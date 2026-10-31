/* Judge Scorecard & Brief: declared data sources, best refusals, a random
   sourced claim, and the CONCEPT_BRIEF.md generator. Everything here is
   computed from the proposal/refusal/evidence files and the fetch cache. */
const fs = require("fs");
const path = require("path");
const store = require("./lib/store");
const nova = require("./nova");
const { hostOf } = require("./lib/text");

const CACHE = path.join(__dirname, ".cache");
const API_HOSTS = new Set(["nominatim.openstreetmap.org", "geocoding.geo.census.gov", "api.nsf.gov", "api.reporter.nih.gov", "api.usaspending.gov", "efts.sec.gov", "api.github.com", "api.ror.org", "api.openalex.org", "projects.propublica.org"]);

function sources() {
  const hosts = new Map(), apiUse = new Map();
  let files = [];
  try { files = fs.readdirSync(CACHE); } catch {}
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
      const h = hostOf(c.url);
      if (!h) continue;
      if (API_HOSTS.has(h)) { apiUse.set(h, (apiUse.get(h) || 0) + 1); continue; }
      const e = hosts.get(h) || { host: h, fetches: 0, ok: 0 };
      e.fetches++; if (c.status && c.status < 400) e.ok++;
      hosts.set(h, e);
    } catch {}
  }
  const n = h => apiUse.get(h) ? ` · ${apiUse.get(h)} cached responses` : "";
  return {
    apis: [
      { name: "Organizations' own websites", url: "", use: "homepage + up to 6 same-site contact/about/apply/partner pages per org — the primary source of quotes" },
      { name: "OpenStreetMap Nominatim", url: "https://nominatim.openstreetmap.org/", use: `independent geocoding of quoted addresses (1 req/s, 24 h cache)${n("nominatim.openstreetmap.org")}` },
      { name: "US Census Geocoder", url: "https://geocoding.geo.census.gov/geocoder/", use: `second geocoder for street pins and new-entity addresses${n("geocoding.geo.census.gov")}` },
      { name: "NSF Awards API", url: "https://api.nsf.gov/services/v1/awards.json", use: `MA SBIR/STTR awardees (radar) and per-org award lookups${n("api.nsf.gov")}` },
      { name: "NIH RePORTER API", url: "https://api.reporter.nih.gov/", use: `MA SBIR/STTR projects (radar)${n("api.reporter.nih.gov")}` },
      { name: "USAspending.gov API", url: "https://api.usaspending.gov/", use: `federal grants and contracts received, per org${n("api.usaspending.gov")}` },
      { name: "SEC EDGAR full-text search", url: "https://efts.sec.gov/LATEST/search-index", use: process.env.WEAVE_CONTACT_EMAIL ? `Form D filings by MA issuers (radar)${n("efts.sec.gov")}` : "Form D filings (radar) — disabled: the SEC requires a contact email; set WEAVE_CONTACT_EMAIL" },
      { name: "GitHub organization search API", url: "https://api.github.com/search/users", use: `newest MA-located orgs (radar; unauthenticated: 10 searches/min, 60 lookups/h)${n("api.github.com")}` },
      { name: "ROR API", url: "https://api.ror.org/", use: `institution identity and city for universities and companies${n("api.ror.org")}` },
      { name: "OpenAlex API", url: "https://api.openalex.org/", use: `university research activity (talent signal; shared keyless daily budget)${n("api.openalex.org")}` },
      { name: "ProPublica Nonprofit Explorer API", url: "https://projects.propublica.org/nonprofits/api", use: `IRS 990 registration for MA accelerators, communities and spaces${n("projects.propublica.org")}` },
      { name: "Mass AI Atlas dataset (git HEAD)", url: "https://github.com/holzerjm/mass-ai-atlas/blob/main/data/entities.yml", use: "baseline for the probes; reciprocal links as corroboration (linked to the exact line)" },
      { name: "/.well-known/mass-ai-atlas.json", url: "https://github.com/holzerjm/mass-ai-atlas/blob/main/docs/well-known-manifest.md", use: "self-verification manifests published by orgs" },
    ],
    orgSites: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)),
    notUsed: ["No LLM generates any quote or value — every quote is a substring of a fetched page or a verbatim registry record", "No search engines, scraped aggregators, paid data, or API keys"],
  };
}

