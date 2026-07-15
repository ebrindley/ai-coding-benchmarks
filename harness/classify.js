/**
 * Trial classification for the external benchmark harness.
 *
 * Classifications: PASS, FAIL, NO_OP, INFRA_FAIL, TIMEOUT
 * Default precedence (highest wins): TIMEOUT > INFRA_FAIL > NO_OP > FAIL > PASS
 * Exception: rawEvidenceUnavailable true always stores INFRA_FAIL (including
 * when a TIMEOUT signal is also present).
 */

import {
  CLASSIFICATIONS,
  CLASSIFICATION_PRECEDENCE,
} from './contracts.js';

/**
 * @typedef {'PASS' | 'FAIL' | 'NO_OP' | 'INFRA_FAIL' | 'TIMEOUT'} Classification
 */

/**
 * @typedef {object} ClassificationResult
 * @property {Classification} classification
 * @property {string} reason
 * @property {Record<string, unknown>} evidence
 */

/**
 * Pick the highest-precedence classification from a set of signals.
 * @param {Iterable<Classification>} signals
 * @returns {Classification}
 */
export function pickHighestClassification(signals) {
  /** @type {Classification} */
  let best = 'PASS';
  let bestScore = CLASSIFICATION_PRECEDENCE.PASS;
  for (const signal of signals) {
    if (!CLASSIFICATIONS.includes(signal)) {
      continue;
    }
    const score = CLASSIFICATION_PRECEDENCE[signal] ?? 0;
    if (score > bestScore) {
      best = signal;
      bestScore = score;
    }
  }
  return best;
}

/**
 * @param {unknown} invokerResult
 * @returns {boolean}
 */
