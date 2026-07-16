/**
 * Content digests for harness artifacts and metadata.
 * All digests are sha256 hex strings. JSON digests use canonical
 * (recursively key-sorted) serialization so equivalent objects match.
 *
 * Directory walks never follow symlinks for content: symlink entries are
 * recorded by link-text metadata only so external targets are never read.
 *
 * Exclusion policy (identical for fixture digests and fixture copy):
 * - `.git` and `node_modules` are skipped at any depth (neither copied nor digested).
 * See FIXTURE_SKIP_DIR_NAMES / isSkippedFixtureEntry.
 */

import { createHash } from 'node:crypto';
import { readdir, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { readFileNoFollow } from './safe-fs.js';

/**
 * Directory basenames excluded from both fixture copy and directory digests.
 * Policy is identical in workspace.copyFixtureTree and collectDirEntries:
 * neither copy nor digest includes these trees.
 */
export const FIXTURE_SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

/**
 * True when a basename is excluded from fixture copy and digests.
 * @param {string} name
 * @returns {boolean}
 */
export function isSkippedFixtureEntry(name) {
  return FIXTURE_SKIP_DIR_NAMES.has(String(name));
}

/**
 * Portable permission bits (owner/group/other rwx).
 * @param {number} mode
 * @returns {number}
 */
export function portableModeBits(mode) {
  return Number(mode) & 0o777;
}

/**
 * Recursively canonicalize a value for stable JSON serialization.
 * Object keys are sorted; arrays preserve order; undefined values are dropped.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = /** @type {Record<string, unknown>} */ (value)[key];
    if (v !== undefined) {
      out[key] = canonicalize(v);
    }
  }
  return out;
}

/**
 * @param {unknown} obj
 * @returns {string}
 */
export function canonicalJsonString(obj) {
  return JSON.stringify(canonicalize(obj));
}

/**
 * @param {Buffer | Uint8Array | string} buf
 * @returns {string} sha256 hex
 */
export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash a regular file by content through a held no-follow descriptor.
 * Never follows a leaf symlink (O_NOFOLLOW open + fstat). Prefer
 * collectDirEntries for tree digests (per-entry identity pin).
 *
 * @param {string} filePath
 * @returns {Promise<string>} sha256 hex
 */
export async function sha256File(filePath) {
  // Full-chain policy for single-file digests: refuse symlink leaf via
  // no-follow open; content is read only from the held regular-file fd.
  const buf = await readFileNoFollow(filePath);
  return sha256Buffer(buf);
}

/**
 * @param {unknown} obj
 * @returns {string} sha256 hex of canonical JSON
 */
export function sha256Json(obj) {
  return sha256Buffer(Buffer.from(canonicalJsonString(obj), 'utf8'));
}

/**
 * @param {string} rel
 * @returns {string}
 */
function toPosixRel(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * @typedef {{ type: 'file', path: string, sha256: string, size: number, mode: number }} FileEntry
 * @typedef {{ type: 'dir', path: string, mode: number }} DirEntry
 * @typedef {{ type: 'symlink', path: string, target: string, mode: number }} SymlinkEntry
 * @typedef {FileEntry | DirEntry | SymlinkEntry} DirDigestEntry
 */

/**
 * Walk a directory and collect digest entries without following symlinks.
 * Symlink entries record only `{ type, path, target, mode }` (link text).
 * Regular files record content hash + size + portable mode bits.
 * Directories (including empty ones) record path + portable mode bits.
 * Walk order is locale-sorted by name. `.git` and `node_modules` are skipped
 * at any depth — same policy as fixture copy (FIXTURE_SKIP_DIR_NAMES).
 *
 * @param {string} dir absolute or relative root to walk
 * @param {string} [relBase=''] relative path prefix for entries
 * @returns {Promise<DirDigestEntry[]>}
 */
export async function collectDirEntries(dir, relBase = '') {
  /** @type {DirDigestEntry[]} */
  const entries = [];

  /**
   * @param {string} current
   * @param {string} rel
   */
  async function walk(current, rel) {
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        return;
      }
      throw err;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (isSkippedFixtureEntry(dirent.name)) {
        continue;
      }
      const abs = path.join(current, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const posixRel = toPosixRel(childRel);

      // Prefer lstat over Dirent flags so symlink-to-dir is never walked.
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }

      const mode = portableModeBits(st.mode);

      if (st.isSymbolicLink()) {
        let target;
        try {
          target = await readlink(abs);
        } catch {
          // Unreadable symlink: fail closed with a stable sentinel target.
          target = '';
        }
        entries.push({
          type: 'symlink',
          path: posixRel,
          target: String(target),
          mode,
        });
        continue;
      }

      if (st.isDirectory()) {
        // Record every directory (including empty) so structure binds the digest.
        entries.push({ type: 'dir', path: posixRel, mode });
        await walk(abs, childRel);
        continue;
      }

      if (st.isFile()) {
        // Close leaf swap races: after lstat identity, open O_NOFOLLOW and
        // require the held fd to match (dev,ino) before reading content.
        // Never follow a symlink planted between lstat and open.
        let buf;
        try {
          buf = await readFileNoFollow(abs, {
            expectedDev: st.dev,
            expectedIno: st.ino,
          });
        } catch (err) {
          const code = /** @type {NodeJS.ErrnoException} */ (err).code;
          // Vanished between lstat and open: omit (same as lstat race above).
          if (code === 'ENOENT') continue;
          // Symlink / identity mismatch / not-regular: fail closed (throw).
          throw err;
        }
        entries.push({
          type: 'file',
          path: posixRel,
          sha256: sha256Buffer(buf),
          size: buf.length,
          mode,
        });
      }
      // Skip sockets, devices, FIFOs — not meaningful digest content.
    }
  }

  await walk(dir, relBase);
  return entries;
}

