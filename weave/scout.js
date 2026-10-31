/* Scout — multi-source address and signal verification.

   For one organization it reads the org's own site (homepage + a few
   contact/about pages), pulls street addresses out of the page text and JSON-LD,
   and checks each against OpenStreetMap Nominatim. It proposes a change only
   when BOTH sources agree; anything ambiguous or single-sourced becomes a
   refusal. It never edits data/entities.yml. */
const { crawlOrg } = require("./lib/pages");
const { findAddresses, normStreet, hostOf } = require("./lib/text");
const { geocode, km, sameStreet, sameCity } = require("./lib/geo");
const { get } = require("./lib/fetcher");
const store = require("./lib/store");
const { discover } = require("./fields");

/* Addresses that name an institution, not the unit: a lab "at" MIT is not at
   MIT's mailing address. Plus any address quoted in a mail-it-to context. */
const GENERIC = new Map([
  ["77 massachusetts ave|cambridge", "MIT's institutional mailing address (Building 7) — used by hundreds of MIT units"],
]);
const MAILING = /(\bto:\s|mailing address|mail (?:it |them |applications )?to|send (?:it |them |your |applications )|applications should be (?:sent|addressed)|P\.?\s?O\.? Box|postal address|attn\.?:)/i;
// Meetups and events move between venues: an address on their page is usually tonight's venue.
const VENUE_CATS = new Set(["community", "event"]);
const VENUE_CONTEXT = /\b(meetup|join us|rsvp|doors open|hosted (?:at|by)|\d{1,2}:\d{2}\s?(?:AM|PM)|tickets?)\b/i;
function genericReason(c, city, d) {
  const g = GENERIC.get(normStreet(`${c.number} ${c.street}`) + "|" + (c.city || city).toLowerCase());
  if (g && d.id !== "mit") return g;
  if (MAILING.test(c.quote)) return "the address is quoted in a mail-it-to context (a job posting or mailing instruction), not as where the org is";
  return null;
}

const round4 = n => Math.round(n * 1e4) / 1e4;
const cityOf = loc => loc.split(",").map(s => s.trim()).filter(Boolean).pop() || "";
const geoSnapshot = d => ({ loc: d.loc, lat: d.lat, lng: d.lng, approx: Boolean(d.approx) });

/* Distinct Massachusetts street addresses a site publishes, with verbatim quotes. */
function siteAddresses(pages, city) {
  const seen = new Map();
  for (const p of pages) {
    const found = findAddresses(p.text).map(a => ({ ...a, source_url: p.url }));
    for (const j of p.jsonLd) {
      const [a] = findAddresses(`${j.street}, ${j.city}${j.region ? ", " + j.region : ""}`);
      if (a) found.push({ ...a, ma: a.ma || /^(MA|Massachusetts)$/i.test(j.region), quote: j.raw.slice(0, 300), source_url: p.url, jsonLd: true });
    }
    for (const a of found) {
      const inMA = a.ma || (a.city && city && a.city.toLowerCase() === city.toLowerCase());
      if (!inMA) continue;
      const key = normStreet(`${a.number} ${a.street}`);
      if (!seen.has(key)) seen.set(key, a);
    }
  }
  return [...seen.values()];
}

