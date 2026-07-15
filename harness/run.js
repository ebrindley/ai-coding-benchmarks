/**
 * Canonical `run` orchestration: preflight → expand → lock → trials → summary.
 * No Poetic workflow wrapper. Does not invoke live providers unless invokers are configured.
 * Resumable and deterministic.
 */

import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { preflight } from './preflight.js';
import { SCHEMA_VERSION } from './contracts.js';
import { sha256Json, sha256Buffer, digestArtifactDir } from './digest.js';
import { computePostureFingerprint } from './posture.js';
import {
  parseResolvedModelEvidence,
} from './invokers/index.js';
import { readFileNoFollow, UnsafePathError } from './safe-fs.js';

/**
 * Best-effort chmod for private modes (ignore platforms that lack mode bits).
 * @param {string} p
 * @param {number} mode
 */
async function tryChmod(p, mode) {
  try {
    await chmod(p, mode);
  } catch {
    /* ignore */
  }
}

/**
 * Lazy-load peer modules.
 */
async function loadPeers() {
  const [
    { loadSuite, loadCorpusTasks },
    { expandExperiment, nextTrial },
    { acquireLock, releaseLock },
    {
      createManifest,
      loadManifest,
      saveManifest,
      updateTrial,
      listResumableTrials,
      computeCampaignInputDigests,
      compareInputDigests,
    },
    {
      createIsolatedWorkspace,
      resolveExecutionRoot,
      cleanupExecutionWorkspace,
      assertWorkspaceOutsideCampaign,
    },
    { getInvoker, buildInvocationRequest },
    { runGates, detectConfinement, sanitizeGateResultsForStorage },
    { classifyTrial },
    {
      writeTrialResult,
      quarantineRawOutput,
      ensurePrivateDir,
      writePrivateFile,
      buildTrialDigests,
      computeResultDigest,
      computeArtifactDigest,
      verifyCampaignEvidenceDigests,
    },
    { buildReport, formatHumanSummary },
    {
      assertSafeTrialId,
      assertSafeCampaignId,
      assertSafeIdSegment,
      assertInsideRoot,
      resolveUnder,
      trialPathUnder,
    },
  ] = await Promise.all([
    import('./load.js'),
    import('./schedule.js'),
    import('./lock.js'),
    import('./manifest.js'),
    import('./workspace.js'),
    import('./invokers/index.js'),
    import('./gates.js'),
    import('./classify.js'),
    import('./results.js'),
    import('./summary.js'),
    import('./paths.js'),
  ]);

  return {
    loadSuite,
    loadCorpusTasks,
    expandExperiment,
    nextTrial,
    acquireLock,
    releaseLock,
    createManifest,
    loadManifest,
    saveManifest,
    updateTrial,
    listResumableTrials,
    computeCampaignInputDigests,
    compareInputDigests,
    createIsolatedWorkspace,
    resolveExecutionRoot,
    cleanupExecutionWorkspace,
    assertWorkspaceOutsideCampaign,
    getInvoker,
    buildInvocationRequest,
    runGates,
    detectConfinement,
    sanitizeGateResultsForStorage,
    classifyTrial,
    writeTrialResult,
    quarantineRawOutput,
    ensurePrivateDir,
    writePrivateFile,
    buildTrialDigests,
    computeResultDigest,
    computeArtifactDigest,
    verifyCampaignEvidenceDigests,
    buildReport,
    formatHumanSummary,
    assertSafeTrialId,
    assertSafeCampaignId,
    assertSafeIdSegment,
    assertInsideRoot,
    resolveUnder,
    trialPathUnder,
  };
}

/**
 * Resolve suite path and suite-dir under the declared corpusRoot.
 * Fail-closed: suitePath/suiteId must stay inside corpusRoot after lexical + realpath.
 *
 * @param {object} experiment
 * @param {string} corpusRoot
 * @param {{ assertInsideRoot?: typeof import('./paths.js').assertInsideRoot, assertSafeIdSegment?: typeof import('./paths.js').assertSafeIdSegment }} [pathHelpers]
 * @returns {Promise<{ suitePath: string, suiteDir: string }>}
 */
