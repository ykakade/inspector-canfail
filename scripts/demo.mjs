// npm run demo: the README numbers, live. Runs canfail on two test suites for the same code.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = path.join(root, "examples/checkout");
const cli = path.join(root, "skills/canfail/scripts/canfail.cjs");

const step = (title, args) => {
  console.log(`\n\x1b[1;36m▸ ${title}\x1b[0m\n\x1b[2m$ canfail ${args.join(" ")}\x1b[0m\n`);
  spawnSync("node", [cli, ...args], { cwd, stdio: "inherit", env: { ...process.env, FORCE_COLOR: "1" } });
};

step("1/3  Scan the agent-style suite for tests that can't fail", ["scan", "tests/before"]);
step("2/3  Plant 10 bugs. Does the agent-style suite catch them?", ["prove", "src/checkout.ts", "--cmd", "npx vitest run tests/before"]);
step("3/3  Same 10 bugs, against the honest suite", ["prove", "src/checkout.ts", "--cmd", "npx vitest run tests/after"]);
