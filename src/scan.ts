import path from "node:path";
import {
  compact,
  innermostCall,
  isFunctionLike,
  isLiteral,
  parse,
  position,
  rootIdentifier,
  ts,
  unwrap,
  walk,
} from "./ast.js";

export type Severity = "error" | "warn";

export const RULES = {
  "mocks-subject": {
    severity: "error",
    summary: "The file mocks the module it is named after, so the tests run the mock.",
    fix: "Delete the mock of the module under test. Mock only its dependencies.",
  },
  "everything-mocked": {
    severity: "error",
    summary: "Every project module the file imports is mocked. No real code runs.",
    fix: "Import at least one real module and test it. Mock only boundaries: network, clock, disk.",
  },
  "tests-the-mock": {
    severity: "error",
    summary: "The test calls a mock itself and checks the mock. The code under test never runs.",
    fix: "Call the real function. Assert on what it returns, or on how it used the mock.",
  },
  "no-assertion": {
    severity: "error",
    summary: "The test has no assertion. It passes unless the code throws.",
    fix: "Assert the exact result the test name promises.",
  },
  tautology: {
    severity: "error",
    summary: "The assertion compares constants, or a value with itself. It is always true.",
    fix: "Compare the real output with a value you worked out by hand.",
  },
  "dangling-expect": {
    severity: "error",
    summary: "expect() has no matcher call, so it checks nothing.",
    fix: "Call a matcher: expect(x).toBe(y). Note the parentheses.",
  },
  "swallowed-failure": {
    severity: "error",
    summary: "The assertion is inside try, and catch swallows its failure.",
    fix: "Remove the try/catch, or rethrow in catch.",
  },
  "unchecked-throw": {
    severity: "error",
    summary: "The test asserts only inside catch. It passes when nothing throws.",
    fix: "Use expect(() => fn()).toThrow(...) or await expect(p).rejects.toThrow(...).",
  },
  "floating-assertion": {
    severity: "error",
    summary: "The assertion runs after the test ends (no await, no return).",
    fix: "await the promise, or return it from the test.",
  },
  "skipped-test": {
    severity: "warn",
    summary: "The test is skipped. It does not run, but the run still looks green.",
    fix: "Make the test pass for real, or delete it and tell the user why.",
  },
  "weak-assertion": {
    severity: "warn",
    summary: "Only weak checks like toBeDefined(). They pass for almost any value.",
    fix: "Assert the exact expected value.",
  },
  "conditional-assertion": {
    severity: "warn",
    summary: "Every assertion is inside an if. When the condition is false, nothing is checked.",
    fix: "Assert the condition itself, then assert unconditionally.",
  },
} as const satisfies Record<string, { severity: Severity; summary: string; fix: string }>;

export type RuleId = keyof typeof RULES;

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: RuleId;
  severity: Severity;
  message: string;
  test?: string;
}

export interface FileReport {
  file: string;
  tests: number;
  /** Tests with an error: they can't fail. */
  fake: number;
  /** Tests with only warnings: they can fail, but barely. */
  weak: number;
  findings: Finding[];
}

export interface ScanResult {
  files: FileReport[];
  tests: number;
  fake: number;
  weak: number;
  errors: number;
  warnings: number;
}

interface Assertion {
  node: ts.Node;
  kind: "expect" | "assert" | "helper" | "fail";
  subject?: ts.Expression;
  matcher?: string;
  modifiers: string[];
  args: readonly ts.Expression[];
  /** expect() chains only: false when no matcher is called. */
  valid?: boolean;
}

interface TestCase {
  call: ts.CallExpression;
  name: string;
  fn?: ts.ArrowFunction | ts.FunctionExpression;
  skipped: boolean;
}

const TEST_NAMES = new Set(["it", "test"]);
const SKIPPED_TEST_NAMES = new Set(["xit", "xtest"]);
const SUITE_NAMES = new Set(["describe", "suite", "context"]);
const SKIPPED_SUITE_NAMES = new Set(["xdescribe", "xcontext"]);

