# Protocol (written before any run; do not change after results exist)
Question: does the canfail skill + hook + checker make Claude Code write tests that catch more bugs?
Conditions, same model, same prompt, same files:
- generic: Claude Code with no user settings, plugins or MCP.
- canfail: same, plus `.claude/skills/canfail` and a PostToolUse scan hook in `.claude/settings.json`.
Tasks: 6 clean modules + 2 modules with one seeded bug that contradicts the written requirements. 3 runs per task per condition = 48.
Prompt: "Add tests for src/<module>.ts. The requirements are in REQUIREMENTS.md. Run the tests and tell me the result when you are done."
Primary metric: hand-written held-out bugs caught (agent never sees them; not derived from canfail's mutation operators). A bug is caught when a test that passes on the correct code fails on the bugged code.
Secondary: seeded bug found / pinned into a test; tests written; share of tests that catch no held-out bug; time; cost; whether canfail ran.
Validity check: a hand-written oracle suite must pass on correct code and catch every held-out bug, or the bug is fixed before the first run.
Rules: report every run. No task, bug or prompt changes after the first real run. Infrastructure failures may be re-run and must be disclosed.
Known limits: small sample; the author of the tasks also reviewed canfail; JS/TS only; one model.

# Addendum: Experiment 2 (written after Experiment 1 tied at 219/219, before any Experiment 2 run)
Experiment 1 hit a ceiling: every run scored 100%, so it could not separate the conditions. It stays reported as is.
Experiment 2 is exploratory and is the last one. Same tasks, bugs, conditions and scoring, canfail code unchanged.
Changes: terse prompt "Add a quick test for src/<module>.ts so this module has coverage."; two models, Sonnet 5.5 and Haiku 5.5. 3 runs per task, condition and model = 96 runs.
Primary metric unchanged: held-out bugs caught. Report both models. No more experiments to look for a difference.

# Addendum: rerun on canfail 0.2.0 (written before the rerun)
This is a regression check of the fixed version, not a new experiment. Same tasks, bugs, prompts, models and scoring: labels y1, y2s, y2h. Only the canfail group runs, so the comparison with the generic group crosses two days and is not a controlled test.
The first attempt hit a usage limit: all 72 runs failed at $0 and were discarded, then all 72 were run again. The runner now stops on a failed run, and the scorer refuses errored runs.
