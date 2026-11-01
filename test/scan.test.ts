import { describe, expect, it } from "vitest";
import { RULES, type RuleId, scanSource, summarize } from "../src/scan";

/** Scans `code` as if it lived in `file`, and returns "rule@line" for each finding. */
function scan(code: string, file = "/repo/test/cart.test.ts"): string[] {
  return scanSource(file, code.trim() + "\n").findings.map((f) => `${f.rule}@${f.line}`);
}

const rules = (code: string, file?: string) => scan(code, file).map((f) => f.split("@")[0] as RuleId);

describe("tests that can fail produce no findings", () => {
  it("accepts a plain exact assertion on real code", () => {
    expect(scan(`
import { total } from "../src/cart";
it("adds", () => { expect(total([1, 2])).toBe(3); });
`)).toEqual([]);
  });

  it("accepts a fake at the boundary when real code uses it", () => {
    expect(scan(`
import { checkout } from "../src/cart";
it("charges", async () => {
  const gateway = { charge: vi.fn(async () => ({ ok: true })) };
  await checkout(gateway);
  expect(gateway.charge).toHaveBeenCalledWith(3740, "usd");
});
`)).toEqual([]);
  });

  it("accepts mocking a dependency, not the subject", () => {
    expect(scan(`
import { load } from "../src/cart";
import { fetchJson } from "../src/http";
vi.mock("../src/http");
it("loads", async () => {
  vi.mocked(fetchJson).mockResolvedValue({ items: [] });
  expect(await load()).toEqual([]);
});
`)).toEqual([]);
  });

  it("accepts toThrow, awaited rejects, and returned promises", () => {
    expect(scan(`
import { parse, fetchCart } from "../src/cart";
it("throws", () => { expect(() => parse("")).toThrow("empty"); });
it("rejects", async () => { await expect(fetchCart(-1)).rejects.toThrow("bad id"); });
it("returns", () => { return fetchCart(1).then((c) => { expect(c.id).toBe(1); }); });
`)).toEqual([]);
  });

  it("accepts node:assert, chai, and custom expect helpers", () => {
    expect(scan(`
import assert from "node:assert/strict";
import { total } from "../src/cart";
test("assert", () => { assert.equal(total([2]), 2); });
it("chai", () => { expect(total([])).to.equal(0); });
it("helper", () => { expectTotal([1], 1); });
test("ava snapshot", (t) => { t.snapshot(total([1])); });
`)).toEqual([]);
  });
});

