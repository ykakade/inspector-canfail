import ts from "typescript";

export { ts };

export function parse(file: string, text: string): ts.SourceFile {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(file)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

export function position(sf: ts.SourceFile, at: number): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(at);
  return { line: line + 1, column: character + 1 };
}

/** Source text without whitespace, so `db . save` and `db.save` compare equal. */
export function compact(node: ts.Node): string {
  return node.getText().replace(/\s+/g, "");
}

/** Strips `await`, parentheses, `!`, `as T` and `satisfies T` around an expression. */
export function unwrap(node: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      node = node.expression;
    } else {
      return node;
    }
  }
}

/** The innermost call of a chain: `vi.fn().mockReturnValue(1)` gives `vi.fn()`. */
export function innermostCall(node: ts.Expression): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  let cur: ts.Expression = unwrap(node);
  for (;;) {
    if (ts.isCallExpression(cur)) {
      found = cur;
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else {
      return found;
    }
  }
}

/** The left-most identifier of `a.b.c(...)`. */
export function rootIdentifier(node: ts.Expression): string | undefined {
  let cur: ts.Expression = unwrap(node);
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isCallExpression(cur)) {
      cur = unwrap(cur.expression);
    } else {
      return undefined;
    }
  }
}

export function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void | "skip"): void {
  if (visit(node) === "skip") return;
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function isLiteral(node: ts.Expression): boolean {
  node = unwrap(node);
  if (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node)
  ) {
    return true;
  }
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(node)) return node.text === "undefined" || node.text === "NaN";
  if (ts.isPrefixUnaryExpression(node)) return isLiteral(node.operand);
  if (ts.isBinaryExpression(node)) return isLiteral(node.left) && isLiteral(node.right);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => isLiteral(e as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((p) => ts.isPropertyAssignment(p) && isLiteral(p.initializer));
  }
  return false;
}
