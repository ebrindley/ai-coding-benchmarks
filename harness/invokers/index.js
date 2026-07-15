/**
 * Invoker registry and request-payload helpers.
 */

import path from 'node:path';
import { invokePoeticAdapter } from './poetic-adapter.js';
import { invokeNativeCli } from './native-cli.js';
import { invokePoeticSystem } from './poetic-system.js';

export const POETIC_INVOKE_REQUEST_SCHEMA = 'poetic.provider.invoke.request.v1';

const INVOKERS = Object.freeze({
  'poetic-adapter': invokePoeticAdapter,
  'native-cli': invokeNativeCli,
  'poetic-system': invokePoeticSystem,
});

/**
 * @param {string} invocationPath
 * @returns {typeof invokePoeticAdapter | typeof invokeNativeCli | typeof invokePoeticSystem}
 */
export function getInvoker(invocationPath) {
  const fn = INVOKERS[invocationPath];
  if (!fn) {
    const known = Object.keys(INVOKERS).join(', ');
    throw new Error(
      `Unknown invocationPath "${invocationPath}". Expected one of: ${known}`,
    );
  }
  return fn;
}

/**
 * Build a poetic-adapter request matching bridge contract:
 * schema poetic.provider.invoke.request.v1, requestId, provider, optional non-null model,
 * prompt, absolute workingDirectory, positive timeoutMs.
 * No trialId/workspace aliases.
 *
 * @param {object} opts
 * @param {object} opts.arm
 * @param {object} opts.task
 * @param {string} opts.workspaceDir - absolute working directory
 * @param {string} opts.requestId - unique request id (typically trial id)
 * @param {number} [opts.timeoutMs]
 * @returns {Record<string, unknown>}
 */
export function buildInvocationRequest({
  arm,
  task,
  workspaceDir,
  requestId,
  timeoutMs,
}) {
  if (!arm || typeof arm !== 'object') {
    throw new Error('buildInvocationRequest: arm is required');
  }
  if (!task || typeof task !== 'object') {
    throw new Error('buildInvocationRequest: task is required');
  }
  if (workspaceDir == null || workspaceDir === '') {
    throw new Error('buildInvocationRequest: workspaceDir is required');
  }
  if (requestId == null || requestId === '') {
    throw new Error('buildInvocationRequest: requestId is required');
  }
  if (arm.provider == null || String(arm.provider).trim() === '') {
    throw new Error('buildInvocationRequest: arm.provider is required');
  }

  const absWork = path.resolve(String(workspaceDir));
  const prompt =
    task.prompt ??
    task.description ??
    task.instruction ??
    task.goal ??
    '';

  let resolvedTimeout = timeoutMs;
  if (resolvedTimeout == null && arm.timeoutMs != null) {
    resolvedTimeout = Number(arm.timeoutMs);
  }
  if (resolvedTimeout == null || !Number.isFinite(resolvedTimeout) || resolvedTimeout <= 0) {
    resolvedTimeout = 600_000;
  }
  resolvedTimeout = Math.floor(Number(resolvedTimeout));
  if (resolvedTimeout <= 0) {
    throw new Error('buildInvocationRequest: timeoutMs must be a positive number');
  }

  /** @type {Record<string, unknown>} */
  const request = {
    schema: POETIC_INVOKE_REQUEST_SCHEMA,
    requestId: String(requestId),
    provider: String(arm.provider),
    prompt: String(prompt),
    workingDirectory: absWork,
    timeoutMs: resolvedTimeout,
  };

  // Optional non-null model only
  if (arm.model != null && String(arm.model).trim() !== '') {
    request.model = String(arm.model);
  }

  return request;
}

/**
 * Parse resolved model evidence from an adapter output artifact.
 *
 * Bridge shape only:
 *   model.resolved = { availability: "available", value: "..." }
 *   model.resolved = { availability: "unavailable", reason: "..." }
 *
 * Never stringifies the resolved object. Never falls back to a requested model.
 *
 * @param {unknown} artifact - parsed JSON from poetic --output
 * @returns {{ resolvedModel: string | null, available: boolean, source: string, reason?: string }}
 */
export function parseResolvedModelEvidence(artifact) {
  if (artifact == null) {
    return { resolvedModel: null, available: false, source: 'absent' };
  }
  let obj = artifact;
  if (typeof artifact === 'string') {
    try {
      obj = JSON.parse(artifact);
    } catch {
      return { resolvedModel: null, available: false, source: 'unparseable' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { resolvedModel: null, available: false, source: 'invalid' };
  }
  const rec = /** @type {Record<string, unknown>} */ (obj);
  if (!rec.model || typeof rec.model !== 'object' || Array.isArray(rec.model)) {
    return { resolvedModel: null, available: false, source: 'no-model' };
  }
  const m = /** @type {Record<string, unknown>} */ (rec.model);
  const resolved = m.resolved;
  // Must be the bridge object form — never treat a bare string/object dump as the model id
  if (resolved == null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    return { resolvedModel: null, available: false, source: 'no-resolved' };
  }
  const r = /** @type {Record<string, unknown>} */ (resolved);
  const availability =
    r.availability != null ? String(r.availability).toLowerCase() : '';
  if (availability === 'available') {
    if (typeof r.value === 'string' && r.value.trim() !== '') {
      return {
        resolvedModel: r.value.trim(),
        available: true,
        source: 'model.resolved.value',
      };
    }
    return {
      resolvedModel: null,
      available: false,
      source: 'available-missing-value',
      reason: 'model.resolved.availability is available but value is missing',
    };
  }
  if (availability === 'unavailable') {
    return {
      resolvedModel: null,
      available: false,
      source: 'model.resolved.unavailable',
      reason: r.reason != null ? String(r.reason) : 'unavailable',
    };
  }
  return {
    resolvedModel: null,
    available: false,
    source: 'unknown-availability',
    reason: availability || 'missing availability',
  };
}

export {
  invokePoeticAdapter,
  parseInvokeResult,
  mapOutcomeKind,
  prepareFreshOutputPath,
  bindInvokeResultToRequest,
  bindInvokeResultToRequestId,
  normalizeRequestedModelIdentity,
  sanitizeAdapterReasonCode,
  expectedProviderRawPaths,
  ingestProviderRawEvidence,
  resolveProviderRawArtifactsDirName,
  POETIC_INVOKE_RESULT_SCHEMA,
  POETIC_OUTCOME_KINDS,
  REASON_CODE_RE,
  PROVIDER_RAW_ARTIFACTS_SUFFIX,
  PROVIDER_RAW_ARTIFACTS_DIR,
  PROVIDER_RAW_STDOUT_NAME,
  PROVIDER_RAW_STDERR_NAME,
} from './poetic-adapter.js';
export { invokeNativeCli, PROMPT_TRANSPORTS } from './native-cli.js';
export { invokePoeticSystem } from './poetic-system.js';
export {
  detectProviderConfinement,
  buildProviderSeatbeltProfile,
  buildProviderConfinedArgv,
  wrapProviderCommand,
  campaignDenyPaths,
  escapeSeatbeltPath,
  assertPathOutsideCampaign,
} from './provider-confine.js';