async function survey(d, { DATA }) {
  const report = { entity: d.id, name: d.name, url: d.url, signals: [], proposals: [], refusals: [], started: store.now() };
  const refuse = (field, reason, extra = {}) => {
    const r = store.addRefusal({ entity: d.id, entityName: d.name, module: "scout", field, reason, ...extra });
    report.refusals.push(r);
  };
  const propose = (p) => report.proposals.push(store.addProposal({ entity: d.id, entityName: d.name, module: "scout", ...p }));

  const { home, pages } = await crawlOrg(d.url);
  report.pagesRead = pages.map(p => p.url);
  if (!pages.length) {
    report.signals.push({ kind: "unreachable", detail: `${d.url} → ${home.status || home.error}` });
    refuse("loc", "Official site could not be read, so nothing on it can be quoted", { source_url: d.url, detail: String(home.status || home.error) });
    return finish(report);
  }
  report.signals.push({ kind: "reachable", detail: `HTTP ${home.status}`, source_url: home.finalUrl });
  if (hostOf(home.finalUrl) !== hostOf(d.url))
    report.signals.push({ kind: "redirect", detail: `${d.url} now redirects to ${home.finalUrl} — a reviewer should check the url field`, source_url: home.finalUrl });

  await checkManifest(d, report, propose, refuse);

  // ---- address ----------------------------------------------------------
  const city = cityOf(d.loc);
  const [locAddr] = findAddresses(d.loc);
  const cands = siteAddresses(pages, city);
  report.addressCandidates = cands.map(c => ({ verbatim: c.verbatim, source_url: c.source_url }));
  const match = locAddr && cands.find(c => normStreet(`${c.number} ${c.street}`) === normStreet(`${locAddr.number} ${locAddr.street}`));

  if (match) {
    // The atlas address is on the org's own site. Corroborate with OSM.
    const g = await geocode(`${locAddr.number} ${locAddr.street}, ${city}, Massachusetts`);
    const hit = g.results.find(r => sameStreet(r, locAddr.street));
    if (!hit) {
      refuse("loc", "Address is quoted on the org's site but OpenStreetMap could not place it — single source only", { source_url: match.source_url, quote: match.quote, corroboration_url: g.humanUrl });
    } else {
      const dist = km(d, hit);
      if (dist <= 0.35) {
        propose({ field: "loc", op: "confirm", confidence: "two-source", before: geoSnapshot(d), after: geoSnapshot(d),
          summary: `Confirm "${d.loc}" — on the org's site, and OSM places it ${Math.round(dist * 1000)} m from the pin`,
          evidence: { source_url: match.source_url, quote: match.quote, kind: "official site" },
          corroboration: { source_url: hit.osmUrl, detail: `${hit.name} (${hit.lat}, ${hit.lng})`, kind: "OpenStreetMap Nominatim", search_url: g.humanUrl } });
      } else if (dist <= 5 && hit.house) {
        const after = { loc: d.loc, lat: round4(hit.lat), lng: round4(hit.lng), approx: false };
        propose({ field: "location", op: "setGeo", confidence: "two-source", before: geoSnapshot(d), after,
          summary: `Move pin ${dist.toFixed(2)} km to where OSM places "${locAddr.number} ${locAddr.street}" (the address the org publishes)`,
          evidence: { source_url: match.source_url, quote: match.quote, kind: "official site" },
          corroboration: { source_url: hit.osmUrl, detail: `${hit.name} (${hit.lat}, ${hit.lng})`, kind: "OpenStreetMap Nominatim", search_url: g.humanUrl } });
      } else {
        refuse("lat/lng", `OSM places the quoted address ${dist.toFixed(1)} km from the pin${hit.house ? "" : " at street level only"} — too far or too coarse to move it automatically`, { source_url: match.source_url, quote: match.quote, corroboration_url: hit.osmUrl });
      }
    }
  } else if (!cands.length) {
    refuse("loc", d.approx
      ? "No street address published on the org's site — the approximate pin stays approximate"
      : "The atlas address does not appear on the org's site, and the site publishes no other address — unconfirmed",
      { source_url: report.pagesRead[0], detail: `pages read: ${report.pagesRead.length}` });
  } else if (cands.length > 1) {
    refuse("loc", `Ambiguous: the site publishes ${cands.length} different Massachusetts addresses and none matches the atlas`,
      { source_url: cands[0].source_url, candidate: cands.map(c => c.verbatim).join(" | "), quote: cands.slice(0, 3).map(c => c.quote).join(" … ") });
  } else {
    const c = cands[0];
    const cCity = c.city || city;
    const generic = genericReason(c, city, d);
    if (generic) {
      refuse("loc", `Refused generic address "${c.verbatim}": ${generic}`, { source_url: c.source_url, quote: c.quote, candidate: c.verbatim });
      discover(d, pages, { refuse, propose, today: store.now().slice(0, 10) });
      return finish(report);
    }
    const g = await geocode(`${c.number} ${c.street}, ${cCity}, Massachusetts`);
    const hit = g.results.find(r => sameStreet(r, c.street) && sameCity(r, cCity) && (!r.house || r.house.split(/[-;,]/)[0] === c.number.split("-")[0]));
    const elsewhere = !hit && g.results.find(r => sameStreet(r, c.street));
    if (!d.approx) {
      // A precise, human-verified address is never overwritten from a scrape: the
      // site may show a parent institution, an old office, or another org.
      refuse("loc", `The atlas has a precise address ("${d.loc}") that does not appear on the site, which publishes "${c.verbatim}" instead — could be a parent institution, an old office, or a move; a person should check`,
        { source_url: c.source_url, quote: c.quote, candidate: c.verbatim, corroboration_url: hit?.osmUrl || g.humanUrl });
    } else if (VENUE_CATS.has(d.cat) || VENUE_CONTEXT.test(c.quote)) {
      refuse("loc", `Refused venue address "${c.verbatim}": ${d.name} is a ${VENUE_CATS.has(d.cat) ? d.cat : "group"} and the address appears in an event listing — it is where a meetup was held, not where the org is`,
        { source_url: c.source_url, quote: c.quote, candidate: c.verbatim });
    } else if (elsewhere) {
      refuse("loc", `OpenStreetMap places "${c.number} ${c.street}" in ${elsewhere.city || "another town"}, not ${cCity} — the sources disagree`, { source_url: c.source_url, quote: c.quote, candidate: c.verbatim, corroboration_url: elsewhere.osmUrl });
    } else if (!hit) {
      refuse("loc", "Site publishes an address but OpenStreetMap does not corroborate it — single source only", { source_url: c.source_url, quote: c.quote, candidate: c.verbatim, corroboration_url: g.humanUrl });
    } else {
      const dist = km(d, hit);
      if (dist > 15) {
        refuse("loc", `The site's address is ${dist.toFixed(0)} km from the pin — probably a different office; a person should decide which one the atlas means`, { source_url: c.source_url, quote: c.quote, candidate: c.verbatim, corroboration_url: hit.osmUrl });
      } else {
        const newLoc = `${c.number} ${c.street}, ${cCity}`;
        const after = { loc: newLoc, lat: round4(hit.lat), lng: round4(hit.lng), approx: false };
        propose({ field: "location", op: "setGeo", confidence: "two-source", before: geoSnapshot(d), after,
          summary: `Sharpen approximate pin to "${newLoc}" (${dist.toFixed(2)} km move)`,
          evidence: { source_url: c.source_url, quote: c.quote, kind: c.jsonLd ? "official site (JSON-LD)" : "official site" },
          corroboration: { source_url: hit.osmUrl, detail: `${hit.name} (${hit.lat}, ${hit.lng})`, kind: "OpenStreetMap Nominatim", search_url: g.humanUrl } });
      }
    }
  }
  discover(d, pages, { refuse, propose, today: store.now().slice(0, 10) });
  return finish(report);
}

