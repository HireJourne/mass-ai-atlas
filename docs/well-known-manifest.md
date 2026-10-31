# Self-verification manifest: `/.well-known/mass-ai-atlas.json`

An organization listed in the atlas can vouch for its own entry by serving a small
JSON file from the same host as the `url` in its entry:

```
https://<your official site>/.well-known/mass-ai-atlas.json
```

```json
{
  "version": 1,
  "atlas_id": "csail",
  "name": "MIT CSAIL",
  "url": "https://www.csail.mit.edu",
  "loc": "Stata Center, 32 Vassar St, Cambridge",
  "offers": ["talent", "community"],
  "contact": "someone@example.org",
  "published": "2026-10-31"
}
```

`atlas_id` is required and must equal the entry's `id`. Every other field is optional.

## What Atlas Weave does with it

Scout (in `weave/`) checks for the file on every survey.

- **Served from the entry's own host and naming its `atlas_id`:** Scout queues a
  `selfVerified` confirmation for a maintainer. The org's control of its own domain
  is the corroborating signal. Approval records evidence only and never changes
  `data/entities.yml`.
- **Served from a different host, or naming a different `atlas_id`:** refused.
- **Any field that differs from the atlas:** logged in `data/refusals.json` for the
  reviewer to see, never proposed. A self-claim is one source. Addresses still need
  OpenStreetMap to agree before anything moves.

The manifest does not set `lastVerified`. That field still means that a maintainer
checked the organization.

To get a draft for your entry, run `node weave/cli.js manifest <id>`, or use
"Draft manifest" in the dashboard.
