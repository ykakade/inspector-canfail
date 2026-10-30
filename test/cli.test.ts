// End-to-end: runs the bundled CLI the way users and agents run it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  demo("prove: the honest suite's 19 tests catch 10 of 10 bugs", () => {
    const { code, out } = canfail(["prove", SOURCE, "--cmd", AFTER]);
    expect(code).toBe(0);
    expect(out).toContain("Your 19 passing tests caught 10 of 10 planted bugs.");
  });

  it("scan: the honest suite has no findings", () => {
    const { code, out } = canfail(["scan", "examples/checkout/tests/after"]);
    expect(code).toBe(0);
    expect(out).toContain("No fake tests found in 16 tests.");
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
    expect(out.match(/^\s+(error|warn)\s+\S+$/gm)).toHaveLength(12);
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
    const child = spawn("node", [CLI, "prove", "f.js", "--cmd", "node hang.js", "--timeout", "30000"], { cwd: dir });
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
