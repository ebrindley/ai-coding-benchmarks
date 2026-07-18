# CLI Comparison Benchmark

This benchmark suite contains task specs, fixtures, and oracles for comparing
AI coding agents on small but realistic software engineering tasks.

## Directory Structure

```text
cli-comparison/
  suite.yaml
  tasks/
    greenfield/
    brownfield/
  fixtures/
  oracles/
```

## Task Spec Format

Each task YAML defines:

- `taskId`: unique challenge ID.
- `type`: `greenfield` or `brownfield`.
- `description`: the prompt given to the coding agent.
- `expectedOutcome`: must-have requirements.
- `eligibilityGates`: build/test/lint/oracle checks.
- `fixturePath`: starting codebase, when applicable.
- `tags`: useful labels for filtering.

## Running the whole suite as a comparison

These tasks are **not** meant to be compared one by one — the suite is a single
comprehensive assessment yielding a composite score and per-language /
per-category sub-scores. To compare models, providers, or harnesses across the
whole suite, see [`COMPARISON.md`](COMPARISON.md) and the example experiments in
[`../../examples/`](../../examples/).

## Scoring Guidance

Use pass/fail gate results first. A run should be considered passing only when
all required gates pass and the final diff respects the task constraints.

For qualitative comparison, inspect:

- correctness against tests and oracles,
- whether tests or validators were improperly edited,
- implementation scope,
- maintainability,
- API compatibility,
- security behavior where relevant.

