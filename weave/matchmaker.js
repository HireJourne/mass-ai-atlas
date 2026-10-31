/* Matchmaker — warm-path links between atlas entries.

   For organization A it looks for other atlas entries that A's own site names
   or links to. A link A→B is proposed only when a second, independent signal
   agrees: B already links to A in the atlas (a reciprocal graph edge), or B's
   own site names or links to A. One-sided or ambiguous mentions are refused.
   It never edits data/entities.yml. */
const { crawlOrg } = require("./lib/pages");
const { hostOf, escapeRe, quoteAround } = require("./lib/text");
const store = require("./lib/store");
const { lineOf } = require("./lib/yamledit");

const MAX_PER_ENTITY = 5;
// Names too generic to count as a mention on their own.
const GENERIC = new Set(["mit", "harvard", "tufts", "babson", "northeastern", "boston university", "ai hub", "the engine", "engine", "greentown", "lab", "labs", "hub"]);

function hostIndex(DATA) {
  const m = new Map();
  for (const d of DATA) { const h = hostOf(d.url); m.set(h, [...(m.get(h) || []), d]); }
  return m;
}
const pathOf = u => { try { return new URL(u).pathname.replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };

/* Which atlas entry does a hyperlink point at? Entries can share a host
   (entrepreneurship.mit.edu, linkedin.com), so the entry whose url path is the
   longest prefix of the link's path wins; a tie is ambiguous. */
function resolveHref(href, host, hosts) {
  const owners = hosts.get(host);
  if (!owners) return { owners: [] };
  const lp = pathOf(href);
  const fits = owners.map(o => ({ o, p: pathOf(o.url) })).filter(({ p }) => lp === p || lp.startsWith(p + "/"));
  if (!fits.length) return { owners: [] };
  const best = Math.max(...fits.map(f => f.p.length));
  return { owners: fits.filter(f => f.p.length === best).map(f => f.o) };
}

/* Every mention of an atlas entry on a set of pages: href to its host, or its
   full name in the text. Returns Map<id, {quote, source_url, how}>. */
function mentions(pages, self, DATA, hosts) {
  const found = new Map();
  const ambiguous = [];
  const selfHost = hostOf(self.url);
  for (const p of pages) {
    for (const l of p.links) {
      if (!l.host || l.host === selfHost) continue;
      const { owners } = resolveHref(l.href, l.host, hosts);
      if (!owners.length) continue;
      if (owners.length > 1) { ambiguous.push({ host: l.host, ids: owners.map(o => o.id), source_url: p.url, quote: `<a href="${l.href}">${l.text}</a>` }); continue; }
      const b = owners[0];
      if (b.id === self.id || found.has(b.id)) continue;
      found.set(b.id, { source_url: p.url, quote: `link "${l.text || l.href}" → ${l.href}`, how: "hyperlink to its official site" });
    }
    // Names, longest first, so "MassChallenge HealthTech" claims its span before "MassChallenge".
    const claimed = [];
    const byLen = DATA.filter(b => b.id !== self.id && b.name.length >= 5 && !GENERIC.has(b.name.toLowerCase()) && !self.name.includes(b.name))
      .sort((a, b) => b.name.length - a.name.length);
    for (const b of byLen) {
      if (found.has(b.id)) continue;
      const re = new RegExp(`(?<![\\w-])${escapeRe(b.name)}(?![\\w-])`, "g");
      let m;
      while ((m = re.exec(p.text))) {
        const s = m.index, e = s + m[0].length;
        if (claimed.some(([a, z]) => s >= a && e <= z)) continue;
        claimed.push([s, e]);
        const quote = quoteAround(p.text, s, m[0].length);
        // A person's bio ("…is a Board Member of X") is a tie through a person, not between the orgs.
        const bio = /\b(is (?:the |a )?(?:founder|co-?founder|partner|managing|director|board member|advisor|professor|ceo)|board member|spends his|spends her|serves on|previously (?:at|was))\b/i.test(quote);
        found.set(b.id, { source_url: p.url, quote, how: bio ? "named in a person's bio — a tie through a person, weaker than an org-level link" : "named in page text" });
        break;
      }
    }
  }
  return { found, ambiguous };
}

const crawlCache = new Map();
async function pagesFor(d) {
  if (!crawlCache.has(d.id)) crawlCache.set(d.id, (await crawlOrg(d.url)).pages);
  return crawlCache.get(d.id);
}

async function match(a, { DATA }) {
  const report = { entity: a.id, name: a.name, proposals: [], refusals: [], considered: [] };
  const byId = new Map(DATA.map(d => [d.id, d]));
  const hosts = hostIndex(DATA);
  const pages = await pagesFor(a);
  if (!pages.length) return report;
  const { found, ambiguous } = mentions(pages, a, DATA, hosts);

  for (const amb of ambiguous)
    report.refusals.push(store.addRefusal({ entity: a.id, entityName: a.name, module: "matchmaker", field: "links",
      reason: `Ambiguous: that link on ${amb.host} fits ${amb.ids.length} atlas entries equally (${amb.ids.join(", ")}) — cannot tell which one is meant`,
      candidate: amb.ids.join("|"), source_url: amb.source_url, quote: amb.quote }));

  let n = 0;
  for (const [bid, ev] of found) {
    const b = byId.get(bid);
    if ((a.links || []).includes(bid)) continue;
    report.considered.push(bid);
    let corroboration = null;
    if ((b.links || []).includes(a.id)) {
      corroboration = { kind: "reciprocal atlas link", source_url: `https://github.com/holzerjm/mass-ai-atlas/blob/main/data/entities.yml#L${lineOf(b.id, "links")}`, detail: `${b.name} (${b.id}) already lists ${a.id} in its links — a person verified that edge` };
    } else {
      const bPages = await pagesFor(b);
      const back = mentions(bPages, b, DATA, hosts).found.get(a.id);
      if (back) corroboration = { kind: "reciprocal mention on the other org's site", source_url: back.source_url, quote: back.quote, detail: back.how };
    }
    if (!corroboration) {
      report.refusals.push(store.addRefusal({ entity: a.id, entityName: a.name, module: "matchmaker", field: "links",
        reason: `${a.name}'s site mentions ${b.name}, but nothing independent corroborates a relationship (no reciprocal link or mention)`,
        candidate: bid, source_url: ev.source_url, quote: ev.quote }));
      continue;
    }
    if (n >= MAX_PER_ENTITY) {
      report.refusals.push(store.addRefusal({ entity: a.id, entityName: a.name, module: "matchmaker", field: "links",
        reason: `Per-entry cap of ${MAX_PER_ENTITY} proposed links reached — left for a later pass`, candidate: bid, source_url: ev.source_url, quote: ev.quote }));
      continue;
    }
    n++;
    report.proposals.push(store.addProposal({ entity: a.id, entityName: a.name, module: "matchmaker", field: "links", op: "addLink", confidence: "two-source",
      before: a.links || [], after: bid,
      summary: `Link ${a.name} → ${b.name}`,
      evidence: { source_url: ev.source_url, quote: ev.quote, kind: `official site (${ev.how})` },
      corroboration }));
  }
  return report;
}

module.exports = { match, mentions, hostIndex };
