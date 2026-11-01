import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, copyFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyMutant, findMutants, type Mutant, mutantHint, mutantLines, pickMutants } from "./mutate.js";

/**
 * caught: a test failed. survived: the tests still passed. timeout: the run hit the time limit.
 * crashed: the command failed, but no test failed, as with a compile error. Not in the score.
 * uncovered: the coverage report says no test runs this line. No test run is needed.
 */
export type Status = "caught" | "survived" | "timeout" | "crashed" | "uncovered";

export interface MutantResult extends Mutant {
  status: Status;
  durationMs: number;
  before: string;
  after: string;
  hint: string;
}

export interface ProveOptions {
  cwd: string;
  files: string[];
  cmd: string;
  bugs: number | "all";
  seed: number;
  timeoutMs?: number;
  /** Edit the real files, not a temporary copy of the project. */
  inPlace?: boolean;
  /** Runs at the same time, each in its own copy. Ignored with inPlace. */
  jobs?: number;
  /** Only plant bugs on these lines. */
  lines?: Map<string, Set<number>>;
  /** Lines the coverage report says no test runs. */
  uncovered?: Map<string, Set<number>>;
  onNotice?: (message: string) => void;
  onBaseline?: (baseline: Baseline) => void;
  onResult?: (result: MutantResult, index: number, total: number) => void;
}

export interface Baseline {
  durationMs: number;
  passed: number | null;
}

export interface ProveResult {
  cmd: string;
  files: string[];
  baseline: Baseline;
  candidates: number;
  results: MutantResult[];
  /** Files that no test loads: a thrown error at the top of the file did not fail the command. */
  unreached: string[];
  caught: number;
  survived: number;
  timedOut: number;
  crashed: number;
  uncovered: number;
  score: number;
}

export class ProveError extends Error {
  constructor(
    message: string,
    readonly output = "",
  ) {
    super(message);
  }
}

/** There is nothing to check, which is not a failure: a diff with no code to mutate. */
export class NothingToProve extends Error {}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

const active = new Set<() => void>();

export function runCommand(cmd: string, cwd: string, timeoutMs = 0): Promise<RunResult> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1", CANFAIL: "1" };
  delete env.FORCE_COLOR;
  const posix = process.platform !== "win32";
  const child = spawn(cmd, { cwd, env, shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-64_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      if (posix) process.kill(-child.pid, "SIGKILL"); // the whole group: npm, the runner, its workers
      else spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } catch {
      // The group exited between the check and the kill.
    }
  };
  active.add(kill);
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : undefined;

  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      active.delete(kill);
      resolve({ code, timedOut, output, durationMs: Date.now() - started });
    });
  });
}

/** Reads "47 passed" style summaries from vitest, jest, node:test, mocha and bun. */
export function countPassed(output: string): number | null {
  const patterns = [
    /Tests:?\s+(?:\d+ failed(?:, | \| ))?(?:\d+ skipped(?:, | \| ))?(\d+) passed/, // jest, vitest
    /^#\s*pass\s+(\d+)/m, // node:test (tap)
    /ℹ pass (\d+)/, // node:test (spec)
    /(\d+) passing/, // mocha
    /^\s*(\d+) pass\b/m, // bun
  ];
  for (const re of patterns) {
    const m = re.exec(output);
    if (m) return Number(m[1]);
  }
  return null;
}

/** True when the output shows that a test failed, not only that the command did. */
export function hasTestFailure(output: string): boolean {
  return [
    /Tests:?\s+[^\n]*\b[1-9]\d* failed/, // jest, vitest
    /^#\s*fail\s+[1-9]/m, // node:test (tap)
    /ℹ fail [1-9]/, // node:test (spec)
    /\b[1-9]\d* failing/, // mocha
    /^\s*[1-9]\d* fail\b/m, // bun
    /AssertionError/, // a plain script that uses node:assert
  ].some((re) => re.test(output));
}

export function statusOf(run: RunResult, baseline: Baseline): Status {
  if (run.timedOut) return "timeout";
  if (run.code === 0) return "survived";
  if (hasTestFailure(run.output) || baseline.passed === null) return "caught"; // a runner we can't read: trust the exit code
  return "crashed";
}

/** A planted bug can cause an endless loop. Stop a run at 3x the clean run, but never before 10s. */
export function defaultTimeout(baselineMs: number): number {
  return Math.max(10_000, baselineMs * 3);
}

/** The clean run has no number to scale from. A watch-mode command never ends, so stop at 10 minutes. */
const BASELINE_LIMIT_MS = 600_000;

// ---------------------------------------------------------------- journal

