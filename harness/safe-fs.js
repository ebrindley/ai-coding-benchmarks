/**
 * Fail-closed filesystem I/O that never follows symlinks.
 *
 * Read path: open with O_NOFOLLOW (where supported), fstat must be a regular
 * file, then bounded read from the held descriptor. Optional expected
 * (dev,ino) identity pins close leaf swap races (digest / evidence reads).
 *
 * Write path (campaign boundary) — pinned-boundary strategy:
 * Node has no portable openat/renameat. Pathname open/rename always walk
 * intermediate components, and O_NOFOLLOW protects only the leaf. Therefore:
 * 1. Pin every existing directory component with O_DIRECTORY|O_NOFOLLOW,
 *    holding FDs and recording (dev,ino) identity.
 * 2. Re-assert that held-fd identity and path-walk identity still match
 *    before every pathname open/rename (full chain, not only the parent).
 * 3. On Linux, prefer /proc/self/fd/<dirfd>/<name> for leaf create/rename so
 *    the operation is relative to the pinned parent inode (strongest portable
 *    construction available without native openat).
 * 4. Fail closed when O_NOFOLLOW/O_DIRECTORY are unavailable or identity
 *    cannot be established. Never follow user symlinks; macOS /tmp and /var
 *    volume aliases remain the only allowed symlink components.
 *
 * Provider children must never gain access to campaign-control storage via
 * ancestor replacement between validation and open/replace.
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
 * True when O_DIRECTORY is available (required to pin directory identity).
 * @returns {boolean}
 */
