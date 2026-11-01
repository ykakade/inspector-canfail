#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { expand, gitChanged, gitChangedSince, inTestDir, isSourceFile, isTestFile, lcovUncovered, resolveImport, walkDir } from "./files.js";
import { NothingToProve, prove, ProveError, recover, type ProveResult } from "./prove.js";
import { c, formatBaseline, formatProveHeader, formatProveSummary, formatResult, formatRules, formatScan } from "./report.js";
import { scanSource, summarize, type ScanResult } from "./scan.js";

const VERSION = "0.2.0";

const HELP = `${c.bold("canfail")} ${c.dim(VERSION)}  Catch tests that can't fail.

${c.bold("Usage")}
  canfail [test paths]        scan, then prove
  canfail scan [test paths]   find tests that can't fail. Static, no test run.
  canfail prove [src paths]   plant bugs in source files, run the tests, count the catches
  canfail rules               list the scan rules and how to fix each one
  canfail restore             put back source files after a killed --in-place run
  canfail demo                see a fake test and a real test, no project needed

${c.bold("Options")}
  --cmd <command>      test command (default: npm test). {file} becomes the mutated file
  --files <a,b,...>    source files for prove (default: changed files the tests reach,
                       else the files the tests import)
  --bugs <n|all>       how many bugs to plant (default: 10)
  --seed <n>           pick a different set of bugs (default: 1)
  --timeout <ms>       time limit per test run (default: 3x baseline, at least 10s)
  --min-score <0-100>  pass when at least this % of bugs are caught (default: 100)
  --since <ref>        only changed test files, and bugs only on lines changed since <ref>
  --lcov <file>        a coverage report: bugs on lines no test runs need no test run
  --jobs <n>           test runs at the same time, each in its own copy (default: 1)
  --in-place           edit the real files, not a temporary copy of the project
  --json               print JSON for tools and agents
  -h, --help           show this help
  -v, --version        show the version

${c.bold("Exit codes")}
  0  no fake tests found, and every planted bug was caught
  1  fake tests found, or a planted bug survived
  2  canfail could not run (bad option, failing or flaky baseline, no test files)
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cmd: { type: "string" },
      files: { type: "string" },
      bugs: { type: "string", default: "10" },
      seed: { type: "string", default: "1" },
      timeout: { type: "string" },
      "min-score": { type: "string", default: "100" },
      since: { type: "string" },
      lcov: { type: "string" },
      jobs: { type: "string", default: "1" },
      "in-place": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return print(HELP), 0;
  if (values.version) return print(VERSION), 0;

  const cwd = process.cwd();
  const commands = ["scan", "prove", "rules", "restore", "hook", "stop-hook", "demo"];
  const command = commands.includes(positionals[0]) ? positionals.shift()! : "all";

  if (command === "rules") return print(formatRules()), 0;
  if (command === "hook") return hook();
  if (command === "stop-hook") return stopHook();
  if (command === "demo") return demo();
  if (command === "restore") {
    const { restored, kept, corrupt } = recover(cwd);
    const names = (files: string[]) => files.map((f) => path.relative(cwd, f)).join(", ");
    if (restored.length) print(`Restored ${names(restored)}`);
    if (kept.length) print(`Left alone, because they changed after the killed run: ${names(kept)}`);
    if (corrupt) print("The record of the killed run is damaged, so it was deleted. Use git to check your files.");
    if (!restored.length && !kept.length && !corrupt) print("Nothing to restore.");
    return 0;
  }

  const bugs = values.bugs === "all" ? "all" : Number(values.bugs);
  const minScore = Number(values["min-score"]);
  if (bugs !== "all" && !(Number.isInteger(bugs) && bugs > 0)) throw new UsageError("--bugs must be a positive number or 'all'.");
  if (!(minScore >= 0 && minScore <= 100)) throw new UsageError("--min-score must be between 0 and 100.");
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new UsageError("--seed must be a whole number.");
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new UsageError("--timeout must be a positive number of milliseconds.");
  const jobs = Number(values.jobs);
  if (!(Number.isInteger(jobs) && jobs > 0)) throw new UsageError("--jobs must be a positive whole number.");
  if (values["in-place"] && jobs > 1) throw new UsageError("--jobs needs temporary copies, so it can't be used with --in-place.");
  const since = values.since === undefined ? undefined : gitChangedSince(cwd, values.since);

  const json: { scan?: ScanResult; prove?: ProveResult } = {};
  let failed = false;

  // scan
  let testFiles: string[] = [];
  if (command === "scan" || command === "all") {
    testFiles = findTests(positionals, cwd, since);
    if (testFiles.length === 0 && !since) {
      throw new UsageError(positionals.length ? `No test files in: ${positionals.join(" ")}` : "No test files found. Name them: canfail scan tests/");
    }
    const result = summarize(testFiles.map((f) => scanSource(f, readFileSync(f, "utf8"))));
    json.scan = result;
    if (!values.json) print(formatScan(result, cwd) + "\n");
    failed ||= result.errors > 0;
  }

  // prove
  if (command === "prove" || command === "all") {
    const explicit = values.files ? [values.files] : command === "prove" ? positionals : [];
    let found: { files: string[]; source: string };
    if (since && explicit.length === 0) {
      const changed = [...since.keys()].filter((f) => isSourceFile(f) && !IS_CONFIG.test(f));
      const tests = testFiles.length ? testFiles : findTests([], cwd);
      const reachable = importClosure(walkDir(cwd).filter(isTestFile).concat(tests));
      found = { files: changed.filter((f) => reachable.has(f)), source: c.dim(`(changed since ${values.since}) `) };
    } else {
      found = findSources(explicit, testFiles.length ? testFiles : findTests([], cwd), cwd);
    }
    const { files, source } = found;
    if (since && files.length === 0) {
      if (!values.json) print(`  No changed source file that the tests load since ${values.since}. Nothing to prove.`);
    } else {
      const cmd = values.cmd ?? defaultCommand(cwd);
      if (!values.json) print(formatProveHeader(files, bugs, cmd, source, cwd));
      try {
        const result = await prove({
          cwd,
          cmd,
          files,
          bugs,
          seed,
          timeoutMs,
          jobs,
          inPlace: values["in-place"],
          lines: since,
          uncovered: values.lcov ? lcovUncovered(readFileSync(path.resolve(cwd, values.lcov), "utf8"), cwd) : undefined,
          onNotice: (message) => process.stderr.write(`${c.yellow("canfail:")} ${message}\n`),
          onBaseline: (b) => !values.json && print(formatBaseline(b)),
          onResult: (r) => !values.json && print(formatResult(r, cwd)),
        });
        json.prove = result;
        if (!values.json) print(formatProveSummary(result, cwd));
        failed ||= result.score < minScore || result.unreached.length > 0;
      } catch (error) {
        if (!(error instanceof NothingToProve)) throw error;
        if (!values.json) print(`  ${error.message} Nothing to prove.`);
      }
    }
  }

  if (values.json) print(JSON.stringify({ version: VERSION, ...json }, null, 2));
  return failed ? 1 : 0;
}

function findTests(targets: string[], cwd: string, since?: Map<string, Set<number>>): string[] {
  if (targets.length > 0) {
    // A file the user names is a test file. In a folder, a test folder name also counts.
    const named = new Set(targets.flatMap((t) => t.split(",")).filter(Boolean).map((t) => path.resolve(cwd, t)));
    return expand(targets, cwd).filter((f) => isTestFile(f) || inTestDir(f) || named.has(f));
  }
  if (since) return [...since.keys()].filter((f) => isTestFile(f) || inTestDir(f));
  const changed = gitChanged(cwd)?.filter(isTestFile) ?? [];
  if (changed.length > 0) return changed;
  return walkDir(cwd).filter(isTestFile);
}

const IS_CONFIG = /(^|[/\\])[^/\\]*(\.config|rc)\.[cm]?[jt]s$/;

function findSources(explicit: string[], tests: string[], cwd: string): { files: string[]; source: string } {
  if (explicit.length > 0) {
    const files = expand(explicit, cwd).filter(isSourceFile);
    if (files.length === 0) throw new UsageError(`No source files in: ${explicit.join(" ")}`);
    return { files, source: "" };
  }
  const reachable = importClosure(tests);
  const changed = (gitChanged(cwd) ?? []).filter((f) => isSourceFile(f) && !IS_CONFIG.test(f) && reachable.has(f));
  if (changed.length > 0) return { files: changed, source: c.dim("(changed files) ") };
  const direct = [...new Set(tests.flatMap(importsOf))].filter((f) => isSourceFile(f) && !IS_CONFIG.test(f)).sort();
  if (direct.length > 0) return { files: direct, source: c.dim("(files the tests import) ") };
  throw new UsageError("No source files found. Name them: canfail prove src/cart.ts");
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)].map((m) => m[1]);
  return specs.map((s) => resolveImport(file, s)).filter((f): f is string => !!f && !f.includes(`${path.sep}node_modules${path.sep}`));
}

function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    for (const dep of importsOf(queue.pop()!)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

function defaultCommand(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  const test = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")).scripts?.test : undefined;
  if (!test || /no test specified/.test(test)) {
    throw new UsageError('No "test" script in package.json. Pass one: --cmd "npx vitest run"');
  }
  return "npm test";
}

/** The findings an agent must see: errors only, and short. */
function agentReport(file: string): string | undefined {
  const report = scanSource(file, readFileSync(file, "utf8"));
  const errors = report.findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return undefined;
  const lines = errors.slice(0, 12).map((f) => `- line ${f.line}: [${f.rule}] ${f.message}`);
  if (errors.length > 12) lines.push(`- … and ${errors.length - 12} more`);
  return [`canfail: ${path.basename(file)} has tests that can't fail.`, ...lines].join("\n");
}