const MOCK_FACTORIES = new Set([
  "vi.fn",
  "jest.fn",
  "vi.spyOn",
  "jest.spyOn",
  "mock.fn",
  "t.mock.fn",
  "sinon.stub",
  "sinon.spy",
  "sinon.fake",
  "mock",
  "mockDeep",
]);
const MODULE_MOCKS = new Set(["vi.mock", "vi.doMock", "jest.mock", "jest.doMock", "jest.unstable_mockModule", "mock.module"]);
const MOCK_API = /^(mock[A-Z]\w*|returns|resolves|rejects|callsFake|withArgs|calledWith|reset|restore)$/;
const WEAK_MATCHERS = new Set(["toBeDefined", "toBeTruthy", "toBeFalsy", "toBeTypeOf", "toBeInstanceOf"]);
const WEAK_NEGATED = new Set(["toBeNull", "toBeUndefined", "toThrow", "toBeFalsy", "toBeNaN"]);
const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toBeCloseTo", "equal", "eql", "deepEqual"]);
const CONST_MATCHERS = new Set(["toBeTruthy", "toBeFalsy", "toBeDefined", "toBeUndefined", "toBeNull", "toBeNaN"]);
const ASSERT_EQUALITY = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "is", "same"]);
const CONTEXT_ASSERTIONS = new Set([
  "is", "not", "deepEqual", "notDeepEqual", "like", "true", "false", "truthy", "falsy", "throws", "throwsAsync",
  "notThrows", "notThrowsAsync", "regex", "notRegex", "snapshot", "assert", "equal", "notEqual", "ok", "notOk",
  "same", "notSame", "match", "strictEqual", "deepStrictEqual", "rejects", "resolves", "fail", "pass",
]);
const HELPER = /^(expect|assert|verify|check|ensure|should)[A-Z_$]/;
const DEFERRED = new Set(["setTimeout", "setImmediate", "queueMicrotask", "process.nextTick"]);

/** Statically finds tests that cannot fail. */
export function scanSource(file: string, text: string): FileReport {
  const sf = parse(file, text);
  const findings: Finding[] = [];
  const add = (node: ts.Node, rule: RuleId, message: string, test?: string, severity?: Severity) => {
    const at = node.getStart(sf);
    const { line, column } = position(sf, at);
    if (ignored(text, sf, at, rule)) return;
    findings.push({ file, line, column, rule, severity: severity ?? RULES[rule].severity, message, test });
  };

  const tests = collectTests(sf);
  const mocks = collectMocks(sf, file);

  // File level: modules replaced by mocks.
  const subject = subjectName(file);
  for (const mock of mocks.modules) {
    if (mock.key && path.basename(mock.key).toLowerCase() === subject) {
      add(
        mock.call,
        "mocks-subject",
        mock.partial
          ? `${mock.call.expression.getText()}("${mock.spec}") replaces parts of the module this file tests.`
          : `${mock.call.expression.getText()}("${mock.spec}") replaces the module this file tests.`,
        undefined,
        mock.partial ? "warn" : "error",
      );
    }
  }
  const fullyMocked = new Set(mocks.modules.filter((m) => !m.partial && m.key).map((m) => m.key!));
  const realImports = mocks.imports.filter((i) => i.key);
  const subjectFlagged = findings.some((f) => f.rule === "mocks-subject" && f.severity === "error");
  if (
    realImports.length > 0 &&
    realImports.every((i) => fullyMocked.has(i.key!)) &&
    !(subjectFlagged && realImports.every((i) => path.basename(i.key!).toLowerCase() === subject))
  ) {
    add(realImports[0].node, "everything-mocked", `Every module this file imports is mocked. No real code runs.`);
  }
  const fileLevelError = findings.some((f) => f.severity === "error");

  // Test level.
  let fake = 0;
  let weak = 0;
  for (const t of tests) {
    const before = findings.length;
    if (t.skipped) {
      add(t.call.expression, "skipped-test", `Skipped. It never runs, and the run still looks green.`, t.name);
    } else if (t.fn) {
      checkTest(t, sf, mocks, (node, rule, message, severity) => add(node, rule, message, t.name, severity));
    } else {
      continue;
    }
    const own = findings.slice(before);
    if (fileLevelError || own.some((f) => f.severity === "error")) {
      // An error says enough. Drop this test's warnings to keep the report short.
      const keep = own.filter((f) => f.severity === "error");
      findings.splice(before, own.length, ...keep);
      fake++;
    } else if (own.length > 0) {
      weak++;
    }
  }

  return { file, tests: tests.filter((t) => t.fn || t.skipped).length, fake, weak, findings };
}

