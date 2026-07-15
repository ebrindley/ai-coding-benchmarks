/**
 * Content digests for harness artifacts and metadata.
 * All digests are sha256 hex strings. JSON digests use canonical
 * (recursively key-sorted) serialization so equivalent objects match.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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
 * Digest a directory of trial/result artifacts.
 * Walks files in stable relative-path order and hashes path+content pairs.
 * Symlinks are not followed as directories; symlink files are hashed by target content if readable as files.
 *
 * @param {string} dir
 * @returns {Promise<string>} sha256 hex
 */
export async function digestArtifactDir(dir) {
  /** @type {{ path: string, sha256: string, size: number }[]} */
  const files = [];

  /**
   * @param {string} current
   * @param {string} rel
   */
  async function walk(current, rel) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        return;
      }
      throw err;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        let st;
        try {
          st = await stat(abs);
        } catch {
          continue;
        }
        if (!st.isFile()) {
          continue;
        }
        const hash = await sha256File(abs);
        files.push({ path: childRel.split(path.sep).join('/'), sha256: hash, size: st.size });
      }
    }
  }

  await walk(dir, '');
  return sha256Json({ files, schema: 'artifact-dir-v1' });
}
