/**
 * Path confinement helpers for corpus, fixture, oracle, workspace, and artifact roots.
 * Rejects traversal (`..`), absolute escape, and symlink escape outside a declared root.
 */

import { realpath, lstat, access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Error thrown when a candidate path escapes its declared root.
 */
export class PathEscapeError extends Error {
  /**
   * @param {string} message
   * @param {{ root?: string, candidate?: string, code?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'PathEscapeError';
    this.root = details.root;
    this.candidate = details.candidate;
    this.code = details.code ?? 'PATH_ESCAPE';
  }
}

/**
 * @param {string} root
 * @returns {string}
 */
function normalizeRoot(root) {
  if (root == null || String(root).trim() === '') {
    throw new PathEscapeError('root path is required', { code: 'ROOT_REQUIRED' });
  }
  return path.resolve(String(root));
}

/**
 * True when candidate is the root itself or a path strictly under root.
 * Uses separator-aware prefix matching so `/tmp/foo` does not match `/tmp/foobar`.
 *
 * @param {string} rootAbs
 * @param {string} candidateAbs
 * @returns {boolean}
 */
export function isPathInside(rootAbs, candidateAbs) {
  const root = path.resolve(rootAbs);
  const candidate = path.resolve(candidateAbs);
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolve realpath of an existing path, or of the deepest existing ancestor
 * joined with remaining segments when the full path does not yet exist.
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function realpathExisting(absPath) {
  try {
    return await realpath(absPath);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  let current = absPath;
  const missing = [];
  while (current !== path.parse(current).root) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
    try {
      const real = await realpath(current);
      return path.resolve(real, ...missing);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }
  // Nothing exists yet; return lexical absolute path.
  return absPath;
}

/**
 * Assert that candidate resolves inside root after lexical normalize and realpath.
 * Rejects `..` traversal, absolute escape, and symlink escape when realpath leaves root.
 *
 * @param {string} root
 * @param {string} candidate - absolute or root-relative path
 * @returns {Promise<string>} absolute path (realpath when resolvable)
 */
export async function assertInsideRoot(root, candidate) {
  if (candidate == null || String(candidate).trim() === '') {
    throw new PathEscapeError('candidate path is required', {
      root: String(root ?? ''),
      code: 'CANDIDATE_REQUIRED',
    });
  }

  const absRoot = normalizeRoot(root);
  const raw = String(candidate);

  // Lexical resolve: absolute candidates ignore root (escape if outside).
  const lexical = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(absRoot, raw);

  if (!isPathInside(absRoot, lexical)) {
    throw new PathEscapeError(
      `path escapes root: candidate "${raw}" resolves to "${lexical}" outside root "${absRoot}"`,
      { root: absRoot, candidate: lexical, code: 'LEXICAL_ESCAPE' },
    );
  }

  // Reject embedded null bytes (path tricks).
  if (raw.includes('\0') || lexical.includes('\0')) {
    throw new PathEscapeError('path contains null byte', {
      root: absRoot,
      candidate: raw,
      code: 'NULL_BYTE',
    });
  }

  let realRoot;
  try {
    realRoot = await realpath(absRoot);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      // Root does not exist yet; lexical containment is the best check available.
      return lexical;
    }
    throw err;
  }

  const realCandidate = await realpathExisting(lexical);
  if (!isPathInside(realRoot, realCandidate)) {
    throw new PathEscapeError(
      `symlink or realpath escape: candidate "${raw}" realpath "${realCandidate}" is outside root realpath "${realRoot}"`,
      { root: realRoot, candidate: realCandidate, code: 'SYMLINK_ESCAPE' },
    );
  }

  return realCandidate;
}

/**
 * Join a relative path under root and assert containment.
 * Absolute `rel` values are accepted only when they still resolve inside root.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>} absolute path under root
 */
export async function resolveUnder(root, rel) {
  if (rel == null || String(rel).trim() === '') {
    throw new PathEscapeError('relative path is required for resolveUnder', {
      root: String(root ?? ''),
      code: 'REL_REQUIRED',
    });
  }
  const absRoot = normalizeRoot(root);
  const joined = path.isAbsolute(String(rel))
    ? path.resolve(String(rel))
    : path.resolve(absRoot, String(rel));
  return assertInsideRoot(absRoot, joined);
}

/**
 * @param {string} corpusRoot
 * @returns {string}
 */
export function resolveCorpusRoot(corpusRoot) {
  return normalizeRoot(corpusRoot);
}

/**
 * Fixture root: `<corpusRoot>/fixtures`
 * @param {string} corpusRoot
 * @returns {string}
 */
export function resolveFixtureRoot(corpusRoot) {
  return path.join(resolveCorpusRoot(corpusRoot), 'fixtures');
}

/**
 * Oracle root: `<corpusRoot>/oracles`
 * @param {string} corpusRoot
 * @returns {string}
 */
export function resolveOracleRoot(corpusRoot) {
  return path.join(resolveCorpusRoot(corpusRoot), 'oracles');
}

/**
 * Tasks root: `<corpusRoot>/tasks`
 * @param {string} corpusRoot
 * @returns {string}
 */
export function resolveTasksRoot(corpusRoot) {
  return path.join(resolveCorpusRoot(corpusRoot), 'tasks');
}

/**
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function resolveWorkspaceRoot(workspaceRoot) {
  return normalizeRoot(workspaceRoot);
}

/**
 * @param {string} artifactRoot
 * @returns {string}
 */
export function resolveArtifactRoot(artifactRoot) {
  return normalizeRoot(artifactRoot);
}

/**
 * Resolve a fixture directory name under the corpus fixtures root.
 * @param {string} corpusRoot
 * @param {string} fixturePath - relative fixture directory name
 * @returns {Promise<string>}
 */
export async function resolveFixtureDir(corpusRoot, fixturePath) {
  if (fixturePath == null || String(fixturePath).trim() === '') {
    throw new PathEscapeError('fixturePath is required', { code: 'FIXTURE_REQUIRED' });
  }
  if (path.isAbsolute(String(fixturePath))) {
    throw new PathEscapeError(
      `absolute fixturePath is not allowed: "${fixturePath}"`,
      { candidate: String(fixturePath), code: 'ABSOLUTE_FIXTURE' },
    );
  }
  return resolveUnder(resolveFixtureRoot(corpusRoot), fixturePath);
}

/**
 * Resolve an oracle-relative path under the corpus oracles root.
 * @param {string} corpusRoot
 * @param {string} oracleRel
 * @returns {Promise<string>}
 */
export async function resolveOraclePath(corpusRoot, oracleRel) {
  if (oracleRel == null || String(oracleRel).trim() === '') {
    throw new PathEscapeError('oracle path is required', { code: 'ORACLE_REQUIRED' });
  }
  if (path.isAbsolute(String(oracleRel))) {
    throw new PathEscapeError(
      `absolute oracle path is not allowed: "${oracleRel}"`,
      { candidate: String(oracleRel), code: 'ABSOLUTE_ORACLE' },
    );
  }
  return resolveUnder(resolveOracleRoot(corpusRoot), oracleRel);
}

/**
 * Bundle of standard corpus sub-roots.
 * @param {string} corpusRoot
 * @returns {{ corpusRoot: string, fixturesRoot: string, oraclesRoot: string, tasksRoot: string, suitePath: string }}
 */
export function corpusPaths(corpusRoot) {
  const root = resolveCorpusRoot(corpusRoot);
  return {
    corpusRoot: root,
    fixturesRoot: resolveFixtureRoot(root),
    oraclesRoot: resolveOracleRoot(root),
    tasksRoot: resolveTasksRoot(root),
    suitePath: path.join(root, 'suite.yaml'),
  };
}

/**
 * Check whether a path exists (any type). Does not follow the final component for the check purpose.
 * @param {string} absPath
 * @returns {Promise<boolean>}
 */
export async function pathExists(absPath) {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * lstat helper re-exported for callers that need symlink-aware type checks.
 * @param {string} absPath
 */
export async function lstatPath(absPath) {
  return lstat(absPath);
}

/**
 * Safe single-segment filesystem identifier pattern:
 * - no path separators, no `..`, no null bytes
 * - constrained charset suitable as a single path segment
 * - length 1..128
 *
 * Shared by trial ids, campaign ids, experiment ids used as path segments, etc.
 */
export const SAFE_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @deprecated Prefer SAFE_ID_SEGMENT_RE; kept as alias for trial id call sites. */
export const SAFE_TRIAL_ID_RE = SAFE_ID_SEGMENT_RE;

/**
 * Assert a single path-segment identifier is safe to join under a root.
 * Rejects empty, overlong, traversal, separators, absolute forms, and unconstrained charset.
 *
 * @param {unknown} segment
 * @param {{ label?: string }} [opts]
 * @returns {string} the validated segment
 */
export function assertSafeIdSegment(segment, opts = {}) {
  const label = opts.label ?? 'id segment';
  if (segment == null || typeof segment !== 'string' || segment.trim() === '') {
    throw new PathEscapeError(`${label} is required`, {
      candidate: String(segment ?? ''),
      code: 'ID_SEGMENT_REQUIRED',
    });
  }
  const id = String(segment);
  if (id.includes('\0')) {
    throw new PathEscapeError(`${label} contains null byte`, {
      candidate: id,
      code: 'ID_SEGMENT_NULL',
    });
  }
  if (
    id.includes('..') ||
    id.includes('/') ||
    id.includes('\\') ||
    path.isAbsolute(id) ||
    path.basename(id) !== id ||
    path.normalize(id) !== id
  ) {
    throw new PathEscapeError(
      `unsafe ${label} (traversal or path separator): "${id}"`,
      { candidate: id, code: 'ID_SEGMENT_UNSAFE' },
    );
  }
  if (!SAFE_ID_SEGMENT_RE.test(id)) {
    throw new PathEscapeError(
      `${label} has invalid charset or length: "${id}"`,
      { candidate: id, code: 'ID_SEGMENT_CHARSET' },
    );
  }
  return id;
}

/**
 * Assert a trial id is safe to join under a campaign root.
 * @param {unknown} trialId
 * @returns {string}
 */
export function assertSafeTrialId(trialId) {
  return assertSafeIdSegment(trialId, { label: 'trial id' });
}

/**
 * Assert a campaign id is safe to join as a single path segment (e.g. default campaignDir).
 * @param {unknown} campaignId
 * @returns {string}
 */
export function assertSafeCampaignId(campaignId) {
  return assertSafeIdSegment(campaignId, { label: 'campaign id' });
}

/**
 * Assert an additional relative path segment is safe to join under a root.
 * @param {unknown} segment
 * @returns {string}
 */
function assertSafePathSegment(segment) {
  if (segment == null || String(segment).trim() === '') {
    throw new PathEscapeError('path segment is required', {
      candidate: String(segment ?? ''),
      code: 'SEGMENT_REQUIRED',
    });
  }
  const s = String(segment);
  if (
    s.includes('\0') ||
    s.includes('..') ||
    s.includes('/') ||
    s.includes('\\') ||
    path.isAbsolute(s) ||
    path.basename(s) !== s ||
    path.normalize(s) !== s
  ) {
    throw new PathEscapeError(`unsafe path segment: "${s}"`, {
      candidate: s,
      code: 'SEGMENT_UNSAFE',
    });
  }
  return s;
}

/**
 * Join trialId (+ optional segments) under a campaign root with canonical containment.
 * Uses assertSafeTrialId + resolveUnder / assertInsideRoot at the write boundary.
 *
 * @param {string} root - campaign workspace/artifact/result/raw root
 * @param {string} trialId
 * @param {...string} segments - additional single path segments (no separators)
 * @returns {Promise<string>} absolute path under root
 */
export async function trialPathUnder(root, trialId, ...segments) {
  const id = assertSafeTrialId(trialId);
  const parts = [id];
  for (const seg of segments) {
    parts.push(assertSafePathSegment(seg));
  }
  const rel = path.join(...parts);
  return resolveUnder(root, rel);
}
