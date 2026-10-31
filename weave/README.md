# Atlas Weave

Atlas Weave is a survey tool for maintainers. It looks for evidence that would improve
atlas entries and queues proposals for a person to review. It never edits the data on
its own.

```bash
node weave/cli.js serve            # dashboard at http://localhost:4848
node weave/cli.js survey csail     # one org, live
node weave/cli.js batch 20 --zero-edge
node weave/cli.js probes
node --test weave/test/weave.test.js            # offline tests
```

No dependencies beyond the repository's own (`js-yaml`, `ajv`). It uses Node's built-in
`fetch` and `http`.

## Modules

| Module | What it does | Writes |
|---|---|---|
| **Scout** (`scout.js`) | Reads the org's homepage and up to 4 contact or about pages. Extracts street addresses from page text and JSON-LD, then geocodes them with OpenStreetMap Nominatim. Also checks `/.well-known/mass-ai-atlas.json`. | proposals, refusals |
| **Matchmaker** (`matchmaker.js`) | Finds other atlas entries that the org's site links to or names. A link is proposed only if a second signal agrees: the other entry already links back in the atlas, or the other org's site mentions this one. | proposals, refusals |
| **Nova** (`nova.js`) | The review gate. `approve()` is the only code that writes `data/entities.yml`. It requires a named reviewer, rejects stale proposals, checks that the edit changed exactly one entry, then runs `scripts/validate.js` and restores the file if validation fails. Nova also computes the 7 probes and drafts manifests. | `entities.yml` (on approval only), `evidence.json` |

## Phase 2: sandbox and community tabs

- **Sandbox (dry run).** Staging a proposal (`stage` in the CLI, or **Stage** in the
  dashboard) previews it in memory. The probes, the graph, and the Warm-Path Explorer
  all show the staged result, and `entities.yml` is untouched. You can download the
  preview as YAML. **Export** approves every staged proposal under a named reviewer,
  one at a time, each followed by `validate.js`.
- **Confidence tiers.** *two-source* means an independent corroboration (OpenStreetMap,
  or a reciprocal link or mention). *same-site, 2 pages* means two pages of the org's
  own site agree; this tier is used for deadlines, check sizes, and stages, which no
  outside source can confirm. *self-attested* means the org's own `.well-known`
  manifest.
- **Tabs.** Community Value & Warm Paths, the Give-to-Get Portal (visibility score and
  claim kit), and Judge Demo & Brief (`node weave/cli.js brief` writes
  `CONCEPT_BRIEF.md`).
- **Refusal rules added in Phase 2:**
  - institutional mailing addresses, such as 77 Mass Ave for an MIT unit;
  - addresses quoted in a mail-it-to context;
  - meetup venues;
  - any scraped address that would overwrite a precise, human-checked one;
  - OpenStreetMap placing the street in a different town;
  - check sizes that appear on one page only or that conflict;
  - follow-on and side-letter amounts.

## The two-source rule

Every proposal carries:

- **Source 1:** a clickable `source_url` and a verbatim `quote`, which is a substring
  of that page's text.
- **Source 2:** an independent corroboration, such as an OpenStreetMap match within a
  set distance, a reciprocal atlas link (with the line number), or a reciprocal
  mention on the other org's site.

If the second source is missing, or the evidence is ambiguous (several addresses on
one site, or a link that fits two entries), the field goes to `data/refusals.json`
with the reason and the evidence that was seen.

## The probes

"Before" is `data/entities.yml` at git HEAD. "After" is the working copy.

1. Isolated entries (no link in or out)
2. Entries with no outbound links
3. One-way links (A→B with no B→A)
4. Approximate pins (`approx: true`)
5. Entries missing `stages` (hidden from every stage-filtered search)
6. Entries with a source-quoted, human-approved field (`data/evidence.json`)
7. Entries with a confirmed `.well-known` manifest
8. Community warm path: entries within 3 hops of a funder (new in Phase 2)

## Etiquette

- Every request identifies itself with an `AtlasWeave/0.1` User-Agent.
- Nominatim is limited to 1 request per second, as its usage policy requires.
- Every response is cached on disk for 24 hours in `weave/.cache/`, which is
  gitignored.
- The dashboard binds to `127.0.0.1` only and refuses cross-origin POSTs.

## Limits

- Address extraction is pattern-based. A site that publishes its address only as an
  image or inside a map embed yields a refusal, not a guess.
- Approving a proposal does not bump `lastVerified`. That field means a person
  checked the whole organization.
