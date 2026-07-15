/**
 * Campaign directory lock via exclusive no-follow file create
 * (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600 — no rename/replace).
 * No shell. Lock file: campaign.lock under the campaign directory.
 *
 * Dead-owner recovery is conservative: same-host PID liveness plus age or
 * owner-metadata evidence. Never steals a live or ambiguous lock.
 *
 * Stale-lock recovery is serialized by a separate exclusive recovery guard
 * (`campaign.lock.recover`) so two reclaimers cannot delete a newly acquired
 * live lock (compare-then-unlink race).
 *
 * Recovery guards themselves carry PID/host/time identity. A dead same-host
 * guard holder (crashed reclaimer) can be reclaimed safely after age so a
 * reclaimer crash does not wedge resume forever. Live/ambiguous guards are
 * never stolen.
 *
 * Reads use bounded readTextNoFollow so pre-planted lock/guard leaf symlinks
 * cannot inject host content into reclaim decisions.
 */

import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFileExclusiveNoFollow,
  readTextNoFollow,
  UnsafePathError,
  DEFAULT_SAFE_READ_MAX_BYTES,
} from './safe-fs.js';

/** Bound for lock / recovery-guard JSON (small; keep well under default). */
const LOCK_READ_MAX_BYTES = Math.min(DEFAULT_SAFE_READ_MAX_BYTES, 1024 * 1024);

export const LOCK_FILENAME = 'campaign.lock';
export const LOCK_RECOVER_FILENAME = 'campaign.lock.recover';

/**
 * Minimum age before a dead-pid lock may be recovered without matching owner
 * metadata. Conservative default: 30 seconds.
 */
export const DEAD_LOCK_MIN_AGE_MS = 30_000;

/**
 * Minimum age before a dead-pid recovery guard may be reclaimed.
 * Same conservative default as dead locks.
 */
export const DEAD_GUARD_MIN_AGE_MS = DEAD_LOCK_MIN_AGE_MS;

/**
 * @param {string} campaignDir
 * @returns {string}
 */
export function lockPath(campaignDir) {
  return path.join(campaignDir, LOCK_FILENAME);
}

/**
 * Path to the exclusive recovery guard for dead-owner reclaim.
 * @param {string} campaignDir
 * @returns {string}
 */
export function lockRecoverPath(campaignDir) {
  return path.join(campaignDir, LOCK_RECOVER_FILENAME);
}

/**
 * Same-host PID liveness probe via process.kill(pid, 0).
 * - true: process is alive (or exists but EPERM — treat as alive)
 * - false: process is not alive (ESRCH)
 * - null: pid missing/invalid or probe ambiguous
 *
 * @param {unknown} pid
 * @returns {boolean | null}
 */
export function isPidAlive(pid) {
  if (pid == null) return null;
  const n = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ESRCH') return false;
    // EPERM: process exists but we cannot signal it — treat as alive.
    if (code === 'EPERM') return true;
    return null;
  }
}

/**
 * True when owner metadata encodes the given pid (aicb-<pid>-<ts> convention).
 * @param {unknown} owner
 * @param {unknown} pid
 * @returns {boolean}
 */
export function ownerMatchesPid(owner, pid) {
  if (owner == null || pid == null) return false;
  const o = String(owner);
  const p = String(pid);
  if (o === p) return true;
  // run.js ownerId format: aicb-${process.pid}-${Date.now()}
  if (o.startsWith(`aicb-${p}-`)) return true;
  if (o.includes(`pid:${p}`)) return true;
  return false;
}

/**
 * Parse age from an ISO timestamp field.
 * @param {unknown} iso
 * @param {number} [nowMs]
 * @returns {number | null} age in ms, or null if unparseable
 */
