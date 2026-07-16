#!/usr/bin/env node
/**
 * Trusted campaign FS boundary helper.
 *
 * Parent spawns this process with cwd set to the intended parent directory.
 * The OS resolves cwd at spawn and the child holds that directory vnode/inode
 * for the process lifetime. Relative leaf ops therefore stay anchored even if
 * a lexical ancestor is renamed or replaced after spawn.
 *
 * Protocol (stdin JSON → stdout JSON, no argv ops, no shell):
 *   {
 *     op: 'exclusive-create' | 'atomic-replace' | 'unlink',
 *     expectedDev: number,
 *     expectedIno: number,
 *     name?: string,       // exclusive-create | unlink (basename only)
 *     destName?: string,   // atomic-replace destination basename
 *     tmpName?: string,    // atomic-replace temp basename (optional)
 *     dataB64?: string,    // file body (base64)
 *     mode?: number,       // default 0o600
 *     fsync?: boolean,     // default true
 *     testBarrier?: { readyName: string, goName: string } // test-only
 *   }
 *
 * Never executes caller-supplied commands. Basename-only paths. Fail closed.
 */

import fs from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_DATA_BYTES = 64 * 1024 * 1024;
const BARRIER_WAIT_MS = 10_000;

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  const out = JSON.stringify({
    ok: false,
    code: String(code).slice(0, 64),
    message: String(message).slice(0, 512),
  });
  process.stdout.write(out);
  process.stdout.write('\n');
  process.exit(1);
}

/**
 * @param {Record<string, unknown>} body
 * @returns {never}
 */
function succeed(body = {}) {
  const out = JSON.stringify({ ok: true, ...body });
  process.stdout.write(out);
  process.stdout.write('\n');
  process.exit(0);
}

/**
 * Basename-only leaf validation (no separators, no absolute, no . / ..).
 * @param {unknown} name
 * @param {string} label
 * @returns {string}
 */
function requireBasename(name, label) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    fail('INVALID_NAME', `${label}: invalid leaf name`);
  }
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.isAbsolute(name)
  ) {
    fail('INVALID_NAME', `${label}: leaf must be basename-only`);
  }
  return name;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function requireIdentityNumber(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail('INVALID_IDENTITY', `${label} must be a finite number`);
  }
  return v;
}

/**
 * Stat held cwd (`.`) and require directory identity match.
 * @param {number} expectedDev
 * @param {number} expectedIno
 * @returns {{ dev: number, ino: number }}
 */
