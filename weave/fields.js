/* Scout field discovery: applyBy deadlines, check sizes, founder stages.

   These are facts an org states about itself, so no outside source can confirm
   them. The rule here is stricter than "found it once":
     - the value must be quoted verbatim from the org's own site;
     - the SAME value must appear on a second, different page of that site
       (confidence "same-site, 2 pages" — weaker than an independent source,
       and labelled as such for the reviewer);
     - one page only, or two pages that disagree → refusal. */
const { quoteAround } = require("./lib/text");

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RES = [
  new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi"),   // March 3, 2027
  new RegExp(`\\b(\\d{1,2})\\s+${MON_RE}\\.?,?\\s+(20\\d{2})\\b`, "gi"),                    // 3 March 2027
];
const DEADLINE_CUE = /\b(deadline|apply by|applications? (?:are |is )?due|due (?:date|by)|applications? close|closes? on|submit(?:ted)? by|last day to apply|priority deadline)\b/i;

function sentences(text) {
  const out = [];
  let i = 0;
  for (const part of text.split(/(?<=[.!?])\s+|\n+/)) { const at = text.indexOf(part, i); out.push({ s: part, at }); i = at + part.length; }
  return out;
}
const monthIdx = m => MONTHS.findIndex(x => x.startsWith(m.toLowerCase().slice(0, 3)));
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function findDeadlines(page, today) {
  const max = new Date(Date.parse(today) + 400 * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const { s, at } of sentences(page.text)) {
    if (!DEADLINE_CUE.test(s) || s.length > 400) continue;
    for (const re of DATE_RES) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(s))) {
        const [mon, day, year] = /^\d/.test(m[1]) ? [m[2], m[1], m[3]] : [m[1], m[2], m[3]];
        const mi = monthIdx(mon); const dd = +day;
        if (mi < 0 || dd < 1 || dd > 31) continue;
        const date = ymd(+year, mi, dd);
        if (date <= today || date > max) continue;
        out.push({ value: date, source_url: page.url, quote: quoteAround(page.text, at + m.index, m[0].length, 140) });
      }
    }
  }
  return out;
}

const MONEY = String.raw`\$\s?(\d[\d,.]*)\s?(k|K|M|MM|m(?:illion)?|thousand)?`;
const RANGE_RE = new RegExp(`${MONEY}(?:\\s?(?:–|—|-|to)\\s?${MONEY})?`, "g");
// The sentence must be about the firm's own typical check, not follow-on rights,
// fund size, or what portfolio companies raised.
const CHECK_CUE = /\b(check sizes?|checks? (?:of|between|from|ranging)|first checks?|we (?:typically |usually )?(?:invest|write|lead)|initial investments? (?:of|between|ranging)|typical investment)\b/i;
const NOT_CHECK = /\b(fund (?:size|of)|raised|closed|under management|AUM|portfolio companies have raised|valuation|revenue|additional|follow-?on|right to|side letter|pro rata)\b/i;