function checkTest(
  t: TestCase,
  sf: ts.SourceFile,
  mocks: Mocks,
  add: (node: ts.Node, rule: RuleId, message: string, severity?: Severity) => void,
) {
  const fn = t.fn!;
  const contextParam = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : undefined;
  const hasDone = contextParam !== undefined && /^(done|cb|callback|next)$/.test(contextParam);
  const assertions = collectAssertions(fn.body, contextParam);
  const usesAssertionCount = /expect\s*\.\s*(assertions|hasAssertions)\s*\(/.test(fn.body.getText());

  // no-assertion
  if (assertions.length === 0) {
    const empty = ts.isBlock(fn.body) && fn.body.statements.length === 0;
    add(t.call.expression, "no-assertion", empty ? `Empty test. It checks nothing.` : `No assertion. It passes unless the code throws.`);
    return;
  }

  for (const a of assertions) {
    // dangling-expect
    if (a.valid === false) {
      const shown = a.node.getText().replace(/\s+/g, " ");
      add(a.node, "dangling-expect", `\`${short(shown)}\` never calls a matcher, so it checks nothing.`);
      continue;
    }
    // tautology
    const taut = tautology(a);
    if (taut) add(a.node, "tautology", taut);
    // floating-assertion
    const floating = floatingReason(a, fn, hasDone);
    if (floating) add(a.node, "floating-assertion", floating);
  }

  // swallowed-failure and unchecked-throw
  const inTry = assertions.filter((a) => enclosingTry(a.node, fn)?.where === "try");
  for (const a of inTry) {
    const tryStmt = enclosingTry(a.node, fn)!.stmt;
    const handler = tryStmt.catchClause?.block;
    if (handler && !rethrows(handler)) {
      add(a.node, "swallowed-failure", `This assertion is inside try, and the catch block swallows its failure.`);
    }
  }
  const inCatch = assertions.filter((a) => enclosingTry(a.node, fn)?.where === "catch");
  if (inCatch.length > 0 && inCatch.length === assertions.filter((a) => a.kind !== "fail").length && !usesAssertionCount) {
    const tryStmt = enclosingTry(inCatch[0].node, fn)!.stmt;
    if (!rethrows(tryStmt.tryBlock)) {
      add(inCatch[0].node, "unchecked-throw", `Assertions run only inside catch. If nothing throws, the test passes.`);
    }
  }

  // tests-the-mock: every assertion is about a mock the test called itself,
  // or about a mock when the test calls no real code at all.
  const direct = directMockCalls(fn.body, mocks);
  const real = callsRealCode(fn.body, mocks);
  const locals = mockDerivedLocals(fn.body, mocks);
  const aboutMock = (a: Assertion) =>
    (a.kind === "expect" || a.kind === "assert") &&
    a.subject !== undefined &&
    (isAboutDirectMock(a.subject, direct, mocks, locals) || (!real && isMockSubject(a.subject, mocks)));
  if (assertions.every(aboutMock)) {
    const names = [...direct].slice(0, 2).map((n) => `\`${n}\``).join(" and ");
    add(
      assertions[0].node,
      "tests-the-mock",
      direct.size > 0
        ? `Calls the mock ${names} itself, then checks it. No real code runs.`
        : `Checks a mock, but calls no real code that could use it.`,
    );
  }

  // weak-assertion
  const expects = assertions.filter((a) => a.valid);
  if (expects.length === assertions.length && expects.every(isWeak)) {
    const label = (a: Assertion) =>
      a.subject && ts.isTypeOfExpression(unwrap(a.subject))
        ? `typeof … ${a.matcher}()`
        : `${a.modifiers.includes("not") ? "not." : ""}${a.matcher}()`;
    const names = [...new Set(expects.map(label))].join(", ");
    add(expects[0].node, "weak-assertion", `Only weak checks (${names}). They pass for almost any value.`);
  }

  // conditional-assertion
  if (assertions.every((a) => insideIf(a.node, fn))) {
    add(assertions[0].node, "conditional-assertion", `Every assertion is inside an if. When it is false, nothing is checked.`);
  }
}

// ---------------------------------------------------------------- tests

function collectTests(sf: ts.SourceFile): TestCase[] {
  const tests: TestCase[] = [];
  const visit = (node: ts.Node, suiteSkipped: boolean): void => {
    if (ts.isCallExpression(node)) {
      const kind = classify(node);
      if (kind) {
        const fn = node.arguments.find(isFunctionLike);
        const nameArg = node.arguments[0];
        const name =
          nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg))
            ? nameArg.text
            : nameArg && !isFunctionLike(nameArg)
              ? nameArg.getText()
              : "(unnamed)";
        if (kind.type === "suite") {
          if (kind.skipped && !suiteSkipped) {
            tests.push({ call: node, name, skipped: true });
          }
          if (fn) visit(fn.body, suiteSkipped || kind.skipped);
          return;
        }
        if (kind.type === "test" && !kind.todo) {
          if (suiteSkipped) return;
          tests.push({ call: node, name, fn: kind.skipped ? undefined : fn, skipped: kind.skipped });
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, suiteSkipped));
  };
  visit(sf, false);
  return tests;
}

