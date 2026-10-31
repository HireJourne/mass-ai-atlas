/* Live engagement ticker — ORGANIZATION-level items only, every one derived
   from a real record in this repository (proposals, refusals, radar run,
   registry signals, calendar). No person names: quotes are never used, only
   org names and Atlas Weave's own summaries. Nothing is invented — if no org
   has published a manifest, the ticker says so. */
const store = require("./lib/store");

function items({ DATA, calendar, signals, radar }) {
  const out = [];
  const P = store.read("proposals"), R = store.read("refusals");
  const name = id => DATA.find(d => d.id === id)?.name || id;
  const recent = (a, b) => String(b.decided || b.created || b.lastSeen || "").localeCompare(String(a.decided || a.created || a.lastSeen || ""));

  for (const p of P.filter(p => p.status === "accepted" || p.status === "approved").sort(recent).slice(0, 4))
    out.push({ icon: p.status === "approved" ? "✅" : "🟢", tag: "Nova", text: `${p.entityName}: ${p.op === "addLink" ? `warm-path edge to ${name(p.after)}` : p.field} ${p.status === "approved" ? "committed to the atlas" : "approved in sandbox"}` });
  const links = P.filter(p => p.op === "addLink" && p.status !== "rejected");
  const byOrg = {};
  for (const p of links) (byOrg[p.entity] = byOrg[p.entity] || []).push(name(p.after));
  for (const [id, targets] of Object.entries(byOrg).sort((a, b) => b[1].length - a[1].length).slice(0, 4))
    out.push({ icon: "⚡", tag: "Matchmaker", text: `${name(id)} — ${targets.length} warm-path edge${targets.length > 1 ? "s" : ""} proposed to ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? "…" : ""} (two sources each)` });
  for (const p of P.filter(p => p.op === "setGeo" && p.status !== "rejected").slice(0, 2))
    out.push({ icon: "📍", tag: "Scout", text: `${p.entityName}: street pin sharpened — website + OpenStreetMap agree` });
  const pick = re => R.find(r => re.test(r.reason));
  for (const r of [pick(/generic address.*MIT/), pick(/RECEIVED federal grants/), pick(/SELLS to the government/), pick(/venue address/), pick(/check size/i), pick(/may be an existing entry/)].filter(Boolean))
    out.push({ icon: "🛡️", tag: "Nova refusal", text: `${r.entityName}: ${r.reason.split(/[:—]/)[0].replace(/^Refused to add `(\w+)` to offers/, "refused `$1` mapping").replace(/^Refused /, "refused ")}` });
  if (radar) out.push({ icon: "🛰️", tag: "Scout radar", text: `${radar.candidates.length} new MA SBIR/STTR awardees detected and de-duplicated against ${DATA.length} entries (${radar.possible.length} possible duplicate refused)` });
  for (const [id, s] of Object.entries(signals || {})) {
    const m = (s.signals || []).find(x => x.status === "match" && /USAspending|NSF/.test(x.source));
    if (m) out.push({ icon: "🏛️", tag: "Scout registry", text: `${name(id)}: ${m.summary.split(" — ")[0].slice(0, 100)} (verified on ${m.source.split(" (")[0]})` });
  }
  if (calendar) {
    const n = Object.values(calendar.tracks).reduce((s, t) => s + t.length, 0);
    const deadlines = Object.values(calendar.tracks).flat().filter(x => x.kind === "deadline");
    out.push({ icon: "📅", tag: "Cohort alert", text: `${n} curated events & deadlines in the next 30 days across 3 founder tracks (${calendar.dropped} networking-only or off-track events filtered out) — .ics ready` });
    for (const d of deadlines.slice(0, 2)) out.push({ icon: "⏳", tag: "Deadline", text: `${d.org} applications close ${d.date}` });
  }
  const manifests = P.filter(p => p.field === "selfVerified").length;
  out.push({ icon: "🔐", tag: "Give-to-Get", text: manifests ? `${manifests} org(s) published a .well-known/mass-ai-atlas.json manifest` : `No org has published a .well-known manifest yet — self-verification kits ready for all ${DATA.length} entries` });
  return out;
}

module.exports = { items };