export async function resolveSuiteLocation(experiment, corpusRoot, pathHelpers) {
  const { assertInsideRoot, assertSafeIdSegment } =
    pathHelpers ?? (await import('./paths.js'));

  const root = path.resolve(corpusRoot);
  /** @type {string} */
  let suitePath;
  if (experiment.suitePath != null && String(experiment.suitePath).trim() !== '') {
    const raw = String(experiment.suitePath);
    // Absolute paths only accepted when still inside corpusRoot (assertInsideRoot enforces).
    suitePath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  } else if (experiment.suiteId != null && String(experiment.suiteId).trim() !== '') {
    // suiteId is one or more relative segments under corpusRoot — reject absolute/empty.
    const suiteId = String(experiment.suiteId);
    if (path.isAbsolute(suiteId)) {
      throw new Error(`absolute suiteId is not allowed: "${suiteId}"`);
    }
    // Reject traversal segments; multi-segment relative ids are joined then contained.
    for (const seg of suiteId.split(/[/\\]+/).filter(Boolean)) {
      assertSafeIdSegment(seg, { label: 'suiteId segment' });
    }
    suitePath = path.resolve(root, suiteId, 'suite.yaml');
  } else {
    // corpusRoot itself may be the suite directory
    suitePath = path.join(root, 'suite.yaml');
  }

  // Canonical realpath/symlink containment under corpusRoot before any read.
  const containedSuitePath = await assertInsideRoot(root, suitePath);
  const suiteDir = path.dirname(containedSuitePath);
  // suiteDir must also remain under corpus root (defense in depth).
  await assertInsideRoot(root, suiteDir);

  return { suitePath: containedSuitePath, suiteDir };
}

/**
 * Build taskId → task map from loadCorpusTasks result.
 * @param {{ suite?: object, tasks?: object[] } | object[]} loaded
 * @returns {Record<string, object>}
 */
export function tasksByIdFromLoad(loaded) {
  const list = Array.isArray(loaded?.tasks)
    ? loaded.tasks
    : Array.isArray(loaded)
      ? loaded
      : [];
  /** @type {Record<string, object>} */
  const map = {};
  for (const t of list) {
    if (t && (t.taskId || t.id)) {
      map[String(t.taskId || t.id)] = t;
    }
  }
  return map;
}

/**
 * Resolve model evidence honestly after an invoker returns.
 *
 * poetic-adapter: model evidence comes ONLY from the invoker's fully validated,
 * requestId-bound `parsedOutput`. Never reopen outputPath/campaign copies as a
 * fallback (stale/mismatched artifacts may still sit on disk).
 *
 * @param {string} invocationPath
 * @param {object} invokerResult
 * @returns {{ resolvedModel: string | null, resolvedModelAvailable: boolean, resolvedModelSource: string }}
 */
function resolveModelEvidence(invocationPath, invokerResult) {
  if (invocationPath === 'poetic-adapter') {
    const artifact = invokerResult?.parsedOutput ?? null;
    if (artifact == null) {
      return {
        resolvedModel: null,
        resolvedModelAvailable: false,
        resolvedModelSource: 'unavailable',
      };
    }
    const parsed = parseResolvedModelEvidence(artifact);
    return {
      resolvedModel: parsed.resolvedModel,
      resolvedModelAvailable: parsed.available,
      resolvedModelSource: parsed.source,
    };
  }
  // native-cli / poetic-system: unavailable unless invoker returned explicit evidence
  if (
    invokerResult?.resolvedModel != null &&
    String(invokerResult.resolvedModel).trim() !== ''
  ) {
    return {
      resolvedModel: String(invokerResult.resolvedModel),
      resolvedModelAvailable: true,
      resolvedModelSource: 'invoker-explicit',
    };
  }
  return {
    resolvedModel: null,
    resolvedModelAvailable: false,
    resolvedModelSource: 'unavailable',
  };
}

/**
 * Detect command-not-found / execvp failure from confined spawn wrappers.
 * sandbox-exec may exit non-zero with stderr and no infraFailure string.
 *
 * @param {object | null | undefined} invokerResult
 * @returns {boolean}
 */