function authenticateCwd(expectedDev, expectedIno) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    fail('NOFOLLOW_UNAVAILABLE', 'O_NOFOLLOW unavailable');
  }
  if (typeof constants.O_DIRECTORY !== 'number') {
    fail('DIRECTORY_OPEN_UNAVAILABLE', 'O_DIRECTORY unavailable');
  }

  let fd;
  try {
    fd = fs.openSync(
      '.',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    fail(code || 'CWD_OPEN', `failed to open cwd: ${code || 'unknown'}`);
  }

  try {
    const st = fs.fstatSync(fd);
    if (!st.isDirectory()) {
      fail('NOT_DIRECTORY', 'cwd is not a directory');
    }
    // Compare as numbers; Node stats.ino is number on supported platforms.
    if (st.dev !== expectedDev || Number(st.ino) !== Number(expectedIno)) {
      fail(
        'IDENTITY_MISMATCH',
        `cwd identity mismatch (dev/ino)`,
      );
    }
    return { dev: st.dev, ino: Number(st.ino) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Optional deterministic test barrier (relative names in authenticated cwd).
 * Only when AICB_FS_HELPER_TEST_BARRIER=1; otherwise reject if present.
 * @param {unknown} barrier
 */
function maybeTestBarrier(barrier) {
  if (barrier == null) return;
  if (process.env.AICB_FS_HELPER_TEST_BARRIER !== '1') {
    fail('TEST_BARRIER_DENIED', 'testBarrier not permitted');
  }
  if (typeof barrier !== 'object' || barrier === null) {
    fail('INVALID_BARRIER', 'testBarrier must be an object');
  }
  const readyName = requireBasename(
    /** @type {{ readyName?: unknown }} */ (barrier).readyName,
    'testBarrier.readyName',
  );
  const goName = requireBasename(
    /** @type {{ goName?: unknown }} */ (barrier).goName,
    'testBarrier.goName',
  );
  try {
    fs.writeFileSync(readyName, '1', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    fail(code || 'BARRIER_READY', `testBarrier ready write failed: ${code}`);
  }
  const start = Date.now();
  while (Date.now() - start < BARRIER_WAIT_MS) {
    try {
      fs.statSync(goName);
      return;
    } catch {
      // spin briefly; Atomics.wait needs SharedArrayBuffer
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 20);
    }
  }
  fail('BARRIER_TIMEOUT', 'testBarrier go file not observed');
}

/**
 * @param {string} name
 * @param {Buffer} data
 * @param {number} mode
 * @param {boolean} doFsync
 */
function exclusiveCreate(name, data, mode, doFsync) {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(name, flags, mode);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      fail('SYMLINK', `refusing symlink leaf: ${name}`);
    }
    if (code === 'EEXIST') {
      fail('EEXIST', `already exists: ${name}`);
    }
    fail(code || 'OPEN', `exclusive create failed: ${code || 'unknown'}`);
  }

  try {
    let offset = 0;
    while (offset < data.length) {
      const n = fs.writeSync(fd, data, offset, data.length - offset, offset);
      offset += n;
    }
    // Create mode can be masked by umask; enforce on the held fd (fail closed).
    fs.fchmodSync(fd, mode);
    if (doFsync) {
      fs.fsyncSync(fd);
    }
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(name);
    } catch {
      /* ignore */
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    fail(code || 'WRITE', `write/chmod/fsync failed: ${code || 'unknown'}`);
  }

  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} name
 */
function unlinkBasename(name) {
  try {
    const st = fs.lstatSync(name);
    if (st.isSymbolicLink()) {
      fail('SYMLINK', `refusing to unlink symlink: ${name}`);
    }
    if (!st.isFile()) {
      fail('NOT_REGULAR', `refusing to unlink non-file: ${name}`);
    }
    fs.unlinkSync(name);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      succeed({ unlinked: false });
    }
    fail(code || 'UNLINK', `unlink failed: ${code || 'unknown'}`);
  }
  succeed({ unlinked: true });
}

/**
 * @param {string} destName
 * @param {Buffer} data
 * @param {number} mode
 * @param {boolean} doFsync
 * @param {number} expectedDev
 * @param {number} expectedIno
 * @param {string | null} preferredTmp
 * @returns {string} temp basename used (before rename)
 */
