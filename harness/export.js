/**
 * Sanitized campaign export bundle (whitelist-based, fail-closed).
 *
 * Default export includes only:
 * - sanitized manifest.json (from validated loadManifest)
 * - results/<id>/result.json for verified reportable trials only
 * - report.json / summary.txt rebuilt from verified results
 * - EXPORT_README.txt
 *
 * Never exports: unmanifested results, source report/summary as-is,
 * prompt-bearing request/output, workspaces, locks, free-form secrets.
 * includeRaw copies only whitelisted raw files for verified trial IDs
 * via nofollow regular-file I/O (never follows symlinks).
 */

import {
  readdir,
  lstat,
  rmdir,
  rename,
  rm,
  mkdtemp,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  isBoundedIdentifier,
  sanitizeBoundedIdentifier,
} from './gates.js';
import { assertSafeTrialId, trialPathUnder, isPathInside } from './paths.js';
import {
  copyFileNoFollow,
  ensurePrivateDirNoFollow,
  writeFileAtomicNoFollow,
  UnsafePathError,
} from './safe-fs.js';

/** Top-level result keys allowed in sanitized export (whitelist). */
const RESULT_WHITELIST_KEYS = new Set([
  'id',
  'experimentId',
  'arm',
  'provider',
  'taskId',
  'repetition',
  'scheduleSeed',
  'invocationPath',
  'requestedModel',
  'resolvedModel',
  'resolvedModelAvailable',
  'resolvedModelSource',
  'postureFingerprint',
  'state',
  'classification',
  // classificationReason is free-form — only exported when bounded identifier
  'classificationReason',
  'reasonCode',
  'outcomeKind',
  'hashes',
  'digests',
  'gateResults',
  'changedFileCount',
  'startedAt',
  'finishedAt',
  'durationMs',
  'error',
  'schemaVersion',
  'writtenAt',
]);

/**
 * Keys whose values must match bounded identifier syntax when exported.
 * Free-form text is dropped (belongs in quarantine raw, not sanitized export).
 */
const BOUNDED_IDENTIFIER_KEYS = new Set([
  'reasonCode',
  'outcomeKind',
  'classificationReason',
  'classification',
  'infraFailure',
  'providerFailure',
]);

/** Nested keys that must never appear even inside whitelisted objects. */
const PROMPT_BEARING_KEYS = new Set([
  'prompt',
  'request',
  'requestBody',
  'stdout',
  'stderr',
  'stdoutPreview',
  'stderrPreview',
  'rawStdout',
  'rawStderr',
  'providerStdout',
  'providerStderr',
  'rawOutput',
  'receivedRequest',
  'workingDirectory',
  'workspaceDir',
  'artifactDir',
  'cwd',
  'stdin',
  // Free-form narrative reasons never belong in sanitized export trees
  'reason',
  'message',
  'detail',
  'details',
  'errorMessage',
]);

/**
 * Expected raw quarantine filenames (whitelist). Never enumerate arbitrary names.
 */
export const EXPORT_RAW_FILE_WHITELIST = Object.freeze([
  'stdout.txt',
  'stderr.txt',
  'output.json',
  'meta.json',
  'output-missing.txt',
]);

/**
 * Redact host-identifying strings.
 * @param {unknown} value
 * @param {string} [campaignDir]
 * @returns {unknown}
 */
