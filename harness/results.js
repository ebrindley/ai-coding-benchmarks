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
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from './contracts.js';
import { assertSafeTrialId, trialPathUnder } from './paths.js';
import {
  sha256Buffer,
  sha256Json,
  digestArtifactDir,
  digestRawOutputBytes,
} from './digest.js';
import { copyFileNoFollow, UnsafePathError } from './safe-fs.js';

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
 * Best-effort chmod; ignore failures on platforms that lack mode bits.
 * @param {string} p
 * @param {number} mode
 */
async function tryChmod(p, mode) {
  try {
    await chmod(p, mode);
  } catch {
    /* ignore */
  }
}

/**
 * Ensure a private directory (0700).
 * @param {string} dir
 */
export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tryChmod(dir, 0o700);
}

/**
 * Write a private file (0600).
 * @param {string} filePath
 * @param {string | Buffer} data
 */
export async function writePrivateFile(filePath, data) {
  await writeFile(filePath, data, { mode: 0o600 });
  await tryChmod(filePath, 0o600);
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
 * After defaults/sanitization/timestamps, computes the canonical final-record
 * resultDigest over the complete stored envelope (excluding resultDigest itself).
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} result trial-shaped result payload
 * @returns {Promise<{ path: string, result: object }>}
 */
export async function writeTrialResult(campaignDir, trialId, result) {
  if (!campaignDir) throw new Error('writeTrialResult: campaignDir is required');
  if (!trialId) throw new Error('writeTrialResult: trialId is required');
  if (!result || typeof result !== 'object') {
    throw new Error('writeTrialResult: result is required');
  }

  // results/ and trial dir are private; path is containment-checked
  const safeId = assertSafeTrialId(trialId);
  await ensurePrivateDir(path.join(path.resolve(campaignDir), 'results'));
  const dir = await resolveTrialResultDir(campaignDir, safeId);
  await ensurePrivateDir(dir);

  const writtenAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const digestsIn =
    result.digests && typeof result.digests === 'object'
      ? { .../** @type {Record<string, unknown>} */ (result.digests) }
      : {};
  // resultDigest is always recomputed over the final envelope below.
  delete digestsIn.resultDigest;

  const payload = {
    ...result,
    id: result.id ?? safeId,
    classification: result.classification ?? null,
    digests: digestsIn,
    gateResults: stripGatePreviews(result.gateResults) ?? undefined,
    requestedModel: result.requestedModel ?? null,
    // Preserve null — never invent resolved from requested
    resolvedModel:
      result.resolvedModel === undefined ? null : result.resolvedModel,
    postureFingerprint: result.postureFingerprint ?? null,
    invocationPath: result.invocationPath ?? null,
    schemaVersion: SCHEMA_VERSION,
    writtenAt,
  };

  // Canonical final-record digest after all defaults/sanitization/timestamps.
  const resultDigest = computeFinalResultDigest(payload);
  payload.digests = {
    .../** @type {Record<string, unknown>} */ (payload.digests),
    resultDigest,
  };

  const finalPath = path.join(dir, 'result.json');
  const tmpPath = path.join(dir, 'result.json.tmp');
  await writePrivateFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmpPath, finalPath);
  await tryChmod(finalPath, 0o600);

  return { path: finalPath, result: payload };
}

/**
 * Read a previously written trial result.
 * @param {string} campaignDir
 * @param {string} trialId
 * @returns {Promise<object>}
 */
export async function readTrialResult(campaignDir, trialId) {
  if (!campaignDir) throw new Error('readTrialResult: campaignDir is required');
  if (!trialId) throw new Error('readTrialResult: trialId is required');

  const dir = await resolveTrialResultDir(campaignDir, trialId);
  const p = path.join(dir, 'result.json');
  const text = await readFile(p, 'utf8');
  return JSON.parse(text);
}

/**
 * Read a private raw file if present; return null when absent.
 * @param {string} filePath
 * @returns {Promise<Buffer | null>}
 */
async function readOptionalBuffer(filePath) {
  try {
    return await readFile(filePath);
  } catch (err) {
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
  const rawRoot = path.join(path.resolve(campaignDir), 'raw');
  await ensurePrivateDir(rawRoot);

  const dir = await resolveTrialRawDir(campaignDir, safeId);
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
      // Never follow a provider-swapped symlink to host content.
      await copyFileNoFollow(String(raw.outputPath), dest);
      await tryChmod(dest, 0o600);
    } catch (err) {
      const note =
        err instanceof UnsafePathError
          ? `source refused (unsafe path / symlink): ${err.code}\n`
          : 'source not copied (path omitted from quarantine metadata)\n';
      await writePrivateFile(path.join(dir, 'output-missing.txt'), note);
    }
  }

  // Digests of exact on-disk bytes (not lengths, not in-memory strings alone).
  const digests = await computeRawOutputDigests(campaignDir, safeId);

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
 * Verify stored trial digests match on-disk raw (and optional artifact) bytes.
 * Fail closed on mismatch — never trust tampered evidence.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {object} [storedResult] - result object with digests; loaded if omitted
 * @param {{ artifactDir?: string | null }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   trialId: string,
 *   mismatches: string[],
 *   error?: string,
 *   recomputed?: object,
 * }>}
 */
