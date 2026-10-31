/* How a proposal changes an entry — one definition used by both the sandbox
   preview (in memory, never touches disk) and Nova's approve/export (on disk). */

const geoOf = d => ({ loc: d.loc, lat: d.lat, lng: d.lng, approx: Boolean(d.approx) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Returns [key, value|undefined, insertAfterKeys][] for yamledit, or null for
   evidence-only proposals. Throws if the proposal no longer fits the entry. */
function changesFor(p, d) {
  switch (p.op) {
    case "confirm": return null;
    case "addLink":
      if ((d.links || []).includes(p.after)) throw new Error(`${d.id} already links ${p.after}`);
      return [["links", [...(d.links || []), p.after], ["stages", "tags", "why"]]];
    case "setGeo":
      if (!same(geoOf(d), p.before)) throw new Error(`stale proposal: ${d.id}'s location changed since it was surveyed`);
      return [["loc", p.after.loc], ["lat", p.after.lat], ["lng", p.after.lng], ["approx", p.after.approx ? true : undefined, ["lng"]]];
    case "setApplyBy":
      if ((d.applyBy ?? null) !== (p.before ?? null)) throw new Error(`stale proposal: ${d.id}'s applyBy changed since it was surveyed`);
      return [["applyBy", p.after, ["offers"]]];
    case "setStages":
      if ((d.stages || []).length) throw new Error(`${d.id} already has stages`);
      return [["stages", p.after, ["tags", "why"]]];
    case "addFact": {
      const facts = d.facts || [];
      if (facts.some(([k]) => k === p.after[0])) throw new Error(`${d.id} already has a "${p.after[0]}" fact`);
      if (facts.length >= 6) throw new Error(`${d.id} already has 6 facts`);
      return [["facts", [...facts, p.after], ["applyNote", "applyBy", "offers"]]];
    }
    default: throw new Error(`unknown op ${p.op}`);
  }
}

/* Apply changes to a plain object (for the in-memory preview). */
function applyToObject(d, changes) {
  const out = { ...d };
  for (const [k, v] of changes) { if (v === undefined) delete out[k]; else out[k] = v; }
  return out;
}

/* DATA with every proposal in `props` applied, in order. Proposals that no
   longer fit are skipped and reported, never forced. */
function preview(DATA, props) {
  const byId = new Map(DATA.map((d, i) => [d.id, i]));
  const out = DATA.slice();
  const applied = [], skipped = [];
  for (const p of props) {
    if (p.op === "addEntity") {
      const e = p.final || p.after;
      if (byId.has(e.id) || out.some(d => d.name.toLowerCase() === e.name.toLowerCase())) { skipped.push({ id: p.id, reason: `${e.id} already exists` }); continue; }
      byId.set(e.id, out.length); out.push(e); applied.push(p.id); continue;
    }
    const i = byId.get(p.entity);
    if (i === undefined) { skipped.push({ id: p.id, reason: "entry gone" }); continue; }
    try {
      const ch = changesFor(p, out[i]);
      if (ch) out[i] = applyToObject(out[i], ch);
      applied.push(p.id);
    } catch (e) { skipped.push({ id: p.id, reason: e.message }); }
  }
  return { DATA: out, applied, skipped };
}

module.exports = { changesFor, applyToObject, preview, geoOf, same };
