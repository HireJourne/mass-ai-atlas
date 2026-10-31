/* Nova — the human review gate, the sandbox, probes, backups, and community kits.

   Proposal lifecycle:
     pending  → (Stage)   preview only, no reviewer needed
     pending  → (Approve) "accepted": a named reviewer approved it IN THE SANDBOX.
                The After scoreboard updates; data/entities.yml does NOT change.
     accepted → (Commit Approved to entities.yml) "approved": written to the file.
     pending/accepted → (Reject / Undo)

   commit() is the ONLY code in Atlas Weave that writes data/entities.yml. It
   requires a named reviewer, takes a backup first, applies each accepted
   proposal one at a time, and runs scripts/validate.js after each; a failing
   validation restores the previous file and stops. */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const Ajv = require("ajv");
const { execFileSync, spawnSync } = require("child_process");
const store = require("./lib/store");
const { FILE, editEntry, appendEntry } = require("./lib/yamledit");
const { changesFor, preview, same } = require("./lib/apply");
const { loadData } = require("../scripts/load-data");

const loadYaml = t => yaml.load(t, { schema: yaml.CORE_SCHEMA });

/* Memoization keyed on file modification times: parsing + validating the
   YAML, spawning git, and replaying the sandbox only happen again when a file
   they depend on actually changes. Writes (commit, restore) always change an
   mtime, so nothing stale is ever served after them. */
const stamp = (...files) => files.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join("|");
const GIT = path.join(store.REPO, ".git");
function headStamp() {
  let ref = "";
  try { ref = fs.readFileSync(path.join(GIT, "HEAD"), "utf8").trim().replace(/^ref:\s*/, ""); } catch {}
  return `${ref}|${stamp(path.join(GIT, "HEAD"), path.join(GIT, ref), path.join(GIT, "packed-refs"))}`;
}
function memo(fn, keyFn) {
  const cache = new Map();   // one entry per argument list, replaced when its key changes
  return (...args) => {
    const a = JSON.stringify(args), k = keyFn(...args);
    const hit = cache.get(a);
    if (hit && hit.k === k) return hit.v;
    const v = fn(...args);
    cache.set(a, { k, v });
    return v;
  };
}
const DATA_FILES = () => [FILE, path.join(store.DATA, "entities.schema.yml"), path.join(store.DATA, "categories.yml"), path.join(store.DATA, "stages.yml")];
const loadDATA = memo(() => loadData().DATA, () => stamp(...DATA_FILES()));

function runValidate() {   // never cached: the commit gate depends on a fresh run
  const r = spawnSync(process.execPath, [path.join(store.REPO, "scripts", "validate.js")], { encoding: "utf8", cwd: store.REPO });
  return { ok: r.status === 0, code: r.status, output: (r.stdout || "") + (r.stderr || "") };
}
// For the status pill only (validate.js also checks dates against today, hence the day in the key).
const runValidateCached = memo(runValidate, () => stamp(...DATA_FILES()) + new Date().toISOString().slice(0, 10));

function needReviewer(reviewer, verb) {
  reviewer = String(reviewer || "").trim();
  if (!reviewer) throw new Error(`A named human reviewer is required to ${verb}.`);
  return reviewer;
}
const findP = (rows, id) => { const p = rows.find(r => r.id === id); if (!p) throw new Error(`no proposal ${id}`); return p; };
const CLEAR = { reviewer: undefined, note: undefined, decided: undefined, final: undefined, website: undefined };

/* ---------------- new-entity validation ----------------------------------- */
let entryValidator = null;
function validateEntry(e) {
  if (!entryValidator) {
    const schema = loadYaml(fs.readFileSync(path.join(store.DATA, "entities.schema.yml"), "utf8"));
    entryValidator = new Ajv({ allErrors: true }).compile(schema.items);
  }
  return entryValidator(e) ? [] : entryValidator.errors.map(x => `${x.instancePath || "entry"} ${x.message}`);
}

