/* Atlas Weave — LinkWeave future-state UI. Same API as before; every string
   from the data or the web is escaped before it reaches the page. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isUrl = u => /^https?:\/\//.test(u || "");
const link = (u, t) => isUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t || u)}</a>` : esc(t || u || "");
const verify = (u, t = "Verify Live Source ↗") => isUrl(u) ? `<a class="verify" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>` : "";
const trunc = (s, n) => (s = String(s || "")).length > n ? s.slice(0, n - 1) + "…" : s;
const OFFERS = ["funding", "grants", "space", "compute", "mentorship", "community", "talent", "customers"];
const PILLAR_STYLE = { capital: { color: "#F59E0B", short: "Capital stack" }, buyers: { color: "#8B5CF6", short: "First buyers" }, talent: { color: "#22D3EE", short: "Talent" }, scale: { color: "#10B981", short: "Economies of scale" } };
const PERSONAS = [
  { id: "commonwealth-fusion", tag: "Spotlight · Scaling anchor", sub: "Devens · fusion energy · MIT spinout" },
  { id: "jameel", tag: "Spotlight · University lab", sub: "MIT · AI for health" },
  { id: "massrobotics", tag: "Spotlight · Robotics hub", sub: "Boston Seaport · shared labs & buyers" },
  { id: "greentown", tag: "Spotlight · Climate-tech hub", sub: "Somerville · incubator & lab space" },
  { id: "liquid", tag: "Spotlight · AI spinout", sub: "Kendall Sq, Cambridge · CSAIL spinout" },
  { id: "valis-insights", tag: "Spotlight · Regional builder", sub: "Worcester · applied AI, climate, industrial" },
];
let ENT = [], NAME = {}, tab = "queue", HUB = null, focusId = "commonwealth-fusion", selected = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json" } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j });
  return j;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
function idFrom(input) {
  const v = input.value.trim();
  const e = ENT.find(e => e.id === v || e.name.toLowerCase() === v.toLowerCase() || `${e.name} (${e.id})` === v);
  return e && e.id;
}
const reviewer = () => $("#reviewer").value.trim();
const needReviewer = what => { if (reviewer()) return true; alert(`Enter your name as reviewer first (bar under the header). ${what}`); $("#reviewer").focus(); return false; };
const engineFor = m => m === "matchmaker" ? `<span class="eng matchmaker">Matchmaker</span>` : m === "nova" ? `<span class="eng nova">Nova</span>` : `<span class="eng scout">Scout</span>`;
const unlockChip = t => `<span class="chip unlock">◆ Unlocked by Atlas Weave${t ? ` · ${esc(t)}` : ""}</span>`;

/* ---------------- navigation ---------------- */
$$(".pills [data-view]").forEach(b => b.onclick = () => {
  $$(".pills [data-view]").forEach(x => x.setAttribute("aria-selected", x === b));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "v-" + b.dataset.view));
  const v = b.dataset.view;
  if (v === "judge") loadJudge();
  if (v === "scout") loadRadar();
  if (v === "calendar") loadCalendar();
  if (v === "nova") { renderTab(); loadProbes(); loadGraph(); }
  try { localStorage.setItem("weave-view", v); } catch {}
});

async function loadEntities() {
  ENT = await api("/api/entities");
  NAME = Object.fromEntries(ENT.map(e => [e.id, e.name]));
  $("#orgs").innerHTML = ENT.map(e => `<option value="${esc(e.name)} (${esc(e.id)})">`).join("");
  const sel = $("#hubSelect");
  if (sel) sel.innerHTML = `<option value="">— or pick from all ${ENT.length} organizations —</option>` + ENT.slice().sort((a, b) => a.name.localeCompare(b.name)).map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("");
}

/* ---------------- top bar ---------------- */
async function loadValidate() {
  const pill = $("#valPill");
  try {
    const v = await api("/api/validate");
    const m = v.output.match(/(\d+) error/);
    pill.className = "statuspill " + (v.ok ? "ok" : "bad");
    pill.textContent = v.ok ? "validate.js: PASSING · 0 ERRORS" : `validate.js: FAILING · ${m ? m[1] : "?"} ERRORS`;
    pill.title = v.output;
  } catch { pill.className = "statuspill bad"; pill.textContent = "validate.js: unavailable"; }
}
async function loadStatus() {
  const s = await api("/api/status");
  $("#sbPill").textContent = `Sandbox: ${s.accepted} approved · ${s.staged} staged`;
  $("#fileState").innerHTML = s.entitiesFileMatchesGit ? `<span class="safe">● data/entities.yml untouched (matches git)</span>` : `<span class="unsafe">● data/entities.yml has committed changes</span>`;
  $("#counts").textContent = `${s.pending} pending · ${s.committed} committed · ${s.rejected} rejected · ${s.refusals} refusals`;
  $("#commitBtn").disabled = !s.accepted;
  $("#commitBtn").textContent = s.accepted ? `Commit ${s.accepted} Approved` : "Commit Approved";
  $("#backupSel").innerHTML = s.backups.map(b => `<option value="${esc(b.name)}">${esc(b.name.replace(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-\d\d-/, "$1 $2:$3 · "))}</option>`).join("") || `<option value="">no backups</option>`;
}
$("#approveHigh").onclick = async () => {
  if (!needReviewer("Bulk approvals are attributed to you.")) return;
  const P = await api("/api/proposals");
  const n = P.filter(p => p.status === "pending" && p.op !== "addEntity" && (p.confidence || "two-source") === "two-source").length;
  if (!n) { alert("No pending two-source proposals."); return; }
  if (!confirm(`Approve all ${n} pending two-source proposals IN THE SANDBOX as "${reviewer()}"?\n\nThe scoreboard updates now. data/entities.yml is not touched until you click Commit Approved.`)) return;
  const r = await post("/api/sandbox/approve-confidence", { reviewer: reviewer(), confidence: "two-source" });
  const bad = r.results.filter(x => !x.ok);
  if (bad.length) alert(`${r.results.length - bad.length} approved; ${bad.length} skipped: ${bad.map(x => x.error).join("; ")}`);
  refreshAll();
};
$("#commitBtn").onclick = async () => {
  if (!needReviewer("Commits are attributed.")) return;
  if (!confirm(`Write every sandbox-approved proposal to data/entities.yml as "${reviewer()}"?\n\nA backup is taken first; each change is applied one at a time and validate.js runs after each. A failure reverts that change and stops.`)) return;
  const r = await post("/api/commit", { reviewer: reviewer() });
  showValidate((r.backup ? `backup: ${r.backup}\n` : "") + r.results.map(x => `${x.ok ? "✓" : "✗"} ${x.summary}${x.error ? " — " + x.error : ""}`).join("\n") + "\n\n" + r.validation.output);
  refreshAll();
};
$("#backupBtn").onclick = async () => { const r = await post("/api/backups/create"); alert(`Backup created: ${r.name}`); loadStatus(); };
$("#resetBtn").onclick = async () => {
  if (!confirm("Reset the sandbox? Every uncommitted approval, rejection and staging returns to pending. Proposals, refusals and committed changes are kept; a backup is taken first.")) return;
  const r = await post("/api/sandbox/reset"); alert(`Reset ${r.reset} proposal(s). Safety backup: ${r.safety}`); refreshAll();
};
$("#restoreBtn").onclick = async () => {
  const name = $("#backupSel").value; if (!name) return;
  if (!confirm(`Restore backup ${name}?\n\nentities.yml, proposals, refusals and evidence go back exactly as they were. Your current state is backed up first.`)) return;
  const r = await post("/api/backups/restore", { name });
  showValidate(`restored ${r.restored} (safety backup ${r.safety})\n\n${r.validation.output}`);
  refreshAll();
};
function showValidate(text) { $("#vout").hidden = false; $("#vout").textContent = text; }

