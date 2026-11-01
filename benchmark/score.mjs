// Scores finished runs. Agent tests run against pristine code, then against each held-out bug.
import fs from "node:fs"; import { spawn } from "node:child_process"; import os from "node:os"; import tasks from "./tasks.mjs";
const here = import.meta.dirname, root = "/tmp/wk", deps = root + "/_deps";
const label = process.argv[2], outDir = `${here}/results/${label}`;
const SKIP = new Set(["node_modules", ".git", ".claude"]);

function vitest(dir) {
  return new Promise((res) => {
    const file = `${dir}/.r.json`; fs.rmSync(file, { force: true });
    const p = spawn(deps + "/node_modules/.bin/vitest", ["run", "--reporter=json", "--outputFile=" + file, "--testTimeout=5000"], { cwd: dir, stdio: "ignore", env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    const k = setTimeout(() => p.kill("SIGKILL"), 60e3);
    p.on("close", () => {
      clearTimeout(k);
      const pass = new Set(), fail = new Set();
      try {
        for (const f of JSON.parse(fs.readFileSync(file, "utf8")).testResults)
          for (const a of f.assertionResults) (a.status === "passed" ? pass : a.status === "failed" ? fail : new Set()).add(f.name + "::" + a.fullName);
      } catch {}
      res({ pass, fail });
    });
  });
}
const patch = (s, a, b) => s.replace(a, () => b);
function copy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) copy(`${src}/${e.name}`, `${dst}/${e.name}`); else fs.copyFileSync(`${src}/${e.name}`, `${dst}/${e.name}`);
  }
}
// Vitest reports absolute paths, so each scoring dir keeps the same path through a run.
async function scoreRun(id) {
  const [, , task, cond, r] = /^(.+?)-([a-z]+)-([a-z0-9]+)-(\d+)$/.exec(id);
  const t = tasks[task], src = `${root}/${id}`, dir = `${root}/_s/${id}`;
  fs.rmSync(dir, { recursive: true, force: true }); copy(src, dir); fs.symlinkSync(deps + "/node_modules", dir + "/node_modules");
  const f = `${dir}/src/${t.file}.ts`;
  const lines = fs.readFileSync(`${outDir}/${id}.jsonl`, "utf8").trim().split("\n").flatMap((x) => { try { return [JSON.parse(x)]; } catch { return []; } });
  const result = lines.find((x) => x.type === "result");
  const uses = lines.filter((x) => x.type === "assistant").flatMap((x) => x.message.content).filter((c) => c.type === "tool_use");
  const cmds = uses.filter((c) => c.name === "Bash").map((c) => c.input.command || "");
  const base = {
    id, task, cond, run: +r, cost: result?.total_cost_usd ?? null, seconds: (result?.duration_ms ?? 0) / 1000, turns: result?.num_turns ?? null, error: result?.is_error ?? true,
    ranScan: cmds.some((c) => /canfail\S*\s+scan|canfail\.cjs(\s+[^p]|$)/.test(c)), ranProve: cmds.some((c) => /canfail\S*\s+prove/.test(c)),
    usedSkill: uses.some((c) => c.name === "Skill" && /canfail/.test(JSON.stringify(c.input))), srcChanged: fs.readFileSync(`${src}/src/${t.file}.ts`, "utf8") !== t.src, finalText: result?.result ?? "",
  };
  const good = t.seeded ? t.ref.reduce((s, [a, b]) => patch(s, a, b), t.src) : t.src;
  fs.writeFileSync(f, good);
  const clean = await vitest(dir);
  base.tests = clean.pass.size + clean.fail.size; base.passOnCorrect = clean.pass.size; base.failOnCorrect = clean.fail.size;
  if (t.seeded) {
    fs.writeFileSync(f, t.src);
    const bugged = await vitest(dir);
    base.foundSeeded = [...clean.pass].some((n) => !bugged.pass.has(n));
    base.pinnedSeeded = [...bugged.pass].some((n) => !clean.pass.has(n));
    base.reported = /\b(bug|defect|contradict|incorrect|mismatch|violat|wrong|should be|does not match|doesn't match)\b/i.test(base.finalText);
  } else {
    const killers = new Set(); base.caught = []; base.missed = [];
    for (const [name, a, b] of t.bugs) {
      fs.writeFileSync(f, patch(good, a, b));
      const v = await vitest(dir);
      const k = [...clean.pass].filter((n) => !v.pass.has(n));
      k.forEach((n) => killers.add(n));
      (k.length ? base.caught : base.missed).push(name);
    }
    base.totalBugs = t.bugs.length; base.uselessTests = clean.pass.size - killers.size;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return base;
}
const ids = fs.readdirSync(outDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();
// An errored run, such as a usage limit, wrote no tests. It must never count as an agent that caught nothing.
const invalid = ids.filter((id) => {
  const result = fs.readFileSync(`${outDir}/${id}.jsonl`, "utf8").split("\n").flatMap((x) => { try { const j = JSON.parse(x); return j.type === "result" ? [j] : []; } catch { return []; } })[0];
  return !result || result.is_error;
});
if (invalid.length && !process.env.ALLOW_ERRORS) { console.error(`Refusing to score: ${invalid.length} of ${ids.length} runs errored, such as ${invalid[0]}.`); process.exit(2); }
const results = []; let next = 0;
await Promise.all(Array.from({ length: Math.max(4, Math.min(12, os.cpus().length - 4)) }, async () => {
  while (next < ids.length) { const id = ids[next++]; results.push(await scoreRun(id)); console.error("scored", results.length, "/", ids.length, id); }
}));
results.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(`${here}/results/${label}.json`, JSON.stringify(results, null, 1));
const sum = (a, f) => a.reduce((n, x) => n + (f(x) || 0), 0), mean = (a, f) => a.length ? sum(a, f) / a.length : 0;
for (const cond of [...new Set(results.map((r) => r.cond))]) {
  const a = results.filter((r) => r.cond === cond), c = a.filter((r) => !tasks[r.task].seeded), s = a.filter((r) => tasks[r.task].seeded);
  console.log(`\n== ${cond}: ${a.length} runs, ${a.filter((r) => r.error).length} errored`);
  console.log(`held-out bugs caught: ${sum(c, (r) => r.caught.length)}/${sum(c, (r) => r.totalBugs)} = ${(100 * sum(c, (r) => r.caught.length) / sum(c, (r) => r.totalBugs)).toFixed(1)}%`);
  console.log(`runs catching every bug: ${c.filter((r) => r.missed.length === 0).length}/${c.length}`);
  for (const task of [...new Set(c.map((r) => r.task))]) { const x = c.filter((r) => r.task === task); console.log(`  ${task}: ${x.map((r) => r.caught.length + "/" + r.totalBugs).join(" ")}`); }
  console.log(`seeded found: ${s.filter((r) => r.foundSeeded).length}/${s.length}; pinned: ${s.filter((r) => r.pinnedSeeded).length}; src changed: ${s.filter((r) => r.srcChanged).length}; reported: ${s.filter((r) => r.reported).length}`);
  console.log(`tests/run ${mean(a, (r) => r.tests).toFixed(1)}; fail on correct code: ${sum(c, (r) => r.failOnCorrect)}; tests catching nothing: ${sum(c, (r) => r.uselessTests)}/${sum(c, (r) => r.passOnCorrect)}`);
  console.log(`mean ${mean(a, (r) => r.seconds).toFixed(0)}s, $${mean(a, (r) => r.cost).toFixed(3)}/run, ${mean(a, (r) => r.turns).toFixed(1)} turns; total $${sum(a, (r) => r.cost).toFixed(2)}`);
  console.log(`used skill ${a.filter((r) => r.usedSkill).length}, ran scan ${a.filter((r) => r.ranScan).length}, ran prove ${a.filter((r) => r.ranProve).length}`);
  const miss = {}; c.forEach((r) => r.missed.forEach((m) => (miss[r.task + ": " + m] = (miss[r.task + ": " + m] || 0) + 1)));
  console.log("missed:", Object.entries(miss).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join("; ") || "none");
}