/* Reviewer-completed fields for a New Entity Candidate. The official website
   must load and name the organization — the system never guesses a domain. */
async function completeEntity(p, edits = {}) {
  const { get } = require("./lib/fetcher");
  const { htmlToText, quoteAround, escapeRe } = require("./lib/text");
  const { normName } = require("./lib/apis");
  const e = { ...p.after };
  for (const k of ["name", "url", "desc", "cat"]) if (typeof edits[k] === "string" && edits[k].trim()) e[k] = edits[k].trim();
  if (Array.isArray(edits.offers)) e.offers = edits.offers;
  if (!e.offers || !e.offers.length) throw new Error("Choose at least one thing this organization offers founders (offers is required, and no registry can say).");
  if (!/^https:\/\//.test(e.url || "")) throw new Error("Enter the organization's official https:// website. No registry lists one, and Atlas Weave will not guess a domain.");
  const r = await get(e.url);
  if (!r.status || r.status >= 400) throw new Error(`The website ${e.url} did not load (${r.status || r.error}).`);
  const text = htmlToText(r.body);
  const words = normName(e.name).split(" ").filter(w => w.length > 2);
  const m = words.length ? text.match(new RegExp(words.map(escapeRe).join("\\W+(?:\\w+\\W+)?"), "i")) : null;
  if (!m) throw new Error(`The page at ${e.url} never names "${e.name}". Check that this is the right website.`);
  const errs = validateEntry(e);
  const DATA = loadDATA();
  if (DATA.some(d => d.id === e.id)) errs.push(`id ${e.id} already exists`);
  if (DATA.some(d => d.name.toLowerCase() === e.name.toLowerCase())) errs.push(`name "${e.name}" already exists`);
  if (errs.length) throw new Error("Not schema-valid: " + errs.join("; "));
  return { entry: e, website: { source_url: r.finalUrl, quote: quoteAround(text, m.index, m[0].length, 120), kind: "official website (entered by reviewer, verified to name the org)" } };
}

/* ---------------- review actions (sandbox only) --------------------------- */
async function accept(id, reviewer, note = "", edits = {}) {
  reviewer = needReviewer(reviewer, "approve a proposal");
  const rows = store.read("proposals");
  const p = findP(rows, id);
  if (p.status !== "pending") throw new Error(`proposal ${id} is already ${p.status}`);
  if (!p.evidence?.source_url || !p.evidence?.quote || !p.corroboration?.source_url)
    throw new Error("proposal lacks a source_url, quote, or corroborating source — it cannot be approved");
  if (p.op === "addEntity") {
    const done = await completeEntity(p, edits);
    p.final = done.entry; p.website = done.website;
  } else {
    // It must still fit the data as it will be after everything already accepted.
    const d = sandbox({ includeStaged: false }).DATA.find(x => x.id === p.entity);
    if (!d) throw new Error(`entry ${p.entity} no longer exists`);
    changesFor(p, d);
  }
  Object.assign(p, { status: "accepted", staged: false, reviewer, note, decided: store.now() });
  store.write("proposals", rows);
  return { proposal: p };
}
const approve = accept;   // "Approve" in the UI and CLI means approve-in-sandbox

function reject(id, reviewer, note = "") {
  reviewer = needReviewer(reviewer, "reject a proposal");
  const rows = store.read("proposals");
  const p = findP(rows, id);
  if (!["pending", "accepted"].includes(p.status)) throw new Error(`proposal ${id} is already ${p.status}`);
  Object.assign(p, { status: "rejected", staged: false, reviewer, note, decided: store.now() });
  store.write("proposals", rows);
  return { proposal: p };
}

/* Undo a sandbox decision (accepted or rejected → pending). Committed ones can't be undone here. */
function undo(id) {
  const rows = store.read("proposals");
  const p = findP(rows, id);
  if (!["accepted", "rejected"].includes(p.status)) throw new Error(`proposal ${id} is ${p.status}; only sandbox decisions can be undone`);
  Object.assign(p, { status: "pending", ...CLEAR });
  store.write("proposals", rows);
  return { proposal: p };
}

function setStaged(id, staged) {
  const rows = store.read("proposals");
  const p = findP(rows, id);
  if (p.status !== "pending") throw new Error(`proposal ${id} is ${p.status}; only pending proposals can be staged`);
  if (p.op === "addEntity" && staged) throw new Error("New Entity Candidates need a reviewer's website and offers — approve them instead of staging");
  p.staged = Boolean(staged);
  store.write("proposals", rows);
  return { proposal: p };
}

/* ---------------- sandbox ------------------------------------------------- */
const accepted = () => store.read("proposals").filter(p => p.status === "accepted");
const staged = () => store.read("proposals").filter(p => p.status === "pending" && p.staged);

const sandbox = memo(sandboxUncached, () => stamp(...DATA_FILES(), store.FILES.proposals, store.FILES.evidence));
function sandboxUncached({ includeStaged = true } = {}) {
  const DATA = loadDATA();
  const list = [...accepted(), ...(includeStaged ? staged() : [])];
  const pv = preview(DATA, list);
  const appliedSet = new Set(pv.applied);
  const extraEvidence = list.filter(p => appliedSet.has(p.id)).map(p => ({ entity: p.op === "addEntity" ? (p.final || p.after).id : p.entity, field: p.field }));
  return { DATA: pv.DATA, applied: pv.applied, skipped: pv.skipped, list, evidence: [...store.read("evidence"), ...extraEvidence] };
}

/* Accepted + staged as YAML text — for download, never written to disk. */
function previewYaml() {
  let text = fs.readFileSync(FILE, "utf8");
  for (const p of [...accepted(), ...staged()]) {
    try {
      if (p.op === "addEntity") { if (p.final) text = appendEntry(text, p.final); continue; }
      const d = loadYaml(text).find(x => x.id === p.entity);
      const ch = d && changesFor(p, d);
      if (ch) text = editEntry(text, p.entity, ch);
    } catch {}
  }
  return text;
}

/* ---------------- the commit gate ----------------------------------------- */
function commitOne(p) {
  const before = fs.readFileSync(FILE, "utf8");
  let after = null;
  if (p.op === "addEntity") {
    if (!p.final) throw new Error("new entity has no reviewer-completed fields");
    after = appendEntry(before, p.final);
    const A = loadYaml(before), B = loadYaml(after);
    if (B.length !== A.length + 1 || !same(B[B.length - 1], p.final)) throw new Error("append did not produce exactly the new entry — aborted");
  } else {
    const d = loadDATA().find(x => x.id === p.entity);
    if (!d) throw new Error(`entry ${p.entity} no longer exists`);
    const changes = changesFor(p, d);
    if (changes) {
      after = editEntry(before, d.id, changes);
      const A = loadYaml(before), B = loadYaml(after);
      const changedIds = B.filter((e, i) => !same(e, A[i])).map(e => e.id);
      if (A.length !== B.length || changedIds.join() !== d.id) throw new Error(`edit touched ${changedIds.join(", ") || "nothing"} — aborted`);
    }
  }
  if (!after) return null;
  fs.writeFileSync(FILE, after);
  const validation = runValidate();
  if (!validation.ok) { fs.writeFileSync(FILE, before); throw Object.assign(new Error("validate.js failed after applying — change reverted"), { validation }); }
  return validation;
}

function commit(reviewer) {
  reviewer = needReviewer(reviewer, "commit to entities.yml");
  const todo = accepted();
  if (!todo.length) return { results: [], validation: runValidate(), backup: null };
  const backup = makeBackup("pre-commit");
  const results = [];
  for (const p of todo) {
    try {
      commitOne(p);
      const rows = store.read("proposals");
      const q = findP(rows, p.id);
      Object.assign(q, { status: "approved", committed: store.now(), committedBy: reviewer });
      store.write("proposals", rows);
      const ev = store.read("evidence");
      ev.push({ entity: p.op === "addEntity" ? p.final.id : p.entity, field: p.field, op: p.op, value: p.final || p.after, confidence: p.confidence,
        evidence: p.evidence, corroboration: p.corroboration, website: p.website, reviewer: p.reviewer, committedBy: reviewer, approved: q.committed, proposal: p.id });
      store.write("evidence", ev);
      results.push({ id: p.id, ok: true, summary: p.summary });
    } catch (e) {
      results.push({ id: p.id, ok: false, summary: p.summary, error: e.message });
      break;   // stop at the first failure; the file stays as of the last good commit
    }
  }
  return { results, validation: runValidate(), backup };
}

/* ---------------- backups ------------------------------------------------- */
const BACKUPS = path.join(__dirname, "backups");
const BFILES = { "entities.yml": FILE, "proposals.json": store.FILES.proposals, "refusals.json": store.FILES.refusals, "evidence.json": store.FILES.evidence };
function makeBackup(label = "manual") {
  const name = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${String(label).replace(/[^a-z0-9-]/gi, "")}`;
  const dir = path.join(BACKUPS, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, src] of Object.entries(BFILES)) if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  return name;
}
function listBackups() {
  try {
    return fs.readdirSync(BACKUPS).filter(n => fs.statSync(path.join(BACKUPS, n)).isDirectory()).sort().reverse()
      .map(n => ({ name: n, files: fs.readdirSync(path.join(BACKUPS, n)) }));
  } catch { return []; }
}
function restoreBackup(name) {
  const b = listBackups().find(x => x.name === name);
  if (!b) throw new Error(`no backup ${name}`);
  const safety = makeBackup("pre-restore");
  for (const [f, dst] of Object.entries(BFILES)) {
    const src = path.join(BACKUPS, name, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else if (f === "evidence.json" && fs.existsSync(dst)) fs.unlinkSync(dst);
  }
  return { restored: name, safety, validation: runValidate() };
}
/* Reset the sandbox: every uncommitted decision and staging goes back to
   pending. Proposals, refusals and committed changes are kept. */
function resetSandbox() {
  const safety = makeBackup("pre-reset");
  const rows = store.read("proposals");
  let n = 0;
  for (const p of rows) if (p.status === "accepted" || p.status === "rejected" || (p.status === "pending" && p.staged)) {
    Object.assign(p, { status: "pending", staged: false, ...CLEAR }); n++;
  }
  store.write("proposals", rows);
  return { reset: n, safety };
}

/* ---------------- graph helpers ------------------------------------------- */
function adjacency(DATA) {
  const ids = new Set(DATA.map(d => d.id));
  const adj = new Map(DATA.map(d => [d.id, new Set()]));
  for (const d of DATA) for (const l of d.links || []) if (ids.has(l)) { adj.get(d.id).add(l); adj.get(l).add(d.id); }
  return adj;
}
const FUNDER = d => (d.offers || []).some(o => o === "funding" || o === "grants");

/* Entries that reach a funder (not themselves) within 3 hops. */
function warmPathCount(DATA) {
  const adj = adjacency(DATA);
  const funders = new Set(DATA.filter(FUNDER).map(d => d.id));
  let n = 0;
  for (const d of DATA) {
    const seen = new Set([d.id]); let frontier = [d.id], hit = false;
    for (let h = 0; h < 3 && !hit && frontier.length; h++) {
      const next = [];
      for (const x of frontier) for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); next.push(y); if (funders.has(y)) hit = true; }
      frontier = next;
    }
    if (hit) n++;
  }
  return n;
}

/* ---------------- probes --------------------------------------------------
   Columns: before = git HEAD · committed = entities.yml · after = committed +
   approved in the sandbox · preview = after + staged. */
const VC = require("./valuechain");
const PROBES = [
  ["isolated", "1 · Isolated entries (no link in or out)", "lower"],
  ["noOutbound", "2 · Entries with no outbound links", "lower"],
  ["oneWay", "3 · One-way links (A→B with no B→A)", "lower"],
  ["approx", "4 · Approximate pins (approx: true)", "lower"],
  ["noStages", "5 · Entries missing stages (hidden from stage searches)", "lower"],
  ["evidenced", "6 · Entries with a source-quoted, reviewed field", "higher"],
  ["outsideBoston", "7 · Geographic reach: entries >25 km from Boston", "higher"],
  ["warmPath", "Warm path: entries ≤3 hops from a funder", "higher", true],
  ["valueChain", "Value-chain reachability: entries ≤3 hops from all 4 pillars", "higher", true],
  ["selfVerified", "Entries with a confirmed .well-known manifest", "higher", true],
];

function measure(DATA, evidence) {
  const ids = new Set(DATA.map(d => d.id));
  const inbound = new Map();
  const byId = new Map(DATA.map(d => [d.id, d]));
  let oneWay = 0;
  for (const d of DATA) for (const l of d.links || []) {
    inbound.set(l, (inbound.get(l) || 0) + 1);
    if (!(byId.get(l)?.links || []).includes(d.id)) oneWay++;
  }
  return {
    isolated: DATA.filter(d => !(d.links || []).length && !inbound.get(d.id)).length,
    noOutbound: DATA.filter(d => !(d.links || []).length).length,
    oneWay,
    approx: DATA.filter(d => d.approx).length,
    noStages: DATA.filter(d => !(d.stages || []).length).length,
    evidenced: new Set(evidence.filter(e => ids.has(e.entity)).map(e => e.entity)).size,
    outsideBoston: VC.outsideBoston(DATA),
    warmPath: warmPathCount(DATA),
    valueChain: VC.reachability(DATA),
    selfVerified: new Set(evidence.filter(e => e.field === "selfVerified").map(e => e.entity)).size,
    total: DATA.length,
  };
}

const gitShow = memo(rel => {
  try { return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: store.REPO, encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}, () => headStamp());
const baseData = memo(() => loadYaml(gitShow("data/entities.yml") || fs.readFileSync(FILE, "utf8")), () => headStamp());

function probes() {
  const baseEv = gitShow("data/evidence.json");
  const before = measure(baseData(), baseEv ? JSON.parse(baseEv) : []);
  const committed = measure(loadDATA(), store.read("evidence"));
  const sa = sandbox({ includeStaged: false });
  const after = measure(sa.DATA, sa.evidence);
  const sp = sandbox();
  const prev = measure(sp.DATA, sp.evidence);
  return {
    baseline: "git HEAD",
    rows: PROBES.map(([key, label, better, isNew]) => ({ key, label, better, isNew: Boolean(isNew),
      before: before[key], committed: committed[key], after: after[key], preview: prev[key], approved: after[key], staged: prev[key] })),
    totals: { before: before.total, committed: committed.total, after: after.total, preview: prev.total },
    acceptedCount: accepted().length, stagedCount: staged().length, skipped: sp.skipped,
  };
}

/* Which link edges exist where: base (git HEAD), committed, accepted, staged. */
function edgeOrigins() {
  const key = DATA => new Set(DATA.flatMap(d => (d.links || []).map(l => `${d.id}>${l}`)));
  return { base: key(baseData()), committed: key(loadDATA()), accepted: key(sandbox({ includeStaged: false }).DATA) };
}
function originOf(o, a, b) {
  const k1 = `${a}>${b}`, k2 = `${b}>${a}`;
  const has = s => s.has(k1) || s.has(k2);
  return has(o.base) ? null : has(o.committed) ? "committed" : has(o.accepted) ? "approved" : "staged";
}

/* Graph for the sandbox view: nodes + edges, each edge tagged by origin. */
function graph() {
  const o = edgeOrigins();
  const sb = sandbox();
  const baseIds = new Set(baseData().map(d => d.id));
  const nodes = sb.DATA.map(d => ({ id: d.id, name: d.name, cat: d.cat, isNew: !baseIds.has(d.id) }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = [];
  for (const d of sb.DATA) for (const l of d.links || []) {
    if (!ids.has(l)) continue;
    edges.push({ s: d.id, t: l, origin: originOf(o, d.id, l) || "base" });
  }
  return { nodes, edges };
}

/* Capital, Buyers & Scale view (sandbox data, survey-unlocked badges). */
function capital({ stage = null, focus = null } = {}) {
  const o = edgeOrigins();
  const sb = sandbox();
  const base = baseData();
  const baseById = new Map(base.map(d => [d.id, d]));
  const props = store.read("proposals");
  const { lineOf } = require("./lib/yamledit");
  const REPO_URL = "https://github.com/holzerjm/mass-ai-atlas/blob/main/data/entities.yml";
  /* Where an edge comes from: a human-verified atlas link (with its line), or
     the Matchmaker proposal that unlocked it (with both sources). */
  const provenance = (a, b) => {
    const p = props.find(p => p.op === "addLink" && p.status !== "rejected" && ((p.entity === a && p.after === b) || (p.entity === b && p.after === a)));
    if (originOf(o, a, b) && p) return { kind: "matchmaker", status: p.status === "approved" ? "committed" : p.status === "accepted" ? "approved in sandbox" : "staged", proposal: p.id, confidence: p.confidence, evidence: p.evidence, corroboration: p.corroboration };
    const owner = (baseById.get(a)?.links || []).includes(b) ? a : (baseById.get(b)?.links || []).includes(a) ? b : null;
    if (owner) { let line = null; try { line = lineOf(owner, "links"); } catch {} return { kind: "atlas", detail: `Atlas link listed by ${baseById.get(owner).name} — verified by a maintainer`, source_url: line ? `${REPO_URL}#L${line}` : REPO_URL }; }
    return { kind: "unknown" };
  };
  const v = VC.view({ DATA: sb.DATA, baseById, unlockedEdge: (a, b) => originOf(o, a, b), stage, focus });
  for (const p of v.pillars) for (const r of p.rows) if (r.path) r.path.forEach((n, i) => { if (i) n.provenance = provenance(r.path[i - 1].id, n.id); });
  if (v.focus) {
    try { v.focus.signals = (require("./index").readSignals()[v.focus.id] || null); } catch { v.focus.signals = null; }
    v.focus.proposals = props.filter(p => p.entity === v.focus.id && p.status !== "rejected").map(p => ({ id: p.id, summary: p.summary, status: p.status, staged: p.staged, confidence: p.confidence, evidence: p.evidence, corroboration: p.corroboration, census: p.census }));
  }
  return v;
}