/* ---------------- HUB: personas + value-chain map ---------------- */
function renderPersonas() {
  $("#personas").innerHTML = PERSONAS.filter(p => NAME[p.id]).map(p => `<button class="persona" data-persona="${esc(p.id)}" aria-pressed="${p.id === focusId}"><small>${esc(p.tag)}</small><b>${esc(NAME[p.id])}</b><span>${esc(p.sub)}</span></button>`).join("");
  $$("[data-persona]").forEach(b => b.onclick = () => { focusId = b.dataset.persona; $("#hubSearch").value = ""; loadHub(); });
}
/* Typeahead: name, city, category, offer, tag — plus a <select> fallback. */
let acIdx = -1, acRows = [];
function acSearch(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const score = e => {
    const n = e.name.toLowerCase(), hay = `${e.loc} ${e.cat} ${(e.offers || []).join(" ")}`.toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : e.id.includes(q) ? 2 : hay.includes(q) ? 3 : 9;
  };
  return ENT.map(e => [score(e), e]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 12).map(([, e]) => e);
}
function acRender() {
  const box = $("#hubAc");
  if (!acRows.length) { box.hidden = true; $("#hubSearch").setAttribute("aria-expanded", "false"); return; }
  box.innerHTML = acRows.map((e, i) => `<div role="option" data-ac="${esc(e.id)}" class="${i === acIdx ? "on" : ""}"><span>${esc(e.name)}</span><small>${esc(e.cat)} · ${esc(trunc(e.loc, 30))}</small></div>`).join("");
  box.hidden = false; $("#hubSearch").setAttribute("aria-expanded", "true");
  box.querySelectorAll("[data-ac]").forEach(el => el.onmousedown = ev => { ev.preventDefault(); chooseFocus(el.dataset.ac); });
}
function chooseFocus(id) { focusId = id; $("#hubSearch").value = NAME[id] || id; acRows = []; acRender(); loadHub(); }
$("#hubSearch").addEventListener("input", () => { acRows = acSearch($("#hubSearch").value); acIdx = 0; acRender(); });
$("#hubSearch").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { acIdx = Math.min(acIdx + 1, acRows.length - 1); acRender(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { acIdx = Math.max(acIdx - 1, 0); acRender(); e.preventDefault(); }
  else if (e.key === "Enter") { const r = acRows[acIdx] || acSearch($("#hubSearch").value)[0]; if (r) chooseFocus(r.id); }
  else if (e.key === "Escape") { acRows = []; acRender(); }
});
$("#hubSearch").addEventListener("blur", () => setTimeout(() => { acRows = []; acRender(); }, 150));
$("#hubSelect").onchange = () => { if ($("#hubSelect").value) chooseFocus($("#hubSelect").value); };
$("#hubGo").onclick = () => { const r = acSearch($("#hubSearch").value)[0]; if (r) chooseFocus(r.id); else loadHub(); };
$("#hubStage").onchange = () => loadHub();

/* ---------------- ticker ---------------- */
async function loadTicker() {
  try {
    const items = await api("/api/ticker");
    const html = items.map(i => `<span class="it">${esc(i.icon)}<b>[${esc(i.tag)}]</b>${esc(i.text)}</span>`).join("");
    $("#tickerTrack").innerHTML = html;
    $("#tickerTrack").style.setProperty("--dur", `${Math.max(60, items.length * 7)}s`);
  } catch {}
}

