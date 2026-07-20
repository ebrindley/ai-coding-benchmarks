/**
 * Trial result storage and raw-provider-output quarantine.
 *
 * Results live under campaign/results/<trialId>/result.json.
 * Raw provider stdout/stderr (secret-bearing) live under campaign/raw/<trialId>/
 * with directory mode 0700 and file mode 0600.
 *
 * Write boundaries validate trial ids and constrain paths under campaign roots.
 * Stored digests bind results to on-disk raw/artifact bytes; verify before
 * report/summary/export (fail closed on mismatch).
 */

import {
  readFile,
  access,
  rm,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './contracts.js';
import { assertSafeTrialId, trialPathUnder } from './paths.js';
import {
  sha256Buffer,
  sha256Json,
  digestArtifactDir,
  digestRawOutputBytes,
} from './digest.js';
import {
  isBoundedIdentifier,
  sanitizeBoundedIdentifier,
} from './gates.js';
import {
  assertCampaignFilesystemBoundary,
  copyFileNoFollow,
  ensurePrivateDirNoFollow,
  readFileNoFollow,
  readTextNoFollow,
  writeFileAtomicNoFollow,
  writePrivateFileNoFollow,
  DEFAULT_SAFE_READ_MAX_BYTES,
  UnsafePathError,
} from './safe-fs.js';

/**
 * Version of the neutral invocation protocol evidence envelope on trial results.
 * Bump only when the persisted shape of outcomeKind/reasonCode/protocolSchema changes.
 */
export const PROTOCOL_EVIDENCE_VERSION = 1;

/**
 * Stable schema id for poetic-adapter protocol evidence (must match invoker parse).
 * Re-declared here so results verification does not require loading invokers.
 */
export const PROTOCOL_SCHEMA_POETIC_INVOKE_RESULT_V1 =
  'poetic.provider.invoke.result.v1';

/** Bound for campaign result.json / raw evidence nofollow reads. */
const CAMPAIGN_READ_MAX_BYTES = DEFAULT_SAFE_READ_MAX_BYTES;

const TRIAL_SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'trial.schema.json',
);

/** @type {object | null} */
let cachedTrialSchema = null;

/**
 * Immutable identity fields bound exactly to the frozen manifest trial row.
 * Every field must be present on the frozen row and match the result.
 */
export const MANIFEST_IDENTITY_FIELDS = Object.freeze([
  'id',
  'experimentId',
  'arm',
  'provider',
  'taskId',
  'repetition',
  'scheduleSeed',
  'invocationPath',
  'requestedModel',
  'postureFingerprint',
]);

/**
 * Lexical result dir (sync helper). Prefer resolveTrialResultDir at write boundaries.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {string}
 */
export function trialResultDir(campaignDir, trialId) {
  const id = assertSafeTrialId(trialId);
  return path.join(campaignDir, 'results', id);
}

/**
 * Lexical raw dir (sync helper). Prefer resolveTrialRawDir at write boundaries.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {string}
 */
export function trialRawDir(campaignDir, trialId) {
  const id = assertSafeTrialId(trialId);
  return path.join(campaignDir, 'raw', id);
}

/**
 * Lexical artifact dir (sync helper). Prefer resolveTrialArtifactDir at verify boundaries.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {string}
 */
export function trialArtifactDir(campaignDir, trialId) {
  const id = assertSafeTrialId(trialId);
  return path.join(campaignDir, 'artifacts', id);
}

/**
 * Canonical containment for results/<trialId>.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<string>}
 */
export async function resolveTrialResultDir(campaignDir, trialId) {
  if (!campaignDir) throw new Error('resolveTrialResultDir: campaignDir is required');
  const resultsRoot = path.join(path.resolve(campaignDir), 'results');
  return trialPathUnder(resultsRoot, trialId);
}

/**
 * Canonical containment for raw/<trialId>.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<string>}
 */
export async function resolveTrialRawDir(campaignDir, trialId) {
  if (!campaignDir) throw new Error('resolveTrialRawDir: campaignDir is required');
  const rawRoot = path.join(path.resolve(campaignDir), 'raw');
  return trialPathUnder(rawRoot, trialId);
}

/**
 * Canonical containment for artifacts/<trialId>.
 * Verification always digests this path — never trust result.artifactDir.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<string>}
 */
export async function resolveTrialArtifactDir(campaignDir, trialId) {
  if (!campaignDir) throw new Error('resolveTrialArtifactDir: campaignDir is required');
  const artifactsRoot = path.join(path.resolve(campaignDir), 'artifacts');
  return trialPathUnder(artifactsRoot, trialId);
}

/**
 * Load trial.schema.json (cached).
 * @returns {Promise<object>}
 */
export async function loadTrialSchema() {
  if (cachedTrialSchema) return cachedTrialSchema;
  const text = await readFile(TRIAL_SCHEMA_PATH, 'utf8');
  cachedTrialSchema = JSON.parse(text);
  return cachedTrialSchema;
}

/**
 * @param {unknown} value
 * @param {string} t
 * @returns {boolean}
 */
function matchesJsonSchemaType(value, t) {
  if (t === 'null') return value === null;
  if (t === 'array') return Array.isArray(value);
  if (t === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (t === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (t === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === t;
}

/**
 * Resolve a local `#/...` $ref against the schema root.
 * @param {object} root
 * @param {string} ref
 * @returns {object}
 */
function resolveSchemaRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const parts = ref.slice(2).split('/');
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`$ref not found: ${ref}`);
    }
    cur = cur[p];
  }
  if (!cur || typeof cur !== 'object') {
    throw new Error(`$ref target not an object: ${ref}`);
  }
  return cur;
}

/**
 * Minimal draft-07 subset validator (no deps). Enforces type, required,
 * properties, enum, const, additionalProperties, items, pattern, min/max,
 * minLength/maxLength, and local $ref.
 *
 * @param {unknown} data
 * @param {object} schema
 * @param {object} root
 * @param {string} [pathStr]
 * @param {{ requireRequired?: boolean }} [opts]
 * @returns {string[]}
 */