function money(n, u) {
  let v = parseFloat(n.replace(/,/g, ""));
  if (!isFinite(v)) return null;
  u = (u || "").toLowerCase();
  if (u === "k" || u === "thousand") v *= 1e3;
  else if (u.startsWith("m")) v *= 1e6;
  return v;
}
const fmt = v => v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${v}`;

function findCheckSizes(page) {
  const out = [];
  for (const { s, at } of sentences(page.text)) {
    if (!CHECK_CUE.test(s) || NOT_CHECK.test(s) || s.length > 400) continue;
    RANGE_RE.lastIndex = 0; let m;
    while ((m = RANGE_RE.exec(s))) {
      let a = money(m[1], m[2] || m[4]), b = m[3] ? money(m[3], m[4]) : null;
      if (!a || a < 1e4 || a > 1e8 || (b && (b < a || b > 2e8))) continue;
      const value = b ? `${fmt(a)}–${fmt(b)}` : fmt(a);
      out.push({ value, source_url: page.url, quote: quoteAround(page.text, at + m.index, m[0].length, 140) });
    }
  }
  return out;
}

const STAGE_CUES = [
  [4, /\b(pre-?seed|seed[- ]stage|seed rounds?|at (?:the )?seed|first (?:institutional )?round)\b/i, "pre-seed/seed → 4 Fund"],
  [5, /\b(series [abc]|growth[- ]stage|growth equity|expansion stage|scale-?ups?)\b/i, "Series A+/growth → 5 Scale"],
];
function findStages(page) {
  const out = [];
  for (const { s, at } of sentences(page.text)) {
    if (s.length > 400 || !/\b(invest|back|fund|partner|support|work with)/i.test(s)) continue;
    for (const [n, re, why] of STAGE_CUES) {
      const m = s.match(re);
      if (m) out.push({ value: n, why, source_url: page.url, quote: quoteAround(page.text, at + m.index, m[0].length, 140) });
    }
  }
  return out;
}

/* Group findings by value; a value is corroborated when ≥2 distinct pages carry it. */
function corroborate(found) {
  const byVal = new Map();
  for (const f of found) {
    const k = JSON.stringify(f.value);
    if (!byVal.has(k)) byVal.set(k, new Map());
    const pages = byVal.get(k);
    if (!pages.has(f.source_url)) pages.set(f.source_url, f);
  }
  return [...byVal.entries()].map(([k, pages]) => ({ value: JSON.parse(k), hits: [...pages.values()] }));
}

const SAME_SITE = "same-site, 2 pages";

function discover(d, pages, { refuse, propose, today }) {
  const cats = new Set(["vc", "angel", "accel"]);

  // ---- applyBy ----
  if (!d.applyBy || (d.applyBy !== "rolling" && d.applyBy < today)) {
    const groups = corroborate(pages.flatMap(p => findDeadlines(p, today)));
    if (groups.length > 1) {
      refuse("applyBy", `Ambiguous: the site states ${groups.length} different upcoming deadlines`, { candidate: groups.map(g => g.value).join(" | "), source_url: groups[0].hits[0].source_url, quote: groups.slice(0, 3).map(g => g.hits[0].quote).join(" … ") });
    } else if (groups.length === 1) {
      const g = groups[0];
      if (g.hits.length < 2) refuse("applyBy", "Deadline appears on only one page of the org's site — single source, not proposed", { candidate: g.value, source_url: g.hits[0].source_url, quote: g.hits[0].quote });
      else propose({ field: "applyBy", op: "setApplyBy", before: d.applyBy ?? null, after: g.value, confidence: SAME_SITE,
        summary: `Set application deadline to ${g.value}${d.applyBy ? ` (was ${d.applyBy}, now passed)` : ""}`,
        evidence: { source_url: g.hits[0].source_url, quote: g.hits[0].quote, kind: "official site" },
        corroboration: { source_url: g.hits[1].source_url, quote: g.hits[1].quote, kind: "second page of the org's own site (same publisher)" } });
    }
  }

  // ---- check size ----
  if (cats.has(d.cat) && !(d.facts || []).some(([k]) => k === "Check size") && (d.facts || []).length < 6) {
    const groups = corroborate(pages.flatMap(findCheckSizes));
    const two = groups.filter(g => g.hits.length >= 2);
    if (two.length === 1) {
      const g = two[0];
      propose({ field: "facts", op: "addFact", before: d.facts || [], after: ["Check size", g.value], confidence: SAME_SITE,
        summary: `Add fact Check size: ${g.value}`,
        evidence: { source_url: g.hits[0].source_url, quote: g.hits[0].quote, kind: "official site" },
        corroboration: { source_url: g.hits[1].source_url, quote: g.hits[1].quote, kind: "second page of the org's own site (same publisher)" } });
    } else if (two.length > 1 || groups.length > 1) {
      refuse("facts", `Ambiguous check size: the site quotes ${groups.length} different amounts`, { candidate: groups.map(g => g.value).join(" | "), source_url: groups[0].hits[0].source_url, quote: groups.slice(0, 3).map(g => g.hits[0].quote).join(" … ") });
    } else if (groups.length === 1) {
      refuse("facts", "Unverified check size: stated on one page only — not proposed", { candidate: groups[0].value, source_url: groups[0].hits[0].source_url, quote: groups[0].hits[0].quote });
    }
  }

  // ---- stages ----
  if (!(d.stages || []).length) {
    if (!cats.has(d.cat)) {
      refuse("stages", "Missing stages, but nothing on the site states which founder stages it serves — a person must decide", { source_url: pages[0].url });
    } else {
      const groups = corroborate(pages.flatMap(findStages)).filter(g => g.hits.length >= 2);
      if (!groups.length) {
        const any = pages.flatMap(findStages)[0];
        refuse("stages", any ? "Stage language found on one page only — not proposed" : "Missing stages, and the site never names the rounds it backs", { source_url: any?.source_url || pages[0].url, quote: any?.quote, candidate: any ? String(any.value) : undefined });
      } else {
        const values = groups.map(g => g.value).sort();
        const g = groups[0];
        propose({ field: "stages", op: "setStages", before: [], after: values, confidence: SAME_SITE,
          summary: `Set stages to [${values.join(", ")}] (${groups.map(x => x.hits[0].why || STAGE_CUES.find(c => c[0] === x.value)[2]).join("; ")}) — makes it visible in stage searches`,
          evidence: { source_url: g.hits[0].source_url, quote: g.hits[0].quote, kind: "official site" },
          corroboration: { source_url: g.hits[1].source_url, quote: g.hits[1].quote, kind: "second page of the org's own site (same publisher)" } });
      }
    }
  }
}

module.exports = { discover, findDeadlines, findCheckSizes, findStages, sentences };