/* ---------------- warm-path explorer -------------------------------------- */
const HUB_CATS = new Set(["space", "community", "university", "event", "accel", "student"]);

function explore({ needs = [], stage = null, start = null } = {}) {
  const sb = sandbox();
  const DATA = sb.DATA;
  const byId = new Map(DATA.map(d => [d.id, d]));
  const adj = adjacency(DATA);
  const baseDataLocal = baseData();
  const baseById = new Map(baseDataLocal.map(d => [d.id, d]));
  const baseAdj = adjacency(baseDataLocal);
  const decided = store.read("proposals");
  const unlockedBy = (a, b) => {
    if (baseAdj.get(a)?.has(b)) return null;
    const p = decided.find(p => p.op === "addLink" && ((p.entity === a && p.after === b) || (p.entity === b && p.after === a)) && (p.status === "approved" || p.status === "accepted" || p.staged));
    return p ? { proposal: p.id, status: p.status === "approved" ? "committed" : p.status === "accepted" ? "approved" : "staged", source_url: p.evidence.source_url } : { status: "unknown" };
  };
  const today = new Date().toISOString().slice(0, 10);
  const applyOpen = d => d.applyBy === "rolling" || (!!d.applyBy && d.applyBy >= today);

  // BFS from a start entry (or from all hub entries) for shortest chains.
  const sources = start && byId.has(start) ? [start] : DATA.filter(d => HUB_CATS.has(d.cat)).map(d => d.id);
  const prev = new Map(sources.map(s => [s, null]));
  let frontier = sources.slice();
  while (frontier.length) {
    const next = [];
    for (const x of frontier) for (const y of adj.get(x)) if (!prev.has(y)) { prev.set(y, x); next.push(y); }
    frontier = next;
  }
  const chainTo = id => {
    if (!prev.has(id)) return null;
    const out = []; let c = id;
    while (c !== null) { out.unshift(c); c = prev.get(c); }
    return out;
  };

  const scored = DATA.map(d => {
    const met = needs.filter(n => (d.offers || []).includes(n));
    if (needs.length && !met.length) return null;
    const stageOk = !stage || (d.stages || []).includes(+stage);
    if (stage && !stageOk) return null;
    const chain = chainTo(d.id);
    const reasons = [];
    let score = met.length * 10;
    if (needs.length) reasons.push(`offers ${met.join(", ")}`);
    if (stage) reasons.push(`helps at stage ${stage}`);
    if (applyOpen(d)) { score += 4; reasons.push(d.applyBy === "rolling" ? "applications rolling" : `apply by ${d.applyBy}`); }
    if (chain) { score += Math.max(0, 5 - chain.length); reasons.push(`${chain.length - 1}-hop warm path`); }
    // Fields the survey unlocked for this entry (staged or approved vs git HEAD)
    const b = baseById.get(d.id) || {};
    const unlocked = [];
    for (const k of ["stages", "applyBy", "facts", "links", "loc"])
      if (JSON.stringify(b[k]) !== JSON.stringify(d[k])) unlocked.push(k);
    return {
      id: d.id, name: d.name, cat: d.cat, url: d.url, offers: d.offers, stages: d.stages || [], applyBy: d.applyBy || null,
      score, reasons, unlocked,
      chain: chain ? chain.map((id, i) => ({ id, name: byId.get(id).name, cat: byId.get(id).cat, edge: i ? unlockedBy(chain[i - 1], id) : null })) : null,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { needs, stage, start, count: scored.length, results: scored.slice(0, 25) };
}

/* ---------------- give-to-get: visibility & kits -------------------------- */
const OFFERS = ["funding", "grants", "space", "compute", "mentorship", "community", "talent", "customers"];
const STAGES_N = [1, 2, 3, 4, 5];
const APPLY_CATS = new Set(["accel", "vc", "angel", "gov", "student"]);

/* Founder searches modelled on the public Directory: one need (or none) ×
   one stage (or any) × "open applications only" on/off — the same filters
   index.html applies. Only searches for something the org offers count. */
function visibility(id) {
  const d = loadDATA().find(x => x.id === id);
  if (!d) throw new Error(`no entry ${id}`);
  const today = new Date().toISOString().slice(0, 10);
  const open = d.applyBy === "rolling" || (!!d.applyBy && d.applyBy >= today);
  // Only searches the org SHOULD appear in count: a stage it doesn't serve, or
  // "open applications" for an org that takes no applications, is not a loss.
  const hasStages = (d.stages || []).length > 0;
  const takesApplications = APPLY_CATS.has(d.cat) || Boolean(d.applyBy);
  let relevant = 0, shown = 0;
  const lost = { stages: 0, applyBy: 0 };
  for (const need of [null, ...OFFERS]) {
    if (need && !d.offers.includes(need)) continue;
    for (const st of [null, ...STAGES_N]) for (const openOnly of [false, true]) {
      if (st && hasStages && !d.stages.includes(st)) continue;
      if (openOnly && !takesApplications) continue;
      relevant++;
      const stageOk = !st || (d.stages || []).includes(st);
      const openOk = !openOnly || open;
      if (stageOk && openOk) shown++;
      else { if (!stageOk) lost.stages++; if (!openOk) lost.applyBy++; }
    }
  }
  const DATA = loadDATA();
  const degree = adjacency(DATA).get(d.id).size;
  const pct = relevant ? Math.round(100 * (relevant - shown) / relevant) : 0;
  const missing = [];
  if (!(d.stages || []).length) missing.push({ field: "stages", impact: `hidden from every stage-filtered search and from all 5 Journey stages` });
  if (!d.applyBy && takesApplications) missing.push({ field: "applyBy", impact: `hidden whenever a founder ticks "open applications only" — even "rolling" fixes this` });
  if (!degree) missing.push({ field: "links", impact: "an isolated dot in Galaxy — no warm path leads to you" });
  if (!d.facts) missing.push({ field: "facts", impact: "no check size, terms, or focus shown on your card" });
  if (d.approx) missing.push({ field: "approx pin", impact: "your map pin is neighborhood-level, not your door" });
  const ev = store.read("evidence").filter(e => e.entity === d.id);
  const score = Math.max(0, 100 - pct - (degree ? 0 : 15) - (d.facts ? 0 : 5) - (d.approx ? 5 : 0)) + (ev.length ? 5 : 0);
  return { id: d.id, name: d.name, url: d.url, searches: relevant, shown, invisiblePct: pct, lost, degree, missing, evidence: ev.length, score: Math.min(100, score) };
}

function draftManifest(id) {
  const d = loadDATA().find(x => x.id === id);
  if (!d) throw new Error(`no entry ${id}`);
  const m = {
    $schema: "https://github.com/holzerjm/mass-ai-atlas/blob/main/docs/well-known-manifest.md",
    version: 1, atlas_id: d.id, name: d.name, url: d.url, loc: d.loc,
    offers: d.offers, stages: d.stages || [],
    applyBy: d.applyBy || "", facts: d.facts || [], links: d.links || [],
    contact: "", published: new Date().toISOString().slice(0, 10),
  };
  return m;
}

function jsonLd(id) {
  const d = loadDATA().find(x => x.id === id);
  if (!d) throw new Error(`no entry ${id}`);
  const parts = d.loc.split(",").map(s => s.trim());
  const city = parts.pop();
  const street = parts.filter(p => /\d/.test(p)).pop() || "";
  return {
    "@context": "https://schema.org", "@type": "Organization", name: d.name, url: d.url, description: d.desc,
    address: { "@type": "PostalAddress", ...(street ? { streetAddress: street } : {}), addressLocality: city, addressRegion: "MA", addressCountry: "US" },
    ...(d.approx ? {} : { geo: { "@type": "GeoCoordinates", latitude: d.lat, longitude: d.lng } }),
  };
}

function kit(id) {
  const v = visibility(id);
  const manifest = draftManifest(id);
  const ld = jsonLd(id);
  const repo = "holzerjm/mass-ai-atlas";
  const body = [
    `**Organization:** ${v.name} (\`${id}\`)`,
    `**Official site:** ${v.url}`, "",
    `We have published a self-verification manifest at ${new URL("/.well-known/mass-ai-atlas.json", v.url).href}.`,
    `Fields we are asking a maintainer to review: ${v.missing.map(m => m.field).join(", ") || "none — confirming the entry as listed"}.`, "",
    "```json", JSON.stringify(manifest, null, 2), "```", "",
    "_Generated by Atlas Weave. A maintainer reviews every change; nothing is merged automatically._",
  ].join("\n");
  const issueUrl = `https://github.com/${repo}/issues/new?` + new URLSearchParams({ title: `Claim & verify: ${v.name}`, body });
  return { visibility: v, manifest, jsonLd: ld, jsonLdSnippet: `<script type="application/ld+json">\n${JSON.stringify(ld, null, 2)}\n</script>`, issueUrl: issueUrl.length < 7800 ? issueUrl : `https://github.com/${repo}/issues/new`, issueBody: body };
}

module.exports = { runValidateCached, approve, accept, reject, undo, setStaged, sandbox, previewYaml, commit, makeBackup, listBackups, restoreBackup, resetSandbox, probes, measure, graph, capital, explore, visibility, draftManifest, jsonLd, kit, runValidate, loadDATA, validateEntry, PROBES };
