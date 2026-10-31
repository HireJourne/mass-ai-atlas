/* Keyless public registries. Each function returns plain records plus a
   clickable human URL for every record, so anything shown can be checked. */
const { json } = require("./fetcher");

const enc = encodeURIComponent;

/* ---------- names, for de-duplication and matching ---------- */
const SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|lp|llp|pbc|plc|the|group|holdings)\b\.?/g;
function normName(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/\(.*?\)/g, " ").replace(SUFFIX, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/* ---------- geocoding ---------- */
async function census(oneLine) {
  const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + new URLSearchParams({ address: oneLine, benchmark: "Public_AR_Current", format: "json" });
  const r = await json(url, { timeoutMs: 15000 });
  const m = r.data?.result?.addressMatches?.[0];
  return {
    source: "US Census Geocoder", url, ok: Boolean(m), status: r.status,
    match: m ? { lat: m.coordinates.y, lng: m.coordinates.x, matched: m.matchedAddress, city: m.addressComponents?.city || "", state: m.addressComponents?.state || "" } : null,
  };
}

/* ---------- federal awards ---------- */
async function nsfAwards({ keyword, awardeeName, program, rpp = 25, offset = 1, startDateStart } = {}) {
  const p = new URLSearchParams({ awardeeStateCode: "MA", rpp: String(rpp), offset: String(offset),
    printFields: "id,title,awardeeName,awardeeCity,awardeeAddress,awardeeZipCode,startDate,date,fundsObligatedAmt,estimatedTotalAmt,fundProgramName" });
  if (keyword) p.set("keyword", keyword);
  if (awardeeName) p.set("awardeeName", awardeeName);
  if (program) p.set("fundProgramName", program);
  if (startDateStart) p.set("startDateStart", startDateStart);
  const url = "https://api.nsf.gov/services/v1/awards.json?" + p;
  const r = await json(url, { timeoutMs: 20000 });
  return { source: "NSF Awards API", url, status: r.status, records: (r.data?.response?.award || []).map(a => ({
    id: a.id, title: a.title, name: a.awardeeName, city: a.awardeeCity, address: a.awardeeAddress, zip: a.awardeeZipCode,
    date: a.date || a.startDate, amount: Number(a.estimatedTotalAmt || a.fundsObligatedAmt || 0), program: a.fundProgramName,
    humanUrl: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${a.id}`,
  })) };
}

async function nihSbir({ text = "artificial intelligence", limit = 25 } = {}) {
  const url = "https://api.reporter.nih.gov/v2/projects/search";
  const body = { criteria: { org_states: ["MA"], activity_codes: ["R43", "R44", "U43", "U44", "R41", "R42"], fiscal_years: [2025, 2026, 2027],
    advanced_text_search: { search_text: text, operator: "and", search_field: "projecttitle,abstracttext" } },
    limit, include_fields: ["ProjectTitle", "Organization", "AwardAmount", "FiscalYear", "ProjectNum", "ApplId", "ProjectStartDate"] };
  const r = await json(url, { method: "POST", body, timeoutMs: 20000 });
  return { source: "NIH RePORTER", url: "https://reporter.nih.gov/", status: r.status, records: (r.data?.results || []).map(x => ({
    id: x.project_num, title: x.project_title, name: x.organization?.org_name, city: x.organization?.org_city, zip: x.organization?.org_zipcode,
    address: "", date: x.project_start_date?.slice(0, 10), amount: x.award_amount, program: "NIH SBIR/STTR",
    humanUrl: `https://reporter.nih.gov/project-details/${x.appl_id}`,
  })) };
}

async function usaspending(recipient, group = "grants") {
  const codes = { grants: ["02", "03", "04", "05"], contracts: ["A", "B", "C", "D"] }[group];
  const url = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
  const body = { filters: { recipient_search_text: [recipient], award_type_codes: codes, recipient_locations: [{ country: "USA", state: "MA" }] },
    fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "generated_internal_id"], limit: 10, sort: "Award Amount", order: "desc" };
  const r = await json(url, { method: "POST", body, timeoutMs: 20000 });
  return { source: `USAspending.gov (${group})`, url: `https://www.usaspending.gov/search/?hash=&keyword=${enc(recipient)}`, status: r.status,
    records: (r.data?.results || []).map(x => ({ id: x["Award ID"], name: x["Recipient Name"], amount: x["Award Amount"], agency: x["Awarding Agency"], date: x["Start Date"],
      humanUrl: `https://www.usaspending.gov/award/${x.generated_internal_id}` })) };
}

