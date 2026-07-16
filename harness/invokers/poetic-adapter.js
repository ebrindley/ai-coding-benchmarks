/**
 * Poetic adapter invoker: argv-safe `poetic provider invoke --request … --output …`.
 *
 * Does not pass arbitrary env from corpus task YAML. Only harness-controlled
 * env (explicit `env` or filtered process.env) is used. Tests inject `poeticBin`.
 *
 * Bridge contract: CLI may exit 0 after writing an artifact. The harness MUST
 * parse `poetic.provider.invoke.result.v1` and map `outcome.kind` / `reasonCode`
 * into the invoker result. Non-success outcomes are never treated as success.
 *
 * Fresh result binding: before each invoke the harness securely clears
 * `outputPath` (never following a symlink), then after spawn accepts the
 * result only when the artifact is fully schema-valid and identity-bound to
 * the frozen request (requestId + provider + requested model). Stale or
 * mismatched provider/model evidence is never treated as fullyBound.
 */

import { readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnControlled } from './spawn-controlled.js';
import {
  ensurePrivateDirNoFollow,
  writeFileAtomicNoFollow,
  readTextNoFollow,
  readContainedRegularFileNoFollow,
  UnsafePathError,
} from '../safe-fs.js';
import { assertSafeIdSegment, PathEscapeError } from '../paths.js';

/** Bridge result schema id. */
export const POETIC_INVOKE_RESULT_SCHEMA = 'poetic.provider.invoke.result.v1';

/**
 * Deterministic provider raw quarantine — mirrors Poetic's public
 * `resolveArtifactQuarantineDir(outputPath, requestId)` EXACTLY:
 *
 *   const base = path.basename(path.resolve(outputPath));
 *   const stem = base.toLowerCase().endsWith('.json')
 *     ? base.slice(0, -5)
 *     : base;
 *   // dir = dirname(resolved) / (stem + ".invoke-artifacts") / requestId
 *
 * Example: /scratch/output.json
 *   → /scratch/output.invoke-artifacts/<requestId>/{stdout,stderr}.txt
 *
 * Only a trailing `.json` (case-insensitive) is stripped — not path.extname.
 * Multi-dot: foo.bar.json → foo.bar.invoke-artifacts
 * Non-json:  foo.txt → foo.txt.invoke-artifacts
 *
 * Wrapper CLI stdout/stderr are intentionally quiet; actual provider streams
 * live only in these private files. Never trust free-form paths from the
 * result artifact — only these exact locations.
 */
export const PROVIDER_RAW_ARTIFACTS_SUFFIX = '.invoke-artifacts';
/** @deprecated Use PROVIDER_RAW_ARTIFACTS_SUFFIX; was the wrong standalone dirname. */
export const PROVIDER_RAW_ARTIFACTS_DIR = PROVIDER_RAW_ARTIFACTS_SUFFIX;
export const PROVIDER_RAW_STDOUT_NAME = 'stdout.txt';
export const PROVIDER_RAW_STDERR_NAME = 'stderr.txt';

/**
 * Resolve Poetic's deterministic quarantine directory name for an output path.
 * Exact mirror of Poetic: strip only trailing `.json` (case-insensitive).
 *
 * @param {string} outputPath
 * @returns {string} e.g. "output.invoke-artifacts"
 */
export function resolveProviderRawArtifactsDirName(outputPath) {
  const base = path.basename(path.resolve(String(outputPath)));
  const stem = base.toLowerCase().endsWith('.json')
    ? base.slice(0, -5)
    : base;
  return `${stem}${PROVIDER_RAW_ARTIFACTS_SUFFIX}`;
}

/**
 * Documented outcome kinds for poetic.provider.invoke.result.v1.
 * - success: provider completed without harness-level failure
 * - timeout: wall-clock / provider timeout
 * - provider_error: provider transport/API/runtime error
 * - refusal: provider refused the request
 * - aborted: invocation aborted (signal, cancel, user abort)
 * - internal_error: bridge/internal failure while producing a result artifact
 */
export const POETIC_OUTCOME_KINDS = Object.freeze([
  'success',
  'timeout',
  'provider_error',
  'refusal',
  'aborted',
  'internal_error',
]);

/** @type {ReadonlySet<string>} */
const OUTCOME_KIND_SET = new Set(POETIC_OUTCOME_KINDS);

/**
 * Stable reason codes from poetic ProviderInvokeReasonCode.
 * Free-form text is never accepted on the parse boundary.
 */
export const POETIC_REASON_CODES = Object.freeze([
  'SUCCESS',
  'MODEL_UNRESOLVED',
  'PROVIDER_ERROR',
  'PROVIDER_EXECUTION_ERROR',
  'PROVIDER_AUTH_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ABORTED',
  'PROVIDER_NOT_FOUND',
  'INTERNAL_ERROR',
  'NOT_READY',
]);

/** @type {ReadonlySet<string>} */
const REASON_CODE_SET = new Set(POETIC_REASON_CODES);

/** Model resolutionSource enum from Poetic types.ts */
export const MODEL_RESOLUTION_SOURCES = Object.freeze([
  'request',
  'provider-result',
  'config-default',
  'unavailable',
]);

/** @type {ReadonlySet<string>} */
const RESOLUTION_SOURCE_SET = new Set(MODEL_RESOLUTION_SOURCES);

/** stateIsolation enum */
export const STATE_ISOLATION_LEVELS = Object.freeze([
  'enforced',
  'partial',
  'unsupported',
]);

/** cleanup.status enum */
export const CLEANUP_STATUSES = Object.freeze([
  'complete',
  'partial',
  'unsupported',
  'not-needed',
]);

/**
 * Bounded adapter reasonCode syntax for ordinary/exported records.
 * Accepts Poetic ProviderInvokeReasonCode values and other bounded ids.
 * Free-form text is rejected at the parse boundary (never flows into results).
 */
export const REASON_CODE_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validate outcome.reasonCode at the parsing boundary.
 * Invalid/free-form codes become null (never pass through arbitrary text).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeAdapterReasonCode(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  return REASON_CODE_RE.test(s) ? s : null;
}

