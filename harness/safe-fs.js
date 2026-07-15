/**
 * Fail-closed filesystem I/O that never follows symlinks.
 *
 * Read path: open with O_NOFOLLOW (where supported), fstat must be a regular
 * file, then bounded read. Used after untrusted provider exit when re-ingesting
 * scratch request/output paths.
 *
 * Write path (campaign boundary):
 * - Physical campaign boundary validation (no symlink root/ancestors)
 * - Component-by-component directory creation without following symlinks
 * - Atomic file replacement via unpredictable same-dir temps with O_EXCL +
 *   O_NOFOLLOW, mode 0600 when private, revalidation immediately before rename
 * - Never open or chmod a pre-existing symlink
 * - Fail closed if no-follow guarantees cannot be established
 */

import { open, constants, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPathInside } from './paths.js';

/** Default max bytes for a single safe read (adapter outputs / request JSON). */
export const DEFAULT_SAFE_READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * True when O_NOFOLLOW is available on this platform.
 * Campaign writes fail closed when this is false (no portable no-follow guarantee).
 * @returns {boolean}
 */
export function hasNoFollowOpen() {
  return typeof constants.O_NOFOLLOW === 'number';
}

/**
 * Assert no-follow open is available; fail closed otherwise.
 * @returns {void}
 */
export function assertNoFollowAvailable() {
  if (!hasNoFollowOpen()) {
    throw new UnsafePathError(
      'O_NOFOLLOW is unavailable; refusing campaign writes (fail closed)',
      { code: 'NOFOLLOW_UNAVAILABLE' },
    );
  }
}

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
 * Exclusive create + write + no-follow (temp files). Requires O_NOFOLLOW.
 * @returns {number}
 */
