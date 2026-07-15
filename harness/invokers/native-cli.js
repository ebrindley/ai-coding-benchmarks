/**
 * Native CLI invoker: explicit harness driver for command + args from the
 * experiment arm config. Must not smuggle credentials or env from corpus task YAML.
 *
 * spawn without shell; argv array only. Tests inject fake executables via `command`.
 *
 * Task prompt delivery is injection-safe:
 * - default `promptTransport: 'stdin'` writes the exact prompt to controlled stdin
 * - `promptTransport: 'prompt-file'` writes a harness-controlled temp file and
 *   appends the absolute path as a final argv element (no shell templating);
 *   the temp prompt directory is always removed in `finally` after the child
 *   completes or fails (success path never returns a stale absolute path)
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnControlled } from './spawn-controlled.js';

/** Allowed prompt transport modes (enumerated; never free-form shell). */
export const PROMPT_TRANSPORTS = Object.freeze(['stdin', 'prompt-file']);

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
 * @property {string} [promptTransport]
 * @property {boolean} [promptFileUsed] - true when prompt-file transport was used (path not returned; cleaned up)
 */

/**
 * Invoke a native CLI as configured by the experiment arm (not task YAML).
 *
 * Prompt delivery (injection-safe):
 * - `prompt` + `promptTransport: 'stdin'` (default): exact prompt bytes on stdin
 * - `prompt` + `promptTransport: 'prompt-file'`: write harness temp file; append
 *   absolute path as final argv element; always remove temp dir in `finally`
 * - explicit `stdin` overrides prompt for stdin transport
 * - legacy `promptFile` (path): read file contents into stdin when no prompt/stdin
 *
 * @param {object} opts
 * @param {string} opts.command - executable path/name from arm config
 * @param {string[]} [opts.args] - argv array (no shell)
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env] harness-controlled only
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.prompt] - exact task prompt to deliver
 * @param {'stdin' | 'prompt-file'} [opts.promptTransport] - default 'stdin'
 * @param {string} [opts.promptFile] - legacy: if set and no prompt/stdin, file → stdin
 * @param {string | Buffer} [opts.stdin]
 * @param {unknown} [opts.taskEnv] - REJECTED if present (smuggling guard)
 * @param {string} opts.campaignDir - campaign control tree hidden via OS confinement
 * @param {string} [opts.scratchDir] - preferred temp dir under execution workspace for prompt-file
 * @param {import('./provider-confine.js').ProviderConfinementInfo} [opts.confinement]
 * @returns {Promise<InvokerResult>}
 */
export async function invokeNativeCli({
  command,
  args = [],
  cwd,
  env,
  timeoutMs,
  prompt,
  promptTransport,
  promptFile,
  stdin,
  taskEnv,
  campaignDir,
  scratchDir,
  confinement,
  ...rest
}) {
  // Refuse credential/env smuggling from task YAML (before confinement setup)
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
  if (campaignDir == null || String(campaignDir).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure:
        'campaignDir is required for provider confinement (fail closed; unconfined refused)',
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
  for (const a of args) {
    if (typeof a !== 'string') {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        infraFailure: 'args must be an array of strings (argv-safe; no shell)',
      };
    }
  }

  const transport =
    promptTransport == null || promptTransport === ''
      ? 'stdin'
      : String(promptTransport);
  if (!PROMPT_TRANSPORTS.includes(/** @type {'stdin' | 'prompt-file'} */ (transport))) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: `unsupported promptTransport "${transport}"; expected one of: ${PROMPT_TRANSPORTS.join(', ')}`,
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

  /** @type {string[]} */
  let finalArgs = args.map(String);
  /** @type {string | Buffer | undefined} */
  let stdinData = stdin;
  /** @type {string | undefined} */
  let promptTempDir;
  /** @type {string | undefined} */
  let writtenPromptPath;

  if (transport === 'prompt-file') {
    if (prompt == null) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        promptTransport: transport,
        infraFailure: 'prompt is required when promptTransport is prompt-file',
      };
    }
    try {
      // Prompt scratch under execution workspace when provided (never campaign).
      const base =
        scratchDir != null && String(scratchDir).trim() !== ''
          ? String(scratchDir)
          : cwd != null && String(cwd).trim() !== ''
            ? String(cwd)
            : os.tmpdir();
      promptTempDir = await mkdtemp(path.join(base, 'aicb-prompt-'));
      writtenPromptPath = path.join(promptTempDir, 'prompt.txt');
      await writeFile(writtenPromptPath, String(prompt), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      // Best-effort cleanup if mkdir succeeded but write failed.
      if (promptTempDir) {
        await rm(promptTempDir, { recursive: true, force: true }).catch(() => {});
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        promptTransport: transport,
        infraFailure: `failed to write prompt-file: ${message}`,
      };
    }
    // Controlled argv append only — never shell interpolation of the prompt.
    finalArgs = [...finalArgs, writtenPromptPath];
    // Do not put prompt body on stdin for prompt-file transport.
    stdinData = undefined;
  } else {
    // stdin transport (default)
    if (stdinData === undefined && prompt != null) {
      stdinData = String(prompt);
    }
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
          promptTransport: transport,
          infraFailure: `failed to read promptFile: ${message}`,
        };
      }
    }
  }

  try {
    const result = await spawnControlled({
      command: String(command),
      args: finalArgs,
      cwd,
      env,
      timeoutMs,
      stdin: stdinData,
      campaignDir: String(campaignDir),
      confine: true,
      confinement,
      extraBindPaths: [
        ...(scratchDir ? [String(scratchDir)] : []),
        ...(promptTempDir ? [promptTempDir] : []),
      ],
    });

    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      promptTransport: transport,
      // Do not return the now-stale absolute prompt path after cleanup.
      ...(promptTempDir ? { promptFileUsed: true } : {}),
      ...(result.executionUnavailable
        ? { executionUnavailable: true }
        : {}),
      ...(result.infraFailure ? { infraFailure: result.infraFailure } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  } finally {
    // Always remove temporary prompt directory/file after child completes or fails.
    if (promptTempDir) {
      await rm(promptTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
