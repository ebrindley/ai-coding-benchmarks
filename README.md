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

It contains no runner/orchestration code, credentials, run logs, or results.

## Running a Task

Each task YAML lists the fixture to start from, the constraints, the expected
outcome, and the gates that must pass. A typical manual run:

1. Copy the referenced fixture into a temporary working directory.
2. Have an agent complete the task from its description.
3. Run the task's eligibility gate commands.
4. Run any task-specific oracle in `oracles/`.
5. Inspect the diff to confirm the constraints were respected.

The harness is left to you, which keeps the suite portable across any coding
agent or CLI.

## Toolchain

Some fixtures require local tooling: Node.js + npm (JS/TS), Python 3.9+,
Java 17 + Maven, and SQLite. Generated artifacts (`node_modules/`, `.venv/`,
`dist/`, Maven `target/`, SQLite database files) should not be committed.

## Contributing & Governance

This repository is owned and maintained solely by its author.

- Forking, copying, and adapting are allowed under the [MIT License](LICENSE).
- **Pull requests are not accepted.**
- Feedback, suggestions, corrections, and bug reports are welcome via
  [Issues](../../issues).
- Submitted suggestions may be used, adapted, or declined at the author's
  discretion.

## License

[MIT](LICENSE) © 2026 Ed Brindley
