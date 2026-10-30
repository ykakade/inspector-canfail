import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CODE = /\.[cm]?[jt]sx?$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST = /[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", "out"]);

export const toPosix = (file: string) => file.split(path.sep).join("/");

export const isCodeFile = (file: string) => CODE.test(file) && !DECLARATION.test(file);
export const isTestFile = (file: string) => isCodeFile(file) && TEST.test(toPosix(file));
export const isSourceFile = (file: string) => isCodeFile(file) && !isTestFile(file);

export function walkDir(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkDir(full, out);
    } else if (isCodeFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Expands files, folders and comma lists into absolute code file paths. */
export function expand(targets: string[], cwd: string): string[] {
  const files = new Set<string>();
  for (const target of targets.flatMap((t) => t.split(",")).filter(Boolean)) {
    const full = path.resolve(cwd, target);
    if (!existsSync(full)) throw new Error(`Not found: ${target}`);
    if (statSync(full).isDirectory()) walkDir(full).forEach((f) => files.add(f));
    else files.add(full);
  }
  return [...files].sort();
}

/** Files changed since the last commit, plus untracked files. Null outside a git repo. */
export function gitChanged(cwd: string): string[] | null {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let root: string;
  try {
    root = git("rev-parse", "--show-toplevel").trim();
  } catch {
    return null;
  }
  let tracked = "";
  try {
    tracked = git("diff", "--name-only", "HEAD");
  } catch {
    tracked = git("diff", "--name-only", "--cached"); // no commits yet
  }
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))]
    .map((f) => path.join(root, f))
    .filter((f) => existsSync(f) && !f.split(path.sep).some((part) => SKIP_DIRS.has(part)))
    .sort();
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Resolves a relative import like `../src/cart` or `./cart.js` to a file on disk. */
export function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => stem + ext),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}