describe("rules", () => {
  it("mocks-subject: flags vi.mock of the module the file is named after", () => {
    const code = `
import { total } from "../src/cart";
vi.mock("../src/cart", () => ({ total: vi.fn(() => 3) }));
it("adds", () => { expect(total([1, 2])).toBe(3); });
`;
    expect(scan(code)).toEqual(["mocks-subject@2", "tests-the-mock@3"]);
  });

  it("mocks-subject: knows node:test and bun mock.module", () => {
    expect(rules(`
import { total } from "../src/cart";
mock.module("../src/cart", { namedExports: { total: () => 3 } });
test("adds", () => { assert.equal(total([1, 2]), 3); });
`)).toContain("mocks-subject");
  });

  it("mocks-subject: names an index.test file after its folder", () => {
    expect(rules(`
import { total } from "./index";
vi.mock("./index");
it("adds", () => { expect(total([1])).toBe(1); });
`, "/repo/src/Cart/index.test.ts")).toEqual(["mocks-subject", "tests-the-mock"]);
  });

  it("mocks-subject: only warns for a partial mock that keeps the real module", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
import { total } from "../src/cart";
jest.mock("../src/cart", () => ({ ...jest.requireActual("../src/cart"), log: jest.fn() }));
it("adds", () => { expect(total([1, 2])).toBe(3); });
`);
    expect(report.findings.map((f) => [f.rule, f.severity])).toEqual([["mocks-subject", "warn"]]);
    expect(report).toMatchObject({ tests: 1, fake: 0, weak: 0 }); // a file-level warning marks no test as fake
  });

  it("everything-mocked: reads CommonJS require", () => {
    expect(rules(`
const { price } = require("../src/pricing");
jest.mock("../src/pricing");
it("works", () => { expect(price(1)).toBe(2); });
`, "/repo/test/order.test.ts")).toContain("everything-mocked");
  });

  it("everything-mocked: ignores type-only imports", () => {
    expect(rules(`
import { type Order, type Item } from "../src/types";
import { price } from "../src/pricing";
vi.mock("../src/pricing");
it("works", () => { expect(price(1)).toBe(2); });
`, "/repo/test/order.test.ts")).toContain("everything-mocked");
  });

  it("everything-mocked: flags a file where every project import is a mock", () => {
    expect(rules(`
import { price } from "../src/pricing";
import { tax } from "../src/tax";
vi.mock("../src/pricing");
vi.mock("../src/tax");
it("works", () => { expect(price(1) + tax(1)).toBe(2); });
`, "/repo/test/order.test.ts")).toContain("everything-mocked");
  });

  it("tests-the-mock: flags a test that calls its own mock and checks it", () => {
    expect(scan(`
const send = vi.fn();
it("sends", () => {
  send("hi");
  expect(send).toHaveBeenCalledWith("hi");
});
`)).toEqual(["tests-the-mock@4"]);
  });

  it("tests-the-mock: names at most two mocks", () => {
    expect(scanSource("/repo/test/a.test.ts", `
const a = vi.fn(), b = vi.fn(), c = vi.fn();
it("x", () => { a(); b(); c(); expect(a).toHaveBeenCalled(); });
`).findings[0].message).toBe("Calls the mock `a` and `b` itself, then checks it. No real code runs.");
  });

  it("tests-the-mock: finds mocks assigned in beforeEach", () => {
    expect(rules(`
let gateway: Gateway;
beforeEach(() => { gateway = { charge: vi.fn() }; });
it("charges", () => { gateway.charge(1); expect(gateway.charge).toHaveBeenCalledWith(1); });
`)).toEqual(["tests-the-mock"]);
  });

  it("tests-the-mock: flags a check of the test's own mock call, even next to real code", () => {
    expect(rules(`
import { makeCart } from "../src/cart";
const send = vi.fn();
it("a", () => { const cart = makeCart(); send(cart); expect(send).toHaveBeenCalledWith(cart); });
it("b", () => { const cart = makeCart(); send(cart); expect(send.mock.calls[0][0]).toBe(cart); });
`)).toEqual(["tests-the-mock", "tests-the-mock"]);
  });

  it("tests-the-mock: needs every check to be about the mock", () => {
    expect(scan(`
import { checkout } from "../src/cart";
const send = vi.fn();
it("a", () => { send(1); expect(send).toHaveBeenCalled(); expect(checkout(send)).toBe(true); });
`)).toEqual([]);
  });

  it("tests-the-mock: sees mocks behind a namespace import", () => {
    expect(rules(`
import * as api from "../src/api";
vi.mock("../src/api");
it("gets", () => { api.get("/x"); expect(api.get).toHaveBeenCalledWith("/x"); });
`)).toContain("tests-the-mock");
  });

  it("tests-the-mock: follows values that came out of a mock", () => {
    expect(rules(`
const gateway = { charge: jest.fn().mockResolvedValue({ ok: true }) };
it("charges", async () => {
  const result = await gateway.charge(100);
  expect(result.ok).toBe(true);
});
`)).toEqual(["tests-the-mock"]);
  });

  it("tests-the-mock: counts constructing a real class as real code", () => {
    expect(scan(`
const send = vi.fn();
it("builds", () => { new Mailer(send); expect(send).not.toHaveBeenCalled(); });
`)).toEqual([]);
  });

  it("tests-the-mock: flags asserting on a mock when no real code runs", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
const mailer = { send: vi.fn() };
it("does not email", () => { expect(mailer.send).not.toHaveBeenCalled(); });
it("has no calls", () => { expect(mailer.send.mock.calls).toHaveLength(0); });
`);
    expect(report.findings.map((f) => [f.test, f.message])).toEqual([
      ["does not email", "Checks a mock, but calls no real code that could use it."],
      ["has no calls", "Checks a mock, but calls no real code that could use it."],
    ]);
  });

  it("no-assertion: flags empty tests and tests that only call code", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
import { total } from "../src/cart";
it("is empty", () => {});
it("runs", () => { total([1]); });
`);
    expect(report.findings.map((f) => `${f.rule}@${f.line}: ${f.message}`)).toEqual([
      "no-assertion@3: Empty test. It checks nothing.",
      "no-assertion@4: No assertion. It passes unless the code throws.",
    ]);
  });

  it("tautology: flags constants and self-comparison", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => { expect(true).toBe(true); });
it("b", () => { expect(total([1])).toEqual(total([1])); });
it("c", () => { expect(1).toBeTruthy(); });
it("d", () => { assert.equal(2, 2); });
test("e", (t) => { t.true(true); });
test("f", (t) => { t.is(1, 1); });
`)).toEqual(["tautology@2", "tautology@3", "tautology@4", "tautology@5", "tautology@6", "tautology@7"]);
  });

  it("tautology: accepts a constant expected value on either side", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => { assert.strictEqual(3, total([1, 2])); });