/* ---------------- curated calendar ---------------- */
let CAL = null, calTrack = "all";
const TRACKS = { capital: "Capital & cohort cutoffs", buyers: "Enterprise buyer & demo showcases", talent: "Technical, hackathon & talent" };
function calQuery() { const qs = new URLSearchParams(); if ($("#calStage").value) qs.set("stage", $("#calStage").value); if ($("#calNeed").value) qs.set("need", $("#calNeed").value); return qs; }
async function loadCalendar() {
  const qs = calQuery();
  CAL = await api("/api/calendar?" + qs);
  $("#icsBtn").href = "/api/calendar.ics?" + qs;
  const counts = Object.fromEntries(Object.entries(CAL.tracks).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $("#trackTabs").innerHTML = [["all", `All · ${total}`], ...Object.entries(TRACKS).map(([k, l]) => [k, `${l} · ${counts[k]}`])].map(([k, l]) => `<button data-track="${k}" aria-pressed="${k === calTrack}">${esc(l)}</button>`).join("");
  $$("[data-track]").forEach(b => b.onclick = () => { calTrack = b.dataset.track; loadCalendar(); });
  const items = (calTrack === "all" ? Object.entries(CAL.tracks).flatMap(([k, v]) => v.map(x => ({ ...x, track: k }))) : CAL.tracks[calTrack].map(x => ({ ...x, track: calTrack })))
    .sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  const mon = d => new Date(d + "T12:00:00").toLocaleString("en-US", { month: "short" }).toUpperCase();
  $("#calList").innerHTML = items.map(it => `<div class="calitem"><div class="d">${mon(it.date)}<b>${+it.date.slice(8)}</b></div><div>
      <div>${it.kind === "deadline" ? "⏳ " : ""}${link(it.url, it.title)}</div>
      <div class="muted small">${esc(TRACKS[it.track])}${it.org ? ` · ${esc(it.org)}` : ""}${it.venue ? ` · ${esc(trunc(it.venue, 40))}` : ""}${it.start ? ` · ${new Date(it.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}</div>
      <div class="dim small mono">${esc(it.source)}</div></div></div>`).join("") || `<div class="empty">Nothing in this track for the selected stage/offer.</div>`;
  $("#calRolling").innerHTML = CAL.rolling.map(r => `${link(r.url, r.name)} <span class="dim">(${esc(TRACKS[r.track])})</span>`).join(" · ") || "none";
  const stage = $("#calStage").value, need = $("#calNeed").value;
  const soon = items.slice(0, 3);
  $("#alertPreview").innerHTML = `<div class="quote"><div class="small muted">PREVIEW · weekly organizational digest${stage ? ` · stage ${esc(stage)}` : ""}${need ? ` · ${esc(need)}` : ""}</div>
    <q style="quotes:none">This week in the Massachusetts AI ecosystem: ${soon.map(s => `${esc(s.title)} (${esc(s.date)})`).join("; ") || "no curated items"}. ${CAL.rolling.length} programs accept applications on a rolling basis.</q>
    <div class="dim small" style="margin-top:6px">Preview only: nothing is sent, and no email is collected. The .ics file above is the working subscription today.</div></div>`;
  $("#calMeta").textContent = `${total} curated of ${CAL.total} upcoming events + atlas deadlines · ${CAL.dropped} networking-only or off-track events filtered out · events fetched ${CAL.fetchedAt ? CAL.fetchedAt.slice(0, 16).replace("T", " ") : "never"} (scripts/fetch-events.js)`;
}
$("#calStage").onchange = loadCalendar; $("#calNeed").onchange = loadCalendar;

async function loadHub() {
  $$("[data-persona]").forEach(b => b.setAttribute("aria-pressed", b.dataset.persona === focusId));
  const qs = new URLSearchParams({ focus: focusId });
  if ($("#hubStage").value) qs.set("stage", $("#hubStage").value);
  HUB = await api("/api/capital?" + qs);
  selected = null;
  renderMap(); renderFocus(); renderPillarDetail();
  if ($("#hubSelect")) $("#hubSelect").value = focusId;
  $("#drawer").innerHTML = `<div class="sechead"><h2>Warm intro path</h2><span class="eng matchmaker">Matchmaker</span></div><div class="empty">Click any organization in the value-chain diagram to see the exact warm path from ${esc(HUB.focus?.name || "")} and the evidence behind every hop.</div>`;
}

const hopColor = path => !path ? "#334155" : path.length - 1 <= 1 ? "#10B981" : path.length - 1 === 2 ? "#22D3EE" : "#6366F1";
const pathUnlocked = path => (path || []).some(n => n.unlocked);

function renderMap() {
  const v = HUB; if (!v || !v.focus) { $("#mapwrap").innerHTML = `<div class="empty">Pick an organization.</div>`; return; }
  const W = 1000, H = 680, C = { x: 500, y: 340 };
  const HUBS = { capital: { x: 235, y: 170 }, buyers: { x: 765, y: 170 }, talent: { x: 235, y: 510 }, scale: { x: 765, y: 510 } };
  const parts = [], nodes = [];
  parts.push(`<defs>
    <radialGradient id="cglow"><stop offset="0" stop-color="#22D3EE" stop-opacity=".45"/><stop offset="1" stop-color="#22D3EE" stop-opacity="0"/></radialGradient>
    <linearGradient id="unl" x1="0" x2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#22D3EE"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`);
  // faint rings
  parts.push(`<circle cx="${C.x}" cy="${C.y}" r="150" fill="none" stroke="rgba(255,255,255,.04)"/><circle cx="${C.x}" cy="${C.y}" r="290" fill="none" stroke="rgba(255,255,255,.03)"/>`);
  for (const p of v.pillars) {
    const h = HUBS[p.key], st = PILLAR_STYLE[p.key];
    parts.push(`<path class="edge flow" d="M${C.x},${C.y} L${h.x},${h.y}" stroke="${st.color}" stroke-width="2.5" opacity=".75"/>`);
    const rows = p.rows.slice(0, 7);
    const base = Math.atan2(h.y - C.y, h.x - C.x);
    rows.forEach((r, i) => {
      const spread = rows.length > 1 ? (-1 + 2 * i / (rows.length - 1)) * 1.25 : 0;
      const ang = base + spread, rad = 125;
      const x = h.x + Math.cos(ang) * rad, y = h.y + Math.sin(ang) * rad;
      const col = hopColor(r.path), unl = pathUnlocked(r.path) || r.unlocked.length;
      parts.push(`<path class="edge ${unl ? "flow" : ""}" d="M${h.x},${h.y} Q${(h.x + x) / 2 + Math.sin(ang) * 14},${(h.y + y) / 2 - Math.cos(ang) * 14} ${x},${y}" stroke="${unl ? "url(#unl)" : col}" stroke-width="${r.path ? 1.8 : 1.2}" ${r.path ? "" : 'stroke-dasharray="3 5"'} opacity="${r.path ? .9 : .55}"/>`);
      const right = Math.cos(ang) >= 0;
      nodes.push(`<g class="node" data-pillar="${p.key}" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.name)}">
        ${unl ? `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="url(#unl)" stroke-width="1.5" filter="url(#glow)"/>` : ""}
        <circle class="dot" cx="${x}" cy="${y}" r="${r.path ? 8 : 6}" fill="${col}" stroke="${st.color}" stroke-width="1.5"/>
        <text class="lbl ${r.path ? "" : "dim"}" x="${x + (right ? 14 : -14)}" y="${y + 4}" text-anchor="${right ? "start" : "end"}">${esc(trunc(r.name, 24))}${r.path ? ` · ${r.path.length - 1}h` : ""}${unl ? " ◆" : ""}</text></g>`);
    });
    parts.push(`<g><circle cx="${h.x}" cy="${h.y}" r="30" fill="#0F1420" stroke="${st.color}" stroke-width="2" filter="url(#glow)"/>
      <text class="hublbl" x="${h.x}" y="${h.y - 40}" text-anchor="middle" fill="${st.color}" style="fill:${st.color}">${esc(st.short)}</text>
      <text x="${h.x}" y="${h.y + 5}" text-anchor="middle" style="font-family:var(--mono);font-size:13px;font-weight:700">${p.reachable ?? 0}/${p.count}</text></g>`);
  }
  const f = v.focus;
  parts.push(`<circle cx="${C.x}" cy="${C.y}" r="95" fill="url(#cglow)"/><circle cx="${C.x}" cy="${C.y}" r="46" fill="#0F1420" stroke="#22D3EE" stroke-width="2.5" filter="url(#glow)"/>
    <text x="${C.x}" y="${C.y - 4}" text-anchor="middle" style="font-size:13px;font-weight:700">${esc(trunc(f.name, 22))}</text>
    <text x="${C.x}" y="${C.y + 14}" text-anchor="middle" style="font-size:11px;fill:#8B95A8">${esc(trunc(f.loc, 26))}</text>`);
  $("#mapwrap").innerHTML = `<svg class="vc" viewBox="-150 0 ${W + 300} ${H}" role="img" aria-label="Value chain for ${esc(f.name)}">${parts.join("")}${nodes.join("")}</svg>
    <p class="muted small" style="margin:6px 0 0">Hub numbers show <span class="mono">reachable/total</span>: organizations in that pillar within 4 warm hops of ${esc(f.name)}, out of all in the atlas${v.stage ? ` at stage ${esc(v.stage)}` : ""}.</p>`;
  $$("svg.vc .node").forEach(g => {
    const open = () => selectTarget(g.dataset.pillar, g.dataset.id);
    g.addEventListener("click", open);
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function provenanceCard(prov, a, b) {
  if (!prov || prov.kind === "unknown") return "";
  if (prov.kind === "atlas") return `<div class="icard"><div class="top"><span class="eng nova">Nova</span><span class="chip ok">Human-verified atlas link ✓</span><span class="title">${esc(a)} ↔ ${esc(b)}</span></div>
    <div class="muted small">${esc(prov.detail)}</div><div class="actions">${verify(prov.source_url, "View line in entities.yml ↗")}</div></div>`;
  const ev = prov.evidence || {}, co = prov.corroboration || {};
  return `<div class="icard ${prov.status === "approved in sandbox" ? "accepted" : prov.status === "staged" ? "staged" : ""}"><div class="top"><span class="eng matchmaker">Matchmaker</span>${unlockChip(prov.status)}<span class="title">${esc(a)} → ${esc(b)}</span></div>
    <div class="quote"><q>${esc(ev.quote)}</q><div class="src"><span class="chip cyan">${esc(ev.kind || "source")}</span>${verify(ev.source_url)}</div></div>
    <div class="quote second"><q>${esc(co.quote || co.detail || "")}</q><div class="src"><span class="chip violet">${esc(co.kind || "corroboration")} ✓</span>${verify(co.source_url, "Verify corroboration ↗")}</div></div></div>`;
}

function selectTarget(pillarKey, id) {
  const p = HUB.pillars.find(x => x.key === pillarKey);
  const r = p && p.rows.find(x => x.id === id);
  if (!r) return;
  selected = id;
  $$("svg.vc .node").forEach(g => g.classList.toggle("sel", g.dataset.id === id));
  const st = PILLAR_STYLE[pillarKey];
  const facts = [r.nonDilutive ? "non-dilutive grants" : "", r.dilutive ? "dilutive funding" : "", r.checkSize ? `check ${r.checkSize}` : "", r.terms ? `terms: ${r.terms}` : "", r.equity ? `equity: ${r.equity}` : "",
    r.applyOpen ? (r.applyBy === "rolling" ? "applications rolling" : `apply by ${r.applyBy}`) : "", r.stages.length ? `stages ${r.stages.join(", ")}` : "stages not listed"].filter(Boolean);
  const chain = r.path ? `<div class="path">${r.path.map((n, i) => {
    const hub = i > 0 && i < r.path.length - 1;
    const edge = i ? `<div class="pedge ${n.unlocked ? "unl" : ""}"><span>${n.unlocked ? "◆ unlocked" : "atlas link"}</span><span class="ln"></span><span>${n.provenance?.kind === "matchmaker" ? esc(n.provenance.status) : "verified"}</span></div>` : "";
    return `${edge}<div class="pnode"><small>${i === 0 ? "start" : hub ? "via · " + esc(n.cat) : "target · " + esc(n.cat)}</small>${esc(n.name)}</div>`;
  }).join("")}</div>` : `<div class="empty">No warm path yet: ${esc(r.name)} isn't connected to ${esc(HUB.focus.name)} within 4 hops in the atlas. A Matchmaker proposal or a claimed entry would create one.</div>`;
  const provs = r.path ? r.path.slice(1).map((n, i) => provenanceCard(n.provenance, r.path[i].name, n.name)).join("") : "";
  $("#drawer").innerHTML = `<div class="sechead"><h2>Warm intro path</h2><span class="eng matchmaker">Matchmaker</span></div>
    <div class="fade-in">
    <div class="row"><span class="chip" style="color:${st.color};border-color:${st.color}55">${esc(st.short)}</span><span class="chip">${esc(r.cat)}</span>${r.kmFromBoston > 25 ? `<span class="chip warn">${r.kmFromBoston} km from Boston</span>` : ""}${r.unlocked.length ? unlockChip(r.unlocked.join(", ")) : ""}</div>
    <h3 style="margin:8px 0 2px">${link(r.url, r.name)}</h3><div class="muted small">${esc(r.loc)}</div>
    <div class="badges" style="margin-top:8px">${facts.map(f => `<span class="chip">${esc(f)}</span>`).join("")}</div>
    <h2 style="margin:14px 0 4px">${esc(HUB.focus.name)} → ${esc(r.name)}</h2>${chain}
    ${provs ? `<h2 style="margin:14px 0 4px">Scout provenance, hop by hop</h2>${provs}` : ""}</div>`;
}

function renderFocus() {
  const f = HUB.focus;
  const sig = f.signals?.signals || [];
  const money = sig.filter(s => s.status === "match" && /USAspending|NSF/.test(s.source));
  $("#focusCard").innerHTML = `<div class="sechead"><h2>Scout registry signals</h2><span class="eng scout">Scout</span></div>
    <h3>${link(f.url, f.name)}</h3><div class="muted small">${esc(f.loc)} · ${f.kmFromBoston} km from Boston</div>
    <div class="badges" style="margin-top:8px">${f.links.map(l => `<span class="chip ${l.unlocked ? "unlock" : ""}">${esc(l.name || l.id)}${l.unlocked ? " ◆" : ""}</span>`).join("") || `<span class="chip">no direct links</span>`}</div>
    ${money.length ? `<div class="quote" style="margin-top:10px"><q>${money.map(s => esc(s.summary)).join("<br>")}</q><div class="src"><span class="chip ok">Federal awards received ✓</span>${verify(money[0].humanUrl || money[0].url, "Verify on registry ↗")}</div><div class="muted small" style="margin-top:6px">This is a validation signal. Receiving a federal award is not offering <code>grants</code>, so Nova refuses that mapping.</div></div>` : ""}
    ${sig.length ? `<div style="margin-top:10px">${sig.map(s => `<div class="sig"><span class="st ${s.status === "no match" ? "no" : esc(s.status)}">${esc(s.status)}</span><div><b>${esc(s.source)}</b><div class="muted small">${esc(s.summary)}</div>${s.humanUrl ? verify(s.humanUrl, "record ↗") : ""}</div></div>`).join("")}</div><div class="dim small">cross-checked ${esc(f.signals.at)}</div>`
      : `<div class="empty" style="margin-top:10px">No public-API cross-check yet for this org.</div>`}
    <div class="actions"><button class="btn-cyan btn-sm" id="focusScan">${sig.length ? "Re-run" : "Run"} Scout cross-check now</button><span class="muted small" id="focusScanState"></span></div>
    ${f.proposals?.length ? `<h2 style="margin:14px 0 4px">Proposals about ${esc(f.name)}</h2>${f.proposals.map(p => `<div class="icard ${p.status === "accepted" ? "accepted" : ""}"><div class="top"><span class="chip">${esc(p.status === "accepted" ? "approved in sandbox" : p.staged ? "staged" : p.status)}</span><span class="title small">${esc(p.summary)}</span></div><div class="quote"><q>${esc(p.evidence.quote)}</q><div class="src">${verify(p.evidence.source_url)}${p.corroboration?.source_url ? verify(p.corroboration.source_url, "Corroboration ↗") : ""}</div></div></div>`).join("")}` : ""}`;
  $("#focusScan").onclick = async () => {
    $("#focusScan").disabled = true; $("#focusScanState").textContent = "running website + public-API survey…";
    try { await post(`/api/survey/${f.id}`); await loadHub(); refreshCounts(); } catch (e) { $("#focusScanState").textContent = e.message; $("#focusScan").disabled = false; }
  };
}

function renderPillarDetail() {
  $("#pillarDetail").innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">${HUB.pillars.map(p => {
    const st = PILLAR_STYLE[p.key];
    return `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;background:rgba(255,255,255,.015)"><div class="row" style="justify-content:space-between"><b style="color:${st.color}">${esc(p.label)}</b><span class="mono dim">${p.reachable ?? 0}/${p.count}</span></div>
      ${p.rows.slice(0, 10).map(r => `<div style="border-top:1px solid var(--line);padding:6px 0;font-size:13px;cursor:pointer" data-pick="${p.key}|${esc(r.id)}"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${hopColor(r.path)};margin-right:6px"></span>${esc(r.name)} <span class="dim small">${r.path ? `${r.path.length - 1} hop${r.path.length > 2 ? "s" : ""}` : "no path"}${r.checkSize ? ` · ${esc(r.checkSize)}` : ""}${r.applyOpen ? " · open" : ""}</span>${(pathUnlocked(r.path) || r.unlocked.length) ? ' <span class="chip unlock" style="padding:0 6px">◆</span>' : ""}</div>`).join("")}</div>`;
  }).join("")}</div>`;
  $$("[data-pick]").forEach(el => el.onclick = () => { const [k, id] = el.dataset.pick.split("|"); selectTarget(k, id); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

/* ---------------- find by need ---------------- */
$("#needs").innerHTML = OFFERS.map(o => `<label><input type="checkbox" value="${o}">${o}</label>`).join("");
$("#exRun").onclick = async () => {
  const qs = new URLSearchParams();
  $$("#needs input:checked").forEach(i => qs.append("need", i.value));
  if ($("#exStage").value) qs.set("stage", $("#exStage").value);
  qs.set("start", focusId);
  const r = await api("/api/explore?" + qs);
  $("#exOut").innerHTML = `<p class="muted small">${r.count} matching · paths start from ${esc(NAME[focusId] || focusId)}</p>` + r.results.slice(0, 12).map((x, i) => `
    <div class="icard"><div class="top"><span class="mono dim">${String(i + 1).padStart(2, "0")}</span><span class="title">${link(x.url, x.name)}</span><span class="chip">${esc(x.cat)}</span>${x.unlocked.length ? unlockChip(x.unlocked.join(", ")) : ""}<span class="mono dim">score ${x.score}</span></div>
      <div class="muted small">${esc(x.reasons.join(" · "))}</div>
      ${x.chain ? `<div class="path">${x.chain.map((c, j) => `${j ? `<div class="pedge ${c.edge && c.edge.status ? "unl" : ""}"><span class="ln"></span></div>` : ""}<div class="pnode">${esc(c.name)}</div>`).join("")}</div>` : ""}</div>`).join("");
};

/* ---------------- intelligence cards ---------------- */
const STATUS = { pending: "pending", accepted: "approved in sandbox", approved: "committed", rejected: "rejected" };
function apiBadges(p) {
  const out = [], k = `${p.corroboration?.kind || ""} ${p.evidence?.kind || ""}`;
  if (/OpenStreetMap/.test(k)) out.push(["OpenStreetMap ✓", "ok"]);
  if (/Census/.test(k) || (p.census && p.census.agrees)) out.push(["US Census ✓", "ok"]);
  if (p.census && !p.census.agrees) out.push(["US Census ⚠", "warn"]);
  if (/NSF/.test(k)) out.push(["NSF ✓", "ok"]);
  if (/ROR/.test(k)) out.push(["ROR ✓", "ok"]);
  if (/NIH/.test(k)) out.push(["NIH ✓", "ok"]);
  if (/reciprocal atlas/.test(k)) out.push(["Reciprocal atlas link ✓", "violet"]);
  if (/reciprocal mention/.test(k)) out.push(["Reciprocal website ✓", "violet"]);
  if (/second page/.test(k)) out.push(["2nd page, same site", "warn"]);
  if (/domain control/.test(k)) out.push(["Domain control ✓", "violet"]);
  if (/official site|website/.test(k)) out.push(["Official website ✓", "cyan"]);
  if (/bio/.test(k)) out.push(["via a person's bio", "warn"]);
  return out.map(([t, c]) => `<span class="chip ${c}">${esc(t)}</span>`).join("");
}
function diffHtml(p) {
  const b = (label, html) => `<div class="b"><small>Before</small>${html}</div>`, a = (html) => `<div class="a"><small>After</small>${html}</div>`, arr = `<div class="arrow">➜</div>`;
  if (p.op === "addLink") return `<div class="diff">${b("", (p.before || []).length ? `links: [${esc(p.before.join(", "))}]` : `<span class="x">no outbound links</span>`)}${arr}${a(`links: + <b>${esc(NAME[p.after] || p.after)}</b>`)}</div>`;
  if (p.op === "setGeo") { const B = p.before || {}, A = p.after || {}; return `<div class="diff">${b("", `<span class="${B.loc !== A.loc ? "x" : ""}">${esc(B.loc)}</span><br><span class="x">${B.lat}, ${B.lng}</span>${B.approx ? `<br><span class="x">approx: true</span>` : ""}`)}${arr}${a(`${esc(A.loc)}<br>${A.lat}, ${A.lng}${A.approx ? "<br>approx: true" : "<br>precise pin"}`)}</div>`; }
  if (p.op === "confirm") return `<div class="diff">${b("", esc(p.before ? (p.before.loc || JSON.stringify(p.before)) : "unverified"))}${arr}${a(`✓ ${p.field === "selfVerified" ? "self-verified" : "confirmed by two sources"} (no data change)`)}</div>`;
  if (p.op === "addEntity") { const e = p.final || p.after; return `<div class="diff">${b("", `<span class="x">not in the atlas</span>`)}${arr}${a(`<b>${esc(e.name)}</b><br>${esc(e.loc)} · ${e.lat}, ${e.lng}${e.approx ? " (approx)" : ""}<br>${e.url ? esc(e.url) : "website: reviewer must supply"}`)}</div>`; }
  return `<div class="diff">${b("", esc(JSON.stringify(p.before)))}${arr}${a(esc(JSON.stringify(p.after)))}</div>`;
}
function entityForm(p) {
  const e = p.after;
  return `<div class="entityform" data-form="${esc(p.id)}"><b class="small" style="color:var(--amber)">Human gate: complete what no registry can supply</b>
    <label>Display name<input data-f="name" value="${esc(e.name)}"></label>
    <label>Official website (https://). Scout fetches it and checks that it names the org.<input data-f="url" value="${esc(e.url || "")}" placeholder="https://…"></label>
    <label>Description<input data-f="desc" value="${esc(e.desc)}"></label>
    <div class="small muted">Offers (what it gives founders; choose at least one)</div>
    <div class="offers">${OFFERS.map(o => `<label><input type="checkbox" data-offer value="${o}">${o}</label>`).join("")}</div></div>`;
}
function proposalCard(p) {
  const c = p.corroboration || {}, ev = p.evidence || {}, isNew = p.op === "addEntity";
  const cls = ["icard", p.status, p.staged && p.status === "pending" ? "staged" : "", isNew ? "newentity" : ""].join(" ");
  const status = p.staged && p.status === "pending" ? "staged" : STATUS[p.status] || p.status;
  let actions = "";
  if (p.status === "pending") actions = `${isNew ? "" : `<button class="btn-ghost btn-sm" data-act="${p.staged ? "unstage" : "stage"}" data-id="${esc(p.id)}">${p.staged ? "Unstage" : "Stage preview"}</button>`}<button class="btn-emerald btn-sm" data-act="approve" data-id="${esc(p.id)}">Approve (sandbox)</button><button class="btn-ghost btn-sm" data-act="reject" data-id="${esc(p.id)}" style="color:var(--red)">Reject</button>`;
  else if (p.status === "accepted") actions = `<button class="btn-ghost btn-sm" data-act="undo" data-id="${esc(p.id)}">Undo</button><button class="btn-ghost btn-sm" data-act="reject" data-id="${esc(p.id)}" style="color:var(--red)">Reject</button><span class="muted small">Written to entities.yml only on Commit Approved.</span>`;
  else if (p.status === "rejected") actions = `<button class="btn-ghost btn-sm" data-act="undo" data-id="${esc(p.id)}">Undo</button>`;
  return `<div class="${cls}" data-card="${esc(p.id)}">
    <div class="top">${engineFor(p.module)}<span class="chip ${p.confidence === "two-source" ? "ok" : "warn"}">${esc(p.confidence || "two-source")}</span><span class="chip">${esc(p.field)}</span><span class="chip ${p.status === "accepted" ? "ok" : ""}">${esc(status)}</span>${isNew && p.distanceKm != null ? `<span class="chip ${p.outsideBoston ? "warn" : ""}">${p.distanceKm} km from Boston</span>` : ""}</div>
    <div class="title">${esc(p.entityName)}</div><div class="muted small">${esc(p.summary)}</div>
    ${diffHtml(p)}
    <div class="badges">${apiBadges(p)}</div>
    <div class="quote"><q>${esc(ev.quote)}</q><div class="src"><span class="chip cyan">Source 1 · ${esc(ev.kind)}</span>${verify(ev.source_url)}</div></div>
    <div class="quote second"><q>${esc(c.quote || c.detail || "")}</q><div class="src"><span class="chip violet">Source 2 · ${esc(c.kind)}</span>${verify(c.source_url, "Verify corroboration ↗")}${c.search_url ? verify(c.search_url, "OSM search ↗") : ""}${c.second_url ? verify(c.second_url, "OSM object ↗") : ""}</div></div>
    ${p.census ? `<div class="muted small">Source 3 · US Census Geocoder: ${esc(p.census.detail)} ${verify(p.census.source_url, "Census ↗")}</div>` : ""}
    ${p.website ? `<div class="quote"><q>${esc(p.website.quote)}</q><div class="src"><span class="chip cyan">Website · reviewer-entered, verified</span>${verify(p.website.source_url)}</div></div>` : ""}
    ${isNew ? `<details><summary>Draft entry &amp; de-duplication</summary><pre>${esc(JSON.stringify(p.final || p.after, null, 2))}</pre><ul class="muted small">${(p.dedupe || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
    ${p.reviewer ? `<div class="muted small">${esc(STATUS[p.status])} by ${esc(p.reviewer)} · <span class="mono">${esc(p.decided)}</span>${p.note ? " · " + esc(p.note) : ""}${p.committedBy ? ` · committed by ${esc(p.committedBy)}` : ""}</div>` : ""}
    ${isNew && p.status === "pending" ? entityForm(p) : ""}
    ${actions ? `<div class="actions">${actions}<span class="mono dim" style="margin-left:auto">${esc(p.id)}</span></div>` : ""}</div>`;
}
function refusalCard(f) {
  return `<div class="icard refusal"><div class="top"><span class="eng novaamber">Nova guardrail</span>${engineFor(f.module === "matchmaker" ? "matchmaker" : "scout")}<span class="chip red">refused</span><span class="chip">${esc(f.field)}</span></div>
    <div class="title">${esc(f.entityName)}</div><div style="margin:4px 0 6px">${esc(f.reason)}</div>
    ${f.candidate ? `<div class="muted small">Candidate value: <span class="mono">${esc(f.candidate)}</span></div>` : ""}
    ${f.quote ? `<div class="quote"><q>${esc(f.quote)}</q><div class="src"><span class="chip">what was seen</span>${verify(f.source_url)}${f.corroboration_url ? verify(f.corroboration_url, "Checked against ↗") : ""}</div></div>` : f.source_url ? `<div class="actions">${verify(f.source_url)}</div>` : ""}</div>`;
}

/* ---------------- Nova queue ---------------- */
async function renderTab() {
  $$("[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  const conf = $("#filterConf").value, field = $("#filterField").value;
  const [all, refs] = await Promise.all([api("/api/proposals"), api("/api/refusals")]);
  const groups = {
    queue: all.filter(p => p.status === "pending" && p.op !== "addEntity"), new: all.filter(p => p.op === "addEntity" && p.status === "pending"),
    staged: all.filter(p => p.status === "pending" && p.staged), accepted: all.filter(p => p.status === "accepted"), decided: all.filter(p => p.status === "approved" || p.status === "rejected"),
  };
  for (const [k, v] of Object.entries(groups)) { const el = document.querySelector(`[data-count="${k}"]`); if (el) el.textContent = v.length; }
  document.querySelector(`[data-count="refusals"]`).textContent = refs.length;
  const fields = [...new Set([...all.map(p => p.field), ...(tab === "refusals" ? refs.map(r => r.field) : [])])].sort();
  $("#filterField").innerHTML = `<option value="">All fields</option>` + fields.map(f => `<option ${f === field ? "selected" : ""}>${esc(f)}</option>`).join("");
  if (tab === "refusals") {
    let r = refs.slice().reverse(); if (field) r = r.filter(x => x.field === field);
    $("#tabCount").textContent = `${r.length} refusal(s)${r.length > 150 ? " · showing 150" : ""}`;
    $("#tab").innerHTML = r.slice(0, 150).map(refusalCard).join("") || `<div class="empty">No refusals.</div>`;
    return;
  }
  let rows = groups[tab].slice().reverse();
  if (conf) rows = rows.filter(p => (p.confidence || "two-source") === conf);
  if (field) rows = rows.filter(p => p.field === field);
  if (tab === "new") rows.sort((a, b) => (b.distanceKm || 0) - (a.distanceKm || 0));
  $("#tabCount").textContent = `${rows.length} proposal(s)`;
  $("#tab").innerHTML = rows.map(proposalCard).join("") || `<div class="empty">Nothing here.</div>`;
}
$$("[data-tab]").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTab(); });
$("#filterConf").onchange = renderTab; $("#filterField").onchange = renderTab;

document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if ((act === "approve" || act === "reject") && !needReviewer("Every decision is attributed.")) return;
  const edits = {};
  if (act === "approve") {
    const form = document.querySelector(`[data-form="${id}"]`);
    if (form) { form.querySelectorAll("[data-f]").forEach(i => edits[i.dataset.f] = i.value); edits.offers = [...form.querySelectorAll("[data-offer]:checked")].map(i => i.value); }
  }
  const note = act === "reject" ? (prompt("Reason for rejecting (optional):") || "") : "";
  b.disabled = true;
  try {
    const r = await post(`/api/proposals/${id}/${act}`, { reviewer: reviewer(), note, edits });
    $$(`[data-card="${id}"]`).forEach(c => c.outerHTML = proposalCard(r.proposal));
  } catch (e) { alert(e.message); b.disabled = false; }
  refreshCounts();
});
$("#stageTwo").onclick = async () => { await post("/api/sandbox/stage-all", { confidence: "two-source" }); refreshAll(); };
$("#clearStage").onclick = async () => { await post("/api/sandbox/clear"); refreshAll(); };
$("#approveStaged").onclick = async () => {
  if (!needReviewer("Approving is attributed.")) return;
  const r = await post("/api/sandbox/approve-staged", { reviewer: reviewer() });
  const bad = r.results.filter(x => !x.ok); if (bad.length) alert(`${r.results.length - bad.length} approved; ${bad.length} skipped: ${bad.map(x => x.error).join("; ")}`);
  refreshAll();
};
$("#validate").onclick = async () => { const v = await post("/api/validate"); showValidate(v.output); loadValidate(); };
try { const r = localStorage.getItem("weave-reviewer"); if (r) $("#reviewer").value = r; } catch {}
$("#reviewer").addEventListener("change", () => { try { localStorage.setItem("weave-reviewer", reviewer()); } catch {} });

/* ---------------- scoreboard ---------------- */
function probeRows(p, el) {
  el.innerHTML = p.rows.map((r, i) => {
    const max = Math.max(r.before, r.after, r.preview, 1);
    const fixed = r.better === "lower" ? r.before - r.after : r.after - r.before;
    const word = r.better === "lower" ? "Fixed" : "Gained";
    return `<div class="probe"><div class="lbl"><span>${esc(r.label)}${r.isNew ? ' <span class="chip violet" style="padding:0 6px">new</span>' : ""}</span>
      <span class="nums">${r.before} → <b>${r.after}</b>${fixed > 0 ? `<span class="delta fix">+${fixed} ${word} in Sandbox</span>` : fixed < 0 ? `<span class="delta worse">${fixed}</span>` : `<span class="delta none">±0</span>`}</span></div>
      <div class="bar"><span class="before" style="width:${100 * r.before / max}%"></span><span class="after ${fixed < 0 ? "worse" : ""}" data-w="${100 * r.after / max}" style="width:${100 * r.before / max}%"></span></div>
      ${r.preview !== r.after ? `<div class="dim small mono">preview with staged: ${r.preview}</div>` : ""}</div>`;
  }).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".after").forEach(x => x.style.width = x.dataset.w + "%")));
}
async function loadProbes() { const p = await api("/api/probes"); probeRows(p, $("#probes")); return p; }