function classify(call: ts.CallExpression): { type: "test" | "suite"; skipped: boolean; todo: boolean } | undefined {
  const names: string[] = [];
  let cur: ts.Expression = call.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      names.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression; // it.each(table)(name, fn)
    } else break;
  }
  if (!ts.isIdentifier(cur)) return undefined;
  const base = cur.text;
  const skipped = names.includes("skip") || SKIPPED_TEST_NAMES.has(base) || SKIPPED_SUITE_NAMES.has(base);
  const todo = names.includes("todo");
  if (TEST_NAMES.has(base) || SKIPPED_TEST_NAMES.has(base)) return { type: "test", skipped, todo };
  if (SUITE_NAMES.has(base) || SKIPPED_SUITE_NAMES.has(base)) return { type: "suite", skipped, todo };
  return undefined;
}

// ---------------------------------------------------------------- assertions

function collectAssertions(body: ts.Node, contextParam: string | undefined): Assertion[] {
  const out: Assertion[] = [];
  walk(body, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "should") {
      out.push({ node, kind: "expect", modifiers: [], args: [] });
      return "skip";
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const calleeText = compact(callee);

    if (calleeText === "expect" || calleeText === "expect.soft" || calleeText === "expect.poll") {
      out.push(expectChain(node));
      return;
    }
    if (calleeText === "fail" || calleeText === "expect.unreachable" || calleeText === "expect.fail") {
      out.push({ node, kind: "fail", modifiers: [], args: node.arguments });
      return;
    }
    const root = rootIdentifier(callee);
    if (root === "assert" || calleeText.startsWith("sinon.assert.")) {
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : "assert";
      out.push({
        node,
        kind: method === "fail" ? "fail" : "assert",
        matcher: method,
        subject: node.arguments[0],
        modifiers: [],
        args: node.arguments.slice(1),
      });
      return;
    }
    if (
      contextParam &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === contextParam &&
      CONTEXT_ASSERTIONS.has(callee.name.text)
    ) {
      out.push({ node, kind: "assert", matcher: callee.name.text, subject: node.arguments[0], modifiers: [], args: node.arguments.slice(1) });
      return;
    }
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (HELPER.test(name) || name === "expect") {
      out.push({ node, kind: "helper", modifiers: [], args: node.arguments });
    }
  });
  return out;
}

function expectChain(call: ts.CallExpression): Assertion {
  const names: string[] = [];
  let node: ts.Node = call;
  let top: ts.Node = call;
  let lastWasCall = false;
  for (;;) {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) {
      names.push(p.name.text);
      node = top = p;
      lastWasCall = false;
    } else if (ts.isCallExpression(p) && p.expression === node) {
      node = top = p;
      lastWasCall = true;
    } else break;
  }
  const chai = names.includes("to") || names.includes("be");
  const matcher = names[names.length - 1];
  const valid = chai
    ? names.length >= 2
    : lastWasCall && matcher !== undefined && !["not", "resolves", "rejects"].includes(matcher);
  return {
    node: top,
    kind: "expect",
    subject: call.arguments[0],
    matcher,
    modifiers: names.slice(0, -1),
    args: lastWasCall && ts.isCallExpression(top) ? top.arguments : [],
    valid,
  };
}

