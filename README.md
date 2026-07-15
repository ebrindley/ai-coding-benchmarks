# AI Coding Benchmarks

A public reference set of benchmark scenarios for evaluating AI coding models
and agentic coding tools on small but realistic software engineering tasks.

This is **not** a leaderboard, an endorsement of any tool, or a
community-maintained benchmark suite. It is a fixed, reusable set of tasks,
starting fixtures, and validators that you can run against any coding agent to
compare results yourself.

## What's Included

- `benchmarks/cli-comparison/tasks/` — greenfield and brownfield task specs.
- `benchmarks/cli-comparison/fixtures/` — starting codebases for the tasks.
- `benchmarks/cli-comparison/oracles/` — validators for checks beyond ordinary
  build/test commands.
- `benchmarks/cli-comparison/suite.yaml` — the default task list.
- `schemas/` — versioned contracts for suite/task YAML and optional harness
  experiment, trial, campaign-manifest, and report documents.
- `harness/` — **optional** local Node.js harness (`aicb`) for experiment
  expansion, confined gate execution, resume, and sanitized export.

The portable corpus under `benchmarks/` remains runner-neutral. The harness is
optional tooling in the same repository; it does not change pull-request or
governance posture.

## Optional harness

Install dependencies (only runtime dependency: `yaml`):

```bash
npm install
```

Quiet CLI:

```bash
npx aicb self-validate
npx aicb run --experiment ./path/to/experiment.json --corpus ./benchmarks
npx aicb summary --campaign /path/to/campaign
npx aicb export --campaign /path/to/campaign --out /path/to/bundle
```

Experiment arms must name an explicit `invocationPath`:

- `poetic-adapter` — argv-safe `poetic provider invoke --request … --output …`
- `native-cli` — harness-driven command/args from the arm (not task YAML)
- `poetic-system` — harness-driven Poetic system path

The harness never silently aggregates results across different invocation
paths, resolved model ids, or posture fingerprints. Raw provider output is
treated as secret-bearing, quarantined under the campaign directory, excluded
from default sanitized export, and should not be committed. Upload/publish of
results remains external to this repository.

Tests and self-validation use fake executables only; they do not call live
providers or download fixture dependencies.

## Running a Task (manual, harness-independent)

Each task YAML lists the fixture to start from, the constraints, the expected
outcome, and the gates that must pass. A typical manual run:

1. Copy the referenced fixture into a temporary working directory.
2. Have an agent complete the task from its description.
3. Run the task's eligibility gate commands.
4. Run any task-specific oracle in `oracles/`.
5. Inspect the diff to confirm the constraints were respected.

## Toolchain

Some fixtures require local tooling: Node.js + npm (JS/TS), Python 3.9+,
Java 17 + Maven, and SQLite. Generated artifacts (`node_modules/`, `.venv/`,
`dist/`, Maven `target/`, SQLite database files) should not be committed.

## Contributing & Governance

This repository is owned and maintained solely by its author.

- Forking, copying, and adapting are allowed under the [MIT License](LICENSE).
- **Pull requests are not accepted.** (Unchanged by the optional harness.)
- Feedback, suggestions, corrections, and bug reports are welcome via
  [Issues](../../issues).
- Submitted suggestions may be used, adapted, or declined at the author's
  discretion.

## License

[MIT](LICENSE) © 2026 Ed Brindley