let layout = {};
async function loadGraph() {
  const g = await api("/api/graph");
  const cv = $("#graph"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const P = g.nodes.map(n => layout[n.id] || (layout[n.id] = { x: W * (0.15 + 0.7 * rnd()), y: H * (0.15 + 0.7 * rnd()), vx: 0, vy: 0 }));
  const E = g.edges.map(e => [idx.get(e.s), idx.get(e.t), e.origin]).filter(e => e[0] !== undefined && e[1] !== undefined);
  const deg = new Array(g.nodes.length).fill(0); E.forEach(([a, b]) => { deg[a]++; deg[b]++; });
  // Isolated entries go in a labelled band at the bottom; the rest get a
  // Fruchterman–Reingold layout with cooling in the area above it.
  const iso = P.map((_, i) => i).filter(i => !deg[i]);
  const BAND = 150, GH = H - BAND, cols = 24;
  iso.forEach((i, n) => { P[i].x = 16 + (n % cols) * ((W - 32) / (cols - 1)); P[i].y = GH + 26 + Math.floor(n / cols) * 22; });
  const live = P.map((_, i) => i).filter(i => deg[i]);
  const K = Math.sqrt((W * GH) / Math.max(live.length, 1)) * 0.5, ITER = 300;
  for (let it = 0; it < ITER; it++) {
    const temp = 40 * (1 - it / ITER) + 0.5;
    const disp = P.map(() => ({ x: 0, y: 0 }));
    for (let ii = 0; ii < live.length; ii++) for (let jj = ii + 1; jj < live.length; jj++) {
      const i = live[ii], j = live[jj];
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y; let d = Math.hypot(dx, dy);
      if (d < 0.01) { dx = Math.random() - .5; dy = Math.random() - .5; d = 0.5; }
      const f = (K * K) / d / d;
      disp[i].x += dx * f; disp[i].y += dy * f; disp[j].x -= dx * f; disp[j].y -= dy * f;
    }
    for (const [a, b] of E) {
      const dx = P[a].x - P[b].x, dy = P[a].y - P[b].y, d = Math.hypot(dx, dy) || 0.01, f = d / K;
      disp[a].x -= dx * f; disp[a].y -= dy * f; disp[b].x += dx * f; disp[b].y += dy * f;
    }
    for (const i of live) {
      const p = P[i];
      disp[i].x += (W / 2 - p.x) * 0.18; disp[i].y += (GH / 2 - p.y) * 0.18;
      const d = Math.hypot(disp[i].x, disp[i].y) || 1, m = Math.min(d, temp);
      p.x = Math.max(12, Math.min(W - 12, p.x + disp[i].x / d * m));
      p.y = Math.max(12, Math.min(GH - 12, p.y + disp[i].y / d * m));
    }
  }
  const col = { base: "rgba(148,163,184,.25)", committed: "#10B981", approved: "#10B981", staged: "#8B5CF6" };
  const CAT = { startup: "#5eead4", vc: "#a78bfa", angel: "#f472b6", accel: "#fbbf24", university: "#60a5fa", corporate: "#94a3b8", community: "#4ade80", event: "#fb923c", gov: "#f87171", space: "#22d3ee", student: "#e879f9" };
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(10, GH); ctx.lineTo(W - 10, GH); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#8B95A8"; ctx.font = "600 18px Inter, system-ui, sans-serif";
  ctx.fillText(`ISOLATED · ${iso.length} entries with no link in or out`, 16, GH + 4 + 0);
  for (const o of ["base", "committed", "approved", "staged"]) {
    ctx.strokeStyle = col[o]; ctx.lineWidth = o === "base" ? 1 : 3; ctx.shadowColor = o === "base" ? "transparent" : col[o]; ctx.shadowBlur = o === "base" ? 0 : 8;
    ctx.beginPath(); for (const [a, b, oo] of E) if (oo === o) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); } ctx.stroke();
  }
  ctx.shadowBlur = 0;
  g.nodes.forEach((n, i) => {
    const c = CAT[n.cat] || "#888";
    ctx.beginPath();
    if (n.isNew) { ctx.moveTo(P[i].x, P[i].y - 7); ctx.lineTo(P[i].x + 7, P[i].y); ctx.lineTo(P[i].x, P[i].y + 7); ctx.lineTo(P[i].x - 7, P[i].y); ctx.closePath(); ctx.fillStyle = "#F59E0B"; ctx.fill(); return; }
    ctx.arc(P[i].x, P[i].y, deg[i] ? 4 + Math.min(4, deg[i] / 2) : 4, 0, 7);
    if (deg[i]) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
  });
}

