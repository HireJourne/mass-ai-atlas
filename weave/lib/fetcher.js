/* Polite HTTP: identifying User-Agent, on-disk cache, and per-host pacing
   (Nominatim 1 req/s per its usage policy; Census and others gently). Every
   fetch is recorded with the URL actually served, so a quote can always be
   traced to a clickable page. Failed or rate-limited responses are not cached. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UA = "AtlasWeave/0.1 (Mass AI Atlas maintainer review tool; https://github.com/holzerjm/mass-ai-atlas)";
const CACHE = path.join(__dirname, "..", ".cache");
const TTL_MS = 24 * 3600 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Minimum gap between requests to the same host.
const PACE = { "nominatim.openstreetmap.org": 1100, "api.github.com": 700, "efts.sec.gov": 250, "api.openalex.org": 250 };
const queues = new Map();
async function pace(host) {
  const gap = PACE[host];
  if (!gap) return;
  const q = queues.get(host) || { last: 0, chain: Promise.resolve() };
  const turn = q.chain.then(async () => {
    const wait = q.last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    q.last = Date.now();
  });
  q.chain = turn.catch(() => {});
  queues.set(host, q);
  await turn;
}

function cachePath(key) {
  return path.join(CACHE, crypto.createHash("sha1").update(key).digest("hex") + ".json");
}

async function get(url, { timeoutMs = 12000, accept = "text/html,application/xhtml+xml,*/*", method = "GET", body = null, ttlMs = TTL_MS } = {}) {
  const key = method === "GET" ? url : `${method} ${url} ${JSON.stringify(body)}`;
  const cp = cachePath(key);
  try {
    const c = JSON.parse(fs.readFileSync(cp, "utf8"));
    if (Date.now() - c.at < ttlMs) return c;
  } catch {}
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  await pace(host);
  let res;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    // SEC fair-access policy requires a contact email in the User-Agent. Only an
    // address the operator chose (WEAVE_CONTACT_EMAIL) is ever sent.
    const sec = /(^|\.)sec\.gov$/.test(host);
    const headers = { "User-Agent": sec && process.env.WEAVE_CONTACT_EMAIL ? `AtlasWeave/0.1 ${process.env.WEAVE_CONTACT_EMAIL}` : UA, Accept: accept };
    if (body) headers["Content-Type"] = "application/json";
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "follow", signal: ctl.signal });
    const ct = r.headers.get("content-type") || "";
    let text = "";
    if (/text|html|json|xml/.test(ct) || !ct) text = (await r.text()).slice(0, 1_500_000);
    clearTimeout(t);
    res = { url, method, finalUrl: r.url, status: r.status, contentType: ct, body: text, at: Date.now() };
  } catch (e) {
    res = { url, method, finalUrl: url, status: 0, error: String(e.cause?.code || e.name || e.message), body: "", at: Date.now() };
  }
  // Don't pin a rate-limit or server error in the cache for a day.
  if (res.status && res.status !== 403 && res.status !== 429 && res.status < 500) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify(res));
  }
  return res;
}

async function json(url, opts = {}) {
  const r = await get(url, { accept: "application/json", ...opts });
  let data = null;
  try { data = JSON.parse(r.body); } catch {}
  return { ...r, data };
}

module.exports = { get, json, UA };
