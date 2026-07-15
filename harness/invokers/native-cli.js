/**
 * Native CLI invoker: explicit harness driver for command + args from the
 * experiment arm config. Must not smuggle credentials or env from corpus task YAML.
 *
 * spawn without shell; argv array only. Tests inject fake executables via `command`.
 */

import { readFile } from 'node:fs/promises';
import { spawnControlled } from './spawn-controlled.js';

/**
 * Keys that look like credentials. Invokers refuse env objects that appear to
 * be corpus task YAML merges carrying these keys when `source: 'task-yaml'` is set,
 * and always refuse an explicit `taskEnv` property smuggled on the options bag.
 */
const CREDENTIAL_KEY_RE =
  /^(?:[A-Z0-9_]*_)*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN|BEARER)(?:_[A-Z0-9_]+)*$/i;

/**
 * @param {Record<string, unknown> | null | undefined} env
 * @param {{ allowCredentialKeys?: boolean }} [opts]
 */
function assertHarnessEnv(env, opts = {}) {
  if (env == null) return;
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('native-cli: env must be a plain object when provided');
  }
  // Refuse if caller marked env as coming from task YAML
  if (/** @type {{ __source?: string }} */ (env).__source === 'task-yaml') {
    throw new Error('native-cli: refusing to use env sourced from corpus task YAML');
  }
  if (opts.allowCredentialKeys) return;
  // Default: do not refuse harness-owned credential keys (providers need them);
  // smuggling is prevented by never accepting task.env merge. Documented no-op check.
  void CREDENTIAL_KEY_RE;
}

/**
 * @typedef {object} InvokerResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} [outputPath]
 * @property {string} [infraFailure]
 * @property {string} [signal]
 */

/**
 * Invoke a native CLI as configured by the experiment arm (not task YAML).
 *
 * @param {object} opts
 * @param {string} opts.command - executable path/name from arm config
 * @param {string[]} [opts.args] - argv array (no shell)
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env] harness-controlled only
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.promptFile] - if set, file contents are written to stdin (unless stdin provided)
 * @param {string | Buffer} [opts.stdin]
 * @param {unknown} [opts.taskEnv] - REJECTED if present (smuggling guard)
 * @returns {Promise<InvokerResult>}
 */
export async function invokeNativeCli({
  command,
  args = [],
  cwd,
  env,
  timeoutMs,
  promptFile,
  stdin,
  taskEnv,
  ...rest
}) {
  // Refuse credential/env smuggling from task YAML
  if (taskEnv !== undefined) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'refusing taskEnv: native-cli does not merge corpus task YAML env/credentials',
    };
  }
  if (rest && Object.prototype.hasOwnProperty.call(rest, 'task')) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'refusing task object: pass only harness-controlled command/args/env',
    };
  }

  if (command == null || String(command).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'command is empty',
    };
  }

  if (!Array.isArray(args)) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'args must be an array of strings',
    };
  }

  try {
    assertHarnessEnv(env);
  } catch (err) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: err instanceof Error ? err.message : String(err),
    };
  }

  let stdinData = stdin;
  if (stdinData === undefined && promptFile) {
    try {
      stdinData = await readFile(promptFile, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: `failed to read promptFile: ${message}`,
      };
    }
  }

  const result = await spawnControlled({
    command: String(command),
    args: args.map(String),
    cwd,
    env,
    timeoutMs,
    stdin: stdinData,
  });

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.infraFailure ? { infraFailure: result.infraFailure } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  };
}