const AGENT_ADVICE = [
  "Fix them before you report that tests pass. Mock only boundaries, call the real code, assert exact values.",
  "Run `canfail rules` for fixes, and `canfail prove` to count the bugs your tests catch.",
].join("\n");

async function readEvent(): Promise<Record<string, any> | undefined> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/** Claude Code PostToolUse hook: scan a test file right after the agent writes it. */
async function hook(): Promise<number> {
  const event = await readEvent();
  const file: string | undefined = event?.tool_input?.file_path ?? event?.tool_input?.path;
  if (!file || !(isTestFile(file) || inTestDir(file)) || !existsSync(file)) return 0;
  const report = agentReport(file);
  if (!report) return 0;
  process.stderr.write(`${report}\n${AGENT_ADVICE}\n`);
  return 2;
}

/**
 * Claude Code Stop hook: before the agent reports success, scan every changed test file.
 * This also sees test files written through Bash, which the PostToolUse hook misses.
 */
async function stopHook(): Promise<number> {
  const event = await readEvent();
  if (!event || event.stop_hook_active) return 0; // one reminder only, so an agent can't get stuck
  const changed = gitChanged(event.cwd ?? process.cwd()) ?? [];
  const reports = changed.filter((f) => isTestFile(f) || inTestDir(f)).flatMap((f) => agentReport(f) ?? []);
  if (reports.length === 0) return 0;
  process.stderr.write(`${reports.join("\n")}\n${AGENT_ADVICE}\n`);
  return 2;
}