/**
 * @typedef {object} ParsedInvokeResult
 * @property {boolean} valid
 * @property {boolean} success
 * @property {string | null} outcomeKind
 * @property {string | null} reasonCode
 * @property {boolean} timedOut
 * @property {string} [infraFailure]
 * @property {string} [providerFailure]
 * @property {Record<string, unknown> | null} [artifact]
 * @property {string} [parseError]
 * @property {boolean} [reasonCodeRejected]
 */

/**
 * @typedef {object} ExpectedInvokeIdentity
 * @property {string} requestId
 * @property {string} provider
 * @property {string | null | undefined} [requestedModel]
 */

/**
 * Normalize requested-model identity from a request.model string (request side).
 * Absent / null / empty (trim-only emptiness check) → null.
 * Non-empty → original string (not trimmed) so full binding does not mask
 * leading/trailing differences.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeRequestedModelIdentity(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  return value;
}

/**
 * Extract string value from AvailabilityCoded / AvailableValue for bind compare.
 * available + non-empty (trim check only) value → original string (not trimmed);
 * unavailable or missing → null. Exact identity must preserve leading/trailing spaces.
 *
 * @param {unknown} coded
 * @returns {string | null}
 */
export function valueFromAvailabilityCoded(coded) {
  if (coded == null || typeof coded !== 'object' || Array.isArray(coded)) {
    return null;
  }
  const c = /** @type {Record<string, unknown>} */ (coded);
  if (c.availability !== 'available') return null;
  if (typeof c.value !== 'string' || c.value.trim() === '') return null;
  // Return original value — do not mask leading/trailing differences.
  return c.value;
}

/**
 * Fail-closed invalid ParsedInvokeResult helper.
 * @param {string} infraFailure
 * @param {string} parseError
 * @param {Partial<ParsedInvokeResult>} [extra]
 * @returns {ParsedInvokeResult}
 */
function invalidParse(infraFailure, parseError, extra = {}) {
  return {
    valid: false,
    success: false,
    outcomeKind: null,
    reasonCode: null,
    timedOut: false,
    infraFailure,
    parseError,
    artifact: null,
    ...extra,
  };
}

/**
 * Validate AvailabilityCoded<T> / AvailableValue shape.
 * @param {unknown} coded
 * @param {string} path
 * @param {{ requireAvailable?: boolean, valueType?: 'string' | 'string[]' | 'object' | 'number' }} [opts]
 * @returns {string | null} error message or null if ok
 */
function validateAvailabilityCoded(coded, path, opts = {}) {
  if (coded == null || typeof coded !== 'object' || Array.isArray(coded)) {
    return `${path} must be an AvailabilityCoded object`;
  }
  const c = /** @type {Record<string, unknown>} */ (coded);
  const availability =
    c.availability != null ? String(c.availability).trim() : '';
  if (availability === 'available') {
    if (!('value' in c)) {
      return `${path}.value is required when availability is available`;
    }
    // Available must not carry reason (incompatible partial).
    if ('reason' in c && c.reason !== undefined) {
      return `${path} must not carry reason when availability is available`;
    }
    const vt = opts.valueType ?? 'string';
    if (vt === 'string') {
      if (typeof c.value !== 'string' || c.value.trim() === '') {
        return `${path}.value must be a non-empty string when available`;
      }
    } else if (vt === 'string[]') {
      if (!Array.isArray(c.value) || !c.value.every((x) => typeof x === 'string')) {
        return `${path}.value must be a string[] when available`;
      }
    } else if (vt === 'object') {
      if (
        c.value == null ||
        typeof c.value !== 'object' ||
        Array.isArray(c.value)
      ) {
        return `${path}.value must be a plain object when available`;
      }
    } else if (vt === 'number') {
      if (typeof c.value !== 'number' || !Number.isFinite(c.value)) {
        return `${path}.value must be a finite number when available`;
      }
    }
    return null;
  }
  if (availability === 'unavailable') {
    if (opts.requireAvailable) {
      return `${path} must be available`;
    }
    // Unavailable must not carry value.
    if ('value' in c && c.value !== undefined) {
      return `${path} must not carry value when availability is unavailable`;
    }
    if (c.reason != null && typeof c.reason !== 'string') {
      return `${path}.reason must be a string when present`;
    }
    return null;
  }
  return `${path}.availability must be "available" or "unavailable"`;
}

/**
 * True when path is a non-empty absolute filesystem path string.
 * @param {unknown} p
 * @returns {boolean}
 */
function isAbsolutePathString(p) {
  return typeof p === 'string' && p.trim() !== '' && path.isAbsolute(p);
}

/**
 * Validate usage.value token fields when usage is available.
 * @param {unknown} value
 * @returns {string | null}
 */
function validateUsageValue(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return 'usage.value must be an object when available';
  }
  const v = /** @type {Record<string, unknown>} */ (value);
  const allowed = new Set([
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
  ]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) {
      return `usage.value has unsupported field "${key}"`;
    }
    const n = v[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return `usage.value.${key} must be a finite non-negative number`;
    }
  }
  return null;
}

/**
 * @param {unknown} attempt
 * @param {string} path
 * @returns {string | null}
 */
function validateAttempt(attempt, path) {
  if (attempt == null || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return `${path} must be an object`;
  }
  const a = /** @type {Record<string, unknown>} */ (attempt);
  if (typeof a.attempt !== 'number' || !Number.isInteger(a.attempt) || a.attempt < 1) {
    return `${path}.attempt must be an integer >= 1`;
  }
  if (typeof a.startedAt !== 'string' || a.startedAt.trim() === '') {
    return `${path}.startedAt must be a non-empty string`;
  }
  if (typeof a.endedAt !== 'string' || a.endedAt.trim() === '') {
    return `${path}.endedAt must be a non-empty string`;
  }
  if (typeof a.durationMs !== 'number' || !Number.isFinite(a.durationMs)) {
    return `${path}.durationMs must be a finite number`;
  }
  if (
    'exitCode' in a &&
    a.exitCode != null &&
    (typeof a.exitCode !== 'number' || !Number.isInteger(a.exitCode))
  ) {
    return `${path}.exitCode must be an integer or null when present`;
  }
  if ('error' in a && a.error != null) {
    if (typeof a.error !== 'object' || Array.isArray(a.error)) {
      return `${path}.error must be an object when present`;
    }
    const e = /** @type {Record<string, unknown>} */ (a.error);
    if (typeof e.code !== 'string' || e.code.trim() === '') {
      return `${path}.error.code must be a non-empty string`;
    }
    if (typeof e.message !== 'string') {
      return `${path}.error.message must be a string`;
    }
  }
  return null;
}

