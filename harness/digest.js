/**
 * Content digests for harness artifacts and metadata.
 * All digests are sha256 hex strings. JSON digests use canonical
 * (recursively key-sorted) serialization so equivalent objects match.
 *
 * Directory walks never follow symlinks for content: symlink entries are
 * recorded by link-text metadata only so external targets are never read.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

/** Directory basenames skipped while walking trees for digests. */
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

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
 * Hash a regular file by content. Callers must not pass symlink paths when
 * symlink-safe digests are required — use collectDirEntries instead.
 *
 * @param {string} filePath
 * @returns {Promise<string>} sha256 hex
 */
export async function sha256File(filePath) {
  const buf = await readFile(filePath);
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
 * Walk a directory and collect digest entries without following symlinks.
 * Symlink entries record only `{ type, path, target }` (link text).
 * Regular files record content hash + size. Directories are walked in
 * locale-sorted name order. `.git` and `node_modules` are skipped.
 *
 * @param {string} dir absolute or relative root to walk
 * @param {string} [relBase=''] relative path prefix for entries
 * @returns {Promise<Array<
 *   | { type: 'file', path: string, sha256: string, size: number }
 *   | { type: 'symlink', path: string, target: string }
 * >>}
 */
export async function collectDirEntries(dir, relBase = '') {
  /** @type {Array<
   *   | { type: 'file', path: string, sha256: string, size: number }
   *   | { type: 'symlink', path: string, target: string }
   * >} */
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
      if (SKIP_DIR_NAMES.has(dirent.name)) {
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

      if (st.isSymbolicLink()) {
        let target;
        try {
          target = await readlink(abs);
        } catch {
          // Unreadable symlink: fail closed with a stable sentinel target.
          target = '';
        }
        entries.push({ type: 'symlink', path: posixRel, target: String(target) });
        continue;
      }

      if (st.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }

      if (st.isFile()) {
        const buf = await readFile(abs);
        entries.push({
          type: 'file',
          path: posixRel,
          sha256: sha256Buffer(buf),
          size: st.size,
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
 * Walks files in stable relative-path order and hashes path+content pairs.
 * Never follows symlinks: symlink entries contribute only link-text metadata.
 *
 * @param {string} dir
 * @returns {Promise<string>} sha256 hex
 */
export async function digestArtifactDir(dir) {
  const files = await collectDirEntries(dir, '');
  // Stable order is already walk-order (sorted names); sort by path as belt+suspenders.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Json({ files, schema: 'artifact-dir-v2' });
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
  /** @type {Array<
   *   | { type: 'file', path: string, sha256: string, size: number }
   *   | { type: 'symlink', path: string, target: string }
   * >} */
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
      entries.push({ type: 'symlink', path: name, target: String(target) });
      continue;
    }
    if (st.isFile()) {
      const buf = await readFile(abs);
      entries.push({
        type: 'file',
        path: name,
        sha256: sha256Buffer(buf),
        size: st.size,
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Json({
    schema: 'harness-content-v1',
    entries,
  });
}
