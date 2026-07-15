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
import { sha256Json, sha256Buffer } from './digest.js';
import { computePostureFingerprint } from './posture.js';
import {
  parseResolvedModelEvidence,
} from './invokers/index.js';

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
    { createIsolatedWorkspace },
    { getInvoker, buildInvocationRequest },
    { runGates, detectConfinement, sanitizeGateResultsForStorage },
    { classifyTrial },
    { writeTrialResult, quarantineRawOutput, ensurePrivateDir, writePrivateFile },
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
 * @param {string} invocationPath
 * @param {object} invokerResult
 * @param {string} [outputPath]
 * @returns {Promise<{ resolvedModel: string | null, resolvedModelAvailable: boolean, resolvedModelSource: string }>}
 */
async function resolveModelEvidence(invocationPath, invokerResult, outputPath) {
  if (invocationPath === 'poetic-adapter') {
    let artifact = invokerResult?.parsedOutput ?? null;
    if (!artifact && outputPath) {
      try {
        const text = await readFile(outputPath, 'utf8');
        artifact = JSON.parse(text);
      } catch {
        artifact = null;
      }
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
  await peers.ensurePrivateDir(campaignDir);
  await peers.ensurePrivateDir(path.join(campaignDir, 'raw'));
  await peers.ensurePrivateDir(path.join(campaignDir, 'results'));
  await peers.ensurePrivateDir(path.join(campaignDir, 'workspaces'));
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

    const workspaceRoot = path.join(campaignDir, 'workspaces');
    const artifactRoot = path.join(campaignDir, 'artifacts');

    if (!manifest) {
      const trials = peers.expandExperiment(experiment, {
        tasks: taskList,
        arms: experiment.arms,
      });

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

        const workspace = fixtureDir
          ? await peers.createIsolatedWorkspace({
              fixtureDir,
              workspaceRoot,
              trialId: trial.id,
            })
          : {
              workspaceDir: await peers.trialPathUnder(workspaceRoot, trial.id),
              fixtureHash: null,
            };

        if (!fixtureDir) {
          await mkdir(workspace.workspaceDir, { recursive: true });
        }

        const invoker = peers.getInvoker(arm.invocationPath);
        const timeoutMs = experiment.timeoutMs;
        const request = peers.buildInvocationRequest({
          arm,
          task,
          workspaceDir: workspace.workspaceDir,
          requestId: trial.id,
          timeoutMs,
        });
        const artifactDir = await peers.trialPathUnder(artifactRoot, trial.id);
        await peers.ensurePrivateDir(artifactDir);
        const requestPath = path.join(artifactDir, 'request.json');
        const outputPath = path.join(artifactDir, 'output.json');

        // Prompt-bearing request written privately (0600) even under permissive umask.
        await peers.writePrivateFile(
          requestPath,
          `${JSON.stringify(request, null, 2)}\n`,
        );

        const invokerResult = await invoker({
          poeticBin: arm.poeticBin || process.env.AICB_POETIC_BIN || 'poetic',
          requestPath,
          outputPath,
          // request already written privately; still pass for invokers that re-write
          request,
          cwd: workspace.workspaceDir,
          timeoutMs,
          command: arm.command,
          args: arm.args || [],
          prompt: request.prompt,
          // native-cli: enumerated prompt transport only ('stdin' | 'prompt-file')
          promptTransport: arm.promptTransport,
          provider: arm.provider,
          model: arm.model,
          // harness-controlled env only; never task YAML
          env: undefined,
        });

        // Re-assert private modes after invoker may have rewritten request/output.
        await tryChmod(requestPath, 0o600);
        try {
          await access(outputPath);
          await tryChmod(outputPath, 0o600);
        } catch {
          /* output may be absent on infra failure */
        }

        await peers.quarantineRawOutput(campaignDir, trial.id, {
          stdout: invokerResult.stdout,
          stderr: invokerResult.stderr,
          outputPath: invokerResult.outputPath || outputPath,
        });

        const modelEv = await resolveModelEvidence(
          arm.invocationPath,
          invokerResult,
          outputPath,
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
          artifactDir,
        };

        await peers.writeTrialResult(campaignDir, trial.id, {
          ...trial,
          ...trialUpdate,
          digests: {
            resultDigest: sha256Json({
              classification: classified.classification,
              gateResults: safeGateResults,
              exitCode: invokerResult.exitCode,
            }),
            rawOutputDigest: sha256Json({
              stdoutLen: (invokerResult.stdout || '').length,
              stderrLen: (invokerResult.stderr || '').length,
            }),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trialUpdate = {
          state: 'failed',
          classification: 'INFRA_FAIL',
          classificationReason: message,
          error: message,
          resolvedModel: null,
          resolvedModelAvailable: false,
          finishedAt: new Date().toISOString(),
          startedAt,
        };
        try {
          await peers.writeTrialResult(campaignDir, trial.id, {
            ...trial,
            ...trialUpdate,
          });
        } catch {
          /* best effort */
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

    const report = peers.buildReport(manifest, trialResults);
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