/**
 * @typedef {object} InvokerResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} outputPath
 * @property {string | null} [outcomeKind]
 * @property {string | null} [reasonCode]
 * @property {boolean} [success]
 * @property {string} [infraFailure]
 * @property {string} [providerFailure]
 * @property {string} [signal]
 * @property {Record<string, unknown> | null} [parsedOutput]
 */

/**
 * Map a validated outcome.kind (+ optional reasonCode) to invoker fields.
 * Non-success kinds never set success=true.
 *
 * @param {string} kind
 * @param {string | null} reasonCode
 * @returns {Omit<ParsedInvokeResult, 'valid' | 'artifact' | 'parseError'>}
 */
export function mapOutcomeKind(kind, reasonCode = null) {
  // Only bounded identifiers may appear as reasonCode on ordinary records.
  const code = sanitizeAdapterReasonCode(reasonCode);
  const detail = code ? `${kind}: ${code}` : kind;

  switch (kind) {
    case 'success':
      return {
        success: true,
        outcomeKind: 'success',
        reasonCode: code,
        timedOut: false,
      };
    case 'timeout':
      return {
        success: false,
        outcomeKind: 'timeout',
        reasonCode: code,
        timedOut: true,
        infraFailure: `adapter outcome timeout (${detail})`,
      };
    case 'provider_error':
      return {
        success: false,
        outcomeKind: 'provider_error',
        reasonCode: code,
        timedOut: false,
        providerFailure: detail,
        infraFailure: `adapter provider_error (${detail})`,
      };
    case 'refusal':
      return {
        success: false,
        outcomeKind: 'refusal',
        reasonCode: code,
        timedOut: false,
        providerFailure: detail,
        infraFailure: `adapter refusal (${detail})`,
      };
    case 'aborted':
      return {
        success: false,
        outcomeKind: 'aborted',
        reasonCode: code,
        timedOut: false,
        infraFailure: `adapter aborted (${detail})`,
      };
    case 'internal_error':
      return {
        success: false,
        outcomeKind: 'internal_error',
        reasonCode: code,
        timedOut: false,
        infraFailure: `adapter internal_error (${detail})`,
      };
    default:
      return {
        success: false,
        outcomeKind: kind,
        reasonCode: code,
        timedOut: false,
        infraFailure: `unknown adapter outcome kind (${detail})`,
      };
  }
}

/**
 * Parse and validate a poetic.provider.invoke.result.v1 artifact against the
 * real ProviderInvokeResultV1 contract (poetic types.ts). Fail closed: invalid
 * never retains model/artifact evidence.
 *
 * Required top-level: schema, requestId, outcome, provider, model, versions,
 * posture, stateIsolation, attempts, timing, process, cleanup, diagnostics,
 * usage, cost, artifacts.
 *
 * Non-success outcome kinds remain valid when the rest of the schema is sound;
 * identity binding is separate ({@link bindInvokeResultToRequest}).
 *
 * @param {unknown} artifact - parsed JSON or JSON string from poetic --output
 * @returns {ParsedInvokeResult}
 */