export function lockAgeMs(iso, nowMs = Date.now()) {
  if (iso == null || iso === '') return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/**
 * Decide whether a held lock is safely recoverable as a dead owner.
 * Never recovers live or ambiguous locks.
 *
 * @param {object | null | undefined} lock
 * @param {{ nowMs?: number, minAgeMs?: number, hostname?: string }} [opts]
 * @returns {{ recoverable: boolean, reason: string }}
 */
export function canRecoverDeadLock(lock, opts = {}) {
  if (!lock || typeof lock !== 'object') {
    return { recoverable: false, reason: 'no lock metadata' };
  }

  const pid = lock.pid;
  if (pid == null) {
    return { recoverable: false, reason: 'lock pid missing (ambiguous)' };
  }

  const expectedHost = opts.hostname ?? os.hostname();
  const lockHost = lock.hostname ?? lock.host ?? null;
  if (lockHost != null && String(lockHost) !== String(expectedHost)) {
    return {
      recoverable: false,
      reason: `lock host "${lockHost}" != current host "${expectedHost}" (ambiguous)`,
    };
  }

  const alive = isPidAlive(pid);
  if (alive === true) {
    return { recoverable: false, reason: `owner pid ${pid} is alive` };
  }
  if (alive === null) {
    return {
      recoverable: false,
      reason: `owner pid ${pid} liveness ambiguous`,
    };
  }
  // alive === false

  const minAgeMs = opts.minAgeMs ?? DEAD_LOCK_MIN_AGE_MS;
  const age = lockAgeMs(lock.acquiredAt, opts.nowMs);
  const ageOk = age != null && age >= minAgeMs;
  const ownerEvidence = ownerMatchesPid(lock.owner, pid);

  // When hostname is absent (legacy lock), require age — never recover on
  // owner evidence alone without same-host confirmation.
  if (lockHost == null && !ageOk) {
    return {
      recoverable: false,
      reason:
        'legacy lock without hostname: age threshold not met (conservative)',
    };
  }

  if (!ageOk && !ownerEvidence) {
    return {
      recoverable: false,
      reason:
        'dead pid but age below threshold and owner metadata does not match pid',
    };
  }

  return {
    recoverable: true,
    reason: ageOk
      ? `dead pid ${pid}, age ${age}ms >= ${minAgeMs}ms`
      : `dead pid ${pid} with matching owner metadata`,
  };
}

/**
 * Decide whether a recovery guard is safely reclaimable (dead holder).
 * Requires validated PID + host + time identity. Never steals live/ambiguous.
 *
 * @param {object | null | undefined} guard
 * @param {{ nowMs?: number, minAgeMs?: number, hostname?: string }} [opts]
 * @returns {{ recoverable: boolean, reason: string }}
 */
export function canRecoverDeadGuard(guard, opts = {}) {
  if (!guard || typeof guard !== 'object') {
    return { recoverable: false, reason: 'no guard metadata' };
  }

  const pid = guard.pid;
  if (pid == null) {
    return { recoverable: false, reason: 'guard pid missing (ambiguous)' };
  }

  const expectedHost = opts.hostname ?? os.hostname();
  const guardHost = guard.hostname ?? guard.host ?? null;
  if (guardHost == null) {
    return {
      recoverable: false,
      reason: 'guard hostname missing (ambiguous)',
    };
  }
  if (String(guardHost) !== String(expectedHost)) {
    return {
      recoverable: false,
      reason: `guard host "${guardHost}" != current host "${expectedHost}" (ambiguous)`,
    };
  }

  const alive = isPidAlive(pid);
  if (alive === true) {
    return { recoverable: false, reason: `guard pid ${pid} is alive` };
  }
  if (alive === null) {
    return {
      recoverable: false,
      reason: `guard pid ${pid} liveness ambiguous`,
    };
  }

  const minAgeMs = opts.minAgeMs ?? DEAD_GUARD_MIN_AGE_MS;
  // Prefer startedAt; accept acquiredAt for symmetry with lock payloads.
  const age = lockAgeMs(guard.startedAt ?? guard.acquiredAt, opts.nowMs);
  if (age == null) {
    return {
      recoverable: false,
      reason: 'guard startedAt/acquiredAt missing or unparseable (ambiguous)',
    };
  }
  if (age < minAgeMs) {
    return {
      recoverable: false,
      reason: `guard age ${age}ms < ${minAgeMs}ms (refuse early reclaim)`,
    };
  }

  return {
    recoverable: true,
    reason: `dead guard pid ${pid}, age ${age}ms >= ${minAgeMs}ms`,
  };
}

/**
 * Read lock metadata if present (nofollow; never follows a planted leaf symlink).
 * @param {string} campaignDir
 * @returns {Promise<object | null>}
 */
export async function readLock(campaignDir) {
  const p = lockPath(campaignDir);
  try {
    const text = await readTextNoFollow(p, { maxBytes: LOCK_READ_MAX_BYTES });
    const data = JSON.parse(text);
    return {
      owner: data.owner ?? null,
      acquiredAt: data.acquiredAt ?? null,
      pid: data.pid ?? null,
      hostname: data.hostname ?? data.host ?? null,
      path: p,
      ...data,
    };
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Read recovery guard metadata if present (nofollow).
 * @param {string} campaignDir
 * @returns {Promise<object | null>}
 */
export async function readRecoveryGuard(campaignDir) {
  const p = lockRecoverPath(campaignDir);
  try {
    const text = await readTextNoFollow(p, { maxBytes: LOCK_READ_MAX_BYTES });
    const data = JSON.parse(text);
    return {
      owner: data.owner ?? null,
      pid: data.pid ?? null,
      hostname: data.hostname ?? data.host ?? null,
      startedAt: data.startedAt ?? data.acquiredAt ?? null,
      path: p,
      ...data,
    };
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return null;
    }
    // Corrupt guard: treat as unreadable/ambiguous for reclaim decisions.
    throw err;
  }
}

/**
 * Build lock file payload for the current process.
 * @param {string} ownerId
 * @returns {{ owner: string, acquiredAt: string, pid: number, hostname: string }}
 */
function buildLockPayload(ownerId) {
  return {
    owner: String(ownerId),
    acquiredAt: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
  };
}

/**
 * Build recovery guard payload with PID/host/time identity.
 * @param {object} lockPayload - new owner payload
 * @param {object | null} existing - lock snapshot being recovered
 * @returns {object}
 */
function buildGuardPayload(lockPayload, existing) {
  return {
    owner: lockPayload.owner,
    pid: lockPayload.pid,
    hostname: lockPayload.hostname,
    startedAt: new Date().toISOString(),
    target: lockIdentity(existing),
  };
}

/**
 * Attempt exclusive create of a file with O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600.
 * Does not replace an existing file (no rename). Leaf symlinks fail closed.
 *
 * @param {string} p
 * @param {string} body
 * @returns {Promise<{ ok: true } | { ok: false, code?: string, error: string }>}
 */
async function tryCreateExclusive(p, body) {
  try {
    await createFileExclusiveNoFollow(p, body, { mode: 0o600, fsync: true });
    return { ok: true };
  } catch (err) {
    if (err instanceof UnsafePathError) {
      // Pre-planted LEAF symlink at the lock path: surface as EEXIST so callers
      // re-read via nofollow and fail closed without reclaiming from external
      // content. Intermediate/parent symlink failures keep their own codes so
      // acquisition fails immediately (must not enter reclaim).
      const leafSymlink =
        err.code === 'SYMLINK' &&
        /path is a symlink \(fail closed\)/i.test(err.message);
      return {
        ok: false,
        code: leafSymlink ? 'EEXIST' : err.code,
        error: err.message,
      };
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return {
      ok: false,
      code,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Attempt exclusive create of the lock file.
 * @param {string} p
 * @param {object} payload
 * @returns {Promise<{ ok: true, acquired: true, path: string, owner: string, acquiredAt: string, pid: number, hostname: string } | { ok: false, code?: string, error: string }>}
 */
async function tryCreateLock(p, payload) {
  const created = await tryCreateExclusive(
    p,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  if (created.ok) {
    return {
      ok: true,
      acquired: true,
      path: p,
      owner: payload.owner,
      acquiredAt: payload.acquiredAt,
      pid: payload.pid,
      hostname: payload.hostname,
    };
  }
  return {
    ok: false,
    code: created.code,
    error: created.error,
  };
}

/**
 * Stable identity fingerprint of a lock for re-check after acquiring the recovery guard.
 * @param {object | null} lock
 * @returns {string}
 */
function lockIdentity(lock) {
  if (!lock || typeof lock !== 'object') return '';
  return JSON.stringify({
    owner: lock.owner ?? null,
    pid: lock.pid ?? null,
    acquiredAt: lock.acquiredAt ?? null,
    hostname: lock.hostname ?? lock.host ?? null,
  });
}

/**
 * Stable identity fingerprint of a recovery guard.
 * @param {object | null} guard
 * @returns {string}
 */
function guardIdentity(guard) {
  if (!guard || typeof guard !== 'object') return '';
  return JSON.stringify({
    owner: guard.owner ?? null,
    pid: guard.pid ?? null,
    startedAt: guard.startedAt ?? guard.acquiredAt ?? null,
    hostname: guard.hostname ?? guard.host ?? null,
  });
}

/**
 * Best-effort unlink; ignore ENOENT.
 * @param {string} p
 */
async function unlinkIfExists(p) {
  try {
    await unlink(p);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') throw err;
  }
}

/**
 * Acquire the recovery guard, reclaiming a dead/stale guard when safe.
 * Never steals a live or ambiguous guard. Two concurrent reclaimers of a
 * dead guard: only one wins the post-unlink `wx`; the other fails closed.
 *
 * @param {string} campaignDir
 * @param {object} guardPayload
 * @param {{ minAgeMs?: number, nowMs?: number }} opts
 * @returns {Promise<{ ok: true, recovered?: boolean } | { ok: false, error: string, guard?: object|null }>}
 */
async function acquireRecoveryGuard(campaignDir, guardPayload, opts) {
  const recoverPath = lockRecoverPath(campaignDir);
  const body = `${JSON.stringify(guardPayload, null, 2)}\n`;

  const first = await tryCreateExclusive(recoverPath, body);
  if (first.ok) {
    return { ok: true, recovered: false };
  }
  if (first.code !== 'EEXIST') {
    return {
      ok: false,
      error: `failed to acquire lock recovery guard: ${first.error}`,
    };
  }

  // Guard held — try stale reclaim only when holder is proven dead.
  let existing;
  try {
    existing = await readRecoveryGuard(campaignDir);
  } catch (readErr) {
    return {
      ok: false,
      error: `recovery guard unreadable (fail closed): ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      guard: null,
    };
  }

  const decision = canRecoverDeadGuard(existing, {
    minAgeMs: opts.minAgeMs ?? DEAD_GUARD_MIN_AGE_MS,
    nowMs: opts.nowMs,
  });
  if (!decision.recoverable) {
    return {
      ok: false,
      error: `campaign lock recovery already in progress (fail closed; ${decision.reason})`,
      guard: existing,
    };
  }

  // Serialized stale-guard reclamation: re-check identity, unlink, re-create wx.
  // Two reclaimers both seeing a dead guard: only one wins wx after unlink.
  const snapshotId = guardIdentity(existing);
  let current;
  try {
    current = await readRecoveryGuard(campaignDir);
  } catch (readErr) {
    return {
      ok: false,
      error: `recovery guard unreadable during reclaim (fail closed): ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      guard: existing,
    };
  }

  if (current == null) {
    // Vanished between checks — try clean create.
    const again = await tryCreateExclusive(recoverPath, body);
    if (again.ok) return { ok: true, recovered: true };
    return {
      ok: false,
      error: 'campaign lock recovery already in progress (fail closed; guard claimed after vanish)',
      guard: null,
    };
  }

  if (guardIdentity(current) !== snapshotId) {
    return {
      ok: false,
      error:
        'campaign lock recovery already in progress (fail closed; guard identity changed)',
      guard: current,
    };
  }

  const recheck = canRecoverDeadGuard(current, {
    minAgeMs: opts.minAgeMs ?? DEAD_GUARD_MIN_AGE_MS,
    nowMs: opts.nowMs,
  });
  if (!recheck.recoverable) {
    return {
      ok: false,
      error: `campaign lock recovery already in progress (fail closed; ${recheck.reason})`,
      guard: current,
    };
  }

  try {
    await unlink(recoverPath);
  } catch (unlinkErr) {
    const code = /** @type {NodeJS.ErrnoException} */ (unlinkErr).code;
    if (code !== 'ENOENT') {
      return {
        ok: false,
        error: `failed to reclaim stale recovery guard: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
        guard: current,
      };
    }
  }

  const second = await tryCreateExclusive(recoverPath, body);
  if (second.ok) {
    return { ok: true, recovered: true };
  }
  // Another reclaimer won the race — fail closed (never double-own the guard).
  return {
    ok: false,
    error:
      'campaign lock recovery already in progress (fail closed; concurrent guard reclaim)',
    guard: current,
  };
}

/**
 * Recover a dead-owner lock under an exclusive recovery guard.
 * Serializes reclaimers so two processes cannot both unlink and one cannot
 * delete a lock the other just acquired.
 *
 * @param {string} campaignDir
 * @param {string} p - lock path
 * @param {object} payload - new owner payload
 * @param {object | null} existing - lock snapshot that was judged recoverable
 * @param {{ minAgeMs?: number, nowMs?: number }} opts
 * @returns {Promise<{ ok: boolean, acquired: boolean, path?: string, owner?: string, acquiredAt?: string, pid?: number, hostname?: string, recovered?: boolean, error?: string, lock?: object|null }>}
 */
async function recoverDeadLock(campaignDir, p, payload, existing, opts) {
  const guardPayload = buildGuardPayload(payload, existing);
  const guard = await acquireRecoveryGuard(campaignDir, guardPayload, opts);
  if (!guard.ok) {
    return {
      ok: false,
      acquired: false,
      error: guard.error,
      lock: existing,
      path: p,
    };
  }

  const recoverPath = lockRecoverPath(campaignDir);
  try {
    // Re-read under the guard and re-validate identity + recoverability.
    let current = null;
    try {
      current = await readLock(campaignDir);
    } catch (readErr) {
      return {
        ok: false,
        acquired: false,
        error: `lock unreadable during recovery (fail closed): ${readErr instanceof Error ? readErr.message : String(readErr)}`,
        lock: existing,
        path: p,
      };
    }

    if (current == null) {
      // Lock vanished (another reclaimer finished) — try clean acquire without unlink.
      const second = await tryCreateLock(p, payload);
      if (second.ok) {
        return { ...second, recovered: true };
      }
      return {
        ok: false,
        acquired: false,
        error: `campaign lock claimed after dead-owner recovery (no lock to reclaim)`,
        lock: null,
        path: p,
      };
    }

    // If the lock identity changed, another process may have claimed it — never unlink.
    if (lockIdentity(current) !== lockIdentity(existing)) {
      return {
        ok: false,
        acquired: false,
        error:
          'campaign lock changed during recovery (fail closed; refuse to unlink)',
        lock: current,
        path: p,
      };
    }

    const recheck = canRecoverDeadLock(current, {
      minAgeMs: opts.minAgeMs,
      nowMs: opts.nowMs,
    });
    if (!recheck.recoverable) {
      return {
        ok: false,
        acquired: false,
        error: `campaign lock no longer recoverable (${recheck.reason})`,
        lock: current,
        path: p,
      };
    }

    try {
      await unlink(p);
    } catch (unlinkErr) {
      const code = /** @type {NodeJS.ErrnoException} */ (unlinkErr).code;
      if (code !== 'ENOENT') {
        return {
          ok: false,
          acquired: false,
          error: `failed to recover dead lock: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
          lock: current,
          path: p,
        };
      }
    }

    const second = await tryCreateLock(p, payload);
    if (second.ok) {
      return {
        ...second,
        recovered: true,
      };
    }
    // Race: another process claimed the lock after recovery unlink (should be rare
    // under the guard; still fail closed rather than looping).
    return {
      ok: false,
      acquired: false,
      error: `campaign lock held after dead-owner recovery attempt (${second.error})`,
      lock: current,
      path: p,
    };
  } finally {
    // Always release the recovery guard so a subsequent reclaim can proceed.
    await unlinkIfExists(recoverPath);
  }
}

/**
 * Acquire an exclusive campaign lock.
 * Succeeds if the lock file can be created, or if already held by the same owner.
 * May recover a dead same-host owner when age/owner evidence is conservative.
 *
 * @param {string} campaignDir
 * @param {string} ownerId
 * @param {{ minAgeMs?: number, nowMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, acquired: boolean, path?: string, owner?: string, acquiredAt?: string, pid?: number, hostname?: string, reentrant?: boolean, recovered?: boolean, error?: string, lock?: object|null }>}
 */
export async function acquireLock(campaignDir, ownerId, opts = {}) {
  if (!campaignDir) {
    return { ok: false, acquired: false, error: 'campaignDir is required' };
  }
  if (ownerId == null || ownerId === '') {
    return { ok: false, acquired: false, error: 'ownerId is required' };
  }

  const p = lockPath(campaignDir);
  const payload = buildLockPayload(ownerId);

  const first = await tryCreateLock(p, payload);
  if (first.ok) {
    return first;
  }
  if (first.code !== 'EEXIST') {
    return {
      ok: false,
      acquired: false,
      error: first.error,
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
      hostname: existing.hostname ?? undefined,
      lock: existing,
    };
  }

  // Dead-owner recovery: only when pid present, not alive on same host, and
  // age exceeds threshold OR owner metadata matches dead pid evidence.
  // Serialized via campaign.lock.recover (wx) so two reclaimers cannot both
  // unlink and accidentally delete a newly acquired live lock.
  const recovery = canRecoverDeadLock(existing, {
    minAgeMs: opts.minAgeMs,
    nowMs: opts.nowMs,
  });
  if (recovery.recoverable) {
    return recoverDeadLock(campaignDir, p, payload, existing, opts);
  }

  return {
    ok: false,
    acquired: false,
    error: `campaign lock held by ${existing?.owner ?? 'unknown'}${recovery.reason ? ` (${recovery.reason})` : ''}`,
    lock: existing,
    path: p,
  };
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

  // Best-effort: clear a stale recovery guard left by a crashed reclaimer.
  await unlinkIfExists(lockRecoverPath(campaignDir));

  return { ok: true, released: true };
}