export function safeOpenExclusiveWriteFlags() {
  assertNoFollowAvailable();
  return (
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW
  );
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
 * True when a symlink is a known OS volume alias we deliberately allow
 * (macOS /tmp -> /private/tmp, /var -> /private/var). User-controlled
 * intermediate symlinks are never allowed on the campaign boundary.
 *
 * @param {string} linkPath absolute path that is a symlink
 * @returns {Promise<boolean>}
 */
export async function isAllowedSystemPathSymlink(linkPath) {
  const abs = path.resolve(linkPath);
  if (process.platform !== 'darwin') {
    return false;
  }
  if (abs !== '/tmp' && abs !== '/var') {
    return false;
  }
  try {
    const real = await realpath(abs);
    return real === '/private/tmp' || real === '/private/var';
  } catch {
    return false;
  }
}

/**
 * lstat a path; return null on ENOENT.
 * @param {string} p
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function lstatOrNull(p) {
  try {
    return await lstat(p);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Map open/ELOOP failures to UnsafePathError.
 * @param {unknown} err
 * @param {string} abs
 * @returns {never}
 */
function rethrowOpenError(err, abs) {
  if (err instanceof UnsafePathError) throw err;
  const code = /** @type {NodeJS.ErrnoException} */ (err).code;
  if (code === 'ELOOP' || code === 'EMLINK') {
    throw new UnsafePathError(
      `refusing to follow symlink at ${abs} (fail closed)`,
      { code: 'SYMLINK', path: abs },
    );
  }
  throw err;
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
    rethrowOpenError(err, abs);
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
 * chmod via an open fd so we never chmod through a symlink.
 * Requires O_NOFOLLOW. For directories prefers O_DIRECTORY when available.
 *
 * @param {string} filePath
 * @param {number} mode
 * @param {{ directory?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function chmodNoFollow(filePath, mode, opts = {}) {
  assertNoFollowAvailable();
  const abs = path.resolve(String(filePath));
  let flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  if (opts.directory && typeof constants.O_DIRECTORY === 'number') {
    flags |= constants.O_DIRECTORY;
  }
  let handle;
  try {
    handle = await open(abs, flags);
  } catch (err) {
    rethrowOpenError(err, abs);
  }
  try {
    const st = await handle.stat();
    if (opts.directory) {
      if (!st.isDirectory()) {
        throw new UnsafePathError(
          `chmodNoFollow: not a directory (fail closed): ${abs}`,
          { code: 'NOT_DIRECTORY', path: abs },
        );
      }
    } else if (!st.isFile() && !st.isDirectory()) {
      throw new UnsafePathError(
        `chmodNoFollow: not a regular file or directory (fail closed): ${abs}`,
        { code: 'NOT_REGULAR', path: abs },
      );
    }
    await handle.chmod(mode);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Best-effort private chmod; ignore platforms that lack mode bits.
 * Never follows symlinks when O_NOFOLLOW is available.
 *
 * @param {string} p
 * @param {number} mode
 * @param {{ directory?: boolean }} [opts]
 */
export async function tryChmodNoFollow(p, mode, opts = {}) {
  try {
    if (hasNoFollowOpen()) {
      await chmodNoFollow(p, mode, opts);
    }
  } catch {
    /* ignore mode failures / race ENOENT */
  }
}

/**
 * Walk every existing path component from filesystem root to `absPath` with
 * lstat. Reject any user-controlled symlink (macOS /tmp and /var aliases
 * allowed). Returns the lexical absolute path after validation.
 *
 * When `mustExist` is false, missing tail components are OK (create path).
 * The deepest existing component must not be a non-directory if further
 * components remain, except when the full path is a missing leaf.
 *
 * @param {string} absPath
 * @param {{ mustExist?: boolean, label?: string }} [opts]
 * @returns {Promise<string>} validated absolute path (lexical)
 */
export async function assertNoSymlinkAncestors(absPath, opts = {}) {
  const label = opts.label ?? 'path';
  const lexical = path.resolve(String(absPath));
  if (lexical.includes('\0')) {
    throw new UnsafePathError(
      `${label}: path contains null byte (fail closed)`,
      { code: 'NULL_BYTE', path: lexical },
    );
  }

  const root = path.parse(lexical).root;
  const rel = path.relative(root, lexical);
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);

  // Walk components. On POSIX, build absolute paths from '/'.
  let cur = process.platform === 'win32' ? root : '';
  for (let i = 0; i < parts.length; i += 1) {
    cur = cur === '' ? path.sep + parts[i] : path.join(cur, parts[i]);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        if (opts.mustExist) {
          throw new UnsafePathError(
            `${label}: path does not exist (fail closed): ${lexical}`,
            { code: 'MISSING', path: lexical },
          );
        }
        // Remaining segments do not exist yet — existing prefix is clean.
        return lexical;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      const allowed = await isAllowedSystemPathSymlink(cur);
      if (!allowed) {
        throw new UnsafePathError(
          `${label}: refusing symlink component (fail closed): ${cur}`,
          { code: 'SYMLINK', path: cur },
        );
      }
    }
  }

  return lexical;
}

/**
 * Physically validate a campaign filesystem boundary before any create/resume
 * write. Rejects:
 * - null bytes / empty path
 * - symlink at the campaign root (when it exists)
 * - any existing user-controlled symlink ancestor/component
 *
 * Does not require the campaign directory to exist yet (create path).
 * Keeps the path as the caller-authorized absolute path after lexical resolve.
 *
 * @param {string} campaignDir
 * @returns {Promise<string>} absolute campaign path (validated)
 */
export async function assertCampaignFilesystemBoundary(campaignDir) {
  if (campaignDir == null || String(campaignDir).trim() === '') {
    throw new UnsafePathError(
      'campaignDir is required (fail closed)',
      { code: 'CAMPAIGN_REQUIRED' },
    );
  }
  const abs = path.resolve(String(campaignDir));
  if (abs.includes('\0')) {
    throw new UnsafePathError(
      'campaignDir contains null byte (fail closed)',
      { code: 'NULL_BYTE', path: abs },
    );
  }

  // Existing ancestors only (not the campaign leaf itself) — leaf gets a
  // dedicated SYMLINK_ROOT / NOT_DIRECTORY diagnosis below.
  const parent = path.dirname(abs);
  if (parent && parent !== abs) {
    await assertNoSymlinkAncestors(parent, {
      mustExist: true,
      label: 'campaign boundary ancestor',
    });
  }

  // If campaign root exists, it must be a real directory (not a symlink).
  const st = await lstatOrNull(abs);
  if (st) {
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(
        `campaign root is a symlink (fail closed): ${abs}`,
        { code: 'SYMLINK_ROOT', path: abs },
      );
    }
    if (!st.isDirectory()) {
      throw new UnsafePathError(
        `campaign root is not a directory (fail closed): ${abs}`,
        { code: 'NOT_DIRECTORY', path: abs },
      );
    }
  }

  return abs;
}

/**
 * Ensure every path component from root to candidate is free of symlinks
 * (ancestors and final link). Fail closed on any symlink in the chain.
 * Both root and candidate must already exist.
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
 * Create directories component-by-component without following symlinks.
 * Existing components must be real directories (not symlinks). New components
 * are created one level at a time; after each create we re-lstat to reject
 * races that plant a symlink.
 *
 * @param {string} dirPath
 * @param {{ mode?: number }} [opts]
 * @returns {Promise<string>} absolute path created/validated
 */
export async function mkdirpNoFollow(dirPath, opts = {}) {
  assertNoFollowAvailable();
  const mode = opts.mode != null ? opts.mode : 0o700;
  const abs = path.resolve(String(dirPath));
  if (abs.includes('\0')) {
    throw new UnsafePathError(
      `mkdirpNoFollow: path contains null byte (fail closed)`,
      { code: 'NULL_BYTE', path: abs },
    );
  }

  // Validate existing ancestors (allow system aliases only).
  await assertNoSymlinkAncestors(abs, {
    mustExist: false,
    label: 'mkdirpNoFollow',
  });

  const root = path.parse(abs).root;
  const rel = path.relative(root, abs);
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);

  let cur = process.platform === 'win32' ? root : '';
  for (let i = 0; i < parts.length; i += 1) {
    cur = cur === '' ? path.sep + parts[i] : path.join(cur, parts[i]);
    const st = await lstatOrNull(cur);
    if (st) {
      if (st.isSymbolicLink()) {
        const allowed = await isAllowedSystemPathSymlink(cur);
        if (!allowed) {
          throw new UnsafePathError(
            `mkdirpNoFollow: refusing symlink component (fail closed): ${cur}`,
            { code: 'SYMLINK', path: cur },
          );
        }
        // Allowed system alias: continue walking the lexical path (mkdir will
        // operate under the real volume via OS resolution for that alias only).
        continue;
      }
      if (!st.isDirectory()) {
        throw new UnsafePathError(
          `mkdirpNoFollow: component is not a directory (fail closed): ${cur}`,
          { code: 'NOT_DIRECTORY', path: cur },
        );
      }
      continue;
    }

    // Missing: create this single component only (never recursive).
    try {
      await mkdir(cur, { mode });
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'EEXIST') {
        throw err;
      }
      // Race: something appeared — fall through to revalidate.
    }

    // Revalidate: must now be a real directory, not a symlink.
    const after = await lstatOrNull(cur);
    if (!after) {
      throw new UnsafePathError(
        `mkdirpNoFollow: component missing after create (fail closed): ${cur}`,
        { code: 'MISSING', path: cur },
      );
    }
    if (after.isSymbolicLink()) {
      throw new UnsafePathError(
        `mkdirpNoFollow: component became a symlink (fail closed): ${cur}`,
        { code: 'SYMLINK', path: cur },
      );
    }
    if (!after.isDirectory()) {
      throw new UnsafePathError(
        `mkdirpNoFollow: component is not a directory after create (fail closed): ${cur}`,
        { code: 'NOT_DIRECTORY', path: cur },
      );
    }
  }

  // Private mode on the final directory via fd (never chmod a symlink).
  await tryChmodNoFollow(abs, mode, { directory: true });
  return abs;
}

/**
 * Ensure a private directory (0700) without following symlinks.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function ensurePrivateDirNoFollow(dir) {
  return mkdirpNoFollow(dir, { mode: 0o700 });
}

/**
 * Unpredictable same-directory temp path basenames.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string}
 */
export function randomTempPath(dir, prefix = '.aicb-tmp-') {
  const name = `${prefix}${randomBytes(16).toString('hex')}`;
  return path.join(path.resolve(String(dir)), name);
}

/**
 * Revalidate parent directory and destination immediately before rename.
 * Parent must be a real directory. Destination must not be a pre-existing
 * symlink (or non-file special node). Missing destination is OK.
 *
 * @param {string} parentDir
 * @param {string} destPath
 * @returns {Promise<void>}
 */
export async function revalidateBeforeRename(parentDir, destPath) {
  const parent = path.resolve(String(parentDir));
  const dest = path.resolve(String(destPath));

  if (path.dirname(dest) !== parent) {
    throw new UnsafePathError(
      `revalidateBeforeRename: destination not in parent (fail closed): ${dest}`,
      { code: 'PARENT_MISMATCH', path: dest },
    );
  }

  const parentSt = await lstatOrNull(parent);
  if (!parentSt) {
    throw new UnsafePathError(
      `revalidateBeforeRename: parent missing (fail closed): ${parent}`,
      { code: 'PARENT_MISSING', path: parent },
    );
  }
  if (parentSt.isSymbolicLink()) {
    throw new UnsafePathError(
      `revalidateBeforeRename: parent is a symlink (fail closed): ${parent}`,
      { code: 'SYMLINK', path: parent },
    );
  }
  if (!parentSt.isDirectory()) {
    throw new UnsafePathError(
      `revalidateBeforeRename: parent is not a directory (fail closed): ${parent}`,
      { code: 'NOT_DIRECTORY', path: parent },
    );
  }

  const destSt = await lstatOrNull(dest);
  if (destSt) {
    if (destSt.isSymbolicLink()) {
      throw new UnsafePathError(
        `revalidateBeforeRename: destination is a symlink (fail closed): ${dest}`,
        { code: 'SYMLINK_DEST', path: dest },
      );
    }
    if (!destSt.isFile()) {
      throw new UnsafePathError(
        `revalidateBeforeRename: destination is not a regular file (fail closed): ${dest}`,
        { code: 'NOT_REGULAR', path: dest },
      );
    }
  }
}

/**
 * Atomically replace a file without following leaf/intermediate symlinks.
 *
 * 1. Ensure parent via mkdirpNoFollow
 * 2. Create unpredictable same-dir temp with O_CREAT|O_EXCL|O_NOFOLLOW, mode
 * 3. Write + fsync + close
 * 4. Revalidate parent + destination (reject dest symlink)
 * 5. rename temp → dest
 *
 * Never opens or chmods a pre-existing destination symlink.
 *
 * @param {string} filePath
 * @param {string | Buffer} data
 * @param {{ mode?: number, fsync?: boolean }} [opts]
 * @returns {Promise<{ path: string }>}
 */
export async function writeFileAtomicNoFollow(filePath, data, opts = {}) {
  assertNoFollowAvailable();
  const mode = opts.mode != null ? opts.mode : 0o600;
  const doFsync = opts.fsync !== false;
  const abs = path.resolve(String(filePath));
  if (abs.includes('\0')) {
    throw new UnsafePathError(
      `writeFileAtomicNoFollow: path contains null byte (fail closed)`,
      { code: 'NULL_BYTE', path: abs },
    );
  }

  const parent = path.dirname(abs);
  await mkdirpNoFollow(parent, { mode: 0o700 });

  // Reject destination symlink before any exclusive open of temp (fast path).
  {
    const destSt = await lstatOrNull(abs);
    if (destSt?.isSymbolicLink()) {
      throw new UnsafePathError(
        `writeFileAtomicNoFollow: destination is a symlink (fail closed): ${abs}`,
        { code: 'SYMLINK_DEST', path: abs },
      );
    }
    if (destSt && !destSt.isFile()) {
      throw new UnsafePathError(
        `writeFileAtomicNoFollow: destination is not a regular file (fail closed): ${abs}`,
        { code: 'NOT_REGULAR', path: abs },
      );
    }
  }

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const flags = safeOpenExclusiveWriteFlags();

  /** @type {string | null} */
  let tmpPath = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomTempPath(parent);
    try {
      const handle = await open(candidate, flags, mode);
      tmpPath = candidate;
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
        // Ensure mode on the fd (create mode can be masked by umask).
        await handle.chmod(mode).catch(() => {});
        if (doFsync) {
          await handle.sync().catch(() => {});
        }
      } finally {
        await handle.close().catch(() => {});
      }
      break;
    } catch (err) {
      if (err instanceof UnsafePathError) throw err;
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        tmpPath = null;
        continue;
      }
      rethrowOpenError(err, candidate);
    }
  }

  if (tmpPath == null) {
    throw new UnsafePathError(
      `writeFileAtomicNoFollow: failed to create exclusive temp (fail closed): ${parent}`,
      { code: 'TEMP_CREATE', path: parent },
    );
  }

  try {
    // Immediately before rename: revalidate parent + dest (race window close).
    await revalidateBeforeRename(parent, abs);
    await rename(tmpPath, abs);
    tmpPath = null;
  } finally {
    if (tmpPath != null) {
      await unlink(tmpPath).catch(() => {});
    }
  }

  return { path: abs };
}

/**
 * Private file write (0600) via atomic no-follow replacement.
 * @param {string} filePath
 * @param {string | Buffer} data
 * @returns {Promise<{ path: string }>}
 */
export async function writePrivateFileNoFollow(filePath, data) {
  return writeFileAtomicNoFollow(filePath, data, { mode: 0o600, fsync: true });
}

/**
 * Copy a regular file to dest without following a symlink at source or dest.
 * Dest is written via atomic no-follow replacement (mode 0600).
 *
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ bytes: number }>}
 */
export async function copyFileNoFollow(srcPath, destPath, opts = {}) {
  const buf = await readFileNoFollow(srcPath, opts);
  await writeFileAtomicNoFollow(destPath, buf, { mode: 0o600, fsync: true });
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