export function parseInvokeResult(artifact) {
  let obj = artifact;
  if (typeof artifact === 'string') {
    try {
      obj = JSON.parse(artifact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return invalidParse(`unparseable invoke result: ${message}`, message);
    }
  }

  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return invalidParse('invoke result is not a JSON object', 'not-object');
  }

  const rec = /** @type {Record<string, unknown>} */ (obj);
  const schema = rec.schema != null ? String(rec.schema) : '';
  if (schema !== POETIC_INVOKE_RESULT_SCHEMA) {
    return invalidParse(
      `invoke result schema mismatch: expected ${POETIC_INVOKE_RESULT_SCHEMA}, got ${schema || '(missing)'}`,
      'schema-mismatch',
    );
  }

  if (typeof rec.requestId !== 'string' || rec.requestId.trim() === '') {
    return invalidParse(
      'invoke result requestId must be a non-empty string',
      'missing-requestId',
    );
  }

  // --- outcome ---
  const outcome = rec.outcome;
  if (outcome == null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return invalidParse('invoke result missing outcome object', 'missing-outcome');
  }
  const o = /** @type {Record<string, unknown>} */ (outcome);
  if (o.kind == null || String(o.kind).trim() === '') {
    return invalidParse('invoke result outcome.kind is missing', 'missing-kind');
  }
  const kind = String(o.kind).trim();
  if (!OUTCOME_KIND_SET.has(kind)) {
    return invalidParse(
      `unknown adapter outcome kind (${kind})`,
      'unknown-kind',
    );
  }
  if (
    !('exitCode' in o) ||
    (o.exitCode != null &&
      (typeof o.exitCode !== 'number' || !Number.isInteger(o.exitCode)))
  ) {
    return invalidParse(
      'invoke result outcome.exitCode must be an integer or null',
      'invalid-outcome-exitCode',
    );
  }
  if (typeof o.reasonCode !== 'string' || !REASON_CODE_SET.has(o.reasonCode)) {
    return invalidParse(
      `invoke result outcome.reasonCode must be a ProviderInvokeReasonCode, got ${
        o.reasonCode != null ? JSON.stringify(o.reasonCode) : '(missing)'
      }`,
      'invalid-reasonCode',
    );
  }
  if (o.message != null && typeof o.message !== 'string') {
    return invalidParse(
      'invoke result outcome.message must be a string when present',
      'invalid-outcome-message',
    );
  }
  const reasonCode = o.reasonCode;
  const reasonCodeRejected = false;

  // --- provider: { requested: AvailableValue<string>, resolved: AvailabilityCoded<string> } ---
  const provider = rec.provider;
  if (provider == null || typeof provider !== 'object' || Array.isArray(provider)) {
    return invalidParse(
      'invoke result provider must be an object',
      'missing-provider',
    );
  }
  const p = /** @type {Record<string, unknown>} */ (provider);
  const provReqErr = validateAvailabilityCoded(p.requested, 'provider.requested', {
    requireAvailable: true,
    valueType: 'string',
  });
  if (provReqErr) {
    return invalidParse(provReqErr, 'invalid-provider-requested');
  }
  const provResErr = validateAvailabilityCoded(p.resolved, 'provider.resolved', {
    valueType: 'string',
  });
  if (provResErr) {
    return invalidParse(provResErr, 'invalid-provider-resolved');
  }

  // --- model: { requested, resolved: AvailabilityCoded, resolutionSource } ---
  const model = rec.model;
  if (model == null || typeof model !== 'object' || Array.isArray(model)) {
    return invalidParse('invoke result missing model object', 'missing-model');
  }
  const m = /** @type {Record<string, unknown>} */ (model);
  const modelReqErr = validateAvailabilityCoded(m.requested, 'model.requested', {
    valueType: 'string',
  });
  if (modelReqErr) {
    return invalidParse(modelReqErr, 'invalid-model-requested');
  }
  const modelResErr = validateAvailabilityCoded(m.resolved, 'model.resolved', {
    valueType: 'string',
  });
  if (modelResErr) {
    return invalidParse(modelResErr, 'invalid-model-resolved');
  }
  if (
    typeof m.resolutionSource !== 'string' ||
    !RESOLUTION_SOURCE_SET.has(m.resolutionSource)
  ) {
    return invalidParse(
      `invoke result model.resolutionSource must be a ModelResolutionSource, got ${
        m.resolutionSource != null ? JSON.stringify(m.resolutionSource) : '(missing)'
      }`,
      'invalid-resolutionSource',
    );
  }
  // model.resolved / resolutionSource consistency
  const modelResolvedAvail =
    m.resolved != null &&
    typeof m.resolved === 'object' &&
    !Array.isArray(m.resolved)
      ? String(
          /** @type {Record<string, unknown>} */ (m.resolved).availability,
        ).trim()
      : '';
  if (modelResolvedAvail === 'unavailable' && m.resolutionSource !== 'unavailable') {
    return invalidParse(
      'model.resolutionSource must be "unavailable" when model.resolved is unavailable',
      'invalid-resolutionSource-consistency',
    );
  }
  if (modelResolvedAvail === 'available' && m.resolutionSource === 'unavailable') {
    return invalidParse(
      'model.resolutionSource must not be "unavailable" when model.resolved is available',
      'invalid-resolutionSource-consistency',
    );
  }

  // --- versions ---
  const versions = rec.versions;
  if (versions == null || typeof versions !== 'object' || Array.isArray(versions)) {
    return invalidParse('invoke result missing versions object', 'missing-versions');
  }
  const v = /** @type {Record<string, unknown>} */ (versions);
  for (const key of /** @type {const} */ (['poetic', 'providerCli'])) {
    const err = validateAvailabilityCoded(v[key], `versions.${key}`, {
      valueType: 'string',
    });
    if (err) return invalidParse(err, `invalid-versions-${key}`);
  }

  // --- posture ---
  const posture = rec.posture;
  if (posture == null || typeof posture !== 'object' || Array.isArray(posture)) {
    return invalidParse('invoke result missing posture object', 'missing-posture');
  }
  const pos = /** @type {Record<string, unknown>} */ (posture);
  for (const [key, vt] of /** @type {const} */ ([
    ['fingerprint', 'string'],
    ['argvRedacted', 'string[]'],
    ['commandPath', 'string'],
    ['workspaceMode', 'string'],
  ])) {
    const err = validateAvailabilityCoded(pos[key], `posture.${key}`, {
      valueType: /** @type {'string' | 'string[]'} */ (vt),
    });
    if (err) return invalidParse(err, `invalid-posture-${key}`);
  }
  if (
    !Array.isArray(pos.sourceClasses) ||
    !pos.sourceClasses.every((x) => typeof x === 'string')
  ) {
    return invalidParse(
      'posture.sourceClasses must be a string array',
      'invalid-posture-sourceClasses',
    );
  }

  // --- stateIsolation ---
  if (
    typeof rec.stateIsolation !== 'string' ||
    !STATE_ISOLATION_LEVELS.includes(
      /** @type {typeof STATE_ISOLATION_LEVELS[number]} */ (rec.stateIsolation),
    )
  ) {
    return invalidParse(
      `invoke result stateIsolation invalid: ${JSON.stringify(rec.stateIsolation)}`,
      'invalid-stateIsolation',
    );
  }

  // --- attempts ---
  if (!Array.isArray(rec.attempts) || rec.attempts.length < 1) {
    return invalidParse(
      'invoke result attempts must be a non-empty array',
      'invalid-attempts',
    );
  }
  for (let i = 0; i < rec.attempts.length; i += 1) {
    const err = validateAttempt(rec.attempts[i], `attempts[${i}]`);
    if (err) return invalidParse(err, 'invalid-attempt');
  }

  // --- timing ---
  const timing = rec.timing;
  if (timing == null || typeof timing !== 'object' || Array.isArray(timing)) {
    return invalidParse('invoke result missing timing object', 'missing-timing');
  }
  const t = /** @type {Record<string, unknown>} */ (timing);
  if (typeof t.startedAt !== 'string' || t.startedAt.trim() === '') {
    return invalidParse('timing.startedAt must be a non-empty string', 'invalid-timing');
  }
  if (typeof t.endedAt !== 'string' || t.endedAt.trim() === '') {
    return invalidParse('timing.endedAt must be a non-empty string', 'invalid-timing');
  }
  if (typeof t.durationMs !== 'number' || !Number.isFinite(t.durationMs)) {
    return invalidParse('timing.durationMs must be a finite number', 'invalid-timing');
  }

  // --- process ---
  const processObj = rec.process;
  if (
    processObj == null ||
    typeof processObj !== 'object' ||
    Array.isArray(processObj)
  ) {
    return invalidParse('invoke result missing process object', 'missing-process');
  }
  const proc = /** @type {Record<string, unknown>} */ (processObj);
  if (
    !('exitCode' in proc) ||
    (proc.exitCode != null &&
      (typeof proc.exitCode !== 'number' || !Number.isInteger(proc.exitCode)))
  ) {
    return invalidParse(
      'process.exitCode must be an integer or null',
      'invalid-process-exitCode',
    );
  }
  const tsErr = validateAvailabilityCoded(
    proc.transportStatus,
    'process.transportStatus',
    { valueType: 'string' },
  );
  if (tsErr) return invalidParse(tsErr, 'invalid-process-transportStatus');

  // --- cleanup ---
  const cleanup = rec.cleanup;
  if (cleanup == null || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
    return invalidParse('invoke result missing cleanup object', 'missing-cleanup');
  }
  const cl = /** @type {Record<string, unknown>} */ (cleanup);
  if (
    typeof cl.status !== 'string' ||
    !CLEANUP_STATUSES.includes(
      /** @type {typeof CLEANUP_STATUSES[number]} */ (cl.status),
    )
  ) {
    return invalidParse(
      `cleanup.status invalid: ${JSON.stringify(cl.status)}`,
      'invalid-cleanup-status',
    );
  }
  if (
    cl.notes != null &&
    (!Array.isArray(cl.notes) || !cl.notes.every((x) => typeof x === 'string'))
  ) {
    return invalidParse(
      'cleanup.notes must be a string array when present',
      'invalid-cleanup-notes',
    );
  }

  // --- diagnostics / usage / cost ---
  const diagErr = validateAvailabilityCoded(rec.diagnostics, 'diagnostics', {
    valueType: 'object',
  });
  if (diagErr) return invalidParse(diagErr, 'invalid-diagnostics');

  const usage = rec.usage;
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
    return invalidParse('invoke result missing usage object', 'missing-usage');
  }
  const uErr = validateAvailabilityCoded(usage, 'usage', { valueType: 'object' });
  if (uErr) return invalidParse(uErr, 'invalid-usage');
  const u = /** @type {Record<string, unknown>} */ (usage);
  if (u.availability === 'available') {
    const usageValErr = validateUsageValue(u.value);
    if (usageValErr) return invalidParse(usageValErr, 'invalid-usage');
  }

  const cost = rec.cost;
  if (cost == null || typeof cost !== 'object' || Array.isArray(cost)) {
    return invalidParse('invoke result missing cost object', 'missing-cost');
  }
  const cErr = validateAvailabilityCoded(cost, 'cost', { valueType: 'object' });
  if (cErr) return invalidParse(cErr, 'invalid-cost');
  const co = /** @type {Record<string, unknown>} */ (cost);
  if (co.availability === 'available') {
    const cv = /** @type {Record<string, unknown>} */ (co.value);
    if (
      typeof cv.totalCostUsd !== 'number' ||
      !Number.isFinite(cv.totalCostUsd) ||
      cv.totalCostUsd < 0
    ) {
      return invalidParse(
        'cost.value.totalCostUsd must be a finite non-negative number when available',
        'invalid-cost',
      );
    }
  }

  // --- artifacts (required object with absolute path strings) ---
  const artifacts = rec.artifacts;
  if (
    artifacts == null ||
    typeof artifacts !== 'object' ||
    Array.isArray(artifacts)
  ) {
    return invalidParse(
      'invoke result missing artifacts object',
      'missing-artifacts',
    );
  }
  const art = /** @type {Record<string, unknown>} */ (artifacts);
  if (!isAbsolutePathString(art.result)) {
    return invalidParse(
      'artifacts.result must be a non-empty absolute path string',
      'invalid-artifacts-result',
    );
  }
  if (!isAbsolutePathString(art.quarantineDir)) {
    return invalidParse(
      'artifacts.quarantineDir must be a non-empty absolute path string',
      'invalid-artifacts-quarantineDir',
    );
  }
  if (art.stdout != null && !isAbsolutePathString(art.stdout)) {
    return invalidParse(
      'artifacts.stdout must be a non-empty absolute path string when present',
      'invalid-artifacts-stdout',
    );
  }
  if (art.stderr != null && !isAbsolutePathString(art.stderr)) {
    return invalidParse(
      'artifacts.stderr must be a non-empty absolute path string when present',
      'invalid-artifacts-stderr',
    );
  }

  const mapped = mapOutcomeKind(kind, reasonCode);
  return {
    valid: true,
    ...mapped,
    reasonCode,
    reasonCodeRejected,
    // Keep the fully validated object (reasonCode already enum-bound)
    artifact: { ...rec },
  };
}