it("b", () => { assert.ok(total([1])); });
`)).toEqual([]);
  });

  it("dangling-expect: flags expect without a matcher call", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => { expect(total([1])); });
it("b", () => { expect(total([1])).toBeTruthy; });
it("c", () => { expect(total([1])).not; });
`)).toEqual(["dangling-expect@2", "dangling-expect@3", "dangling-expect@4"]);
  });

  it("swallowed-failure: flags assertions whose catch does not rethrow", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => {
  try {
    expect(total([1])).toBe(1);
  } catch (e) {
    console.log(e);
  }
});
it("b", () => {
  try { expect(total([1])).toBe(1); } catch (e) { throw e; }
});
`)).toEqual(["swallowed-failure@4"]);
  });

  it("unchecked-throw: flags assertions that only run in catch", () => {
    expect(scan(`
import { parse } from "../src/cart";
it("a", () => {
  try { parse(""); } catch (e) { expect(e.message).toBe("empty"); }
});
it("b", () => {
  expect.assertions(1);
  try { parse(""); } catch (e) { expect(e.message).toBe("empty"); }
});
it("c", () => {
  try { parse(""); throw new Error("no throw"); } catch (e) { expect(e.message).toBe("empty"); }
});
`)).toEqual(["unchecked-throw@3"]);
  });

  it("floating-assertion: flags un-awaited resolves, then and setTimeout", () => {
    expect(scan(`
import { fetchCart } from "../src/cart";
it("a", () => { expect(fetchCart(1)).resolves.toEqual({ id: 1 }); });
it("b", () => { fetchCart(1).then((c) => { expect(c.id).toBe(1); }); });
it("c", () => { setTimeout(() => { expect(fetchCart).toBeDefined(); }, 10); });
it("e", () => { fetchCart(1).then((c) => { expect(c.id).toBe(1); }).catch(() => {}); });
it("d", (done) => { setTimeout(() => { expect(1 + fetchCart.length).toBe(1); done(); }, 10); });
`)).toEqual(["floating-assertion@2", "floating-assertion@3", "floating-assertion@4", "floating-assertion@5"]);
  });

  it("skipped-test: warns on skip, xit and describe.skip, but not todo", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
it.skip("a", () => { expect(1).toBe(2); });
xit("b", () => {});
describe.skip("c", () => { it("d", () => {}); });
it.todo("e");
`);
    expect(report.findings.map((f) => `${f.rule}@${f.line}:${f.severity}`)).toEqual([
      "skipped-test@2:warn",
      "skipped-test@3:warn",
      "skipped-test@4:warn",
    ]);
    expect(report.tests).toBe(3);
  });

  it("weak-assertion: warns when every check is weak", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => { expect(total([1])).toBeDefined(); });
