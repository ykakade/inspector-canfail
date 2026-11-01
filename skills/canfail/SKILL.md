---
name: canfail
description: >
  Helps coding agents avoid useless tests and check that useful tests catch bugs.
  Use when writing, fixing, changing, or reviewing tests; when investigating a
  failing test; or before reporting test results. Also use when the user asks
  for canfail, fake-test checks, mutation testing, or proof that tests work.
license: MIT
---

# canfail

Write tests that protect behavior worth keeping. A passing test is useful when a plausible mistake in the real code would make it fail.

This skill guides test choices. Its checker, `scripts/canfail.cjs`, scans JavaScript/TypeScript tests and mutates source to check for missed bugs. The checker needs Node 18+ and no runtime dependencies.

## Before adding a test

Read the code and the nearby tests. Name the behavior that matters and a mistake the test would catch. If a nearby case already protects it, use or extend that case. Trivial wiring, language features, and a mock's own behavior usually do not need new tests.

Choose tests for actual risk: a boundary, a calculation, a parser, a state change, a failure path, or a security decision. Avoid permutations that add no distinct protection. Do not turn a small change into a new test framework.

## Rules for tests you keep

1. **Run the real implementation.** Fake external boundaries when needed: the network, payment gateway, email, clock, or randomness. Never replace the module under test with a mock.
2. **Check behavior.** Assert on the result, state change, or a meaningful boundary call made by real code. Calling a mock yourself and asserting that call tests nothing about the implementation.
3. **Derive expectations from the requirement.** For a calculation, check a specific value worked out independently. `toBeDefined()` does not check a total. Match assertion precision to the behavior; don't compare incidental details.
4. **Check meaningful edges.** For `>= 100`, test exactly 100 and a value just below. Check relevant failure paths without duplicating every arrangement of the same behavior.
5. **Let assertions finish and fail.** Await or return async assertions. Use `expect(() => f()).toThrow()` or `await expect(p).rejects.toThrow()`. Don't hide assertions in a catch block that may never run or swallow their errors.
6. **Investigate red tests.** Read the failure and check the requirement before changing code or expectations. Never copy an unchecked result into the expected value.
7. **Keep failures visible.** Never skip, delete, or weaken a failing test to make the run green. If the test is wrong, explain the mismatch to the user.

## Check the tests

Run from the project root. `<skill>` below is the directory containing this file.

```bash
node <skill>/scripts/canfail.cjs scan tests/
node <skill>/scripts/canfail.cjs prove src/cart.ts --cmd "npm test"
```

Use paths and a non-watch test command appropriate to the project. With no paths, `scan` prefers uncommitted tests, then all discovered tests. `prove` prefers uncommitted source reachable through relative imports from tests, then source directly imported by tests. Pass explicit paths when checking a committed branch or a project with import aliases.

- **scan** flags 16 ineffective testing patterns without executing tests. Review errors and warnings in context. Run `rules` for suggestions or read [the examples](references/fake-tests.md). A clean scan does not establish that a test is useful.
- **prove** changes one boundary, constant, operator, or call at a time, then runs the test command. The baseline must pass. It samples up to 10 mutations by default; use `--bugs all` for all available candidates. `--json` provides structured results.

`prove` works in a temporary copy of the project, so you can keep working during a run and your files never change. If the tests need the real directory, use `--in-place`; then do not edit those files during the run, and after a forced kill run `restore` from the same project directory. `restore` only removes a planted bug. It never overwrites later work.

For a branch, `--since main` checks only the lines changed since `main`. This is usually the check you want, and it is much faster. `--jobs 4` runs four copies at the same time. `--json` gives a `hint` for each mutation that says what a test must check.

## Review survivors

For each mutation that survives, inspect the before/after line and ask whether it changes supported behavior.

- If it reveals a real gap, add or extend a test that fails with the mutation and passes without it. Keep the production requirement unchanged.
- If it cannot change supported behavior, explain why. Do not invent a test or change a requirement to make the score pass. A justified `// canfail-ignore` on the source line excludes it from future samples.
- If the check cannot run, report the limitation. Do not claim it passed.

Rerun after fixing real gaps. The same source and `--seed` reproduce a sample; changing source can change the sample. A high score is supporting evidence, not the objective.

A run where the command fails but no test failed, such as a compile error, is reported as `crashed` and is not in the score. With a test runner canfail can't read, any failure counts as caught. A timeout counts as caught, so check suspicious catches. `prove` stops with exit code 2 when the tests are flaky, and reports a file that no test loads instead of asking for more tests.

## Report what you checked

Include the test command and result, scan errors and warnings, mutations caught and survived, and any limits. For example:

> Tests: 20 passed. Scan: 0 errors, 0 warnings. Prove: 10 of 10 sampled mutations caught. Only the checkout module was checked.

If mutations survived, say which behavior is unprotected or why a mutation is harmless. If you reused existing tests or added none, say what already covers the change. Don't add tests just to have something to report.
