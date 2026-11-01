// End-to-end: runs the bundled CLI the way users and agents run it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
// Bundle the current src/ into a temp file, so these tests check the code as it is now
// (with a planted bug, inside a canfail run) and never touch the committed bundle.
const CLI = path.join(mkdtempSync(path.join(os.tmpdir(), "canfail-cli-")), "canfail.cjs");

beforeAll(() => {
  buildSync({ entryPoints: [path.join(ROOT, "src/cli.ts")], bundle: true, platform: "node", format: "cjs", outfile: CLI, logLevel: "silent" });
});

// The two demo runs plant 20 bugs each. Inside `npm run prove:self` they would multiply the run time.
const demo = it.skipIf(!!process.env.CANFAIL);

function canfail(args: string[], options: { cwd?: string; input?: string } = {}) {
  const run = spawnSync("node", [CLI, ...args], {
    cwd: options.cwd ?? ROOT,
    input: options.input,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const BEFORE = "npx vitest run --root examples/checkout tests/before";
const AFTER = "npx vitest run --root examples/checkout tests/after";
const SOURCE = "examples/checkout/src/checkout.ts";

describe("the numbers in the README", () => {
  it("scan: 48 of 48 tests in the fake suite are suspect", () => {
    const { code, out } = canfail(["scan", "examples/checkout/tests/before"]);
    expect(code).toBe(1);
    expect(out).toContain("48 of 48 tests are suspect: 39 can't fail, 9 are weak.");
  });

  demo("prove: the fake suite's 47 passing tests catch 0 of 10 bugs", () => {
    const original = readFileSync(path.join(ROOT, SOURCE), "utf8");
    const { code, out } = canfail(["prove", SOURCE, "--cmd", BEFORE]);
    expect(code).toBe(1);
    expect(out).toContain("Your 47 passing tests caught 0 of 10 planted bugs.");
    expect(readFileSync(path.join(ROOT, SOURCE), "utf8")).toBe(original);
  });

  demo("prove: the honest suite's 20 tests catch 10 of 10 bugs", () => {
    const { code, out } = canfail(["prove", SOURCE, "--cmd", AFTER]);
    expect(code).toBe(0);
    expect(out).toContain("Your 20 passing tests caught 10 of 10 planted bugs.");
  });

  it("scan: the honest suite has no findings", () => {
    const { code, out } = canfail(["scan", "examples/checkout/tests/after"]);
    expect(code).toBe(0);
    expect(out).toContain("No fake tests found in 17 tests.");
  });
});

describe("cli", () => {
  it("prints JSON for tools", () => {
    const { code, out } = canfail(["scan", "examples/checkout/tests/before/edge-cases.test.ts", "--json"]);
    expect(code).toBe(1);
    const json = JSON.parse(out);
    expect(json.scan).toMatchObject({ tests: 15, fake: 7, weak: 8 });
    expect(json.scan.files[0].findings[0]).toMatchObject({ rule: "unchecked-throw", line: 10, severity: "error" });
  });

  it("rejects bad options with exit code 2", () => {
    expect(canfail(["prove", "--bugs", "zero"])).toMatchObject({ code: 2 });
    expect(canfail(["--nope"])).toMatchObject({ code: 2 });
    expect(canfail(["scan", "no/such/dir"]).err).toContain("Not found: no/such/dir");
  });

  it("lists every rule", () => {
    const { code, out } = canfail(["rules"]);
    expect(code).toBe(0);
    expect(out.match(/^\s+(error|warn)\s+\S+$/gm)).toHaveLength(16);
  });
});

describe("hook", () => {
  const event = (file: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(ROOT, file) } });

  it("blocks with exit 2 and explains when the agent writes a fake test", () => {
    const { code, err } = canfail(["hook"], { input: event("examples/checkout/tests/before/payment.test.ts") });
    expect(code).toBe(2);
    expect(err).toContain("payment.test.ts has tests that can't fail");
    expect(err).toContain("[tests-the-mock]");
  });

  it("stays silent for honest tests and for files that are not tests", () => {
    expect(canfail(["hook"], { input: event("examples/checkout/tests/after/checkout.test.ts") })).toMatchObject({ code: 0, err: "" });
    expect(canfail(["hook"], { input: event(SOURCE) })).toMatchObject({ code: 0, err: "" });
    expect(canfail(["hook"], { input: "not json" })).toMatchObject({ code: 0, err: "" });
  });
});

describe("bad input stops the run", () => {
  const project = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-bad-"));
    writeFileSync(path.join(dir, "f.js"), "exports.f = (a) => a + 1;\n");
    return dir;
  };

  it("exits 2 when a scan finds no test files, because 0 files is not a pass", () => {
    const dir = project();
    expect(canfail(["scan", "f.js"], { cwd: dir }).code).toBe(0); // a named file counts as a test file
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(path.join(dir, "lib/a.js"), "exports.a = 1;\n");
    const { code, err } = canfail(["scan", "lib"], { cwd: dir });
    expect(code).toBe(2);
    expect(err).toContain("No test files in: lib");
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a test in a test folder without .test in its name", () => {
    const dir = project();
    mkdirSync(path.join(dir, "test"));
    writeFileSync(path.join(dir, "test/cart.js"), `it("x", () => {});\n`);
    const { code, out } = canfail(["scan", "test"], { cwd: dir });
    expect(code).toBe(1);
    expect(out).toContain("no-assertion");
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [["--timeout", "abc"], "--timeout"],
    [["--seed", "abc"], "--seed"],
    [["--jobs", "0"], "--jobs"],
    [["--jobs", "2", "--in-place"], "--jobs"],
  ])("rejects %j", (args, name) => {
    const dir = project();
    const { code, err } = canfail(["prove", "f.js", "--cmd", "true", ...args], { cwd: dir });
    expect(code).toBe(2);
    expect(err).toContain(name);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the stop hook", () => {
  const repo = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-stop-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  };

  it("blocks once when a changed test can't fail, then lets the agent stop", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.test.js"), `it("x", () => { expect(1).toBe(1); });\n`);
    const first = canfail(["stop-hook"], { input: JSON.stringify({ cwd: dir }) });
    expect(first.code).toBe(2);
    expect(first.err).toContain("[tautology]");
    expect(canfail(["stop-hook"], { input: JSON.stringify({ cwd: dir, stop_hook_active: true }) }).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet when the changed tests are fine", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.test.js"), `it("x", () => { expect(f(1)).toBe(2); });\n`);
    expect(canfail(["stop-hook"], { input: JSON.stringify({ cwd: dir }) }).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("--since", () => {
  const git = (dir: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });

  it("plants bugs only on changed lines", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-since-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "f.js"), "exports.a = (x) => x + 1;\nexports.b = (x) => x * 2;\n");
    writeFileSync(path.join(dir, "f.test.js"), `const { a, b } = require("./f.js"); if (a(1) !== 2) process.exit(1);\nb(1);\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "one");
    git(dir, "checkout", "-qb", "work");
    writeFileSync(path.join(dir, "f.js"), "exports.a = (x) => x + 1;\nexports.b = (x) => x * 3;\n");
    const { out } = canfail(["prove", "--since", "main", "--bugs", "all", "--cmd", "node f.test.js", "--json"], { cwd: dir });
    const lines = new Set(JSON.parse(out).prove.results.map((r: { line: number }) => r.line));
    expect([...lines]).toEqual([2]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 when the diff has no source to prove", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-since-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "one");
    const { code, out } = canfail(["prove", "--since", "main", "--cmd", "true"], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain("Nothing to prove");
    rmSync(dir, { recursive: true, force: true });
  });

  it("explains a ref it can't read", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-since-"));
    git(dir, "init", "-q");
    const { code, err } = canfail(["prove", "--since", "nope", "--cmd", "true"], { cwd: dir });
    expect(code).toBe(2);
    expect(err).toContain('Can\'t compare with "nope"');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("demo", () => {
  demo("needs no project and shows the gap", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-empty-"));
    const { code, out } = canfail(["demo"], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain("caught 0 of");
    expect(out).toMatch(/caught (\d+) of \1 planted/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a killed run never leaves a bug behind", () => {
  // The test command hangs once a bug is planted, so the run can be killed mid-bug.
  function project() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canfail-kill-"));
    const source = "exports.f = (a) => a + 1;\n";
    writeFileSync(path.join(dir, "f.js"), source);
    writeFileSync(
      path.join(dir, "hang.js"),
      `const fs = require("node:fs");
       if (fs.readFileSync("f.js", "utf8") !== ${JSON.stringify(source)}) {
         fs.writeFileSync("planted", String(process.pid));
         setTimeout(() => {}, 60000);
       }`,
    );
    return { dir, source };
  }

  async function startAndWaitForBug(dir: string) {
    const child = spawn("node", [CLI, "prove", "f.js", "--in-place", "--cmd", "node hang.js", "--timeout", "30000"], { cwd: dir });
    for (let i = 0; i < 200 && !existsSync(path.join(dir, "planted")); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(path.join(dir, "planted"))).toBe(true);
    return child;
  }

  it("restores the file on Ctrl-C", async () => {
    const { dir, source } = project();
    const child = await startAndWaitForBug(dir);
    const exit = new Promise((r) => child.on("exit", r));
    child.kill("SIGINT");
    expect(await exit).toBe(130);
    expect(readFileSync(path.join(dir, "f.js"), "utf8")).toBe(source);
    rmSync(dir, { recursive: true, force: true });
  });

  it("`canfail restore` repairs the file after kill -9", async () => {
    const { dir, source } = project();
    const child = await startAndWaitForBug(dir);
    const exit = new Promise((r) => child.on("exit", r));
    child.kill("SIGKILL");
    await exit;
    process.kill(Number(readFileSync(path.join(dir, "planted"), "utf8")), "SIGKILL");
    expect(readFileSync(path.join(dir, "f.js"), "utf8")).not.toBe(source);
    const { code, out } = canfail(["restore"], { cwd: dir });
    expect(code).toBe(0);
    expect(out).toContain("Restored f.js");
    expect(readFileSync(path.join(dir, "f.js"), "utf8")).toBe(source);
    rmSync(dir, { recursive: true, force: true });
  });
});