it("b", () => { expect(typeof total([1])).toBe("number"); });
it("c", () => { expect(total([1])).not.toBeNull(); expect(total([1])).toBe(1); });
it("d", () => { expect(cart()).toHaveProperty("id"); });
it("e", () => { expect(cart()).toHaveProperty("id", 7); });
`)).toEqual(["weak-assertion@2", "weak-assertion@3", "weak-assertion@5"]);
  });

  it("conditional-assertion: warns when every check sits inside an if", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => {
  const t = total([1]);
  if (t > 100) {
    expect(t).toBe(1);
  }
});
`)).toEqual(["conditional-assertion@5"]);
  });

  it("conditional-assertion: also sees ternaries, and accepts one unconditional check", () => {
    expect(scan(`
import { total } from "../src/cart";
it("a", () => { const t = total([1]); t > 1 ? expect(t).toBe(2) : null; });
it("c", () => { const t = total([1]); t > 1 && expect(t).toBe(2); });
it("b", () => { const t = total([1]); expect(t).toBe(1); if (t > 1) { expect(t).toBe(2); } });
`)).toEqual(["conditional-assertion@2", "conditional-assertion@3"]);
  });
});

describe("edge cases", () => {
  it("gives every rule a summary and a fix", () => {
    for (const rule of Object.values(RULES)) {
      expect(rule.summary.length).toBeGreaterThan(20);
      expect(rule.fix.length).toBeGreaterThan(20);
    }
  });

  it("accepts a test that only calls fail()", () => {
    expect(scan(`it("todo", () => { fail("write me"); });`)).toEqual([]);
  });
});

