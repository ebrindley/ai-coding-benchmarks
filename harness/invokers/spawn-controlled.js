/**
 * Argv-safe subprocess runner for harness invokers.
 * Never uses a shell. Only harness-controlled env may be passed.
 * Corpus task YAML must never contribute env.
 *
 * Captured stdout/stderr are bounded. On timeout, the process group/tree is
 * terminated where the platform supports detached process groups.
 */

import { spawn } from 'node:child_process';

/** Default max chars retained per stream (rest discarded, length recorded). */
export const DEFAULT_CAPTURE_LIMIT = 256 * 1024;

/**
 * @typedef {object} SpawnResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} [infraFailure]
 * @property {string} [signal]
 * @property {number} [stdoutTruncatedChars]
 * @property {number} [stderrTruncatedChars]
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
 * Append to a bounded buffer.
 * @param {{ text: string, truncated: number }} buf
 * @param {string} chunk
 * @param {number} limit
 */
function appendBounded(buf, chunk, limit) {
  if (buf.text.length >= limit) {
    buf.truncated += chunk.length;
    return;
  }
  const room = limit - buf.text.length;
  if (chunk.length <= room) {
    buf.text += chunk;
  } else {
    buf.text += chunk.slice(0, room);
    buf.truncated += chunk.length - room;
  }
}

/**
 * Kill process tree: prefer negative PID (process group) when detached.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killTree(child, signal) {
  if (child.pid == null) return;
  try {
    // When detached with new process group, -pid signals the whole group.
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
 * Spawn a process without a shell.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {string | Buffer} [opts.stdin]
 * @param {number} [opts.captureLimit] max stdout/stderr chars retained
 * @returns {Promise<SpawnResult>}
 */
export function spawnControlled({
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
        // New process group so timeout can signal the whole tree on POSIX.
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

    /** @type {{ text: string, truncated: number }} */
    const outBuf = { text: '', truncated: 0 };
    /** @type {{ text: string, truncated: number }} */
    const errBuf = { text: '', truncated: 0 };
    let timedOut = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let settled = false;

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

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        appendBounded(outBuf, String(chunk), limit);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        appendBounded(errBuf, String(chunk), limit);
      });
    }

    child.on('error', (err) => {
      finish({
        exitCode: null,
        timedOut: false,
        stdout: outBuf.text,
        stderr: errBuf.text,
        infraFailure: `process error: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      /** @type {SpawnResult} */
      const result = {
        exitCode: code,
        timedOut,
        stdout: outBuf.text,
        stderr: errBuf.text,
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
        /* ignore EPIPE if process exits early */
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
