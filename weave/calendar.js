/* Curated events, cohort deadlines and the .ics calendar.

   Sources: applyBy in the atlas (human-verified) and upcoming events from the
   repo's own keyless pipeline (scripts/fetch-events.js → weave/events-cache.json,
   Luma calendars + AI Tinkerers). Three founder tracks; pure networking is
   filtered out; past or undated items never reach the calendar. */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const store = require("./lib/store");

const CACHE = path.join(__dirname, "events-cache.json");
const FLUFF = /\b(cocktails?|conversations?|happy hour|mixer|networking night|social|drinks|meet ?and ?greet|coffee chat|brunch|party)\b/i;
const TRACK_RE = {
  capital: /\b(pitch|investor|vc\b|venture|fund(ing|raise|raising)?|grant|accelerator|cohort|application|apply|demo day)\b/i,
  buyers: /\b(demo|showcase|pilot|enterprise|customer|buyer|procure|defense|gov(ernment)?|industry day|partner|corporate)\b/i,
  talent: /\b(hackathon|hack|build(er|ers|ing)?|workshop|summit|conference|talent|career|recruit|meetup|tinkerers|lab|research|seminar|bootcamp|course)\b/i,
};
const today = () => new Date().toISOString().slice(0, 10);

function loadEvents() {
  let raw = [];
  let fetchedAt = null;
  try { const j = JSON.parse(fs.readFileSync(CACHE, "utf8")); raw = Array.isArray(j) ? j : j.events || []; fetchedAt = fs.statSync(CACHE).mtime.toISOString(); } catch {}
  return { events: raw.filter(e => e.start && e.start.slice(0, 10) >= today()), fetchedAt };
}

function classify(e) {
  const t = `${e.title} ${e.organizer || ""}`;
  // Social-first events are dropped unless the title promises real work (a hack, workshop, demo or pitch).
  if (FLUFF.test(t) && !/\b(hack(athon)?|workshop|demo|pitch|showcase)\b/i.test(e.title)) return null;
  if (/\bhack(athon)?s?\b/i.test(e.title)) return "talent";
  if (TRACK_RE.buyers.test(t)) return "buyers";
  if (TRACK_RE.capital.test(t)) return "capital";
  if (TRACK_RE.talent.test(t)) return "talent";
  return null;
}

function curated({ DATA, stage = null, needs = [] }) {
  const { events, fetchedAt } = loadEvents();
  const names = new Map(DATA.map(d => [d.name.toLowerCase(), d]));
  const stageOk = d => !stage || !(d.stages || []).length || d.stages.includes(+stage);
  const needOk = d => !needs.length || (d.offers || []).some(o => needs.includes(o));
  const tracks = { capital: [], buyers: [], talent: [] };
  const rolling = [];
  // atlas deadlines
  for (const d of DATA) {
    if (!d.applyBy || !stageOk(d) || !needOk(d)) continue;
    const track = d.cat === "gov" || d.cat === "corporate" || (d.offers || []).includes("customers") ? "buyers" : ["student", "community", "event"].includes(d.cat) ? "talent" : "capital";
    if (d.applyBy === "rolling") { rolling.push({ id: d.id, name: d.name, cat: d.cat, url: d.url, track, note: d.applyNote || "" }); continue; }
    if (d.applyBy < today()) continue;   // validate.js already warns; never calendared
    tracks[track].push({ kind: "deadline", date: d.applyBy, title: `${d.name}: application deadline`, org: d.name, orgId: d.id, url: d.url, note: d.applyNote || "", source: "Mass AI Atlas applyBy (human-verified)" });
  }
  // upcoming events
  let dropped = 0;
  for (const e of events) {
    const tr = classify(e);
    if (!tr) { dropped++; continue; }
    const org = names.get(String(e.organizer || "").toLowerCase());
    if ((stage || needs.length) && org && (!stageOk(org) || !needOk(org))) continue;
    tracks[tr].push({ kind: "event", date: e.start.slice(0, 10), start: e.start, end: e.end, title: e.title, org: org ? org.name : null, orgId: org?.id || null, url: e.url, venue: e.venue || "", source: e.source });
  }
  for (const k of Object.keys(tracks)) tracks[k].sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  return { stage, needs, fetchedAt, tracks, rolling, dropped, total: events.length };
}

/* RFC 5545 calendar: dated deadlines (all-day) and timed events. */
function ics(opts) {
  const c = curated(opts);
  const esc = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const fold = l => { const out = []; while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); } out.push(l); return out.join("\r\n"); };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Atlas Weave//Mass AI Atlas curated calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`Mass AI Atlas — curated${c.stage ? ` · stage ${c.stage}` : ""}${c.needs.length ? ` · ${c.needs.join("+")}` : ""}`)}`];
  const LABEL = { capital: "Capital & cohort cutoffs", buyers: "Enterprise buyer & demo showcases", talent: "Technical, hackathon & talent" };
  let n = 0;
  for (const [track, items] of Object.entries(c.tracks)) for (const it of items) {
    const uid = `${it.kind}-${(it.orgId || "").replace(/[^a-z0-9-]/g, "")}-${(it.start || it.date).replace(/[^0-9]/g, "")}-${n++}@atlas-weave.local`;
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`);
    if (it.kind === "deadline") {
      const d = it.date.replace(/-/g, "");
      const next = new Date(Date.parse(it.date) + 864e5).toISOString().slice(0, 10).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
    } else {
      lines.push(`DTSTART:${dt(it.start)}`);
      if (it.end) lines.push(`DTEND:${dt(it.end)}`);
    }
    lines.push(fold(`SUMMARY:${esc(it.title)}`), fold(`DESCRIPTION:${esc(`${LABEL[track]} · ${it.source}${it.note ? " · " + it.note : ""}`)}`), `CATEGORIES:${esc(LABEL[track])}`);
    if (it.url) lines.push(fold(`URL:${it.url}`));
    if (it.venue) lines.push(fold(`LOCATION:${esc(it.venue)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

let refreshing = null;
function refresh() {
  if (refreshing) return { running: true };
  refreshing = new Promise(res => {
    const p = spawn(process.execPath, [path.join(store.REPO, "scripts", "fetch-events.js"), "--days", "30", "--out", CACHE], { cwd: store.REPO });
    p.on("close", code => { refreshing = null; res(code); });
  });
  return { running: true };
}

module.exports = { curated, ics, refresh, loadEvents };
