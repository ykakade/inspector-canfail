---
name: canfail
description: >
  Stops fake tests: tests that mock the code they test, check their own mocks,
  or cannot fail for any other reason. Use whenever you write, fix, change or
  review tests, when a test fails and you are about to edit it, and before you
  tell the user that tests pass. Also use when the user says "canfail", "fake
  tests", "are these tests real", "mutation test", or "prove the tests work".
license: MIT
---

# canfail

A test that cannot fail proves nothing. "All tests pass" is not evidence until you have seen the tests catch a bug.

This skill has two parts: rules for writing tests, and a checker that proves the tests work. The checker is `scripts/canfail.cjs` in this skill's folder. It needs only Node 18+.

## Rules for every test you write

1. **Run the real code.** Mock only what you cannot run in a test: the network, paid APIs, the clock, randomness, email, the file system. Never mock the module the test is about.
2. **Assert on the result.** Check what the code returns or changes. Do not call a mock yourself and then check that mock.
3. **Assert the exact value.** `toBe(37.4)`, not `toBeDefined()`, `toBeTruthy()` or `typeof x === "number"`. Work out the expected value by hand, from the requirement, not from the output.
4. **Test the edges.** Add a test at each boundary: `>= 100` needs a test at exactly 100 and one just under it.
5. **Await every async assertion.** `await expect(p).rejects.toThrow()`. Use `expect(() => f()).toThrow()`, not `try/catch` with an `expect` in the `catch`.
6. **When a test fails, suspect the code first.** Read the failure. Never change an expected value to match output you did not check by hand.
7. **Never skip, delete or weaken a failing test to get a green run.** If you think the test is wrong, tell the user why. Let the user decide.

## Prove it before you say "done"

Run from the project root. `<skill>` is the folder of this file.

```bash
node <skill>/scripts/canfail.cjs                    # scan, then prove
node <skill>/scripts/canfail.cjs scan tests/        # static check, about 1 second
node <skill>/scripts/canfail.cjs prove src/cart.ts  # plant 10 bugs, run the tests 10 times
```

- **scan** reads the test files and flags 12 patterns of tests that cannot fail. It does not run anything.
- **prove** plants one bug at a time in the source (flips `>=` to `>`, deletes a call, changes a constant), runs the test command, and counts the bugs the tests catch. It always puts the source back, also after Ctrl-C. If a run was killed with `kill -9`, run `canfail restore`.

By default, prove targets the source files you changed (git) that the tests reach, and runs `npm test`. Set them yourself when you need to: `--files src/a.ts,src/b.ts --cmd "npx vitest run"`. Use `--json` to read the results as data.

## The loop

1. Run `scan`. Fix every error. Read `canfail rules` for the fix of each rule.
2. Run `prove`. For each `survived` bug, the report shows the line before and after.
3. Write a test that fails with that bug and passes without it. Do not change the source to make the bug go away.
4. Run `prove` again with the same `--seed`. Repeat until every bug is caught.
5. If a surviving bug cannot change behavior (an equivalent mutant, such as `x >= 0` vs `x > 0` when `x` is never 0), do not write a test for it. Delete the dead code, or name the bug in your report and say why.

## How to report

Report the numbers. Never write "all tests pass" alone.

> Tests: 19 pass. canfail scan: 0 errors. canfail prove: caught 10 of 10 planted bugs.

If you could not reach 10 of 10, say which bugs survived and why.

## Excuses and the facts

| Excuse | Fact |
|---|---|
| "Mocking the module keeps the test fast and isolated." | It replaces the code under test. The test now checks the mock. Mock its dependencies instead. |
| "The test fails, so the expected value must be wrong." | Maybe. Maybe the code is wrong. Work out the value by hand before you change anything. |
| "`toHaveBeenCalled()` proves the code works." | Only if real code made the call. If the test made the call, it proves nothing. |
| "I'll skip this one test for now." | A skipped test still shows a green run. The user reads green as "it works." |
| "The code is too hard to test without mocking everything." | Mock the boundary (the gateway, the clock), call the real function, and assert its output. If that is still hard, tell the user. |
| "Coverage is 100%, so the tests are good." | Coverage counts the lines that ran. It does not count the lines that were checked. `prove` does. |

## Red flags: stop and read this skill again

- You wrote `vi.mock` or `jest.mock` with the path of the file you are testing.
- Your test calls a `vi.fn()` and then asserts on that same `vi.fn()`.
- You are about to change an expected value because a test failed.
- You typed `.skip`, `xit`, or deleted a test while the suite was red.
- Every assertion in a test is `toBeDefined()`, `toBeTruthy()` or `not.toThrow()`.
- You are about to write "all tests pass" and you did not run `prove`.

More bad and good examples, one per rule: [references/fake-tests.md](references/fake-tests.md).
