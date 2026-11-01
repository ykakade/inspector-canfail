import { describe, expect, it } from "vitest";
import { applyMutant, findMutants, type Mutant, mutantLines, pickMutants } from "../src/mutate";

const mutate = (code: string, file = "/repo/src/a.ts") =>
  findMutants(file, code).map((m) => `${m.operator}: ${applyMutant(code, m).trim()}`);

describe("findMutants", () => {
  it("flips equality, boundaries, arithmetic and logic", () => {
    expect(mutate("a === b && c < d;")).toEqual([
      "logical: a === b || c < d;",
      "equality: a !== b && c < d;",
      "boundary: a === b && c <= d;",
    ]);
    expect(mutate("x = a + b * c;")).toEqual(["arithmetic: x = a - b * c;", "arithmetic: x = a + b / c;"]);
    expect(mutate("x = a / b;")).toEqual(["arithmetic: x = a * b;"]);
    expect(mutate("x = a || b;")).toEqual(["logical: x = a && b;"]);
    expect(mutate("x = a >= b ? a % b : a - b;")).toEqual([
      "condition: x = !(a >= b) ? a % b : a - b;",
      "boundary: x = a > b ? a % b : a - b;",
      "arithmetic: x = a >= b ? a * b : a - b;",
      "arithmetic: x = a >= b ? a % b : a + b;",
    ]);
  });

  it("negates conditions, drops !, swaps booleans and bumps numbers", () => {
    expect(mutate("if (!ok) x = true;")).toEqual(["negation: if (ok) x = true;", "boolean: if (!ok) x = false;"]);
    expect(mutate("const n = 0, m = 41, f = 0.5;")).toEqual([
      "number: const n = 1, m = 41, f = 0.5;",
      "number: const n = 0, m = 42, f = 0.5;",
      "number: const n = 0, m = 41, f = 0;",
    ]);
    expect(mutate("if (done) { stop(); }")).toEqual([
      "condition: if (!(done)) { stop(); }",
      "remove-call: if (done) { ; }",
    ]);
  });

  it("empties strings and swaps look-alike methods", () => {
    expect(mutate(`const s = "usd", e = '';`)).toEqual([`string: const s = "", e = '';`, `string: const s = "usd", e = 'canfail';`]);
    expect(mutate("Math.max(a, b);")).toEqual(["remove-call: ;", "method: Math.min(a, b);"]);
    expect(mutate("i++; --j;")).toEqual(["update: i--; --j;", "update: i++; ++j;"]);
    expect(mutate("t += 1;")).toEqual(["arithmetic: t -= 1;", "number: t += 2;"]);
  });

  it("leaves imports, types, logs, error messages and object keys alone", () => {
    const code = [
      `import { a } from "./a";`,
      `export type T = "x" | 1;`,
      `interface I { k: "v" }`,
      `console.log("debug", 1 + 2);`,
      `const o = { "key": v };`,
    ].join("\n");
    expect(mutate(code)).toEqual([]);
    // The message stays, but the throw itself is a bug to plant.
    expect(mutate(`throw new Error("bad input");`)).toEqual(["remove-throw: ;"]);
  });

  it("plants the bugs agents leave behind in new code", () => {
    expect(mutate("v = a ?? b;")).toEqual(["nullish: v = a && b;"]);
    expect(mutate("v = a?.b;")).toEqual(["optional-chain: v = a.b;"]);
    expect(mutate("v = a?.[0];")).toEqual(["optional-chain: v = a[0];", "number: v = a?.[1];"]);
    expect(mutate("v = await f;")).toEqual(["await: v = f;"]);
    expect(mutate("function f() { return x; }")).toEqual(["return-value: function f() { return undefined; }"]);
    expect(mutate("v = xs.filter(f);")).toEqual(["remove-filter: v = xs;"]);
    expect(mutate("function f() { return; }")).toEqual([]);
  });

  it("leaves enums, namespaces and declare blocks alone", () => {
    expect(mutate(`enum Level { Low = 1 }\nnamespace N { export const x = 1; }\nexport declare const y = 2;`)).toEqual([]);
  });

  it("still mutates calls and constructors that only look like logging or errors", () => {
    expect(mutate(`new Money("usd");`)).toEqual([`string: new Money("");`]);
    expect(mutate(`reportError(a + b);`)).toEqual([`remove-call: ;`, `arithmetic: reportError(a - b);`]);
  });

  it("leaves property names and index keys alone", () => {
    expect(mutate(`class A { "p" = 1; "m"() { return o["k"]; } }`)).toEqual([
      `number: class A { "p" = 2; "m"() { return o["k"]; } }`,
      `return-value: class A { "p" = 1; "m"() { return undefined; } }`,
    ]);
  });

  it("ignores methods that only exist on Object.prototype", () => {
    // Tree order: the outer + comes first.
    expect(mutate("s = chunk.toString() + o.valueOf() + o.constructor();")).toEqual([
      "arithmetic: s = chunk.toString() + o.valueOf() - o.constructor();",
      "arithmetic: s = chunk.toString() - o.valueOf() + o.constructor();",
    ]);
  });

  it("mutates exported code, but not the use strict directive", () => {
    expect(mutate(`"use strict";\nexport const fee = 5;`)).toEqual([`number: "use strict";\nexport const fee = 6;`]);
  });

  it("leaves module paths alone but mutates other call arguments", () => {
    expect(mutate(`const m = require("./m");`)).toEqual([]);
    expect(mutate(`send("hi");`)).toEqual([`remove-call: ;`, `string: send("");`]);
  });

  it("skips string concatenation and lines marked canfail-ignore", () => {
    expect(mutate(`const s = "a" + b;`)).toEqual([`string: const s = "" + b;`]);
    expect(mutate(`x = a + 1; // canfail-ignore`)).toEqual([]);
  });

  it("reports 1-based line and column", () => {
    const [m] = findMutants("/a.ts", "let a;\nlet b = a === 1;");
    expect(m).toMatchObject({ line: 2, column: 11, original: "===", replacement: "!==" });
  });
});

