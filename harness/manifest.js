/**
 * Resumable atomic campaign manifest under the campaign directory.
 * Writes via exclusive no-follow temp + rename (atomic on the same filesystem).
 * Validates shape on load/save; freezes and verifies input digests for resume integrity.
 * Campaign root and ancestors are physically validated before any write.
 */

import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, TRIAL_STATUSES } from './contracts.js';
import {
  sha256File,
  sha256Json,
  digestArtifactDir,
  digestHarnessContent,
} from './digest.js';
import { assertSafeCampaignId, assertSafeTrialId, resolveUnder } from './paths.js';
import {
  assertCampaignFilesystemBoundary,
  ensurePrivateDirNoFollow,
  readTextNoFollow,
  writeFileAtomicNoFollow,
  DEFAULT_SAFE_READ_MAX_BYTES,
} from './safe-fs.js';

/** Bound for campaign manifest.json nofollow reads (same default as other safe reads). */
const MANIFEST_MAX_BYTES = DEFAULT_SAFE_READ_MAX_BYTES;

export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_TMP_FILENAME = 'manifest.json.tmp';

export const CAMPAIGN_STATUSES = Object.freeze([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'aborted',
]);

/** @type {Record<string, ReadonlySet<string>>} */
const ALLOWED_TRANSITIONS = {
  pending: new Set(['running', 'skipped']),
  // running → pending is allowed for crash recovery (interrupted trials)
  running: new Set(['completed', 'failed', 'skipped', 'pending']),
  completed: new Set(),
  failed: new Set(),
  skipped: new Set(),
};

/**
 * Host metadata snapshot for campaign records.
 * @returns {{ hostname: string, platform: string, arch: string, nodeVersion: string, cpus: number, totalMemoryBytes: number, user?: string }}
 */
export function buildHostMetadata() {
  /** @type {{ hostname: string, platform: string, arch: string, nodeVersion: string, cpus: number, totalMemoryBytes: number, user?: string }} */
  const host = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpus: os.cpus()?.length ?? 1,
    totalMemoryBytes: os.totalmem(),
  };
  // Do not record local username (sanitized exports must not leak it).
  return host;
}

/**
 * Validate a trial state transition.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTrialTransition(from, to) {
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * @param {string} from
 * @param {string} to
 */
