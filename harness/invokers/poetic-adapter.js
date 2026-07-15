/**
 * Poetic adapter invoker: argv-safe `poetic provider invoke --request … --output …`.
 *
 * Does not pass arbitrary env from corpus task YAML. Only harness-controlled
 * env (explicit `env` or filtered process.env) is used. Tests inject `poeticBin`.
 *
 * Bridge contract: CLI may exit 0 after writing an artifact. The harness MUST
 * parse `poetic.provider.invoke.result.v1` and map `outcome.kind` / `reasonCode`
 * into the invoker result. Non-success outcomes are never treated as success.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
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
  const code = reasonCode != null && String(reasonCode).trim() !== ''
    ? String(reasonCode)
    : null;
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
  const reasonCode =
    o.reasonCode != null && String(o.reasonCode).trim() !== ''
      ? String(o.reasonCode)
      : null;

  if (!OUTCOME_KIND_SET.has(kind)) {
    const mapped = mapOutcomeKind(kind, reasonCode);
    return {
      valid: false,
      ...mapped,
      success: false,
      infraFailure:
        mapped.infraFailure ??
        `unknown adapter outcome kind (${kind})`,
      parseError: 'unknown-kind',
      artifact: rec,
    };
  }

  const mapped = mapOutcomeKind(kind, reasonCode);
  return {
    valid: true,
    ...mapped,
    artifact: rec,
  };
}

/**
 * Read and parse the adapter output artifact at outputPath.
 * @param {string} outputPath
 * @returns {Promise<ParsedInvokeResult>}
 */
async function readAndParseOutput(outputPath) {
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
 * Invoke Poetic via the provider-adapter path.
 *
 * Always parses the result artifact after spawn. Bridge process exit 0 alone
 * is not success — only outcome.kind === 'success' yields success: true.
 *
 * @param {object} opts
 * @param {string} opts.poeticBin - path or name of poetic executable (injectable for tests)
 * @param {string} opts.requestPath - path to request JSON file
 * @param {string} opts.outputPath - path where poetic writes its response
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env] harness-controlled only
 * @param {number} [opts.timeoutMs]
 * @param {unknown} [opts.request] if provided, written as JSON to requestPath before spawn
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
}) {
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

  // Parent of output is private; pre-create output with 0600 so the path exists
  // privately even if the child later truncates/overwrites in place.
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 }).catch(
    () => {},
  );
  try {
    await writeFile(String(outputPath), '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    // EEXIST: already present (e.g. prior run); leave as-is. Other errors: ignore —
    // bridge will create/overwrite; run.js also re-chmods after invoke.
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'EEXIST') {
      /* best-effort private pre-create */
    }
  }

  const args = [
    'provider',
    'invoke',
    '--request',
    String(requestPath),
    '--output',
    String(outputPath),
  ];

  const result = await spawnControlled({
    command: String(poeticBin),
    args,
    cwd,
    env,
    timeoutMs,
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
  const parsed = await readAndParseOutput(String(outputPath));
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

  // Success only when spawn did not time out, exit is 0 (or null only if
  // we still got a valid success artifact — fail closed: require exit 0),
  // and outcome.kind is success.
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
