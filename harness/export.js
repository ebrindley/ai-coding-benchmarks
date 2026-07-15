/**
 * Sanitized campaign export bundle (whitelist-based).
 *
 * Default export includes only:
 * - sanitized manifest.json
 * - results/<id>/result.json (digests/metadata only)
 * - report.json / summary.txt
 * - EXPORT_README.txt
 *
 * Never exports: raw/, prompt-bearing request/output (even nested),
 * workspaces, locks, tmp files, local usernames, absolute paths.
 */

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
  'classificationReason',
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

/** Nested keys that must never appear even inside whitelisted objects. */
const PROMPT_BEARING_KEYS = new Set([
  'prompt',
  'request',
  'requestBody',
  'stdout',
  'stderr',
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
    out[k] = stripPromptBearing(v);
  }
  return out;
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
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      out[key] = result[key];
    }
  }
  // gateResults: keep classification/status digests only
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
        evidence,
        stdoutDigest,
        stderrDigest,
        expectedExitCode,
        check,
      } = g;
      return stripPromptBearing({
        gate,
        order,
        required,
        status,
        exitCode,
        timedOut,
        classificationSignal,
        evidence,
        stdoutDigest,
        stderrDigest,
        expectedExitCode,
        check,
      });
    });
  }
  return /** @type {object} */ (
    redactHostIdentifying(stripPromptBearing(out), campaignDir)
  );
}

/**
 * @param {object} opts
 * @param {string} opts.campaignDir
 * @param {string} opts.outDir
 * @param {boolean} [opts.includeRaw=false]
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

  const srcRoot = path.resolve(campaignDir);
  const destRoot = path.resolve(outDir);
  /** @type {string[]} */
  const warnings = [];
  let filesCopied = 0;

  await mkdir(destRoot, { recursive: true });

  // Whitelist: manifest.json
  try {
    const manifest = JSON.parse(
      await readFile(path.join(srcRoot, 'manifest.json'), 'utf8'),
    );
    /** @type {Record<string, unknown>} */
    const sanitizedManifest = {
      campaignId: manifest.campaignId,
      schemaVersion: manifest.schemaVersion,
      status: manifest.status,
      experimentId: manifest.experimentId ?? null,
      lock: { held: false, owner: null, acquiredAt: null, path: null },
      trials: Array.isArray(manifest.trials)
        ? manifest.trials.map((t) => {
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
          })
        : [],
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
    const redacted = redactHostIdentifying(
      stripPromptBearing(sanitizedManifest),
      srcRoot,
    );
    await writeFile(
      path.join(destRoot, 'manifest.json'),
      `${JSON.stringify(redacted, null, 2)}\n`,
      'utf8',
    );
    filesCopied += 1;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') throw err;
    warnings.push('manifest.json missing; export continues without it');
  }

  // Whitelist: results/*/result.json
  try {
    const trialDirs = await readdir(path.join(srcRoot, 'results'), {
      withFileTypes: true,
    });
    for (const entry of trialDirs) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          await readFile(
            path.join(srcRoot, 'results', entry.name, 'result.json'),
            'utf8',
          ),
        );
        const clean = sanitizeResult(raw, srcRoot);
        const destDir = path.join(destRoot, 'results', entry.name);
        await mkdir(destDir, { recursive: true });
        await writeFile(
          path.join(destDir, 'result.json'),
          `${JSON.stringify(clean, null, 2)}\n`,
          'utf8',
        );
        filesCopied += 1;
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT') continue;
        warnings.push(
          `skipped result ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') throw err;
  }

  // Whitelist: report.json / summary.txt
  for (const name of ['report.json', 'summary.txt']) {
    try {
      const text = await readFile(path.join(srcRoot, name), 'utf8');
      let body = text;
      if (name.endsWith('.json')) {
        try {
          body = `${JSON.stringify(
            redactHostIdentifying(stripPromptBearing(JSON.parse(text)), srcRoot),
            null,
            2,
          )}\n`;
        } catch {
          body = String(redactHostIdentifying(text, srcRoot));
        }
      } else {
        body = String(redactHostIdentifying(text, srcRoot));
      }
      await writeFile(path.join(destRoot, name), body, 'utf8');
      filesCopied += 1;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  // Default: never copy artifacts/ or raw/
  if (includeRaw) {
    warnings.push(
      'includeRaw=true: raw/ may contain secrets — handle as confidential',
    );
    try {
      const { copyFile: cp } = await import('node:fs/promises');
      const rawSrc = path.join(srcRoot, 'raw');
      const trialDirs = await readdir(rawSrc, { withFileTypes: true });
      for (const entry of trialDirs) {
        if (!entry.isDirectory()) continue;
        const files = await readdir(path.join(rawSrc, entry.name));
        for (const fname of files) {
          const from = path.join(rawSrc, entry.name, fname);
          const toDir = path.join(destRoot, 'raw', entry.name);
          await mkdir(toDir, { recursive: true });
          await cp(from, path.join(toDir, fname));
          filesCopied += 1;
        }
      }
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  await writeFile(
    path.join(destRoot, 'EXPORT_README.txt'),
    [
      'Sanitized campaign export bundle (whitelist)',
      'source: <campaign> (absolute path redacted)',
      `includeRaw: ${includeRaw}`,
      'Only manifest, results digests, and report/summary are exported by default.',
      'Prompt-bearing request/output content is never exported.',
      'Local usernames and absolute paths are redacted.',
      'Upload/publish is not performed by the harness.',
      '',
    ].join('\n'),
    'utf8',
  );
  filesCopied += 1;

  return {
    outDir: destRoot,
    filesCopied,
    includeRaw: Boolean(includeRaw),
    warnings,
  };
}
