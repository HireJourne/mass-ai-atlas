/* Surgical line edits to data/entities.yml: changes only the lines of one
   entry, so comments, ordering and formatting elsewhere survive. */
const fs = require("fs");
const path = require("path");
const { DATA } = require("./store");

const FILE = path.join(DATA, "entities.yml");

function blockRange(lines, id) {
  const start = lines.findIndex(l => l === `- id: ${id}` || l === `- id: "${id}"`);
  if (start < 0) throw new Error(`entry ${id} not found in entities.yml`);
  let end = start + 1;
  while (end < lines.length && /^\s{2}\S/.test(lines[end])) end++;
  return [start, end];   // [start, end)
}

function scalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return `'${s}'`;   // dates stay strings, matching the file's style
  return /^[A-Za-z0-9][^#:]*$/.test(s) && !/\s$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
}
// Inside a flow sequence, commas and brackets end a plain scalar — quote those.
function flowItem(v) {
  if (Array.isArray(v)) return flowSeq(v);
  if (typeof v === "string" && /[,[\]{}]/.test(v)) return JSON.stringify(v);
  return scalar(v);
}
function flowSeq(arr) { return `[${arr.map(flowItem).join(", ")}]`; }

/* Set or delete keys of one entry. order = keys to insert after, first found wins. */
function editEntry(text, id, changes) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = editLF(text.replace(/\r\n/g, "\n"), id, changes);
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}
function editLF(text, id, changes) {
  const lines = text.split("\n");
  const [s, e] = blockRange(lines, id);
  const block = lines.slice(s, e);
  const idx = k => block.findIndex(l => l.startsWith(`  ${k}:`));
  for (const [key, value, after] of changes) {
    const i = idx(key);
    if (value === undefined) { if (i >= 0) block.splice(i, 1); continue; }
    const line = `  ${key}: ${Array.isArray(value) ? flowSeq(value) : scalar(value)}`;
    if (i >= 0) { block[i] = line; continue; }
    let at = -1;
    for (const k of after || []) { const j = idx(k); if (j >= 0) { at = j + 1; break; } }
    if (at < 0) at = block.length;
    block.splice(at, 0, line);
  }
  lines.splice(s, e - s, ...block);
  return lines.join("\n");
}

/* Append one new entry at the end of the file, under a marked section. */
const ORDER = ["id", "name", "cat", "loc", "lat", "lng", "approx", "url", "badge", "desc", "why", "tags", "stages", "links", "offers", "applyBy", "applyNote", "facts", "added", "lastVerified"];
const SECTION = "# ---------- ADDED VIA ATLAS WEAVE (human-reviewed new entities) ----------";
function appendEntry(text, entry) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let t = text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
  if (!t.includes(SECTION)) t += `\n${SECTION}\n`;
  const lines = ORDER.filter(k => entry[k] !== undefined && entry[k] !== "" && !(Array.isArray(entry[k]) && !entry[k].length))
    .map((k, i) => `${i ? "  " : "- "}${k}: ${Array.isArray(entry[k]) ? flowSeq(entry[k]) : scalar(entry[k])}`);
  t += lines.join("\n") + "\n";
  return eol === "\n" ? t : t.replace(/\n/g, eol);
}

function lineOf(id, key) {
  const lines = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n").split("\n");
  const [s, e] = blockRange(lines, id);
  const i = lines.slice(s, e).findIndex(l => l.startsWith(`  ${key}:`));
  return (i >= 0 ? s + i : s) + 1;
}

module.exports = { FILE, editEntry, appendEntry, lineOf };
