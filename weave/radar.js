/* Radar — new Massachusetts AI organizations from public registries, every one
   run through de-duplication against the atlas.

   Sources (all keyless): NSF Awards (SBIR/STTR), NIH RePORTER (SBIR/STTR),
   SEC EDGAR full-text search (Form D), GitHub organization search.

   - Matches an existing entry → validation signals; a registry address that
     equals the atlas address becomes a confirm proposal (registry + Census).
   - Looks like an entry but isn't certain → refused as ambiguous.
   - Net-new → a "New Entity Candidate" proposal with the registry record as
     evidence and a Census/OSM-corroborated pin. Fields a registry cannot
     supply (offers, official website) are left for the reviewer to fill —
     nothing is invented. Nothing reaches entities.yml without the commit gate. */
const store = require("./lib/store");
const A = require("./lib/apis");
const { geocode, km } = require("./lib/geo");
const { get } = require("./lib/fetcher");
const { htmlToText, findAddresses, normStreet, quoteAround, escapeRe } = require("./lib/text");
const { dedupe, index } = require("./dedupe");

const BOSTON = { lat: 42.3601, lng: -71.0589 };
const WORCESTER_LNG = -71.8023;
const AI_RE = /\b(artificial intelligence|machine learning|deep learning|neural network|large language model|LLMs?|computer vision|generative AI|natural language processing|robotic|autonomy|autonomous|AI)\b/;
const round4 = n => Math.round(n * 1e4) / 1e4;
const yearOf = d => (String(d || "").match(/\d{4}/) || [])[0] || "";
const kebab = s => A.normName(s).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "org";
const titleCase = s => String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(Ai|Ml|Llc|Inc|Mit|Usa|Ii|Iii)\b/g, m => m.toUpperCase());
const displayName = s => titleCase(s).replace(/,?\s+(Inc|LLC|Corp|Corporation|Co|Company|Ltd|Pbc)\.?$/i, "").trim();