/* Refusals worth showing first. */
function bestRefusals(n = 8) {
  const rank = r =>
    /generic address/i.test(r.reason) && /MIT/.test(r.reason) ? 0 :
    /RECEIVED|SELLS to the government/.test(r.reason) ? 1 :
    /Form D/.test(r.reason) ? 1.5 :
    /check size/i.test(r.reason) ? 2 :
    /venue address|precise address/i.test(r.reason) ? 3 :
    /generic address/i.test(r.reason) ? 3.5 :
    /may be an existing entry|^Ambiguous/i.test(r.reason) ? 4 :
    /self-declared|state-wide pin/i.test(r.reason) ? 5 : 9;
  const seen = new Set();
  return store.read("refusals").filter(r => r.quote || r.candidate)
    .sort((a, b) => rank(a) - rank(b))
    .filter(r => { const k = rank(r) + "|" + r.reason.slice(0, 40); if (rank(r) >= 9 || seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n);
}

function randomClaim() {
  const ev = store.read("evidence");
  if (ev.length) return { status: "committed", ...ev[Math.floor(Math.random() * ev.length)] };
  const p = store.read("proposals").filter(p => ["pending", "accepted"].includes(p.status) && p.evidence?.quote);
  if (!p.length) return null;
  const x = p[Math.floor(Math.random() * p.length)];
  return { status: x.status === "accepted" ? "approved in sandbox" : x.staged ? "staged" : "pending review", entity: x.entity, entityName: x.entityName, field: x.field, value: x.after,
    confidence: x.confidence, summary: x.summary, evidence: x.evidence, corroboration: x.corroboration, census: x.census };
}

function counts() {
  const P = store.read("proposals"), R = store.read("refusals");
  const by = (rows, k) => rows.reduce((a, r) => (a[r[k] || "—"] = (a[r[k] || "—"] || 0) + 1, a), {});
  return {
    proposals: P.length, pending: P.filter(p => p.status === "pending").length, staged: P.filter(p => p.staged && p.status === "pending").length,
    accepted: P.filter(p => p.status === "accepted").length, committed: P.filter(p => p.status === "approved").length, rejected: P.filter(p => p.status === "rejected").length,
    newEntities: P.filter(p => p.op === "addEntity").length,
    byField: by(P, "field"), byConfidence: by(P, "confidence"), refusals: R.length, refusalsByModule: by(R, "module"),
  };
}

function brief() {
  const pr = nova.probes();
  const c = counts();
  const s = sources();
  const refs = bestRefusals(5);
  const radar = require("./radar").lastRun();
  const row = r => `| ${r.label} | ${r.before} | ${r.after} | ${r.preview} |`;
  const get = k => pr.rows.find(r => r.key === k);
  const md = `# Atlas Weave: Concept Brief

*Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`node weave/cli.js brief\`. Every number below is computed from the repository at that moment.*

**Atlas Weave** is a survey engine for the Mass AI Atlas, built by the community for the community. It finds evidence on organizations' own websites and in public registries, corroborates every claim with a second source, and queues each change for a named human reviewer. It also logs what it refused to do. \`data/entities.yml\` changes only when a maintainer clicks **Commit Approved**: a backup is taken first, and \`validate.js\` runs after every write.

## The gap (git HEAD)

- **${get("noStages").before}** entries have no \`stages\`, so they are hidden from every stage-filtered founder search.
- **${get("noOutbound").before}** entries have no outbound links, and **${get("isolated").before}** have no links at all, so no warm path reaches them.
- **${get("approx").before}** pins are neighborhood-level.
- Only **${get("outsideBoston").before}** of ${pr.totals.before} entries are more than 25 km from Boston.

## What we built (Track A: The Survey)

| Module | Job |
|---|---|
| **Scout** | Quotes addresses, deadlines, check sizes, and stage language verbatim from each org's own site, and pins addresses with OpenStreetMap plus the US Census Geocoder. |
| **Matchmaker** | Proposes a link only when one org's site names the other *and* the other links back, in the atlas or on its own site. |
| **Public-API cross-check** | Checks a live pick against USAspending, NSF, ROR, OpenAlex, and IRS 990 (ProPublica), accepting exact-name matches only. |
| **Radar** | Pulls new MA AI organizations from NSF and NIH SBIR/STTR awards, SEC Form D filings, and GitHub, and de-duplicates them against every entry by name, domain, and address. Net-new orgs become New Entity Candidates, and the reviewer supplies the website and \`offers\` that no registry has. |
| **Nova** | The sandbox, the review gate, backups and restore, and probes. Approving updates the scoreboard live, and only Commit writes to the file. |
| **Value chain** | Maps capital, buyers, talent, and shared scale, with warm paths. |
| **Give-to-Get** | A visibility and deal-flow score, plus a \`.well-known/mass-ai-atlas.json\` manifest and Schema.org kit for each org. |

## Results so far

- Proposals: **${c.proposals}**, including ${c.newEntities} New Entity Candidates. Of these, ${c.pending} are pending, ${c.staged} staged, ${c.accepted} approved in the sandbox, ${c.committed} committed, and ${c.rejected} rejected.
- By confidence: ${Object.entries(c.byConfidence).map(([k, v]) => `${k} ${v}`).join(", ")}
- Refusals logged: **${c.refusals}** (${Object.entries(c.refusalsByModule).map(([k, v]) => `${k} ${v}`).join(", ")})
- Organization websites read: **${s.orgSites.length}**${radar ? `\n- Last radar run: ${radar.leads} registry records → ${radar.organizations} orgs → ${radar.candidates.length} net-new, ${radar.matched.length} matched, ${radar.possible.length} possible duplicates refused` : ""}

### Probes

"Before" is git HEAD, "after" adds everything approved in the sandbox, and "preview" adds staged proposals too.

| Probe | Before | After | Preview |
|---|---|---|---|
${pr.rows.map(row).join("\n")}

### Refusals we would show a judge

${refs.map(r => `- **${r.entityName}** · \`${r.field}\`: ${r.reason}${r.source_url ? ` ([source](${r.source_url}))` : ""}`).join("\n")}

## Declared data sources

${s.apis.map(a => `- **${a.name}**${a.url ? ` (${a.url})` : ""}: ${a.use.replace(/ · \d+ cached responses/, "")}`).join("\n")}
- ${s.notUsed.join("\n- ")}

## Run it

\`\`\`bash
node weave/cli.js serve      # http://localhost:4848
node weave/cli.js radar      # registry discovery and de-duplication
node --test weave/test/weave.test.js
node scripts/validate.js
\`\`\`

*Dataset: Mass AI Atlas, The Open Accelerator (CC BY 4.0). Geocoding: © OpenStreetMap contributors (ODbL) and the US Census Bureau. Registry data: NSF, NIH, USAspending.gov, SEC, ROR (CC0), OpenAlex (CC0), and ProPublica.*
`;
  fs.writeFileSync(path.join(store.REPO, "CONCEPT_BRIEF.md"), md);
  return { path: "CONCEPT_BRIEF.md", markdown: md };
}

module.exports = { sources, bestRefusals, randomClaim, counts, brief };