function tautology(a: Assertion): string | undefined {
  if (!a.subject) return undefined;
  const subject = unwrap(a.subject);
  if (a.kind === "expect" && a.matcher) {
    if (CONST_MATCHERS.has(a.matcher) && isLiteral(subject)) {
      return `\`expect(${short(subject.getText())}).${a.matcher}()\` checks a constant. It is always the same.`;
    }
    if (EQUALITY_MATCHERS.has(a.matcher) && a.args[0]) {
      const expected = unwrap(a.args[0]);
      if (isLiteral(subject) && isLiteral(expected)) {
        return `Compares two constants (${short(subject.getText())} and ${short(expected.getText())}). No code runs.`;
      }
      if (compact(subject) === compact(expected)) {
        return `Compares \`${short(subject.getText())}\` with itself. It is always equal.`;
      }
    }
  }
  if (a.kind === "assert") {
    if ((a.matcher === "assert" || a.matcher === "ok" || a.matcher === "true") && isLiteral(subject)) {
      return `\`${short(a.node.getText())}\` checks a constant.`;
    }
    if (a.matcher && ASSERT_EQUALITY.has(a.matcher) && a.args[0]) {
      const expected = unwrap(a.args[0]);
      if ((isLiteral(subject) && isLiteral(expected)) || compact(subject) === compact(expected)) {
        return `\`${short(a.node.getText())}\` compares a value that cannot change.`;
      }
    }
  }
  return undefined;
}

function isWeak(a: Assertion): boolean {
  if (!a.matcher) return false;
  const negated = a.modifiers.includes("not");
  if (negated) return WEAK_NEGATED.has(a.matcher);
  if (WEAK_MATCHERS.has(a.matcher)) return true;
  if (a.matcher === "toHaveBeenCalled" || a.matcher === "toHaveProperty") return a.args.length <= 1;
  if (a.matcher === "toBe" && a.subject && ts.isTypeOfExpression(unwrap(a.subject))) return true;
  return false;
}

function floatingReason(a: Assertion, fn: ts.Node, hasDone: boolean): string | undefined {
  // expect(p).resolves.toBe(x) without await / return
  if (a.kind === "expect" && (a.modifiers.includes("resolves") || a.modifiers.includes("rejects"))) {
    if (ts.isExpressionStatement(a.node.parent)) {
      return `\`.${a.modifiers.includes("resolves") ? "resolves" : "rejects"}\` returns a promise, and nothing awaits it. The test ends first.`;
    }
  }
  // assertion inside .then() or setTimeout() that nothing waits for
  for (let node: ts.Node = a.node; node && node !== fn; node = node.parent) {
    if (!isFunctionLike(node) || !ts.isCallExpression(node.parent)) continue;
    const call = node.parent;
    const callee = compact(call.expression);
    if (DEFERRED.has(callee) && !hasDone) {
      return `This assertion runs inside ${callee}() after the test has ended.`;
    }
    if (ts.isPropertyAccessExpression(call.expression) && ["then", "catch", "finally"].includes(call.expression.name.text)) {
      let top: ts.Node = call;
      while (
        (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top) ||
        (ts.isCallExpression(top.parent) && top.parent.expression === top)
      ) {
        top = top.parent;
      }
      if (ts.isExpressionStatement(top.parent) && !hasDone) {
        return `This assertion runs in .${call.expression.name.text}() on a promise nobody awaits. The test ends first.`;
      }
    }
  }
  return undefined;
}

function enclosingTry(node: ts.Node, stop: ts.Node): { stmt: ts.TryStatement; where: "try" | "catch" } | undefined {
  let child = node;
  for (let cur = node.parent; cur && cur !== stop; child = cur, cur = cur.parent) {
    if (isFunctionLike(cur) || ts.isFunctionDeclaration(cur)) return undefined;
    if (ts.isTryStatement(cur)) {
      if (child === cur.tryBlock) return { stmt: cur, where: "try" };
      if (child === cur.catchClause) return { stmt: cur, where: "catch" };
    }
  }
  return undefined;
}

function rethrows(block: ts.Node): boolean {
  let found = false;
  walk(block, (node) => {
    if (ts.isThrowStatement(node)) found = true;
    if (ts.isCallExpression(node)) {
      const callee = compact(node.expression);
      if (callee === "fail" || callee === "expect.unreachable" || callee === "assert.fail" || callee === "expect" || callee === "expect.fail") {
        found = true;
      }
    }
  });
  return found;
}

