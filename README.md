# AI Coding Benchmarks

Reproducible coding-agent benchmark challenges for comparing AI coding tools.

This repository contains standalone benchmark tasks, starting fixtures, and
oracle checks. It intentionally does not include any orchestration framework,
provider credentials, private run logs, or local machine configuration.

## What Is Included

- `benchmarks/cli-comparison/tasks/` - task specifications for greenfield and
  brownfield coding challenges.
- `benchmarks/cli-comparison/fixtures/` - starting codebases used by the tasks.
- `benchmarks/cli-comparison/oracles/` - external validators for tasks that need
  checks beyond ordinary build/test commands.
- `benchmarks/cli-comparison/suite.yaml` - the default task list for the current
  CLI comparison suite.

## What Is Not Included

- Provider-specific runner code.
- Private credentials, API keys, or local environment files.
- Raw agent transcripts or per-run worktree artifacts.
- Any dependency on a specific orchestration framework.

## Benchmark Scope

The current suite mixes small but practical coding-agent challenges:

- greenfield implementation,
- brownfield bug fixing,
- refactoring,
- migration,
- security,
- SQL,
- Python,
- JavaScript,
- TypeScript,
- Java.

This is not a universal leaderboard and does not include benchmark writeups or
published comparison results. It is a reusable task suite: inspect the tasks,
run your own agents, compare outputs, and propose improvements.

## Running Challenges Manually

Each task YAML lists:

- the fixture to start from,
- the implementation constraints,
- the expected outcome,
- the gates that should pass.

A typical manual workflow is:

1. Copy the referenced fixture into a temporary working directory.
2. Ask an agent to complete the task using the task description.
3. Run the eligibility gate commands listed in the task YAML.
4. Run any task-specific oracle in `benchmarks/cli-comparison/oracles/`.
5. Inspect the diff to ensure the task constraints were respected.

The exact automation harness is intentionally left to the user. This keeps the
benchmark portable across Cursor, Claude Code, Codex, Gemini CLI, OpenCode, and
other coding agents.

## Toolchain Notes

Some fixtures require local language tooling:

- Node.js and npm for JavaScript/TypeScript fixtures.
- Python 3.9+ for Python fixtures.
- Java 17 and Maven for Java fixtures.
- SQLite for SQL fixtures.

Generated artifacts such as `node_modules/`, `.venv/`, `dist/`, `.oracle-dist/`,
Maven `target/`, and SQLite database files should not be committed.
