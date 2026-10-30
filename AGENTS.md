# Testing rules (canfail)

Write tests that protect behavior worth keeping. Before adding one, name the mistake it would catch and check whether an existing test already covers it. Extend that test when possible. Do not add tests of trivial wiring, language features, or a mock's own behavior just to increase the count.

1. Run the real implementation. Fake external boundaries when needed: network, payments, email, the clock, randomness. Never replace the module under test with a mock.
2. Assert on what the code returns, changes, or sends to a boundary. Do not call a mock yourself and then check that mock.
3. Derive expected values from the requirement, not the current output. Use specific values where they matter; an existence check is not enough to test a calculation.
4. Check meaningful edges and failure paths. For `>= 100`, include exactly 100 and a value just below it. Avoid cases that repeat the same protection.
5. Await or return async assertions. Use `expect(() => f()).toThrow()` rather than asserting only inside `catch`.
6. Investigate a failure before editing the test. Never copy unchecked output into the expected value.
7. Never skip, delete, or weaken a failing test to get a green run. If the test is wrong, explain why.

When writing or changing JavaScript/TypeScript tests, run `npx github:ykakade/inspector-canfail scan` from the project root, then `npx github:ykakade/inspector-canfail prove` on the relevant source with a non-watch test command. The checker also runs locally as `node skills/canfail/scripts/canfail.cjs` in this repo.

For each surviving mutation, inspect whether it changes supported behavior. Cover real gaps, preferably in an existing test. Explain harmless mutations; do not add useless assertions to reach a score. Scan findings are heuristics and need review too.

Report the tests run, scan errors and warnings, mutations caught and survived, and anything not checked. A caught mutation can be a type error or timeout; do not present the score as proof of correctness.