function atomicReplace(
  destName,
  data,
  mode,
  doFsync,
  expectedDev,
  expectedIno,
  preferredTmp,
) {
  // Reject destination symlink before creating temp (clearer diagnosis).
  try {
    const destSt = fs.lstatSync(destName);
    if (destSt.isSymbolicLink()) {
      fail('SYMLINK_DEST', `destination is a symlink: ${destName}`);
    }
    if (!destSt.isFile()) {
      fail('NOT_REGULAR', `destination is not a regular file: ${destName}`);
    }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      fail(code || 'LSTAT_DEST', `destination lstat failed: ${code}`);
    }
  }

  /** @type {string | null} */
  let tmpName = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate =
      attempt === 0 && preferredTmp
        ? preferredTmp
        : `.aicb-tmp-${randomBytes(16).toString('hex')}`;
    requireBasename(candidate, 'tmpName');
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(candidate, flags, mode);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') continue;
      if (code === 'ELOOP' || code === 'EMLINK') {
        fail('SYMLINK', `refusing symlink leaf: ${candidate}`);
      }
      fail(code || 'OPEN', `temp exclusive create failed: ${code}`);
    }
    try {
      let offset = 0;
      while (offset < data.length) {
        const n = fs.writeSync(fd, data, offset, data.length - offset, offset);
        offset += n;
      }
      fs.fchmodSync(fd, mode);
      if (doFsync) fs.fsyncSync(fd);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(candidate);
      } catch {
        /* ignore */
      }
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      fail(code || 'WRITE', `temp write/chmod/fsync failed: ${code}`);
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    tmpName = candidate;
    break;
  }

  if (tmpName == null) {
    fail('TEMP_CREATE', 'failed to create exclusive temp in authenticated cwd');
  }

  // Re-auth before rename (cwd is held; this catches unexpected cwd change).
  authenticateCwd(expectedDev, expectedIno);

  try {
    const destSt = fs.lstatSync(destName);
    if (destSt.isSymbolicLink()) {
      try {
        fs.unlinkSync(tmpName);
      } catch {
        /* ignore */
      }
      fail('SYMLINK_DEST', `destination became a symlink: ${destName}`);
    }
    if (!destSt.isFile()) {
      try {
        fs.unlinkSync(tmpName);
      } catch {
        /* ignore */
      }
      fail('NOT_REGULAR', `destination is not a regular file: ${destName}`);
    }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmpName);
      } catch {
        /* ignore */
      }
      fail(code || 'LSTAT_DEST', `destination lstat failed: ${code}`);
    }
  }

  try {
    // Relative rename stays inside the held cwd directory inode.
    fs.renameSync(tmpName, destName);
  } catch (err) {
    try {
      fs.unlinkSync(tmpName);
    } catch {
      /* ignore */
    }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    fail(code || 'RENAME', `rename failed: ${code || 'unknown'}`);
  }
  return tmpName;
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_DATA_BYTES + 1024 * 1024) {
      fail('REQUEST_TOO_LARGE', 'helper request exceeds bound');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    fail('EMPTY_REQUEST', 'empty helper request');
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    fail('MALFORMED_REQUEST', 'helper request is not JSON');
  }
  if (req == null || typeof req !== 'object' || Array.isArray(req)) {
    fail('MALFORMED_REQUEST', 'helper request must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (req);
}

async function main() {
  const req = await readRequest();
  const op = req.op;
  if (typeof op !== 'string') {
    fail('INVALID_OP', 'op is required');
  }

  const expectedDev = requireIdentityNumber(req.expectedDev, 'expectedDev');
  const expectedIno = requireIdentityNumber(req.expectedIno, 'expectedIno');
  authenticateCwd(expectedDev, expectedIno);
  maybeTestBarrier(req.testBarrier);

  const mode =
    req.mode != null && typeof req.mode === 'number' && Number.isFinite(req.mode)
      ? req.mode
      : 0o600;
  const doFsync = req.fsync !== false;

  if (op === 'unlink') {
    const name = requireBasename(req.name, 'name');
    // Re-auth is cheap; unlink only regular basenames in held cwd.
    authenticateCwd(expectedDev, expectedIno);
    unlinkBasename(name);
    return;
  }

  if (op === 'exclusive-create') {
    const name = requireBasename(req.name, 'name');
    if (typeof req.dataB64 !== 'string') {
      fail('INVALID_DATA', 'dataB64 is required');
    }
    let data;
    try {
      data = Buffer.from(req.dataB64, 'base64');
    } catch {
      fail('INVALID_DATA', 'dataB64 is not valid base64');
    }
    if (data.length > MAX_DATA_BYTES) {
      fail('DATA_TOO_LARGE', 'payload exceeds bound');
    }
    // Refuse pre-existing leaf symlink with a clear code.
    try {
      const st = fs.lstatSync(name);
      if (st.isSymbolicLink()) {
        fail('SYMLINK', `path is a symlink: ${name}`);
      }
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') {
        fail(code || 'LSTAT', `lstat failed: ${code}`);
      }
    }
    exclusiveCreate(name, data, mode, doFsync);
    succeed({ op, name });
    return;
  }

  if (op === 'atomic-replace') {
    const destName = requireBasename(req.destName, 'destName');
    const preferredTmp =
      req.tmpName != null ? requireBasename(req.tmpName, 'tmpName') : null;
    if (typeof req.dataB64 !== 'string') {
      fail('INVALID_DATA', 'dataB64 is required');
    }
    let data;
    try {
      data = Buffer.from(req.dataB64, 'base64');
    } catch {
      fail('INVALID_DATA', 'dataB64 is not valid base64');
    }
    if (data.length > MAX_DATA_BYTES) {
      fail('DATA_TOO_LARGE', 'payload exceeds bound');
    }
    const tmpName = atomicReplace(
      destName,
      data,
      mode,
      doFsync,
      expectedDev,
      expectedIno,
      preferredTmp,
    );
    succeed({ op, destName, tmpName });
    return;
  }

  fail('INVALID_OP', `unsupported op: ${String(op).slice(0, 32)}`);
}

main().catch((err) => {
  fail(
    'HELPER_CRASH',
    err instanceof Error ? err.message : String(err),
  );
});