function looksLikeCommandNotFound(invokerResult) {
  if (!invokerResult || typeof invokerResult !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (invokerResult);
  const infra =
    typeof r.infraFailure === 'string' ? r.infraFailure : '';
  if (/ENOENT|command is empty|spawn failed|not found|no such file/i.test(infra)) {
    return true;
  }
  const stdout = r.stdout == null ? '' : String(r.stdout);
  const stderr = r.stderr == null ? '' : String(r.stderr);
  // Wrapper-only noise: no provider stdout, stderr is spawn/execvp ENOENT.
  if (stdout.length > 0) return false;
  if (
    /execvp\(\).*failed|spawn\s+\S+\s+ENOENT|\bENOENT\b|No such file or directory/i.test(
      stderr,
    )
  ) {
    // Prefer non-zero/null exit — successful empty commands must not match.
    if (r.exitCode == null || Number(r.exitCode) !== 0) return true;
  }
  return false;
}

/**
 * Normalize invoker results so command-not-found / confinement-style spawn
 * failures carry an explicit infraFailure for classify + raw availability.
 * Does not invent model evidence or clear valid provider streams.
 *
 * @param {string} invocationPath
 * @param {object} invokerResult
 * @returns {object}
 */
export function normalizeInvokerInfraSignals(invocationPath, invokerResult) {
  if (!invokerResult || typeof invokerResult !== 'object') {
    return invokerResult;
  }
  const r = /** @type {Record<string, unknown>} */ (invokerResult);
  if (typeof r.infraFailure === 'string' && r.infraFailure.trim() !== '') {
    return invokerResult;
  }
  // poetic-adapter already sets infraFailure when raw is missing / bind fails.
  if (invocationPath === 'poetic-adapter') {
    return invokerResult;
  }
  if (looksLikeCommandNotFound(r)) {
    const stderr = r.stderr == null ? '' : String(r.stderr).trim();
    const detail = stderr.slice(0, 240) || 'command not found';
    return {
      ...r,
      // Treat as infra: process never ran the provider binary.
      infraFailure: `command not found / spawn ENOENT: ${detail}`,
    };
  }
  return invokerResult;
}

/**
 * Detect whether provider raw evidence is unavailable for reportable digests.
 *
 * Missing/invalid poetic raw, confinement refusal, spawn failures, and
 * command-not-found must never become verified empty raw digests.
 *
 * @param {string} invocationPath
 * @param {object | null | undefined} invokerResult
 * @returns {boolean}
 */
export function isRawEvidenceUnavailable(invocationPath, invokerResult) {
  const r =
    invokerResult && typeof invokerResult === 'object'
      ? /** @type {Record<string, unknown>} */ (invokerResult)
      : {};
  const infra =
    typeof r.infraFailure === 'string' && r.infraFailure.trim() !== ''
      ? r.infraFailure
      : '';
  const stdout = r.stdout == null ? '' : String(r.stdout);
  const stderr = r.stderr == null ? '' : String(r.stderr);
  const hasStreamEvidence = stdout.length > 0 || stderr.length > 0;

  // Capture truncation: retained prefixes are incomplete raw. Fail closed so
  // digests are marked rawEvidenceUnavailable (never reportable as complete).
  const outTrunc = Number(r.stdoutTruncatedChars);
  const errTrunc = Number(r.stderrTruncatedChars);
  if (
    r.rawTruncated === true ||
    (Number.isFinite(outTrunc) && outTrunc > 0) ||
    (Number.isFinite(errTrunc) && errTrunc > 0)
  ) {
    return true;
  }

  // poetic-adapter: only fully ingested provider raw is reportable evidence.
  // Missing raw, bind failure, or non-actual marker → unavailable (never empty
  // quiet-CLI bytes as verified digests).
  if (invocationPath === 'poetic-adapter') {
    if (r.providerRawEvidence !== 'actual') return true;
    // Defensive: actual marker without bound artifact still cannot attribute.
    if (r.parsedOutput == null && r.success === false) return true;
    return false;
  }

  // Command-not-found / execvp ENOENT (including sandbox-exec wrapper stderr).
  if (looksLikeCommandNotFound(r)) {
    return true;
  }

  // Confinement refusal / unconfined refused (all paths).
  if (
    infra &&
    /confinement|campaignDir|unconfined\s+refused|provider spawn requires|execution_unavailable|execution unavailable/i.test(
      infra,
    )
  ) {
    return true;
  }

  // Spawn failures / command-not-found / ENOENT-style infra.
  if (
    infra &&
    /spawn failed|process error|ENOENT|not found|command is empty|no such file/i.test(
      infra,
    )
  ) {
    return true;
  }

  // exitCode null with infraFailure: process never produced usable streams.
  if (r.exitCode == null && infra) {
    return true;
  }

  // native-cli / poetic-system: invoker failed before usable stream evidence.
  if (infra && !hasStreamEvidence) {
    return true;
  }

  // Explicit execution_unavailable without infra string.
  if (r.executionUnavailable === true && !hasStreamEvidence) {
    return true;
  }

  return false;
}

/**
 * @param {object} opts
 * @param {object} opts.experiment
 * @param {string} opts.corpusRoot
 * @param {string} [opts.campaignDir]
 * @param {string} [opts.harnessRoot]
 * @param {boolean} [opts.resume=true]
 * @param {boolean} [opts.execute=true]
 * @param {number} [opts.maxTrials]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<object>}
 */
export async function runCampaign(opts) {
  const log = opts.log ?? (() => {});
  const peers = await loadPeers();
  const corpusRoot = path.resolve(opts.corpusRoot);
  const harnessRoot = path.resolve(
    opts.harnessRoot ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );

  // Default campaignDir must never be derived from an unsafe experiment.id.
  /** @type {string} */
  let campaignDir;
  if (opts.campaignDir != null) {
    campaignDir = path.resolve(opts.campaignDir);
  } else {
    let safeId;
    try {
      safeId = peers.assertSafeCampaignId(opts.experiment?.id || 'campaign');
    } catch (err) {
      return {
        ok: false,
        stage: 'preflight',
        errors: [
          `unsafe experiment.id for default campaignDir: ${err instanceof Error ? err.message : String(err)}`,
        ],
        warnings: [],
        campaignDir: null,
      };
    }
    campaignDir = path.join(os.tmpdir(), 'aicb-campaigns', safeId);
  }

  const pf = await preflight({
    experiment: opts.experiment,
    corpusRoot,
    campaignDir,
    harnessRoot,
  });
  if (!pf.ok) {
    return {
      ok: false,
      stage: 'preflight',
      errors: pf.errors,
      warnings: pf.warnings,
      campaignDir,
    };
  }

  // Campaign tree is private (0700) — secrets may land under raw/artifacts/results.
  // Provider execution workspaces live outside the campaign tree (see executionRoot).
  await peers.ensurePrivateDir(campaignDir);
  await peers.ensurePrivateDir(path.join(campaignDir, 'raw'));
  await peers.ensurePrivateDir(path.join(campaignDir, 'results'));
  await peers.ensurePrivateDir(path.join(campaignDir, 'artifacts'));

  const ownerId = `aicb-${process.pid}-${Date.now()}`;
  const lock = await peers.acquireLock(campaignDir, ownerId);
  if (!lock?.ok) {
    return {
      ok: false,
      stage: 'lock',
      errors: [lock?.error || 'failed to acquire campaign lock'],
      campaignDir,
    };
  }

  try {
    // Resume uses frozen manifest.experiment; never prefer a mutated caller experiment.
    let manifest = null;
    if (opts.resume !== false) {
      try {
        manifest = await peers.loadManifest(campaignDir);
      } catch (err) {
        try {
          await readFile(path.join(campaignDir, 'manifest.json'), 'utf8');
          return {
            ok: false,
            stage: 'resume',
            errors: [
              `invalid campaign manifest (fail closed): ${err instanceof Error ? err.message : String(err)}`,
            ],
            campaignDir,
          };
        } catch {
          manifest = null;
        }
      }
    }

    /** @type {object} */
    let experiment;
    if (manifest) {
      if (!manifest.experiment || typeof manifest.experiment !== 'object') {
        return {
          ok: false,
          stage: 'resume',
          errors: [
            'resumed manifest missing frozen experiment (fail closed)',
          ],
          campaignDir,
        };
      }
      if (
        opts.experiment &&
        sha256Json(opts.experiment) !== sha256Json(manifest.experiment)
      ) {
        return {
          ok: false,
          stage: 'resume',
          errors: [
            'caller experiment does not match frozen manifest.experiment (fail closed)',
          ],
          campaignDir,
        };
      }
      experiment = manifest.experiment;
      log(`resumed campaign ${manifest.campaignId}`);
    } else {
      experiment = opts.experiment;
    }

    /** @type {string} */
    let suitePath;
    /** @type {string} */
    let suiteDir;
    try {
      ({ suitePath, suiteDir } = await resolveSuiteLocation(experiment, corpusRoot, {
        assertInsideRoot: peers.assertInsideRoot,
        assertSafeIdSegment: peers.assertSafeIdSegment,
      }));
    } catch (err) {
      return {
        ok: false,
        stage: 'load',
        errors: [
          `suite path escapes corpusRoot (fail closed): ${err instanceof Error ? err.message : String(err)}`,
        ],
        campaignDir,
      };
    }

    const suite = await peers.loadSuite(suitePath);

    const taskIds = experiment.taskIds?.length
      ? experiment.taskIds
      : suite.tasks;

    // loadCorpusTasks: first arg is suite dir (where tasks/ lives)
    const suiteForLoad = { ...suite, tasks: taskIds };
    const loaded = await peers.loadCorpusTasks(suiteDir, suiteForLoad);
    const tasksById = tasksByIdFromLoad(loaded);
    const taskList = taskIds.map((id) => tasksById[id]);

    for (const id of taskIds) {
      if (!tasksById[id]) {
        return {
          ok: false,
          stage: 'load',
          errors: [`failed to load task ${id} from corpus at ${suiteDir}`],
          campaignDir,
        };
      }
    }

    const inputDigests = await peers.computeCampaignInputDigests({
      experiment,
      suite,
      tasks: taskList,
      suiteDir,
      harnessRoot,
    });

    // Execution workspaces are outside the campaign tree so provider cwd
    // ancestor walks cannot reach raw/manifest/locks/results.
    // (Filesystem-tree separation only — not OS read isolation.)
    const safeCampaignIdForExec = peers.assertSafeCampaignId(
      manifest?.campaignId || experiment.id,
    );
    const executionRoot = peers.resolveExecutionRoot({
      campaignId: safeCampaignIdForExec,
    });
    await peers.ensurePrivateDir(executionRoot);
    // workspaceRoot on the manifest records the external execution root.
    const workspaceRoot = executionRoot;
    const artifactRoot = path.join(campaignDir, 'artifacts');

    if (!manifest) {
      const trials = peers.expandExperiment(experiment, {
        tasks: taskList,
        arms: experiment.arms,
      });

      // Freeze per-trial expected fixture digests in immutable trial metadata
      // (independent authority for fixtureDigest verification; not derived from result).
      /** @type {Record<string, string>} */
      const fixtureDigestByPath = {};
      for (const task of taskList) {
        const fixturePath =
          task && typeof task.fixturePath === 'string' ? task.fixturePath : null;
        if (!fixturePath || fixtureDigestByPath[fixturePath]) continue;
        try {
          const fixtureAbs = await peers.resolveUnder(
            path.join(suiteDir, 'fixtures'),
            fixturePath,
          );
          fixtureDigestByPath[fixturePath] = await digestArtifactDir(fixtureAbs);
        } catch {
          /* missing fixture: leave unset; execution will INFRA_FAIL */
        }
      }
      for (const t of trials) {
        const task = tasksById[t.taskId];
        const fp =
          task && typeof task.fixturePath === 'string' ? task.fixturePath : null;
        if (fp && fixtureDigestByPath[fp]) {
          t.expectedFixtureDigest = fixtureDigestByPath[fp];
          t.fixturePath = fp;
        }
      }

      // experiment.id already validated by preflight / assertSafeCampaignId
      const safeCampaignId = peers.assertSafeCampaignId(experiment.id);
      manifest = peers.createManifest({
        campaignId: safeCampaignId,
        experimentId: safeCampaignId,
        experiment,
        trials,
        scheduleSeed: experiment.seed,
        artifactRoot,
        workspaceRoot,
        inputDigests,
        host: {
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          cpus: Math.max(1, os.cpus()?.length ?? 1),
          totalMemoryBytes: os.totalmem(),
        },
        lock: {
          held: true,
          owner: ownerId,
          acquiredAt: new Date().toISOString(),
          path: path.join(campaignDir, 'campaign.lock'),
        },
      });
      await peers.saveManifest(campaignDir, manifest);
      log(`created campaign ${manifest.campaignId} with ${trials.length} trials`);
    } else {
      const cmp = peers.compareInputDigests(manifest.inputDigests, inputDigests);
      if (!cmp.ok) {
        return {
          ok: false,
          stage: 'resume',
          errors: [cmp.error],
          mismatches: cmp.mismatches,
          campaignDir,
        };
      }
    }

    if (opts.execute === false) {
      return {
        ok: true,
        stage: 'expanded',
        campaignDir,
        manifest,
        suiteDir,
        taskCount: Object.keys(tasksById).length,
        warnings: pf.warnings,
      };
    }

    const confinement =
      typeof peers.detectConfinement === 'function'
        ? await peers.detectConfinement()
        : { available: false, reason: 'detectConfinement missing' };

    let executed = 0;
    const maxTrials = opts.maxTrials ?? Number.POSITIVE_INFINITY;

    for (const t of manifest.trials) {
      if (t.state === 'running') {
        peers.updateTrial(manifest, t.id, {
          state: 'pending',
          error: 'recovered from interrupted running state',
        });
      }
    }
    let pending = manifest.trials.filter((t) => t.state === 'pending');

    while (executed < maxTrials) {
      const trial = peers.nextTrial(pending, {
        oneActivePerProvider: true,
        active: manifest.trials.filter((t) => t.state === 'running'),
      });

      if (!trial) break;

      // Defense in depth: manifests are validated on load/create; path joins still
      // re-check so write boundaries never accept traversal trial ids.
      peers.assertSafeTrialId(trial.id);

      // Frozen experiment arms only — never a mutated caller experiment on resume.
      const arm = (experiment.arms || []).find((a) => a.name === trial.arm);
      if (!arm) {
        peers.updateTrial(manifest, trial.id, {
          state: 'failed',
          classification: 'INFRA_FAIL',
          classificationReason: `arm not found: ${trial.arm}`,
        });
        await peers.saveManifest(campaignDir, manifest);
        executed += 1;
        pending = manifest.trials.filter((t) => t.state === 'pending');
        continue;
      }

      const task = tasksById[trial.taskId];
      const startedAt = new Date().toISOString();
      peers.updateTrial(manifest, trial.id, {
        state: 'running',
        startedAt,
      });
      await peers.saveManifest(campaignDir, manifest);

      /** @type {Record<string, unknown>} */
      let trialUpdate = {};
      /** @type {string | null} */
      let trialWorkspaceDir = null;
      try {
        // Prefer already-validated/canonical fixture dir from corpus loading.
        // Fall back only when absent, still contained under suite fixtures/.
        /** @type {string | null} */
        let fixtureDir = null;
        if (
          task._resolvedFixtureDir != null &&
          String(task._resolvedFixtureDir).trim() !== ''
        ) {
          fixtureDir = String(task._resolvedFixtureDir);
        } else if (task.fixturePath != null && String(task.fixturePath).trim() !== '') {
          fixtureDir = await peers.resolveUnder(
            path.join(suiteDir, 'fixtures'),
            String(task.fixturePath),
          );
        }

        // Always create under the external execution root (never campaign/workspaces).
        // On resume, re-create outside campaign even if an older manifest recorded
        // a campaign-relative workspaceRoot.
        const workspace = fixtureDir
          ? await peers.createIsolatedWorkspace({
              fixtureDir,
              workspaceRoot: executionRoot,
              campaignId: safeCampaignIdForExec,
              campaignDir,
              trialId: trial.id,
            })
          : {
              workspaceDir: await peers.trialPathUnder(executionRoot, trial.id),
              fixtureHash: null,
              executionRoot,
            };

        if (!fixtureDir) {
          await mkdir(workspace.workspaceDir, { recursive: true, mode: 0o700 });
          await peers.assertWorkspaceOutsideCampaign(
            workspace.workspaceDir,
            campaignDir,
          );
        }

        trialWorkspaceDir = workspace.workspaceDir;

        const invoker = peers.getInvoker(arm.invocationPath);
        const timeoutMs = experiment.timeoutMs;
        const request = peers.buildInvocationRequest({
          arm,
          task,
          workspaceDir: workspace.workspaceDir,
          requestId: trial.id,
          timeoutMs,
        });
        // Invocation scratch lives under the external execution workspace only —
        // never under campaign/artifacts (provider is OS-confined away from campaign).
        const scratchDir = path.join(workspace.workspaceDir, '.aicb-scratch');
        await peers.ensurePrivateDir(scratchDir);
        const requestPath = path.join(scratchDir, 'request.json');
        const outputPath = path.join(scratchDir, 'output.json');
        // Campaign-side copies (post-invocation only; trusted harness process).
        const artifactDir = await peers.trialPathUnder(artifactRoot, trial.id);
        await peers.ensurePrivateDir(artifactDir);
        const campaignRequestPath = path.join(artifactDir, 'request.json');
        const campaignOutputPath = path.join(artifactDir, 'output.json');

        // Prompt-bearing request written privately in execution scratch (0600).
        await peers.writePrivateFile(
          requestPath,
          `${JSON.stringify(request, null, 2)}\n`,
        );

        const invokerResultRaw = await invoker({
          poeticBin: arm.poeticBin || process.env.AICB_POETIC_BIN || 'poetic',
          requestPath,
          outputPath,
          request,
          cwd: workspace.workspaceDir,
          timeoutMs,
          command: arm.command,
          args: arm.args || [],
          prompt: request.prompt,
          promptTransport: arm.promptTransport,
          provider: arm.provider,
          model: arm.model,
          // OS confinement: hide campaign control/evidence while provider is alive
          campaignDir,
          scratchDir,
          env: undefined,
        });
        // Normalize wrapper ENOENT / command-not-found into infraFailure so
        // classify + raw availability stay honest under confined spawn.
        const invokerResult = normalizeInvokerInfraSignals(
          arm.invocationPath,
          invokerResultRaw,
        );

        // Trusted harness only: copy scratch request/output into campaign storage
        // after the confined provider process has exited. Never follow symlinks
        // (provider may replace scratch files with links to host content).
        try {
          const reqBody = await readFileNoFollow(requestPath);
          await peers.writePrivateFile(campaignRequestPath, reqBody);
        } catch (err) {
          if (err instanceof UnsafePathError) {
            log(`scratch request refused (unsafe path): ${err.message}`);
          }
          /* missing or unsafe request */
        }
        /** @type {string | null} */
        let recordedOutputPath = null;
        try {
          const outBody = await readFileNoFollow(outputPath);
          await peers.writePrivateFile(campaignOutputPath, outBody);
          recordedOutputPath = campaignOutputPath;
        } catch (err) {
          if (err instanceof UnsafePathError) {
            log(`scratch output refused (unsafe path): ${err.message}`);
          }
          // Do not fall back to reading invokerResult.outputPath if it may be a symlink.
          recordedOutputPath = null;
        }

        // Raw availability before quarantine: missing/invalid poetic raw,
        // confinement refusal, spawn failures, and command-not-found must not
        // become verified empty raw digests.
        const rawUnavailable = isRawEvidenceUnavailable(
          arm.invocationPath,
          invokerResult,
        );

        // Quarantine only when raw is available for reportable digests.
        // When unavailable, skip quarantine so empty files are not stored as
        // if they were verified provider evidence (forensics live on the
        // result classification / infraFailure fields instead).
        /** @type {{ path?: string, digests?: Record<string, string | null> } | null} */
        let rawQuarantine = null;
        if (!rawUnavailable) {
          rawQuarantine = await peers.quarantineRawOutput(
            campaignDir,
            trial.id,
            {
              stdout: invokerResult.stdout,
              stderr: invokerResult.stderr,
              // Only pass a path we already nofollow-verified into campaign storage
              ...(recordedOutputPath ? { outputPath: recordedOutputPath } : {}),
            },
          );
        }

        // poetic-adapter: only requestId-bound parsedOutput may supply model evidence.
        // Never reopen scratch/campaign outputPath as a fallback.
        const modelEv = resolveModelEvidence(
          arm.invocationPath,
          invokerResult,
        );

        const oracleRoot = path.join(suiteDir, 'oracles');
        // Minimal deterministic gate env: arm allowlist + sandbox posture only.
        // Never pass process.env or task YAML env.
        const gateResults = await peers.runGates({
          gates: task.eligibilityGates || [],
          workspaceDir: workspace.workspaceDir,
          oracleRoot,
          confinement,
          task,
          envAllowlist: arm.envAllowlist,
          sandboxMode: arm.sandboxMode,
        });
        const safeGateResults =
          typeof peers.sanitizeGateResultsForStorage === 'function'
            ? peers.sanitizeGateResultsForStorage(gateResults)
            : gateResults;

        let changedFileCount = null;
        try {
          const { spawnControlled } = await import(
            './invokers/spawn-controlled.js'
          );
          const { countMeaningfulChangedFiles } = await import('./gates.js');
          const diff = await spawnControlled({
            command: 'git',
            args: ['-C', workspace.workspaceDir, 'status', '--porcelain'],
            timeoutMs: 10_000,
            // Trusted harness helper — not a provider; do not require campaign mask
            confine: false,
          });
          if (diff.exitCode === 0) {
            // Exclude .poetic/** bookkeeping so telemetry-only runs are NO_OP
            changedFileCount = countMeaningfulChangedFiles(diff.stdout);
          }
        } catch {
          changedFileCount = null;
        }

        const classified = peers.classifyTrial({
          invokerResult,
          gateResults: safeGateResults,
          changedFileCount,
          timedOut: Boolean(invokerResult.timedOut),
        });

        const finishedAt = new Date().toISOString();
        trialUpdate = {
          state:
            classified.classification === 'INFRA_FAIL' ||
            classified.classification === 'TIMEOUT'
              ? 'failed'
              : 'completed',
          classification: classified.classification,
          classificationReason: classified.reason,
          requestedModel: arm.model != null ? String(arm.model) : null,
          resolvedModel: modelEv.resolvedModel,
          resolvedModelAvailable: modelEv.resolvedModelAvailable,
          resolvedModelSource: modelEv.resolvedModelSource,
          postureFingerprint:
            trial.postureFingerprint ||
            computePostureFingerprint({
              invocationPath: arm.invocationPath,
              envAllowlist: arm.envAllowlist,
              sandboxMode: arm.sandboxMode,
              extra: arm.posture,
            }),
          hashes: {
            fixtureHash: workspace.fixtureHash,
            promptHash: sha256Buffer(
              Buffer.from(String(request.prompt || ''), 'utf8'),
            ),
          },
          // Digests only — never secret-bearing gate stdout/stderr previews
          gateResults: safeGateResults,
          changedFileCount,
          startedAt,
          finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
          workspaceDir: workspace.workspaceDir,
          executionRoot,
          artifactDir,
        };

        // Exact on-disk raw bytes + artifact tree digests (not lengths alone).
        // resultDigest is computed by writeTrialResult over the final envelope.
        const artifactDigest =
          typeof peers.computeArtifactDigest === 'function'
            ? await peers.computeArtifactDigest(artifactDir)
            : await digestArtifactDir(artifactDir);
        // Prefer frozen expectedFixtureDigest authority; fall back to workspace hash.
        const fixtureDigest =
          trial.expectedFixtureDigest != null
            ? String(trial.expectedFixtureDigest)
            : workspace.fixtureHash;

        // When raw is unavailable: mark rawEvidenceUnavailable and omit all
        // raw* digest claims so verify classifies the record as unavailable
        // (never "verified empty" provider evidence).
        const digests = rawUnavailable
          ? peers.buildTrialDigests({
              artifactDigest,
              fixtureDigest,
              rawEvidenceUnavailable: true,
            })
          : peers.buildTrialDigests({
              artifactDigest,
              fixtureDigest,
              rawOutputDigest: rawQuarantine?.digests?.rawOutputDigest,
              rawStdoutSha256: rawQuarantine?.digests?.rawStdoutSha256,
              rawStderrSha256: rawQuarantine?.digests?.rawStderrSha256,
              rawOutputFileSha256: rawQuarantine?.digests?.rawOutputFileSha256,
            });

        // Do not persist manifest-only authority fields on the public result record.
        const {
          expectedFixtureDigest: _expFix,
          fixturePath: _fixPath,
          ...trialPublic
        } = trial;
        await peers.writeTrialResult(
          campaignDir,
          trial.id,
          {
            ...trialPublic,
            ...trialUpdate,
            exitCode: invokerResult.exitCode,
            digests,
          },
          // Bind identity to frozen manifest trial row (lane B contract).
          { manifestTrial: trial },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trialUpdate = {
          state: 'failed',
          classification: 'INFRA_FAIL',
          classificationReason: message,
          error: message,
          resolvedModel: null,
          resolvedModelAvailable: false,
          resolvedModelSource: 'unavailable',
          finishedAt: new Date().toISOString(),
          startedAt,
          ...(trialWorkspaceDir
            ? { workspaceDir: trialWorkspaceDir, executionRoot }
            : { executionRoot }),
        };
        try {
          // Infra path without provider raw artifacts: mark unavailable for reportability.
          // resultDigest stamped by writeTrialResult over the final envelope.
          const infraDigests = peers.buildTrialDigests({});
          infraDigests.rawEvidenceUnavailable = true;
          const {
            expectedFixtureDigest: _expFix2,
            fixturePath: _fixPath2,
            ...trialPublicInfra
          } = trial;
          await peers.writeTrialResult(
            campaignDir,
            trial.id,
            {
              ...trialPublicInfra,
              ...trialUpdate,
              // Ensure required identity fields exist for schema write
              experimentId: trial.experimentId ?? trialPublicInfra.experimentId,
              arm: trial.arm ?? trialPublicInfra.arm,
              taskId: trial.taskId ?? trialPublicInfra.taskId,
              repetition: trial.repetition ?? trialPublicInfra.repetition,
              scheduleSeed: trial.scheduleSeed ?? trialPublicInfra.scheduleSeed,
              invocationPath:
                trial.invocationPath ?? trialPublicInfra.invocationPath,
              requestedModel:
                trial.requestedModel !== undefined
                  ? trial.requestedModel
                  : trialPublicInfra.requestedModel ?? null,
              exitCode: null,
              digests: infraDigests,
            },
            { manifestTrial: trial },
          );
        } catch {
          /* best effort */
        }
      } finally {
        // Remove external execution workspace after trial when possible.
        if (trialWorkspaceDir) {
          await peers
            .cleanupExecutionWorkspace(trialWorkspaceDir, {
              executionRoot,
            })
            .catch(() => {});
        }
      }

      peers.updateTrial(manifest, trial.id, trialUpdate);
      await peers.saveManifest(campaignDir, manifest);
      executed += 1;
      pending = manifest.trials.filter((t) => t.state === 'pending');
      log(`trial ${trial.id} → ${trialUpdate.classification || trialUpdate.state}`);
    }

    const trialResults = [];
    for (const t of manifest.trials) {
      if (t.state === 'completed' || t.state === 'failed') {
        try {
          const { readTrialResult } = await import('./results.js');
          trialResults.push(await readTrialResult(campaignDir, t.id));
        } catch {
          trialResults.push(t);
        }
      }
    }

    // Before report/summary: full evidence verification (resultDigest envelope,
    // raw/artifact bytes, fixture authority). Unavailable/unverified records
    // must not produce a benchmark report (fail closed).
    const evidenceCheck = await peers.verifyCampaignEvidenceDigests(
      campaignDir,
      manifest.trials,
      trialResults,
      { failOnUnavailable: true },
    );
    if (!evidenceCheck.ok) {
      // Do not write or reuse report.json when evidence is unavailable/tampered.
      return {
        ok: false,
        stage: 'evidence',
        campaignDir,
        manifest,
        executed,
        remaining: manifest.trials.filter((t) => t.state === 'pending').length,
        errors: [
          evidenceCheck.error ||
            'evidence digest verification failed (no benchmark report)',
        ],
        failures: evidenceCheck.failures,
        unavailable: evidenceCheck.unavailable,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    // Only fully verified results enter the benchmark report.
    const reportable =
      evidenceCheck.reportableResults &&
      evidenceCheck.reportableResults.length > 0
        ? evidenceCheck.reportableResults
        : [];

    const report = peers.buildReport(manifest, reportable);
    const human = peers.formatHumanSummary(report);
    await writeFile(
      path.join(campaignDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(campaignDir, 'summary.txt'), `${human}\n`, 'utf8');

    const remaining = manifest.trials.filter((t) => t.state === 'pending').length;
    manifest.status = remaining === 0 ? 'completed' : 'paused';
    manifest.updatedAt = new Date().toISOString();
    if (manifest.status === 'completed') {
      manifest.completedAt = manifest.updatedAt;
    }
    await peers.saveManifest(campaignDir, manifest);

    return {
      ok: true,
      stage: 'complete',
      campaignDir,
      manifest,
      report,
      humanSummary: human,
      executed,
      remaining,
      verified: evidenceCheck.verified,
      schemaVersion: SCHEMA_VERSION,
      warnings: [
        ...pf.warnings,
        ...(confinement.available
          ? []
          : ['gate confinement unavailable — gates fail closed']),
      ],
    };
  } finally {
    try {
      await peers.releaseLock(campaignDir, ownerId);
    } catch {
      /* ignore */
    }
  }
}
