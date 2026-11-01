import { compact, parse, position, ts } from "./ast.js";

export type Operator =
  | "equality"
  | "boundary"
  | "arithmetic"
  | "logical"
  | "negation"
  | "condition"
  | "boolean"
  | "number"
  | "string"
  | "remove-call"
  | "method"
  | "update"
  | "nullish"
  | "optional-chain"
  | "await"
  | "return-value"
  | "remove-throw"
  | "remove-filter";

/** One planted bug: replace `start..end` of `file` with `replacement`. */
export interface Mutant {
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
  operator: Operator;
}

const SWAP: Partial<Record<ts.SyntaxKind, [string, Operator]>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["!==", "equality"],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["===", "equality"],
  [ts.SyntaxKind.EqualsEqualsToken]: ["!=", "equality"],
  [ts.SyntaxKind.ExclamationEqualsToken]: ["==", "equality"],
  [ts.SyntaxKind.LessThanToken]: ["<=", "boundary"],
  [ts.SyntaxKind.LessThanEqualsToken]: ["<", "boundary"],
  [ts.SyntaxKind.GreaterThanToken]: [">=", "boundary"],
  [ts.SyntaxKind.GreaterThanEqualsToken]: [">", "boundary"],
  [ts.SyntaxKind.PlusToken]: ["-", "arithmetic"],
  [ts.SyntaxKind.MinusToken]: ["+", "arithmetic"],
  [ts.SyntaxKind.AsteriskToken]: ["/", "arithmetic"],
  [ts.SyntaxKind.SlashToken]: ["*", "arithmetic"],
  [ts.SyntaxKind.PercentToken]: ["*", "arithmetic"],
  [ts.SyntaxKind.PlusEqualsToken]: ["-=", "arithmetic"],
  [ts.SyntaxKind.MinusEqualsToken]: ["+=", "arithmetic"],
  [ts.SyntaxKind.AmpersandAmpersandToken]: ["||", "logical"],
  [ts.SyntaxKind.BarBarToken]: ["&&", "logical"],
  [ts.SyntaxKind.QuestionQuestionToken]: ["&&", "nullish"],
};

// A Map, not an object: `x.toString()` must not find Object.prototype.toString.
const METHOD_SWAP = new Map<string, string>([
  ["min", "max"],
  ["max", "min"],
  ["floor", "ceil"],
  ["ceil", "floor"],
  ["some", "every"],
  ["every", "some"],
  ["startsWith", "endsWith"],
  ["endsWith", "startsWith"],
  ["toUpperCase", "toLowerCase"],
  ["toLowerCase", "toUpperCase"],
  ["padStart", "padEnd"],
  ["padEnd", "padStart"],
  ["trimStart", "trimEnd"],
  ["trimEnd", "trimStart"],
]);