export function hasDirectoryOpen() {
  return typeof constants.O_DIRECTORY === 'number';
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
 * Assert directory pin primitives are available; fail closed otherwise.
 * @returns {void}
 */
export function assertDirectoryOpenAvailable() {
  assertNoFollowAvailable();
  if (!hasDirectoryOpen()) {
    throw new UnsafePathError(
      'O_DIRECTORY is unavailable; refusing campaign boundary pin (fail closed)',
      { code: 'DIRECTORY_OPEN_UNAVAILABLE' },
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
 * Open flags: directory pin (read-only + directory + no-follow).
 * @returns {number}
 */
export function safeOpenDirectoryFlags() {
  assertDirectoryOpenAvailable();
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

/**
 * Exclusive create + write + no-follow (temp files / lock files). Requires O_NOFOLLOW.
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
 * Linux /proc/self/fd/<dirfd>/<name> lets leaf open/rename target a held
 * directory inode without re-walking replaced ancestors. Not available on
 * macOS (/dev/fd/N is not a directory mount).
 * @returns {boolean}
 */
export function canUseFdRelativePaths() {
  return process.platform === 'linux';
}

/**
 * Build a leaf path relative to an open directory fd (Linux only).
 * Returns null when the construction is unavailable.
 *
 * @param {number} dirFd
 * @param {string} baseName - single path component (no separators)
 * @returns {string | null}
 */
export function fdRelativeChildPath(dirFd, baseName) {
  if (!canUseFdRelativePaths()) return null;
  const name = String(baseName);
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new UnsafePathError(
      `fdRelativeChildPath: invalid leaf name (fail closed): ${name}`,
      { code: 'INVALID_NAME', path: name },
    );
  }
  if (!Number.isInteger(dirFd) || dirFd < 0) {
    throw new UnsafePathError(
      `fdRelativeChildPath: invalid directory fd (fail closed)`,
      { code: 'INVALID_FD' },
    );
  }
  return `/proc/self/fd/${dirFd}/${name}`;
}

/**
 * @typedef {{
 *   path: string,
 *   realPath: string,
 *   dev: number,
 *   ino: number,
 *   handle: import('node:fs/promises').FileHandle,
 *   allowedAlias?: boolean,
 * }} PinnedDir
 *
 * @typedef {{
 *   path: string,
 *   dirs: PinnedDir[],
 *   release: () => Promise<void>,
 * }} BoundaryPin
 */

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
 * Best-effort close of a pin's held directory handles.
 * @param {PinnedDir[]} dirs
 * @returns {Promise<void>}
 */
async function closePinnedDirs(dirs) {
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const d = dirs[i];
    if (d?.handle) {
      await d.handle.close().catch(() => {});
    }
  }
}

/**
 * Open a real directory at `openPath` with O_DIRECTORY|O_NOFOLLOW and
 * confirm it is still a directory. When `expected` is provided, require
 * matching (dev,ino).
 *
 * @param {string} openPath
 * @param {string} labelPath - path used in errors (lexical)
 * @param {{ dev?: number, ino?: number }} [expected]
 * @returns {Promise<PinnedDir>}
 */
async function openPinnedDirectory(openPath, labelPath, expected = {}) {
  assertDirectoryOpenAvailable();
  /** @type {import('node:fs/promises').FileHandle} */
  let handle;
  try {
    handle = await open(openPath, safeOpenDirectoryFlags());
  } catch (err) {
    rethrowOpenError(err, labelPath);
  }
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) {
      throw new UnsafePathError(
        `pinned path is not a directory (fail closed): ${labelPath}`,
        { code: 'NOT_DIRECTORY', path: labelPath },
      );
    }
    if (
      expected.dev != null &&
      expected.ino != null &&
      (st.dev !== expected.dev || st.ino !== expected.ino)
    ) {
      throw new UnsafePathError(
        `pinned directory identity mismatch (fail closed): ${labelPath}`,
        { code: 'IDENTITY_MISMATCH', path: labelPath },
      );
    }
    return {
      path: labelPath,
      realPath: openPath,
      dev: st.dev,
      ino: st.ino,
      handle,
    };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/**
 * Pin every existing directory component from filesystem root to `dirPath`.
 * Holds O_DIRECTORY|O_NOFOLLOW FDs and records (dev,ino) so later operations
 * can detect ancestor replacement. Allowed macOS /tmp and /var aliases are
 * pinned via their realpath directory inode (user symlinks still rejected).
 *
 * Caller must invoke `pin.release()` (also available as releaseBoundaryPin).
 *
 * @param {string} dirPath
 * @param {{ label?: string }} [opts]
 * @returns {Promise<BoundaryPin>}
 */
export async function pinDirectoryBoundary(dirPath, opts = {}) {
  assertDirectoryOpenAvailable();
  const label = opts.label ?? 'pinDirectoryBoundary';
  const lexical = path.resolve(String(dirPath));
  if (lexical.includes('\0')) {
    throw new UnsafePathError(
      `${label}: path contains null byte (fail closed)`,
      { code: 'NULL_BYTE', path: lexical },
    );
  }

  // Policy pass: reject user symlink ancestors before opening pins.
  await assertNoSymlinkAncestors(lexical, {
    mustExist: true,
    label,
  });

  const root = path.parse(lexical).root;
  const rel = path.relative(root, lexical);
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);

  /** @type {PinnedDir[]} */
  const dirs = [];

  try {
    // Pin the volume root when it is a real directory (skip if unreadable).
    if (root && root !== '') {
      try {
        const rootPin = await openPinnedDirectory(root, root);
        dirs.push(rootPin);
      } catch {
        // Some environments cannot O_DIRECTORY the volume root; continue with
        // component pins. Identity of deeper components still binds the chain.
      }
    }

    let cur = process.platform === 'win32' ? root : '';
    for (let i = 0; i < parts.length; i += 1) {
      cur = cur === '' ? path.sep + parts[i] : path.join(cur, parts[i]);
      let st;
      try {
        st = await lstat(cur);
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT') {
          throw new UnsafePathError(
            `${label}: path component missing (fail closed): ${cur}`,
            { code: 'MISSING', path: cur },
          );
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
        // Pin the real directory behind the allowed alias (not the symlink node).
        let real;
        try {
          real = await realpath(cur);
        } catch (err) {
          throw new UnsafePathError(
            `${label}: failed to resolve allowed system alias (fail closed): ${cur}`,
            { code: 'REALPATH', path: cur },
          );
        }
        // Open real path without O_NOFOLLOW on the alias itself; realpath already
        // produced a non-symlink directory path for /private/tmp|/private/var.
        /** @type {import('node:fs/promises').FileHandle} */
        let handle;
        try {
          handle = await open(
            real,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
        } catch (err) {
          rethrowOpenError(err, cur);
        }
        try {
          const fst = await handle.stat();
          if (!fst.isDirectory()) {
            throw new UnsafePathError(
              `${label}: allowed alias realpath is not a directory (fail closed): ${cur}`,
              { code: 'NOT_DIRECTORY', path: cur },
            );
          }
          dirs.push({
            path: cur,
            realPath: real,
            dev: fst.dev,
            ino: fst.ino,
            handle,
            allowedAlias: true,
          });
        } catch (err) {
          await handle.close().catch(() => {});
          throw err;
        }
        continue;
      }

      if (!st.isDirectory()) {
        throw new UnsafePathError(
          `${label}: component is not a directory (fail closed): ${cur}`,
          { code: 'NOT_DIRECTORY', path: cur },
        );
      }

      // Prefer Linux fd-relative open from the previous pin when available so
      // intermediate path resolution cannot be redirected mid-walk.
      let openPath = cur;
      const prev = dirs.length > 0 ? dirs[dirs.length - 1] : null;
      if (prev && !prev.allowedAlias && canUseFdRelativePaths()) {
        const relOpen = fdRelativeChildPath(prev.handle.fd, parts[i]);
        if (relOpen) openPath = relOpen;
      }

      const pin = await openPinnedDirectory(openPath, cur, {
        dev: st.dev,
        ino: st.ino,
      });
      dirs.push(pin);
    }

    if (dirs.length === 0) {
      throw new UnsafePathError(
        `${label}: failed to pin any directory (fail closed): ${lexical}`,
        { code: 'PIN_EMPTY', path: lexical },
      );
    }

    // Final component of dirPath must be represented (or root-only path).
    const leaf = dirs[dirs.length - 1];
    // Re-check lexical leaf identity via path walk vs held fd.
    await assertPinnedBoundary({ path: lexical, dirs, release: async () => {} });

    return {
      path: lexical,
      dirs,
      release: async () => {
        await closePinnedDirs(dirs);
      },
    };
  } catch (err) {
    await closePinnedDirs(dirs);
    throw err;
  }
}

/**
 * Re-assert a boundary pin: each held FD still has the recorded (dev,ino)
 * directory identity, and a fresh path walk still names the same objects
 * (allowed system aliases still resolve to the pinned real inode).
 *
 * This is the confinement check that closes grandparent/ancestor replacement
 * between validation and pathname open/rename (fail closed on mismatch).
 *
 * @param {BoundaryPin} pin
 * @returns {Promise<void>}
 */
export async function assertPinnedBoundary(pin) {
  if (!pin || !Array.isArray(pin.dirs) || pin.dirs.length === 0) {
    throw new UnsafePathError(
      'assertPinnedBoundary: empty pin (fail closed)',
      { code: 'PIN_EMPTY' },
    );
  }

  for (const d of pin.dirs) {
    let fst;
    try {
      fst = await d.handle.stat();
    } catch (err) {
      throw new UnsafePathError(
        `assertPinnedBoundary: held directory fd lost (fail closed): ${d.path}`,
        { code: 'PIN_FD_LOST', path: d.path },
      );
    }
    if (!fst.isDirectory()) {
      throw new UnsafePathError(
        `assertPinnedBoundary: held fd is not a directory (fail closed): ${d.path}`,
        { code: 'NOT_DIRECTORY', path: d.path },
      );
    }
    if (fst.dev !== d.dev || fst.ino !== d.ino) {
      throw new UnsafePathError(
        `assertPinnedBoundary: held directory identity changed (fail closed): ${d.path}`,
        { code: 'IDENTITY_MISMATCH', path: d.path },
      );
    }

    // Path walk must still resolve to the same directory inode. Ancestor
    // replacement with a symlink or different directory fails here.
    let st;
    try {
      st = await lstat(d.path);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        throw new UnsafePathError(
          `assertPinnedBoundary: path component missing after pin (fail closed): ${d.path}`,
          { code: 'MISSING', path: d.path },
        );
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      if (!d.allowedAlias) {
        throw new UnsafePathError(
          `assertPinnedBoundary: path became a symlink (fail closed): ${d.path}`,
          { code: 'SYMLINK', path: d.path },
        );
      }
      const allowed = await isAllowedSystemPathSymlink(d.path);
      if (!allowed) {
        throw new UnsafePathError(
          `assertPinnedBoundary: path is not an allowed system alias (fail closed): ${d.path}`,
          { code: 'SYMLINK', path: d.path },
        );
      }
      let real;
      try {
        real = await realpath(d.path);
      } catch {
        throw new UnsafePathError(
          `assertPinnedBoundary: allowed alias unresolvable (fail closed): ${d.path}`,
          { code: 'REALPATH', path: d.path },
        );
      }
      // Confirm realpath directory still matches pinned identity.
      let realSt;
      try {
        realSt = await lstat(real);
      } catch {
        throw new UnsafePathError(
          `assertPinnedBoundary: allowed alias realpath missing (fail closed): ${d.path}`,
          { code: 'MISSING', path: d.path },
        );
      }
      if (realSt.isSymbolicLink() || !realSt.isDirectory()) {
        throw new UnsafePathError(
          `assertPinnedBoundary: allowed alias realpath not a directory (fail closed): ${d.path}`,
          { code: 'NOT_DIRECTORY', path: d.path },
        );
      }
      if (realSt.dev !== d.dev || realSt.ino !== d.ino) {
        throw new UnsafePathError(
          `assertPinnedBoundary: allowed alias identity mismatch (fail closed): ${d.path}`,
          { code: 'IDENTITY_MISMATCH', path: d.path },
        );
      }
      continue;
    }

    if (!st.isDirectory()) {
      throw new UnsafePathError(
        `assertPinnedBoundary: path is not a directory (fail closed): ${d.path}`,
        { code: 'NOT_DIRECTORY', path: d.path },
      );
    }
    if (st.dev !== d.dev || st.ino !== d.ino) {
      throw new UnsafePathError(
        `assertPinnedBoundary: path identity mismatch — ancestor replaced (fail closed): ${d.path}`,
        { code: 'IDENTITY_MISMATCH', path: d.path },
      );
    }
  }
}

/**
 * Release held directory FDs from a boundary pin.
 * @param {BoundaryPin | null | undefined} pin
 * @returns {Promise<void>}
 */
export async function releaseBoundaryPin(pin) {
  if (!pin) return;
  if (typeof pin.release === 'function') {
    await pin.release();
    return;
  }
  if (Array.isArray(pin.dirs)) {
    await closePinnedDirs(pin.dirs);
  }
}

/**
 * Parent pin leaf directory entry (deepest component).
 * @param {BoundaryPin} pin
 * @returns {PinnedDir}
 */
function pinLeafDir(pin) {
  return pin.dirs[pin.dirs.length - 1];
}

/**
 * Resolve the pathname used for a leaf create/open/rename under a pinned parent.
 * Prefers Linux fd-relative paths; otherwise lexical join after caller has
 * assertPinnedBoundary'd.
 *
 * @param {BoundaryPin} pin
 * @param {string} baseName
 * @returns {string}
 */
function leafPathUnderPin(pin, baseName) {
  const leaf = pinLeafDir(pin);
  const fdRel = fdRelativeChildPath(leaf.handle.fd, baseName);
  if (fdRel) return fdRel;
  return path.join(pin.path, baseName);
}

/**
 * Create a new file exclusively without following symlinks and without rename.
 *
 * Used for lock-style acquisition that must not replace an existing file:
 * open with O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600 (default), complete write,
 * fsync, and close. Never opens a pre-existing path (including a leaf
 * symlink) for write-through.
 *
 * Parent is pinned (held directory FDs + identity) for the full ancestor
 * chain before open so intermediate/grandparent user symlink swaps cannot
 * redirect the create. chmod(mode) and fsync are part of the contract:
 * failures remove the partial regular file and rethrow (fail closed).
 *
 * @param {string} filePath
 * @param {string | Buffer} data
 * @param {{ mode?: number, fsync?: boolean }} [opts]
 * @returns {Promise<{ path: string }>}
 */
export async function createFileExclusiveNoFollow(filePath, data, opts = {}) {
  assertDirectoryOpenAvailable();
  const mode = opts.mode != null ? opts.mode : 0o600;
  const doFsync = opts.fsync !== false;
  const abs = path.resolve(String(filePath));
  if (abs.includes('\0')) {
    throw new UnsafePathError(
      `createFileExclusiveNoFollow: path contains null byte (fail closed)`,
      { code: 'NULL_BYTE', path: abs },
    );
  }

  const parent = path.dirname(abs);
  const baseName = path.basename(abs);
  if (!baseName || baseName === '.' || baseName === '..') {
    throw new UnsafePathError(
      `createFileExclusiveNoFollow: invalid leaf name (fail closed): ${abs}`,
      { code: 'INVALID_NAME', path: abs },
    );
  }

  const pin = await pinDirectoryBoundary(parent, {
    label: 'createFileExclusiveNoFollow parent',
  });
  /** @type {boolean} */
  let created = false;
  /** @type {string | null} */
  let createdPath = null;
  try {
    await assertPinnedBoundary(pin);

    // Refuse pre-existing leaf symlink without following (clearer than EEXIST alone).
    const destSt = await lstatOrNull(abs);
    if (destSt?.isSymbolicLink()) {
      throw new UnsafePathError(
        `createFileExclusiveNoFollow: path is a symlink (fail closed): ${abs}`,
        { code: 'SYMLINK', path: abs },
      );
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const flags = safeOpenExclusiveWriteFlags();
    const openPath = leafPathUnderPin(pin, baseName);

    // Re-assert immediately before pathname/fd-relative open.
    await assertPinnedBoundary(pin);

    /** @type {import('node:fs/promises').FileHandle | null} */
    let handle = null;
    try {
      try {
        handle = await open(openPath, flags, mode);
      } catch (err) {
        rethrowOpenError(err, abs);
      }
      created = true;
      createdPath = abs;

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
      // Create mode can be masked by umask; enforce private bits on the fd.
      // Fail closed: do not swallow chmod/sync errors (mode 0600 + durability).
      await handle.chmod(mode);
      if (doFsync) {
        await handle.sync();
      }
    } catch (err) {
      if (created && createdPath) {
        // Incomplete exclusive create: remove only the partial regular file we created.
        // Prefer fd-relative unlink when available so we do not follow a swapped path.
        const unlinkPath = leafPathUnderPin(pin, baseName);
        await unlink(unlinkPath).catch(async () => {
          await unlink(createdPath).catch(() => {});
        });
      }
      throw err;
    } finally {
      if (handle != null) {
        await handle.close().catch(() => {});
        handle = null;
      }
    }
    return { path: abs };
  } finally {
    await releaseBoundaryPin(pin);
  }
}

/**
 * Read a regular file without following symlinks.
 *
 * Opens with O_NOFOLLOW, confirms the held fd is a regular file (and matches
 * optional expected (dev,ino) identity from a prior lstat), then reads through
 * that held descriptor only — never a second pathname open.
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number, expectedDev?: number, expectedIno?: number }} [opts]
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
    if (
      opts.expectedDev != null &&
      opts.expectedIno != null &&
      (st.dev !== opts.expectedDev || st.ino !== opts.expectedIno)
    ) {
      throw new UnsafePathError(
        `file identity mismatch after open (fail closed): ${abs}`,
        { code: 'IDENTITY_MISMATCH', path: abs },
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
 * @param {{ maxBytes?: number, expectedDev?: number, expectedIno?: number }} [opts]
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
 * Revalidate parent directory chain and destination immediately before rename.
 *
 * When a BoundaryPin is provided, assertPinnedBoundary enforces held-fd +
 * path-walk identity for the full ancestor chain (not only the immediate
 * parent). Without a pin, performs a full no-symlink ancestor walk plus
 * parent directory checks. Destination must not be a pre-existing symlink
 * (or non-file special node). Missing destination is OK.
 *
 * @param {string} parentDir
 * @param {string} destPath
 * @param {{ pin?: BoundaryPin }} [opts]
 * @returns {Promise<void>}
 */
export async function revalidateBeforeRename(parentDir, destPath, opts = {}) {
  const parent = path.resolve(String(parentDir));
  const dest = path.resolve(String(destPath));

  if (path.dirname(dest) !== parent) {
    throw new UnsafePathError(
      `revalidateBeforeRename: destination not in parent (fail closed): ${dest}`,
      { code: 'PARENT_MISMATCH', path: dest },
    );
  }

  if (opts.pin) {
    if (path.resolve(opts.pin.path) !== parent) {
      throw new UnsafePathError(
        `revalidateBeforeRename: pin path mismatch (fail closed): ${opts.pin.path} vs ${parent}`,
        { code: 'PIN_MISMATCH', path: parent },
      );
    }
    await assertPinnedBoundary(opts.pin);
  } else {
    // Full ancestor chain — not merely the immediate parent — so a swapped
    // grandparent symlink is rejected before rename.
    await assertNoSymlinkAncestors(parent, {
      mustExist: true,
      label: 'revalidateBeforeRename',
    });
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
 * Pinned-boundary strategy (Node has no portable openat/renameat):
 * 1. Ensure parent via mkdirpNoFollow
 * 2. Pin full parent ancestor chain (held O_DIRECTORY|O_NOFOLLOW FDs + identity)
 * 3. Create unpredictable same-dir temp with O_CREAT|O_EXCL|O_NOFOLLOW
 *    (Linux: via /proc/self/fd/<parentfd>/name; else lexical path after pin assert)
 * 4. Write + chmod + fsync on the held fd (fail closed; clean only our temp)
 * 5. Re-assert pin identity + destination (reject dest symlink / full chain)
 * 6. rename temp → dest (fd-relative when available)
 *
 * Never opens or chmods a pre-existing destination symlink.
 *
 * @param {string} filePath
 * @param {string | Buffer} data
 * @param {{ mode?: number, fsync?: boolean }} [opts]
 * @returns {Promise<{ path: string }>}
 */
export async function writeFileAtomicNoFollow(filePath, data, opts = {}) {
  assertDirectoryOpenAvailable();
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
  const destBase = path.basename(abs);
  if (!destBase || destBase === '.' || destBase === '..') {
    throw new UnsafePathError(
      `writeFileAtomicNoFollow: invalid leaf name (fail closed): ${abs}`,
      { code: 'INVALID_NAME', path: abs },
    );
  }

  await mkdirpNoFollow(parent, { mode: 0o700 });

  const pin = await pinDirectoryBoundary(parent, {
    label: 'writeFileAtomicNoFollow parent',
  });

  /** @type {string | null} */
  let tmpBase = null;
  /** @type {string | null} */
  let tmpLexical = null;

  try {
    await assertPinnedBoundary(pin);

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

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidateBase = `${'.aicb-tmp-'}${randomBytes(16).toString('hex')}`;
      await assertPinnedBoundary(pin);
      const openPath = leafPathUnderPin(pin, candidateBase);
      try {
        const handle = await open(openPath, flags, mode);
        tmpBase = candidateBase;
        tmpLexical = path.join(parent, candidateBase);
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
          // Fail closed: do not swallow chmod/fsync errors.
          await handle.chmod(mode);
          if (doFsync) {
            await handle.sync();
          }
        } catch (err) {
          // Partial temp: remove only the file we created, then rethrow.
          await handle.close().catch(() => {});
          const unlinkPath = leafPathUnderPin(pin, candidateBase);
          await unlink(unlinkPath).catch(async () => {
            if (tmpLexical) await unlink(tmpLexical).catch(() => {});
          });
          tmpBase = null;
          tmpLexical = null;
          throw err;
        }
        await handle.close().catch(() => {});
        break;
      } catch (err) {
        if (err instanceof UnsafePathError) throw err;
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'EEXIST') {
          tmpBase = null;
          tmpLexical = null;
          continue;
        }
        rethrowOpenError(err, path.join(parent, candidateBase));
      }
    }

    if (tmpBase == null || tmpLexical == null) {
      throw new UnsafePathError(
        `writeFileAtomicNoFollow: failed to create exclusive temp (fail closed): ${parent}`,
        { code: 'TEMP_CREATE', path: parent },
      );
    }

    // Immediately before rename: full-chain pin identity + dest revalidation.
    await revalidateBeforeRename(parent, abs, { pin });

    const renameFrom = leafPathUnderPin(pin, tmpBase);
    const renameTo = leafPathUnderPin(pin, destBase);
    await rename(renameFrom, renameTo);
    tmpBase = null;
    tmpLexical = null;
  } finally {
    if (tmpBase != null) {
      const unlinkPath = leafPathUnderPin(pin, tmpBase);
      await unlink(unlinkPath).catch(async () => {
        if (tmpLexical) await unlink(tmpLexical).catch(() => {});
      });
    }
    await releaseBoundaryPin(pin);
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
 * Then bounded nofollow read through a held descriptor after identity check.
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

  // Read through held no-follow fd, pinned to the lstat identity.
  return readFileNoFollow(expected, {
    ...opts,
    expectedDev: st.dev,
    expectedIno: st.ino,
  });
}
