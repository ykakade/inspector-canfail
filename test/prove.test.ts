import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { countPassed, defaultTimeout, journalPath, prove, ProveError, restore, runCommand } from "../src/prove";

// A tiny project: one source file and a test script that uses node:assert.
const SOURCE = `exports.price = (qty, unit) => qty >= 10 ? qty * unit * 0.9 : qty * unit;\n`;
const STRONG = `const assert = require("node:assert");
const { price } = require("./price.js");
assert.strictEqual(price(2, 5), 10);
assert.strictEqual(price(9, 10), 90);
assert.strictEqual(price(10, 10), 90);
console.log("Tests  3 passed");
`;
const WEAK = `const { price } = require("./price.js");
if (typeof price(1, 1) !== "number") process.exit(1);
console.log("Tests  1 passed");
`;

let dir: string;
const file = () => path.join(dir, "price.js");
const write = (name: string, text: string) => writeFileSync(path.join(dir, name), text);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "canfail-test-"));
  write("price.js", SOURCE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prove", () => {
  it("counts every bug as caught when the tests pin exact values", async () => {
    write("strong.test.js", STRONG);
    const result = await prove({ cwd: dir, files: [file()], cmd: "node strong.test.js", bugs: "all", seed: 1 });
    expect(result.candidates).toBe(7);
    expect(result).toMatchObject({ caught: 7, survived: 0, score: 100, baseline: { passed: 3 } });
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
  });

  it("reports survivors with the line before and after", async () => {
    write("weak.test.js", WEAK);
    const result = await prove({ cwd: dir, files: [file()], cmd: "node weak.test.js", bugs: 3, seed: 2 });
    expect(result).toMatchObject({ caught: 0, survived: 3, score: 0 });
    expect(result.results[0]).toMatchObject({ status: "survived", line: 1, before: SOURCE.trim() });
    expect(result.results[0].after).not.toBe(result.results[0].before);
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
  });

  it("cleans up: no journal, no signal listeners left behind", async () => {
    write("strong.test.js", STRONG);
    const listeners = () => ["SIGINT", "SIGTERM", "exit"].map((e) => process.listenerCount(e));
    const before = listeners();
    const during: number[][] = [];
    await prove({ cwd: dir, files: [file()], cmd: "node strong.test.js", bugs: 2, seed: 1, onResult: () => during.push(listeners()) });
    expect(during[0]).toEqual(before.map((n) => n + 1)); // Ctrl-C, kill and exit restore the file mid-run
    expect(listeners()).toEqual(before);
    expect(existsSync(journalPath(dir))).toBe(false);
  });

  it("calls back once for the baseline and once per bug", async () => {
    write("strong.test.js", STRONG);
    const seen: string[] = [];
    await prove({
      cwd: dir, files: [file()], cmd: "node strong.test.js", bugs: 2, seed: 1,
      onBaseline: (b) => seen.push(`baseline:${b.passed}`),
      onResult: (r, i, total) => seen.push(`${i + 1}/${total}:${r.status}`),
    });
    expect(seen).toEqual(["baseline:3", "1/2:caught", "2/2:caught"]);
  });

  it("puts the mutated file name in {file}", async () => {
    write("echo.js", `require("node:fs").appendFileSync("seen.txt", process.argv[2] + "\\n");`);
    await prove({ cwd: dir, files: [file()], cmd: "node echo.js {file}", bugs: 1, seed: 1 });
    expect(readFileSync(path.join(dir, "seen.txt"), "utf8")).toBe("{file}\nprice.js\n");
  });

  it("refuses to start when the tests already fail", async () => {
    write("broken.test.js", `console.log("boom"); process.exit(3);`);
    const run = prove({ cwd: dir, files: [file()], cmd: "node broken.test.js", bugs: 1, seed: 1 });
    await expect(run).rejects.toThrow(ProveError);
    await expect(run).rejects.toThrow("fail before any bug is planted (exit 3)");
    await expect(run).rejects.toMatchObject({ output: expect.stringContaining("boom") });
  });

  it("refuses a file with nowhere to plant a bug", async () => {
    write("empty.js", `// nothing here\n`);
    await expect(prove({ cwd: dir, files: [path.join(dir, "empty.js")], cmd: "node -e 0", bugs: 1, seed: 1 })).rejects.toThrow(
      "No place to plant a bug",
    );
  });

  it("counts a hung test run as caught, and still restores the file", async () => {
    write("loop.js", `exports.wait = (n) => { let i = 0; while (i < n) i++; return i; };\n`);
    write("loop.test.js", `const { wait } = require("./loop.js"); (wait(3) === 3 && wait(0) === 0) || process.exit(1);`);
    const result = await prove({
      cwd: dir, files: [path.join(dir, "loop.js")], cmd: "node loop.test.js", bugs: "all", seed: 1, timeoutMs: 1500,
    });
    expect(result.results.find((r) => r.original === "++")).toMatchObject({ status: "timeout" });
    expect(result.survived).toBe(0);
    expect(readFileSync(path.join(dir, "loop.js"), "utf8")).toContain("i++");
  });
});

describe("restore", () => {
  it("restores a file that a crashed run left mutated", () => {
    const journal = path.join(os.tmpdir(), "canfail");
    mkdirSync(journal, { recursive: true });
    // Simulate a crash: write a journal, then break the file.
    const id = createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 12);
    writeFileSync(path.join(journal, `${id}.json`), JSON.stringify({ [file()]: SOURCE }));
    write("price.js", "exports.price = () => 0;\n");
    expect(restore(dir)).toEqual([file()]);
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
    expect(restore(dir)).toEqual([]);
  });
});

describe("defaultTimeout", () => {
  it("is 3x the clean run, and never under 10 seconds", () => {
    expect(defaultTimeout(100)).toBe(10_000);
    expect(defaultTimeout(5_000)).toBe(15_000);
  });
});

describe("runCommand", () => {
  it("returns the exit code and the output", async () => {
    const run = await runCommand(`node -e "console.log('hi'); process.exit(4)"`, os.tmpdir());
    expect(run).toMatchObject({ code: 4, timedOut: false });
    expect(run.output.trim()).toBe("hi");
  });

  it("sets CI and NO_COLOR so runners do not watch or paint", async () => {
    const run = await runCommand(`node -e "console.log(process.env.CI, process.env.NO_COLOR, process.env.CANFAIL)"`, os.tmpdir());
    expect(run.output.trim()).toBe("1 1 1");
  });
});

describe("countPassed", () => {
  it.each([
    ["vitest", " Test Files  3 passed (3)\n      Tests  46 passed | 1 skipped (47)", 46],
    ["jest", "Tests:       2 failed, 40 passed, 42 total", 40],
    ["node:test tap", "# tests 5\n# pass 5\n# fail 0", 5],
    ["node:test spec", "ℹ tests 9\nℹ pass 9", 9],
    ["mocha", "  12 passing (30ms)", 12],
    ["bun", " 7 pass\n 0 fail", 7],
    ["unknown", "all good", null],
  ])("reads %s output", (_, output, expected) => {
    expect(countPassed(output)).toBe(expected);
  });
});
