/**
 * Canonical `run` orchestration: preflight → expand → lock → trials → summary.
 * No Poetic workflow wrapper. Does not invoke live providers unless invokers are configured.
 * Resumable and deterministic.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    },
    { createIsolatedWorkspace },
    { getInvoker, buildInvocationRequest },
    { runGates, detectConfinement },
    { classifyTrial },
    { writeTrialResult, quarantineRawOutput, ensurePrivateDir },
    { buildReport, formatHumanSummary },
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
    createIsolatedWorkspace,
    getInvoker,
    buildInvocationRequest,
    runGates,
    detectConfinement,
    classifyTrial,
    writeTrialResult,
    quarantineRawOutput,
    ensurePrivateDir,
    buildReport,
    formatHumanSummary,
  };
}

/**
 * Resolve suite path and suite-dir corpus root from experiment + corpusRoot.
 * @param {object} experiment
 * @param {string} corpusRoot
 * @returns {{ suitePath: string, suiteDir: string }}
 */
export function resolveSuiteLocation(experiment, corpusRoot) {
  const root = path.resolve(corpusRoot);
  let suitePath;
  if (experiment.suitePath != null) {
    suitePath = path.isAbsolute(experiment.suitePath)
      ? experiment.suitePath
      : path.resolve(root, experiment.suitePath);
  } else if (experiment.suiteId) {
    suitePath = path.join(root, experiment.suiteId, 'suite.yaml');
  } else {
    // corpusRoot itself may be the suite directory
    suitePath = path.join(root, 'suite.yaml');
  }
  return { suitePath, suiteDir: path.dirname(suitePath) };
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
  const campaignDir =
    opts.campaignDir != null
      ? path.resolve(opts.campaignDir)
      : path.join(os.tmpdir(), 'aicb-campaigns', opts.experiment.id || 'campaign');

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

  await mkdir(campaignDir, { recursive: true });
  await peers.ensurePrivateDir(path.join(campaignDir, 'raw'));
  await mkdir(path.join(campaignDir, 'results'), { recursive: true });
  await mkdir(path.join(campaignDir, 'workspaces'), { recursive: true });
  await mkdir(path.join(campaignDir, 'artifacts'), { recursive: true });

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
    const { suitePath, suiteDir } = resolveSuiteLocation(
      opts.experiment,
      corpusRoot,
    );

    const suite = await peers.loadSuite(suitePath);

    const taskIds = opts.experiment.taskIds?.length
      ? opts.experiment.taskIds
      : suite.tasks;

    // loadCorpusTasks: first arg is suite dir (where tasks/ lives)
    const suiteForLoad = { ...suite, tasks: taskIds };
    const loaded = await peers.loadCorpusTasks(suiteDir, suiteForLoad);
    const tasksById = tasksByIdFromLoad(loaded);

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

    let manifest;
    if (opts.resume !== false) {
      try {
        manifest = await peers.loadManifest(campaignDir);
      } catch {
        manifest = null;
      }
    }

    if (!manifest) {
      const trials = peers.expandExperiment(opts.experiment, {
        tasks: taskIds.map((id) => tasksById[id]),
        arms: opts.experiment.arms,
      });

      manifest = peers.createManifest({
        campaignId: opts.experiment.id,
        experimentId: opts.experiment.id,
        experiment: opts.experiment,
        trials,
        scheduleSeed: opts.experiment.seed,
        artifactRoot: path.join(campaignDir, 'artifacts'),
        workspaceRoot: path.join(campaignDir, 'workspaces'),
        host: {
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          cpus: os.cpus()?.length ?? 0,
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
      log(`resumed campaign ${manifest.campaignId}`);
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

      const arm = opts.experiment.arms.find((a) => a.name === trial.arm);
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
        const fixtureName = task.fixturePath;
        const fixtureDir = fixtureName
          ? path.join(suiteDir, 'fixtures', fixtureName)
          : null;

        const workspace = fixtureDir
          ? await peers.createIsolatedWorkspace({
              fixtureDir,
              workspaceRoot: path.join(campaignDir, 'workspaces'),
              trialId: trial.id,
            })
          : {
              workspaceDir: path.join(campaignDir, 'workspaces', trial.id),
              fixtureHash: null,
            };

        if (!fixtureDir) {
          await mkdir(workspace.workspaceDir, { recursive: true });
        }

        const invoker = peers.getInvoker(arm.invocationPath);
        const timeoutMs = opts.experiment.timeoutMs;
        const request = peers.buildInvocationRequest({
          arm,
          task,
          workspaceDir: workspace.workspaceDir,
          requestId: trial.id,
          timeoutMs,
        });
        const requestPath = path.join(
          campaignDir,
          'artifacts',
          trial.id,
          'request.json',
        );
        const outputPath = path.join(
          campaignDir,
          'artifacts',
          trial.id,
          'output.json',
        );
        await mkdir(path.dirname(requestPath), { recursive: true });

        const invokerResult = await invoker({
          poeticBin: arm.poeticBin || process.env.AICB_POETIC_BIN || 'poetic',
          requestPath,
          outputPath,
          request,
          cwd: workspace.workspaceDir,
          timeoutMs,
          command: arm.command,
          args: arm.args || [],
          prompt: request.prompt,
          provider: arm.provider,
          model: arm.model,
          // harness-controlled env only; never task YAML
          env: undefined,
        });

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
        const gateResults = await peers.runGates({
          gates: task.eligibilityGates || [],
          workspaceDir: workspace.workspaceDir,
          oracleRoot,
          confinement,
          task,
        });

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
          gateResults,
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
          gateResults,
          changedFileCount,
          startedAt,
          finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
          workspaceDir: workspace.workspaceDir,
          artifactDir: path.join(campaignDir, 'artifacts', trial.id),
        };

        await peers.writeTrialResult(campaignDir, trial.id, {
          ...trial,
          ...trialUpdate,
          digests: {
            resultDigest: sha256Json({
              classification: classified.classification,
              gateResults,
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