/* A .well-known/mass-ai-atlas.json manifest served from the entry's own host
   is the org vouching for its own entry (see docs/well-known-manifest.md). */
async function checkManifest(d, report, propose, refuse) {
  const url = new URL("/.well-known/mass-ai-atlas.json", d.url).href;
  const r = await get(url, { accept: "application/json" });
  let m = null;
  if (r.status === 200) { try { m = JSON.parse(r.body); } catch {} }
  if (!m || typeof m !== "object") { report.signals.push({ kind: "no-manifest", detail: `no manifest at ${url}` }); return; }
  report.manifest = { url: r.finalUrl, body: m };
  if (hostOf(r.finalUrl) !== hostOf(d.url)) {
    refuse("manifest", "Manifest was served from a different host than the entry's url — domain control not shown", { source_url: r.finalUrl });
    return;
  }
  if (m.atlas_id !== d.id) {
    refuse("manifest", `Manifest names atlas_id ${JSON.stringify(m.atlas_id)}, not "${d.id}"`, { source_url: r.finalUrl, quote: JSON.stringify({ atlas_id: m.atlas_id }) });
    return;
  }
  propose({ field: "selfVerified", op: "confirm", confidence: "self-attested", before: null, after: { manifest: r.finalUrl },
    summary: `${d.name} publishes a self-verification manifest naming this entry`,
    evidence: { source_url: r.finalUrl, quote: JSON.stringify({ atlas_id: m.atlas_id, name: m.name }), kind: ".well-known manifest" },
    corroboration: { source_url: d.url, detail: `served from ${hostOf(d.url)}, the official site already in the atlas`, kind: "domain control" } });
  const today = store.now().slice(0, 10);
  const selfProp = (field, op, before, after, summary) => propose({ field, op, before, after, confidence: "self-attested",
    summary: `${summary} (from the org's own manifest)`,
    evidence: { source_url: r.finalUrl, quote: JSON.stringify({ [field]: after }), kind: ".well-known manifest" },
    corroboration: { source_url: d.url, detail: `served from ${hostOf(d.url)}, the official site already in the atlas — the org is authoritative for its own deadlines and stages`, kind: "domain control" } });
  if (/^\d{4}-\d{2}-\d{2}$/.test(m.applyBy || "") && m.applyBy > today && m.applyBy !== d.applyBy) selfProp("applyBy", "setApplyBy", d.applyBy ?? null, m.applyBy, `Set application deadline to ${m.applyBy}`);
  else if (m.applyBy === "rolling" && d.applyBy !== "rolling") selfProp("applyBy", "setApplyBy", d.applyBy ?? null, "rolling", "Set applications to rolling");
  if (Array.isArray(m.stages) && m.stages.length && !(d.stages || []).length && m.stages.every(n => [1, 2, 3, 4, 5].includes(n))) selfProp("stages", "setStages", [], m.stages, `Set stages to [${m.stages.join(", ")}]`);
  for (const k of ["name", "loc", "offers", "desc"])
    if (m[k] !== undefined && JSON.stringify(m[k]) !== JSON.stringify(d[k]))
      refuse(k, "Manifest claims a different value; a self-claim is one source, so it is shown to a reviewer, not proposed", { source_url: r.finalUrl, quote: JSON.stringify({ [k]: m[k] }) });
}

function finish(report) { report.finished = store.now(); return report; }

module.exports = { survey, siteAddresses };