export function redactHostIdentifying(value, campaignDir) {
  if (value == null) return value;
  if (typeof value === 'string') {
    let s = value;
    if (campaignDir) {
      const abs = path.resolve(campaignDir);
      if (s.includes(abs)) s = s.split(abs).join('<campaign>');
    }
    const home = os.homedir();
    if (home && s.includes(home)) s = s.split(home).join('<home>');
    s = s.replace(/\/var\/folders\/[^\s"']+/g, '<tmpdir>');
    s = s.replace(/\/private\/tmp\/[^\s"']+/g, '<tmpdir>');
    s = s.replace(/\/tmp\/[^\s"']+/g, '<tmpdir>');
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactHostIdentifying(v, campaignDir));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'user' || k === 'username' || k === 'homedir') continue;
      if (PROMPT_BEARING_KEYS.has(k)) continue;
      out[k] = redactHostIdentifying(v, campaignDir);
    }
    return out;
  }
  return value;
}

/**
 * Deep-strip prompt-bearing keys from any object tree.
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripPromptBearing(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stripPromptBearing);
  if (typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PROMPT_BEARING_KEYS.has(k)) continue;
    // Nested request.json-like payloads
    if (k === 'receivedRequest' || k === 'raw') continue;
    // Bounded-identifier fields: drop free-form values
    if (BOUNDED_IDENTIFIER_KEYS.has(k)) {
      const bounded = sanitizeBoundedIdentifier(v);
      if (bounded == null) continue;
      out[k] = bounded;
      continue;
    }
    out[k] = stripPromptBearing(v);
  }
  return out;
}

/**
 * Constrain a top-level or nested adapter/outcome field to bounded identifier
 * syntax. Free-form text is excluded from sanitized export (quarantine only).
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeExportReasonCode(value) {
  return sanitizeBoundedIdentifier(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExportSafeReasonCode(value) {
  return isBoundedIdentifier(value);
}

/**
 * Whitelist-sanitize a trial result for export.
 * @param {object} result
 * @param {string} [campaignDir]
 * @returns {object}
 */
function sanitizeResult(result, campaignDir) {
  if (!result || typeof result !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of RESULT_WHITELIST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = result[key];
    // Free-form / adapter reason fields: only bounded identifiers leave export
    if (BOUNDED_IDENTIFIER_KEYS.has(key)) {
      const bounded = sanitizeBoundedIdentifier(value);
      if (bounded != null) out[key] = bounded;
      continue;
    }
    // error may contain free-form infra messages — drop free-form strings
    if (key === 'error') {
      const bounded = sanitizeBoundedIdentifier(value);
      if (bounded != null) out[key] = bounded;
      continue;
    }
    out[key] = value;
  }
  // gateResults: keep classification/status digests only — never previews
  // or free-form evidence narratives (evidence may embed host paths/secrets).
  if (Array.isArray(out.gateResults)) {
    out.gateResults = out.gateResults.map((g) => {
      if (!g || typeof g !== 'object') return g;
      const {
        gate,
        order,
        required,
        status,
        exitCode,
        timedOut,
        classificationSignal,
        stdoutDigest,
        stderrDigest,
        expectedExitCode,
        check,
        infraFailure,
        oraclePath,
        oracleExecuted,
      } = g;
      /** @type {Record<string, unknown>} */
      const clean = {
        gate,
        order,
        required,
        status,
        exitCode,
        timedOut,
        classificationSignal,
        stdoutDigest,
        stderrDigest,
        expectedExitCode,
        check,
      };
      // infraFailure codes are harness-controlled identifiers; keep if bounded
      if (infraFailure != null) {
        const bounded = sanitizeBoundedIdentifier(infraFailure);
        if (bounded != null) clean.infraFailure = bounded;
      }
      // oraclePath only when exclusive execution was recorded
      if (oraclePath != null && oracleExecuted === true) {
        clean.oraclePath = oraclePath;
        clean.oracleExecuted = true;
      }
      // Explicitly drop previews / free-form evidence even if present
      return stripPromptBearing(clean);
    });
  }
  return /** @type {object} */ (
    redactHostIdentifying(stripPromptBearing(out), campaignDir)
  );
}

/**
 * Sanitize a loaded campaign manifest for export (no absolute paths / usernames).
 * When verifiedIds is provided, manifest.trials is filtered to exactly those
 * verified exported trial IDs (pending/skipped/unverified excluded).
 *
 * @param {object} manifest
 * @param {string} srcRoot
 * @param {Set<string>} [verifiedIds]
 * @returns {object}
 */
function sanitizeManifestForExport(manifest, srcRoot, verifiedIds) {
  const sourceTrials = Array.isArray(manifest.trials) ? manifest.trials : [];
  const filteredTrials =
    verifiedIds != null
      ? sourceTrials.filter(
          (t) => t && t.id != null && verifiedIds.has(String(t.id)),
        )
      : sourceTrials;

  /** @type {Record<string, unknown>} */
  const sanitizedManifest = {
    campaignId: manifest.campaignId,
    schemaVersion: manifest.schemaVersion,
    status: manifest.status,
    experimentId: manifest.experimentId ?? null,
    lock: { held: false, owner: null, acquiredAt: null, path: null },
    trials: filteredTrials.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const {
        id,
        state,
        arm,
        taskId,
        repetition,
        invocationPath,
        requestedModel,
        resolvedModel,
        postureFingerprint,
        classification,
        provider,
        scheduleSeed,
      } = t;
      return {
        id,
        state,
        arm,
        taskId,
        repetition,
        invocationPath,
        requestedModel,
        resolvedModel,
        postureFingerprint,
        classification,
        provider,
        scheduleSeed,
      };
    }),
    corpusRevision: manifest.corpusRevision ?? null,
    harnessRevision: manifest.harnessRevision ?? null,
    host: manifest.host
      ? (() => {
          const h = { ...manifest.host };
          delete h.user;
          delete h.username;
          return h;
        })()
      : undefined,
    scheduleSeed: manifest.scheduleSeed ?? null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    completedAt: manifest.completedAt ?? null,
  };
  return /** @type {object} */ (
    redactHostIdentifying(stripPromptBearing(sanitizedManifest), srcRoot)
  );
}

/**
 * True when a symlink is a known OS volume alias we deliberately allow
 * (macOS /tmp -> /private/tmp, /var -> /private/var). User-controlled
 * intermediate symlinks are never allowed.
 *
 * @param {string} linkPath absolute path that is a symlink
 * @returns {Promise<boolean>}
 */
async function isAllowedSystemPathSymlink(linkPath) {
  const abs = path.resolve(linkPath);
  if (process.platform !== 'darwin') {
    return false;
  }
  // Only the top-level /tmp and /var aliases are allowed.
  if (abs !== '/tmp' && abs !== '/var') {
    return false;
  }
  try {
    const real = await realpath(abs);
    // Only the standard macOS volume aliases — not arbitrary /private/* links.
    return real === '/private/tmp' || real === '/private/var';
  } catch {
    return false;
  }
}

/**
 * Walk every path component from filesystem root to `absPath` with lstat.
 * Reject any symlink ancestor that is not an allowed system alias.
 * Returns the physical realpath of the deepest existing ancestor joined with
 * remaining segments when the full path does not yet exist.
 *
 * @param {string} absPath
 * @param {{ mustExist?: boolean }} [opts]
 * @returns {Promise<string>} canonical absolute path
 */
export async function canonicalizePathNoUserSymlinks(absPath, opts = {}) {
  const lexical = path.resolve(String(absPath));
  if (lexical.includes('\0')) {
    throw new Error(
      'exportSanitizedBundle: path contains null byte (fail closed)',
    );
  }

  const root = path.parse(lexical).root; // '/' or 'C:\\'
  const rel = path.relative(root, lexical);
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);

  let cur = root.endsWith(path.sep) ? root.slice(0, -1) || root : root;
  // On Unix root is '/'; path.join('/', 'a') works. On walk, start at ''.
  if (process.platform !== 'win32') {
    cur = '';
  }

  for (let i = 0; i < parts.length; i += 1) {
    cur = cur === '' ? path.sep + parts[i] : path.join(cur, parts[i]);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        if (opts.mustExist) {
          throw new Error(
            `exportSanitizedBundle: path does not exist (fail closed): ${lexical}`,
          );
        }
        // Remaining segments do not exist yet. Canonicalize existing prefix.
        const existing = path.dirname(cur);
        let realPrefix;
        try {
          realPrefix = await realpath(existing === path.sep ? path.sep : existing);
        } catch {
          realPrefix = existing;
        }
        const rest = parts.slice(i).join(path.sep);
        return rest ? path.join(realPrefix, rest) : realPrefix;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      const allowed = await isAllowedSystemPathSymlink(cur);
      if (!allowed) {
        throw new Error(
          `exportSanitizedBundle: refusing symlink ancestor (fail closed): ${cur}`,
        );
      }
    }
  }

  // Full path exists: return physical realpath (system aliases collapsed).
  try {
    return await realpath(lexical);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' && !opts.mustExist) {
      return lexical;
    }
    throw err;
  }
}

