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
 * `outputPath` (never following a symlink), then after spawn accepts success
 * only when the artifact `requestId` exactly equals the current request's
 * `requestId` (rejects stale/pre-planted success for another request).
 */

import { writeFile, mkdir, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnControlled } from './spawn-controlled.js';

/** Bridge result schema id. */
export const POETIC_INVOKE_RESULT_SCHEMA = 'poetic.provider.invoke.result.v1';

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
 * Fail closed: missing schema, missing outcome, or unknown kind → invalid.
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
      return {
        valid: false,
        success: false,
        outcomeKind: null,
        reasonCode: null,
        timedOut: false,
        infraFailure: `unparseable invoke result: ${message}`,
        parseError: message,
        artifact: null,
      };
    }
  }

  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: 'invoke result is not a JSON object',
      parseError: 'not-object',
      artifact: null,
    };
  }

  const rec = /** @type {Record<string, unknown>} */ (obj);
  const schema = rec.schema != null ? String(rec.schema) : '';
  if (schema !== POETIC_INVOKE_RESULT_SCHEMA) {
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: `invoke result schema mismatch: expected ${POETIC_INVOKE_RESULT_SCHEMA}, got ${schema || '(missing)'}`,
      parseError: 'schema-mismatch',
      artifact: rec,
    };
  }

  const outcome = rec.outcome;
  if (outcome == null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: 'invoke result missing outcome object',
      parseError: 'missing-outcome',
      artifact: rec,
    };
  }

  const o = /** @type {Record<string, unknown>} */ (outcome);
  if (o.kind == null || String(o.kind).trim() === '') {
    return {
      valid: false,
      success: false,
      outcomeKind: null,
      reasonCode: null,
      timedOut: false,
      infraFailure: 'invoke result outcome.kind is missing',
      parseError: 'missing-kind',
      artifact: rec,
    };
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
      // Strip free-form reason from artifact copy used on ordinary records
      artifact: sanitizeArtifactReasonCode(rec),
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
    text = await readFile(outputPath, 'utf8');
  } catch (err) {
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
 * Extract requestId from a request object or request JSON file.
 * @param {unknown} request
 * @param {string} requestPath
 * @returns {Promise<string | null>}
 */
async function resolveExpectedRequestId(request, requestPath) {
  if (request != null && typeof request === 'object' && !Array.isArray(request)) {
    const id = /** @type {Record<string, unknown>} */ (request).requestId;
    if (id != null && String(id).trim() !== '') {
      return String(id);
    }
  }
  try {
    const text = await readFile(String(requestPath), 'utf8');
    const obj = JSON.parse(text);
    if (
      obj != null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      obj.requestId != null &&
      String(obj.requestId).trim() !== ''
    ) {
      return String(obj.requestId);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Bind a parsed invoke result to the expected requestId.
 * Stale/pre-planted success for a different requestId is never accepted.
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
    return parsed;
  }
  const rawId = /** @type {Record<string, unknown>} */ (artifact).requestId;
  const got = rawId != null && String(rawId).trim() !== '' ? String(rawId) : null;

  if (got === expected) {
    return parsed;
  }

  return {
    ...parsed,
    valid: false,
    success: false,
    infraFailure: `adapter result requestId mismatch: expected ${expected}, got ${got ?? '(missing)'}`,
    parseError: 'requestId-mismatch',
  };
}

/**
 * Invoke Poetic via the provider-adapter path.
 *
 * Always parses the result artifact after spawn. Bridge process exit 0 alone
 * is not success — only outcome.kind === 'success' with matching requestId
 * yields success: true.
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

  const expectedRequestId = await resolveExpectedRequestId(request, requestPath);
  if (expectedRequestId == null) {
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
    stdout: result.stdout,
    stderr: result.stderr,
    outputPath: String(outputPath),
    success: false,
    outcomeKind: null,
    reasonCode: null,
    ...(result.signal ? { signal: result.signal } : {}),
  };

  // Spawn-level failure (not found, timeout kill, etc.) — still try to parse
  // any artifact the bridge may have written before dying.
  let parsed = await readAndParseOutput(String(outputPath));
  // Accept only when artifact requestId exactly equals this invoke's requestId.
  parsed = bindInvokeResultToRequestId(parsed, expectedRequestId);

  base.parsedOutput = parsed.artifact ?? null;
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

  // Success only when spawn did not time out, exit is 0,
  // outcome.kind is success, and requestId matches.
  const exitOk = result.exitCode === 0;
  base.success =
    parsed.valid === true &&
    parsed.success === true &&
    !timedOut &&
    exitOk &&
    !result.infraFailure;

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

  return base;
}
