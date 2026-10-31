/* Atlas Weave — run the live survey (Scout + Matchmaker + public-API
   cross-check) for one organization. Writes only data/proposals.json and
   data/refusals.json. */
const scout = require("./scout");
const matchmaker = require("./matchmaker");
const { corroborate } = require("./corroborate");
const nova = require("./nova");
const store = require("./lib/store");

async function surveyOne(id, { apis = true } = {}) {
  const DATA = nova.loadDATA();
  const d = DATA.find(x => x.id === id);
  if (!d) throw new Error(`no entry "${id}"`);
  const s = await scout.survey(d, { DATA });
  const m = await matchmaker.match(d, { DATA });
  const c = apis ? await corroborate(d, { scout: s, matchmaker: m, DATA }) : { signals: [], refusals: [], proposals: [] };
  if (apis) saveSignals(d.id, c.signals);
  // Re-read so proposals carry anything the cross-check attached (Census).
  const all = store.read("proposals");
  const fresh = p => all.find(x => x.id === p.id) || p;
  return {
    entity: d.id, name: d.name, url: d.url, cat: d.cat, loc: d.loc, approx: Boolean(d.approx), links: d.links || [],
    scout: s, matchmaker: m, apiSignals: c.signals,
    proposals: [...s.proposals, ...m.proposals, ...(c.proposals || [])].map(fresh),
    // Refusals still on file (a corroborated proposal can supersede one).
    refusals: (() => { const keys = new Set(store.read("refusals").map(r => r.key)); return [...s.refusals, ...m.refusals, ...c.refusals].filter(r => keys.has(r.key)); })(),
  };
}

/* Last public-API cross-check per entry — validation signals, never data changes. */
const fs = require("fs");
const path = require("path");
const SIGNALS = path.join(store.DATA, "api-signals.json");
function readSignals() { try { return JSON.parse(fs.readFileSync(SIGNALS, "utf8")); } catch { return {}; } }
function saveSignals(id, signals) {
  const all = readSignals();
  all[id] = { at: store.now(), signals };
  fs.writeFileSync(SIGNALS, JSON.stringify(all, null, 2) + "\n");
}

module.exports = { surveyOne, readSignals, ...nova };
