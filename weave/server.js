/* Atlas Weave dashboard server — localhost only, no dependencies.
   The ONLY route that writes data/entities.yml is POST /api/commit (and
   /api/backups/restore, which puts back a backup the user chose). "Approve"
   records a sandbox decision; the file is untouched until Commit. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const W = require("./index");
const J = require("./judge");
const R = require("./radar");
const CAL = require("./calendar");
const store = require("./lib/store");

const send = (res, code, body, type = "application/json", extra = {}) => {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = req => new Promise((ok, bad) => {
  let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});
const STATIC = { "/": ["dashboard.html", "text/html"], "/index.html": ["dashboard.html", "text/html"], "/dashboard.js": ["dashboard.js", "text/javascript"] };

// Radar runs in the background; the page polls its log.
const radarState = { running: false, log: [], error: null, started: null };
function startRadar() {
  if (radarState.running) return radarState;
  Object.assign(radarState, { running: true, log: [], error: null, started: store.now() });
  R.run({ log: m => radarState.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`) })
    .then(o => radarState.log.push(`done: ${o.candidates.length} new candidates, ${o.matched.length} matched, ${o.possible.length} possible duplicates, ${o.refusals} refusals`))
    .catch(e => { radarState.error = e.message; radarState.log.push(`error: ${e.message}`); })
    .finally(() => { radarState.running = false; });
  return radarState;
}

// `git status` for entities.yml, re-run only when the file or HEAD changes.
let gitClean = { key: null, val: null };
function entitiesMatchGit() {
  const st = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = [st(path.join(store.DATA, "entities.yml")), st(path.join(store.REPO, ".git", "index")), st(path.join(store.REPO, ".git", "HEAD"))].join("|");
  if (gitClean.key !== key) {
    let v = null;
    try { v = require("child_process").execFileSync("git", ["status", "--porcelain", "data/entities.yml"], { cwd: store.REPO, encoding: "utf8" }).trim() === ""; } catch {}
    gitClean = { key, val: v };
  }
  return gitClean.val;
}
function sandboxStatus() {
  const P = store.read("proposals");
  const fileClean = entitiesMatchGit();
  return { pending: P.filter(p => p.status === "pending").length, staged: P.filter(p => p.status === "pending" && p.staged).length,
    accepted: P.filter(p => p.status === "accepted").length, committed: P.filter(p => p.status === "approved").length,
    rejected: P.filter(p => p.status === "rejected").length, refusals: store.read("refusals").length, entitiesFileMatchesGit: fileClean, backups: W.listBackups().slice(0, 15) };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const q = url.searchParams;
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: "cross-origin request refused" });
  }
  if (req.method === "GET" && STATIC[p]) return send(res, 200, fs.readFileSync(path.join(__dirname, STATIC[p][0]), "utf8"), STATIC[p][1]);

  const GET = {
    "/api/ticker": () => { const DATA = W.sandbox().DATA; return require("./ticker").items({ DATA, calendar: CAL.curated({ DATA }), signals: W.readSignals(), radar: R.lastRun() }); },
    "/api/calendar": () => CAL.curated({ DATA: W.sandbox().DATA, stage: q.get("stage") || null, needs: q.getAll("need") }),
    "/api/entities": () => W.sandbox().DATA.map(d => ({ id: d.id, name: d.name, cat: d.cat, loc: d.loc, url: d.url, approx: Boolean(d.approx), lat: d.lat, lng: d.lng, links: d.links || [], stages: d.stages || [], offers: d.offers, applyBy: d.applyBy || null })),
    "/api/proposals": () => store.read("proposals"),
    "/api/refusals": () => store.read("refusals"),
    "/api/probes": () => W.probes(),
    "/api/graph": () => W.graph(),
    "/api/status": () => sandboxStatus(),
    "/api/explore": () => W.explore({ needs: q.getAll("need"), stage: q.get("stage") || null, start: q.get("start") || null }),
    "/api/capital": () => W.capital({ stage: q.get("stage") || null, focus: q.get("focus") || null }),
    "/api/radar": () => ({ ...radarState, last: R.lastRun() }),
    "/api/judge/sources": () => J.sources(),
    "/api/judge/refusals": () => J.bestRefusals(8),
    "/api/judge/claim": () => J.randomClaim(),
    "/api/judge/counts": () => J.counts(),
  };
  if (req.method === "GET" && GET[p]) return send(res, 200, GET[p]());
  if (req.method === "GET" && p === "/api/calendar.ics") {
    const stage = q.get("stage") || null, needs = q.getAll("need");
    return send(res, 200, CAL.ics({ DATA: W.sandbox().DATA, stage, needs }), "text/calendar", { "Content-Disposition": `attachment; filename="mass-ai-atlas${stage ? "-stage" + stage : ""}.ics"` });
  }
  if (req.method === "POST" && p === "/api/calendar/refresh") return send(res, 200, CAL.refresh());
  if (req.method === "GET" && p === "/api/sandbox/preview.yml")
    return send(res, 200, W.previewYaml(), "text/yaml", { "Content-Disposition": 'attachment; filename="entities.preview.yml"' });

  let m;
  if (req.method === "GET" && (m = p.match(/^\/api\/(manifest|visibility|kit)\/([a-z0-9-]+)$/)))
    return send(res, 200, { manifest: W.draftManifest, visibility: W.visibility, kit: W.kit }[m[1]](m[2]));
  if (req.method === "POST" && (m = p.match(/^\/api\/survey\/([a-z0-9-]+)$/))) return send(res, 200, await W.surveyOne(m[1]));
  if (req.method === "POST" && p === "/api/validate") return send(res, 200, W.runValidate());
  if (req.method === "POST" && p === "/api/brief") return send(res, 200, J.brief());
  if (req.method === "POST" && p === "/api/radar/run") return send(res, 200, startRadar());
  if (req.method === "POST" && (m = p.match(/^\/api\/proposals\/([a-f0-9]+)\/(approve|reject|stage|unstage|undo)$/))) {
    const b = await readBody(req);
    if (m[2] === "stage" || m[2] === "unstage") return send(res, 200, W.setStaged(m[1], m[2] === "stage"));
    if (m[2] === "undo") return send(res, 200, W.undo(m[1]));
    if (m[2] === "approve") return send(res, 200, await W.accept(m[1], b.reviewer, b.note || "", b.edits || {}));
    return send(res, 200, W.reject(m[1], b.reviewer, b.note || ""));
  }
  if (req.method === "POST" && p === "/api/sandbox/stage-all") {
    const b = await readBody(req);
    const ids = store.read("proposals").filter(x => x.status === "pending" && x.op !== "addEntity" && (!b.confidence || x.confidence === b.confidence)).map(x => x.id);
    ids.forEach(id => W.setStaged(id, true));
    return send(res, 200, { staged: ids.length });
  }
  if (req.method === "POST" && p === "/api/sandbox/approve-staged") {
    const b = await readBody(req);
    const out = [];
    for (const x of store.read("proposals").filter(x => x.status === "pending" && x.staged)) {
      try { await W.accept(x.id, b.reviewer, "approved from staging"); out.push({ id: x.id, ok: true }); } catch (e) { out.push({ id: x.id, ok: false, error: e.message }); }
    }
    return send(res, 200, { results: out });
  }
  if (req.method === "POST" && p === "/api/sandbox/approve-confidence") {
    // Approve (in the sandbox only) every pending proposal at one confidence level.
    const b = await readBody(req);
    const level = b.confidence || "two-source";
    const out = [];
    for (const x of store.read("proposals").filter(x => x.status === "pending" && x.op !== "addEntity" && (x.confidence || "two-source") === level)) {
      try { await W.accept(x.id, b.reviewer, `bulk sandbox approval: ${level}`); out.push({ id: x.id, ok: true }); } catch (e) { out.push({ id: x.id, ok: false, error: e.message }); }
    }
    return send(res, 200, { level, results: out });
  }
  if (req.method === "GET" && p === "/api/validate") return send(res, 200, W.runValidateCached());
  if (req.method === "POST" && p === "/api/sandbox/clear") {
    store.read("proposals").filter(x => x.staged && x.status === "pending").forEach(x => W.setStaged(x.id, false));
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/sandbox/reset") return send(res, 200, W.resetSandbox());
  if (req.method === "POST" && p === "/api/commit") { const b = await readBody(req); return send(res, 200, W.commit(b.reviewer)); }
  if (req.method === "POST" && p === "/api/backups/create") return send(res, 200, { name: W.makeBackup("manual") });
  if (req.method === "POST" && p === "/api/backups/restore") { const b = await readBody(req); return send(res, 200, W.restoreBackup(b.name)); }
  send(res, 404, { error: "not found" });
}

function start(port = 4848) {
  // A backup at every server start, so "restore" always has a known-good point.
  try { W.makeBackup("server-start"); } catch {}
  const handler = (req, res) => handle(req, res).catch(e => send(res, 400, { error: e.message, validation: e.validation }));
  // Listen on BOTH loopbacks. On Windows "localhost" resolves to ::1 first; with
  // only 127.0.0.1 bound, every browser request waited ~200 ms for the IPv6
  // attempt to fail before falling back. Still loopback-only — never external.
  const server = http.createServer(handler);
  server.listen(port, "127.0.0.1", () => console.log(`Atlas Weave dashboard → http://localhost:${port}`));
  const v6 = http.createServer(handler);
  v6.on("error", () => {});   // no IPv6 loopback on this machine: IPv4 alone still works
  v6.listen(port, "::1");
  return server;
}

if (require.main === module) start(Number(process.argv[2]) || 4848);
module.exports = { start };
