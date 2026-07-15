/**
 * Experiment expansion to a deterministic trial matrix and next-trial selection.
 *
 * Ordering is seeded (mulberry32) and stable. Each trial stub records
 * invocationPath, requestedModel, and postureFingerprint so paths are never
 * silently mixed in schedule metadata.
 */

import { createHash } from 'node:crypto';
import { computePostureFingerprint } from './posture.js';

/**
 * mulberry32 PRNG — returns a function yielding [0, 1).
 * @param {number} seed uint32
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert experiment seed (number or string) to a uint32 for the PRNG.
 * @param {number | string} seed
 * @returns {number}
 */
export function seedToUint32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed >>> 0;
  }
  const hex = createHash('sha256').update(String(seed), 'utf8').digest('hex');
  return Number.parseInt(hex.slice(0, 8), 16) >>> 0;
}

/**
 * Fisher–Yates shuffle using a provided RNG. Mutates a copy; input is not modified.
 * @template T
 * @param {T[]} items
 * @param {() => number} rng
 * @returns {T[]}
 */
export function seededShuffle(items, rng) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Stable trial id from seed + arm + task + repetition.
 * @param {{ seed: number|string, arm: string, taskId: string, repetition: number }} parts
 * @returns {string}
 */
export function makeTrialId({ seed, arm, taskId, repetition }) {
  const payload = JSON.stringify({
    arm: String(arm),
    repetition: Number(repetition),
    seed: typeof seed === 'number' ? seed : String(seed),
    taskId: String(taskId),
  });
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
  const safeArm = String(arm).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const safeTask = String(taskId).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${safeArm}__${safeTask}__r${Number(repetition)}__${hex}`;
}

/**
 * @param {unknown} task
 * @returns {string}
 */
function resolveTaskId(task) {
  if (typeof task === 'string') return task;
  if (task && typeof task === 'object') {
    const t = /** @type {Record<string, unknown>} */ (task);
    if (t.taskId != null) return String(t.taskId);
    if (t.id != null) return String(t.id);
  }
  throw new Error('expandExperiment: task is missing taskId/id');
}

/**
 * Expand an experiment into ordered trial stubs (arms × tasks × repetitions).
 *
 * @param {object} experiment
 * @param {object} [opts]
 * @param {Array<object|string>} [opts.tasks] task objects or ids (defaults to experiment.taskIds)
 * @param {Array<object>} [opts.arms] arm objects (defaults to experiment.arms)
 * @returns {object[]} ordered trial stubs with state 'pending'
 */
export function expandExperiment(experiment, opts = {}) {
  if (!experiment || typeof experiment !== 'object') {
    throw new Error('expandExperiment: experiment is required');
  }
  if (experiment.seed == null) {
    throw new Error('expandExperiment: experiment.seed is required');
  }
  const repetitions = Number(experiment.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error('expandExperiment: experiment.repetitions must be an integer >= 1');
  }

  const arms = opts.arms ?? experiment.arms;
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error('expandExperiment: arms must be a non-empty array');
  }

  let tasks = opts.tasks;
  if (tasks == null) {
    if (Array.isArray(experiment.taskIds) && experiment.taskIds.length > 0) {
      tasks = experiment.taskIds;
    } else {
      throw new Error('expandExperiment: tasks or experiment.taskIds required');
    }
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('expandExperiment: tasks must be a non-empty array');
  }

  const scheduleSeed = experiment.seed;
  const experimentId = experiment.id != null ? String(experiment.id) : 'experiment';

  /** @type {object[]} */
  const stubs = [];

  for (const arm of arms) {
    if (!arm || typeof arm !== 'object' || !arm.name) {
      throw new Error('expandExperiment: each arm requires name');
    }
    if (!arm.invocationPath) {
      throw new Error(`expandExperiment: arm "${arm.name}" missing invocationPath`);
    }
    if (!arm.model) {
      throw new Error(`expandExperiment: arm "${arm.name}" missing model`);
    }
    if (arm.provider == null || String(arm.provider).trim() === '') {
      throw new Error(
        `expandExperiment: arm "${arm.name}" missing provider (fail closed)`,
      );
    }

    let postureFingerprint = null;
    try {
      postureFingerprint = computePostureFingerprint({
        invocationPath: arm.invocationPath,
        envAllowlist: arm.envAllowlist,
        sandboxMode: arm.sandboxMode,
        extra: arm.posture,
      });
    } catch {
      postureFingerprint = null;
    }

    for (const task of tasks) {
      const taskId = resolveTaskId(task);
      for (let rep = 1; rep <= repetitions; rep += 1) {
        stubs.push({
          id: makeTrialId({
            seed: scheduleSeed,
            arm: arm.name,
            taskId,
            repetition: rep,
          }),
          experimentId,
          arm: String(arm.name),
          provider: String(arm.provider).trim(),
          taskId,
          repetition: rep,
          scheduleSeed,
          invocationPath: arm.invocationPath,
          requestedModel: String(arm.model),
          resolvedModel: null,
          postureFingerprint,
          state: 'pending',
          classification: null,
        });
      }
    }
  }

  const rng = mulberry32(seedToUint32(scheduleSeed));
  return seededShuffle(stubs, rng);
}

/**
 * Select the next trial to run from a list (typically pending trials).
 *
 * Default fairness: at most one active trial per provider when
 * `oneActivePerProvider` is true (the default).
 *
 * @param {object[]} trials candidate trials (usually pending)
 * @param {object} [opts]
 * @param {boolean} [opts.oneActivePerProvider=true]
 * @param {object[]} [opts.active] currently running trials
 * @returns {object | null}
 */
export function nextTrial(trials, opts = {}) {
  if (!Array.isArray(trials) || trials.length === 0) {
    return null;
  }

  const oneActivePerProvider = opts.oneActivePerProvider !== false;
  const active = Array.isArray(opts.active) ? opts.active : [];

  /** @type {Set<string>} */
  const busyProviders = new Set();
  if (oneActivePerProvider) {
    for (const t of active) {
      if (t && t.provider != null && t.provider !== '') {
        busyProviders.add(String(t.provider));
      }
    }
  }

  for (const trial of trials) {
    if (!trial) continue;
    if (trial.state != null && trial.state !== 'pending') {
      continue;
    }
    if (oneActivePerProvider && trial.provider != null && trial.provider !== '') {
      if (busyProviders.has(String(trial.provider))) {
        continue;
      }
    }
    return trial;
  }

  return null;
}