/**
 * Reject equal or nested campaignDir/outDir in either direction using
 * physical/canonical roots. Require a fresh destination: must not exist, or
 * be an empty real directory (not a symlink). Staging is created only under
 * the verified canonical parent. Never merge into pre-existing/stale content.
 *
 * @param {string} campaignDir
 * @param {string} outDir
 * @returns {Promise<{
 *   srcRoot: string,
 *   destRoot: string,
 *   destParent: string,
 *   destExists: boolean,
 * }>}
 */
export async function assertSafeExportDestination(campaignDir, outDir) {
  // Campaign must exist and have no user-controlled symlink ancestors.
  const srcRoot = await canonicalizePathNoUserSymlinks(campaignDir, {
    mustExist: true,
  });

  const lexicalDest = path.resolve(String(outDir));
  const lexicalParent = path.dirname(lexicalDest);

  // Parent must exist and be free of user symlink ancestors.
  const destParent = await canonicalizePathNoUserSymlinks(lexicalParent, {
    mustExist: true,
  });

  // Dest basename is a single segment under the verified parent.
  const destBase = path.basename(lexicalDest);
  if (
    !destBase ||
    destBase === '.' ||
    destBase === '..' ||
    destBase.includes(path.sep)
  ) {
    throw new Error(
      'exportSanitizedBundle: outDir basename invalid (fail closed)',
    );
  }
  const destRoot = path.join(destParent, destBase);

  // Physical overlap checks (canonical roots).
  if (srcRoot === destRoot) {
    throw new Error(
      'exportSanitizedBundle: outDir must not equal campaignDir (fail closed)',
    );
  }
  if (isPathInside(srcRoot, destRoot) && srcRoot !== destRoot) {
    throw new Error(
      'exportSanitizedBundle: outDir must not be inside campaignDir (fail closed)',
    );
  }
  if (isPathInside(destRoot, srcRoot) && srcRoot !== destRoot) {
    throw new Error(
      'exportSanitizedBundle: campaignDir must not be inside outDir (fail closed)',
    );
  }
  // Parent of export under campaign is also an overlap risk for staging.
  if (isPathInside(srcRoot, destParent) || srcRoot === destParent) {
    throw new Error(
      'exportSanitizedBundle: outDir parent must not be inside or equal campaignDir (fail closed)',
    );
  }

  let destExists = false;
  try {
    const st = await lstat(destRoot);
    destExists = true;
    if (st.isSymbolicLink()) {
      throw new Error(
        'exportSanitizedBundle: outDir must not be a symlink (fail closed)',
      );
    }
    if (!st.isDirectory()) {
      throw new Error(
        'exportSanitizedBundle: outDir exists and is not a directory (fail closed)',
      );
    }
    const entries = await readdir(destRoot);
    if (entries.length > 0) {
      throw new Error(
        'exportSanitizedBundle: outDir must be empty or not exist; refusing to merge into pre-existing content (fail closed)',
      );
    }
  } catch (err) {
    if (err instanceof Error && /fail closed/.test(err.message)) {
      throw err;
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      throw err;
    }
    destExists = false;
  }

  return { srcRoot, destRoot, destParent, destExists };
}

