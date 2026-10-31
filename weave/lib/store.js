/* Atlas Weave — state files.
   Scout and Matchmaker only ever write here (proposals / refusals). The single
   path that edits data/entities.yml is nova.js#approve, which requires a named
   human reviewer. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..", "..");
const DATA = path.join(REPO, "data");
const FILES = {
  proposals: path.join(DATA, "proposals.json"),
  refusals: path.join(DATA, "refusals.json"),
  evidence: path.join(DATA, "evidence.json"),
};

function read(name) {
  try { return JSON.parse(fs.readFileSync(FILES[name], "utf8")); }
  catch { return []; }
}
function write(name, rows) {
  fs.writeFileSync(FILES[name], JSON.stringify(rows, null, 2) + "\n");
}
const now = () => new Date().toISOString();
const pid = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 10);

/* A proposal is keyed by entity+field+proposed value, so re-surveying the same
   org does not duplicate it. A decided proposal is never reopened. */
function addProposal(p) {
  const rows = read("proposals");
  const id = pid([p.entity, p.field, p.after]);
  const existing = rows.find(r => r.id === id);
  if (existing) return existing;
  const row = { id, status: "pending", created: now(), ...p };
  rows.push(row);
  write("proposals", rows);
  return row;
}

function addRefusal(r) {
  const rows = read("refusals");
  const key = pid([r.entity, r.field, r.reason, r.candidate ?? null]);
  const existing = rows.find(x => x.key === key);
  if (existing) { existing.lastSeen = now(); write("refusals", rows); return existing; }
  const row = { key, created: now(), lastSeen: now(), ...r };
  rows.push(row);
  write("refusals", rows);
  return row;
}

/* Drop a refusal that a later, corroborated proposal supersedes. */
function removeRefusal(key) {
  const rows = read("refusals");
  const next = rows.filter(r => r.key !== key);
  if (next.length !== rows.length) write("refusals", next);
}

module.exports = { REPO, DATA, FILES, read, write, now, addProposal, addRefusal, removeRefusal };