/** Every bug canfail can plant in this file, in source order. */
export function findMutants(file: string, text: string): Mutant[] {
  const sf = parse(file, text);
  const lines = text.split("\n");
  const out: Mutant[] = [];

  const add = (start: number, end: number, replacement: string, operator: Operator) => {
    const original = text.slice(start, end);
    if (original === replacement) return;
    const { line, column } = position(sf, start);
    if (/canfail-ignore/.test(lines[line - 1] ?? "") || /canfail-ignore-next-line/.test(lines[line - 2] ?? "")) return;
    out.push({ file, line, column, start, end, original, replacement, operator });
  };

  const visit = (node: ts.Node): void => {
    if (skipSubtree(node)) return;

    if (ts.isBinaryExpression(node)) {
      const swap = SWAP[node.operatorToken.kind];
      if (swap && !(swap[1] === "arithmetic" && isStringConcat(node))) {
        add(node.operatorToken.getStart(sf), node.operatorToken.end, swap[0], swap[1]);
      }
    } else if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.ExclamationToken && !isNot(node.operand) && !isNot(node.parent)) {
        add(node.getStart(sf), node.operand.getStart(sf), "", "negation");
      } else if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        const start = node.getStart(sf);
        add(start, start + 2, node.operator === ts.SyntaxKind.PlusPlusToken ? "--" : "++", "update");
      }
    } else if (ts.isPostfixUnaryExpression(node)) {
      add(node.end - 2, node.end, node.operator === ts.SyntaxKind.PlusPlusToken ? "--" : "++", "update");
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      add(node.getStart(sf), node.end, node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true", "boolean");
    } else if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (Number.isFinite(value)) {
        add(node.getStart(sf), node.end, Number.isInteger(value) ? String(value + 1) : "0", "number");
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isMutableString(node)) {
        const quote = node.getText(sf)[0];
        add(node.getStart(sf), node.end, node.text === "" ? `${quote}canfail${quote}` : `${quote}${quote}`, "string");
      }
    } else if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const cond = ts.isIfStatement(node) ? node.expression : node.condition;
      // `if (!x)` already gets the negation bug; `!(!x)` would be the same bug twice.
      if (!isNot(cond)) add(cond.getStart(sf), cond.end, `!(${cond.getText(sf)})`, "condition");
    } else if (ts.isExpressionStatement(node)) {
      const expr = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
      if (ts.isCallExpression(expr) && expr.expression.kind !== ts.SyntaxKind.SuperKeyword && !skipSubtree(expr)) {
        add(node.getStart(sf), node.end, ";", "remove-call");
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const swap = METHOD_SWAP.get(node.name.text);
      if (swap) add(node.name.getStart(sf), node.name.end, swap, "method");
      // `xs.filter(f)` becomes `xs`: the filter is gone, the types still line up.
      else if (node.name.text === "filter" && !node.questionDotToken) add(node.parent.getStart(sf), node.parent.end, node.expression.getText(sf), "remove-filter");
    } else if (ts.isAwaitExpression(node)) {
      add(node.getStart(sf), node.expression.getStart(sf), "", "await");
    } else if (ts.isReturnStatement(node) && node.expression) {
      add(node.expression.getStart(sf), node.expression.end, "undefined", "return-value");
    } else if (ts.isThrowStatement(node)) {
      add(node.getStart(sf), node.end, ";", "remove-throw");
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) {
      const token = node.questionDotToken;
      const dotKeeps = ts.isPropertyAccessExpression(node);
      add(token.getStart(sf), token.end, dotKeeps ? "." : "", "optional-chain");
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function applyMutant(text: string, m: Mutant): string {
  return text.slice(0, m.start) + m.replacement + text.slice(m.end);
}

/** The source line before and after the bug, trimmed, for reports. */
export function mutantLines(text: string, m: Mutant): { before: string; after: string } {
  const lineStart = text.lastIndexOf("\n", m.start - 1) + 1;
  const lineEndRaw = text.indexOf("\n", m.end);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const before = text.slice(lineStart, lineEnd);
  const after = text.slice(lineStart, m.start) + m.replacement + text.slice(m.end, lineEnd);
  // Multi-line statements: show the first line only.
  const shown = after.split("\n")[0].trim();
  return { before: before.split("\n")[0].trim(), after: shown === ";" || shown === "" ? "(call deleted)" : shown };
}

/** What a test must check to catch this bug. Agents read this in the JSON output. */
export function mutantHint(m: Mutant): string {
  const hints: Record<Operator, string> = {
    equality: "Check one input where the two sides are equal and one where they differ.",
    boundary: "Check the exact boundary value and the value just past it.",
    arithmetic: "Assert an exact computed value, worked out from the requirement.",
    logical: "Check an input where only one of the two conditions is true.",
    negation: "Check both outcomes of this condition.",
    condition: "Check both outcomes of this condition.",
    boolean: "Assert the exact boolean or the behavior it controls.",
    number: "Assert a result that depends on this exact constant.",
    string: "Assert the exact text.",
    "remove-call": "Assert the effect of this call: a state change or a call to a boundary.",
    method: "Use an input where the two methods give different results.",
    update: "Assert the value after this update, not only that the code ran.",
    nullish: "Check this expression with null or undefined, and with a real value.",
    "optional-chain": "Check this expression with a null or undefined value.",
    await: "Assert the awaited result, or the order of the async work.",
    "return-value": "Assert the exact return value.",
    "remove-throw": "Assert that this input throws: expect(() => f()).toThrow().",
    "remove-filter": "Use an input with items the filter must remove.",
  };
  return hints[m.operator];
}

/**
 * Picks `count` mutants. The pick is the same for the same seed, spreads over
 * operators, and avoids two bugs on one line, so 10 bugs mean 10 different checks.
 */
export function pickMutants(all: Mutant[], bugs: number | "all", seed: number): Mutant[] {
  const count = bugs === "all" ? all.length : bugs;
  const rand = mulberry32(seed);
  const buckets = new Map<string, Mutant[]>();
  for (const m of all) {
    const list = buckets.get(m.operator) ?? [];
    list.push(m);
    buckets.set(m.operator, list);
  }
  const operators = shuffle([...buckets.keys()].sort(), rand);
  for (const op of operators) shuffle(buckets.get(op)!, rand);

  const lineKey = (m: Mutant) => `${m.file}:${m.line}`;
  const usedLines = new Set<string>();
  const picked: Mutant[] = [];
  for (let progress = true; progress; ) {
    progress = false;
    for (const op of operators) {
      if (picked.length >= count) break;
      const list = buckets.get(op)!;
      const index = list.findIndex((m) => !usedLines.has(lineKey(m)));
      if (index === -1) continue;
      const [m] = list.splice(index, 1);
      usedLines.add(lineKey(m));
      picked.push(m);
      progress = true;
    }
  }
  // Fewer free lines than bugs asked for: fill up with the rest.
  const rest = shuffle(all.filter((m) => !picked.includes(m)), rand);
  picked.push(...rest.slice(0, count - picked.length));
  return picked.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
}

function skipSubtree(node: ts.Node): boolean {
  if (
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeNode(node) ||
    ts.isDecorator(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return true;
  }
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const callee = compact(node.expression);
    // Logging and error messages are noise: changing them is rarely a bug a user would see.
    if (/^console\./.test(callee) || /^(logger|log|debug)\b/.test(callee)) return true;
    if (ts.isNewExpression(node) && /Error$/.test(callee)) return true;
  }
  if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)) return true; // "use strict"
  return false;
}

function isNot(node: ts.Node): boolean {
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
}

function isStringConcat(node: ts.BinaryExpression): boolean {
  const isText = (e: ts.Expression) =>
    ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e);
  return node.operatorToken.kind === ts.SyntaxKind.PlusToken && (isText(node.left) || isText(node.right));
}

function isMutableString(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const p = node.parent;
  if ("name" in p && p.name === node) return false; // { "key": 1 }, class { "p" = 1; "m"() {} }
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return false;
  if (ts.isJsxAttribute(p) || ts.isLiteralTypeNode(p)) return false;
  if (ts.isCallExpression(p) && (compact(p.expression) === "require" || p.expression.kind === ts.SyntaxKind.ImportKeyword)) {
    return false;
  }
  return true;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(list: T[], rand: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
