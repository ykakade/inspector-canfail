<p align="center">
  <img src="assets/inspector.png" width="200" alt="Inspector Canfail holds an evidence card with an X.">
</p>

<h1 align="center">Inspector Canfail</h1>

<p align="center"><em>She questions the tests. Then she checks their story.</em></p>

<p align="center">
  <img src="https://img.shields.io/github/stars/ykakade/inspector-canfail?style=flat-square&color=111111&label=stars" alt="GitHub stars">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

You know her. Rumpled coat. Looks lost. Your agent says all 47 tests passed.

“Just one question. Can they fail?”

Inspector Canfail treats a fake test as a false witness. It says everything is fine. It was never in a position to see anything.

`scan` questions the witnesses. `prove` stages the crime: one small source change, then a test run to see who noticed.

She looks lost. Your tests should be worried.

Inspector Canfail is a skill and a zero-config JavaScript/TypeScript checker for AI coding agents. The CLI and skill are named `canfail`.

[Install](#install) · [Example](#before-and-after) · [Benchmark](#benchmark) · [Commands](#commands)

## Before and after

The agent adds a test for a shipping function:

```ts
it("returns a shipping cost", () => {
  expect(typeof shipping(50)).toBe("number");
});
```

This test passes with a shipping cost of `0`, `5`, or `500`. It does not find an incorrect cost.

With canfail, the test uses the required values:

```ts
it("gives free shipping at 50", () => {
  expect(shipping(50)).toBe(0);
  expect(shipping(49.99)).toBe(5);
});
```

A change from `>= 50` to `> 50` makes this test fail. The test finds an error at the boundary.

The two examples use the [checkout module](examples/checkout/src/checkout.ts). The [complete tests](examples/checkout/tests/after/checkout.test.ts) also include discounts, tax, payments, and receipts.

## The example results

Two test suites use the same checkout module. The two test suites pass before canfail adds errors.

| Test suite | Tests that pass | Tests that do not run | Errors found |
|---|---:|---:|---:|
| [Tests with incorrect checks](examples/checkout/tests/before) | 47 | 1 | 0 of 10 |
| [Tests of required behavior](examples/checkout/tests/after/checkout.test.ts) | 20 | 0 | 10 of 10 |

This project includes these example test suites. These results do not measure the performance of an AI agent.

Run it yourself:

```bash
git clone https://github.com/ykakade/inspector-canfail
cd inspector-canfail
npm ci
npm run demo
```

The [integration tests](test/cli.test.ts) make sure that these results stay correct.

## Benchmark

We ran Claude Code 144 times on 8 small modules, with and without canfail. Each agent wrote tests. We then scored the tests against bugs that the agents did not see. We wrote these bugs by hand.

<p align="center">
  <img src="assets/canfail-benchmark.png" width="760" alt="Share of hidden bugs caught. Clear spec with Sonnet: 100.0% without canfail, 100.0% with canfail. Terse prompt with Sonnet: 90.0% and 98.6%. Terse prompt with Haiku: 93.2% and 95.4%. Runs with canfail take 2.6 to 3.8 times longer and cost 1.4 to 1.6 times more.">
</p>

Canfail helps most when the prompt is short and the agent does not look for a specification. It gave no improvement when the agent had a clear specification, and it costs time. The image shows version 0.1.0; version 0.2.0 gives similar scores and is slower. In one module, the agents without canfail found a real bug that the agents with canfail did not find. This is a small benchmark. Read the [method and all the results](docs/benchmark.md).

## How it works

`scan` looks for ineffective test patterns without changing source files. `prove` breaks the code on purpose, one mutation at a time, and checks whether the tests fail.

The Inspector's question becomes the agent's rule: name the error a test must catch before adding it.

The agent does these steps before it adds a test:

1. Read the code and the tests.
2. Select an error that a test must find.
3. Examine the tests for this error.
4. If necessary, add a test for that error.
5. Check the tests with canfail.

The test must call your code. A **mock** replaces an external service, such as a payment service or a clock. It must not replace the function under test.

The expected value comes from the requirement. The agent must not copy an incorrect result into an assertion to make a test pass.

The agent must not skip or remove a test because that test fails. It must tell the user about the failure.

### The skill

The instructions are in [`skills/canfail/SKILL.md`](skills/canfail/SKILL.md). The short form is in [`AGENTS.md`](AGENTS.md).

The skill gives the agent rules for test selection. The checker examines the tests. The Claude Code hook starts a scan after the agent writes or changes a test file.

## Install

### Claude Code

Enter this command:

```text
/plugin marketplace add ykakade/inspector-canfail
```

Then, enter this command:

```text
/plugin install canfail@canfail
```

This installs the skill and the hook.

### Other agents

For an agent that supports skills, use this command:

```bash
npx skills add ykakade/inspector-canfail
```

For an agent with a project rules file, add the [short instructions](AGENTS.md) to that file. Keep the other project instructions.

### The checker only

Node 18+ is necessary for the checker. It has no runtime dependencies. It reads JavaScript and TypeScript files.

To examine test files without changes to the source, use this command:

```bash
npx github:ykakade/inspector-canfail scan
```

## Commands

These examples use `canfail` for `npx github:ykakade/inspector-canfail`.

| Command | Function |
|---|---|
| `canfail scan [test paths]` | Find test patterns with incorrect assertions. |
| `canfail prove [source paths]` | Run the tests against small changes to the source code. |
| `canfail rules` | Show the scan rules. |
| `canfail restore` | Restore source files after an interrupted `--in-place` run. |
| `canfail demo` | Show a fake test and a real test. You do not need a project. |

With no command, canfail starts `scan`, then `prove`.

`scan` examines test files without a test run. It finds 16 patterns, such as assertions that do not run and `.only`. It gives warnings for weak assertions and skipped tests. The [rule examples](skills/canfail/references/fake-tests.md) show each pattern.

`prove` changes the source code, one change at a time. Each change is a **mutation**. For example, it can change `>=` to `>` or remove a function call.

`prove` works in a temporary copy of your project. It makes sure that the tests pass two times without mutations, and that the tests load each source file. It then runs the test command for each mutation. It uses up to 10 mutations unless you select a different number.

To check only the lines that changed on a branch, use this command:

```bash
npx github:ykakade/inspector-canfail prove --since main --cmd "npm test"
```

To see a fake test and a real test without a project, use this command:

```bash
npx github:ykakade/inspector-canfail demo
```

To select a source file and a test command, use this command:

```bash
npx github:ykakade/inspector-canfail prove src/cart.ts --cmd "npm test"
```

If the tests pass with a mutation, examine the result. Add a test only if the mutation shows an error in required behavior. Do not add tests only to increase the score.

[All options and CI instructions](docs/cli.md)

## FAQ

**Does canfail change my source files?**

No. `prove` changes a temporary copy of the project. You can continue to work during a run.

If your tests need the real directory, use `--in-place`. Then `prove` changes your files and restores them after each mutation. After a forced stop, use `canfail restore` from the same project directory. `restore` removes only a planted bug. It does not overwrite your later changes.

**Are the tests correct if the score is 100%?**

No. The score shows the result for the mutations in that run. Timeouts increase the score. If canfail cannot read the output of your test runner, other command failures also increase the score. Some mutations do not change required behavior.

**Can a scan result be incorrect?**

Yes. The scan finds code patterns. It does not find all test errors. Examine each result before you change a test.

**Does canfail make an agent write better tests?**

Sometimes. In [our benchmark](docs/benchmark.md), it made no difference when Sonnet had a clear specification: both groups caught all the bugs. With a short prompt, Sonnet caught 98.6% of the bugs with canfail and 90.0% without. With Haiku, the difference was too small to be certain. A run with canfail takes about 3 to 5 times longer.

**When must a test fail?**

A test must fail when the code gives an incorrect result.

## Contributing

Open an issue for an incorrect scan result. Include a small example with the issue.

For code changes, refer to the [development instructions](docs/development.md).

## Credits

The layout of this README uses [Ponytail](https://github.com/DietrichGebert/ponytail) as its model. [Impeccable](https://github.com/pbakaus/impeccable) also shows the skill format for agents.

## License

[MIT](LICENSE)
