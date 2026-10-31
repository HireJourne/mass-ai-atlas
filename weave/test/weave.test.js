/* Offline tests for Atlas Weave:  node --test weave/test/weave.test.js */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const yaml = require("js-yaml");
const { findAddresses, normStreet, htmlToText } = require("../lib/text");
const { editEntry, FILE } = require("../lib/yamledit");
const { mentions, hostIndex } = require("../matchmaker");
const nova = require("../nova");

test("finds a Massachusetts street address with a verbatim quote", () => {
  const text = htmlToText("<footer><p>Visit us</p><address>32 Vassar St, Cambridge MA 02139</address></footer>");
  const [a] = findAddresses(text);
  assert.equal(a.number, "32");
  assert.equal(normStreet(a.street), "vassar st");
  assert.equal(a.city, "Cambridge");
  assert.ok(a.ma);
  assert.ok(text.includes(a.verbatim), "quote must be a substring of the page text");
});

test("Street and St normalize to the same street", () => {
  assert.equal(normStreet("Vassar Street"), normStreet("Vassar St."));
});

const DATA = [
  { id: "a", name: "Alpha Lab", url: "https://alpha.org" },
  { id: "deltav", name: "MIT delta v", url: "https://entrepreneurship.mit.edu/accelerator" },
  { id: "trust", name: "Martin Trust Center", url: "https://entrepreneurship.mit.edu" },
  { id: "walnut", name: "Walnut Venture Associates", url: "https://www.linkedin.com/company/walnut-ventures" },
  { id: "mc", name: "MassChallenge", url: "https://masschallenge.org" },
  { id: "mch", name: "MassChallenge HealthTech", url: "https://masschallenge.org/healthtech" },
];
const page = (text, links = []) => ({ url: "https://alpha.org/", text, links: links.map(h => ({ href: h, host: new URL(h).hostname.replace(/^www\./, ""), text: "" })), jsonLd: [] });

test("a link resolves to the entry with the longest matching url path", () => {
  const { found } = mentions([page("", ["https://entrepreneurship.mit.edu/accelerator/apply"])], DATA[0], DATA, hostIndex(DATA));
  assert.deepEqual([...found.keys()], ["deltav"]);
});

test("a generic platform link (LinkedIn) does not match an entry whose url is a LinkedIn page", () => {
  const { found } = mentions([page("", ["https://www.linkedin.com/company/alpha-lab"])], DATA[0], DATA, hostIndex(DATA));
  assert.equal(found.size, 0);
});

test("the longer name claims its span: MassChallenge HealthTech is not also MassChallenge", () => {
  const { found } = mentions([page("We are proud alumni of MassChallenge HealthTech.")], DATA[0], DATA, hostIndex(DATA));
  assert.deepEqual([...found.keys()], ["mch"]);
});

test("editEntry changes only the target entry and keeps CRLF line endings", () => {
  const src = fs.readFileSync(FILE, "utf8");
  const [first] = yaml.load(src);
  const out = editEntry(src, first.id, [["links", [...(first.links || []), "medialab"], ["stages"]]]);
  const A = yaml.load(src), B = yaml.load(out);
  assert.equal(A.length, B.length);
  assert.deepEqual(B[0].links, [...(first.links || []), "medialab"]);
  assert.deepEqual(A.slice(1), B.slice(1));
  assert.equal(src.includes("\r\n"), out.includes("\r\n"));
});

test("approve and commit refuse to run without a named reviewer", async () => {
  await assert.rejects(() => nova.approve("anything", ""), /reviewer is required/);
  await assert.rejects(() => nova.approve("anything", "   "), /reviewer is required/);
  assert.throws(() => nova.commit(""), /reviewer is required/);
});

test("de-duplication: exact name, shared website, fuzzy overlap, and net-new", () => {
  const { dedupe, index } = require("../dedupe");
  const DATA = nova.loadDATA();
  const idx = index(DATA);
  const cfs = DATA.find(d => d.id === "commonwealth-fusion");
  assert.equal(dedupe({ name: "COMMONWEALTH FUSION SYSTEMS LLC" }, idx).status, "match");
  assert.equal(dedupe({ name: "Totally Different Name", url: cfs.url }, idx).entry.id, "commonwealth-fusion");
  assert.equal(dedupe({ name: "Commonwealth Fusion" }, idx).status, "possible");
  assert.equal(dedupe({ name: "Zyxwv Quantum Widgets Inc" }, idx).status, "new");
  assert.notEqual(dedupe({ name: "Some Co", url: "https://www.linkedin.com/company/some-co" }, idx).status, "match", "shared platform hosts prove nothing");
});

