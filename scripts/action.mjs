// The GitHub Action: runs canfail on the lines a pull request changes, then reports the result.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../skills/canfail/scripts/canfail.cjs");
const input = (name) => process.env[`INPUT_${name}`] ?? "";
const since = input("SINCE") || (process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : "");
if (!since) {
  console.error("canfail: no ref to compare with. Set the since input, or run on a pull request.");
  process.exit(2);
}

const args = ["--since", since, "--cmd", input("CMD") || "npm test", "--bugs", input("BUGS") || "10", "--min-score", input("MIN_SCORE") || "100", "--jobs", input("JOBS") || "1", "--json"];
const run = spawnSync("node", [cli, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
if (run.stderr) process.stderr.write(run.stderr);
if (run.status === 2 || !run.stdout) process.exit(run.status ?? 2);

const { scan, prove } = JSON.parse(run.stdout);
const findings = (scan?.files ?? []).flatMap((f) => f.findings.map((x) => ({ ...x, file: path.relative(process.cwd(), f.file) })));
const survivors = (prove?.results ?? []).filter((r) => r.status === "survived" || r.status === "uncovered");
const cell = (text) => `\`${String(text).replaceAll("|", "\\|").replaceAll("`", "'")}\``;
const out = ["## Inspector Canfail", ""];
out.push(run.status === 0 ? "✅ The check passed." : "❌ The check failed.", "");
if (scan) out.push(`**Scan:** ${scan.tests} tests in the changed test files. ${scan.errors} errors, ${scan.warnings} warnings.`, "");
if (prove) {
  out.push(`**Prove:** the tests caught ${prove.caught} of ${prove.caught + prove.survived + prove.uncovered} mutations on the changed lines (${prove.score}%).`);
  if (prove.crashed) out.push(`${prove.crashed} runs failed with no failed test, and are not in the score.`);
  if (prove.unreached.length) out.push(`No test loads: ${prove.unreached.map((f) => cell(path.relative(process.cwd(), f))).join(", ")}.`);
  out.push("");
} else {
  out.push("**Prove:** no changed source file that the tests load.", "");
}
if (findings.length) {
  out.push("| Test file | Line | Rule | Finding |", "|---|---:|---|---|");
  for (const f of findings.slice(0, 20)) out.push(`| ${cell(f.file)} | ${f.line} | ${f.rule} | ${f.message.replaceAll("|", "\\|")} |`);
  out.push("");
}
if (survivors.length) {
  out.push("| Source | Line | Mutation | What to check |", "|---|---:|---|---|");
  for (const r of survivors.slice(0, 20)) out.push(`| ${cell(path.relative(process.cwd(), r.file))} | ${r.line} | ${cell(r.after)} | ${r.hint} |`);
  out.push("", "Check if each one changes required behavior. Add a test only if it does.", "");
}
const body = out.join("\n");
console.log(body);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
if (input("COMMENT") === "true" && process.env.PR_NUMBER) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "canfail-")), "comment.md");
  writeFileSync(file, body);
  const comment = spawnSync("gh", ["pr", "comment", process.env.PR_NUMBER, "--body-file", file, "--edit-last", "--create-if-none"], { stdio: "inherit" });
  if (comment.status !== 0) console.error("canfail: could not add the comment. Does the job have pull-requests write permission?");
}
process.exit(run.status);
