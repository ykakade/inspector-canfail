# Working on canfail

The skill lives in [`skills/canfail/SKILL.md`](../skills/canfail/SKILL.md). [`AGENTS.md`](../AGENTS.md) is the compact version for project rules files. Keep their guidance consistent.

The checker source is in [`src/`](../src). Its bundled CLI is committed at [`skills/canfail/scripts/canfail.cjs`](../skills/canfail/scripts/canfail.cjs), so an installed skill can run without installing dependencies. The Claude Code plugin and hook load that same bundle.

## Checks

Install development dependencies with `npm ci`. Run these before opening a code change:

```bash
npm test
npm run typecheck
npm run check:bundle
npm run prove:self
```

`check:bundle` rebuilds the CLI and checks that it matches the committed file. If you changed the checker, run `npm run build` and include the updated bundle.

For a new scan rule, include an ineffective test it should flag and a valid test it should leave alone. Prefer small reproductions over large fixtures.

The integration suite checks the demo: 47 passing tests catch none of the 10 sampled mutations, while the 20 behavior tests catch all 10. These are demonstration fixtures, not collected agent benchmark runs. Run `npm run demo` to see the output.

`prove:self` mutates the scanner, mutation engine, and runner against the project's own tests. It skips the two demo mutation runs to avoid nested mutation testing. Review survivors before deciding whether they need a test; the project does not currently catch every self-mutation.

## Recorded self-check

On version 0.2.0, the recorded run caught **123 of 150 mutations (82%)**, with 173 tests running and the demo runs skipped. Seven of the 123 are timeouts. Twenty-seven mutations survived, including checks in the new journal, the flaky-test message, and `??` defaults. This is a historical result, not a live score for the current checkout.

To repeat that sample:

```bash
npm run prove:self -- --bugs 150 --seed 7 --jobs 6
```

Earlier runs found an actual bug: the method-swap lookup was a plain object. A call to `chunk.toString()` could find the inherited `Object.prototype.toString` function and insert it as replacement text. The lookup is now a `Map`, with a regression test. That is the sort of outcome these checks are for; a higher score alone is not the goal.

## Benchmark

[`benchmark/`](../benchmark) holds the tasks, the runner, and the scorer. See [the results](benchmark.md). Do not change a task or a hidden bug and then compare with an old result.

## README language

The README reference material uses ASD-STE100 Issue 9; its opening sections may use the Inspector character voice. Refer to the [writing rules and software terms](writing.md) before you change its text.

## Artwork

[`assets/inspector.png`](../assets/inspector.png) is the README illustration. The image uses a transparent background and opaque white areas inside the portrait.

The [generation prompts](../assets/inspector.prompt.md) record the source of the image. The built-in image generation tool created the image. The character is original. Ponytail is the reference for the compact portrait format.
