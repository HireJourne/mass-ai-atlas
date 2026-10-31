/* HTML → text, links, JSON-LD, and verbatim quote extraction. Deterministic on
   purpose: every quote returned here is a substring of the page text, so it
   can be checked by searching the source page for it. */

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", middot: "·", bull: "•" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|address|section|footer|header)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t\r\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(decode(m[1]), baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      out.push({ href: u.href, host: hostOf(u.href), text: htmlToText(m[2]).replace(/\s+/g, " ").slice(0, 120) });
    } catch {}
  }
  return out;
}

function extractJsonLdAddresses(html) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if ((o["@type"] === "PostalAddress" || o.streetAddress) && typeof o.streetAddress === "string")
      out.push({ street: o.streetAddress, city: o.addressLocality || "", region: o.addressRegion || "", raw: JSON.stringify(o) });
    Object.values(o).forEach(walk);
  };
  while ((m = re.exec(html))) { try { walk(JSON.parse(m[1])); } catch {} }
  return out;
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

/* A sentence-ish window of the page text around [i, i+len). */
function quoteAround(text, i, len, pad = 90) {
  let a = Math.max(0, i - pad), b = Math.min(text.length, i + len + pad);
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return text.slice(a, b).replace(/\s+/g, " ").trim();
}

const SUFFIX = "(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Way|Pl|Place|Sq|Square|Dr|Drive|Pkwy|Parkway|Ln|Lane|Ct|Court|Wharf|Row|Plaza|Hwy|Highway|Ter|Terrace|Park|Pier|Circle|Center|Mall)";
const ADDR_RE = new RegExp(
  String.raw`\b(\d{1,5}[A-Z]?(?:-\d{1,5})?)\s+((?:[A-Z][A-Za-z.'’-]*\s+){0,4}?${SUFFIX})\.?` +
  String.raw`(?:,?\s*(?:Suite|Ste\.?|Floor|Fl\.?|Unit|#|Room)\s*[\w-]+)?` +
  String.raw`(?:,?\s*\n?\s*((?!(?:MA|Mass|Massachusetts)\b)[A-Z][A-Za-z.]+(?:\s(?!(?:MA|Mass|Massachusetts)\b)[A-Z][A-Za-z.]+){0,2}))?` +
  String.raw`(?:,?\s*(MA|Mass\.?|Massachusetts)\b)?(?:\s*(0\d{4}))?`, "g");

/* Street-address candidates in page text, each with its verbatim quote. */
function findAddresses(text) {
  const out = [];
  let m;
  ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(text))) {
    const [full, num, street, city, state, zip] = m;
    out.push({
      verbatim: full.replace(/\s+/g, " ").trim(),
      number: num, street: street.replace(/\s+/g, " ").trim(),
      city: city || "", ma: Boolean(state) || /^0[12]\d{3}$/.test(zip || ""), zip: zip || "",
      quote: quoteAround(text, m.index, full.length),
    });
  }
  return out;
}

const ABBR = { street: "st", avenue: "ave", road: "rd", boulevard: "blvd", place: "pl", square: "sq", drive: "dr", parkway: "pkwy", lane: "ln", court: "ct", highway: "hwy", terrace: "ter" };
function normStreet(s) {
  return s.toLowerCase().replace(/[.,’']/g, "").split(/\s+/).map(w => ABBR[w] || w).join(" ").trim();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

module.exports = { htmlToText, extractLinks, extractJsonLdAddresses, findAddresses, normStreet, quoteAround, hostOf, escapeRe };
