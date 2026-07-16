/**
 * Argv-safe subprocess runner for harness invokers.
 * Never uses a shell. Only harness-controlled env may be passed.
 * Corpus task YAML must never contribute env.
 *
 * Provider invocations must pass `campaignDir` so the process tree is wrapped
 * in OS confinement that denies read/write of the campaign control tree.
 * Unconfined provider spawn is refused (fail closed).
 *
 * Captured stdout/stderr are bounded. On timeout, the process group/tree is
 * terminated where the platform supports detached process groups.
 *
 * Capture fidelity: streams are collected as raw Buffer chunks and joined
 * before a single UTF-8 decode, so multi-byte sequences split across chunk
 * boundaries are not corrupted. Capture limits are applied in bytes.
 *
 * Remaining limitation: once decoded to a JS string for invoker consumers,
 * invalid UTF-8 byte sequences are replaced (U+FFFD). Digests of string
 * quarantine therefore match the decoded text re-encoded as UTF-8, not the
 * original invalid bytes. Prefer Buffer passthrough when callers need exact
 * raw bytes (see stdoutBytes/stderrBytes).
 */

import { spawn } from 'node:child_process';
import {
  wrapProviderCommand,
  applyProviderTempEnv,
} from './provider-confine.js';

/** Default max bytes retained per stream (rest discarded, length recorded). */
export const DEFAULT_CAPTURE_LIMIT = 256 * 1024;

/**
 * @typedef {object} SpawnResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {Buffer} [stdoutBytes] - exact retained raw bytes (pre-string decode)
 * @property {Buffer} [stderrBytes] - exact retained raw bytes (pre-string decode)
 * @property {string} [infraFailure]
 * @property {string} [signal]
 * @property {number} [stdoutTruncatedChars] - bytes discarded above capture limit
 * @property {number} [stderrTruncatedChars] - bytes discarded above capture limit
 * @property {boolean} [executionUnavailable]
 * @property {string[]} [confinedArgv]
 * @property {string} [confinedCommand]
 * @property {string} [privateTempDir] - confined private temp (cleaned after return)
 */

/**
 * Resolve env for a controlled spawn.
 * Uses the explicit `env` object when provided; otherwise a shallow copy of process.env.
 * Does not merge task YAML env — callers must not pass corpus task.env here.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | undefined | null} env
 * @returns {NodeJS.ProcessEnv}
 */