export function validateJsonSchemaSubset(
  data,
  schema,
  root,
  pathStr = '$',
  opts = {},
) {
  if (!schema || typeof schema !== 'object') return [];
  const requireRequired = opts.requireRequired !== false;

  if (schema.$ref) {
    return validateJsonSchemaSubset(
      data,
      resolveSchemaRef(root, schema.$ref),
      root,
      pathStr,
      opts,
    );
  }

  /** @type {string[]} */
  const errors = [];

  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push(
        `${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`,
      );
    }
  }

  if (schema.enum) {
    const ok = schema.enum.some(
      (e) => e === data || (Number.isNaN(e) && Number.isNaN(data)),
    );
    if (!ok) {
      errors.push(`${pathStr}: value ${JSON.stringify(data)} not in enum`);
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesJsonSchemaType(data, t))) {
      errors.push(
        `${pathStr}: expected type ${types.join('|')}, got ${
          data === null
            ? 'null'
            : Array.isArray(data)
              ? 'array'
              : typeof data
        }`,
      );
      return errors;
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(
        `${pathStr}: string shorter than minLength ${schema.minLength}`,
      );
    }
    if (schema.maxLength != null && data.length > schema.maxLength) {
      errors.push(
        `${pathStr}: string longer than maxLength ${schema.maxLength}`,
      );
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(data)) {
        errors.push(
          `${pathStr}: string does not match pattern ${schema.pattern}`,
        );
      }
    }
    if (schema.format === 'date-time') {
      if (Number.isNaN(Date.parse(data))) {
        errors.push(`${pathStr}: invalid date-time`);
      }
    }
  }

  if (typeof data === 'number' && Number.isFinite(data)) {
    if (schema.minimum != null && data < schema.minimum) {
      errors.push(`${pathStr}: ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && data > schema.maximum) {
      errors.push(`${pathStr}: ${data} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(data) && schema.items) {
    for (let i = 0; i < data.length; i += 1) {
      errors.push(
        ...validateJsonSchemaSubset(
          data[i],
          schema.items,
          root,
          `${pathStr}[${i}]`,
          opts,
        ),
      );
    }
  }

  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (schema.properties ||
      schema.required ||
      schema.additionalProperties !== undefined)
  ) {
    const props = schema.properties || {};
    if (requireRequired && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in /** @type {object} */ (data)) || data[key] === undefined) {
          errors.push(`${pathStr}: missing required property "${key}"`);
        }
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(
          ...validateJsonSchemaSubset(
            value,
            props[key],
            root,
            `${pathStr}.${key}`,
            opts,
          ),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathStr}: additional property "${key}" not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        errors.push(
          ...validateJsonSchemaSubset(
            value,
            schema.additionalProperties,
            root,
            `${pathStr}.${key}`,
            opts,
          ),
        );
      }
    }
  }

  return errors;
}

/**
 * Validate a trial result against trial.schema.json.
 * Fail closed on unknown fields and missing required properties by default.
 * There is no silent production opt-out of required-property checks.
 *
 * @param {object} result
 * @param {{ requireRequired?: boolean }} [opts]
 *   requireRequired defaults true. Passing false is rejected (fail closed).
 * @returns {Promise<string[]>} error messages (empty when valid)
 */
export async function validateTrialResultSchema(result, opts = {}) {
  if (opts.requireRequired === false) {
    throw new Error(
      'validateTrialResultSchema: requireRequired:false is not permitted (fail closed)',
    );
  }
  const schema = await loadTrialSchema();
  return validateJsonSchemaSubset(result, schema, schema, '$', {
    requireRequired: true,
  });
}

/**
 * Assert result validates; throw on any schema error.
 * Always enforces required properties (no production opt-out).
 * @param {object} result
 * @param {{ label?: string, requireRequired?: boolean }} [opts]
 */
export async function assertTrialResultSchema(result, opts = {}) {
  // Propagate requireRequired:false as an explicit rejection (same as validate).
  if (opts.requireRequired === false) {
    throw new Error(
      'assertTrialResultSchema: requireRequired:false is not permitted (fail closed)',
    );
  }
  const errors = await validateTrialResultSchema(result, {
    requireRequired: true,
  });
  if (errors.length > 0) {
    const label = opts.label || 'trial result';
    throw new Error(
      `${label} failed schema validation (fail closed): ${errors.join('; ')}`,
    );
  }
}

/**
 * Normalize identity values for comparison (undefined ≡ null).
 * Types are otherwise preserved — numeric 1 and string "1" are distinct.
 * @param {unknown} v
 * @returns {unknown}
 */
function normalizeIdentityValue(v) {
  return v === undefined ? null : v;
}

/**
 * Compare result identity fields against a frozen manifest trial row.
 * Every MANIFEST_IDENTITY_FIELDS entry must be present on the frozen row
 * (authority) and equal the result with exact type-sensitive comparison.
 * Partial test rows fail closed with `manifest:<field>`.
 *
 * @param {object} result
 * @param {object} manifestTrial
 * @returns {string[]} mismatch field names
 */
