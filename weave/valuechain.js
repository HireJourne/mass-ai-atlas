/* The 4-pillar ecosystem value chain, computed from the atlas fields:
     capital — offers funding or grants (with Check size / Terms / applyBy where known)
     buyers  — corporate or gov entries that offer customers (who startups sell to)
     talent  — talent pipelines in university, student, and community entries
     scale   — shared compute and space that reduce burn
   "Reachable" means within 3 hops in the link graph (staged/approved links included). */

const PILLARS = [
  { key: "capital", label: "Capital stack", test: d => (d.offers || []).some(o => o === "funding" || o === "grants") },
  { key: "buyers", label: "Employer partners as buyers & strategic investors", test: d => ["corporate", "gov"].includes(d.cat) && (d.offers || []).includes("customers") },
  { key: "talent", label: "Talent & workforce", test: d => ["university", "student", "community"].includes(d.cat) && (d.offers || []).includes("talent") },
  { key: "scale", label: "Shared economies of scale", test: d => (d.offers || []).some(o => o === "compute" || o === "space") },
];

function adjacency(DATA) {
  const ids = new Set(DATA.map(d => d.id));
  const adj = new Map(DATA.map(d => [d.id, new Set()]));
  for (const d of DATA) for (const l of d.links || []) if (ids.has(l)) { adj.get(d.id).add(l); adj.get(l).add(d.id); }
  return adj;
}

/* BFS up to maxHops; returns Map<id, prevId>. */
function bfs(adj, start, maxHops = 3) {
  const prev = new Map([[start, null]]);
  let frontier = [start];
  for (let h = 0; h < maxHops && frontier.length; h++) {
    const next = [];
    for (const x of frontier) for (const y of adj.get(x) || []) if (!prev.has(y)) { prev.set(y, x); next.push(y); }
    frontier = next;
  }
  return prev;
}
const pathTo = (prev, id) => { if (!prev.has(id)) return null; const p = []; for (let c = id; c !== null; c = prev.get(c)) p.unshift(c); return p; };

/* Entries that reach (or are) a member of all four pillars within 3 hops. */
function reachability(DATA) {
  const adj = adjacency(DATA);
  const members = PILLARS.map(p => new Set(DATA.filter(p.test).map(d => d.id)));
  let n = 0;
  for (const d of DATA) {
    const seen = bfs(adj, d.id, 3);
    if (members.every(m => [...seen.keys()].some(id => m.has(id)))) n++;
  }
  return n;
}

const BOSTON = { lat: 42.3601, lng: -71.0589 };
function kmFromBoston(d) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(d.lat - BOSTON.lat), dLng = r(d.lng - BOSTON.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(BOSTON.lat)) * Math.cos(r(d.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const outsideBoston = DATA => DATA.filter(d => kmFromBoston(d) > 25).length;

/* The Capital, Buyers & Scale view for a stage and/or a focal company. */
function view({ DATA, baseById, unlockedEdge, stage = null, focus = null }) {
  const adj = adjacency(DATA);
  const byId = new Map(DATA.map(d => [d.id, d]));
  const today = new Date().toISOString().slice(0, 10);
  const prev = focus && byId.has(focus) ? bfs(adj, focus, 4) : null;
  const unlockedFields = d => {
    const b = baseById.get(d.id);
    if (!b) return ["new entry"];
    return ["loc", "stages", "applyBy", "facts", "links", "offers"].filter(k => JSON.stringify(b[k]) !== JSON.stringify(d[k]));
  };
  const fact = (d, k) => (d.facts || []).find(([l]) => l === k)?.[1] || null;
  const pillars = PILLARS.map(p => {
    let rows = DATA.filter(p.test).filter(d => !stage || !(d.stages || []).length || d.stages.includes(+stage));
    rows = rows.map(d => {
      const path = prev ? pathTo(prev, d.id) : null;
      return {
        id: d.id, name: d.name, cat: d.cat, url: d.url, loc: d.loc, offers: d.offers, stages: d.stages || [],
        checkSize: fact(d, "Check size"), terms: fact(d, "Terms"), equity: fact(d, "Equity"),
        applyBy: d.applyBy || null, applyOpen: d.applyBy === "rolling" || (!!d.applyBy && d.applyBy >= today),
        nonDilutive: (d.offers || []).includes("grants"), dilutive: (d.offers || []).includes("funding"),
        unlocked: unlockedFields(d),
        path: path ? path.map((id, i) => ({ id, name: byId.get(id).name, cat: byId.get(id).cat, unlocked: i ? unlockedEdge(path[i - 1], id) : null })) : null,
        kmFromBoston: Math.round(kmFromBoston(d)),
      };
    });
    rows.sort((a, b) => (a.path ? a.path.length : 99) - (b.path ? b.path.length : 99) || (b.checkSize ? 1 : 0) - (a.checkSize ? 1 : 0) || (b.applyOpen ? 1 : 0) - (a.applyOpen ? 1 : 0) || a.name.localeCompare(b.name));
    return { key: p.key, label: p.label, count: rows.length, reachable: prev ? rows.filter(r => r.path).length : null, rows: rows.slice(0, 15) };
  });
  const f = focus && byId.get(focus);
  return {
    stage, focus: f ? { id: f.id, name: f.name, cat: f.cat, loc: f.loc, url: f.url, links: (f.links || []).map(id => ({ id, name: byId.get(id)?.name, unlocked: unlockedEdge(f.id, id) })), kmFromBoston: Math.round(kmFromBoston(f)) } : null,
    pillars,
  };
}

module.exports = { PILLARS, reachability, outsideBoston, kmFromBoston, view, adjacency };
