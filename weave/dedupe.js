/* De-duplication against the atlas: name, domain, and street address.
   Returns one of:
     match     — the same organization as an existing entry
     possible  — looks related (shared tokens or a shared building); a person
                 must decide, so nothing new is created
     new       — no entry resembles it */
const { normName } = require("./lib/apis");
const { hostOf, findAddresses, normStreet } = require("./lib/text");

// Hosts shared by many unrelated orgs: a match on these proves nothing.
const SHARED_HOSTS = new Set(["linkedin.com", "github.com", "medium.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "meetup.com", "luma.com", "lu.ma", "eventbrite.com", "sites.google.com", "notion.site", "substack.com", "wixsite.com"]);
const STOP = new Set(["and", "of", "for", "the", "ai", "labs", "lab", "technologies", "technology", "tech", "systems", "solutions", "ventures", "boston", "massachusetts", "ma", "inc", "therapeutics", "bio", "health", "robotics", "capital", "partners", "center", "institute"]);
const tokens = s => normName(s).split(" ").filter(t => t.length > 1 && !STOP.has(t));

function index(DATA) {
  return DATA.map(d => {
    const [a] = findAddresses(d.loc);
    return { d, name: normName(d.name), toks: tokens(d.name), host: hostOf(d.url), street: a ? normStreet(`${a.number} ${a.street}`) : "", city: (d.loc.split(",").pop() || "").trim().toLowerCase() };
  });
}

function dedupe(c, idx) {
  const reasons = [];
  const name = normName(c.name);
  const host = c.url ? hostOf(c.url) : "";
  const exact = idx.filter(e => e.name && e.name === name);
  if (exact.length === 1) return { status: "match", entry: exact[0].d, reasons: [`normalized name "${name}" equals ${exact[0].d.id}`] };
  if (host && !SHARED_HOSTS.has(host)) {
    const byHost = idx.filter(e => e.host === host);
    if (byHost.length === 1) return { status: "match", entry: byHost[0].d, reasons: [`website ${host} is ${byHost[0].d.id}'s`] };
    if (byHost.length > 1) return { status: "possible", entries: byHost.map(e => e.d), reasons: [`website ${host} is shared by ${byHost.map(e => e.d.id).join(", ")}`] };
  }
  const ct = tokens(c.name);
  const fuzzy = idx.filter(e => {
    if (!ct.length || !e.toks.length) return false;
    const a = new Set(ct), b = new Set(e.toks);
    const aInB = ct.every(t => b.has(t)), bInA = e.toks.every(t => a.has(t));
    const strong = (x) => x.length >= 2 || (x.length === 1 && x[0].length >= 6);
    return (aInB && strong(ct)) || (bInA && strong(e.toks));
  });
  if (fuzzy.length) return { status: "possible", entries: fuzzy.map(e => e.d), reasons: fuzzy.map(e => `name "${c.name}" overlaps "${e.d.name}" (${e.d.id})`) };
  const notes = [];
  if (c.address) {
    const [a] = findAddresses(`${c.address}, ${c.city || ""}`);
    if (a) {
      const st = normStreet(`${a.number} ${a.street}`);
      const same = idx.filter(e => e.street && e.street === st);
      if (same.length) notes.push(`shares the building at ${a.number} ${a.street} with ${same.map(e => e.d.id).join(", ")} (coworking or lab space — not a duplicate on its own)`);
    }
  }
  reasons.push(`no entry matches name "${name}"${host ? `, website ${host}` : ""}${c.address ? `, or address` : ""}`);
  return { status: "new", reasons: [...reasons, ...notes] };
}

module.exports = { dedupe, index, tokens, SHARED_HOSTS };