export function journalPath(cwd: string): string {
  const id = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  const cache = process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
  return path.join(cache, "canfail", `${id}.json`); // not in the temp dir: a reboot must not lose it
}

interface Journal {
  originals: Record<string, string>;
  /** The bug in the file right now. Only this exact text is canfail's to overwrite. */
  active?: { file: string; text: string };
}

function writeJournal(file: string, journal: Journal) {
  mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(journal));
  renameSync(partial, file); // a kill mid-write must not leave half a journal
}

export interface Recovery {
  restored: string[];
  /** Files with text canfail did not write. They were left alone. */
  kept: string[];
  corrupt: boolean;
}

/** After a killed run: removes the bug canfail left in a file. It never overwrites other changes. */
export function recover(cwd: string): Recovery {
  const file = journalPath(cwd);
  const out: Recovery = { restored: [], kept: [], corrupt: false };
  if (!existsSync(file)) return out;
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(file, "utf8"));
    if (typeof journal.originals !== "object" || journal.originals === null) throw new Error("no originals");
  } catch {
    rmSync(file, { force: true });
    return { ...out, corrupt: true };
  }
  for (const [target, original] of Object.entries(journal.originals)) {
    if (!existsSync(target)) {
      out.kept.push(target);
      continue;
    }
    const current = readFileSync(target, "utf8");
    if (current === original) continue;
    if (journal.active?.file === target && journal.active.text === current) {
      writeFileSync(target, original);
      out.restored.push(target);
    } else {
      out.kept.push(target);
    }
  }
  rmSync(file, { force: true });
  return out;
}

/** Puts back every file a killed run left mutated. Returns the files it restored. */
export function restore(cwd: string): string[] {
  return recover(cwd).restored;
}

// ---------------------------------------------------------------- workspaces

const NOT_COPIED = new Set([".git", ".next", ".turbo", "coverage"]);

function copyTree(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (NOT_COPIED.has(entry.name)) continue;
    if (entry.name === "node_modules") symlinkSync(source, target, "junction");
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (entry.isDirectory()) copyTree(source, target);
    else if (lstatSync(source).isFile()) copyFileSync(source, target);
  }
}

function makeCopy(cwd: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-copy-"));
  copyTree(cwd, dir);
  return dir;
}

/** A top-level throw. If the command still passes, no test loads this file. */
export function withCanary(text: string): string {
  const canary = 'throw new Error("canfail: is this file reached?");\n';
  if (!text.startsWith("#!")) return canary + text;
  const end = text.indexOf("\n") + 1;
  return text.slice(0, end) + canary + text.slice(end);
}

// ---------------------------------------------------------------- prove

