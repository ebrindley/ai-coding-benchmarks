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
 * @property {string} invocationPath - 'build-adapter' | 'native-cli' | 'build-system'
 * @property {string[] | Record<string, string> | null | undefined} envAllowlist
 * @property {string | null | undefined} sandboxMode
 * @property {string} [provider]
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string} [promptTransport]
 * @property {number} [timeoutMs]
 * @property {string} [buildBin]
 * @property {unknown} [extra] - optional additional posture-affecting fields
 */

/**
 * Share the effective deadline between request, execution and posture.
 * The legacy arm fallback remains available to programmatic callers only.
 * @param {number} [timeoutMs]
 * @param {number} [legacyArmTimeoutMs]
 * @returns {number}
 */
export function resolveTrialTimeoutMs(timeoutMs, legacyArmTimeoutMs) {
  const supplied = timeoutMs ?? legacyArmTimeoutMs;
  const timeout = typeof supplied === 'number' ? supplied : Number(supplied);
  if (supplied == null || !Number.isFinite(timeout) || timeout <= 0) return 600_000;
  const whole = Math.floor(timeout);
  if (whole <= 0) throw new Error('timeoutMs must be a positive number');
  return whole;
}

/**
 * Arm overrides predate the experiment schema and remain programmatic-only.
 * @param {string} [legacyArmBin]
 * @param {string} [envBin]
 * @returns {string}
 */
export function resolveBuildBin(legacyArmBin, envBin = process.env.AICB_BUILD_BIN) {
  return legacyArmBin || envBin || 'build';
}

/**
 * @param {PostureInput} input
 * @returns {string} sha256 hex of canonical JSON
 */
export function computePostureFingerprint({
  invocationPath,
  provider,
  envAllowlist,
  sandboxMode,
  command,
  args,
  promptTransport,
  timeoutMs,
  buildBin,
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
    provider: provider ?? null,
    sandboxMode: sandboxMode == null ? null : String(sandboxMode),
    timeoutMs: resolveTrialTimeoutMs(timeoutMs),
    ...(invocationPath === 'native-cli'
      ? {
          command: command ?? null,
          args: args ?? [],
          promptTransport: promptTransport ?? 'stdin',
        }
      : { buildBin: resolveBuildBin(buildBin) }),
  };

  if (extra !== undefined) {
    payload.extra = extra;
  }

  return sha256Json(payload);
}