/**
 * Copy whitelisted raw files for a verified trial with nofollow + containment.
 * Rejects symlink/unsafe material rather than following it.
 *
 * @param {string} campaignDir
 * @param {string} trialId
 * @param {string} destRoot
 * @param {string[]} warnings
 * @returns {Promise<number>} files copied
 */
async function copyVerifiedTrialRaw(campaignDir, trialId, destRoot, warnings) {
  const safeId = assertSafeTrialId(trialId);
  const rawRoot = path.join(path.resolve(campaignDir), 'raw');
  const srcDir = await trialPathUnder(rawRoot, safeId);
  const destDir = path.join(destRoot, 'raw', safeId);
  await ensurePrivateDirNoFollow(destDir);

  let copied = 0;
  for (const fname of EXPORT_RAW_FILE_WHITELIST) {
    const from = path.join(srcDir, fname);
    // Containment: lexical join under srcDir must stay under raw root
    if (!from.startsWith(srcDir + path.sep) && from !== srcDir) {
      warnings.push(`raw path refused for ${safeId}/${fname}: not under trial raw dir`);
      continue;
    }
    const to = path.join(destDir, fname);
    try {
      await copyFileNoFollow(from, to);
      copied += 1;
    } catch (err) {
      if (err instanceof UnsafePathError) {
        warnings.push(
          `raw refused (unsafe/symlink) for ${safeId}/${fname}: ${err.code || err.message}`,
        );
        continue;
      }
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        // Optional raw file missing is fine
        continue;
      }
      warnings.push(
        `raw copy failed for ${safeId}/${fname}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return copied;
}

/**
 * Fail-closed sanitized export.
 *
 * Always verifies evidence. Exports only verified reportable trial results
 * that correspond to manifest terminal trials. Rebuilds report/summary from
 * those results; never reads source report.json / summary.txt.
 *
 * @param {object} opts
 * @param {string} opts.campaignDir
 * @param {string} opts.outDir
 * @param {boolean} [opts.includeRaw=false]
 * @returns {Promise<{
 *   outDir: string,
 *   filesCopied: number,
 *   includeRaw: boolean,
 *   verified: number,
 *   warnings: string[],
 * }>}
 */
export async function exportSanitizedBundle({
  campaignDir,
  outDir,
  includeRaw = false,
}) {
  if (!campaignDir) {
    throw new Error('exportSanitizedBundle: campaignDir is required');
  }
  if (!outDir) {
    throw new Error('exportSanitizedBundle: outDir is required');
  }

  // Destination safety first: canonical roots, no user symlink ancestors,
  // physical overlap checks, fresh/empty dest only.
  const { srcRoot, destRoot, destParent, destExists } =
    await assertSafeExportDestination(campaignDir, outDir);

  /** @type {string[]} */
  const warnings = [];
  let filesCopied = 0;

  // 1–2. Require a valid manifest (no silent continue without one).
  const { loadManifest } = await import('./manifest.js');
  let manifest;
  try {
    manifest = await loadManifest(srcRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `exportSanitizedBundle: valid campaign manifest required (fail closed): ${message}`,
    );
  }

  const trials = Array.isArray(manifest.trials) ? manifest.trials : [];
  const terminal = trials.filter(
    (t) => t && (t.state === 'completed' || t.state === 'failed'),
  );
  if (terminal.length === 0) {
    throw new Error(
      'exportSanitizedBundle: no completed/failed trials eligible for export (fail closed)',
    );
  }

  // 3. Full evidence gate; only verified reportable results are exported.
  const { verifyCampaignEvidenceDigests } = await import('./results.js');
  const evidence = await verifyCampaignEvidenceDigests(
    srcRoot,
    trials,
    undefined,
    { failOnUnavailable: true },
  );
  if (!evidence.ok) {
    throw new Error(
      evidence.error ||
        'exportSanitizedBundle: evidence digest verification failed (fail closed)',
    );
  }
  if (evidence.unavailable > 0) {
    throw new Error(
      'exportSanitizedBundle: unavailable trial evidence present (fail closed; no benchmark export)',
    );
  }

  const reportable = Array.isArray(evidence.reportableResults)
    ? evidence.reportableResults
    : [];
  if (reportable.length === 0) {
    throw new Error(
      'exportSanitizedBundle: no verified reportable results to export (fail closed)',
    );
  }

  // Only IDs that are both manifest-terminal and verified reportable.
  /** @type {Set<string>} */
  const terminalIds = new Set(terminal.map((t) => String(t.id)));
  const exportResults = reportable.filter(
    (r) => r && r.id != null && terminalIds.has(String(r.id)),
  );
  if (exportResults.length === 0) {
    throw new Error(
      'exportSanitizedBundle: verified results do not match manifest terminal trials (fail closed)',
    );
  }

  /** @type {Set<string>} */
  const exportIds = new Set(exportResults.map((r) => String(r.id)));

  // Write into a private staging directory under the verified canonical parent,
  // then rename-publish into destRoot. Never merge into a pre-existing nonempty
  // destination; never recursive cleanup of user-chosen existing content.
  const stagingRoot = await mkdtemp(
    path.join(destParent, '.aicb-export-staging-'),
  );

  try {
    // Sanitized manifest: trials list is exactly the verified export set.
    const redactedManifest = sanitizeManifestForExport(
      manifest,
      srcRoot,
      exportIds,
    );
    await writeFileAtomicNoFollow(
      path.join(stagingRoot, 'manifest.json'),
      `${JSON.stringify(redactedManifest, null, 2)}\n`,
      { mode: 0o600, fsync: true },
    );
    filesCopied += 1;

    // Export ONLY verified reportable results — never readdir results/.
    for (const raw of exportResults) {
      const id = assertSafeTrialId(String(raw.id));
      const clean = sanitizeResult(raw, srcRoot);
      const destDir = path.join(stagingRoot, 'results', id);
      await ensurePrivateDirNoFollow(destDir);
      await writeFileAtomicNoFollow(
        path.join(destDir, 'result.json'),
        `${JSON.stringify(clean, null, 2)}\n`,
        { mode: 0o600, fsync: true },
      );
      filesCopied += 1;
    }

    // Rebuild report/summary from verified results only (not full manifest trials).
    // Never read or copy source report.json / summary.txt.
    const { buildReport, formatHumanSummary } = await import('./summary.js');
    const report = buildReport(manifest, exportResults);
    const reportBody = redactHostIdentifying(
      stripPromptBearing(report),
      srcRoot,
    );
    await writeFileAtomicNoFollow(
      path.join(stagingRoot, 'report.json'),
      `${JSON.stringify(reportBody, null, 2)}\n`,
      { mode: 0o600, fsync: true },
    );
    filesCopied += 1;

    const human = formatHumanSummary(
      /** @type {object} */ (reportBody),
    );
    await writeFileAtomicNoFollow(
      path.join(stagingRoot, 'summary.txt'),
      `${String(redactHostIdentifying(human, srcRoot))}\n`,
      { mode: 0o600, fsync: true },
    );
    filesCopied += 1;

    // includeRaw: only verified trial IDs, whitelist filenames, nofollow.
    if (includeRaw) {
      warnings.push(
        'includeRaw=true: raw/ may contain secrets — handle as confidential',
      );
      for (const r of exportResults) {
        const id = String(r.id);
        try {
          filesCopied += await copyVerifiedTrialRaw(
            srcRoot,
            id,
            stagingRoot,
            warnings,
          );
        } catch (err) {
          warnings.push(
            `raw export skipped for ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await writeFileAtomicNoFollow(
      path.join(stagingRoot, 'EXPORT_README.txt'),
      [
        'Sanitized campaign export bundle (whitelist)',
        'source: <campaign> (absolute path redacted)',
        `includeRaw: ${includeRaw}`,
        'Only validated manifest, verified result digests, and rebuilt report/summary are exported.',
        'Source report.json/summary.txt are never copied; they are regenerated from verified evidence.',
        'Unmanifested results and unverified trials are never exported.',
        'Prompt-bearing request/output content is never exported.',
        'Local usernames and absolute paths are redacted.',
        'Upload/publish is not performed by the harness.',
        '',
      ].join('\n'),
      { mode: 0o600, fsync: true },
    );
    filesCopied += 1;

    // Publish: empty dest may be rmdir'd then rename; nonexistent → rename.
    // Re-check emptiness so a race cannot merge into stale content.
    if (destExists) {
      let entries;
      try {
        const st = await lstat(destRoot);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          throw new Error(
            'exportSanitizedBundle: outDir changed during export (fail closed)',
          );
        }
        entries = await readdir(destRoot);
      } catch (err) {
        if (err instanceof Error && /fail closed/.test(err.message)) {
          throw err;
        }
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== 'ENOENT') throw err;
        entries = null;
      }
      if (entries != null) {
        if (entries.length > 0) {
          throw new Error(
            'exportSanitizedBundle: outDir became non-empty during export (fail closed)',
          );
        }
        await rmdir(destRoot);
      }
    }
    await rename(stagingRoot, destRoot);
  } catch (err) {
    // Best-effort staging cleanup; never touch user dest content on failure.
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    outDir: destRoot,
    filesCopied,
    includeRaw: Boolean(includeRaw),
    verified: exportResults.length,
    warnings,
  };
}