export function collectManifestIdentityMismatches(result, manifestTrial) {
  if (!result || typeof result !== 'object') return ['result'];
  if (!manifestTrial || typeof manifestTrial !== 'object') {
    return ['manifestTrial'];
  }
  /** @type {string[]} */
  const mismatches = [];
  const r = /** @type {Record<string, unknown>} */ (result);
  const m = /** @type {Record<string, unknown>} */ (manifestTrial);

  for (const field of MANIFEST_IDENTITY_FIELDS) {
    // Frozen authority must declare every immutable identity field.
    if (!(field in m) || m[field] === undefined) {
      mismatches.push(`manifest:${field}`);
      continue;
    }
    // Result must carry the field for binding (null is a declared value).
    if (!(field in r) || r[field] === undefined) {
      mismatches.push(field);
      continue;
    }
    const rv = normalizeIdentityValue(r[field]);
    const mv = normalizeIdentityValue(m[field]);
    // Exact equality: do not coerce number/string (1 !== "1").
    if (rv !== mv) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

/**
 * @param {object} result
 * @param {object} manifestTrial
 * @param {string} [label]
 */
export function assertManifestIdentityBinding(
  result,
  manifestTrial,
  label = 'writeTrialResult',
) {
  const mismatches = collectManifestIdentityMismatches(result, manifestTrial);
  if (mismatches.length > 0) {
    throw new Error(
      `${label}: result identity does not match frozen manifest trial (fail closed): ${mismatches.join(', ')}`,
    );
  }
}

/**
 * Ensure a private directory (0700) without following symlinks.
 * Component-by-component creation; never open/chmod a pre-existing symlink.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function ensurePrivateDir(dir) {
  return ensurePrivateDirNoFollow(dir);
}

/**
 * Write a private file (0600) via atomic no-follow replacement.
 * Never opens or chmods a pre-existing destination symlink.
 * @param {string} filePath
 * @param {string | Buffer} data
 * @returns {Promise<{ path: string }>}
 */
export async function writePrivateFile(filePath, data) {
  return writePrivateFileNoFollow(filePath, data);
}

/**
 * Strip secret-bearing gate previews before ordinary result write.
 * Digests / status / evidence remain.
 * @param {unknown} gateResults
 * @returns {unknown}
 */
function stripGatePreviews(gateResults) {
  if (!Array.isArray(gateResults)) return gateResults;
  return gateResults.map((g) => {
    if (!g || typeof g !== 'object') return g;
    const copy = { ...g };
    delete copy.stdoutPreview;
    delete copy.stderrPreview;
    delete copy.stdout;
    delete copy.stderr;
    delete copy.rawStdout;
    delete copy.rawStderr;
    return copy;
  });
}

/**
 * Write (or overwrite) a trial result.json atomically (dir 0700, file 0600).
 *
 * After defaults/sanitization/timestamps, enforces trial.schema.json
 * (additionalProperties: false) and computes the canonical final-record
 * resultDigest over the complete stored envelope (excluding resultDigest itself).
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} result trial-shaped result payload
 * @param {{ manifestTrial: object }} opts
 *   manifestTrial is required: complete frozen identity authority for the row.
 * @returns {Promise<{ path: string, result: object }>}
 */
export async function writeTrialResult(campaignDir, trialId, result, opts = {}) {
  if (!campaignDir) throw new Error('writeTrialResult: campaignDir is required');
  if (!trialId) throw new Error('writeTrialResult: trialId is required');
  if (!result || typeof result !== 'object') {
    throw new Error('writeTrialResult: result is required');
  }
  if (opts.manifestTrial == null || typeof opts.manifestTrial !== 'object') {
    throw new Error(
      'writeTrialResult: complete manifestTrial identity authority is required (fail closed)',
    );
  }

  // results/ and trial dir are private; path is containment-checked
  const safeId = assertSafeTrialId(trialId);
  const campaignRoot = await assertCampaignFilesystemBoundary(campaignDir);

  // ID binding: reject swapped/mismatched ids; always force destination id.
  if (result.id != null && String(result.id) !== '') {
    if (String(result.id) !== safeId) {
      throw new Error(
        `writeTrialResult: result.id "${result.id}" !== trialId "${safeId}" (fail closed)`,
      );
    }
  }

  await ensurePrivateDir(path.join(campaignRoot, 'results'));
  const dir = await resolveTrialResultDir(campaignRoot, safeId);
  await ensurePrivateDir(dir);

  const writtenAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const digestsIn =
    result.digests && typeof result.digests === 'object'
      ? { .../** @type {Record<string, unknown>} */ (result.digests) }
      : {};
  // resultDigest is always recomputed over the final envelope below.
  delete digestsIn.resultDigest;
  // Drop null/empty digest fields so schema (string patterns) is never fed null.
  for (const key of Object.keys(digestsIn)) {
    const v = digestsIn[key];
    if (v == null || v === '') delete digestsIn[key];
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    ...result,
    id: safeId,
    // Required identity / evidence fields — stamp defaults where allowed
    experimentId:
      result.experimentId != null ? String(result.experimentId) : result.experimentId,
    arm: result.arm != null ? String(result.arm) : result.arm,
    provider: result.provider != null ? String(result.provider) : result.provider,
    taskId: result.taskId != null ? String(result.taskId) : result.taskId,
    repetition: result.repetition,
    scheduleSeed: result.scheduleSeed,
    invocationPath: result.invocationPath,
    requestedModel:
      result.requestedModel === undefined ? null : result.requestedModel,
    // Preserve null — never invent resolved from requested
    resolvedModel:
      result.resolvedModel === undefined ? null : result.resolvedModel,
    resolvedModelAvailable:
      result.resolvedModelAvailable === undefined
        ? false
        : Boolean(result.resolvedModelAvailable),
    resolvedModelSource:
      result.resolvedModelSource != null &&
      String(result.resolvedModelSource).trim() !== ''
        ? String(result.resolvedModelSource)
        : 'unavailable',
    postureFingerprint:
      result.postureFingerprint === undefined ? null : result.postureFingerprint,
    state: result.state,
    classification:
      result.classification === undefined ? null : result.classification,
    digests: digestsIn,
    schemaVersion: SCHEMA_VERSION,
    writtenAt,
  };

  // Only set gateResults when provided (stripped of secret-bearing previews).
  if (result.gateResults !== undefined) {
    payload.gateResults = stripGatePreviews(result.gateResults);
  } else {
    delete payload.gateResults;
  }

  // Drop undefined keys so schema additionalProperties/type checks see the
  // same shape JSON.stringify will persist.
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  // Manifest identity binding — always required, full frozen row, exact types.
  assertManifestIdentityBinding(
    payload,
    opts.manifestTrial,
    'writeTrialResult',
  );

  // Strict schema enforcement: required properties + additionalProperties:false.
  await assertTrialResultSchema(payload, {
    label: 'writeTrialResult',
  });

  // Canonical final-record digest after all defaults/sanitization/timestamps.
  // Covers the entire strict stored record except digests.resultDigest.
  const resultDigest = computeFinalResultDigest(payload);
  payload.digests = {
    .../** @type {Record<string, unknown>} */ (payload.digests),
    resultDigest,
  };

  // Re-validate with resultDigest stamped (still schema-legal).
  await assertTrialResultSchema(payload, {
    label: 'writeTrialResult',
  });

  const finalPath = path.join(dir, 'result.json');
  await writeFileAtomicNoFollow(
    finalPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600, fsync: true },
  );

  return { path: finalPath, result: payload };
}

/**
 * Read a previously written trial result.
 * Always enforces trial.schema.json (required + additionalProperties).
 * There is no validate opt-out.
 *
 * Physically validates the campaign boundary, then reads result.json with
 * readFileNoFollow so a pre-planted leaf symlink cannot inject host content
 * into resume/verification/reporting/export paths.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<object>}
 */
export async function readTrialResult(campaignDir, trialId) {
  if (!campaignDir) throw new Error('readTrialResult: campaignDir is required');
  if (!trialId) throw new Error('readTrialResult: trialId is required');

  const campaignRoot = await assertCampaignFilesystemBoundary(campaignDir);
  const dir = await resolveTrialResultDir(campaignRoot, trialId);
  const p = path.join(dir, 'result.json');
  const text = await readTextNoFollow(p, { maxBytes: CAMPAIGN_READ_MAX_BYTES });
  const result = JSON.parse(text);
  await assertTrialResultSchema(result, {
    label: 'readTrialResult',
  });
  return result;
}

/**
 * Remove a trial subdirectory under a campaign child root when present.
 * Containment-checked; never follows a leaf symlink as a directory root.
 * @param {string} campaignRoot
 * @param {'results' | 'raw' | 'artifacts'} kind
 * @param {string} trialId
 * @returns {Promise<boolean>} true when something was removed
 */
async function removeTrialSubdirIfPresent(campaignRoot, kind, trialId) {
  const parent = path.join(path.resolve(campaignRoot), kind);
  // trialPathUnder enforces containment (safe id + resolveUnder).
  // Do not re-check with lexical isPathInside: macOS /var vs /private/var
  // realpath normalization would false-reject valid temps.
  const target = await trialPathUnder(parent, trialId);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) {
      // Leaf symlink: unlink only (do not follow into host).
      await rm(target, { force: true });
      return true;
    }
    await rm(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Clear durable trial state (results/, raw/, artifacts/) so a re-run cannot
 * adopt stale evidence. Fail closed on boundary / unexpected FS errors.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<{ cleared: string[] }>}
 */
export async function clearTrialDurableState(campaignDir, trialId) {
  if (!campaignDir) throw new Error('clearTrialDurableState: campaignDir is required');
  if (!trialId) throw new Error('clearTrialDurableState: trialId is required');
  const safeId = assertSafeTrialId(trialId);
  const campaignRoot = await assertCampaignFilesystemBoundary(campaignDir);
  /** @type {string[]} */
  const cleared = [];
  for (const kind of /** @type {const} */ (['results', 'raw', 'artifacts'])) {
    const removed = await removeTrialSubdirIfPresent(campaignRoot, kind, safeId);
    if (removed) cleared.push(kind);
  }
  return { cleared };
}

/**
 * Terminal states a durable result may claim when adopting a crash-window write.
 */
const ADOPTABLE_RESULT_STATES = new Set(['completed', 'failed']);

/**
 * Try to adopt a verified durable result for a crash-window / resume path.
 *
 * A result is adoptable when:
 * - result.json exists and passes schema
 * - identity binds exactly to the frozen manifest trial row
 * - digests.resultDigest matches the recomputed final-record digest
 * - result.state is completed|failed
 *
 * Full raw/artifact byte re-verify is best-effort for adoption diagnostics but
 * identity + resultDigest are the hard gates (result was written only after
 * those were stamped). When rawEvidenceUnavailable is set, still adopt if
 * identity+resultDigest hold so infra-failure crash windows resume cleanly.
 *
 * @param {string} campaignDir
 * @param {object} manifestTrial frozen trial row from the campaign manifest
 * @returns {Promise<
 *   | { ok: true, result: object, state: string, classification: string | null }
 *   | { ok: false, reason: string }
 * >}
 */
export async function tryAdoptDurableTrialResult(campaignDir, manifestTrial) {
  if (!campaignDir) {
    return { ok: false, reason: 'campaignDir required' };
  }
  if (!manifestTrial || typeof manifestTrial !== 'object') {
    return { ok: false, reason: 'manifestTrial required' };
  }
  const trialId =
    manifestTrial.id != null ? String(manifestTrial.id) : '';
  if (!trialId) {
    return { ok: false, reason: 'manifestTrial.id required' };
  }

  /** @type {object} */
  let result;
  try {
    result = await readTrialResult(campaignDir, trialId);
  } catch (err) {
    return {
      ok: false,
      reason: `no durable result: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const state = result.state != null ? String(result.state) : '';
  if (!ADOPTABLE_RESULT_STATES.has(state)) {
    return {
      ok: false,
      reason: `durable result state not terminal: ${state || '(missing)'}`,
    };
  }

  const idMismatches = collectManifestIdentityMismatches(result, manifestTrial);
  if (idMismatches.length > 0) {
    return {
      ok: false,
      reason: `identity mismatch: ${idMismatches.join(', ')}`,
    };
  }

  if (!result.digests || typeof result.digests !== 'object') {
    return { ok: false, reason: 'missing digests' };
  }
  const stored = /** @type {Record<string, unknown>} */ (result.digests);
  const expectedResultDigest = computeFinalResultDigest(result);
  if (stored.resultDigest == null || stored.resultDigest === '') {
    return { ok: false, reason: 'resultDigest missing' };
  }
  if (String(stored.resultDigest) !== expectedResultDigest) {
    return { ok: false, reason: 'resultDigest mismatch' };
  }

  // Optional fixture authority when the frozen row carries it.
  if (
    manifestTrial.expectedFixtureDigest != null &&
    String(manifestTrial.expectedFixtureDigest).trim() !== ''
  ) {
    const expected = String(manifestTrial.expectedFixtureDigest);
    if (
      stored.fixtureDigest == null ||
      String(stored.fixtureDigest) !== expected
    ) {
      return { ok: false, reason: 'fixtureDigest mismatch vs frozen authority' };
    }
  }

  return {
    ok: true,
    result,
    state,
    classification:
      result.classification != null ? String(result.classification) : null,
  };
}

/**
 * Read a private campaign raw file if present; return null when absent.
 * Never follows leaf symlinks (fail closed with UnsafePathError).
 * @param {string} filePath
 * @returns {Promise<Buffer | null>}
 */
async function readOptionalBuffer(filePath) {
  try {
    return await readFileNoFollow(filePath, {
      maxBytes: CAMPAIGN_READ_MAX_BYTES,
    });
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Compute sha256 digests of on-disk raw provider output bytes under raw/<trialId>/.
 * Hashes exact file bytes (not lengths).
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<{
 *   rawStdoutSha256: string | null,
 *   rawStderrSha256: string | null,
 *   rawOutputFileSha256: string | null,
 *   rawOutputDigest: string,
 *   hasStdout: boolean,
 *   hasStderr: boolean,
 *   hasOutput: boolean,
 * }>}
 */
export async function computeRawOutputDigests(campaignDir, trialId) {
  const dir = await resolveTrialRawDir(campaignDir, trialId);
  const stdoutBuf = await readOptionalBuffer(path.join(dir, 'stdout.txt'));
  const stderrBuf = await readOptionalBuffer(path.join(dir, 'stderr.txt'));
  // Prefer output.json; if missing, no output file digest.
  const outputBuf = await readOptionalBuffer(path.join(dir, 'output.json'));

  const rawStdoutSha256 = stdoutBuf != null ? sha256Buffer(stdoutBuf) : null;
  const rawStderrSha256 = stderrBuf != null ? sha256Buffer(stderrBuf) : null;
  const rawOutputFileSha256 = outputBuf != null ? sha256Buffer(outputBuf) : null;

  const rawOutputDigest = digestRawOutputBytes({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    output: outputBuf,
  });

  return {
    rawStdoutSha256,
    rawStderrSha256,
    rawOutputFileSha256,
    rawOutputDigest,
    hasStdout: stdoutBuf != null,
    hasStderr: stderrBuf != null,
    hasOutput: outputBuf != null,
  };
}

/**
 * Quarantine raw provider output under campaign/raw/<trialId>/ (0700 / 0600).
 * Returns digests of the exact on-disk bytes written.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} raw
 * @param {string | Buffer} [raw.stdout]
 * @param {string | Buffer} [raw.stderr]
 * @param {string} [raw.outputPath]
 * @param {unknown} [raw.meta]
 * @returns {Promise<{
 *   path: string,
 *   digests: {
 *     rawStdoutSha256: string | null,
 *     rawStderrSha256: string | null,
 *     rawOutputFileSha256: string | null,
 *     rawOutputDigest: string,
 *   },
 * }>}
 */
export async function quarantineRawOutput(campaignDir, trialId, raw = {}) {
  if (!campaignDir) throw new Error('quarantineRawOutput: campaignDir is required');
  if (!trialId) throw new Error('quarantineRawOutput: trialId is required');

  // Ensure raw root is private; path is containment-checked
  const safeId = assertSafeTrialId(trialId);
  const campaignRoot = await assertCampaignFilesystemBoundary(campaignDir);
  const rawRoot = path.join(campaignRoot, 'raw');
  await ensurePrivateDir(rawRoot);

  const dir = await resolveTrialRawDir(campaignRoot, safeId);
  await ensurePrivateDir(dir);

  // Always materialize stdout/stderr files (empty allowed) so digests are complete.
  {
    const data =
      raw.stdout == null
        ? ''
        : typeof raw.stdout === 'string' || Buffer.isBuffer(raw.stdout)
          ? raw.stdout
          : String(raw.stdout);
    await writePrivateFile(path.join(dir, 'stdout.txt'), data);
  }
  {
    const data =
      raw.stderr == null
        ? ''
        : typeof raw.stderr === 'string' || Buffer.isBuffer(raw.stderr)
          ? raw.stderr
          : String(raw.stderr);
    await writePrivateFile(path.join(dir, 'stderr.txt'), data);
  }

  if (raw.outputPath) {
    try {
      const dest = path.join(dir, 'output.json');
      // Never follow a provider-swapped symlink to host content (src or dest).
      await copyFileNoFollow(String(raw.outputPath), dest);
    } catch (err) {
      const note =
        err instanceof UnsafePathError
          ? `source refused (unsafe path / symlink): ${err.code}\n`
          : 'source not copied (path omitted from quarantine metadata)\n';
      await writePrivateFile(path.join(dir, 'output-missing.txt'), note);
    }
  }

  // Digests of exact on-disk bytes (not lengths, not in-memory strings alone).
  const digests = await computeRawOutputDigests(campaignRoot, safeId);

  const meta = {
    trialId: String(safeId),
    quarantinedAt: new Date().toISOString(),
    warning:
      'SECRET-BEARING: raw provider output. Do not commit or include in sanitized export by default.',
    hasStdout: digests.hasStdout,
    hasStderr: digests.hasStderr,
    hasOutputPath: Boolean(raw.outputPath),
    digests: {
      rawStdoutSha256: digests.rawStdoutSha256,
      rawStderrSha256: digests.rawStderrSha256,
      rawOutputFileSha256: digests.rawOutputFileSha256,
      rawOutputDigest: digests.rawOutputDigest,
    },
    // Do not embed absolute source paths
    ...(raw.meta && typeof raw.meta === 'object' && !('path' in /** @type {object} */ (raw.meta))
      ? { extra: raw.meta }
      : {}),
  };
  await writePrivateFile(
    path.join(dir, 'meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  return {
    path: dir,
    digests: {
      rawStdoutSha256: digests.rawStdoutSha256,
      rawStderrSha256: digests.rawStderrSha256,
      rawOutputFileSha256: digests.rawOutputFileSha256,
      rawOutputDigest: digests.rawOutputDigest,
    },
  };
}

/**
 * Recompute artifact-dir digest when the directory exists.
 * @param {string} artifactDir
 * @returns {Promise<string | null>}
 */
export async function computeArtifactDigest(artifactDir) {
  if (artifactDir == null || String(artifactDir).trim() === '') return null;
  try {
    await access(artifactDir);
  } catch {
    return null;
  }
  return digestArtifactDir(artifactDir);
}

/**
 * Build the canonical final-record envelope for resultDigest.
 *
 * Covers the **entire** strict stored record except digests.resultDigest
 * itself (deterministic via sha256Json/canonicalize). Schema-enforced
 * writers ensure only declared exportable fields are present; rawEvidenceUnavailable
 * and every other digests/identity/timing field are included when set.
 *
 * @param {object} result - full trial result after defaults/sanitization
 * @returns {object}
 */
export function buildFinalResultEnvelope(result) {
  const r =
    result && typeof result === 'object' && !Array.isArray(result)
      ? /** @type {Record<string, unknown>} */ (result)
      : {};
  /** @type {Record<string, unknown>} */
  const digestsIn =
    r.digests && typeof r.digests === 'object' && !Array.isArray(r.digests)
      ? { .../** @type {Record<string, unknown>} */ (r.digests) }
      : {};
  delete digestsIn.resultDigest;

  /** @type {Record<string, unknown>} */
  const envelope = { ...r, digests: digestsIn };
  // Drop undefined so digest matches JSON-persisted shape.
  for (const key of Object.keys(envelope)) {
    if (envelope[key] === undefined) delete envelope[key];
  }
  return envelope;
}

/**
 * Canonical final-record resultDigest (complete stored envelope).
 * @param {object} result
 * @returns {string}
 */
export function computeFinalResultDigest(result) {
  return sha256Json(buildFinalResultEnvelope(result));
}

/**
 * @deprecated Prefer computeFinalResultDigest over the complete stored result.
 * Kept for call-site migration; now digests the same final envelope when given
 * a full result, or a minimal classification/gates/exit envelope for tests.
 *
 * @param {object} parts
 * @returns {string}
 */
export function computeResultDigest(parts = {}) {
  // If caller already has a written-shaped result, use full envelope.
  if (
    parts &&
    typeof parts === 'object' &&
    (parts.writtenAt != null ||
      parts.schemaVersion != null ||
      parts.id != null ||
      parts.digests != null)
  ) {
    return computeFinalResultDigest(parts);
  }
  // Minimal legacy path (tests that only pass classification/gates/exit):
  // still produce a stable digest via the final envelope shape.
  return computeFinalResultDigest({
    classification: parts.classification ?? null,
    gateResults: parts.gateResults ?? [],
    exitCode: parts.exitCode ?? null,
    digests: {},
  });
}

/**
 * True when digests declare raw evidence unavailable (truncation, missing raw,
 * spawn failure, etc.). Independent of classification — a mislabeled PASS with
 * this flag is still non-reportable.
 *
 * @param {object} result
 * @returns {boolean}
 */
export function hasRawEvidenceUnavailableFlag(result) {
  if (!result || typeof result !== 'object') return false;
  const d = result.digests;
  if (!d || typeof d !== 'object') return false;
  return d.rawEvidenceUnavailable === true;
}

/**
 * Whether a stored result is an explicit infra-failure without raw artifacts.
 * Such records are "unavailable" for reportability — never silently verified.
 *
 * Prefer hasRawEvidenceUnavailableFlag / isUnavailableForReport for
 * reportability gates: those check the digest flag directly so a misleading
 * classification cannot take a missing-digest route instead of unavailability.
 *
 * @param {object} result
 * @returns {boolean}
 */
export function isInfraFailureWithoutRawEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.classification !== 'INFRA_FAIL') return false;
  return hasRawEvidenceUnavailableFlag(result);
}

/**
 * True when a result must not enter benchmark reports/summaries/exports.
 * Fail-closed on digests.rawEvidenceUnavailable true, independent of
 * classification (PASS/FAIL/NO_OP mislabels included).
 *
 * @param {object} result
 * @returns {boolean}
 */
export function isUnavailableForReport(result) {
  if (!result || typeof result !== 'object') return true;
  // Direct fail-closed: the digest flag alone makes a record non-reportable.
  if (hasRawEvidenceUnavailableFlag(result)) return true;
  if (result.evidenceUnavailable === true) return true;
  return false;
}

/**
 * Extract versioned, neutral invocation protocol evidence from an invoker result.
 *
 * outcomeKind / reasonCode are bounded identifiers only (never free-form text).
 * Transport exitCode is intentionally excluded — callers persist it separately.
 *
 * For poetic-adapter, stamps protocolSchema + protocolEvidenceVersion whenever
 * any bounded protocol field is present. Non-adapter paths may carry bounded
 * fields without claiming the poetic result schema.
 *
 * @param {string} invocationPath
 * @param {object | null | undefined} invokerResult
 * @returns {{
 *   outcomeKind?: string | null,
 *   reasonCode?: string | null,
 *   protocolEvidenceVersion?: number | null,
 *   protocolSchema?: string | null,
 * }}
 */
export function extractProtocolEvidence(invocationPath, invokerResult) {
  const r =
    invokerResult && typeof invokerResult === 'object'
      ? /** @type {Record<string, unknown>} */ (invokerResult)
      : {};
  const outcomeKind = sanitizeBoundedIdentifier(r.outcomeKind);
  const reasonCode = sanitizeBoundedIdentifier(r.reasonCode);
  const hasAny = outcomeKind != null || reasonCode != null;

  if (invocationPath === 'poetic-adapter') {
    if (!hasAny) {
      // No parse-bound protocol fields (e.g. spawn failed before artifact).
      // Leave absent rather than inventing SUCCESS / empty schema claims.
      return {};
    }
    return {
      outcomeKind,
      reasonCode,
      protocolEvidenceVersion: PROTOCOL_EVIDENCE_VERSION,
      protocolSchema: PROTOCOL_SCHEMA_POETIC_INVOKE_RESULT_V1,
    };
  }

  if (!hasAny) return {};
  return {
    outcomeKind,
    reasonCode,
    protocolEvidenceVersion: PROTOCOL_EVIDENCE_VERSION,
    // Non-adapter paths do not claim the poetic invoke result schema.
    protocolSchema: null,
  };
}

/**
 * Whether a stored result claims reportable poetic-adapter protocol evidence.
 * Raw-unavailable / non-adapter records do not claim it (back-compat soft path).
 *
 * @param {object} result
 * @returns {boolean}
 */
export function claimsPoeticAdapterProtocolEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.invocationPath !== 'poetic-adapter') return false;
  // Explicit unavailability: not reportable, no protocol requirement.
  if (hasRawEvidenceUnavailableFlag(result)) return false;
  if (isUnavailableForReport(result)) return false;
  return true;
}

/**
 * Collect protocol-evidence issues for reportable poetic-adapter records.
 * Fail closed: missing/invalid outcomeKind, reasonCode, version, or schema.
 * Older records without protocol fields fail when they claim reportable
 * poetic-adapter evidence (raw digests present, rawEvidenceUnavailable absent).
 * Non-adapter and unavailable records return no issues (existing contract).
 *
 * @param {object} result
 * @returns {string[]}
 */
export function collectProtocolEvidenceIssues(result) {
  if (!claimsPoeticAdapterProtocolEvidence(result)) return [];
  /** @type {string[]} */
  const issues = [];
  if (result.protocolEvidenceVersion !== PROTOCOL_EVIDENCE_VERSION) {
    issues.push('protocolEvidenceVersion');
  }
  if (result.protocolSchema !== PROTOCOL_SCHEMA_POETIC_INVOKE_RESULT_V1) {
    issues.push('protocolSchema');
  }
  if (!isBoundedIdentifier(result.outcomeKind)) {
    issues.push('outcomeKind');
  }
  if (!isBoundedIdentifier(result.reasonCode)) {
    issues.push('reasonCode');
  }
  return issues;
}

/**
 * Verify stored trial digests match on-disk raw + campaign artifacts bytes.
 * Fail closed on mismatch, schema violation, or identity binding failure.
 * Never trusts result.artifactDir — always digests campaignDir/artifacts/<trialId>.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} [storedResult] - result object with digests; loaded if omitted
 * @param {{
 *   expectedFixtureDigest?: string | null,
 *   requireFixtureAuthority?: boolean,
 *   requireFixtureDigest?: boolean,
 *   manifestTrial: object,
 * }} opts
 *   manifestTrial is required: complete frozen identity authority.
 * @returns {Promise<{
 *   ok: boolean,
 *   trialId: string,
 *   mismatches: string[],
 *   error?: string,
 *   recomputed?: object,
 *   unavailable?: boolean,
 *   reportable?: boolean,
 * }>}
 */
export async function verifyTrialEvidenceDigests(
  campaignDir,
  trialId,
  storedResult,
  opts = {},
) {
  const safeId = assertSafeTrialId(trialId);
  /** @type {object} */
  let result = storedResult;
  if (result == null) {
    try {
      result = await readTrialResult(campaignDir, safeId);
    } catch (err) {
      return {
        ok: false,
        trialId: safeId,
        mismatches: ['result'],
        unavailable: false,
        error: `result unreadable for evidence verify: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Schema enforcement: required properties + unknown fields fail closed.
  try {
    await assertTrialResultSchema(result, {
      label: 'verifyTrialEvidenceDigests',
    });
  } catch (err) {
    return {
      ok: false,
      trialId: safeId,
      mismatches: ['schema'],
      unavailable: false,
      reportable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Manifest identity binding is always required (complete frozen row).
  if (opts.manifestTrial == null || typeof opts.manifestTrial !== 'object') {
    return {
      ok: false,
      trialId: safeId,
      mismatches: ['manifestTrial'],
      unavailable: false,
      reportable: false,
      error: 'manifest trial identity authority missing (fail closed)',
    };
  }
  const idMismatches = collectManifestIdentityMismatches(
    result,
    opts.manifestTrial,
  );
  if (idMismatches.length > 0) {
    return {
      ok: false,
      trialId: safeId,
      mismatches: idMismatches.map((f) => `identity:${f}`),
      unavailable: false,
      reportable: false,
      error: `manifest identity mismatch (fail closed): ${idMismatches.join(', ')}`,
    };
  }

  if (!result.digests || typeof result.digests !== 'object') {
    return {
      ok: false,
      trialId: safeId,
      mismatches: ['digests'],
      unavailable: false,
      error: 'missing digests object (fail closed)',
    };
  }

  const stored = /** @type {Record<string, unknown>} */ (result.digests);

  /** @type {string[]} */
  const mismatches = [];
  /** @type {Record<string, unknown>} */
  const recomputed = {};

  // Always recompute final-record resultDigest over the complete stored envelope.
  const expectedResultDigest = computeFinalResultDigest(result);
  recomputed.resultDigest = expectedResultDigest;
  if (stored.resultDigest == null || stored.resultDigest === '') {
    mismatches.push('resultDigest-missing');
  } else if (String(stored.resultDigest) !== expectedResultDigest) {
    mismatches.push('resultDigest');
  }

  // Fixture digest vs independent frozen authority (manifest trial metadata).
  // Never merely compare two fields inside the same result.
  const expectedFixture =
    opts.expectedFixtureDigest != null &&
    String(opts.expectedFixtureDigest).trim() !== ''
      ? String(opts.expectedFixtureDigest)
      : null;
  if (expectedFixture) {
    recomputed.expectedFixtureDigest = expectedFixture;
    if (stored.fixtureDigest == null || stored.fixtureDigest === '') {
      mismatches.push('fixtureDigest-missing');
    } else if (String(stored.fixtureDigest) !== expectedFixture) {
      mismatches.push('fixtureDigest');
    }
  } else if (
    opts.requireFixtureAuthority === true &&
    !hasRawEvidenceUnavailableFlag(result)
  ) {
    mismatches.push('expectedFixtureDigest-missing');
  }

  // Explicit raw-unavailable path: must not count as verified/reportable.
  // Keyed on digests.rawEvidenceUnavailable alone — independent of
  // classification and of any coexisting integrity mismatches. Mismatches may
  // still be retained for diagnostics, but unavailable stays true and
  // reportable stays false (never unavailable:false for a raw-unavailable record).
  if (hasRawEvidenceUnavailableFlag(result)) {
    return {
      ok: false,
      trialId: safeId,
      mismatches,
      unavailable: true,
      reportable: false,
      recomputed,
      error:
        mismatches.length > 0
          ? `raw evidence unavailable with integrity failures (fail closed): ${mismatches.join(', ')}`
          : 'raw evidence unavailable (unavailable; not verified/reportable)',
    };
  }

  // Reportable poetic-adapter evidence requires versioned neutral protocol fields.
  // Transport exitCode is not a substitute. Older records without these fields
  // fail closed when they claim reportable adapter evidence.
  const protocolIssues = collectProtocolEvidenceIssues(result);
  if (protocolIssues.length > 0) {
    mismatches.push(...protocolIssues.map((f) => `protocol:${f}`));
    return {
      ok: false,
      trialId: safeId,
      mismatches,
      unavailable: false,
      reportable: false,
      recomputed,
      error: `poetic-adapter protocol evidence missing or invalid (fail closed): ${protocolIssues.join(', ')}`,
    };
  }

  // Reportable completed/failed trials require full result + raw + artifact bindings.
  for (const key of [
    'rawOutputDigest',
    'rawStdoutSha256',
    'rawStderrSha256',
    'artifactDigest',
  ]) {
    if (stored[key] == null || stored[key] === '') {
      mismatches.push(`${key}-missing`);
    }
  }
  // fixtureDigest required when an independent frozen authority is provided;
  // real campaigns always stamp expectedFixtureDigest on trial metadata.
  if (expectedFixture) {
    /* already checked above against authority */
  } else if (stored.fixtureDigest == null || stored.fixtureDigest === '') {
    // Soft-require when no authority: still prefer presence for reportable trials.
    // Hard-require only when opts.requireFixtureDigest === true (run/export paths).
    if (opts.requireFixtureDigest === true) {
      mismatches.push('fixtureDigest-missing');
    }
  }

  // Raw output bytes under campaign/raw/<trialId>/
  let rawDigests;
  try {
    rawDigests = await computeRawOutputDigests(campaignDir, safeId);
  } catch (err) {
    return {
      ok: false,
      trialId: safeId,
      mismatches: [...mismatches, 'raw'],
      unavailable: false,
      error: `raw digests unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  recomputed.rawOutputDigest = rawDigests.rawOutputDigest;
  recomputed.rawStdoutSha256 = rawDigests.rawStdoutSha256;
  recomputed.rawStderrSha256 = rawDigests.rawStderrSha256;
  recomputed.rawOutputFileSha256 = rawDigests.rawOutputFileSha256;

  if (
    stored.rawOutputDigest != null &&
    stored.rawOutputDigest !== rawDigests.rawOutputDigest
  ) {
    mismatches.push('rawOutputDigest');
  }
  if (
    stored.rawStdoutSha256 != null &&
    stored.rawStdoutSha256 !== rawDigests.rawStdoutSha256
  ) {
    mismatches.push('rawStdoutSha256');
  }
  if (
    stored.rawStderrSha256 != null &&
    stored.rawStderrSha256 !== rawDigests.rawStderrSha256
  ) {
    mismatches.push('rawStderrSha256');
  }
  if (
    stored.rawOutputFileSha256 != null &&
    stored.rawOutputFileSha256 !== rawDigests.rawOutputFileSha256
  ) {
    mismatches.push('rawOutputFileSha256');
  }

  // Artifact digest: ONLY campaignDir/artifacts/<trialId> (containment-checked).
  // Never trust result.artifactDir or any caller-supplied external path.
  let artifactDir = null;
  try {
    artifactDir = await resolveTrialArtifactDir(campaignDir, safeId);
    recomputed.artifactDir = artifactDir;
  } catch (err) {
    mismatches.push('artifactDir');
    recomputed.artifactDirError =
      err instanceof Error ? err.message : String(err);
  }
  if (!artifactDir) {
    mismatches.push('artifactDir-missing');
  } else {
    try {
      const art = await computeArtifactDigest(artifactDir);
      recomputed.artifactDigest = art;
      if (art == null) {
        mismatches.push('artifactDigest-unavailable');
      } else if (
        stored.artifactDigest != null &&
        stored.artifactDigest !== art
      ) {
        mismatches.push('artifactDigest');
      } else if (stored.artifactDigest == null || stored.artifactDigest === '') {
        mismatches.push('artifactDigest-missing');
      }
    } catch (err) {
      mismatches.push('artifactDigest');
      recomputed.artifactDigestError =
        err instanceof Error ? err.message : String(err);
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      trialId: safeId,
      mismatches,
      unavailable: false,
      reportable: false,
      recomputed,
      error: `evidence digest mismatch (fail closed): ${mismatches.join(', ')}`,
    };
  }

  return {
    ok: true,
    trialId: safeId,
    mismatches: [],
    unavailable: false,
    reportable: true,
    recomputed,
  };
}

/**
 * Verify evidence digests for all completed/failed trials before report/export.
 * Fail closed on mismatch, missing result, or unavailable records when
 * `failOnUnavailable` is true (default for report/export/summary paths).
 *
 * @param {string} campaignDir
 * @param {object[]} trials - manifest trials (need id + state; optional expectedFixtureDigest)
 * @param {object[]} [trialResults] - optional preloaded results
 * @param {{ failOnUnavailable?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   verified: number,
 *   skipped: number,
 *   unavailable: number,
 *   reportableResults: object[],
 *   failures: Array<{ trialId: string, error: string, mismatches: string[] }>,
 *   error?: string,
 * }>}
 */
export async function verifyCampaignEvidenceDigests(
  campaignDir,
  trials,
  trialResults,
  opts = {},
) {
  const failOnUnavailable = opts.failOnUnavailable !== false;

  if (!campaignDir) {
    return {
      ok: false,
      verified: 0,
      skipped: 0,
      unavailable: 0,
      reportableResults: [],
      failures: [],
      error: 'campaignDir is required for evidence verify',
    };
  }

  /** @type {Map<string, object>} */
  const byId = new Map();
  if (Array.isArray(trialResults)) {
    for (const r of trialResults) {
      if (r && typeof r === 'object' && r.id != null) {
        byId.set(String(r.id), r);
      }
    }
  }

  /** @type {Map<string, object>} */
  const trialMetaById = new Map();
  for (const t of trials || []) {
    if (t && typeof t === 'object' && t.id != null) {
      trialMetaById.set(String(t.id), t);
    }
  }

  let verified = 0;
  let skipped = 0;
  let unavailable = 0;
  /** @type {object[]} */
  const reportableResults = [];
  /** @type {Array<{ trialId: string, error: string, mismatches: string[] }>} */
  const failures = [];

  for (const t of trials || []) {
    if (!t || typeof t !== 'object') continue;
    const state = t.state;
    if (state !== 'completed' && state !== 'failed') {
      skipped += 1;
      continue;
    }
    const id = String(t.id);
    let result = byId.get(id);
    if (!result) {
      try {
        result = await readTrialResult(campaignDir, id);
      } catch {
        // Completed/failed without a result file: fail closed (not silent skip).
        failures.push({
          trialId: id,
          error: 'missing result file for completed/failed trial (fail closed)',
          mismatches: ['result'],
        });
        continue;
      }
    }

    const digests = result.digests;
    if (!digests || typeof digests !== 'object') {
      failures.push({
        trialId: id,
        error: 'missing digests for completed/failed trial (fail closed)',
        mismatches: ['digests'],
      });
      continue;
    }

    const meta = trialMetaById.get(id) || t;
    const expectedFixtureDigest =
      meta.expectedFixtureDigest != null
        ? String(meta.expectedFixtureDigest)
        : null;

    // Pass frozen manifest row for identity binding; artifact path is derived
    // only as campaignDir/artifacts/<trialId> inside verify (never result.artifactDir).
    const v = await verifyTrialEvidenceDigests(campaignDir, id, result, {
      expectedFixtureDigest,
      requireFixtureAuthority: Boolean(expectedFixtureDigest),
      manifestTrial: meta,
    });
    if (v.unavailable || isUnavailableForReport(result)) {
      // rawEvidenceUnavailable (any classification) — not verified, not reportable.
      unavailable += 1;
      if (failOnUnavailable) {
        failures.push({
          trialId: id,
          error:
            v.error ||
            'unavailable evidence (not reportable; fail closed for report path)',
          mismatches: v.mismatches?.length
            ? v.mismatches
            : ['unavailable'],
        });
      }
      continue;
    }
    if (!v.ok) {
      failures.push({
        trialId: id,
        error: v.error || 'evidence mismatch',
        mismatches: v.mismatches,
      });
      continue;
    }
    verified += 1;
    reportableResults.push(result);
  }

  if (failures.length > 0) {
    return {
      ok: false,
      verified,
      skipped,
      unavailable,
      reportableResults,
      failures,
      error: `evidence integrity failed for ${failures.length} trial(s): ${failures
        .map((f) => `${f.trialId}(${f.mismatches.join(',')})`)
        .join('; ')}`,
    };
  }

  return {
    ok: true,
    verified,
    skipped,
    unavailable,
    reportableResults,
    failures: [],
  };
}

/**
 * Build trial digests object from components (canonical field names).
 *
 * @param {object} parts
 * @param {string} [parts.resultDigest]
 * @param {string | null} [parts.artifactDigest]
 * @param {string | null} [parts.fixtureDigest]
 * @param {string | null} [parts.rawOutputDigest]
 * @param {string | null} [parts.rawStdoutSha256]
 * @param {string | null} [parts.rawStderrSha256]
 * @param {string | null} [parts.rawOutputFileSha256]
 * @returns {Record<string, string>}
 */
export function buildTrialDigests(parts = {}) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (const key of [
    'resultDigest',
    'artifactDigest',
    'fixtureDigest',
    'rawOutputDigest',
    'rawStdoutSha256',
    'rawStderrSha256',
    'rawOutputFileSha256',
  ]) {
    const v = /** @type {Record<string, unknown>} */ (parts)[key];
    if (v != null && v !== '') {
      out[key] = String(v);
    }
  }
  if (parts.rawEvidenceUnavailable === true) {
    out.rawEvidenceUnavailable = true;
  }
  return out;
}

// Re-export helpers used by run for resultDigest construction convenience.
export { sha256Json, sha256Buffer };