function insideIf(node: ts.Node, stop: ts.Node): boolean {
  let child = node;
  for (let cur = node.parent; cur && cur !== stop; child = cur, cur = cur.parent) {
    if (ts.isIfStatement(cur) && child !== cur.expression) return true;
    if (ts.isConditionalExpression(cur) && child !== cur.condition) return true;
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === cur.right) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- mocks

interface ModuleMock {
  call: ts.CallExpression;
  spec: string;
  key?: string;
  partial: boolean;
}

interface Mocks {
  /** Exact paths that hold a mock, like `send` or `db.save`. */
  paths: Set<string>;
  /** Prefixes from `import * as api` of a mocked module, like `api.`. */
  prefixes: string[];
  modules: ModuleMock[];
  imports: { node: ts.Node; spec: string; key?: string }[];
}

function collectMocks(sf: ts.SourceFile, file: string): Mocks {
  const mocks: Mocks = { paths: new Set(), prefixes: [], modules: [], imports: [] };

  const addObject = (prefix: string, obj: ts.ObjectLiteralExpression) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
      const key = `${prefix}.${prop.name.getText().replace(/^["']|["']$/g, "")}`;
      const value = unwrap(prop.initializer);
      if (isMockFactory(value)) mocks.paths.add(key);
      else if (ts.isObjectLiteralExpression(value)) addObject(key, value);
    }
  };
  const record = (target: string, init: ts.Expression) => {
    const value = unwrap(init);
    if (isMockFactory(value)) {
      mocks.paths.add(target);
      const spied = spyTarget(value);
      if (spied) mocks.paths.add(spied);
    } else if (ts.isObjectLiteralExpression(value)) {
      addObject(target, value);
    }
  };

  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      record(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      record(compact(node.left), node.right);
    }
    if (ts.isCallExpression(node)) {
      const callee = compact(node.expression);
      const spied = isMockFactory(node) ? spyTarget(node) : undefined;
      if (spied) mocks.paths.add(spied);
      if (callee === "vi.mocked" || callee === "jest.mocked") {
        if (node.arguments[0]) mocks.paths.add(compact(node.arguments[0]));
      }
      if (ts.isPropertyAccessExpression(node.expression) && MOCK_API.test(node.expression.name.text) && /^mock/.test(node.expression.name.text)) {
        mocks.paths.add(compact(node.expression.expression));
      }
      if (MODULE_MOCKS.has(callee) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text;
        const factory = node.arguments[1];
        const partial = !!factory && /importActual|requireActual|importOriginal/.test(factory.getText());
        mocks.modules.push({ call: node, spec, key: moduleKey(spec, file), partial });
      }
      if ((callee === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text;
        mocks.imports.push({ node, spec, key: moduleKey(spec, file) });
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) {
        const spec = node.moduleSpecifier.text;
        mocks.imports.push({ node, spec, key: moduleKey(spec, file) });
      }
    }
  });

  // Names imported from a mocked module are mocks too.
  const mockedKeys = new Set(mocks.modules.filter((m) => !m.partial && m.key).map((m) => m.key));
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
    if (!mockedKeys.has(moduleKey(stmt.moduleSpecifier.text, file))) continue;
    const { name, namedBindings } = stmt.importClause;
    if (name) mocks.paths.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) mocks.prefixes.push(`${namedBindings.name.text}.`);
    if (namedBindings && ts.isNamedImports(namedBindings)) namedBindings.elements.forEach((e) => mocks.paths.add(e.name.text));
  }
  return mocks;
}

function isMockFactory(node: ts.Expression): boolean {
  const call = innermostCall(node);
  return !!call && MOCK_FACTORIES.has(compact(call.expression));
}

function spyTarget(node: ts.Expression): string | undefined {
  const call = innermostCall(node);
  if (!call || !/spyOn$|^sinon\.(stub|spy)$/.test(compact(call.expression))) return undefined;
  const [obj, method] = call.arguments;
  if (obj && method && ts.isStringLiteralLike(method)) return `${compact(obj)}.${method.text}`;
  return undefined;
}

function isMockPath(text: string, mocks: Mocks): boolean {
  return mocks.paths.has(text) || mocks.prefixes.some((p) => text.startsWith(p));
}

/** Mocks the test body calls itself, like `send("hi")` or `await gateway.charge(1)`. */
function directMockCalls(body: ts.Node, mocks: Mocks): Set<string> {
  const out = new Set<string>();
  walk(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = compact(node.expression);
    const last = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : callee;
    if (!MOCK_API.test(last) && isMockPath(callee, mocks)) out.add(callee);
  });
  return out;
}

