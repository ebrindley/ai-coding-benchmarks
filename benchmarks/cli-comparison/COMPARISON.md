# Running the Suite as a Comparison

**These tasks are not meant to be compared one by one. The suite is a single
comprehensive assessment.** A model passing or failing any individual task tells
you almost nothing — one task is one noisy bit. The signal is the **composite
score and its sub-scores** across the whole suite, and the **pattern of
divergence** between the things you are comparing.

Think of the repository as a **template**: clone/pin it at a commit, then run
the *entire* suite against each thing you want to compare (a model, a provider,
a harness). Each task executes in a throwaway, fixture-pinned worktree, so runs
never contaminate each other. You compare the resulting **profiles**, not the
raw repo.

## Why this suite (and contamination)

Saturated public benchmarks (HumanEval, SWE-bench, etc.) appear in training data,
so a high score can reflect memorization as much as capability. This repository
is **public** (MIT-licensed), so it is not immune to that over time — but it is a
**new, purpose-built corpus that is not part of the standard public benchmark
datasets** those models are tuned against, and its tasks were seeded by us rather
than lifted from well-known sources. That makes contamination *less likely today*
than for the saturated benchmarks, though not impossible, and it will erode as
the repo circulates.

Two practical implications:

- Treat the **per-dimension profile** — how an arm does on Python vs TypeScript,
  on bug-fixes vs refactors — as the useful signal, not a single headline number.
- If contamination resistance matters for your comparison, pin to a commit,
  record the date, and consider holding back or rotating a private variant of the
  tasks. Contamination resistance is a property you maintain, not a guarantee the
  public repo provides.

## The composite score and sub-scores

Scoring is deliberately **simple and equal-weight**, so it is easy to compute
and easy to interpret (no hidden weighting math):

- **Task score** = pass/fail. A task passes only when every required
  eligibility gate passes (build/lint/typecheck/tests + anti-gaming + oracle
  gates). This is exactly what the harness records per trial.
- **Composite** = fraction of tasks passed across the whole suite.
- **Sub-scores** = the same pass-rate, sliced by a task dimension. Every task
  YAML carries `language`, `category`, and `type`, which define the slices:

| Dimension | Values (task counts) |
|---|---|
| **language** | typescript (4), python (4), javascript (4), java (3), sql (2), go (2), rust (1), csharp (1) |
| **category** | bugfix (11), feature (7), refactor (2), migration (1) |
| **type** | brownfield (14), greenfield (7) |

Report the **profile**, not just the composite. The point of sub-scores is
exactly your intuition: *one model may lead on Python and trail on TypeScript,
or be strong at bug-fixes and weak at refactors.* Two arms can share a composite
and have completely different profiles — that difference is the finding.

Bigger tasks (a refactor, a migration) are worth the same one point as a small
bug-fix. We chose equal weighting on purpose: the individual sub-scores stand on
their own and are easy to read, which matters more than trying to encode
"difficulty" into the arithmetic.

> Note (current harness): `aicb summary` reports per-arm / per-task / per-cell
> pass counts and pass rates. It does **not yet** roll those up into
> language/category/type sub-scores or a composite for you — you compute those
> from the per-task results today (each task's `language`/`category`/`type` is
> in its YAML). A first-class composite/sub-score report is a planned addition.

## How to run a comparison

Each comparison is one **experiment** (see `../../examples/*.experiment.json`)
that lists **arms** — one arm per thing being compared. Omit `taskIds` so the
**whole suite** runs for every arm.

```bash
npm install
npx aicb self-validate
npx aicb run --experiment ./examples/compare-providers.experiment.json --corpus ./benchmarks
npx aicb summary --campaign /path/to/campaign
npx aicb export  --campaign /path/to/campaign --out /path/to/bundle
```

The harness **never pools results across different invocation paths, resolved
model ids, or posture fingerprints** — so it cannot silently merge two arms into
one misleading number. That guard is what makes cross-arm comparison trustworthy.

## Design a clean contrast: vary one thing, hold the rest fixed

A comparison is only attributable if exactly **one** dimension differs between
arms. The examples each isolate one variable:

| Question | Vary | Hold fixed | Example |
|---|---|---|---|
| Which model is better here? | `model` | provider, invocationPath, posture | `compare-models.experiment.json` |
| Is this provider's backend degraded (quantization/precision)? | `provider` | model, invocationPath, posture | `compare-providers.experiment.json` |
| Does the harness/scaffold change outcomes? | `invocationPath` | provider, model | `compare-harnesses.experiment.json` |

