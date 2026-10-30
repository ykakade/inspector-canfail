#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { expand, gitChanged, isSourceFile, isTestFile, resolveImport, walkDir } from "./files.js";
import { prove, ProveError, restore, type ProveResult } from "./prove.js";
import { c, formatBaseline, formatProveHeader, formatProveSummary, formatResult, formatRules, formatScan } from "./report.js";
import { scanSource, summarize, type ScanResult } from "./scan.js";

const VERSION = "0.1.0";

const HELP = `${c.bold("canfail")} ${c.dim(VERSION)}  Catch tests that can't fail.

${c.bold("Usage")}
  canfail [test paths]        scan, then prove
  canfail scan [test paths]   find tests that can't fail. Static, no test run.
  canfail prove [src paths]   plant bugs in source files, run the tests, count the catches
  canfail rules               list the scan rules and how to fix each one
  canfail restore             put back source files after a killed run

${c.bold("Options")}
  --cmd <command>      test command (default: npm test). {file} becomes the mutated file
  --files <a,b,...>    source files for prove (default: changed files the tests reach,
                       else the files the tests import)
  --bugs <n|all>       how many bugs to plant (default: 10)
  --seed <n>           pick a different set of bugs (default: 1)
  --timeout <ms>       time limit per test run (default: 3x baseline, at least 10s)
  --min-score <0-100>  pass when at least this % of bugs are caught (default: 100)
  --json               print JSON for tools and agents
  -h, --help           show this help
  -v, --version        show the version

${c.bold("Exit codes")}
  0  no fake tests found, and every planted bug was caught
  1  fake tests found, or a planted bug survived
  2  canfail could not run (bad option, failing baseline, no files)
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
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return print(HELP), 0;
  if (values.version) return print(VERSION), 0;

  const cwd = process.cwd();
  const commands = ["scan", "prove", "rules", "restore", "hook"];
  const command = commands.includes(positionals[0]) ? positionals.shift()! : "all";

  if (command === "rules") return print(formatRules()), 0;
  if (command === "hook") return hook();
  if (command === "restore") {
    const files = restore(cwd);
    print(files.length ? `Restored ${files.map((f) => path.relative(cwd, f)).join(", ")}` : "Nothing to restore.");
    return 0;
  }

  const bugs = values.bugs === "all" ? "all" : Number(values.bugs);
  const minScore = Number(values["min-score"]);
  if (bugs !== "all" && !(Number.isInteger(bugs) && bugs > 0)) throw new UsageError("--bugs must be a positive number or 'all'.");
  if (!(minScore >= 0 && minScore <= 100)) throw new UsageError("--min-score must be between 0 and 100.");

  const json: { scan?: ScanResult; prove?: ProveResult } = {};
  let failed = false;

  // scan
  let testFiles: string[] = [];
  if (command === "scan" || command === "all") {
    testFiles = findTests(positionals, cwd);
    const result = summarize(testFiles.map((f) => scanSource(f, readFileSync(f, "utf8"))));
    json.scan = result;
    if (!values.json) print(formatScan(result, cwd) + "\n");
    failed ||= result.errors > 0;
  }

  // prove
  if (command === "prove" || command === "all") {
    const explicit = values.files ? [values.files] : command === "prove" ? positionals : [];
    const { files, source } = findSources(explicit, testFiles.length ? testFiles : findTests([], cwd), cwd);
    const cmd = values.cmd ?? defaultCommand(cwd);
    if (!values.json) print(formatProveHeader(files, bugs, cmd, source, cwd));
    const result = await prove({
      cwd,
      cmd,
      files,
      bugs,
      seed: Number(values.seed),
      timeoutMs: values.timeout ? Number(values.timeout) : undefined,
      onBaseline: (b) => !values.json && print(formatBaseline(b)),
      onResult: (r) => !values.json && print(formatResult(r, cwd)),
    });
    json.prove = result;
    if (!values.json) print(formatProveSummary(result));
    failed ||= result.score < minScore;
  }

  if (values.json) print(JSON.stringify({ version: VERSION, ...json }, null, 2));
  return failed ? 1 : 0;
}

function findTests(targets: string[], cwd: string): string[] {
  if (targets.length > 0) return expand(targets, cwd).filter(isTestFile);
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

/** Claude Code PostToolUse hook: scan a test file right after the agent writes it. */
async function hook(): Promise<number> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let file: string | undefined;
  try {
    const event = JSON.parse(input);
    file = event.tool_input?.file_path ?? event.tool_input?.path;
  } catch {
    return 0;
  }
  if (!file || !isTestFile(file) || !existsSync(file)) return 0;
  const report = scanSource(file, readFileSync(file, "utf8"));
  const errors = report.findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return 0;
  const lines = errors.slice(0, 12).map((f) => `- line ${f.line}: [${f.rule}] ${f.message}`);
  if (errors.length > 12) lines.push(`- … and ${errors.length - 12} more`);
  process.stderr.write(
    [
      `canfail: ${path.basename(file)} has tests that can't fail.`,
      ...lines,
      "Fix them before you report that tests pass. Mock only boundaries, call the real code, assert exact values.",
      "Run `canfail rules` for fixes, and `canfail prove` to count the bugs your tests catch.",
    ].join("\n") + "\n",
  );
  return 2;
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
