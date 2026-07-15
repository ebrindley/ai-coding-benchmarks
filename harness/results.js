/**
 * Trial result storage and raw-provider-output quarantine.
 *
 * Results live under campaign/results/<trialId>/result.json.
 * Raw provider stdout/stderr (secret-bearing) live under campaign/raw/<trialId>/
 * with directory mode 0700 and file mode 0600.
 */

import {
  mkdir,
  readFile,
  rename,
  writeFile,
  copyFile,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from './contracts.js';

/**
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {string}
 */
export function trialResultDir(campaignDir, trialId) {
  return path.join(campaignDir, 'results', trialId);
}

/**
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {string}
 */
export function trialRawDir(campaignDir, trialId) {
  return path.join(campaignDir, 'raw', trialId);
}

/**
 * Best-effort chmod; ignore failures on platforms that lack mode bits.
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
 * Ensure a private directory (0700).
 * @param {string} dir
 */
export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tryChmod(dir, 0o700);
}

/**
 * Write a private file (0600).
 * @param {string} filePath
 * @param {string | Buffer} data
 */
export async function writePrivateFile(filePath, data) {
  await writeFile(filePath, data, { mode: 0o600 });
  await tryChmod(filePath, 0o600);
}

/**
 * Write (or overwrite) a trial result.json atomically.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} result trial-shaped result payload
 * @returns {Promise<{ path: string, result: object }>}
 */
export async function writeTrialResult(campaignDir, trialId, result) {
  if (!campaignDir) throw new Error('writeTrialResult: campaignDir is required');
  if (!trialId) throw new Error('writeTrialResult: trialId is required');
  if (!result || typeof result !== 'object') {
    throw new Error('writeTrialResult: result is required');
  }

  const dir = trialResultDir(campaignDir, trialId);
  await mkdir(dir, { recursive: true });

  const payload = {
    ...result,
    id: result.id ?? trialId,
    classification: result.classification ?? null,
    digests: result.digests ?? {},
    gateResults: result.gateResults ?? undefined,
    requestedModel: result.requestedModel ?? null,
    // Preserve null — never invent resolved from requested
    resolvedModel:
      result.resolvedModel === undefined ? null : result.resolvedModel,
    postureFingerprint: result.postureFingerprint ?? null,
    invocationPath: result.invocationPath ?? null,
    schemaVersion: SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
  };

  const finalPath = path.join(dir, 'result.json');
  const tmpPath = path.join(dir, 'result.json.tmp');
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmpPath, finalPath);

  return { path: finalPath, result: payload };
}

/**
 * Read a previously written trial result.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<object>}
 */
export async function readTrialResult(campaignDir, trialId) {
  if (!campaignDir) throw new Error('readTrialResult: campaignDir is required');
  if (!trialId) throw new Error('readTrialResult: trialId is required');

  const p = path.join(trialResultDir(campaignDir, trialId), 'result.json');
  const text = await readFile(p, 'utf8');
  return JSON.parse(text);
}

/**
 * Quarantine raw provider output under campaign/raw/<trialId>/ (0700 / 0600).
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} raw
 * @param {string} [raw.stdout]
 * @param {string} [raw.stderr]
 * @param {string} [raw.outputPath]
 * @param {unknown} [raw.meta]
 * @returns {Promise<{ path: string }>}
 */
export async function quarantineRawOutput(campaignDir, trialId, raw = {}) {
  if (!campaignDir) throw new Error('quarantineRawOutput: campaignDir is required');
  if (!trialId) throw new Error('quarantineRawOutput: trialId is required');

  // Ensure raw root is private
  const rawRoot = path.join(campaignDir, 'raw');
  await ensurePrivateDir(rawRoot);

  const dir = trialRawDir(campaignDir, trialId);
  await ensurePrivateDir(dir);

  if (raw.stdout != null) {
    await writePrivateFile(path.join(dir, 'stdout.txt'), String(raw.stdout));
  }
  if (raw.stderr != null) {
    await writePrivateFile(path.join(dir, 'stderr.txt'), String(raw.stderr));
  }

  if (raw.outputPath) {
    try {
      const dest = path.join(dir, 'output.json');
      await copyFile(raw.outputPath, dest);
      await tryChmod(dest, 0o600);
    } catch {
      await writePrivateFile(
        path.join(dir, 'output-missing.txt'),
        'source not copied (path omitted from quarantine metadata)\n',
      );
    }
  }

  const meta = {
    trialId: String(trialId),
    quarantinedAt: new Date().toISOString(),
    warning:
      'SECRET-BEARING: raw provider output. Do not commit or include in sanitized export by default.',
    hasStdout: raw.stdout != null,
    hasStderr: raw.stderr != null,
    hasOutputPath: Boolean(raw.outputPath),
    // Do not embed absolute source paths
    ...(raw.meta && typeof raw.meta === 'object' && !('path' in /** @type {object} */ (raw.meta))
      ? { extra: raw.meta }
      : {}),
  };
  await writePrivateFile(
    path.join(dir, 'meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  return { path: dir };
}
