#!/usr/bin/env node
/* Atlas Weave CLI
     node weave/cli.js survey <id> [<id> ...]     run Scout + Matchmaker live
     node weave/cli.js batch [N] [--zero-edge]    survey N entries (default 10)
     node weave/cli.js queue                      list pending proposals
     node weave/cli.js approve <proposalId> --reviewer "Name" [--note "..."]
     node weave/cli.js reject  <proposalId> --reviewer "Name" [--note "..."]
     node weave/cli.js refusals                   what the system refused to do
     node weave/cli.js probes                     the 7 probes, before → after
     node weave/cli.js manifest <id>              draft .well-known/mass-ai-atlas.json
     node weave/cli.js visibility <id>            give-to-get visibility score
     node weave/cli.js stage|unstage <proposalId> sandbox: preview without writing
     node weave/cli.js undo <proposalId>          undo a sandbox decision
     node weave/cli.js commit --reviewer "Name"   write every sandbox-approved proposal to entities.yml
     node weave/cli.js backup | backups | restore <name> | reset
     node weave/cli.js radar                      MA company radar (NSF, NIH, EDGAR, GitHub) + de-dup
     node weave/cli.js brief                      write CONCEPT_BRIEF.md
     node weave/cli.js validate                   run scripts/validate.js
     node weave/cli.js serve [port]               start the dashboard (default 4848) */
const W = require("./index");
const store = require("./lib/store");

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const VALUED = new Set(["--reviewer", "--note", "--concurrency"]);
const positional = rest.filter((a, i) => !a.startsWith("--") && !VALUED.has(rest[i - 1]));

function printSurvey(r) {
  console.log(`\n■ ${r.name} (${r.entity}) — ${r.url}`);
  for (const s of r.scout.signals) console.log(`  · ${s.kind}: ${s.detail}`);
  for (const p of r.proposals) {
    console.log(`  ✚ PROPOSAL ${p.id} [${p.module}] ${p.summary}`);
    console.log(`      source:  ${p.evidence.source_url}\n      quote:   "${p.evidence.quote}"`);
    console.log(`      2nd src: ${p.corroboration.kind} — ${p.corroboration.source_url}`);
  }
  for (const f of r.refusals) console.log(`  ✗ REFUSED [${f.module}] ${f.field}: ${f.reason}`);
}

async function main() {
  switch (cmd) {
    case "survey":
      if (!positional.length) throw new Error("usage: survey <id> [<id> ...]");
      for (const id of positional) printSurvey(await W.surveyOne(id));
      break;
    case "batch": {
      const n = positional[0] === "all" ? Infinity : Number(positional[0]) || 10;
      const conc = Number(flag("concurrency")) || 4;
      let DATA = W.loadDATA();
      if (rest.includes("--zero-edge")) DATA = DATA.filter(d => !(d.links || []).length);
      // Biggest gaps first: no links, no stages, then no applyBy/facts.
      const gap = d => (!(d.links || []).length ? 4 : 0) + (!(d.stages || []).length ? 3 : 0) + (!d.applyBy ? 1 : 0) + (!d.facts ? 1 : 0);
      const queue = DATA.slice().sort((a, b) => gap(b) - gap(a)).slice(0, n);
      let done = 0;
      const worker = async () => {
        while (queue.length) {
          const d = queue.shift();
          try { printSurvey(await W.surveyOne(d.id)); }
          catch (e) { console.log(`\n■ ${d.id}: error ${e.message}`); }
          console.log(`  [${++done}]`);
        }
      };
      await Promise.all(Array.from({ length: conc }, worker));
      const P = store.read("proposals"), R = store.read("refusals");
      console.log(`\nQueue: ${P.filter(p => p.status === "pending").length} pending proposals · ${R.length} refusals logged`);
      printProbes();
      break;
    }
    case "queue": {
      const q = store.read("proposals").filter(p => p.status === "pending");
      if (!q.length) console.log("Queue is empty.");
      for (const p of q) console.log(`${p.id}  ${p.entity.padEnd(22)} ${p.field.padEnd(12)} ${p.summary}`);
      break;
    }
    case "approve": case "reject": {
      const r = await W[cmd](positional[0], flag("reviewer"), flag("note") || "");
      console.log(`${cmd === "approve" ? "approved in sandbox (not committed)" : "rejected"}: ${r.proposal.id} (${r.proposal.summary}) by ${r.proposal.reviewer}`);
      break;
    }
    case "refusals":
      for (const f of store.read("refusals")) console.log(`✗ ${f.entity.padEnd(22)} [${f.module}] ${f.field}: ${f.reason}${f.source_url ? `\n    ${f.source_url}` : ""}`);
      break;
    case "probes": printProbes(); break;
    case "manifest": console.log(JSON.stringify(W.draftManifest(positional[0]), null, 2)); break;
    case "brief": console.log(`wrote ${require("./judge").brief().path}`); break;
    case "stage": case "unstage": for (const id of positional) console.log(`${cmd}d ${W.setStaged(id, cmd === "stage").proposal.summary}`); break;
    case "undo": console.log(`undone: ${W.undo(positional[0]).proposal.summary}`); break;
    case "backup": console.log(`backup ${W.makeBackup("cli")}`); break;
    case "backups": W.listBackups().forEach(b => console.log(b.name)); break;
    case "restore": console.log(JSON.stringify(W.restoreBackup(positional[0]), null, 2)); break;
    case "reset": console.log(JSON.stringify(W.resetSandbox())); break;
    case "radar": { const o = await require("./radar").run({ log: m => console.log(m) }); console.log(`${o.candidates.length} new candidates · ${o.matched.length} matched · ${o.possible.length} possible duplicates · ${o.refusals} refusals`); break; }
    case "commit": { const r = W.commit(flag("reviewer")); r.results.forEach(x => console.log(`${x.ok ? "✓" : "✗"} ${x.summary}${x.error ? " — " + x.error : ""}`)); console.log(r.validation.output.trim().split("\n").pop()); break; }
    case "visibility": console.log(JSON.stringify(W.visibility(positional[0]), null, 2)); break;
    case "validate": { const v = W.runValidate(); console.log(v.output); process.exitCode = v.code; break; }
    case "serve": require("./server").start(Number(positional[0]) || 4848); break;
    default: console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace("#!/usr/bin/env node\n/* ", ""));
  }
}

function printProbes() {
  const p = W.probes();
  console.log(`\nProbes  before (${p.baseline}) · committed (entities.yml) · after (+${p.acceptedCount} approved in sandbox) · preview (+${p.stagedCount} staged)`);
  for (const r of p.rows) console.log(`  ${r.label.padEnd(64)} ${[r.before, r.committed, r.after, r.preview].map(v => String(v).padStart(4)).join("  ")}`);
}

main().catch(e => { console.error("Error:", e.message); if (e.validation) console.error(e.validation.output); process.exit(1); });