/* ---------------- collect ---------------- */
async function collect(log) {
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const nsfDate = since.replace(/(\d+)-(\d+)-(\d+)/, "$2/$3/$1");
  const leads = [];
  const add = (src, rec, extra) => leads.push({ source: src, rec, ...extra });

  for (const keyword of ['"artificial intelligence"', '"machine learning"']) for (const program of ["SBIR", "STTR"]) {
    const r = await A.nsfAwards({ keyword, program, rpp: 25, startDateStart: nsfDate });
    log(`NSF ${program} ${keyword}: HTTP ${r.status}, ${r.records.length} awards`);
    r.records.forEach(x => add("NSF Awards API", x, { name: x.name, address: x.address, city: x.city, zip: x.zip, apiUrl: r.url }));
  }
  const nih = await A.nihSbir({});
  log(`NIH RePORTER SBIR/STTR: HTTP ${nih.status}, ${nih.records.length} projects`);
  nih.records.forEach(x => add("NIH RePORTER", x, { name: x.name, city: x.city, zip: x.zip, apiUrl: nih.url }));

  const enddt = new Date().toISOString().slice(0, 10);
  if (!process.env.WEAVE_CONTACT_EMAIL) log("SEC EDGAR skipped: the SEC requires a contact email in every request — set WEAVE_CONTACT_EMAIL to enable it");
  else for (const q of ["artificial intelligence", "machine learning"]) for (const from of [0, 100]) {
    const r = await A.edgarFormD(q, { startdt: since, enddt, from });
    const ma = r.records.filter(x => x.states.includes("MA"));
    log(`EDGAR Form D "${q}" (from ${from}): HTTP ${r.status}, ${r.records.length} filings, ${ma.length} in MA`);
    ma.forEach(x => add("SEC EDGAR (Form D)", x, { name: x.name, city: (x.locations.find(l => /, MA$/.test(l)) || "").replace(/, MA$/, ""), apiUrl: r.url }));
    if (r.records.length < 100) break;
  }

  const gh = await A.githubOrgs({ perPage: 30 });
  log(`GitHub orgs (newest, location Massachusetts): HTTP ${gh.status}, ${gh.records.length} orgs`);
  for (const o of gh.records.slice(0, 25)) {
    const d = await A.githubOrg(o.login);
    if (d.status !== 200) { log(`GitHub org ${o.login}: HTTP ${d.status} — stopping GitHub (rate limit)`); break; }
    add("GitHub organization search", d, { name: d.name, city: d.location.split(",")[0].trim(), url: /^https?:\/\//.test(d.blog) ? d.blog.replace(/^http:/, "https:") : (d.blog ? `https://${d.blog}` : ""), apiUrl: gh.url });
  }
  return leads;
}

/* Merge leads that name the same organization (across registries). */
function merge(leads) {
  const by = new Map();
  for (const l of leads) {
    const k = A.normName(l.name);
    if (!k) continue;
    const m = by.get(k) || { key: k, name: l.name, records: [], address: "", city: "", zip: "", url: "" };
    m.records.push(l);
    m.address ||= l.address || ""; m.city ||= l.city || ""; m.zip ||= l.zip || ""; m.url ||= l.url || "";
    by.set(k, m);
  }
  return [...by.values()];
}

const recQuote = l => {
  const r = l.rec;
  if (l.source === "NSF Awards API") return `${r.name} · ${r.address}, ${r.city}, MA ${r.zip} · ${r.program} · "${r.title}" · ${r.date}`;
  if (l.source === "NIH RePORTER") return `${r.name} · ${r.city}, MA · ${r.program} · "${r.title}" · ${r.date}`;
  if (l.source === "SEC EDGAR (Form D)") return `${r.name} · ${r.locations.join("; ")} · Form ${r.form} filed ${r.date}`;
  return `${r.name} (github.com/${r.login}) · location "${r.location}" · ${r.bio || "no description"} · created ${r.created.slice(0, 10)}`;
};

/* ---------------- place a candidate ---------------- */
async function place(c) {
  if (c.address && c.city) {
    const one = `${c.address}, ${c.city}, MA ${String(c.zip || "").slice(0, 5)}`;
    const [cz, osm] = [await A.census(one), await geocode(`${c.address}, ${c.city}, Massachusetts`)];
    const o = osm.results[0];
    if (cz.match && o && km(cz.match, o) <= 0.5)
      return { lat: round4(cz.match.lat), lng: round4(cz.match.lng), approx: false, loc: `${titleCase(c.address)}, ${titleCase(c.city)}`,
        corroboration: { kind: "US Census Geocoder + OpenStreetMap agree", source_url: cz.url, detail: `Census: ${cz.match.matched} · OSM ${o.osmUrl} (${Math.round(km(cz.match, o) * 1000)} m apart)`, second_url: o.osmUrl } };
    if (cz.match && cz.match.state === "MA")
      return { lat: round4(cz.match.lat), lng: round4(cz.match.lng), approx: false, loc: `${titleCase(c.address)}, ${titleCase(c.city)}`,
        corroboration: { kind: "US Census Geocoder", source_url: cz.url, detail: `Census matched "${cz.match.matched}" (OpenStreetMap did not place it)` } };
  }
  if (c.city) {
    const g = await geocode(`${c.city}, Massachusetts`);
    const o = g.results[0];
    if (o) return { lat: round4(o.lat), lng: round4(o.lng), approx: true, loc: titleCase(c.city),
      corroboration: { kind: "OpenStreetMap (city level)", source_url: o.osmUrl, detail: `${o.name} — no street address in the registry, so the pin is approximate` } };
  }
  return null;
}

async function verifyWebsite(url, name) {
  if (!/^https:\/\//.test(url || "")) return null;
  const r = await get(url);
  if (!r.status || r.status >= 400) return null;
  const text = htmlToText(r.body);
  const words = A.normName(name).split(" ").filter(w => w.length > 2);
  const re = new RegExp(words.map(escapeRe).join("\\W+"), "i");
  const m = text.match(re) || text.match(/\b(Massachusetts|Boston|Cambridge|Worcester|Lowell|Springfield|Amherst|Devens)\b/);
  return m ? { url: r.finalUrl, quote: quoteAround(text, m.index, m[0].length, 120), ai: AI_RE.test(text) } : null;
}

/* ---------------- run ---------------- */
async function run({ log = () => {}, maxNew = 40 } = {}) {
  const DATA = require("./nova").loadDATA();
  const idx = index(DATA);
  const leads = await collect(log);
  const merged = merge(leads);
  const out = { started: store.now(), leads: leads.length, organizations: merged.length, matched: [], possible: [], candidates: [], dropped: [], proposals: 0, refusals: 0 };
  const refuse = r => { store.addRefusal({ module: "radar", ...r }); out.refusals++; };
  const ids = new Set(DATA.map(d => d.id)), names = new Set(DATA.map(d => d.name.toLowerCase()));

  // Outside-Boston candidates first.
  for (const c of merged) {
    const first = c.records[0];
    const dd = dedupe(c, idx);
    const sources = [...new Set(c.records.map(r => r.source))];
    const row = { name: c.name, city: c.city, sources, dedupe: dd.status, reasons: dd.reasons, records: c.records.map(r => ({ source: r.source, url: r.rec.humanUrl, quote: recQuote(r) })) };

    if (dd.status === "match") {
      const d = dd.entry;
      row.entity = d.id;
      out.matched.push(row);
      const nsf = c.records.find(r => r.source === "NSF Awards API" && r.rec.address);
      const [locAddr] = findAddresses(d.loc);
      const [regAddr] = nsf ? findAddresses(`${titleCase(nsf.rec.address)}, ${titleCase(nsf.rec.city)}`) : [];
      if (regAddr && locAddr && normStreet(`${regAddr.number} ${regAddr.street}`) === normStreet(`${locAddr.number} ${locAddr.street}`)) {
        const cz = await A.census(`${nsf.rec.address}, ${nsf.rec.city}, MA`);
        if (cz.match && km(d, cz.match) <= 0.35) {
          store.addProposal({ entity: d.id, entityName: d.name, module: "radar", field: "loc", op: "confirm", confidence: "two-source",
            before: { loc: d.loc, lat: d.lat, lng: d.lng, approx: Boolean(d.approx) }, after: { loc: d.loc, lat: d.lat, lng: d.lng, approx: Boolean(d.approx) },
            summary: `Federal registry confirms "${d.loc}" — NSF award record, and the Census geocoder places it ${Math.round(km(d, cz.match) * 1000)} m from the pin`,
            evidence: { source_url: nsf.rec.humanUrl, quote: recQuote(nsf), kind: "NSF Awards API record" },
            corroboration: { source_url: cz.url, detail: `Census matched "${cz.match.matched}"`, kind: "US Census Geocoder" } });
          out.proposals++;
        }
      }
      if (c.records.some(r => ["NSF Awards API", "NIH RePORTER"].includes(r.source)) && !(d.offers || []).includes("grants"))
        refuse({ entity: d.id, entityName: d.name, field: "offers", reason: "Refused to add `grants` to offers: the registry shows this org RECEIVED a federal grant, which is not the same as offering grants to founders", source_url: first.rec.humanUrl, quote: recQuote(first) });
      if (c.records.some(r => r.source === "SEC EDGAR (Form D)") && ["vc", "angel"].includes(d.cat))
        refuse({ entity: d.id, entityName: d.name, field: "facts", reason: "Refused to derive a Check size from Form D: a Form D reports the size of an offering or fund, not the check a founder receives", source_url: c.records.find(r => r.source === "SEC EDGAR (Form D)").rec.humanUrl, quote: recQuote(c.records.find(r => r.source === "SEC EDGAR (Form D)")) });
      refuse({ entity: d.id, entityName: d.name, field: "lastVerified", reason: "Registry activity does not set lastVerified — that field records a person confirming the org, so it is left for the reviewer", source_url: first.rec.humanUrl, quote: recQuote(first) });
      continue;
    }
    if (dd.status === "possible") {
      row.entities = (dd.entries || []).map(e => e.id);
      out.possible.push(row);
      refuse({ entity: row.entities[0] || "new", entityName: c.name, field: "new entity", reason: `Not creating "${c.name}": it may be an existing entry (${dd.reasons.join("; ")}) — a person must decide`, source_url: first.rec.humanUrl, quote: recQuote(first), candidate: row.entities.join("|") });
      continue;
    }

    // ---- net-new ----
    const isGit = sources.length === 1 && sources[0] === "GitHub organization search";
    const aiText = c.records.map(r => `${r.rec.title || ""} ${r.rec.bio || ""}`).join(" ");
    // A GitHub org must describe itself as AI work; a passing "AI" on a website is not enough.
    if (isGit && !AI_RE.test(aiText)) { out.dropped.push({ ...row, why: "GitHub org whose description shows no AI work" }); continue; }
    if (!c.city || /^(massachusetts|ma|mass\.?|usa|united states|new england)$/i.test(c.city.trim())) {
      refuse({ entity: "new", entityName: c.name, field: "new entity", reason: `Location is only "${c.city || "unknown"}" — no town to place it, and a state-wide pin would be invented`, source_url: first.rec.humanUrl, quote: recQuote(first) });
      continue;
    }
    const site = c.url ? await verifyWebsite(c.url, c.name) : null;
    if (isGit && !site) {
      refuse({ entity: "new", entityName: c.name, field: "new entity", reason: "GitHub location is self-declared and the org's website could not confirm it — one self-reported source, not staged", source_url: first.rec.humanUrl, quote: recQuote(first) });
      continue;
    }
    const pin = await place(c);
    if (!pin) {
      refuse({ entity: "new", entityName: c.name, field: "new entity", reason: "Could not place this registry record in Massachusetts with a geocoder — not staged", source_url: first.rec.humanUrl, quote: recQuote(first) });
      continue;
    }
    if (out.candidates.length >= maxNew) { out.dropped.push({ ...row, why: `cap of ${maxNew} new candidates per run` }); continue; }
    const name = displayName(isGit ? c.name : c.name);
    let id = kebab(name); while (ids.has(id)) id += "-ma";
    if (names.has(name.toLowerCase())) continue;
    const dist = km(BOSTON, pin);
    const award = c.records.find(r => r.rec.title);
    const desc = (award
      ? `${award.source === "NIH RePORTER" ? "NIH" : "NSF"} ${award.rec.program || "SBIR/STTR"} awardee${yearOf(award.rec.date) ? ` (${yearOf(award.rec.date)})` : ""} for "${award.rec.title}".`
      : c.records.find(r => r.rec.bio)?.rec.bio || `Massachusetts organization that filed a Form D with the SEC on ${first.rec.date}.`).replace(/[<>]/g, "").slice(0, 400);
    const draft = { id, name, cat: "startup", loc: pin.loc, lat: pin.lat, lng: pin.lng, ...(pin.approx ? { approx: true } : {}),
      url: site ? site.url.replace(/^http:/, "https:") : "", desc, offers: [], added: new Date().toISOString().slice(0, 7) };
    const outside = dist > 25, west = pin.lng < WORCESTER_LNG;
    const needs = [...(draft.url ? [] : ["url (official website — no registry lists one; Atlas Weave will not guess a domain)"]), "offers (what it gives founders — a registry cannot say)"];
    const p = store.addProposal({ entity: id, entityName: name, module: "radar", field: "new entity", op: "addEntity", confidence: sources.length > 1 ? "two registries" : site ? "registry + website" : "registry + geocoder",
      before: null, after: draft, needs, distanceKm: Math.round(dist), outsideBoston: outside, westOfWorcester: west, sources,
      summary: `New Entity Candidate (Human Gate Required): ${name}, ${pin.loc} — ${Math.round(dist)} km from Boston${west ? ", west of Worcester" : outside ? ", outside the Boston core" : ""}`,
      evidence: { source_url: first.rec.humanUrl, quote: recQuote(first), kind: `${first.source} record` },
      corroboration: site ? { kind: "the org's own website", source_url: site.url, quote: site.quote } : pin.corroboration,
      geo: pin.corroboration, dedupe: dd.reasons });
    row.proposal = p.id; row.distanceKm = Math.round(dist); row.outsideBoston = outside; row.westOfWorcester = west;
    out.candidates.push(row); out.proposals++;
    ids.add(id); names.add(name.toLowerCase());
  }
  out.candidates.sort((a, b) => b.distanceKm - a.distanceKm);
  out.finished = store.now();
  require("fs").writeFileSync(require("path").join(store.DATA, "radar-last-run.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

function lastRun() {
  try { return JSON.parse(require("fs").readFileSync(require("path").join(store.DATA, "radar-last-run.json"), "utf8")); } catch { return null; }
}

module.exports = { run, lastRun, merge, displayName };