function assertTransition(from, to) {
  if (!TRIAL_STATUSES.includes(to)) {
    throw new Error(`updateTrial: invalid target state "${to}"`);
  }
  if (!isValidTrialTransition(from, to)) {
    throw new Error(`updateTrial: illegal state transition ${from} → ${to}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`validateManifest: ${label} must be a non-empty string`);
  }
}

/**
 * @param {unknown} digests
 * @param {{ required?: boolean }} [opts]
 */
function validateInputDigestsShape(digests, opts = {}) {
  if (digests == null) {
    if (opts.required) {
      throw new Error('validateManifest: inputDigests is required');
    }
    return;
  }
  if (typeof digests !== 'object' || Array.isArray(digests)) {
    throw new Error('validateManifest: inputDigests must be an object');
  }
  const d = /** @type {Record<string, unknown>} */ (digests);
  if (d.schemaVersion !== 1 && d.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `validateManifest: inputDigests.schemaVersion unsupported: ${d.schemaVersion}`,
    );
  }
  for (const key of ['experiment', 'suite', 'tasks', 'harness']) {
    if (typeof d[key] !== 'string' || !/^[a-f0-9]{64}$/.test(d[key])) {
      throw new Error(
        `validateManifest: inputDigests.${key} must be a sha256 hex digest`,
      );
    }
  }
  for (const key of ['fixtures', 'oracles']) {
    if (d[key] == null) continue;
    if (typeof d[key] !== 'string' || !/^[a-f0-9]{64}$/.test(/** @type {string} */ (d[key]))) {
      throw new Error(
        `validateManifest: inputDigests.${key} must be a sha256 hex digest when present`,
      );
    }
  }
}

/**
 * Fully validate a loaded/created campaign manifest shape.
 * Fail-closed: throws on any structural or identifier violation.
 *
 * @param {unknown} manifest
 * @param {{ requireInputDigests?: boolean }} [opts]
 * @returns {object} the same manifest (typed as object)
 */
export function validateManifest(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('validateManifest: manifest must be an object');
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);

  assertNonEmptyString(m.campaignId, 'campaignId');
  try {
    assertSafeCampaignId(m.campaignId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`validateManifest: campaignId invalid: ${msg}`);
  }
  if (m.experimentId != null && m.experimentId !== '') {
    try {
      assertSafeCampaignId(m.experimentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`validateManifest: experimentId invalid: ${msg}`);
    }
  }
  if (m.schemaVersion !== 1 && m.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `validateManifest: unsupported schemaVersion ${m.schemaVersion}`,
    );
  }
  assertNonEmptyString(m.status, 'status');
  if (!CAMPAIGN_STATUSES.includes(/** @type {string} */ (m.status))) {
    throw new Error(`validateManifest: invalid campaign status "${m.status}"`);
  }
  assertNonEmptyString(m.createdAt, 'createdAt');
  assertNonEmptyString(m.updatedAt, 'updatedAt');

  if (!m.lock || typeof m.lock !== 'object' || Array.isArray(m.lock)) {
    throw new Error('validateManifest: lock object is required');
  }
  const lock = /** @type {Record<string, unknown>} */ (m.lock);
  if (typeof lock.held !== 'boolean') {
    throw new Error('validateManifest: lock.held must be boolean');
  }
  if (lock.owner != null && typeof lock.owner !== 'string') {
    throw new Error('validateManifest: lock.owner must be string or null');
  }

  if (!Array.isArray(m.trials)) {
    throw new Error('validateManifest: trials must be an array');
  }

  /** @type {Set<string>} */
  const seenIds = new Set();
  for (let i = 0; i < m.trials.length; i += 1) {
    const t = m.trials[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new Error(`validateManifest: trials[${i}] must be an object`);
    }
    const trial = /** @type {Record<string, unknown>} */ (t);
    if (typeof trial.id !== 'string') {
      throw new Error(`validateManifest: trials[${i}].id must be a string`);
    }
    try {
      assertSafeTrialId(trial.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`validateManifest: trials[${i}].id invalid: ${msg}`);
    }
    if (seenIds.has(trial.id)) {
      throw new Error(`validateManifest: duplicate trial id "${trial.id}"`);
    }
    seenIds.add(trial.id);

    if (typeof trial.state !== 'string' || !TRIAL_STATUSES.includes(trial.state)) {
      throw new Error(
        `validateManifest: trials[${i}].state invalid: "${trial.state}"`,
      );
    }
  }

  validateInputDigestsShape(m.inputDigests, {
    required: Boolean(opts.requireInputDigests),
  });

  return /** @type {object} */ (manifest);
}

/**
 * Strip harness-internal fields before digesting task documents.
 * @param {object} task
 * @returns {object}
 */
function cleanTaskForDigest(task) {
  if (!task || typeof task !== 'object') return task;
  const {
    _resolvedFixtureDir: _drop,
    ...rest
  } = /** @type {Record<string, unknown>} */ (task);
  return rest;
}

/**
 * Freeze digests of campaign inputs for resume integrity.
 * Uses digest.js hashes; suite/tasks should already be loaded via load.js.
 * `harness` is a content digest of harness/** + schemas/** + package files
 * (symlink-safe; never follows link targets for content).
 *
 * @param {object} opts
 * @param {object} opts.experiment
 * @param {object} opts.suite
 * @param {object[]} opts.tasks
 * @param {string} opts.suiteDir - corpus suite directory (fixtures/oracles live here)
 * @param {string} [opts.harnessRoot]
 * @returns {Promise<{
 *   schemaVersion: number,
 *   experiment: string,
 *   suite: string,
 *   tasks: string,
 *   fixtures: string,
 *   oracles: string,
 *   harness: string,
 * }>}
 */
export async function computeCampaignInputDigests(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('computeCampaignInputDigests: options required');
  }
  const { experiment, suite, tasks, suiteDir, harnessRoot } = opts;
  if (!experiment || typeof experiment !== 'object') {
    throw new Error('computeCampaignInputDigests: experiment required');
  }
  if (!suite || typeof suite !== 'object') {
    throw new Error('computeCampaignInputDigests: suite required');
  }
  if (!Array.isArray(tasks)) {
    throw new Error('computeCampaignInputDigests: tasks array required');
  }
  if (!suiteDir) {
    throw new Error('computeCampaignInputDigests: suiteDir required');
  }

  const cleanTasks = tasks.map((t) => cleanTaskForDigest(t));

  /** @type {Record<string, string>} */
  const fixtures = {};
  for (const t of tasks) {
    const fixturePath =
      t && typeof t.fixturePath === 'string' ? t.fixturePath : null;
    if (!fixturePath || fixtures[fixturePath]) continue;
    // Constrain fixture path under suite fixtures root.
    const fixtureAbs = await resolveUnder(
      path.join(suiteDir, 'fixtures'),
      fixturePath,
    );
    fixtures[fixturePath] = await digestArtifactDir(fixtureAbs);
  }

  /** @type {Record<string, string>} */
  const oracles = {};
  for (const t of tasks) {
    const gates = Array.isArray(t?.eligibilityGates) ? t.eligibilityGates : [];
    for (const g of gates) {
      const oraclePath =
        g && typeof g.oraclePath === 'string' ? g.oraclePath : null;
      if (!oraclePath || oracles[oraclePath]) continue;
      const oracleAbs = await resolveUnder(
        path.join(suiteDir, 'oracles'),
        oraclePath,
      );
      try {
        oracles[oraclePath] = await sha256File(oracleAbs);
      } catch {
        // Missing oracle files still contribute a stable sentinel so resume
        // detects later appearance/disappearance as a digest mismatch.
        oracles[oraclePath] = sha256Json({
          missing: true,
          oraclePath,
        });
      }
    }
  }

  // Content digest of harness implementation + contracts (not package metadata alone).
  const harness = await digestHarnessContent(
    harnessRoot ? path.resolve(harnessRoot) : null,
  );

  return {
    schemaVersion: 1,
    experiment: sha256Json(experiment),
    suite: sha256Json(suite),
    tasks: sha256Json(cleanTasks),
    fixtures: sha256Json(fixtures),
    oracles: sha256Json(oracles),
    harness,
  };
}

/**
 * Fail-closed comparison of frozen vs recomputed input digests.
 * @param {object | null | undefined} frozen - from manifest.inputDigests
 * @param {object} current - recomputed digests
 * @returns {{ ok: true } | { ok: false, mismatches: string[], error: string }}
 */
export function compareInputDigests(frozen, current) {
  if (!frozen || typeof frozen !== 'object') {
    return {
      ok: false,
      mismatches: ['inputDigests'],
      error: 'inputDigests missing from manifest (fail closed)',
    };
  }
  if (!current || typeof current !== 'object') {
    return {
      ok: false,
      mismatches: ['current'],
      error: 'current input digests missing (fail closed)',
    };
  }
  const keys = [
    'schemaVersion',
    'experiment',
    'suite',
    'tasks',
    'fixtures',
    'oracles',
    'harness',
  ];
  /** @type {string[]} */
  const mismatches = [];
  for (const key of keys) {
    if (
      /** @type {Record<string, unknown>} */ (frozen)[key] !==
      /** @type {Record<string, unknown>} */ (current)[key]
    ) {
      mismatches.push(key);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      mismatches,
      error: `input digest mismatch (fail closed): ${mismatches.join(', ')}`,
    };
  }
  return { ok: true };
}

/**
 * Create a schema-shaped campaign manifest (schemaVersion 1).
 *
 * @param {object} opts
 * @param {string} opts.campaignId
 * @param {string} [opts.experimentId]
 * @param {object} [opts.experiment]
 * @param {object[]} opts.trials
 * @param {number|string|null} [opts.scheduleSeed]
 * @param {string|null} [opts.corpusRevision]
 * @param {string|null} [opts.harnessRevision]
 * @param {object} [opts.host]
 * @param {object} [opts.lock]
 * @param {string|null} [opts.artifactRoot]
 * @param {string|null} [opts.workspaceRoot]
 * @param {string} [opts.status]
 * @param {object} [opts.inputDigests]
 * @returns {object}
 */
export function createManifest(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('createManifest: options object required');
  }
  if (!opts.campaignId) {
    throw new Error('createManifest: campaignId is required');
  }
  const safeCampaignId = assertSafeCampaignId(opts.campaignId);
  const safeExperimentId =
    opts.experimentId != null && opts.experimentId !== ''
      ? assertSafeCampaignId(opts.experimentId)
      : safeCampaignId;
  if (!Array.isArray(opts.trials)) {
    throw new Error('createManifest: trials must be an array');
  }

  const now = new Date().toISOString();
  const trials = opts.trials.map((t, i) => {
    if (!t || typeof t !== 'object') {
      throw new Error(`createManifest: trials[${i}] must be an object`);
    }
    const id = assertSafeTrialId(t.id);
    const state = t.state ?? 'pending';
    if (!TRIAL_STATUSES.includes(state)) {
      throw new Error(`createManifest: trials[${i}].state invalid: "${state}"`);
    }
    return {
      ...t,
      id,
      state,
    };
  });

  const manifest = {
    campaignId: safeCampaignId,
    schemaVersion: SCHEMA_VERSION,
    status: opts.status ?? 'pending',
    experimentId: safeExperimentId,
    experiment: opts.experiment ?? undefined,
    lock: opts.lock ?? {
      held: false,
      owner: null,
      acquiredAt: null,
      path: null,
    },
    trials,
    corpusRevision: opts.corpusRevision ?? null,
    harnessRevision: opts.harnessRevision ?? null,
    host: opts.host ?? buildHostMetadata(),
    scheduleSeed: opts.scheduleSeed ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    artifactRoot: opts.artifactRoot ?? null,
    workspaceRoot: opts.workspaceRoot ?? null,
    ...(opts.inputDigests != null ? { inputDigests: opts.inputDigests } : {}),
  };

  return validateManifest(manifest);
}

/**
 * Load manifest.json from a campaign directory and fully validate shape.
 * Physically validates the campaign boundary first, then reads the leaf with
 * readFileNoFollow so a pre-planted manifest.json symlink cannot exfiltrate
 * or inject host content on resume.
 *
 * @param {string} campaignDir
 * @returns {Promise<object>}
 */
export async function loadManifest(campaignDir) {
  if (!campaignDir) {
    throw new Error('loadManifest: campaignDir is required');
  }
  const root = await assertCampaignFilesystemBoundary(campaignDir);
  const p = path.join(root, MANIFEST_FILENAME);
  // Never follow a pre-planted leaf symlink into host content.
  const text = await readTextNoFollow(p, { maxBytes: MANIFEST_MAX_BYTES });
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`loadManifest: invalid JSON: ${message}`);
  }
  return validateManifest(data);
}

/**
 * Atomically persist a campaign manifest via no-follow exclusive temp + rename.
 * Rejects symlink campaign roots/ancestors and pre-planted manifest leaf/temp
 * symlinks. Temp basenames are unpredictable (not manifest.json.tmp alone).
 *
 * @param {string} campaignDir
 * @param {object} manifest
 * @returns {Promise<{ path: string }>}
 */
export async function saveManifest(campaignDir, manifest) {
  if (!campaignDir) {
    throw new Error('saveManifest: campaignDir is required');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('saveManifest: manifest is required');
  }

  const root = await assertCampaignFilesystemBoundary(campaignDir);
  await ensurePrivateDirNoFollow(root);

  const updated = {
    ...manifest,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  validateManifest(updated);

  const finalPath = path.join(root, MANIFEST_FILENAME);
  const body = `${JSON.stringify(updated, null, 2)}\n`;
  await writeFileAtomicNoFollow(finalPath, body, { mode: 0o600, fsync: true });

  // Reflect updatedAt on the caller's object for in-memory continuity
  Object.assign(manifest, {
    updatedAt: updated.updatedAt,
    schemaVersion: SCHEMA_VERSION,
  });

  return { path: finalPath };
}

/**
 * Mutate a trial entry in-place on the manifest. Validates state transitions.
 *
 * @param {object} manifest
 * @param {string} trialId
 * @param {object} patch fields to merge (may include state)
 * @returns {object} updated trial entry
 */
export function updateTrial(manifest, trialId, patch) {
  if (!manifest || !Array.isArray(manifest.trials)) {
    throw new Error('updateTrial: manifest.trials required');
  }
  if (!trialId) {
    throw new Error('updateTrial: trialId is required');
  }
  assertSafeTrialId(trialId);
  if (!patch || typeof patch !== 'object') {
    throw new Error('updateTrial: patch is required');
  }

  const idx = manifest.trials.findIndex((t) => t.id === trialId);
  if (idx === -1) {
    throw new Error(`updateTrial: trial not found: ${trialId}`);
  }

  const current = manifest.trials[idx];
  const nextState = patch.state != null ? patch.state : current.state;

  if (patch.state != null) {
    assertTransition(current.state ?? 'pending', nextState);
  }

  const updated = {
    ...current,
    ...patch,
    id: current.id,
    state: nextState,
  };
  manifest.trials[idx] = updated;
  manifest.updatedAt = new Date().toISOString();
  return updated;
}

/**
 * Trials that can be resumed (pending or interrupted running).
 * @param {object} manifest
 * @returns {object[]}
 */
export function listResumableTrials(manifest) {
  if (!manifest || !Array.isArray(manifest.trials)) {
    return [];
  }
  return manifest.trials.filter(
    (t) => t && (t.state === 'pending' || t.state === 'running'),
  );
}
