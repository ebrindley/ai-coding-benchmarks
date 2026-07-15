/**
 * Campaign directory lock via exclusive file create (`wx`).
 * No shell. Lock file: campaign.lock under the campaign directory.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LOCK_FILENAME = 'campaign.lock';

/**
 * @param {string} campaignDir
 * @returns {string}
 */
export function lockPath(campaignDir) {
  return path.join(campaignDir, LOCK_FILENAME);
}

/**
 * Read lock metadata if present.
 * @param {string} campaignDir
 * @returns {Promise<object | null>}
 */
export async function readLock(campaignDir) {
  const p = lockPath(campaignDir);
  try {
    const text = await readFile(p, 'utf8');
    const data = JSON.parse(text);
    return {
      owner: data.owner ?? null,
      acquiredAt: data.acquiredAt ?? null,
      pid: data.pid ?? null,
      path: p,
      ...data,
    };
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Acquire an exclusive campaign lock.
 * Succeeds if the lock file can be created, or if already held by the same owner.
 *
 * @param {string} campaignDir
 * @param {string} ownerId
 * @returns {Promise<{ ok: boolean, acquired: boolean, path?: string, owner?: string, acquiredAt?: string, pid?: number, reentrant?: boolean, error?: string, lock?: object|null }>}
 */
export async function acquireLock(campaignDir, ownerId) {
  if (!campaignDir) {
    return { ok: false, acquired: false, error: 'campaignDir is required' };
  }
  if (ownerId == null || ownerId === '') {
    return { ok: false, acquired: false, error: 'ownerId is required' };
  }

  const p = lockPath(campaignDir);
  const acquiredAt = new Date().toISOString();
  const payload = {
    owner: String(ownerId),
    acquiredAt,
    pid: process.pid,
  };

  try {
    await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    return {
      ok: true,
      acquired: true,
      path: p,
      owner: payload.owner,
      acquiredAt: payload.acquiredAt,
      pid: payload.pid,
    };
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'EEXIST') {
      return {
        ok: false,
        acquired: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let existing = null;
    try {
      existing = await readLock(campaignDir);
    } catch (readErr) {
      return {
        ok: false,
        acquired: false,
        error: `lock exists but unreadable: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      };
    }

    if (existing && existing.owner === String(ownerId)) {
      return {
        ok: true,
        acquired: true,
        reentrant: true,
        path: p,
        owner: existing.owner,
        acquiredAt: existing.acquiredAt ?? null,
        pid: existing.pid ?? undefined,
        lock: existing,
      };
    }

    return {
      ok: false,
      acquired: false,
      error: `campaign lock held by ${existing?.owner ?? 'unknown'}`,
      lock: existing,
      path: p,
    };
  }
}

/**
 * Release a campaign lock. Fails if held by a different owner.
 *
 * @param {string} campaignDir
 * @param {string} ownerId
 * @returns {Promise<{ ok: boolean, released: boolean, reason?: string }>}
 */
export async function releaseLock(campaignDir, ownerId) {
  if (!campaignDir) {
    throw new Error('releaseLock: campaignDir is required');
  }
  if (ownerId == null || ownerId === '') {
    throw new Error('releaseLock: ownerId is required');
  }

  const existing = await readLock(campaignDir);
  if (!existing) {
    return { ok: true, released: false, reason: 'no lock' };
  }
  if (existing.owner != null && existing.owner !== String(ownerId)) {
    throw new Error(
      `releaseLock: lock owned by ${existing.owner}, not ${ownerId}`,
    );
  }

  try {
    await unlink(lockPath(campaignDir));
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return { ok: true, released: false, reason: 'no lock' };
    }
    throw err;
  }

  return { ok: true, released: true };
}