/**
 * Read and parse the adapter output artifact at outputPath.
 * Fail closed on symlink: never follow a symlink to read planted target content
 * as if it were this run's output.
 *
 * @param {string} outputPath
 * @returns {Promise<ParsedInvokeResult>}
 */
async function readAndParseOutput(outputPath) {
  try {
    const st = await lstat(outputPath);
    if (st.isSymbolicLink()) {
      return {
        valid: false,
        success: false,
        outcomeKind: null,
        reasonCode: null,
        timedOut: false,
        infraFailure: `outputPath is a symlink after invoke (fail closed): ${outputPath}`,
        parseError: 'output-symlink',
        artifact: null,
      };
    }
    if (st.isDirectory()) {
      return {
        valid: false,
        success: false,
        outcomeKind: null,
        reasonCode: null,
        timedOut: false,
        infraFailure: `outputPath is a directory after invoke (fail closed): ${outputPath}`,
        parseError: 'output-directory',
        artifact: null,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: `failed to lstat invoke result at ${outputPath}: ${message}`,
      parseError: 'lstat-failed',
      artifact: null,
    };
  }

  let text;
  try {
    // No-follow read: refuse symlink-swapped output after provider exit.
    text = await readTextNoFollow(outputPath);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return {
        valid: false,
        success: false,
        outcomeKind: null,
        reasonCode: null,
        timedOut: false,
        infraFailure: err.message,
        parseError: err.code || 'unsafe-path',
        artifact: null,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: `failed to read invoke result at ${outputPath}: ${message}`,
      parseError: 'read-failed',
      artifact: null,
    };
  }
  return parseInvokeResult(text);
}

/**
 * Securely prepare outputPath for a fresh adapter write.
 *
 * - If a regular file exists: unlink it (do not leave stale success artifacts).
 * - If a symlink exists: fail closed (never follow / never write through it).
 * - If a directory exists: fail closed.
 * - Recreate parent dir 0700; create empty private file (0600) with O_EXCL.
 *
 * @param {string} outputPath
 * @returns {Promise<{ ok: true } | { ok: false, infraFailure: string }>}
 */
export async function prepareFreshOutputPath(outputPath) {
  const out = path.resolve(String(outputPath));
  const parent = path.dirname(out);

  try {
    // Component-by-component; never follow intermediate symlink directories.
    await ensurePrivateDirNoFollow(parent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      infraFailure: `failed to create output parent dir: ${message}`,
    };
  }

  try {
    const st = await lstat(out);
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        infraFailure: `outputPath is a symlink (fail closed): ${out}`,
      };
    }
    if (st.isDirectory()) {
      return {
        ok: false,
        infraFailure: `outputPath is a directory (fail closed): ${out}`,
      };
    }
    // Regular file (or other non-dir non-link): remove without following.
    await unlink(out);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return {
        ok: false,
        infraFailure: err.message,
      };
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        infraFailure: `failed to clear outputPath: ${message}`,
      };
    }
  }

  try {
    // Atomic exclusive create via shared no-follow primitive (empty seed).
    await writeFileAtomicNoFollow(out, '', { mode: 0o600, fsync: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      infraFailure: `failed to create fresh empty outputPath: ${message}`,
    };
  }

  return { ok: true };
}

