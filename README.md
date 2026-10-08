# AI Coding Benchmarks

A public reference set of software engineering tasks, starting fixtures and
validators for comparing AI coding models and agentic coding tools.

The corpus is runner-neutral and usable without the optional local harness.
It is not a leaderboard or an endorsement of any tool. Compare results across
the whole suite; a single task is useful for exploration, not a model ranking.

## Choose a starting point

- **Explore a task manually:** use the [manual workflow](#run-a-task-manually)
  with your own coding agent.
- **Check the harness setup:** follow the [setup check](#check-the-harness-setup).
  It validates the corpus and expands a sample without running a provider.
- **Compare models or tools:** configure a [comparison experiment](#configure-a-comparison)
  and read the methodology before interpreting results.

## Requirements

The optional harness needs Node.js 20 or later and npm. Executing trials needs
macOS with `/usr/bin/sandbox-exec` or Linux with `bwrap`; execution is unavailable
without supported confinement. Planning with `--no-execute` does not run trials.

Tasks require the toolchains named in their gate commands. The suite includes
JavaScript/TypeScript, Python, Java, SQL, Go, Rust and C# tasks; install the
tooling for every task you intend to execute. Gates run code from the task
workspace; read [execution boundaries](SECURITY.md) before running them.

Real experiments also need an installed, configured coding-agent CLI.
The shipped comparison templates include Poetic invocation paths and require
a separately available Poetic installation; this repository does not install
or distribute it. A `native-cli` arm uses your own command and arguments.

## Check the harness setup

Clone the repository, enter it, and install its dependencies:

```bash
git clone https://github.com/ebrindley/ai-coding-benchmarks.git
cd ai-coding-benchmarks
npm install
node harness/cli.js self-validate
node harness/cli.js run --experiment examples/experiment.sample.json --corpus benchmarks --no-execute
```

A successful validation prints `self-validate: ok`. The planning command prints
JSON with `ok: true`, a `campaignDir` and `status: "pending"`. No trials
execute. Keep the returned campaign path for later commands.
Without `--campaign`, output goes under the system temporary directory.

The sample contains one task and a fake command (`true`). Removing
`--no-execute` exercises the execution path with that fake command; it does not
measure a coding model or demonstrate a passing solution.

## Configure a comparison

The [examples](examples/) contain model, provider and harness comparison
templates. They require editing before use:

1. Choose a template and replace provider/model placeholders with identifiers
   available in your installation.
2. Set each arm's `invocationPath`: `poetic-adapter`, `poetic-system`, or
   `native-cli`. Native CLI arms need a real `command` and `args`; see the
   [experiment schema](schemas/experiment.schema.json).
3. Configure credentials outside the repository and the arm's environment
   allowlist as needed. Omit `taskIds` to compare the whole suite.
4. Hold other settings constant when comparing one variable. See the
   [comparison methodology](benchmarks/cli-comparison/COMPARISON.md).

After configuring the selected experiment, run it:

```bash
node harness/cli.js run --experiment examples/compare-models.experiment.json --corpus benchmarks
```

Use the `campaignDir` returned by that command in place of `/path/to/campaign`:

```bash
node harness/cli.js summary --campaign /path/to/campaign
node harness/cli.js export --campaign /path/to/campaign --out /path/to/bundle
```

Summary reports per-arm, per-task and per-cell pass counts and pass rates.
It does not yet calculate composite or language/category/type sub-scores;
calculate those from the per-task results using the methodology. Separate
infrastructure failures and timeouts from model failures when interpreting rates.

Results retain distinct invocation paths and resolved-model evidence.
Raw provider output may contain secrets and is excluded from default sanitized
exports. Do not commit it. Uploading or publishing results is a separate action.

## Run a task manually

Each [task YAML](benchmarks/cli-comparison/tasks/) names its fixture, constraints,
expected outcome and required gates:

1. Copy the referenced fixture into a temporary working directory.
2. Have an agent complete the task from its description.
3. Run the task's eligibility gate commands and any task-specific oracle.
4. Inspect the diff to confirm the constraints were respected.

This workflow does not require the harness or Poetic. Use the full suite and
consistent conditions for comparative claims.

## Repository contents and documentation

- [Tasks](benchmarks/cli-comparison/tasks/), [fixtures](benchmarks/cli-comparison/fixtures/)
  and [oracles](benchmarks/cli-comparison/oracles/): the portable corpus.
- [Suite](benchmarks/cli-comparison/suite.yaml): the default task list.
- [Comparison guide](benchmarks/cli-comparison/COMPARISON.md): methodology,
  current scoring limits and invocation evidence.
- [Schemas](schemas/) and [harness](harness/): experiment contracts and optional runner.
- [Security](SECURITY.md): execution and evidence boundaries.

Keep generated dependencies, build output and campaign artifacts out of commits.

## Support and license

Maintained by Ed Brindley. Feedback and bug reports are welcome through
[Issues](https://github.com/ebrindley/ai-coding-benchmarks/issues).
Pull requests are not accepted; see [contribution guidance](CONTRIBUTING.md).

[MIT](LICENSE) © 2026 Ed Brindley.