function isMockCall(expr: ts.Expression, mocks: Mocks): boolean {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return false;
  const callee = compact(e.expression);
  const last = ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text : callee;
  return !MOCK_API.test(last) && isMockPath(callee, mocks);
}

function containsMockCall(node: ts.Expression, mocks: Mocks): boolean {
  let found = false;
  walk(node, (n) => {
    if (found || isFunctionLike(n)) return "skip";
    if (ts.isCallExpression(n) && isMockCall(n, mocks)) found = true;
  });
  return found || (isFunctionLike(node) && !ts.isBlock(node.body) && isMockCall(node.body, mocks));
}

function mockDerivedLocals(body: ts.Node, mocks: Mocks): Set<string> {
  const out = new Set<string>();
  walk(body, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && isMockCall(node.initializer, mocks)) {
      if (ts.isIdentifier(node.name)) out.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) out.add(el.name.text);
        }
      }
    }
  });
  return out;
}

function mockText(subject: ts.Expression): string {
  const text = compact(unwrap(subject));
  return /^(vi|jest)\.mocked\((.+)\)$/.exec(text)?.[2] ?? text;
}

function isMockSubject(subject: ts.Expression, mocks: Mocks): boolean {
  const text = mockText(subject);
  return isMockPath(text, mocks) || [...mocks.paths].some((p) => text.startsWith(`${p}.mock.`));
}

const FRAMEWORK = /^(vi|jest|sinon|mock|expect|assert|console|Promise|Object|Array|JSON|Math|String|Number|Date)\b/;

/** True when the test calls anything besides mocks, assertions and the test framework. */
function callsRealCode(body: ts.Node, mocks: Mocks): boolean {
  let found = false;
  walk(body, (node) => {
    if (found) return "skip";
    if (ts.isNewExpression(node)) found = true;
    if (!ts.isCallExpression(node)) return;
    const callee = compact(node.expression);
    const last = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : callee;
    // FRAMEWORK also covers matcher calls: their callee text starts with "expect(".
    if (FRAMEWORK.test(callee) || MOCK_API.test(last) || isMockPath(callee, mocks)) return;
    found = true;
  });
  return found;
}

function isAboutDirectMock(subject: ts.Expression, direct: Set<string>, mocks: Mocks, locals: Set<string>): boolean {
  const s = unwrap(subject);
  let text = compact(s);
  const mocked = /^(vi|jest)\.mocked\((.+)\)$/.exec(text);
  if (mocked) text = mocked[2];
  for (const name of direct) {
    if (text === name || text.startsWith(`${name}.mock.`)) return true;
  }
  if (containsMockCall(s, mocks)) return true;
  const root = rootIdentifier(ts.isTypeOfExpression(s) ? unwrap(s.expression) : s);
  if (root && locals.has(root)) return true;
  return false;
}

// ---------------------------------------------------------------- helpers

function subjectName(file: string): string {
  const base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, "").replace(/[._-](test|spec)$/, "");
  if (base === "index") return path.basename(path.dirname(file)).toLowerCase();
  return base.toLowerCase();
}

function moduleKey(spec: string, fromFile: string): string | undefined {
  let full: string;
  if (spec.startsWith(".")) full = path.resolve(path.dirname(fromFile), spec);
  else if (/^(@\/|~\/|#|src\/)/.test(spec)) full = spec;
  else return undefined; // a package, not project code
  return full.replace(/\.[cm]?[jt]sx?$/, "").replace(/[/\\]index$/, "");
}

function ignored(text: string, sf: ts.SourceFile, at: number, rule: RuleId): boolean {
  const { line } = sf.getLineAndCharacterOfPosition(at);
  const lines = text.split("\n");
  return [lines[line], lines[line - 1]].some((l) => {
    const m = l && /canfail-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?/.exec(l);
    return !!m && (!m[1] || m[1].split(/\s*,\s*/).includes(rule));
  });
}

function short(text: string, max = 48): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function summarize(files: FileReport[]): ScanResult {
  const all = files.flatMap((f) => f.findings);
  return {
    files,
    tests: files.reduce((n, f) => n + f.tests, 0),
    fake: files.reduce((n, f) => n + f.fake, 0),
    weak: files.reduce((n, f) => n + f.weak, 0),
    errors: all.filter((f) => f.severity === "error").length,
    warnings: all.filter((f) => f.severity === "warn").length,
  };
}