describe("mutantLines", () => {
  it("shows the line before and after", () => {
    const code = "function f(a) {\n  return a > 1;\n}\n";
    const m = findMutants("/a.ts", code).find((x) => x.operator === "boundary")!;
    expect(mutantLines(code, m)).toEqual({ before: "return a > 1;", after: "return a >= 1;" });
  });

  it("finds the right line when the bug sits at the end of a line", () => {
    const code = "let a = 1\nlet b = 2\n";
    expect(mutantLines(code, findMutants("/a.ts", code)[0])).toEqual({ before: "let a = 1", after: "let a = 2" });
  });

  it("reads the last line of a file with no newline at the end", () => {
    const code = "let a = 1";
    expect(mutantLines(code, findMutants("/a.ts", code)[0])).toEqual({ before: "let a = 1", after: "let a = 2" });
  });

  it("names a deleted call", () => {
    const code = "save(x);\n";
    expect(mutantLines(code, findMutants("/a.ts", code)[0])).toEqual({ before: "save(x);", after: "(call deleted)" });
  });
});

describe("pickMutants", () => {
  const fake = (line: number, operator: Mutant["operator"]): Mutant => ({
    file: "/a.ts", line, column: 1, start: line * 10, end: line * 10 + 1, original: "x", replacement: "y", operator,
  });
  const all = [
    ...[1, 2, 3, 4, 5, 6].map((l) => fake(l, "number")),
    fake(7, "equality"),
    fake(7, "boundary"),
    fake(8, "string"),
  ];

  it("returns everything for 'all' or a big count", () => {
    expect(pickMutants(all, "all", 1)).toHaveLength(9);
    expect(pickMutants(all, 50, 1)).toHaveLength(9);
    expect(pickMutants(all, 9, 1)).toHaveLength(9);
  });

  it("picks exactly the count asked for", () => {
    for (const n of [1, 2, 3, 4, 5, 8]) expect(pickMutants(all, n, 3)).toHaveLength(n);
  });

  it("gives the same pick for the same seed, and a new pick for a new seed", () => {
    expect(pickMutants(all, 4, 7)).toEqual(pickMutants(all, 4, 7));
    const seeds = new Set([1, 2, 3, 4, 5].map((s) => pickMutants(all, 3, s).map((m) => m.line).join()));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("covers each operator before it repeats one, and uses each line once", () => {
    const picked = pickMutants(all, 3, 1);
    expect(new Set(picked.map((m) => m.line)).size).toBe(3);
    expect(picked.filter((m) => m.operator === "number")).toHaveLength(1);
    expect(picked.filter((m) => m.operator === "string")).toHaveLength(1);
  });

  it("keeps the same pick across versions for seed 1 (README numbers depend on it)", () => {
    expect(pickMutants(all, 4, 1).map((m) => `${m.operator}@${m.line}`)).toEqual([
      "number@1",
      "number@3", // round 2: boundary@7 is blocked (line 7 is taken), so number goes again
      "equality@7",
      "string@8",
    ]);
  });

  it("returns the pick in source order", () => {
    const starts = pickMutants(all, 5, 3).map((m) => m.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
