/**
 * Fail-closed regular-file I/O that never follows symlinks.
 *
 * Used after untrusted provider exit when the harness re-ingests scratch
 * request/output paths: open with O_NOFOLLOW (where supported), fstat must be a
 * regular file, then bounded read. Never copyFile/readFile through a path that
 * may have been swapped for a symlink to host content.
 */

import { open, constants, lstat, realpath } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './paths.js';

/** Default max bytes for a single safe read (adapter outputs / request JSON). */
export const DEFAULT_SAFE_READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Open flags: read-only + no-follow when available.
 * @returns {number}
 */
export function safeOpenReadFlags() {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_NOFOLLOW === 'number') {
    flags |= constants.O_NOFOLLOW;
  }
  return flags;
}

/**
 * Error for unsafe/symlink/directory/special paths.
 */
export class UnsafePathError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, path?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsafePathError';
    this.code = details.code ?? 'UNSAFE_PATH';
    this.path = details.path;
  }
}

/**
 * Read a regular file without following symlinks.
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function readFileNoFollow(filePath, opts = {}) {
  const maxBytes =
    opts.maxBytes != null && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? Math.floor(opts.maxBytes)
      : DEFAULT_SAFE_READ_MAX_BYTES;
  const abs = String(filePath);
  let handle;
  try {
    handle = await open(abs, safeOpenReadFlags());
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new UnsafePathError(
        `refusing to follow symlink at ${abs} (fail closed)`,
        { code: 'SYMLINK', path: abs },
      );
    }
    throw err;
  }

  try {
    // FileHandle.stat() is the portable API (fstat on the open fd).
    const st = await handle.stat();
    if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
      throw new UnsafePathError(
        `path is a symlink (fail closed): ${abs}`,
        { code: 'SYMLINK', path: abs },
      );
    }
    if (!st.isFile()) {
      throw new UnsafePathError(
        `path is not a regular file (fail closed): ${abs}`,
        { code: 'NOT_REGULAR', path: abs },
      );
    }
    if (st.size > maxBytes) {
      throw new UnsafePathError(
        `file exceeds maxBytes ${maxBytes} (fail closed): ${abs}`,
        { code: 'TOO_LARGE', path: abs },
      );
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(
        buf,
        offset,
        st.size - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === st.size ? buf : buf.subarray(0, offset);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read UTF-8 text from a regular file without following symlinks.
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function readTextNoFollow(filePath, opts = {}) {
  const buf = await readFileNoFollow(filePath, opts);
  return buf.toString('utf8');
}

/**
 * Copy a regular file to dest without following a symlink at source.
 * Dest is written with mode 0600 via exclusive create when possible.
 *
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ bytes: number }>}
 */
export async function copyFileNoFollow(srcPath, destPath, opts = {}) {
  const buf = await readFileNoFollow(srcPath, opts);
  // Write via open O_WRONLY|O_CREAT|O_TRUNC with mode 0600 (not from untrusted path).
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
  const handle = await open(destPath, flags, 0o600);
  try {
    let offset = 0;
    while (offset < buf.length) {
      const { bytesWritten } = await handle.write(
        buf,
        offset,
        buf.length - offset,
        offset,
      );
      offset += bytesWritten;
    }
    await handle.chmod(0o600).catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
  return { bytes: buf.length };
}

/**
 * True if the path currently is a symlink (lstat). Used by tests/helpers.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isSymlinkPath(filePath) {
  try {
    const st = await fs.promises.lstat(filePath);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Ensure every path component from root to candidate is free of symlinks
 * (ancestors and final link). Fail closed on any symlink in the chain.
 *
 * @param {string} rootAbs - trusted root (lexical absolute)
 * @param {string} candidateAbs - path under root (lexical absolute)
 * @returns {Promise<void>}
 */
export async function assertNoSymlinkPathComponents(rootAbs, candidateAbs) {
  const root = path.resolve(rootAbs);
  const candidate = path.resolve(candidateAbs);
  if (!isPathInside(root, candidate)) {
    throw new UnsafePathError(
      `path not under trusted root (fail closed): ${candidate}`,
      { code: 'NOT_CONTAINED', path: candidate },
    );
  }
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafePathError(
      `path escapes trusted root (fail closed): ${candidate}`,
      { code: 'ESCAPE', path: candidate },
    );
  }

  // Root itself must not be a symlink (or we re-resolve outside trust).
  try {
    const rootSt = await lstat(root);
    if (rootSt.isSymbolicLink()) {
      throw new UnsafePathError(
        `trusted root is a symlink (fail closed): ${root}`,
        { code: 'SYMLINK_ROOT', path: root },
      );
    }
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') throw err;
    throw new UnsafePathError(
      `trusted root missing (fail closed): ${root}`,
      { code: 'ROOT_MISSING', path: root },
    );
  }

  let cur = root;
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        throw new UnsafePathError(
          `path component missing (fail closed): ${cur}`,
          { code: 'MISSING', path: cur },
        );
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(
        `symlink in path (fail closed): ${cur}`,
        { code: 'SYMLINK', path: cur },
      );
    }
  }
}

/**
 * Validate that candidate is exactly the expected path under a trusted root:
 * lexical + canonical containment, no symlink ancestors/final, regular file.
 * Then bounded nofollow read.
 *
 * @param {string} trustedRoot
 * @param {string} expectedPath - exact deterministic path required
 * @param {string} candidatePath - path claimed / to validate (must equal expected)
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function readContainedRegularFileNoFollow(
  trustedRoot,
  expectedPath,
  candidatePath,
  opts = {},
) {
  const root = path.resolve(String(trustedRoot));
  const expected = path.resolve(String(expectedPath));
  const candidate = path.resolve(String(candidatePath));

  if (candidate !== expected) {
    throw new UnsafePathError(
      `path is not the expected deterministic path (fail closed): got ${candidate}, expected ${expected}`,
      { code: 'PATH_MISMATCH', path: candidate },
    );
  }
  if (!isPathInside(root, expected)) {
    throw new UnsafePathError(
      `expected path not under trusted root (fail closed): ${expected}`,
      { code: 'NOT_CONTAINED', path: expected },
    );
  }

  await assertNoSymlinkPathComponents(root, expected);

  let st;
  try {
    st = await lstat(expected);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      throw new UnsafePathError(
        `expected regular file missing (fail closed): ${expected}`,
        { code: 'MISSING', path: expected },
      );
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new UnsafePathError(
      `path is a symlink (fail closed): ${expected}`,
      { code: 'SYMLINK', path: expected },
    );
  }
  if (!st.isFile()) {
    throw new UnsafePathError(
      `path is not a regular file (fail closed): ${expected}`,
      { code: 'NOT_REGULAR', path: expected },
    );
  }

  // Canonical containment (after confirming no symlinks, realpath is the path).
  let realRoot;
  let realCand;
  try {
    realRoot = await realpath(root);
    realCand = await realpath(expected);
  } catch (err) {
    throw new UnsafePathError(
      `realpath failed during containment check (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      { code: 'REALPATH', path: expected },
    );
  }
  if (!isPathInside(realRoot, realCand)) {
    throw new UnsafePathError(
      `canonical path escapes trusted root (fail closed): ${realCand}`,
      { code: 'CANONICAL_ESCAPE', path: realCand },
    );
  }

  return readFileNoFollow(expected, opts);
}