export function resolveHarnessEnv(env) {
  if (env == null) {
    return { ...process.env };
  }
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Append raw bytes to a bounded byte buffer (chunk-boundary safe).
 * @param {{ chunks: Buffer[], length: number, truncated: number }} buf
 * @param {Buffer} chunk
 * @param {number} limit - max bytes retained
 */
function appendBoundedBytes(buf, chunk, limit) {
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
  if (buf.length >= limit) {
    buf.truncated += chunk.length;
    return;
  }
  const room = limit - buf.length;
  if (chunk.length <= room) {
    buf.chunks.push(chunk);
    buf.length += chunk.length;
  } else {
    buf.chunks.push(chunk.subarray(0, room));
    buf.length += room;
    buf.truncated += chunk.length - room;
  }
}

/**
 * @param {{ chunks: Buffer[], length: number, truncated: number }} buf
 * @returns {Buffer}
 */
function concatBoundedBytes(buf) {
  if (buf.chunks.length === 0) return Buffer.alloc(0);
  if (buf.chunks.length === 1) return buf.chunks[0];
  return Buffer.concat(buf.chunks, buf.length);
}

/**
 * Kill process tree: prefer negative PID (process group) when detached.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killTree(child, signal) {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    /* fall through */
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

/**
 * Low-level spawn without shell. Prefer spawnControlled for invokers.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {string | Buffer} [opts.stdin]
 * @param {number} [opts.captureLimit]
 * @returns {Promise<SpawnResult>}
 */
export function spawnRaw({
  command,
  args,
  cwd,
  env,
  timeoutMs,
  stdin,
  captureLimit = DEFAULT_CAPTURE_LIMIT,
}) {
  if (command == null || String(command).trim() === '') {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'command is empty',
    });
  }
  if (!Array.isArray(args)) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'args must be an array',
    });
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      return Promise.resolve({
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: 'args must be an array of strings (argv-safe; no shell)',
      });
    }
  }

  const resolvedEnv = resolveHarnessEnv(env);
  const useStdin = stdin !== undefined && stdin !== null;
  const limit =
    Number.isFinite(captureLimit) && captureLimit > 0
      ? Math.floor(captureLimit)
      : DEFAULT_CAPTURE_LIMIT;

  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(String(command), args, {
        cwd: cwd || undefined,
        env: resolvedEnv,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: `spawn failed: ${message}`,
      });
      return;
    }

    /** @type {{ chunks: Buffer[], length: number, truncated: number }} */
    const outBuf = { chunks: [], length: 0, truncated: 0 };
    /** @type {{ chunks: Buffer[], length: number, truncated: number }} */
    const errBuf = { chunks: [], length: 0, truncated: 0 };
    let timedOut = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let settled = false;

    /**
     * @returns {{ stdout: string, stderr: string, stdoutBytes: Buffer, stderrBytes: Buffer }}
     */
    const materializeStreams = () => {
      const stdoutBytes = concatBoundedBytes(outBuf);
      const stderrBytes = concatBoundedBytes(errBuf);
      // Single decode after join: multi-byte sequences split across chunk
      // boundaries stay intact. Invalid UTF-8 still becomes U+FFFD in strings.
      return {
        stdoutBytes,
        stderrBytes,
        stdout: stdoutBytes.toString('utf8'),
        stderr: stderrBytes.toString('utf8'),
      };
    };

    const finish = (/** @type {SpawnResult} */ result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (outBuf.truncated > 0) {
        result.stdoutTruncatedChars = outBuf.truncated;
      }
      if (errBuf.truncated > 0) {
        result.stderrTruncatedChars = errBuf.truncated;
      }
      resolve(result);
    };

    // Collect raw Buffer chunks (no setEncoding) so UTF-8 is decoded once
    // after concatenation, not per chunk boundary.
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        appendBoundedBytes(outBuf, buf, limit);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        appendBoundedBytes(errBuf, buf, limit);
      });
    }

    child.on('error', (err) => {
      const streams = materializeStreams();
      finish({
        exitCode: null,
        timedOut: false,
        stdout: streams.stdout,
        stderr: streams.stderr,
        stdoutBytes: streams.stdoutBytes,
        stderrBytes: streams.stderrBytes,
        infraFailure: `process error: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      const streams = materializeStreams();
      /** @type {SpawnResult} */
      const result = {
        exitCode: code,
        timedOut,
        stdout: streams.stdout,
        stderr: streams.stderr,
        stdoutBytes: streams.stdoutBytes,
        stderrBytes: streams.stderrBytes,
      };
      if (signal) {
        result.signal = signal;
      }
      if (timedOut) {
        result.infraFailure =
          result.infraFailure ?? `process timed out after ${timeoutMs}ms`;
      }
      finish(result);
    });

    if (useStdin && child.stdin) {
      child.stdin.on('error', () => {
        /* ignore EPIPE */
      });
      child.stdin.end(stdin);
    }

    if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => {
          try {
            killTree(child, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }, 1000).unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/**
 * Spawn a process without a shell.
 *
 * For provider invokers, pass `campaignDir` (and typically `confine: true`) so
 * the process is wrapped to deny campaign tree access. Set `confine: false`
 * only for trusted harness helpers (e.g. git status in the workspace).
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {string | Buffer} [opts.stdin]
 * @param {number} [opts.captureLimit]
 * @param {string} [opts.campaignDir] - campaign control tree to hide from provider
 * @param {boolean} [opts.confine] - default true when campaignDir set; false = raw (trusted)
 * @param {string[]} [opts.extraBindPaths] - extra rw binds for bwrap
 * @param {string} [opts.privateTempParent] - parent for private 0700 TMPDIR (default: cwd)
 * @param {import('./provider-confine.js').ProviderConfinementInfo} [opts.confinement]
 * @returns {Promise<SpawnResult>}
 */
export async function spawnControlled(opts) {
  const {
    command,
    args,
    cwd,
    env,
    timeoutMs,
    stdin,
    captureLimit,
    campaignDir,
    confine,
    extraBindPaths,
    privateTempParent,
    confinement,
  } = opts;

  const mustConfine =
    confine === true ||
    (confine !== false && campaignDir != null && String(campaignDir).trim() !== '');

  if (mustConfine) {
    if (campaignDir == null || String(campaignDir).trim() === '') {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        executionUnavailable: true,
        infraFailure:
          'provider spawn requires campaignDir for confinement (fail closed; unconfined refused)',
      };
    }
    if (cwd == null || String(cwd).trim() === '') {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        executionUnavailable: true,
        infraFailure: 'provider spawn requires cwd (workspace) under confinement',
      };
    }

    const wrapped = await wrapProviderCommand({
      command: String(command),
      args: Array.isArray(args) ? args : [],
      cwd: String(cwd),
      campaignDir: String(campaignDir),
      extraBindPaths,
      privateTempParent,
      confinement,
    });

    if (!wrapped.ok) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        executionUnavailable: true,
        infraFailure: wrapped.infraFailure,
      };
    }

    try {
      // Constrain TMPDIR/TMP/TEMP to the private workspace-bound temp so
      // confined children (e.g. Poetic raw spool under os.tmpdir()) can write.
      // Never merges task YAML env — only harness-controlled env + temp keys.
      const childEnv = applyProviderTempEnv(
        resolveHarnessEnv(env),
        wrapped.privateTempDir,
      );
      const result = await spawnRaw({
        command: wrapped.command,
        args: wrapped.args,
        cwd,
        env: childEnv,
        timeoutMs,
        stdin,
        captureLimit,
      });
      return {
        ...result,
        confinedCommand: wrapped.command,
        confinedArgv: wrapped.args,
        privateTempDir: wrapped.privateTempDir,
      };
    } finally {
      await wrapped.cleanup();
    }
  }

  // Trusted harness helpers only (git status, etc.) — never providers.
  return spawnRaw({
    command,
    args,
    cwd,
    env,
    timeoutMs,
    stdin,
    captureLimit,
  });
}