export async function prove(opts: ProveOptions): Promise<ProveResult> {
  const { cwd, cmd } = opts;
  const inPlace = opts.inPlace ?? false;
  const recovery = recover(cwd); // a previous run may have been killed mid-bug
  const named = (files: string[]) => files.map((f) => path.relative(cwd, f)).join(", ");
  if (recovery.restored.length) opts.onNotice?.(`Removed a bug that a killed run left in ${named(recovery.restored)}.`);
  if (recovery.kept.length) opts.onNotice?.(`A killed run was recorded for ${named(recovery.kept)}, but these files changed after it. They were left alone. Check them.`);
  if (recovery.corrupt) opts.onNotice?.("The record of a killed run is damaged, so it was deleted. If a file has a planted bug in it, use git to restore it.");

  if (!inPlace) {
    const outside = opts.files.filter((f) => path.relative(cwd, f).startsWith(".."));
    if (outside.length) throw new ProveError(`These files are outside the current directory: ${outside.join(", ")}. Run canfail from the project root, or use --in-place.`);
  }

  const originals = new Map(opts.files.map((f) => [f, readFileSync(f, "utf8")]));
  const found = opts.files.flatMap((f) => findMutants(f, originals.get(f)!));
  if (found.length === 0) throw new ProveError("No place to plant a bug in these files.");
  const candidates = opts.lines ? found.filter((m) => opts.lines!.get(m.file)?.has(m.line)) : found;
  if (candidates.length === 0) throw new NothingToProve("The changed lines have no place to plant a bug.");

  const jobs = inPlace ? 1 : Math.max(1, opts.jobs ?? 1);
  const roots: string[] = [];
  const journal = journalPath(cwd);
  const locate = (root: string, file: string) => (inPlace ? file : path.join(root, path.relative(cwd, file)));
  const originalsJournal = Object.fromEntries(originals);

  const putBack = () => {
    if (inPlace) {
      for (const [file, text] of originals) {
        if (readFileSync(file, "utf8") !== text) writeFileSync(file, text);
      }
      rmSync(journal, { force: true });
    } else {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    for (const kill of active) kill();
    putBack();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", putBack);

  const place = (file: string, text: string, root: string) => {
    if (inPlace) writeJournal(journal, { originals: originalsJournal, active: { file, text } });
    writeFileSync(locate(root, file), text);
  };

  try {
    if (inPlace) {
      roots.push(cwd);
      writeJournal(journal, { originals: originalsJournal });
    } else {
      for (let i = 0; i < jobs; i++) roots.push(makeCopy(cwd));
    }
    const main = roots[0];
    const quoted = (files: string[]) => files.map((f) => JSON.stringify(path.relative(cwd, f))).join(" ");
    const forFiles = (files: string[]) => cmd.replaceAll("{file}", quoted(files));

    // The clean run, twice: a test that fails at random would count as a caught bug.
    const limit = opts.timeoutMs ?? BASELINE_LIMIT_MS;
    const copyNote = inPlace ? "" : " The run uses a temporary copy without .git. If the tests need the real directory, use --in-place.";
    const base = await runCommand(forFiles(opts.files), main, limit);
    if (base.timedOut) throw new ProveError(`The tests did not finish in ${Math.round(limit / 1000)}s with no bug planted. Does the command use watch mode?`, base.output);
    if (base.code !== 0) throw new ProveError(`The tests fail before any bug is planted (exit ${base.code}). Fix them first.${copyNote}`, base.output);
    const baseline: Baseline = { durationMs: base.durationMs, passed: countPassed(base.output) };
    opts.onBaseline?.(baseline);
    const timeoutMs = opts.timeoutMs ?? defaultTimeout(base.durationMs);
    const again = await runCommand(forFiles(opts.files), main, timeoutMs);
    if (again.code !== 0) throw new ProveError("The tests passed once, then failed with no bug planted. Results from flaky tests can't be trusted.", again.output);

    // Reach: a mutant in a file no test loads tells nothing about the assertions.
    const unreached: string[] = [];
    for (const file of opts.files) {
      if (!candidates.some((m) => m.file === file)) continue;
      place(file, withCanary(originals.get(file)!), main);
      const run = await runCommand(forFiles([file]), main, timeoutMs);
      place(file, originals.get(file)!, main);
      if (!run.timedOut && run.code === 0) unreached.push(file);
    }
    const reachable = candidates.filter((m) => !unreached.includes(m.file));
    if (reachable.length === 0) {
      throw new ProveError(`The tests pass with an error thrown at the top of ${named(unreached)}. No test loads the code. Check the test command.`);
    }

    const mutants = pickMutants(reachable, opts.bugs, opts.seed);
    const results: MutantResult[] = new Array(mutants.length);
    let next = 0;
    let done = 0;
    const worker = async (root: string) => {
      for (let i = next++; i < mutants.length; i = next++) {
        const m = mutants[i];
        const original = originals.get(m.file)!;
        const shared = { ...m, ...mutantLines(original, m), hint: mutantHint(m) };
        let result: MutantResult;
        if (opts.uncovered?.get(m.file)?.has(m.line)) {
          result = { ...shared, status: "uncovered", durationMs: 0 };
        } else {
          place(m.file, applyMutant(original, m), root);
          const run = await runCommand(forFiles([m.file]), root, timeoutMs);
          place(m.file, original, root);
          result = { ...shared, status: statusOf(run, baseline), durationMs: run.durationMs };
        }
        results[i] = result;
        opts.onResult?.(result, done++, mutants.length);
      }
    };
    await Promise.all(roots.map(worker));

    // The clean run once more: if it fails now, every "caught" above is in doubt.
    const last = await runCommand(forFiles(opts.files), main, timeoutMs);
    if (last.code !== 0) throw new ProveError("The tests fail with no bug planted after the run. The environment or a flaky test changed the results, so they can't be trusted.", last.output);

    const count = (s: Status) => results.filter((r) => r.status === s).length;
    const timedOut = count("timeout");
    const caught = count("caught") + timedOut;
    const survived = count("survived");
    const crashed = count("crashed");
    const uncovered = count("uncovered");
    const measured = caught + survived + uncovered;
    if (measured === 0) throw new ProveError(`All ${crashed} runs failed without a test failure, as with a compile error. Nothing was measured. Use a runtime-only test command.`);
    return {
      cmd,
      files: opts.files,
      baseline,
      candidates: candidates.length,
      results,
      unreached,
      caught,
      survived,
      timedOut,
      crashed,
      uncovered,
      score: Math.round((caught / measured) * 100),
    };
  } finally {
    putBack();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", putBack);
  }
}