/**
 * Load request identity fields from an in-memory request or request JSON file.
 * @param {unknown} request
 * @param {string} requestPath
 * @returns {Promise<{
 *   requestId: string | null,
 *   provider: string | null,
 *   requestedModel: string | null,
 * }>}
 */
async function resolveExpectedIdentity(request, requestPath) {
  /** @type {Record<string, unknown> | null} */
  let rec = null;
  if (request != null && typeof request === 'object' && !Array.isArray(request)) {
    rec = /** @type {Record<string, unknown>} */ (request);
  } else {
    try {
      const text = await readFile(String(requestPath), 'utf8');
      const obj = JSON.parse(text);
      if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
        rec = /** @type {Record<string, unknown>} */ (obj);
      }
    } catch {
      /* fall through */
    }
  }
  if (rec == null) {
    return { requestId: null, provider: null, requestedModel: null };
  }
  const requestId =
    rec.requestId != null && String(rec.requestId).trim() !== ''
      ? String(rec.requestId)
      : null;
  const provider =
    rec.provider != null && String(rec.provider).trim() !== ''
      ? String(rec.provider)
      : null;
  const requestedModel = normalizeRequestedModelIdentity(rec.model);
  return { requestId, provider, requestedModel };
}

/**
 * Bind a schema-valid parse to the frozen request identity.
 *
 * Before fullyBound / success / model evidence is allowed:
 * - result.requestId must exactly equal expected.requestId
 * - result.provider.requested.value must exactly equal expected.provider
 * - model.requested AvailabilityCoded must match request.model semantics:
 *     - request pinned model string → available with exact value
 *     - no request model → unavailable (value must not claim a different model)
 *
 * On any mismatch: valid=false, success=false, artifact=null (no model evidence).
 * Non-success outcome kinds are preserved when schema is valid and identity binds.
 *
 * @param {ParsedInvokeResult} parsed
 * @param {ExpectedInvokeIdentity} expected
 * @returns {ParsedInvokeResult}
 */
export function bindInvokeResultToRequest(parsed, expected) {
  const expectedRequestId = String(expected.requestId);
  const expectedProvider = String(expected.provider);
  const expectedRequestedModel = normalizeRequestedModelIdentity(
    expected.requestedModel,
  );

  const artifact = parsed.artifact;
  // No artifact to bind — preserve the original parse/read failure (cannot be success).
  if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return {
      ...parsed,
      valid: false,
      success: false,
      artifact: null,
    };
  }

  const rec = /** @type {Record<string, unknown>} */ (artifact);

  const rawId = rec.requestId;
  const gotId =
    rawId != null && String(rawId).trim() !== '' ? String(rawId) : null;
  if (gotId !== expectedRequestId) {
    return {
      ...parsed,
      valid: false,
      success: false,
      artifact: null,
      infraFailure: `adapter result requestId mismatch: expected ${expectedRequestId}, got ${gotId ?? '(missing)'}`,
      parseError: 'requestId-mismatch',
    };
  }

  // provider.requested is AvailableValue<string> after strict parse
  let gotProvider = null;
  if (
    rec.provider != null &&
    typeof rec.provider === 'object' &&
    !Array.isArray(rec.provider)
  ) {
    const p = /** @type {Record<string, unknown>} */ (rec.provider);
    gotProvider = valueFromAvailabilityCoded(p.requested);
  }
  if (gotProvider !== expectedProvider) {
    return {
      ...parsed,
      valid: false,
      success: false,
      artifact: null,
      infraFailure: `adapter result provider.requested mismatch: expected ${expectedProvider}, got ${gotProvider ?? '(missing)'}`,
      parseError: 'provider-mismatch',
    };
  }

  // model.requested is AvailabilityCoded: available value or unavailable
  let gotRequestedModel = null;
  let modelRequestedUnavailable = false;
  if (rec.model != null && typeof rec.model === 'object' && !Array.isArray(rec.model)) {
    const m = /** @type {Record<string, unknown>} */ (rec.model);
    if (
      m.requested != null &&
      typeof m.requested === 'object' &&
      !Array.isArray(m.requested)
    ) {
      const mr = /** @type {Record<string, unknown>} */ (m.requested);
      if (mr.availability === 'unavailable') {
        modelRequestedUnavailable = true;
        gotRequestedModel = null;
      } else {
        gotRequestedModel = valueFromAvailabilityCoded(m.requested);
      }
    }
  }

  if (expectedRequestedModel != null) {
    // Request pinned a model → result must claim available with exact value
    if (gotRequestedModel !== expectedRequestedModel) {
      return {
        ...parsed,
        valid: false,
        success: false,
        artifact: null,
        infraFailure: `adapter result model.requested mismatch: expected available ${expectedRequestedModel}, got ${gotRequestedModel ?? (modelRequestedUnavailable ? 'unavailable' : '(missing)')}`,
        parseError: 'requested-model-mismatch',
      };
    }
  } else {
    // No request model → result must report unavailable (not a non-null available claim)
    if (gotRequestedModel != null) {
      return {
        ...parsed,
        valid: false,
        success: false,
        artifact: null,
        infraFailure: `adapter result model.requested mismatch: expected unavailable (no model on request), got available ${gotRequestedModel}`,
        parseError: 'requested-model-mismatch',
      };
    }
    if (!modelRequestedUnavailable && gotRequestedModel == null) {
      // parse requires AvailabilityCoded — if missing structure, already invalid
      // at parse. If somehow absent, fail closed.
      return {
        ...parsed,
        valid: false,
        success: false,
        artifact: null,
        infraFailure:
          'adapter result model.requested must be unavailable when request has no model',
        parseError: 'requested-model-mismatch',
      };
    }
  }

  if (parsed.valid === true) {
    return parsed;
  }

  // Identity matched but parse was already invalid — still clear artifact evidence.
  return {
    ...parsed,
    valid: false,
    success: false,
    artifact: null,
    infraFailure:
      parsed.infraFailure || 'adapter result invalid after identity bind',
    parseError: parsed.parseError || 'invalid-after-bind',
  };
}