test("appendEntry adds exactly one schema-valid entry and keeps line endings", () => {
  const { appendEntry } = require("../lib/yamledit");
  const src = fs.readFileSync(FILE, "utf8");
  const e = { id: "zz-test-org", name: "ZZ Test Org", cat: "startup", loc: "1 Main St, Worcester", lat: 42.26, lng: -71.8, url: "https://example.org", desc: "Test: an entry, with commas.", offers: ["talent"], added: "2026-10" };
  assert.deepEqual(nova.validateEntry(e), []);
  const out = appendEntry(src, e);
  const A = yaml.load(src), B = yaml.load(out, { schema: yaml.CORE_SCHEMA });
  assert.equal(B.length, A.length + 1);
  assert.deepEqual(B[B.length - 1], e);
  assert.equal(src.includes("\r\n"), out.includes("\r\n"));
});

test("probes are computed for HEAD, approved, and staged", () => {
  const p = nova.probes();
  assert.equal(p.rows.length, 10);
  for (const r of p.rows) for (const k of ["before", "committed", "after", "preview"]) assert.equal(typeof r[k], "number");
});

test("the sandbox preview applies proposals in memory and never touches the file", () => {
  const { preview } = require("../lib/apply");
  const before = fs.readFileSync(FILE, "utf8");
  const DATA = nova.loadDATA();
  const a = DATA.find(d => !(d.links || []).length);
  const b = DATA.find(d => d.id !== a.id);
  const out = preview(DATA, [{ id: "x", entity: a.id, op: "addLink", after: b.id }]);
  assert.deepEqual(out.DATA.find(d => d.id === a.id).links, [b.id]);
  assert.deepEqual(DATA.find(d => d.id === a.id).links, a.links, "input is not mutated");
  assert.equal(fs.readFileSync(FILE, "utf8"), before);
});

test("visibility counts stage-filtered searches an entry without stages misses", () => {
  const d = nova.loadDATA().find(x => !(x.stages || []).length);
  const v = nova.visibility(d.id);
  assert.ok(v.invisiblePct > 0);
  assert.ok(v.missing.some(m => m.field === "stages"));
});

test("check sizes ignore follow-on rights and accept a stated typical check", () => {
  const { findCheckSizes } = require("../fields");
  const found = findCheckSizes({ url: "u", text: "We have the right to invest up to an additional $500K. We typically invest $250K to $1M in seed rounds." });
  assert.deepEqual(found.map(f => f.value), ["$250K–$1M"]);
});

test("deadlines need a deadline cue and a future date", () => {
  const { findDeadlines } = require("../fields");
  const f = findDeadlines({ url: "u", text: "The application deadline is March 3, 2027. Demo day is May 1, 2027. Deadline was June 1, 2025." }, "2026-10-31");
  assert.deepEqual(f.map(x => x.value), ["2027-03-03"]);
});

test("tiered names: parent prefixes and suffixes are stripped, generic leftovers are not searched alone", () => {
  const { shortName } = require("../corroborate");
  assert.equal(shortName("MIT Jameel Clinic"), "jameel clinic");
  assert.equal(shortName("Harvard Innovation Labs"), "innovation labs");
  assert.equal(shortName("Commonwealth Fusion Systems, Inc."), "commonwealth fusion systems");
  assert.equal(shortName("UMass Amherst CIIR"), "ciir");
});

test("calendar .ics is valid RFC 5545 shape and never includes past dates", () => {
  const CAL = require("../calendar");
  const ics = CAL.ics({ DATA: nova.loadDATA() });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.ok(ics.split("\r\n").every(l => l.length <= 75), "lines folded");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const m of ics.matchAll(/DTSTART(?:;VALUE=DATE)?:(\d{8})/g)) assert.ok(m[1] >= today, `no past date (${m[1]})`);
});
