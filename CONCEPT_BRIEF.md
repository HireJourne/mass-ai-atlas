# Atlas Weave: Concept Brief

*Generated 2026-10-31 19:25 UTC by `node weave/cli.js brief`. Every number below is computed from the repository at that moment.*

**Atlas Weave** is a survey engine for the Mass AI Atlas, built by the community for the community. It finds evidence on organizations' own websites and in public registries, corroborates every claim with a second source, and queues each change for a named human reviewer. It also logs what it refused to do. `data/entities.yml` changes only when a maintainer clicks **Commit Approved**: a backup is taken first, and `validate.js` runs after every write.

## The gap (git HEAD)

- **35** entries have no `stages`, so they are hidden from every stage-filtered founder search.
- **104** entries have no outbound links, and **74** have no links at all, so no warm path reaches them.
- **87** pins are neighborhood-level.
- Only **15** of 197 entries are more than 25 km from Boston.

## What we built (Track A: The Survey)

| Module | Job |
|---|---|
| **Scout** | Quotes addresses, deadlines, check sizes, and stage language verbatim from each org's own site, and pins addresses with OpenStreetMap plus the US Census Geocoder. |
| **Matchmaker** | Proposes a link only when one org's site names the other *and* the other links back, in the atlas or on its own site. |
| **Public-API cross-check** | Checks a live pick against USAspending, NSF, ROR, OpenAlex, and IRS 990 (ProPublica), accepting exact-name matches only. |
| **Radar** | Pulls new MA AI organizations from NSF and NIH SBIR/STTR awards, SEC Form D filings, and GitHub, and de-duplicates them against every entry by name, domain, and address. Net-new orgs become New Entity Candidates, and the reviewer supplies the website and `offers` that no registry has. |
| **Nova** | The sandbox, the review gate, backups and restore, and probes. Approving updates the scoreboard live, and only Commit writes to the file. |
| **Value chain** | Maps capital, buyers, talent, and shared scale, with warm paths. |
| **Give-to-Get** | A visibility and deal-flow score, plus a `.well-known/mass-ai-atlas.json` manifest and Schema.org kit for each org. |

## Results so far

- Proposals: **84**, including 15 New Entity Candidates. Of these, 84 are pending, 0 staged, 0 approved in the sandbox, 0 committed, and 0 rejected.
- By confidence: two-source 68, registry + geocoder 15, same-institution (ROR) 1
- Refusals logged: **425** (scout 209, matchmaker 204, public-apis 10, radar 2)
- Organization websites read: **208**
- Last radar run: 41 registry records → 39 orgs → 15 net-new, 0 matched, 1 possible duplicates refused

### Probes

"Before" is git HEAD, "after" adds everything approved in the sandbox, and "preview" adds staged proposals too.

| Probe | Before | After | Preview |
|---|---|---|---|
| 1 · Isolated entries (no link in or out) | 74 | 74 | 74 |
| 2 · Entries with no outbound links | 104 | 104 | 104 |
| 3 · One-way links (A→B with no B→A) | 118 | 118 | 118 |
| 4 · Approximate pins (approx: true) | 87 | 87 | 87 |
| 5 · Entries missing stages (hidden from stage searches) | 35 | 35 | 35 |
| 6 · Entries with a source-quoted, reviewed field | 0 | 0 | 0 |
| 7 · Geographic reach: entries >25 km from Boston | 15 | 15 | 15 |
| Warm path: entries ≤3 hops from a funder | 107 | 107 | 107 |
| Value-chain reachability: entries ≤3 hops from all 4 pillars | 41 | 41 | 41 |
| Entries with a confirmed .well-known manifest | 0 | 0 | 0 |

### Refusals we would show a judge

- **MIT Jameel Clinic** · `loc`: Refused generic address "77 Massachusetts Ave Cambridge, MA 02139": MIT's institutional mailing address (Building 7) — used by hundreds of MIT units ([source](https://jclinic.mit.edu/))
- **Commonwealth Fusion Systems** · `offers`: Refused to add `grants` to offers: USAspending shows this org RECEIVED federal grants — that validates it is real and active, but it does not mean it offers grants to founders ([source](https://www.usaspending.gov/award/ASST_NON_DESC0021623_089))
- **MassChallenge** · `offers`: Refused to add `customers` to offers: a federal contract means this org SELLS to the government — it is not evidence that it buys from or pilots with startups ([source](https://www.usaspending.gov/award/CONT_AWD_19AQMM26P1198_1900_-NONE-_-NONE-))
- **Flybridge** · `facts`: Ambiguous check size: the site quotes 3 different amounts ([source](https://www.flybridge.com/))
- **Companyon Ventures** · `facts`: Unverified check size: stated on one page only — not proposed ([source](https://companyon.vc/investor.md))

## Declared data sources

- **Organizations' own websites**: homepage + up to 6 same-site contact/about/apply/partner pages per org — the primary source of quotes
- **OpenStreetMap Nominatim** (https://nominatim.openstreetmap.org/): independent geocoding of quoted addresses (1 req/s, 24 h cache)
- **US Census Geocoder** (https://geocoding.geo.census.gov/geocoder/): second geocoder for street pins and new-entity addresses
- **NSF Awards API** (https://api.nsf.gov/services/v1/awards.json): MA SBIR/STTR awardees (radar) and per-org award lookups
- **NIH RePORTER API** (https://api.reporter.nih.gov/): MA SBIR/STTR projects (radar)
- **USAspending.gov API** (https://api.usaspending.gov/): federal grants and contracts received, per org
- **SEC EDGAR full-text search** (https://efts.sec.gov/LATEST/search-index): Form D filings (radar) — disabled: the SEC requires a contact email; set WEAVE_CONTACT_EMAIL
- **GitHub organization search API** (https://api.github.com/search/users): newest MA-located orgs (radar; unauthenticated: 10 searches/min, 60 lookups/h)
- **ROR API** (https://api.ror.org/): institution identity and city for universities and companies
- **OpenAlex API** (https://api.openalex.org/): university research activity (talent signal; shared keyless daily budget)
- **ProPublica Nonprofit Explorer API** (https://projects.propublica.org/nonprofits/api): IRS 990 registration for MA accelerators, communities and spaces
- **Mass AI Atlas dataset (git HEAD)** (https://github.com/holzerjm/mass-ai-atlas/blob/main/data/entities.yml): baseline for the probes; reciprocal links as corroboration (linked to the exact line)
- **/.well-known/mass-ai-atlas.json** (https://github.com/holzerjm/mass-ai-atlas/blob/main/docs/well-known-manifest.md): self-verification manifests published by orgs
- No LLM generates any quote or value — every quote is a substring of a fetched page or a verbatim registry record
- No search engines, scraped aggregators, paid data, or API keys

## Run it

```bash
node weave/cli.js serve      # http://localhost:4848
node weave/cli.js radar      # registry discovery and de-duplication
node --test weave/test/weave.test.js
node scripts/validate.js
```

*Dataset: Mass AI Atlas, The Open Accelerator (CC BY 4.0). Geocoding: © OpenStreetMap contributors (ODbL) and the US Census Bureau. Registry data: NSF, NIH, USAspending.gov, SEC, ROR (CC0), OpenAlex (CC0), and ProPublica.*