If you vary two things at once (say, model *and* provider), a divergence is
unattributable. Keep contrasts one-variable.

## Repetitions and reading the result

- `repetitions: 3` is the suite default and a reasonable floor. For
  **provider/quantization** contrasts, raise it (10+): you are hunting a small,
  categorical divergence and want to see whether a task flips **consistently**
  across repetitions rather than by chance.
- Read the composite, then the **sub-score profile**, then drill into the
  **per-task divergences** — the tasks where one arm consistently passes and the
  other consistently fails. Those specific tasks, inspected via the retained raw
  evidence, are where a real backend or harness difference shows itself.
- **Do not over-read a single task or a single repetition.** A one-task gap is
  noise; a consistent sub-score gap across a language or category is signal.

## Caveats that affect attribution (read before making claims)

- **Resolved-model proof is path-dependent.** Only `poetic-adapter` records
  verified resolved-model evidence. `native-cli` and `poetic-system` cannot
  prove which model/backend actually served the request, so use `poetic-adapter`
  for any **provider** or **quantization** claim, and confirm backend identity
  out-of-band otherwise.
- **Concurrency tasks.** `brownfield-011-go-worker-pool-race` relies on the Go
  scheduler and can flip run-to-run on its own; treat a divergence there as
  signal only if it reproduces across repetitions. The other concurrency tasks
  force the race deterministically —
  `brownfield-003-python-async-race` monkey-patches `asyncio.sleep` to guarantee
  the interleaving, and `brownfield-013-java-order-concurrency-bug` uses a
  `CyclicBarrier` — so they are reproducible, not flaky, though still
  concurrency-heavy.
- **Fairness controls are not yet first-class.** The experiment schema does not
  pin sampling (temperature/top-p/seed), retries, or budgets. If your provider
  path exposes these, hold them equal across arms out-of-band, or a divergence
  may reflect sampling rather than capability.
- **`passRate` denominator includes infrastructure failures.** `INFRA_FAIL` and
  `TIMEOUT` currently count against an arm's pass rate. Separate genuine
  capability failures from infrastructure/timeout noise before ranking.
- **Cost/tokens/latency are not yet aggregated into the report.** Two arms can
  reach the same score at very different cost; capture that out-of-band if it
  matters to your decision.
- **Gate commands run confined with a per-trial writable tool-cache dir.** Every
  gate executes under OS confinement (macOS `sandbox-exec`, Linux `bwrap`) that
  grants writes only to the trial workspace, a private temp, and a per-trial
  harness-created tool-cache directory. The host `$HOME` is neither readable nor
  writable inside confinement, so priming host caches (`~/.m2`, `~/.nuget`,
  `~/.npm`, `~/.cargo`, the Go module cache) does **not** help — the sandbox
  cannot see them. Instead, the harness redirects `HOME` and each toolchain's
  cache location (`NUGET_PACKAGES`, `npm_config_cache`, `PIP_CACHE_DIR`,
  `CARGO_HOME`, `GOPATH`/`GOMODCACHE`, and Maven's local repo via `MAVEN_OPTS`)
  to fixed paths under that writable cache dir. When the task's `networkPolicy`
  allows network, common toolchains (NuGet/Maven/npm/pip/Cargo/Go) can therefore
  populate their caches inside confinement and complete a build/install gate on a
  stock host. The cache dir is created per trial and removed on
  success/failure/timeout, so caches warm within a trial (across its ordered
  gates) but never leak across trials. A genuine dependency-resolution or build
  error surfaces as a normal build/install **FAIL** (nonzero exit), not an
  `INFRA_FAIL` — treat those as capability signal. A network-denied dependency
  fetch also exits nonzero, so it too is a **FAIL**, not `INFRA_FAIL`: if the
  task needs network, allow it via `networkPolicy` rather than reading the
  failure as capability. `INFRA_FAIL` is reserved for confinement/spawn problems
  (e.g. no `sandbox-exec`/`bwrap` available, or the confinement wrapper cannot
  execute the gate at all).

These are known gaps, not properties of a finished instrument. The suite today
is strong for **profiling models** and **detecting large, consistent
divergences**; the caveats above bound how fine a claim the current tooling
supports.