describe("reporting", () => {
  it("shortens long code in messages to 48 characters", () => {
    const fits = "x".repeat(40); // "expect(" + 40 + ")" = 48 characters
    const [a, b] = scanSource("/repo/test/a.test.ts", `
it("a", () => { expect(${fits}); });
it("b", () => { expect(${fits}y); });
`).findings.map((f) => f.message.split("`")[1]);
    expect(a).toBe(`expect(${fits})`);
    expect(b).toBe(`expect(${fits}`.slice(0, 47) + "…");
  });

  it("adds up counts across files", () => {
    const one = scanSource("/repo/test/a.test.ts", `it("a", () => { expect(true).toBe(true); });`);
    const two = scanSource("/repo/test/b.test.ts", `it("b", () => {}); it("c", () => { expect(f()).toBeDefined(); });`);
    expect(summarize([one, two])).toMatchObject({ tests: 3, fake: 2, weak: 1, errors: 2, warnings: 1 });
  });

  it("drops a test's warnings when it already has an error", () => {
    expect(scan(`
const send = vi.fn();
it("a", () => { send(); expect(send).toHaveBeenCalled(); });
`)).toEqual(["tests-the-mock@2"]);
  });

  it("counts fake and weak tests", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
import { total } from "../src/cart";
it("fake", () => { expect(true).toBe(true); });
it("weak", () => { expect(total([1])).toBeDefined(); });
it("good", () => { expect(total([1])).toBe(1); });
`);
    expect(report).toMatchObject({ tests: 3, fake: 1, weak: 1 });
  });

  it("skips findings marked canfail-ignore", () => {
    expect(scan(`
it("a", () => {
  // canfail-ignore tautology: documents a platform guarantee
  expect(0.1 + 0.2).not.toBe(0.3);
});
it("b", () => { expect(true).toBe(true); }); // canfail-ignore
`)).toEqual([]);
  });

  it("reads tests inside describe blocks and it.each tables", () => {
    const report = scanSource("/repo/test/cart.test.ts", `
describe("cart", () => {
  describe("total", () => {
    it.each([[1, 1]])("total of %i", (a, b) => {});
  });
});
`);
    expect(report.findings.map((f) => f.rule)).toEqual(["no-assertion"]);
    expect(report.tests).toBe(1);
  });
});

describe("does not flag working tests", () => {
  it("Playwright hooks and options are not tests, and test.describe is a suite", () => {
    const report = scanSource("a.spec.ts", `
      test.beforeEach(async ({ page }) => { await page.goto("/"); });
      test.afterAll(() => { cleanup(); });
      test.use({ viewport: null });
      test.describe("group", () => {
        test("real", async ({ page }) => { await expect(page).toHaveTitle("x"); });
        test("fake", async () => {});
      });`);
    expect(report.tests).toBe(2);
    expect(report.findings.map((f) => [f.rule, f.test])).toEqual([["no-assertion", "fake"]]);
  });

  it.each(["expect(f()).true;", "expect(f()).false;", "expect(f()).not.undefined;", "expect(f()).is.false;", "expect(f()).to.be.true;", "expect(xs).not.empty;"])(
    "accepts the Chai property %s",
    (line) => {
      expect(rules(`it("x", () => { ${line} });`)).not.toContain("dangling-expect");
    },
  );

  it.each(["expect(channel).toBeDefined;", "expect(file.label, 'File');", "expect(xs[0].endsWith('a'));"])("still flags %s", (line) => {
    expect(rules(`it("x", () => { ${line} });`)).toContain("dangling-expect");
  });

  it("accepts an expect() that is stored, and used later", () => {
    expect(rules(`it("x", () => { const result = expect(run()); result.toBe(1); });`)).not.toContain("dangling-expect");
  });

  it("treats two calls as a repeatability check: a warning, not 'can't fail'", () => {
    const [finding] = scanSource("a.test.ts", `it("x", () => { expect(get()).toBe(get()); });`).findings;
    expect(finding).toMatchObject({ rule: "tautology", severity: "warn" });
    expect(finding.message).toContain("repeatability");
  });

  it("accepts .not with two calls: each call must give a new object", () => {
    expect(rules(`it("x", () => { expect(make()).not.toBe(make()); });`)).toEqual([]);
  });

  it("still flags a value compared with itself", () => {
    const [finding] = scanSource("a.test.ts", `it("x", () => { const a = f(); expect(a).toBe(a); });`).findings;
    expect(finding).toMatchObject({ rule: "tautology", severity: "error" });
  });

  it("accepts assert.ok(false), a deliberate failure", () => {
    expect(rules(`it("x", () => { f(); assert.ok(false, "must not get here"); });`)).toEqual([]);
  });

  it("a spy with no mock implementation calls the real method", () => {
    const code = `import { vi } from "vitest"; import { store } from "./store";
      it("x", () => { const s = vi.spyOn(store, "assign"); expect(store.assign(1)).toBe(2); expect(s).toHaveBeenCalledWith(1); });`;
    expect(rules(code)).toEqual([]);
  });

  it.each([
    `vi.spyOn(store, "assign").mockReturnValue(2);`,
    `const s = vi.spyOn(store, "assign"); s.mockReturnValue(2);`,
  ])("a spy that replaces the method is a mock: %s", (setup) => {
    const code = `import { vi } from "vitest"; import { store } from "./store";
      it("x", () => { ${setup} expect(store.assign(1)).toBe(2); });`;
    expect(rules(code)).toContain("tests-the-mock");
  });

  it("follows helpers in the same file, also through other helpers", () => {
    const code = `const check = (a) => { expect(f(a)).toBe(1); };
      function roundTrip(a) { check(a); }
      it("x", () => { roundTrip(1); });`;
    expect(rules(code)).toEqual([]);
  });
});

describe("finds more tests that can't fail", () => {
  it.each(["it.only", "test.only", "fit"])("%s hides the other tests", (name) => {
    expect(rules(`${name}("x", () => { expect(f()).toBe(1); });`)).toEqual(["focused-test"]);
  });

  it("flags describe.only and still checks the tests inside", () => {
    expect(rules(`describe.only("s", () => { it("x", () => {}); });`).sort()).toEqual(["focused-test", "no-assertion"]);
  });

  it.each(["it.skipIf(true)", "it.runIf(false)"])("%s never runs", (name) => {
    expect(rules(`${name}("x", () => { expect(f()).toBe(1); });`)).toEqual(["never-runs"]);
  });

  it("accepts a real condition: a platform check is fine", () => {
    expect(rules(`it.skipIf(process.platform === "win32")("x", () => { expect(f()).toBe(1); });`)).toEqual([]);
  });

  it("warns about it.fails", () => {
    expect(rules(`it.fails("x", () => { expect(f()).toBe(1); });`)).toEqual(["inverted-test"]);
  });

  it("warns about a return before every assertion", () => {
    expect(rules(`it("x", () => { const r = f(); if (r) return; expect(r).toBe(1); });`)).toEqual(["conditional-assertion"]);
    expect(rules(`it("x", () => { const r = f(); expect(r).toBe(1); if (r) return; expect(r).toBe(2); });`)).toEqual([]);
  });

  it.each([`for (const x of []) expect(f(x)).toBe(1);`, `[].forEach((x) => expect(f(x)).toBe(1));`])("flags a loop over nothing: %s", (body) => {
    expect(rules(`it("x", () => { ${body} });`)).toEqual(["never-runs"]);
  });

  it("accepts a loop over real cases", () => {
    expect(rules(`it("x", () => { for (const x of [1, 2]) expect(f(x)).toBe(x); });`)).toEqual([]);
  });

  it.each(["toEqual(expect.any(Number))", "toEqual(expect.anything())", "toBeGreaterThanOrEqual(0)", "not.toBe(null)", "not.toEqual(undefined)"])("warns about expect(f()).%s", (m) => {
    expect(rules(`it("x", () => { expect(f()).${m}; });`)).toEqual(["weak-assertion"]);
  });

  it("accepts an exact number, and a real exclusion", () => {
    expect(rules(`it("x", () => { expect(f()).toBeGreaterThanOrEqual(5); expect(g()).not.toBe(3); });`)).toEqual([]);
  });

  it("warns when a snapshot is the only check", () => {
    expect(rules(`it("x", () => { expect(f()).toMatchSnapshot(); });`)).toEqual(["snapshot-only"]);
    expect(rules(`it("x", () => { expect(f()).toMatchSnapshot(); expect(g()).toBe(1); });`)).toEqual([]);
  });

  it("does not accept a helper because of its name when its body checks nothing", () => {
    expect(rules(`function assertNothing() {} it("x", () => { assertNothing(); });`)).toEqual(["no-assertion"]);
  });

  it("flags a stored .resolves that nothing awaits", () => {
    expect(rules(`it("x", () => { const p = expect(q).resolves.toBe(2); });`)).toEqual(["floating-assertion"]);
    expect(rules(`it("x", async () => { const p = expect(q).resolves.toBe(2); await p; });`)).toEqual([]);
  });
});

describe("the new rules leave working tests alone", () => {
  it("a variable named fit is not a focused test", () => {
    const report = scanSource("a.test.ts", `const fit = vi.fn(); it("x", () => { fit.mockClear(); expect(f(fit)).toBe(1); });`);
    expect(report.findings).toEqual([]);
  });

  it.each([`test.skip(!RUN, "needs a server");`, `test.skip();`, `test.skip(process.platform === "win32");`])("a run-time skip is not a skipped test: %s", (line) => {
    const report = scanSource("a.spec.ts", `test.beforeAll(() => { ${line} }); test("x", async () => { expect(await f()).toBe(1); });`);
    expect(report.findings).toEqual([]);
  });

  it("still warns about a named skipped test", () => {
    expect(rules(`test.skip("named", async () => { expect(await f()).toBe(1); });`)).toEqual(["skipped-test"]);
  });

  it("a return after a visible skip hides nothing", () => {
    expect(rules(`test("x", async () => { if (!repo) { test.skip(true, "no repo"); return; } expect(await f()).toBe(1); });`)).toEqual([]);
  });

  it("a bare fit() call is not a focused test", () => {
    expect(rules(`function fit() {} it("x", () => { fit(); expect(f()).toBe(1); });`)).toEqual([]);
  });

  it("a try around a local helper may be the test: it does not swallow an assertion", () => {
    const code = `function must(a) { if (!a) throw new Error("no"); }
      it("x", () => { let caught; try { must(0); } catch (e) { caught = e; } expect(caught.message).toBe("no"); });`;
    expect(rules(code)).toEqual([]);
  });

  it("a local helper that throws is a check", () => {
    expect(rules(`function must(a) { if (!a) throw new Error("no"); } it("x", () => { must(f()); });`)).toEqual([]);
  });

  it("a local helper with an assertion name and a body keeps the trust that its name gives", () => {
    expect(rules(`async function assertExits(run) { await run(); } it("x", () => assertExits(f));`)).toEqual([]);
  });
});