const DEMO_SOURCE = `exports.shipping = (total) => (total >= 50 ? 0 : 5);\n`;
const DEMO_FAKE = `const test = require("node:test");
const assert = require("node:assert");
const { shipping } = require("./shipping.js");
test("returns a shipping cost", () => { assert.strictEqual(typeof shipping(50), "number"); });
`;
const DEMO_REAL = `const test = require("node:test");
const assert = require("node:assert");
const { shipping } = require("./shipping.js");
test("gives free shipping at 50", () => { assert.strictEqual(shipping(50), 0); assert.strictEqual(shipping(49.99), 5); });
`;

/** Needs no project and no test runner: node:test and a temporary folder. */
async function demo(): Promise<number> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-demo-"));
  try {
    writeFileSync(path.join(dir, "shipping.js"), DEMO_SOURCE);
    for (const [name, test] of [["fake", DEMO_FAKE], ["real", DEMO_REAL]]) {
      writeFileSync(path.join(dir, "shipping.test.js"), test);
      print(c.bold(`\nThe ${name} test:\n`) + c.dim(test.split("\n").filter((l) => l.startsWith("test(")).join("\n")) + "\n");
      const cmd = `${JSON.stringify(process.execPath)} --test shipping.test.js`;
      const result = await prove({ cwd: dir, cmd, files: [path.join(dir, "shipping.js")], bugs: "all", seed: 1, onResult: (r) => print(formatResult(r, dir)) });
      print(formatProveSummary(result, dir));
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function print(text: string) {
  process.stdout.write(text + "\n");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof ProveError) {
      process.stderr.write(`${c.redBold("canfail:")} ${error.message}\n`);
      if (error.output) process.stderr.write(c.dim(error.output.trim().split("\n").slice(-25).join("\n")) + "\n");
    } else if (error instanceof UsageError || (error as NodeJS.ErrnoException)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      process.stderr.write(`${c.redBold("canfail:")} ${error.message}\nRun canfail --help for usage.\n`);
    } else {
      process.stderr.write(`${c.redBold("canfail:")} ${process.env.DEBUG ? error?.stack : (error?.message ?? error)}\n`);
    }
    process.exit(2);
  },
);
