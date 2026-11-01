# Using the checker

The checker needs Node 18+. Examples below use `canfail` as shorthand for `npx github:ykakade/inspector-canfail` (or `node skills/canfail/scripts/canfail.cjs` inside this repo).

## Commands

```text
canfail [test paths]        scan, then prove
canfail scan [test paths]   read tests and flag ineffective patterns
canfail prove [src paths]   mutate source and run your test command
canfail rules               list scan rules and suggested fixes
canfail restore             restore source from an interrupted --in-place run
canfail demo                show a fake test and a real test, no project needed
```

With no command, canfail runs both checks. Scan errors do not stop `prove` from running; they still make the overall result fail.

`scan` reads JavaScript and TypeScript tests, including Vitest, Jest, Mocha/Chai, `node:test`/`node:assert`, and AVA patterns. It looks for `.test.*`, `.spec.*`, and files inside `__tests__`. Without paths it prefers uncommitted test files, then falls back to all test files it can find.

`prove` also targets JavaScript and TypeScript source. Without paths, it looks for uncommitted source files reachable through relative imports from tests. If none are found, it uses source files the tests import directly. It does not resolve every bundler alias, so pass explicit paths when the defaults do not match. To check a branch, use `--since main`.

A `scan` with no test files exits with code 2, because scanning nothing is not a pass. A file that you name counts as a test file. Inside a folder that you name, `test/`, `tests/`, `spec/` and `__tests__/` also count.

## Options

```text
--cmd <command>      test command (default: npm test)
--files <a,b,...>    explicit source files for prove
--bugs <n|all>       how many mutations to try (default: 10)
--seed <n>           seed for the mutation sample (default: 1)
--timeout <ms>       limit per test run (default: 3x baseline, at least 10s)
--min-score <0-100>  required percentage caught (default: 100)
--since <ref>        only changed test files, and mutations only on lines changed since <ref>
--lcov <file>        coverage report: mutations on lines no test runs need no test run
--jobs <n>           test runs at the same time, each in its own copy (default: 1)
--in-place           edit the real files, not a temporary copy
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

`--cmd` supports a `{file}` placeholder. For a mutation run, it becomes the file with the mutation. For a clean run, it becomes all the selected files.

## Reading the result

The test command runs in a temporary copy of the project, without `.git`. If the tests need the real directory, use `--in-place`.

`prove` makes these checks before it plants mutations:

1. The tests pass two times on the original source. If they fail, it stops with exit code 2, because a flaky test looks like a caught mutation.
2. For each file, it adds a thrown error at the top and runs the tests. If they still pass, no test loads that file. It reports the file and does not count it in the score.

After the mutations, the tests must pass one more time, or the results are rejected.

| Result | Meaning |
|---|---|
| `caught` | A test failed. |
| `survived` | The command still passed. Review the changed line for a missing check. |
| `caught (timeout)` | The command exceeded the time limit. Counted as caught in the score. |
| `crashed` | The command failed, but no test failed, as with a compile error. Not in the score. |
| `uncovered` | The `--lcov` report shows that no test runs this line. Counted as not caught. No test run is needed. |

canfail reads the failure summary of Vitest, Jest, `node:test`, Mocha, and Bun, and `AssertionError` from plain scripts. If it cannot read a summary from the clean run, any failed command counts as `caught`.

`--json` gives a `hint` for each mutation: what a test must check to catch it.

A survivor is not automatically a request for a new test. Check whether the mutation can change supported behavior, and whether an existing case can cover it. Report harmless mutations with a reason. The [README](../README.md#faq) explains the limits of the score.

| Exit code | Meaning |
|---|---|
| `0` | No scan errors, and the score meets `--min-score` if `prove` ran. Warnings do not fail the command. |
| `1` | Scan errors, or a score below the threshold. |
| `2` | The check could not run, such as a failing baseline, bad option, or missing source. |

The Claude Code hooks do not run mutation testing or block on warnings. One hook scans each test file just after the agent writes it. A second hook runs when the agent stops: it scans all changed test files, which includes files written through Bash. It stops the agent one time only, so the agent cannot get stuck.

## Ignoring a finding

Put a comment on the affected line or immediately above it. Name the rule and give a reason:

```ts
// canfail-ignore tautology: documents a JavaScript numeric behavior
expect(0.1 + 0.2).not.toBe(0.3);
```

In source code, `// canfail-ignore` prevents mutations on that line. The mutation engine already avoids imports, types, log calls, and error messages. See the [scan rule catalog](../skills/canfail/references/fake-tests.md) for examples.

## Source recovery

By default, `prove` does not change your files. With `--in-place`, it edits them, keeps a record in `~/.cache/canfail`, and restores them after each mutation, on normal exit, Ctrl-C, and SIGTERM.

After `kill -9` or another interruption that prevents cleanup, run this from the same project directory:

```bash
canfail restore
```

A new `prove` run also attempts recovery first. Recovery removes only the exact mutation that canfail wrote. If a file has other changes, canfail keeps the file and tells you.

## CI

The action checks the lines that a pull request changes, writes a summary, and can add a comment to the pull request:

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write # only for comment: true
jobs:
  canfail:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --since needs the history
      - uses: actions/setup-node@v4
      - run: npm ci
      - uses: ykakade/inspector-canfail@main # pin this to a reviewed commit
        with:
          cmd: npm test
          bugs: 20
          min-score: 80
          comment: true
```

Inputs: `cmd`, `since` (default: the base branch of the pull request), `bugs`, `min-score`, `jobs`, and `comment`.

Without the action, use the commands:

```yaml
- run: npx github:ykakade/inspector-canfail scan tests/
- run: npx github:ykakade/inspector-canfail prove --since origin/main --cmd "npm test" --bugs 20 --min-score 80
```
