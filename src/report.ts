import path from "node:path";
import type { MutantResult, ProveResult, Baseline } from "./prove.js";
import { RULES, type ScanResult } from "./scan.js";

const useColor = () =>
  process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : !process.env.NO_COLOR && !!process.stdout.isTTY;
const paint = (code: string) => (s: string | number) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  cyan: paint("36"),
  redBold: paint("1;31"),
  greenBold: paint("1;32"),
};

const rel = (cwd: string, file: string) => path.relative(cwd, file) || file;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatScan(result: ScanResult, cwd: string): string {
  const out: string[] = [];
  out.push(`${c.bold("canfail scan")}  ${c.dim(`${plural(result.files.length, "file")} · ${plural(result.tests, "test")}`)}`);
  out.push("");
  for (const file of result.files) {
    if (file.findings.length === 0) continue;
    out.push(`  ${c.bold(rel(cwd, file.file))}`);
    const shown = new Map<string, number>();
    const hidden = new Map<string, number[]>();
    for (const f of file.findings) {
      const count = shown.get(f.rule) ?? 0;
      if (count >= 3) {
        hidden.set(f.rule, [...(hidden.get(f.rule) ?? []), f.line]);
        continue;
      }
      shown.set(f.rule, count + 1);
      const where = `${f.line}:${f.column}`.padEnd(7);
      const sev = f.severity === "error" ? c.red("error") : c.yellow("warn ");
      out.push(`    ${c.dim(where)} ${sev}  ${f.rule.padEnd(22)} ${f.message}`);
    }
    for (const [rule, lines] of hidden) {
      const list = lines.slice(0, 8).join(", ") + (lines.length > 8 ? ", …" : "");
      out.push(`    ${" ".repeat(7)} ${c.dim(`… ${lines.length} more ${rule} (lines ${list})`)}`);
    }
    out.push("");
  }
  if (result.errors === 0 && result.warnings === 0) {
    out.push(`  ${c.greenBold("✓")} ${c.bold(`No fake tests found in ${plural(result.tests, "test")}.`)}`);
  } else {
    const mark = result.fake > 0 ? c.redBold("✖") : c.yellow("!");
    const parts = [result.fake > 0 && `${result.fake} can't fail`, result.weak > 0 && `${result.weak} ${result.weak === 1 ? "is" : "are"} weak`];
    out.push(
      `  ${mark} ${c.bold(`${result.fake + result.weak} of ${plural(result.tests, "test")} are suspect:`)} ${parts.filter(Boolean).join(", ")}.`,
    );
    if (result.errors > 0) out.push(`    ${c.dim("Run `canfail rules` to see how to fix each rule.")}`);
  }
  return out.join("\n");
}

export function formatProveHeader(files: string[], bugs: number | "all", cmd: string, source: string, cwd: string): string {
  const what = files.length === 1 ? rel(cwd, files[0]) : plural(files.length, "file");
  const count = bugs === "all" ? "every bug" : plural(bugs, "bug");
  return `${c.bold("canfail prove")}  ${c.dim(`plant ${count} in ${what} ${source}· run \`${cmd}\``)}\n`;
}

export function formatBaseline(b: Baseline): string {
  const tests = b.passed === null ? "Tests pass" : `${plural(b.passed, "test")} pass`;
  return `  ${c.green("✓")} ${c.dim("baseline")}   ${tests} ${c.dim(`in ${seconds(b.durationMs)}, with no bug planted`)}\n`;
}

export function formatResult(r: MutantResult, cwd: string): string {
  const where = `${rel(cwd, r.file)}:${r.line}`;
  if (r.status === "survived") {
    return [
      `  ${c.red("✗")} ${c.redBold("survived")}   ${where}  ${c.dim(r.operator)}`,
      `               ${c.red(`- ${r.before}`)}`,
      `               ${c.green(`+ ${r.after}`)}`,
    ].join("\n");
  }
  if (r.status === "uncovered") {
    return [
      `  ${c.red("✗")} ${c.redBold("uncovered")}  ${where}  ${c.dim(`${r.operator}: the coverage report says no test runs this line`)}`,
    ].join("\n");
  }
  if (r.status === "crashed") {
    return `  ${c.yellow("!")} ${c.yellow("crashed")}    ${where}  ${c.dim(`${r.operator}: ${change(r)} (no test failed, not in the score)`)}`;
  }
  const label = r.status === "timeout" ? "caught (timeout)" : "caught";
  return `  ${c.green("✓")} ${c.green(label.padEnd(8))}   ${where}  ${c.dim(`${r.operator}: ${change(r)}`)}`;
}

function change(r: MutantResult): string {
  if (r.operator === "remove-call" || r.replacement === "") return `removed \`${clip(r.original)}\``;
  return `\`${clip(r.original)}\` → \`${clip(r.replacement)}\``;
}

const clip = (s: string, max = 40) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function formatProveSummary(result: ProveResult, cwd = process.cwd()): string {
  const { caught, crashed, uncovered, timedOut, survived, unreached, baseline } = result;
  const total = caught + survived + uncovered;
  const who = baseline.passed === null ? "Your tests" : `Your ${baseline.passed} passing tests`;
  const line = `${who} caught ${caught} of ${plural(total, "planted bug")}.`;
  const score = `Score: ${result.score}%`;
  const notes = [
    timedOut > 0 && `${timedOut} of the caught ${timedOut === 1 ? "bug is a timeout" : "bugs are timeouts"}, not a failed test.`,
    crashed > 0 && `${crashed} more ${crashed === 1 ? "run" : "runs"} failed with no failed test, as with a compile error. Not in the score.`,
    uncovered > 0 && `${uncovered} planted ${uncovered === 1 ? "bug is" : "bugs are"} on lines with no test coverage.`,
    unreached.length > 0 && `No test loads ${unreached.map((f) => rel(cwd, f)).join(", ")}. Not in the score.`,
  ].filter((n): n is string => !!n);
  const ok = caught === total && unreached.length === 0;
  return [
    "",
    `  ${ok ? c.greenBold("✓") : c.redBold("✖")} ${c.bold(line)} ${c.dim(score)}`,
    ...notes.map((n) => `    ${c.yellow(n)}`),
    ...(survived + uncovered > 0 ? [`    ${c.dim("For each survivor, check if it changes required behavior. If it does, add a test that fails on it.")}`] : []),
    "",
  ].join("\n");
}

export function formatRules(): string {
  const out = [c.bold("canfail rules"), ""];
  for (const [id, rule] of Object.entries(RULES)) {
    const sev = rule.severity === "error" ? c.red("error") : c.yellow("warn ");
    out.push(`  ${sev}  ${c.bold(id)}`);
    out.push(`         ${rule.summary}`);
    out.push(`         ${c.green("Fix:")} ${rule.fix}`);
    out.push("");
  }
  out.push(c.dim("  Silence one finding with a comment on the line, or the line above: // canfail-ignore <rule>"));
  return out.join("\n");
}