/* ---------------- Scout: live survey + radar ---------------- */
async function runSurvey(input, out, status, btn) {
  const id = idFrom(input);
  if (!id) { status.innerHTML = `<span class="err">Pick an organization from the list.</span>`; return; }
  btn.disabled = true;
  status.textContent = "Scout is reading the website, geocoding with Census and OpenStreetMap, and querying USAspending, NSF, ROR, OpenAlex and IRS 990…";
  out.innerHTML = "";
  const t = performance.now();
  try {
    const r = await post(`/api/survey/${id}`);
    status.innerHTML = `<span class="mono">${((performance.now() - t) / 1000).toFixed(1)} s</span> · ${r.proposals.length} proposal(s) · ${r.refusals.length} refusal(s) · ${r.apiSignals.filter(s => s.status === "match").length} registry matches`;
    const TIER = { exact: "exact name", normalized: "normalized name", parent: "parent institution", "osm-poi": "OSM place name" };
    const findings = r.proposals.length || r.refusals.length || (r.scout.addressCandidates || []).length;
    const quotes = [...r.proposals.map(p => p.evidence), ...r.refusals.filter(f => f.quote).map(f => ({ quote: f.quote, source_url: f.source_url, kind: "refused" }))];
    out.innerHTML = `<div class="fade-in"><div class="row"><h3>${link(r.url, r.name)}</h3><span class="chip">${esc(r.cat)}</span><span class="mono dim">${esc(r.entity)}</span></div>
      <div class="muted small">${esc(r.loc)}${r.approx ? " (approximate pin)" : ""} · links: ${r.links.length ? esc(r.links.map(l => NAME[l] || l).join(", ")) : "none"}</div>
      <div class="row" style="margin:12px 0 4px"><span class="chip ok" style="font-size:13px;padding:4px 12px">✚ ${r.proposals.length} verified proposal${r.proposals.length === 1 ? "" : "s"}</span><span class="chip warn" style="font-size:13px;padding:4px 12px">✗ ${r.refusals.length} smart refusal${r.refusals.length === 1 ? "" : "s"}</span><span class="chip cyan" style="font-size:13px;padding:4px 12px">${r.apiSignals.filter(s => s.status === "match").length} registry matches</span></div>
      <h2 style="margin:16px 0 6px;color:var(--emerald)">Verified proposals: two sources each, sandbox approval</h2>
      ${r.proposals.map(proposalCard).join("") || `<div class="empty">No proposals: nothing on this org passed the two-source rule today.</div>`}
      <h2 style="margin:16px 0 6px;color:var(--amber)">Smart refusals: what Scout inspected and would not guess</h2>
      ${r.refusals.map(refusalCard).join("") || `<div class="empty">No refusals.</div>`}
      <h2 style="margin:16px 0 6px">Public registry cross-check (tiered matching)</h2>
      ${r.apiSignals.map(s => `<div class="sig"><span class="st ${s.status === "no match" ? "no" : s.status === "refused" ? "partial" : esc(s.status)}">${esc(s.status)}</span><div><b>${esc(s.source)}</b> ${s.tier ? `<span class="chip ${s.tier === "parent" ? "violet" : s.tier === "osm-poi" ? "cyan" : ""}" style="padding:0 7px">${esc(TIER[s.tier] || s.tier)}</span>` : ""}<div class="muted small">${esc(s.summary)}</div><div class="row" style="margin-top:4px">${s.humanUrl ? verify(s.humanUrl, "record ↗") : ""}${s.url ? verify(s.url, "query ↗") : ""}</div></div></div>`).join("")}
      <details style="margin-top:12px" ${findings ? "open" : ""}><summary>Website signals, quotes &amp; pages read</summary>
        <ul class="muted small">${r.scout.signals.map(s => `<li>${esc(s.kind)}: ${esc(s.detail)}</li>`).join("")}${(r.scout.addressCandidates || []).map(a => `<li>address on site: <span class="mono">${esc(a.verbatim)}</span> ${link(a.source_url, "page")}</li>`).join("")}</ul>
        ${quotes.slice(0, 6).map(q => `<div class="quote"><q>${esc(q.quote)}</q><div class="src"><span class="chip">${esc(q.kind)}</span>${verify(q.source_url)}</div></div>`).join("")}
        <div class="muted small">Pages read: ${(r.scout.pagesRead || []).map(u => link(u)).join(" · ") || "none"}</div></details></div>`;
  } catch (e) { status.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  finally { btn.disabled = false; refreshCounts(); }
}
$("#run").onclick = () => runSurvey($("#pick"), $("#result"), $("#status"), $("#run"));
$("#pick").addEventListener("keydown", e => { if (e.key === "Enter") $("#run").click(); });
$("#random").onclick = () => { const z = ENT.filter(e => !e.links.length); const e = z[Math.floor(Math.random() * z.length)]; $("#pick").value = `${e.name} (${e.id})`; };

let radarTimer = null;
async function loadRadar() {
  const r = await api("/api/radar");
  $("#radarState").textContent = r.running ? "running…" : r.last ? `last run ${r.last.finished || r.last.started}` : "not run yet";
  $("#radarRun").disabled = r.running;
  if (r.log.length) { $("#radarLog").hidden = false; $("#radarLog").textContent = r.log.join("\n"); }
  if (r.running) { clearTimeout(radarTimer); radarTimer = setTimeout(loadRadar, 2000); }
  else if (radarTimer) { radarTimer = null; refreshCounts(); }
  const o = r.last; if (!o) { $("#radarOut").innerHTML = ""; return; }
  const recs = row => row.records.map(x => `<div class="quote"><q>${esc(x.quote)}</q><div class="src"><span class="chip cyan">${esc(x.source)}</span>${verify(x.url, "Verify on registry ↗")}</div></div>`).join("");
  $("#radarOut").innerHTML = `
    <div class="bigscore" style="margin:12px 0">${[["registry records", o.leads], ["organizations", o.organizations], ["net-new candidates", o.candidates.length], ["matched existing", o.matched.length], ["possible duplicates (refused)", o.possible.length], ["dropped", o.dropped.length]].map(([k, v]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("")}</div>
    <h2 style="margin-top:14px">New Entity Candidates (human gate required)</h2>
    ${o.candidates.map(c => `<div class="icard newentity"><div class="top"><span class="eng scout">Scout</span><span class="chip ok">de-dup: new</span><span class="chip">${esc(c.city)}</span><span class="chip ${c.outsideBoston ? "warn" : ""}">${c.distanceKm} km from Boston${c.westOfWorcester ? " · west of Worcester" : ""}</span></div><div class="title">${esc(c.name)}</div>${recs(c)}<div class="muted small">${c.reasons.map(esc).join(" · ")}</div><div class="dim small">Review in Nova → New entity candidates · <span class="mono">${esc(c.proposal)}</span></div></div>`).join("") || `<div class="empty">None this run.</div>`}
    <h2 style="margin-top:14px">Matched an existing entry</h2>
    ${o.matched.map(c => `<div class="icard"><div class="top"><span class="chip ok">match → ${esc(c.entity)}</span></div><div class="title">${esc(c.name)}</div>${recs(c)}</div>`).join("") || `<div class="empty">No registry record this run matched one of the atlas entries.</div>`}
    <h2 style="margin-top:14px">Possible duplicates (refused, so a person decides)</h2>
    ${o.possible.map(c => `<div class="icard refusal"><div class="top"><span class="eng novaamber">Nova guardrail</span><span class="chip red">≈ ${esc(c.entities.join(", "))}</span></div><div class="title">${esc(c.name)}</div><div class="muted small">${c.reasons.map(esc).join(" · ")}</div>${recs(c)}</div>`).join("") || `<div class="empty">None.</div>`}
    <details style="margin-top:10px"><summary>Dropped leads (${o.dropped.length})</summary><ul class="muted small">${o.dropped.map(d => `<li>${esc(d.name)}: ${esc(d.why)} ${d.records?.[0] ? link(d.records[0].url, "record") : ""}</li>`).join("")}</ul></details>`;
}
$("#radarRun").onclick = async () => { await post("/api/radar/run"); loadRadar(); };

/* ---------------- give to get ---------------- */
function download(name, text, type = "application/json") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#gRun").onclick = async () => {
  const id = idFrom($("#gPick"));
  if (!id) { $("#gOut").innerHTML = `<p class="err">Pick an organization from the list.</p>`; return; }
  const K = await api(`/api/kit/${id}`), v = K.visibility;
  $("#gOut").innerHTML = `<div class="fade-in">
    <div class="row" style="gap:28px;margin:16px 0"><div><div class="big">${v.score}</div><div class="muted small">visibility &amp; deal-flow score / 100</div></div>
      <div class="grow"><div class="meter"><i style="width:0" data-w="${v.score}"></i></div>
        <p style="margin:10px 0 4px">${v.invisiblePct ? `<b>${esc(v.name)} is invisible to <span style="color:var(--amber)">${v.invisiblePct}%</span> of founder searches for what it offers.</b> It is missing from ${v.searches - v.shown} of the ${v.searches} searches it should appear in.` : `<b>${esc(v.name)} appears in every founder search for what it offers.</b>`}</p>
        <div class="row small mono dim">stages lost ${v.lost.stages} · applyBy lost ${v.lost.applyBy} · warm-path links ${v.degree} · sourced fields ${v.evidence}</div></div></div>
    ${v.missing.length ? `<table><thead><tr><th>Missing</th><th>What it costs you</th></tr></thead><tbody>${v.missing.map(m => `<tr><td class="mono">${esc(m.field)}</td><td>${esc(m.impact)}</td></tr>`).join("")}</tbody></table>` : ""}
    <h2 style="margin-top:18px">Community self-verification kit</h2>
    <p class="muted small">Publish at <code>${esc(new URL("/.well-known/mass-ai-atlas.json", v.url).href)}</code></p>
    <div class="row"><button class="btn-emerald" id="dlManifest">Download mass-ai-atlas.json</button><button class="btn-ghost" id="dlLd">Download JSON-LD</button>${verify(K.issueUrl, "Open pre-filled GitHub issue ↗")}</div>
    <details open style="margin-top:10px"><summary>.well-known/mass-ai-atlas.json</summary><pre>${esc(JSON.stringify(K.manifest, null, 2))}</pre></details>
    <details><summary>Schema.org JSON-LD</summary><pre>${esc(K.jsonLdSnippet)}</pre></details>
    <details><summary>Maintainer submission preview</summary><pre>${esc(K.issueBody)}</pre></details></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => { const m = $("#gOut .meter i"); if (m) m.style.width = m.dataset.w + "%"; }));
  $("#dlManifest").onclick = () => download("mass-ai-atlas.json", JSON.stringify(K.manifest, null, 2) + "\n");
  $("#dlLd").onclick = () => download(`${id}-jsonld.html`, K.jsonLdSnippet + "\n", "text/html");
};

/* ---------------- judge cockpit ---------------- */
function tiles(p) {
  return p.rows.map(r => {
    const fixed = r.better === "lower" ? r.before - r.after : r.after - r.before;
    const max = Math.max(r.before, r.after, 1);
    return `<div class="tile ${fixed > 0 ? "moved" : ""}"><div class="k">${esc(r.label)}${r.isNew ? ' <span class="chip violet" style="padding:0 6px">new</span>' : ""}</div>
      <div class="v"><span class="from">${r.before} →</span> ${r.after}</div>
      <div class="bar"><span class="before" style="width:${100 * r.before / max}%"></span><span class="after" data-w="${100 * r.after / max}" style="width:${100 * r.before / max}%"></span></div>
      <div style="margin-top:8px">${fixed > 0 ? `<span class="delta fix">+${fixed} ${r.better === "lower" ? "Fixed" : "Gained"} in Sandbox</span>` : `<span class="delta none">no change yet</span>`}</div></div>`;
  }).join("");
}
function animateBars(root) { requestAnimationFrame(() => requestAnimationFrame(() => root.querySelectorAll(".after[data-w]").forEach(x => x.style.width = x.dataset.w + "%"))); }
async function loadJudge() {
  const [p, s] = await Promise.all([api("/api/probes"), api("/api/judge/sources")]);
  $("#jScore").innerHTML = tiles(p); animateBars($("#jScore"));
  $("#jSources").innerHTML = s.apis.map(a => `<div class="sig"><span class="st match">${a.url ? "API" : "WEB"}</span><div><b>${esc(a.name)}</b><div class="muted small">${esc(a.use)}</div>${a.url ? `<div class="mono dim small">${esc(a.url)}</div>` : ""}</div></div>`).join("")
    + `<div class="muted small" style="margin-top:8px">${s.notUsed.map(esc).join(" · ")}</div><details style="margin-top:8px"><summary>${s.orgSites.length} organization domains read</summary><p class="mono dim small">${s.orgSites.map(h => esc(h.host)).join(" · ")}</p></details>`;
}
$$("[data-q]").forEach(b => b.onclick = async () => {
  const q = b.dataset.q, out = $("#qOut");
  if (q === "1") {
    const r = await api("/api/judge/refusals");
    out.innerHTML = `<h2>Q1 · What the system refused to do</h2>` + r.map(refusalCard).join("");
  } else if (q === "2") {
    out.innerHTML = `<h2>Q2 · Live survey on the judge's pick</h2><div class="row"><input class="grow" list="orgs" id="jPick" placeholder="Judge: type any organization…"><button class="btn-cyan" id="jRun">Run live survey</button></div><p class="status" id="jStatus"></p><div id="jResult"></div>`;
    $("#jRun").onclick = () => runSurvey($("#jPick"), $("#jResult"), $("#jStatus"), $("#jRun"));
    $("#jPick").addEventListener("keydown", e => { if (e.key === "Enter") $("#jRun").click(); });
    $("#jPick").focus();
  } else if (q === "3") {
    const p = await api("/api/probes");
    const moved = p.rows.filter(r => r.better === "lower" ? r.after < r.before : r.after > r.before);
    out.innerHTML = `<h2>Q3 · This morning (git HEAD) → now (sandbox)</h2>
      <p class="muted">None of these probes has an official threshold. A probe passes now if it has moved in its better direction since this morning's git HEAD. <b>${moved.length} of ${p.rows.length}</b> have moved${moved.length ? `: ${esc(moved.map(r => r.label.replace(/^\d+ · /, "")).join("; "))}` : ". Approve proposals to move them."}</p>
      <div class="bigscore">${tiles(p)}</div>`;
    animateBars(out);
  } else if (q === "4") {
    const c = await api("/api/judge/claim");
    if (!c) { out.innerHTML = `<div class="empty">No claims yet.</div>`; return; }
    const co = c.corroboration || {}, ev = c.evidence || {};
    out.innerHTML = `<h2>Q4 · A random claim, with both sources</h2>
      <div class="row" style="margin-bottom:10px"><span class="title" style="font-weight:650">${esc(c.entityName || c.entity)}</span><span class="chip">${esc(c.field)}</span><span class="chip">${esc(c.status)}</span><span class="chip ${c.confidence === "two-source" ? "ok" : "warn"}">${esc(c.confidence || "two-source")}</span></div>
      <div class="muted" style="margin-bottom:10px">${esc(c.summary || "")}</div>
      <div class="sbs"><div class="quote"><div class="small muted" style="margin-bottom:6px">PRIMARY · ${esc(ev.kind)}</div><q>${esc(ev.quote)}</q><div class="src">${verify(ev.source_url)}</div><div class="mono dim small" style="margin-top:6px">${esc(ev.source_url)}</div></div>
        <div class="quote second"><div class="small muted" style="margin-bottom:6px">CORROBORATION · ${esc(co.kind)}</div><q>${esc(co.quote || co.detail || "")}</q><div class="src">${verify(co.source_url, "Verify corroboration ↗")}</div><div class="mono dim small" style="margin-top:6px">${esc(co.source_url)}</div>${c.census ? `<div class="small muted" style="margin-top:6px">+ US Census: ${esc(c.census.detail)} ${verify(c.census.source_url, "Census ↗")}</div>` : ""}</div></div>
      <div class="actions"><button class="btn-ghost" id="again">Another one</button></div>`;
    $("#again").onclick = () => b.click();
  }
});
$("#mkBrief").onclick = async () => { const r = await post("/api/brief"); $("#briefOut").hidden = false; $("#briefOut").textContent = r.markdown; };

/* ---------------- refresh ---------------- */
function refreshCounts() { loadStatus(); if ($("#v-nova").classList.contains("active")) { loadProbes(); loadGraph(); } }
function refreshAll() { return Promise.all([loadStatus(), loadValidate(), loadEntities(), renderTab(), loadProbes(), loadGraph(), loadTicker(), HUB ? loadHub() : null]); }

loadEntities().then(() => {
  renderPersonas(); loadHub();
  try { const v = localStorage.getItem("weave-view"); if (v && v !== "hub") $(`.pills [data-view="${v}"]`)?.click(); } catch {}
});
loadStatus(); loadValidate(); loadTicker();   // calendar, Nova queue and scoreboard load when their views open
setInterval(loadTicker, 60000);