/**
 * Digest a directory of trial/result/fixture artifacts.
 * Walks files/dirs/symlinks in stable relative-path order and hashes
 * path+content+mode tuples. Never follows symlinks: symlink entries
 * contribute only link-text metadata.
 *
 * Includes empty directories and portable mode bits (schema artifact-dir-v3).
 * Excludes `.git` and `node_modules` (aligned with fixture copy).
 *
 * @param {string} dir
 * @returns {Promise<string>} sha256 hex
 */
export async function digestArtifactDir(dir) {
  const files = await collectDirEntries(dir, '');
  // Stable order is already walk-order (sorted names); sort by path as belt+suspenders.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Json({ files, schema: 'artifact-dir-v3' });
}

/**
 * Digest of raw provider output bytes (stdout/stderr/output file).
 * Hashes exact bytes, not lengths.
 *
 * @param {{ stdout?: Buffer | Uint8Array | string | null, stderr?: Buffer | Uint8Array | string | null, output?: Buffer | Uint8Array | string | null }} parts
 * @returns {string} sha256 hex of canonical digest envelope
 */
export function digestRawOutputBytes(parts = {}) {
  /** @type {Record<string, string | null>} */
  const body = {
    schema: 'raw-output-bytes-v1',
    stdoutSha256:
      parts.stdout != null ? sha256Buffer(parts.stdout) : null,
    stderrSha256:
      parts.stderr != null ? sha256Buffer(parts.stderr) : null,
    outputSha256:
      parts.output != null ? sha256Buffer(parts.output) : null,
  };
  return sha256Json(body);
}

/**
 * Deterministic content digest of harness implementation + contracts used by a run.
 * Includes at minimum: harness source tree, schemas tree, package.json, and
 * package-lock.json when present. Does not walk .git, node_modules, campaign
 * outputs, or workspaces.
 *
 * @param {string | null | undefined} root - package/harness root directory
 * @returns {Promise<string>} sha256 hex
 */
export async function digestHarnessContent(root) {
  if (root == null || root === '') {
    return sha256Json({
      schema: 'harness-content-v1',
      root: null,
      entries: [],
    });
  }

  const resolved = path.resolve(root);
  /** @type {DirDigestEntry[]} */
  const entries = [];

  // Scoped includes only — never whole-repo walk.
  const harnessDir = path.join(resolved, 'harness');
  const schemasDir = path.join(resolved, 'schemas');
  entries.push(...(await collectDirEntries(harnessDir, 'harness')));
  entries.push(...(await collectDirEntries(schemasDir, 'schemas')));

  for (const name of ['package.json', 'package-lock.json']) {
    const abs = path.join(resolved, name);
    let st;
    try {
      st = await lstat(abs);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = await readlink(abs);
      } catch {
        target = '';
      }
      entries.push({
        type: 'symlink',
        path: name,
        target: String(target),
        mode: portableModeBits(st.mode),
      });
      continue;
    }
    if (st.isFile()) {
      let buf;
      try {
        buf = await readFileNoFollow(abs, {
          expectedDev: st.dev,
          expectedIno: st.ino,
        });
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT') continue;
        throw err;
      }
      entries.push({
        type: 'file',
        path: name,
        sha256: sha256Buffer(buf),
        size: buf.length,
        mode: portableModeBits(st.mode),
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Json({
    schema: 'harness-content-v1',
    entries,
  });
}
