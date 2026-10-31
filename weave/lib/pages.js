/* Fetch an organization's homepage plus a few same-site pages likely to carry
   an address or partner list. Returns parsed pages with their served URLs. */
const { get } = require("./fetcher");
const { htmlToText, extractLinks, extractJsonLdAddresses, hostOf } = require("./text");

const INTERESTING = /(contact|about|location|visit|find-us|directions|partner|sponsor|member|portfolio|community|ecosystem|network|team|collaborat|apply|application|program|accelerator|invest|approach|faq|deadline)/i;

async function crawlOrg(url, { maxExtra = 6 } = {}) {
  const home = await get(url);
  const pages = [];
  if (!home.status || home.status >= 400 || !home.body) return { home, pages };
  pages.push(parse(home));
  const host = hostOf(home.finalUrl);
  const seen = new Set([stripHash(home.finalUrl)]);
  const extra = pages[0].links
    .filter(l => l.host === host && INTERESTING.test(new URL(l.href).pathname))
    .map(l => stripHash(l.href))
    .filter(h => !seen.has(h) && seen.add(h))
    .slice(0, maxExtra);
  for (const h of extra) {
    const r = await get(h);
    if (r.status && r.status < 400 && r.body) pages.push(parse(r));
  }
  return { home, pages };
}

function parse(r) {
  return {
    url: r.finalUrl,
    status: r.status,
    text: htmlToText(r.body),
    links: extractLinks(r.body, r.finalUrl),
    jsonLd: extractJsonLdAddresses(r.body),
  };
}
const stripHash = (u) => u.split("#")[0];

module.exports = { crawlOrg };
