/**
 * Resumable atomic campaign manifest under the campaign directory.
 * Writes via manifest.json.tmp then rename (atomic on the same filesystem).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, TRIAL_STATUSES } from './contracts.js';

export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_TMP_FILENAME = 'manifest.json.tmp';

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
 * @returns {object}
 */
export function createManifest(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('createManifest: options object required');
  }
  if (!opts.campaignId) {
    throw new Error('createManifest: campaignId is required');
  }
  if (!Array.isArray(opts.trials)) {
    throw new Error('createManifest: trials must be an array');
  }

  const now = new Date().toISOString();
  const trials = opts.trials.map((t) => ({
    ...t,
    id: t.id,
    state: t.state ?? 'pending',
  }));

  return {
    campaignId: String(opts.campaignId),
    schemaVersion: SCHEMA_VERSION,
    status: opts.status ?? 'pending',
    experimentId: opts.experimentId ?? opts.campaignId ?? null,
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
  };
}

/**
 * Load manifest.json from a campaign directory.
 * @param {string} campaignDir
 * @returns {Promise<object>}
 */
export async function loadManifest(campaignDir) {
  if (!campaignDir) {
    throw new Error('loadManifest: campaignDir is required');
  }
  const p = path.join(campaignDir, MANIFEST_FILENAME);
  const text = await readFile(p, 'utf8');
  const data = JSON.parse(text);
  if (data.schemaVersion !== 1 && data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `loadManifest: unsupported schemaVersion ${data.schemaVersion}`,
    );
  }
  return data;
}

/**
 * Atomically persist a campaign manifest (tmp + rename).
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

  await mkdir(campaignDir, { recursive: true });

  const updated = {
    ...manifest,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  const finalPath = path.join(campaignDir, MANIFEST_FILENAME);
  const tmpPath = path.join(campaignDir, MANIFEST_TMP_FILENAME);
  const body = `${JSON.stringify(updated, null, 2)}\n`;

  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, finalPath);

  // Reflect updatedAt on the caller's object for in-memory continuity
  Object.assign(manifest, { updatedAt: updated.updatedAt, schemaVersion: SCHEMA_VERSION });

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