/**
 * Deterministic expected provider raw paths under the output's parent.
 * Exact mirror of Poetic resolveArtifactQuarantineDir(outputPath, requestId)
 * plus stdout.txt / stderr.txt filenames.
 *
 * @param {string} outputPath
 * @param {string} requestId
 * @returns {{
 *   scratchRoot: string,
 *   artifactsDirName: string,
 *   requestId: string,
 *   dir: string,
 *   stdoutPath: string,
 *   stderrPath: string,
 * } | { error: string }}
 */
export function expectedProviderRawPaths(outputPath, requestId) {
  if (outputPath == null || String(outputPath).trim() === '') {
    return { error: 'outputPath is required for provider raw paths' };
  }
  let safeId;
  try {
    safeId = assertSafeIdSegment(String(requestId), { label: 'requestId' });
  } catch (err) {
    const message =
      err instanceof PathEscapeError || err instanceof Error
        ? err.message
        : String(err);
    return { error: `unsafe requestId for provider raw paths: ${message}` };
  }
  const resolvedOutput = path.resolve(String(outputPath));
  const scratchRoot = path.dirname(resolvedOutput);
  const artifactsDirName = resolveProviderRawArtifactsDirName(resolvedOutput);
  const dir = path.join(scratchRoot, artifactsDirName, safeId);
  return {
    scratchRoot,
    artifactsDirName,
    requestId: safeId,
    dir,
    stdoutPath: path.join(dir, PROVIDER_RAW_STDOUT_NAME),
    stderrPath: path.join(dir, PROVIDER_RAW_STDERR_NAME),
  };
}

/**
 * After full schema + identity binding (requestId/provider/model.requested),
 * ingest actual Poetic provider stdout/stderr from deterministic quarantine
 * paths under the scratch tree (<stem>.invoke-artifacts/<requestId>/).
 * Fail closed on missing/unsafe/escape/symlink paths — never claim provider
 * evidence.
 *
 * @param {string} outputPath
 * @param {string} requestId
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   stdout: string,
 *   stderr: string,
 *   stdoutBytes?: Buffer,
 *   stderrBytes?: Buffer,
 *   unavailable?: boolean,
 *   error?: string,
 * }>}
 */
export async function ingestProviderRawEvidence(outputPath, requestId, opts = {}) {
  const paths = expectedProviderRawPaths(outputPath, requestId);
  if ('error' in paths) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      unavailable: true,
      error: paths.error,
    };
  }

  try {
    // Full-file Buffer reads (no streaming chunk boundaries). Exact bytes are
    // retained for quarantine digests; string forms are one UTF-8 decode.
    // Invalid UTF-8 still becomes U+FFFD in the string view only.
    const stdoutBuf = await readContainedRegularFileNoFollow(
      paths.scratchRoot,
      paths.stdoutPath,
      paths.stdoutPath,
      opts,
    );
    const stderrBuf = await readContainedRegularFileNoFollow(
      paths.scratchRoot,
      paths.stderrPath,
      paths.stderrPath,
      opts,
    );
    return {
      ok: true,
      stdoutBytes: stdoutBuf,
      stderrBytes: stderrBuf,
      stdout: stdoutBuf.toString('utf8'),
      stderr: stderrBuf.toString('utf8'),
    };
  } catch (err) {
    const message =
      err instanceof UnsafePathError || err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      stdout: '',
      stderr: '',
      unavailable: true,
      error: `provider raw evidence unavailable (fail closed): ${message}`,
    };
  }
}

/**
 * Invoke Poetic via the provider-adapter path.
 *
 * Always parses the result artifact after spawn. Bridge process exit 0 alone
 * is not success — only a fully schema-valid result with identity bound to
 * the frozen request (requestId + provider + requested model) and
 * outcome.kind === 'success' yields success: true.
 *
 * @param {object} opts
 * @param {string} opts.poeticBin - path or name of poetic executable (injectable for tests)
 * @param {string} opts.requestPath - path to request JSON file
 * @param {string} opts.outputPath - path where poetic writes its response
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env] harness-controlled only
 * @param {number} [opts.timeoutMs]
 * @param {unknown} [opts.request] if provided, written as JSON to requestPath before spawn
 * @param {string} opts.campaignDir - campaign control tree hidden from provider via OS confinement
 * @param {import('./provider-confine.js').ProviderConfinementInfo} [opts.confinement]
 * @param {unknown} [opts.taskEnv] - REJECTED if present (smuggling guard; never merge task YAML env)
 * @returns {Promise<InvokerResult>}
 */
