# Using the checker

The checker needs Node 18+. Examples below use `canfail` as shorthand for `npx github:ykakade/canfail` (or `node skills/canfail/scripts/canfail.cjs` inside this repo).

## Commands

```text
canfail [test paths]        scan, then prove
canfail scan [test paths]   read tests and flag ineffective patterns
canfail prove [src paths]   mutate source and run your test command
canfail rules               list scan rules and suggested fixes
canfail restore             restore source from an interrupted run
```

With no command, canfail runs both checks. Scan errors do not stop `prove` from running; they still make the overall result fail.

`scan` reads JavaScript and TypeScript tests, including Vitest, Jest, Mocha/Chai, `node:test`/`node:assert`, and AVA patterns. It looks for `.test.*`, `.spec.*`, and files inside `__tests__`. Without paths it prefers uncommitted test files, then falls back to all test files it can find.

`prove` also targets JavaScript and TypeScript source. Without paths, it looks for uncommitted source files reachable through relative imports from tests. If none are found, it uses source files the tests import directly. It does not compare a branch against `main` or resolve every bundler alias. Pass explicit paths when the defaults do not match the change you want to check.

## Options

```text
--cmd <command>      test command (default: npm test)
--files <a,b,...>    explicit source files for prove
--bugs <n|all>       how many mutations to try (default: 10)
--seed <n>           seed for the mutation sample (default: 1)
--timeout <ms>       limit per test run (default: 3x baseline, at least 10s)
--min-score <0-100>  required percentage caught (default: 100)
--json               JSON output for tools and agents
-h, --help           usage
-v, --version        version
```

The sample spreads mutations across types and lines. The same source and seed give the same sample. Changing the source can change the sample even with the same seed. If there are fewer candidates than requested, canfail tries them all.

```bash
# Scan only a test directory. No source changes or test runs.
canfail scan tests/

# Choose the source and runner explicitly.
canfail prove src/cart.ts --cmd "npx vitest run"

# Try every available mutation in a small module.
canfail prove src/cart.ts --bugs all --cmd "npm test"
```

`--cmd` supports a `{file}` placeholder during mutation runs. There is a current limitation: the baseline receives the command unchanged. Only use a wrapper that also handles the literal `{file}` argument and exercises the intended tests in that case. Otherwise, use a fixed test command as in the examples above.

## Reading the result

The test command runs once on the original source. If that baseline fails, canfail stops. It then edits one mutation into the source, runs the command, and restores the file before trying the next one.

| Result | Meaning |
|---|---|
| `caught` | The command exited with a nonzero code. |
| `survived` | The command still passed. Review the changed line for a missing check. |
| `caught (timeout)` | The command exceeded the time limit. Counted as caught in the score. |

The score is the percentage caught, including timeouts. It does not distinguish assertion failures from type errors, build failures, or unrelated failures. For runners such as ts-jest, type checking can reject a mutation before a test exercises it. Use a runtime-only test command when you want to measure assertions, and run type checks separately.

A survivor is not automatically a request for a new test. Check whether the mutation can change supported behavior, and whether an existing case can cover it. Report harmless mutations with a reason. The [README](../README.md#limits) explains the limits of the score.

| Exit code | Meaning |
|---|---|
| `0` | No scan errors, and the score meets `--min-score` if `prove` ran. Warnings do not fail the command. |
| `1` | Scan errors, or a score below the threshold. |
| `2` | The check could not run, such as a failing baseline, bad option, or missing source. |

The Claude Code hook only scans the test file just written or edited. It returns error findings to the agent; it does not run mutation testing or block on warnings.

## Ignoring a finding

Put a comment on the affected line or immediately above it. Name the rule and give a reason:

```ts
// canfail-ignore tautology: documents a JavaScript numeric behavior
expect(0.1 + 0.2).not.toBe(0.3);
```

In source code, `// canfail-ignore` prevents mutations on that line. The mutation engine already avoids imports, types, log calls, and error messages. See the [scan rule catalog](../skills/canfail/references/fake-tests.md) for examples.

## Source recovery

`prove` edits files in place. It saves the original text in a journal under the system temporary directory and restores it after each mutation, on normal exit, Ctrl-C, and SIGTERM.

After `kill -9` or another interruption that prevents cleanup, run this from the same project directory:

```bash
canfail restore
```

A new `prove` run also attempts recovery first. Avoid concurrent edits or parallel `prove` runs in the same checkout: restoration writes the saved original text back.

## CI

Use explicit source paths in CI. Automatic discovery sees uncommitted changes, not the diff of a checked-out pull request. For example, these steps check a cart module with a 20-mutation sample and an 80% threshold:

```yaml
# Steps within a Node job, after actions/setup-node.
- uses: actions/checkout@v4
- run: npm ci
- run: npx github:ykakade/canfail scan tests/
- run: npx github:ykakade/canfail prove src/cart.ts --cmd "npm test" --bugs 20 --min-score 80
```

Replace the example paths with yours. Pin the GitHub package reference to a reviewed commit for repeatable CI runs.
