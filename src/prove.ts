import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyMutant, findMutants, type Mutant, mutantLines, pickMutants } from "./mutate.js";

export type Status = "caught" | "survived" | "timeout";

export interface MutantResult extends Mutant {
  status: Status;
  durationMs: number;
  before: string;
  after: string;
}

export interface ProveOptions {
  cwd: string;
  files: string[];
  cmd: string;
  bugs: number | "all";
  seed: number;
  timeoutMs?: number;
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
  caught: number;
  survived: number;
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

interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

let active: { kill: () => void } | undefined;

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
  active = { kill };
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : undefined;

  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      active = undefined;
      resolve({ code, timedOut, output, durationMs: Date.now() - started });
    });
  });
}

/** Reads "47 passed" style summaries from vitest, jest, node:test, mocha and bun. */
export function countPassed(output: string): number | null {
  const patterns = [
    /Tests:?\s+(?:\d+ failed, )?(?:\d+ skipped, )?(\d+) passed/, // jest, vitest
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

/** A planted bug can cause an endless loop. Stop a run at 3x the clean run, but never before 10s. */
export function defaultTimeout(baselineMs: number): number {
  return Math.max(10_000, baselineMs * 3);
}

// ---------------------------------------------------------------- journal

export function journalPath(cwd: string): string {
  const id = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), "canfail", `${id}.json`);
}

/** Puts back every file a killed run left mutated. Returns the files it restored. */
export function restore(cwd: string): string[] {
  const journal = journalPath(cwd);
  if (!existsSync(journal)) return [];
  const saved: Record<string, string> = JSON.parse(readFileSync(journal, "utf8"));
  const restored: string[] = [];
  for (const [file, text] of Object.entries(saved)) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      writeFileSync(file, text);
      restored.push(file);
    }
  }
  rmSync(journal, { force: true });
  return restored;
}

// ---------------------------------------------------------------- prove

export async function prove(opts: ProveOptions): Promise<ProveResult> {
  const { cwd, cmd } = opts;
  restore(cwd); // a previous run may have been killed mid-bug

  const originals = new Map(opts.files.map((f) => [f, readFileSync(f, "utf8")]));
  const candidates = opts.files.flatMap((f) => findMutants(f, originals.get(f)!));
  if (candidates.length === 0) throw new ProveError("No place to plant a bug in these files.");

  const base = await runCommand(cmd, cwd, opts.timeoutMs ?? 0);
  if (base.code !== 0) {
    throw new ProveError(`The tests fail before any bug is planted (exit ${base.code}). Fix them first.`, base.output);
  }
  const baseline: Baseline = { durationMs: base.durationMs, passed: countPassed(base.output) };
  opts.onBaseline?.(baseline);

  const mutants = pickMutants(candidates, opts.bugs, opts.seed);
  const timeoutMs = opts.timeoutMs ?? defaultTimeout(base.durationMs);

  const journal = journalPath(cwd);
  mkdirSync(path.dirname(journal), { recursive: true });
  writeFileSync(journal, JSON.stringify(Object.fromEntries(originals)));

  const putBack = () => {
    for (const [file, text] of originals) {
      if (readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    }
    rmSync(journal, { force: true });
  };
  const onSignal = (signal: NodeJS.Signals) => {
    active?.kill();
    putBack();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", putBack);

  const results: MutantResult[] = [];
  try {
    for (const [i, m] of mutants.entries()) {
      const original = originals.get(m.file)!;
      writeFileSync(m.file, applyMutant(original, m));
      const run = await runCommand(cmd.replaceAll("{file}", JSON.stringify(path.relative(cwd, m.file))), cwd, timeoutMs);
      writeFileSync(m.file, original);
      const status: Status = run.timedOut ? "timeout" : run.code === 0 ? "survived" : "caught";
      const result: MutantResult = { ...m, ...mutantLines(original, m), status, durationMs: run.durationMs };
      results.push(result);
      opts.onResult?.(result, i, mutants.length);
    }
  } finally {
    putBack();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", putBack);
  }

  const survived = results.filter((r) => r.status === "survived").length;
  const caught = results.length - survived;
  return {
    cmd,
    files: opts.files,
    baseline,
    candidates: candidates.length,
    results,
    caught,
    survived,
    score: results.length === 0 ? 100 : Math.round((caught / results.length) * 100),
  };
}