export async function invokePoeticAdapter({
  poeticBin,
  requestPath,
  outputPath,
  cwd,
  env,
  timeoutMs,
  request,
  campaignDir,
  confinement,
  taskEnv,
  ...rest
}) {
  // Refuse credential/env smuggling from task YAML (before confinement setup).
  if (taskEnv !== undefined) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure:
        'refusing taskEnv: poetic-adapter does not merge corpus task YAML env/credentials',
    };
  }
  if (rest && Object.prototype.hasOwnProperty.call(rest, 'task')) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'refusing task object: pass only harness-controlled options',
    };
  }
  if (campaignDir == null || String(campaignDir).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure:
        'campaignDir is required for provider confinement (fail closed; unconfined refused)',
    };
  }
  if (poeticBin == null || String(poeticBin).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'poeticBin is required',
    };
  }
  if (requestPath == null || String(requestPath).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'requestPath is required',
    };
  }
  if (outputPath == null || String(outputPath).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: '',
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'outputPath is required',
    };
  }

  if (request !== undefined) {
    // Parent dirs private (0700); request file private (0600) via atomic no-follow.
    // Never open/chmod a pre-existing request leaf symlink.
    await ensurePrivateDirNoFollow(path.dirname(requestPath));
    await writeFileAtomicNoFollow(
      requestPath,
      `${JSON.stringify(request, null, 2)}\n`,
      { mode: 0o600, fsync: true },
    );
  }

  // Fresh output binding: securely remove any prior artifact, then create empty.
  // Never leave a pre-planted success file in place; never follow a symlink.
  const prep = await prepareFreshOutputPath(String(outputPath));
  if (!prep.ok) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: String(outputPath),
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: prep.infraFailure,
    };
  }

  const expectedIdentity = await resolveExpectedIdentity(request, requestPath);
  if (expectedIdentity.requestId == null) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: String(outputPath),
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'requestId is required for adapter result binding',
    };
  }
  if (expectedIdentity.provider == null) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: String(outputPath),
      success: false,
      outcomeKind: null,
      reasonCode: null,
      infraFailure: 'provider is required for adapter result identity binding',
    };
  }
  const expectedRequestId = expectedIdentity.requestId;

  const args = [
    'provider',
    'invoke',
    '--request',
    String(requestPath),
    '--output',
    String(outputPath),
  ];

  // Fail-closed OS confinement: campaign tree inaccessible while provider is alive.
  // Nested Poetic sandboxes (if any) run inside this outer restriction.
  // Private TMPDIR lives under the already-writable scratch bind (request parent)
  // so Poetic's os.tmpdir() raw spool remains writable under bubblewrap.
  const scratchParent = path.dirname(path.resolve(String(requestPath)));
  const result = await spawnControlled({
    command: String(poeticBin),
    args,
    cwd,
    env,
    timeoutMs,
    campaignDir: String(campaignDir),
    confine: true,
    confinement,
    privateTempParent: scratchParent,
    extraBindPaths: [
      scratchParent,
      path.dirname(path.resolve(String(outputPath))),
    ],
  });

  /** @type {InvokerResult} */
  const base = {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    // Quiet wrapper streams — replaced with actual provider raw only after
    // full valid+requestId bind and safe path ingestion below.
    stdout: '',
    stderr: '',
    outputPath: String(outputPath),
    success: false,
    outcomeKind: null,
    reasonCode: null,
    parsedOutput: null,
    ...(result.signal ? { signal: result.signal } : {}),
  };

  // Spawn-level failure (not found, timeout kill, etc.) — still try to parse
  // any artifact the bridge may have written before dying.
  let parsed = await readAndParseOutput(String(outputPath));
  // Accept only when requestId + provider + requested model match the frozen request.
  parsed = bindInvokeResultToRequest(parsed, {
    requestId: expectedRequestId,
    provider: expectedIdentity.provider,
    requestedModel: expectedIdentity.requestedModel,
  });

  // Only a fully schema-valid + identity-bound result may supply model/artifact evidence.
  const fullyBound = parsed.valid === true && parsed.artifact != null;
  base.parsedOutput = fullyBound ? parsed.artifact : null;
  base.outcomeKind = parsed.outcomeKind;
  base.reasonCode = parsed.reasonCode;

  // Prefer spawn timeout, then artifact timeout.
  const timedOut = Boolean(result.timedOut || parsed.timedOut);
  base.timedOut = timedOut;

  // Merge failure evidence (spawn first, then artifact).
  /** @type {string[]} */
  const infraParts = [];
  if (result.infraFailure) infraParts.push(result.infraFailure);
  if (parsed.infraFailure) infraParts.push(parsed.infraFailure);
  if (infraParts.length > 0) {
    base.infraFailure = infraParts.join('; ');
  }
  if (parsed.providerFailure) {
    base.providerFailure = parsed.providerFailure;
  }

  // After full schema + identity bind: ingest actual provider raw from
  // deterministic <stem>.invoke-artifacts/<requestId>/{stdout,stderr}.txt
  // (Poetic resolveArtifactQuarantineDir contract).
  // On any invalid/missing/unsafe path: do not claim provider evidence.
  if (fullyBound) {
    const raw = await ingestProviderRawEvidence(
      String(outputPath),
      expectedRequestId,
    );
    if (raw.ok) {
      // Prefer exact raw bytes for quarantine/digest; string is decode view.
      base.stdout = raw.stdout;
      base.stderr = raw.stderr;
      base.stdoutBytes = raw.stdoutBytes;
      base.stderrBytes = raw.stderrBytes;
      base.providerRawEvidence = 'actual';
    } else {
      base.stdout = '';
      base.stderr = '';
      base.providerRawEvidence = 'unavailable';
      base.providerRawEvidenceError = raw.error;
      // Fail closed: cannot claim success without validated provider raw.
      if (!base.infraFailure) {
        base.infraFailure =
          raw.error ||
          'provider raw evidence unavailable under <stem>.invoke-artifacts (fail closed)';
      } else {
        base.infraFailure = `${base.infraFailure}; ${raw.error || 'provider raw unavailable'}`;
      }
    }
  } else {
    base.providerRawEvidence = 'unavailable';
    // Quiet wrapper streams are not provider evidence — leave empty.
    base.stdout = '';
    base.stderr = '';
  }

  // Success only when spawn did not time out, exit is 0, outcome.kind is
  // success, identity binds (requestId/provider/model.requested), and
  // provider raw was ingested.
  const exitOk = result.exitCode === 0;
  base.success =
    fullyBound &&
    parsed.success === true &&
    !timedOut &&
    exitOk &&
    !result.infraFailure &&
    base.providerRawEvidence === 'actual' &&
    !base.infraFailure;

  // Non-success with clean CLI exit still must not look like clean success.
  if (!base.success && !base.infraFailure && !base.providerFailure) {
    if (!parsed.valid) {
      base.infraFailure =
        parsed.parseError != null
          ? `invalid invoke result (${parsed.parseError})`
          : 'invalid invoke result';
    } else if (parsed.outcomeKind && parsed.outcomeKind !== 'success') {
      base.infraFailure = `adapter non-success outcome: ${parsed.outcomeKind}`;
    } else if (!exitOk) {
      // Non-zero exit without other evidence — leave for classify as FAIL via exitCode
    } else {
      base.infraFailure = 'adapter did not report success';
    }
  }

  // Never expose quiet CLI bytes as provider evidence when bind failed.
  if (!fullyBound || base.providerRawEvidence !== 'actual') {
    base.stdout = '';
    base.stderr = '';
  }

  return base;
}
