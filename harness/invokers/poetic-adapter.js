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

import { writeFile, mkdir, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnControlled } from './spawn-controlled.js';
import {
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
 * Bounded adapter reasonCode syntax for ordinary/exported records.
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
 * Normalize requested-model identity for bind comparison.
 * Absent / null / empty → null (request did not pin a model).
 * Non-empty string → that string.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeRequestedModelIdentity(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s;
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
 * Type-check model.resolved under poetic.provider.invoke.result.v1.
 * - availability: "available" requires non-empty string value
 * - availability: "unavailable" may include optional reason (string if present)
 *
 * @param {unknown} resolved
 * @returns {{ ok: true } | { ok: false, error: string, parseError: string }}
 */
function validateModelResolved(resolved) {
  if (resolved == null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    return {
      ok: false,
      error: 'invoke result model.resolved must be an object',
      parseError: 'invalid-model-resolved',
    };
  }
  const r = /** @type {Record<string, unknown>} */ (resolved);
  const availability =
    r.availability != null ? String(r.availability).trim() : '';
  if (availability === 'available') {
    if (typeof r.value !== 'string' || r.value.trim() === '') {
      return {
        ok: false,
        error:
          'invoke result model.resolved.availability is available but value is missing or not a non-empty string',
        parseError: 'model-resolved-available-missing-value',
      };
    }
    return { ok: true };
  }
  if (availability === 'unavailable') {
    if (r.reason != null && typeof r.reason !== 'string') {
      return {
        ok: false,
        error: 'invoke result model.resolved.reason must be a string when present',
        parseError: 'invalid-model-resolved-reason',
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: `invoke result model.resolved.availability must be "available" or "unavailable", got ${availability || '(missing)'}`,
    parseError: 'invalid-model-resolved-availability',
  };
}

/**
 * Type-check model object under poetic.provider.invoke.result.v1.
 *
 * model.requested contract:
 * - optional at parse time (string or null/absent)
 * - non-string non-null is invalid
 * - identity consistency with the frozen request is enforced by
 *   bindInvokeResultToRequest (not parse alone)
 *
 * @param {unknown} model
 * @returns {{ ok: true } | { ok: false, error: string, parseError: string }}
 */
function validateModelObject(model) {
  if (model == null || typeof model !== 'object' || Array.isArray(model)) {
    return {
      ok: false,
      error: 'invoke result missing model object',
      parseError: 'missing-model',
    };
  }
  const m = /** @type {Record<string, unknown>} */ (model);
  if ('requested' in m && m.requested != null && typeof m.requested !== 'string') {
    return {
      ok: false,
      error: 'invoke result model.requested must be a string or null/absent',
      parseError: 'invalid-model-requested',
    };
  }
  return validateModelResolved(m.resolved);
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
 * Parse and validate a poetic.provider.invoke.result.v1 artifact.
 *
 * Strict contract (fail closed — invalid never retains model/artifact evidence):
 * - schema === poetic.provider.invoke.result.v1
 * - requestId: non-empty string
 * - provider: non-empty string
 * - model: object with:
 *     requested?: string | null (identity match deferred to bind)
 *     resolved: { availability: "available"|"unavailable", value?|reason? }
 * - outcome: { kind ∈ POETIC_OUTCOME_KINDS, reasonCode?: sanitized }
 * - process / evidence / artifact: if present, must be plain objects
 *
 * Non-success outcome kinds remain valid when the rest of the schema is sound;
 * identity binding (requestId/provider/model.requested) is separate.
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

  // Required identity fields on the result itself (bind still checks vs request).
  if (typeof rec.requestId !== 'string' || rec.requestId.trim() === '') {
    return invalidParse(
      'invoke result requestId must be a non-empty string',
      'missing-requestId',
    );
  }
  if (typeof rec.provider !== 'string' || rec.provider.trim() === '') {
    return invalidParse(
      'invoke result provider must be a non-empty string',
      'missing-provider',
    );
  }

  const modelCheck = validateModelObject(rec.model);
  if (!modelCheck.ok) {
    return invalidParse(modelCheck.error, modelCheck.parseError);
  }

  // Optional envelope fields: type-check when present (never accept arrays / scalars).
  for (const key of /** @type {const} */ (['process', 'evidence', 'artifact'])) {
    if (key in rec && rec[key] != null) {
      if (typeof rec[key] !== 'object' || Array.isArray(rec[key])) {
        return invalidParse(
          `invoke result ${key} must be an object when present`,
          `invalid-${key}`,
        );
      }
    }
  }

  const outcome = rec.outcome;
  if (outcome == null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return invalidParse(
      'invoke result missing outcome object',
      'missing-outcome',
    );
  }

  const o = /** @type {Record<string, unknown>} */ (outcome);
  if (o.kind == null || String(o.kind).trim() === '') {
    return invalidParse(
      'invoke result outcome.kind is missing',
      'missing-kind',
    );
  }

  const kind = String(o.kind).trim();
  // Parse-boundary validation: free-form reasonCode never enters ordinary records.
  const rawReason =
    o.reasonCode != null && String(o.reasonCode).trim() !== ''
      ? String(o.reasonCode).trim()
      : null;
  const reasonCodeRejected =
    rawReason != null && sanitizeAdapterReasonCode(rawReason) == null;
  const reasonCode = sanitizeAdapterReasonCode(rawReason);

  if (!OUTCOME_KIND_SET.has(kind)) {
    const mapped = mapOutcomeKind(kind, reasonCode);
    return {
      valid: false,
      ...mapped,
      success: false,
      reasonCode, // sanitized only (null if free-form)
      reasonCodeRejected,
      infraFailure:
        mapped.infraFailure ??
        `unknown adapter outcome kind (${kind})`,
      parseError: 'unknown-kind',
      // Invalid kinds never supply model/artifact evidence
      artifact: null,
    };
  }

  const mapped = mapOutcomeKind(kind, reasonCode);
  return {
    valid: true,
    ...mapped,
    reasonCode,
    reasonCodeRejected,
    artifact: sanitizeArtifactReasonCode(rec),
  };
}

/**
 * Return a shallow copy of the result artifact with outcome.reasonCode
 * sanitized (or removed when free-form) so free-form never flows downstream.
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown>}
 */
function sanitizeArtifactReasonCode(rec) {
  const out = { ...rec };
  if (out.outcome != null && typeof out.outcome === 'object' && !Array.isArray(out.outcome)) {
    const outcome = { .../** @type {Record<string, unknown>} */ (out.outcome) };
    if ('reasonCode' in outcome) {
      const s = sanitizeAdapterReasonCode(outcome.reasonCode);
      if (s == null) {
        delete outcome.reasonCode;
      } else {
        outcome.reasonCode = s;
      }
    }
    out.outcome = outcome;
  }
  return out;
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
    await mkdir(parent, { recursive: true, mode: 0o700 });
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
    // O_EXCL (flag wx): only this run may create; reject races.
    await writeFile(out, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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
 * - result.provider must exactly equal expected.provider
 * - requested model identity must match, including null/absence:
 *     - if the request has no model / null / empty, the result must not claim
 *       a different non-null model.requested
 *     - if the request has a model string, result.model.requested must equal it
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

  const rawProvider = rec.provider;
  const gotProvider =
    rawProvider != null && String(rawProvider).trim() !== ''
      ? String(rawProvider)
      : null;
  if (gotProvider !== expectedProvider) {
    return {
      ...parsed,
      valid: false,
      success: false,
      artifact: null,
      infraFailure: `adapter result provider mismatch: expected ${expectedProvider}, got ${gotProvider ?? '(missing)'}`,
      parseError: 'provider-mismatch',
    };
  }

  // model.requested: string | null | absent. Compare null-normalized identities.
  let gotRequestedModel = null;
  if (rec.model != null && typeof rec.model === 'object' && !Array.isArray(rec.model)) {
    const m = /** @type {Record<string, unknown>} */ (rec.model);
    gotRequestedModel = normalizeRequestedModelIdentity(m.requested);
  }
  if (gotRequestedModel !== expectedRequestedModel) {
    return {
      ...parsed,
      valid: false,
      success: false,
      artifact: null,
      infraFailure: `adapter result model.requested mismatch: expected ${expectedRequestedModel ?? '(none)'}, got ${gotRequestedModel ?? '(none)'}`,
      parseError: 'requested-model-mismatch',
    };
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
 * Bind a parsed invoke result to the expected requestId only.
 * Prefer {@link bindInvokeResultToRequest} for full identity (provider + model).
 * Stale/pre-planted success for a different requestId is never accepted.
 * On any mismatch, clear artifact so model/parsedOutput cannot be consumed.
 *
 * @param {ParsedInvokeResult} parsed
 * @param {string} expectedRequestId
 * @returns {ParsedInvokeResult}
 */
export function bindInvokeResultToRequestId(parsed, expectedRequestId) {
  const expected = String(expectedRequestId);
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
  const rawId = /** @type {Record<string, unknown>} */ (artifact).requestId;
  const got = rawId != null && String(rawId).trim() !== '' ? String(rawId) : null;

  if (got === expected && parsed.valid === true) {
    return parsed;
  }

  return {
    ...parsed,
    valid: false,
    success: false,
    // Clear model/artifact evidence after any binding failure
    artifact: null,
    infraFailure:
      got === expected
        ? parsed.infraFailure || 'adapter result invalid after requestId bind'
        : `adapter result requestId mismatch: expected ${expected}, got ${got ?? '(missing)'}`,
    parseError:
      got === expected
        ? parsed.parseError || 'invalid-after-bind'
        : 'requestId-mismatch',
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
}) {
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
    // Parent dirs private (0700); request file private (0600) at creation.
    await mkdir(path.dirname(requestPath), { recursive: true, mode: 0o700 });
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
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
  const result = await spawnControlled({
    command: String(poeticBin),
    args,
    cwd,
    env,
    timeoutMs,
    campaignDir: String(campaignDir),
    confine: true,
    confinement,
    extraBindPaths: [
      path.dirname(String(requestPath)),
      path.dirname(String(outputPath)),
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
      base.stdout = raw.stdout;
      base.stderr = raw.stderr;
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