function invokerTimedOut(invokerResult) {
  if (!invokerResult || typeof invokerResult !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (invokerResult);
  if (r.timedOut === true) return true;
  // Adapter outcome.kind === 'timeout' even if timedOut flag was dropped
  if (r.outcomeKind === 'timeout') return true;
  return false;
}

/**
 * @param {unknown} invokerResult
 * @returns {string | null}
 */
function invokerInfraFailure(invokerResult) {
  if (!invokerResult || typeof invokerResult !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (invokerResult);
  if (typeof r.infraFailure === 'string' && r.infraFailure.trim() !== '') {
    return r.infraFailure;
  }
  if (typeof r.providerFailure === 'string' && r.providerFailure.trim() !== '') {
    return `provider failure: ${r.providerFailure}`;
  }
  if (r.status === 'execution_unavailable') {
    return 'invoker execution_unavailable';
  }
  // Adapter / invoker reported explicit non-success without infraFailure string
  if (r.success === false) {
    const kind =
      r.outcomeKind != null && String(r.outcomeKind).trim() !== ''
        ? String(r.outcomeKind)
        : 'non-success';
    // timeout is handled separately (TIMEOUT precedence)
    if (kind === 'timeout') return null;
    return `invoker non-success outcome: ${kind}`;
  }
  if (
    r.outcomeKind != null &&
    String(r.outcomeKind).trim() !== '' &&
    String(r.outcomeKind) !== 'success'
  ) {
    const kind = String(r.outcomeKind);
    if (kind === 'timeout') return null;
    return `invoker outcome.kind: ${kind}`;
  }
  return null;
}

/**
 * @param {unknown} invokerResult
 * @returns {boolean}
 */
function invokerNonZero(invokerResult) {
  if (!invokerResult || typeof invokerResult !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (invokerResult);
  if (r.exitCode == null) return false;
  return Number(r.exitCode) !== 0;
}

/**
 * Classify a single trial from invoker + gate outcomes.
 *
 * Rules:
 * - TIMEOUT if any timeout (trial flag, invoker, or gate)
 * - INFRA_FAIL if invoker/gate infraFailure, confinement unavailable, or
 *   rawEvidenceUnavailable (truncation / missing raw / spawn failure, etc.)
 * - NO_OP if completed with zero meaningful file changes (changedFileCount === 0)
 * - FAIL if any required gate non-zero / failed, or invoker non-zero without infra
 * - PASS otherwise
 *
 * Invariant: when rawEvidenceUnavailable is true, classification is always
 * INFRA_FAIL — never PASS, FAIL, NO_OP, or TIMEOUT. Timeout signals may still
 * be recorded in evidence.signals/reasons, but the stored classification is
 * INFRA_FAIL so write-path reportability stays stable.
 *
 * @param {object} input
 * @param {object | null | undefined} [input.invokerResult]
 * @param {Array<Record<string, unknown>> | null | undefined} [input.gateResults]
 * @param {number | null | undefined} [input.changedFileCount]
 * @param {boolean | null | undefined} [input.timedOut]
 * @param {boolean | null | undefined} [input.rawEvidenceUnavailable]
 *   When true, force INFRA_FAIL regardless of provider exit, gates, file
 *   changes, or timeout.
 * @returns {ClassificationResult}
 */
export function classifyTrial({
  invokerResult,
  gateResults,
  changedFileCount,
  timedOut,
  rawEvidenceUnavailable,
}) {
  /** @type {Classification[]} */
  const signals = [];
  /** @type {string[]} */
  const reasons = [];
  /** @type {Record<string, unknown>} */
  const evidence = {
    timedOut: Boolean(timedOut),
    changedFileCount:
      changedFileCount === undefined ? null : changedFileCount,
    invokerExitCode:
      invokerResult && typeof invokerResult === 'object'
        ? /** @type {Record<string, unknown>} */ (invokerResult).exitCode ?? null
        : null,
    rawEvidenceUnavailable: rawEvidenceUnavailable === true,
    gateStatuses: [],
  };

  const gates = Array.isArray(gateResults) ? gateResults : [];

  // --- TIMEOUT ---
  if (timedOut === true) {
    signals.push('TIMEOUT');
    reasons.push('trial timed out');
  }
  if (invokerTimedOut(invokerResult)) {
    signals.push('TIMEOUT');
    reasons.push('invoker timed out');
  }
  for (const g of gates) {
    if (g.timedOut === true || g.classificationSignal === 'TIMEOUT') {
      signals.push('TIMEOUT');
      reasons.push(`gate "${g.gate ?? '?'}" timed out`);
    }
  }

  // --- INFRA_FAIL ---
  // Raw unavailable (truncation, missing poetic raw, command-not-found, etc.)
  // forces INFRA_FAIL before write — including when timeout is also true.
  if (rawEvidenceUnavailable === true) {
    signals.push('INFRA_FAIL');
    reasons.push(
      'raw evidence unavailable (truncated capture, missing raw, or non-reportable invoker output)',
    );
  }
  const invInfra = invokerInfraFailure(invokerResult);
  if (invInfra) {
    signals.push('INFRA_FAIL');
    reasons.push(`invoker infra failure: ${invInfra}`);
  }
  for (const g of gates) {
    const status = g.status;
    const signal = g.classificationSignal;
    const infra =
      typeof g.infraFailure === 'string' && g.infraFailure.trim() !== ''
        ? g.infraFailure
        : null;
    if (
      status === 'execution_unavailable' ||
      signal === 'INFRA_FAIL' ||
      infra
    ) {
      signals.push('INFRA_FAIL');
      reasons.push(
        `gate "${g.gate ?? '?'}" infrastructure failure` +
          (infra ? `: ${infra}` : status === 'execution_unavailable' ? ': execution_unavailable' : ''),
      );
    }
    /** @type {unknown[]} */ (evidence.gateStatuses).push({
      gate: g.gate,
      status: g.status,
      exitCode: g.exitCode ?? null,
      classificationSignal: g.classificationSignal ?? null,
      required: g.required !== false,
    });
  }

  // --- NO_OP (only when count is known and zero) ---
  if (changedFileCount === 0) {
    signals.push('NO_OP');
    reasons.push('no meaningful file changes (changedFileCount === 0)');
  }

  // --- FAIL ---
  if (invokerNonZero(invokerResult) && !invInfra && !invokerTimedOut(invokerResult)) {
    signals.push('FAIL');
    const code =
      invokerResult && typeof invokerResult === 'object'
        ? /** @type {Record<string, unknown>} */ (invokerResult).exitCode
        : null;
    reasons.push(`invoker exited non-zero (${code})`);
  }
  for (const g of gates) {
    const required = g.required !== false;
    if (!required) continue;
    // Structural gates are non-executable: never silent PASS, never FAIL from runner alone.
    if (g.status === 'structural') {
      continue;
    }
    // Timeouts / infra already recorded above with higher precedence.
    if (g.timedOut === true || g.status === 'execution_unavailable') {
      continue;
    }
    if (g.status === 'failed' || g.classificationSignal === 'FAIL') {
      signals.push('FAIL');
      reasons.push(
        `required gate "${g.gate ?? '?'}" failed (exit ${g.exitCode ?? 'null'}, expected ${g.expectedExitCode ?? 0})`,
      );
    }
  }

  // Default PASS when no adverse signals.
  if (signals.length === 0) {
    signals.push('PASS');
    reasons.push('invoker and required executable gates succeeded');
  }

  // rawEvidenceUnavailable outranks default precedence (including TIMEOUT):
  // always store INFRA_FAIL so the write path never claims TIMEOUT/PASS/FAIL/NO_OP.
  const classification =
    rawEvidenceUnavailable === true
      ? 'INFRA_FAIL'
      : pickHighestClassification(signals);
  const reason =
    reasons.length > 0
      ? reasons.filter((r, i, arr) => arr.indexOf(r) === i).join('; ')
      : classification;

  return {
    classification,
    reason,
    evidence: {
      ...evidence,
      signals: [...new Set(signals)],
      precedence: CLASSIFICATION_PRECEDENCE[classification],
      ...(rawEvidenceUnavailable === true
        ? { forcedInfraFailForRawUnavailable: true }
        : {}),
    },
  };
}

export { CLASSIFICATIONS, CLASSIFICATION_PRECEDENCE };
