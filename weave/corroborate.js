/* Live public-API cross-check for one atlas entry (judge Q2).

   Matching is tiered, and every signal says which tier produced it:
     exact       — the registry name equals the entry name (normalized)
     normalized  — equal after stripping parent prefixes and legal suffixes
                   ("MIT Jameel Clinic" → "jameel clinic")
     parent      — the entry's website is a subdomain of an institution whose
                   ROR record lists that domain (jclinic.mit.edu → mit.edu →
                   Massachusetts Institute of Technology); awards are then
                   searched under the parent for the unit's own name
     osm-poi     — OpenStreetMap has a place named for the org
   A tier never silently upgrades a claim: receiving a grant is not offering
   grants, a parent's EIN is not the unit's, and sharing a domain is not, by
   itself, a relationship — the unit's own website must name the other entry. */
const A = require("./lib/apis");
const store = require("./lib/store");
const { geocode, km } = require("./lib/geo");
const { findAddresses, hostOf, quoteAround, escapeRe } = require("./lib/text");
const { crawlOrg } = require("./lib/pages");

const NONPROFIT_CATS = new Set(["accel", "community", "space", "student", "event", "gov"]);
const PARENT_NAMES = {
  "mit.edu": "Massachusetts Institute of Technology", "harvard.edu": "Harvard University", "bu.edu": "Boston University",
  "umass.edu": "University of Massachusetts Amherst", "umb.edu": "University of Massachusetts Boston", "uml.edu": "University of Massachusetts Lowell",
  "umassd.edu": "University of Massachusetts Dartmouth", "northeastern.edu": "Northeastern University", "wpi.edu": "Worcester Polytechnic Institute",
  "tufts.edu": "Tufts University", "brandeis.edu": "Brandeis University", "bc.edu": "Boston College", "babson.edu": "Babson College", "bentley.edu": "Bentley University",
};
const PARENT_ABBR = { "mit.edu": ["MIT"], "harvard.edu": ["Harvard"], "bu.edu": ["BU", "Boston University"], "umass.edu": ["UMass Amherst", "UMass"], "umb.edu": ["UMass Boston"], "northeastern.edu": ["Northeastern"], "wpi.edu": ["WPI"], "tufts.edu": ["Tufts"], "brandeis.edu": ["Brandeis"] };
const PREFIX = /^(mit|harvard|bu|boston university|umass( amherst| boston| lowell| dartmouth)?|northeastern|tufts|wpi|brandeis|the)\s+/i;
const cityOf = loc => (loc.split(",").pop() || "").replace(/\(.*?\)/g, "").trim();
const money = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n || 0)}`;
const registrable = h => h.split(".").slice(-2).join(".");

function shortName(name) {
  let s = name.replace(/\s*\(.*?\)\s*/g, " ").trim();
  for (let i = 0; i < 2; i++) s = s.replace(PREFIX, "");
  return A.normName(s);
}
// A short name is specific enough to search registries with on its own.
const specific = s => { const t = s.split(" ").filter(w => w.length > 2); return t.length >= 2 || (t.length === 1 && t[0].length >= 7); };

async function resolveParent(d) {
  const host = hostOf(d.url), dom = registrable(host);
  if (!/\.edu$/.test(dom) && host === dom) return null;
  if (!PARENT_NAMES[dom] && host === dom) return null;
  const r = await A.ror(PARENT_NAMES[dom] || dom);
  const rec = r.records.find(x => x.domains.some(z => z === dom || z.endsWith("." + dom) || dom.endsWith("." + z)));
  if (!rec) return null;
  return { domain: dom, host, isUnit: host !== dom, name: rec.display, ror: rec.id, city: rec.city, region: rec.region, rorQuery: r.url, domains: rec.domains };
}

async function corroborate(d, { scout = {}, matchmaker = {}, DATA = [] } = {}) {
  const signals = [], refusals = [], proposals = [];
  const full = A.normName(d.name), short = shortName(d.name);
  const refuse = r => refusals.push(store.addRefusal({ entity: d.id, entityName: d.name, module: "public-apis", ...r }));
  const sig = s => signals.push(s);
  const safe = async (label, fn) => { try { await fn(); } catch (e) { sig({ source: label, status: "error", summary: String(e.message || e) }); } };
  const nameTier = n => { const x = A.normName(n); return x === full ? "exact" : short && (x === short || shortName(n) === short) ? "normalized" : null; };
  const city = cityOf(d.loc);

  const parent = await resolveParent(d).catch(() => null);
  if (parent) sig({ source: "ROR", tier: "parent", status: "match", url: parent.rorQuery, humanUrl: parent.ror,
    summary: `${hostOf(d.url)} is ${parent.isUnit ? "a subdomain of" : ""} ${parent.domain}, which ROR lists for ${parent.name} (${parent.city}) — ${parent.isUnit ? `${d.name} is a unit of ${parent.name}` : "same institution"}` });

  // ---- geocoding: atlas street, else OSM place-name + the website's own addresses ----
  await safe("Geocoders", async () => {
    const [a] = findAddresses(d.loc);
    if (a) {
      const line = `${a.number} ${a.street}, ${city}, MA`;
      const [cz, osm] = [await A.census(line), await geocode(`${a.number} ${a.street}, ${city}, Massachusetts`)];
      const o = osm.results[0];
      const dc = cz.match ? km(d, cz.match) : null, dosm = o ? km(d, o) : null;
      const agree = dc !== null && dosm !== null && dc <= 0.35 && dosm <= 0.35;
      sig({ source: "US Census Geocoder + OpenStreetMap", tier: "exact", status: agree ? "match" : cz.match || o ? "partial" : "no match", url: cz.url, humanUrl: o?.osmUrl || osm.humanUrl,
        summary: `${line}: Census ${cz.match ? `${Math.round(dc * 1000)} m from pin (${cz.match.matched})` : "no match"} · OSM ${o ? `${Math.round(dosm * 1000)} m from pin` : "no match"}${agree ? " — both geocoders agree with the pin" : ""}` });
      if (cz.match) attachCensus(scout.proposals || [], d, cz);
      return;
    }
    // Approximate pin: look the org up by name in OpenStreetMap.
    const toks = (short || full).split(" ").filter(w => w.length > 2);
    let poi = null, osmQuery = null;
    for (const q of [...new Set([d.name.replace(/\s*\(.*?\)/g, ""), short && toks.length ? short : null])].filter(Boolean)) {
      const g = await geocode(`${q}, ${city || "Massachusetts"}, Massachusetts`);
      osmQuery = osmQuery || g.humanUrl;
      poi = g.results.find(r => toks.every(t => r.name.toLowerCase().includes(t)) && km(d, r) <= 5);
      if (poi) break;
    }
    const siteAddrs = scout.addressCandidates || [];
    const refusedAddr = new Set((scout.refusals || []).filter(r => r.field === "loc" && r.candidate).map(r => r.candidate));
    sig({ source: "OpenStreetMap (place name)", tier: "osm-poi", status: poi ? "match" : "no match", url: osmQuery, humanUrl: poi?.osmUrl,
      summary: poi ? `OSM has "${poi.name.split(",")[0]}" at ${poi.house ? poi.house + " " : ""}${poi.road || poi.name.split(",").slice(1, 3).join(",")} — ${Math.round(km(d, poi) * 1000)} m from the current approximate pin`
        : `no OpenStreetMap place named "${d.name}" near ${city || "the pin"}` });
    sig({ source: "Website addresses (Scout)", tier: "exact", status: siteAddrs.length ? (siteAddrs.every(x => refusedAddr.has(x.verbatim)) ? "refused" : "match") : "no match", humanUrl: siteAddrs[0]?.source_url,
      summary: siteAddrs.length ? siteAddrs.map(x => `"${x.verbatim}"${refusedAddr.has(x.verbatim) ? " (refused: generic/mailing/venue)" : ""}`).join(" · ") : `no street address on the ${(scout.pagesRead || []).length} pages read` });
    const usable = siteAddrs.filter(x => !refusedAddr.has(x.verbatim));
    if (!(scout.proposals || []).some(p => p.op === "setGeo")) {
      if (poi && !usable.length) refuse({ field: "loc", reason: `Pin stays approximate: OpenStreetMap has a place named "${poi.name.split(",")[0]}", but the org's website ${siteAddrs.length ? "publishes only a generic address" : "publishes no address"} — one source, not enough to move the pin`, source_url: poi.osmUrl, quote: poi.name, corroboration_url: siteAddrs[0]?.source_url });
      // (No POI and no address at all is already Scout's refusal — don't repeat it.)
      else if (!poi && siteAddrs.length && !usable.length) refuse({ field: "loc", reason: `Pin stays approximate: no OpenStreetMap place is named "${d.name}", and the website ${siteAddrs.length ? `publishes only ${siteAddrs.map(x => `"${x.verbatim}"`).join(", ")}, which Scout refused as generic` : "publishes no street address"} — the building cannot be corroborated`, source_url: osmQuery, quote: siteAddrs.map(x => x.verbatim).join(" | ") || undefined });
    }
  });

  // ---- ROR / OpenAlex (by own name, then parent) ----
  await safe("ROR", async () => {
    const r = await A.ror(d.name.replace(/\s*\(.*?\)\s*/g, " ").trim());
    const hit = r.records.map(x => ({ x, t: x.names.map(nameTier).find(Boolean) })).find(o => o.t && (o.x.region === "Massachusetts" || !o.x.region));
    if (hit) sig({ source: "ROR", tier: hit.t, status: "match", url: r.url, humanUrl: hit.x.id, summary: `${hit.x.display} (${hit.x.types.join(", ")}) in ${hit.x.city}${hit.x.city && hit.x.city.toLowerCase() === city.toLowerCase() ? " — same city as the atlas" : ""}` });
    else sig({ source: "ROR", tier: "exact", status: "no match", url: r.url, summary: `no ROR organization named "${d.name}"${short !== full ? ` or "${short}"` : ""}${parent ? ` — resolved via parent above` : ""}` });
  });
  if (d.cat === "university" || parent) await safe("OpenAlex", async () => {
    if (parent) {
      const r = await A.openalexByRor(parent.ror);
      if (r.record) { sig({ source: "OpenAlex", tier: "parent", status: "match", url: r.url, humanUrl: r.record.humanUrl, summary: `${r.record.name}: ${r.record.works.toLocaleString()} research works, ${r.record.cited.toLocaleString()} citations — the talent base ${d.name} draws on` }); return; }
    }
    const r = await A.openalex(d.name.replace(/\s*\(.*?\)\s*/g, " ").trim());
    const hit = r.records.find(x => nameTier(x.name));
    sig({ source: "OpenAlex", tier: hit ? nameTier(hit.name) : "exact", status: hit ? "match" : r.status === 200 ? "no match" : "error", url: r.url, humanUrl: hit?.humanUrl,
      summary: hit ? `${hit.name}: ${hit.works.toLocaleString()} research works` : r.status === 200 ? `no OpenAlex institution named "${d.name}"` : `HTTP ${r.status} (OpenAlex shares a small keyless daily budget)` });
  });

  // ---- federal awards ----
  if (!["vc", "angel"].includes(d.cat)) {
    await safe("NSF Awards API", async () => {
      const r = await A.nsfAwards({ awardeeName: d.name.replace(/\s*\(.*?\)\s*/g, " ").trim(), rpp: 10 });
      const mine = r.records.filter(x => nameTier(x.name));
      if (mine.length) { sig({ source: "NSF Awards API", tier: nameTier(mine[0].name), status: "match", url: r.url, humanUrl: mine[0].humanUrl, summary: `${mine.length} NSF award(s) to ${mine[0].name} at ${mine[0].address}, ${mine[0].city} — latest "${mine[0].title}"` }); return; }
      if (parent && specific(short)) {
        const p = await A.nsfAwards({ awardeeName: parent.name, keyword: `"${short}"`, rpp: 10 });
        sig({ source: "NSF Awards API", tier: "parent", status: p.records.length ? "match" : "no match", url: p.url, humanUrl: p.records[0]?.humanUrl,
          summary: p.records.length ? `${p.records.length} NSF award(s) to ${parent.name} mention "${short}" — e.g. "${p.records[0].title}"` : `no NSF award to ${parent.name} mentions "${short}" in its title or abstract` });
        return;
      }
      sig({ source: "NSF Awards API", tier: "exact", status: "no match", url: r.url, summary: `no NSF awardee named "${d.name}"${parent && !specific(short) ? ` (and "${short}" is too generic to search ${parent.name}'s awards)` : ""}` });
    });
    await safe("USAspending.gov", async () => {
      if (parent && parent.isUnit) {
        if (!specific(short)) { sig({ source: "USAspending.gov", tier: "parent", status: "skipped", summary: `"${short}" is too generic to search ${parent.name}'s federal awards` }); return; }
        const r = await A.usaspendingKeyword(short, parent.name);
        sig({ source: r.source, tier: "parent", status: r.records.length ? "match" : r.status === 200 ? "no match" : "error", url: r.url, humanUrl: r.records[0]?.humanUrl,
          summary: r.records.length ? `${r.records.length} federal grant(s) to ${r.records[0].name} mention "${short}" — largest ${money(r.records[0].amount)} from ${r.records[0].agency}` : `no federal grant to ${parent.name} mentions "${short}"` });
        return;
      }
      for (const group of ["grants", "contracts"]) {
        const r = await A.usaspending(d.name.replace(/\s*\(.*?\)\s*/g, " ").trim(), group);
        const mine = r.records.filter(x => nameTier(x.name));
        if (!mine.length) { sig({ source: r.source, tier: "exact", status: r.status === 200 ? "no match" : "error", url: r.url, summary: r.status === 200 ? `no ${group} to a recipient named "${d.name}" in MA` : `HTTP ${r.status}` }); continue; }
        const total = mine.reduce((s, x) => s + (x.amount || 0), 0);
        sig({ source: r.source, tier: nameTier(mine[0].name), status: "match", url: r.url, humanUrl: mine[0].humanUrl, summary: `${mine.length} federal ${group} to ${mine[0].name}, ${money(total)} total — largest from ${mine[0].agency} (${mine[0].date})` });
        if (group === "grants" && !(d.offers || []).includes("grants"))
          refuse({ field: "offers", reason: "Refused to add `grants` to offers: USAspending shows this org RECEIVED federal grants — that validates it is real and active, but it does not mean it offers grants to founders", source_url: mine[0].humanUrl, quote: `${mine[0].name} · ${mine[0].id} · ${money(mine[0].amount)} · ${mine[0].agency} · ${mine[0].date}` });
        if (group === "contracts" && !(d.offers || []).includes("customers"))
          refuse({ field: "offers", reason: "Refused to add `customers` to offers: a federal contract means this org SELLS to the government — it is not evidence that it buys from or pilots with startups", source_url: mine[0].humanUrl, quote: `${mine[0].name} · ${mine[0].id} · ${money(mine[0].amount)} · ${mine[0].agency}` });
      }
    });
  }

  // ---- ProPublica (IRS 990) ----
  if (NONPROFIT_CATS.has(d.cat) || parent) await safe("ProPublica Nonprofit Explorer", async () => {
    const r = await A.propublica(d.name.replace(/\s*\(.*?\)\s*/g, " ").trim());
    const mine = r.records.filter(x => nameTier(x.name));
    if (mine.length === 1) { sig({ source: r.source, tier: nameTier(mine[0].name), status: "match", url: r.url, humanUrl: mine[0].humanUrl, summary: `IRS-registered nonprofit: ${mine[0].name}, ${mine[0].city} (EIN ${mine[0].ein})` }); return; }
    if (mine.length > 1) {
      sig({ source: r.source, tier: "normalized", status: "ambiguous", url: r.url, summary: `${mine.length} MA nonprofits match "${d.name}" — not used` });
      refuse({ field: "nonprofit", reason: `Ambiguous: ${mine.length} Massachusetts nonprofits match this name in IRS records — not attributing any 990 to this entry`, source_url: mine[0].humanUrl, candidate: mine.map(x => x.ein).join("|"), quote: mine.map(x => `${x.name}, ${x.city} (EIN ${x.ein})`).join(" | ") });
      return;
    }
    if (parent) {
      const p = await A.propublica(parent.name);
      const pm = p.records.find(x => A.normName(x.name) === A.normName(parent.name));
      sig({ source: p.source, tier: "parent", status: pm ? "match" : "no match", url: p.url, humanUrl: pm?.humanUrl,
        summary: pm ? `${d.name} files under its parent: ${pm.name}, ${pm.city} (EIN ${pm.ein}) — the unit has no 990 of its own` : `no 990 for ${d.name} or ${parent.name}` });
      return;
    }
    sig({ source: r.source, tier: "exact", status: r.status === 200 ? "no match" : "error", url: r.url, summary: `no MA nonprofit named "${d.name}" (may be a for-profit or a program of a larger nonprofit)` });
  });

  // ---- institutional links: parent entry, and siblings the website itself names ----
  if (parent) await safe("Institution graph", async () => {
    const hostOfE = e => hostOf(e.url);
    const parentEntry = DATA.find(e => e.id !== d.id && hostOfE(e) === parent.domain);
    const siblings = DATA.filter(e => e.id !== d.id && hostOfE(e) !== parent.domain && registrable(hostOfE(e)) === parent.domain);
    const pages = (await crawlOrg(d.url)).pages;
    const rorEvidence = { kind: "ROR institution record (domain)", source_url: parent.ror, detail: `ROR lists ${parent.domain} for ${parent.name}; ${hostOf(d.url)} is on that domain` };
    const linked = new Set(d.links || []);
    if (parentEntry && !linked.has(parentEntry.id)) {
      const names = [parent.name, ...(PARENT_ABBR[parent.domain] || [])];
      let ev = null;
      for (const p of pages) {
        for (const n of names) { const m = p.text.match(new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`)); if (m) { ev = { source_url: p.url, quote: quoteAround(p.text, m.index, m[0].length), kind: "official site (names its parent institution)" }; break; } }
        if (ev) break;
      }
      if (ev) proposals.push(store.addProposal({ entity: d.id, entityName: d.name, module: "matchmaker", field: "links", op: "addLink", confidence: "two-source",
        before: d.links || [], after: parentEntry.id, summary: `Link ${d.name} → ${parentEntry.name} (its parent institution)`, evidence: ev, corroboration: rorEvidence }));
      else refuse({ field: "links", reason: `${d.name} is on ${parent.domain}, but its pages never name ${parent.name} — the domain alone is not proposed as a link`, candidate: parentEntry.id, source_url: d.url });
    }
    // Siblings: only those the unit's own website names (Matchmaker found the mention, but had no second source).
    const mentioned = (matchmaker.refusals || []).filter(r => r.field === "links" && r.candidate && siblings.some(s => s.id === r.candidate) && !linked.has(r.candidate));
    for (const r of mentioned) {
      const s = siblings.find(x => x.id === r.candidate);
      proposals.push(store.addProposal({ entity: d.id, entityName: d.name, module: "matchmaker", field: "links", op: "addLink", confidence: "same-institution (ROR)",
        before: d.links || [], after: s.id, summary: `Link ${d.name} → ${s.name}: the website names it, and both are units of ${parent.name}`,
        evidence: { source_url: r.source_url, quote: r.quote, kind: "official site (names the other unit)" },
        corroboration: { ...rorEvidence, detail: `ROR lists ${parent.domain} for ${parent.name}; both ${hostOf(d.url)} and ${hostOf(s.url)} are on it` } }));
      store.removeRefusal(r.key);   // superseded by a corroborated proposal
    }
    const unnamed = siblings.filter(s => !linked.has(s.id) && !mentioned.some(m => m.candidate === s.id) && !(s.links || []).includes(d.id));
    if (unnamed.length) sig({ source: "Institution graph", tier: "parent", status: "refused", summary: `${unnamed.length} other ${parent.name} unit(s) in the atlas (${unnamed.slice(0, 4).map(s => s.name).join(", ")}${unnamed.length > 4 ? "…" : ""}) — not linked: sharing a domain is not a relationship unless the website names them` });
  });

  // ---- lastVerified: never from a machine ----
  refuse({ field: "lastVerified", reason: `Not proposing lastVerified: it records a PERSON confirming ${d.name} is real and its facts are right. Live sources agree today, but that is evidence for the reviewer, not the confirmation itself`, source_url: d.url });

  return { signals, refusals, proposals };
}

function attachCensus(scoutProposals, d, cz) {
  const rows = store.read("proposals");
  let touched = false;
  for (const sp of scoutProposals) {
    const p = rows.find(r => r.id === sp.id);
    if (!p || !["confirm", "setGeo"].includes(p.op) || p.field === "selfVerified") continue;
    const target = p.after?.lat ? p.after : d;
    p.census = { source_url: cz.url, detail: `Census matched "${cz.match.matched}", ${Math.round(km(target, cz.match) * 1000)} m from the ${p.op === "setGeo" ? "proposed" : "current"} pin`, agrees: km(target, cz.match) <= 0.35 };
    touched = true;
  }
  if (touched) store.write("proposals", rows);
}

module.exports = { corroborate, shortName, resolveParent };