/**
 * Build the canonical final-record envelope for resultDigest.
 * Includes identity, model evidence, posture, state/classification, gates,
 * timing/exit, hashes, retained paths, and all evidence digests except
 * resultDigest itself. writtenAt/schemaVersion are included so the digest
 * binds the complete stored record.
 *
 * @param {object} result - full trial result after defaults/sanitization
 * @returns {object}
 */
export function buildFinalResultEnvelope(result) {
  const r = result && typeof result === 'object' ? result : {};
  /** @type {Record<string, unknown>} */
  const digestsIn =
    r.digests && typeof r.digests === 'object'
      ? { .../** @type {Record<string, unknown>} */ (r.digests) }
      : {};
  delete digestsIn.resultDigest;

  return {
    id: r.id ?? null,
    experimentId: r.experimentId ?? null,
    arm: r.arm ?? null,
    provider: r.provider ?? null,
    taskId: r.taskId ?? null,
    repetition: r.repetition ?? null,
    scheduleSeed: r.scheduleSeed ?? null,
    invocationPath: r.invocationPath ?? null,
    requestedModel: r.requestedModel ?? null,
    resolvedModel: r.resolvedModel === undefined ? null : r.resolvedModel,
    resolvedModelAvailable: r.resolvedModelAvailable ?? false,
    resolvedModelSource: r.resolvedModelSource ?? null,
    postureFingerprint: r.postureFingerprint ?? null,
    state: r.state ?? null,
    classification: r.classification ?? null,
    classificationReason: r.classificationReason ?? null,
    gateResults: r.gateResults ?? [],
    changedFileCount: r.changedFileCount ?? null,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    durationMs: r.durationMs ?? null,
    exitCode: r.exitCode ?? null,
    hashes: r.hashes ?? null,
    workspaceDir: r.workspaceDir ?? null,
    artifactDir: r.artifactDir ?? null,
    executionRoot: r.executionRoot ?? null,
    error: r.error ?? null,
    digests: digestsIn,
    schemaVersion: r.schemaVersion ?? null,
    writtenAt: r.writtenAt ?? null,
  };
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
 * Whether a stored result is an explicit infra-failure without raw artifacts.
 * Such records are "unavailable" for reportability — never silently verified.
 *
 * @param {object} result
 * @returns {boolean}
 */
export function isInfraFailureWithoutRawEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.classification !== 'INFRA_FAIL') return false;
  const d = result.digests;
  if (!d || typeof d !== 'object') return false;
  return d.rawEvidenceUnavailable === true;
}

/**
 * True when a result must not enter benchmark reports/summaries/exports.
 * @param {object} result
 * @returns {boolean}
 */
export function isUnavailableForReport(result) {
  if (!result || typeof result !== 'object') return true;
  if (isInfraFailureWithoutRawEvidence(result)) return true;
  if (result.evidenceUnavailable === true) return true;
  return false;
}

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
    !isInfraFailureWithoutRawEvidence(result)
  ) {
    mismatches.push('expectedFixtureDigest-missing');
  }

  // Explicit infra-without-raw path: must not count as verified/reportable.
  if (isInfraFailureWithoutRawEvidence(result)) {
    if (mismatches.length > 0) {
      return {
        ok: false,
        trialId: safeId,
        mismatches,
        unavailable: false,
        reportable: false,
        recomputed,
        error: `infra-failure evidence integrity failed (fail closed): ${mismatches.join(', ')}`,
      };
    }
    return {
      ok: false,
      trialId: safeId,
      mismatches: [],
      unavailable: true,
      reportable: false,
      recomputed,
      error:
        'infra-failure without raw artifacts (unavailable; not verified/reportable)',
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

  // Artifact digest is required for reportable trials (cannot skip by deleting key).
  const artifactDir =
    opts.artifactDir ??
    (typeof result.artifactDir === 'string' ? result.artifactDir : null);
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

    const v = await verifyTrialEvidenceDigests(campaignDir, id, result, {
      expectedFixtureDigest,
      requireFixtureAuthority: Boolean(expectedFixtureDigest),
      artifactDir:
        typeof result.artifactDir === 'string' ? result.artifactDir : null,
    });
    if (v.unavailable || isUnavailableForReport(result)) {
      // Explicit INFRA_FAIL without raw — not verified, not reportable.
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
