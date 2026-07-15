/**
 * Run-configuration posture fingerprints.
 *
 * Posture distinguishes configuration that can affect trial outcomes:
 * invocation path, environment allowlist, sandbox mode, and optional extras
 * (e.g. confinement flags, tool policy). Trials with different posture
 * fingerprints must never be silently aggregated in summaries or exports.
 */

import { sha256Json } from './digest.js';

/**
 * @typedef {object} PostureInput
 * @property {string} invocationPath - 'poetic-adapter' | 'native-cli' | 'poetic-system'
 * @property {string[] | Record<string, string> | null | undefined} envAllowlist
 * @property {string | null | undefined} sandboxMode
 * @property {unknown} [extra] - optional additional posture-affecting fields
 */

/**
 * Compute a stable sha256 hex fingerprint of run posture.
 *
 * @param {PostureInput} input
 * @returns {string} sha256 hex of canonical JSON
 */
export function computePostureFingerprint({
  invocationPath,
  envAllowlist,
  sandboxMode,
  extra,
}) {
  if (invocationPath == null || invocationPath === '') {
    throw new Error('computePostureFingerprint: invocationPath is required');
  }

  let normalizedAllowlist;
  if (envAllowlist == null) {
    normalizedAllowlist = [];
  } else if (Array.isArray(envAllowlist)) {
    normalizedAllowlist = [...envAllowlist].map(String).sort();
  } else if (typeof envAllowlist === 'object') {
    normalizedAllowlist = Object.keys(envAllowlist).map(String).sort();
  } else {
    throw new Error('computePostureFingerprint: envAllowlist must be an array, object, null, or undefined');
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    envAllowlist: normalizedAllowlist,
    invocationPath: String(invocationPath),
    sandboxMode: sandboxMode == null ? null : String(sandboxMode),
  };

  if (extra !== undefined) {
    payload.extra = extra;
  }

  return sha256Json(payload);
}