/* ---------- SEC EDGAR full-text search (Form D) ---------- */
async function edgarFormD(q, { startdt, enddt, from = 0 } = {}) {
  const p = new URLSearchParams({ q: `"${q}"`, forms: "D", dateRange: "custom", startdt, enddt, from: String(from) });
  const url = "https://efts.sec.gov/LATEST/search-index?" + p;
  const r = await json(url, { timeoutMs: 20000 });
  const hits = r.data?.hits?.hits || [];
  return { source: "SEC EDGAR full-text search", url: `https://efts.sec.gov/LATEST/search-index?${p}`, status: r.status, total: r.data?.hits?.total?.value || 0,
    records: hits.map(h => {
      const s = h._source || {};
      const [adsh, file] = h._id.split(":");
      const cik = (s.ciks || [""])[0].replace(/^0+/, "");
      return { id: adsh, name: (s.display_names || [""])[0].replace(/\s*\(CIK.*$/, "").trim(), states: s.biz_states || [], locations: s.biz_locations || [],
        date: s.file_date, form: s.form, humanUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}` };
    }) };
}

/* ---------- GitHub organizations ---------- */
async function githubOrgs({ location = "Massachusetts", perPage = 30, page = 1 } = {}) {
  const url = `https://api.github.com/search/users?q=${enc(`type:org location:${location}`)}&sort=joined&order=desc&per_page=${perPage}&page=${page}`;
  const r = await json(url, { accept: "application/vnd.github+json", timeoutMs: 15000 });
  return { source: "GitHub organization search", url, status: r.status, records: (r.data?.items || []).map(i => ({ login: i.login, api: i.url, humanUrl: i.html_url })) };
}
async function githubOrg(login) {
  const url = `https://api.github.com/users/${enc(login)}`;
  const r = await json(url, { accept: "application/vnd.github+json", timeoutMs: 15000 });
  const o = r.data || {};
  return { status: r.status, login, name: o.name || login, blog: o.blog || "", location: o.location || "", bio: o.bio || "", created: o.created_at || "", humanUrl: `https://github.com/${login}` };
}

/* ---------- institutions & nonprofits ---------- */
async function ror(name) {
  const url = `https://api.ror.org/v2/organizations?query=${enc(name)}`;
  const r = await json(url, { timeoutMs: 15000 });
  return { source: "ROR", url, status: r.status, records: (r.data?.items || []).slice(0, 10).map(x => ({
    id: x.id, names: (x.names || []).map(n => n.value), domains: x.domains || [],
    display: (x.names || []).find(n => (n.types || []).includes("ror_display"))?.value || x.names?.[0]?.value || "", city: x.locations?.[0]?.geonames_details?.name || "",
    region: x.locations?.[0]?.geonames_details?.country_subdivision_name || "", lat: x.locations?.[0]?.geonames_details?.lat, lng: x.locations?.[0]?.geonames_details?.lng,
    types: x.types || [], humanUrl: x.id })) };
}
async function openalex(name) {
  const url = `https://api.openalex.org/institutions?search=${enc(name)}&per-page=3&mailto=atlas-weave@users.noreply.github.com`;
  const r = await json(url, { timeoutMs: 15000 });
  return { source: "OpenAlex", url, status: r.status, records: (r.data?.results || []).map(x => ({
    id: x.id, name: x.display_name, ror: x.ror, city: x.geo?.city || "", region: x.geo?.region || "", works: x.works_count, humanUrl: x.id })) };
}
async function openalexByRor(rorId) {
  const id = String(rorId || "").replace("https://ror.org/", "");
  const url = `https://api.openalex.org/institutions/ror:${enc(id)}?mailto=atlas-weave@users.noreply.github.com`;
  const r = await json(url, { timeoutMs: 15000 });
  const x = r.data;
  return { source: "OpenAlex", url, status: r.status, record: x && x.id ? { id: x.id, name: x.display_name, city: x.geo?.city || "", works: x.works_count, cited: x.cited_by_count, humanUrl: x.id } : null };
}
async function usaspendingKeyword(keyword, recipient) {
  const url = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
  const body = { filters: { keywords: [keyword], recipient_search_text: [recipient], award_type_codes: ["02", "03", "04", "05"] },
    fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Description", "Start Date", "generated_internal_id"], limit: 10 };
  const r = await json(url, { method: "POST", body, timeoutMs: 20000 });
  return { source: "USAspending.gov (grants)", url: `https://www.usaspending.gov/search/?hash=&keyword=${enc(keyword)}`, status: r.status,
    records: (r.data?.results || []).map(x => ({ id: x["Award ID"], name: x["Recipient Name"], amount: x["Award Amount"], agency: x["Awarding Agency"], description: x.Description || "", date: x["Start Date"], humanUrl: `https://www.usaspending.gov/award/${x.generated_internal_id}` })) };
}
async function propublica(name) {
  const url = `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${enc(name)}&state%5Bid%5D=MA`;
  const r = await json(url, { timeoutMs: 15000 });
  return { source: "ProPublica Nonprofit Explorer (IRS 990)", url, status: r.status, records: (r.data?.organizations || []).slice(0, 10).map(x => ({
    ein: x.ein, name: x.name, city: x.city, state: x.state, ntee: x.ntee_code, humanUrl: `https://projects.propublica.org/nonprofits/organizations/${x.ein}` })) };
}

module.exports = { normName, census, nsfAwards, nihSbir, usaspending, usaspendingKeyword, edgarFormD, githubOrgs, githubOrg, ror, openalex, openalexByRor, propublica };
