# Testing rules (canfail)

A test that cannot fail proves nothing. Follow these rules for every test you write or change.

1. Run the real code. Mock only what you cannot run in a test: the network, paid APIs, the clock, randomness, email, the file system. Never mock the module the test is about.
2. Assert on the result: what the code returns or changes. Do not call a mock yourself and then check that mock.
3. Assert the exact value, worked out by hand. Not `toBeDefined()`, `toBeTruthy()` or `typeof`.
4. Test each boundary: `>= 100` needs a test at 100 and one just under.
5. Await every async assertion. Use `expect(() => f()).toThrow()`, not an `expect` inside `catch`.
6. When a test fails, suspect the code first. Never change an expected value to match output you did not check.
7. Never skip, delete or weaken a failing test to get a green run. Tell the user instead.

Before you say the tests pass, run `npx github:ykakade/canfail` from the project root. It flags tests that cannot fail, then plants bugs in the code you changed and counts how many the tests catch. For each bug that survives, write a test that fails on it.

Report the numbers: "Tests: 19 pass. canfail: caught 10 of 10 planted bugs." Never write "all tests pass" alone.
