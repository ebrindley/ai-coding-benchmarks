/**
 * Poetic system-path invoker: public surface only.
 *
 *   poetic run <prompt> --provider <provider> --model <model>
 *     --in-place --no-push --profile fast-local --timeout <whole minutes>
 *
 * Runs from the isolated workspace (cwd) on a non-protected trial branch.
 * Argv-safe; no shell; no task YAML env. No arbitrary user command strings.
 */

import { spawnControlled } from './spawn-controlled.js';

/**
 * @typedef {object} InvokerResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} [outputPath]
 * @property {string} [infraFailure]
 * @property {string} [signal]
 * @property {string[]} [argv]
 * @property {null} [resolvedModel]
 */

/**
 * @param {number | undefined | null} timeoutMs
 * @returns {number}
 */
export function timeoutMsToWholeMinutes(timeoutMs) {
  if (timeoutMs == null || !Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    return 10;
  }
  return Math.max(1, Math.ceil(Number(timeoutMs) / 60_000));
}

/**
 * Build controlled argv for poetic system path (no spawn).
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {number} [opts.timeoutMs]
 * @returns {string[]}
 */
export function buildPoeticSystemArgv({ prompt, provider, model, timeoutMs }) {
  if (prompt == null) {
    throw new Error('buildPoeticSystemArgv: prompt is required');
  }
  if (provider == null || String(provider).trim() === '') {
    throw new Error('buildPoeticSystemArgv: provider is required');
  }
  if (model == null || String(model).trim() === '') {
    throw new Error('buildPoeticSystemArgv: model is required');
  }
  const minutes = timeoutMsToWholeMinutes(timeoutMs);
  return [
    'run',
    String(prompt),
    '--provider',
    String(provider),
    '--model',
    String(model),
    '--in-place',
    '--no-push',
    '--profile',
    'fast-local',
    '--timeout',
    String(minutes),
  ];
}

/**
 * @param {object} opts
 * @param {string} opts.poeticBin
 * @param {string} opts.prompt
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} [opts.cwd] isolated workspace (must already be on trial branch)
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {unknown} [opts.taskEnv]
 * @param {unknown} [opts.extraArgs]
 * @param {unknown} [opts.systemPromptPath]
 * @returns {Promise<InvokerResult>}
 */
export async function invokePoeticSystem({
  poeticBin,
  prompt,
  provider,
  model,
  cwd,
  env,
  timeoutMs,
  taskEnv,
  extraArgs,
  systemPromptPath,
  ...rest
}) {
  if (taskEnv !== undefined) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure:
        'refusing taskEnv: poetic-system does not merge corpus task YAML env/credentials',
      resolvedModel: null,
    };
  }
  if (extraArgs !== undefined) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure:
        'refusing extraArgs: poetic-system uses a fixed public argv surface only',
      resolvedModel: null,
    };
  }
  if (systemPromptPath !== undefined) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure:
        'refusing systemPromptPath: obsolete; use poetic run --provider --model --in-place --profile fast-local',
      resolvedModel: null,
    };
  }
  if (rest && Object.prototype.hasOwnProperty.call(rest, 'task')) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'refusing task object: pass only harness-controlled options',
      resolvedModel: null,
    };
  }

  if (poeticBin == null || String(poeticBin).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: 'poeticBin is required',
      resolvedModel: null,
    };
  }

  let args;
  try {
    args = buildPoeticSystemArgv({ prompt, provider, model, timeoutMs });
  } catch (err) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure: err instanceof Error ? err.message : String(err),
      resolvedModel: null,
    };
  }

  const result = await spawnControlled({
    command: String(poeticBin),
    args,
    cwd,
    env,
    timeoutMs,
  });

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    argv: args,
    resolvedModel: null,
    ...(result.infraFailure ? { infraFailure: result.infraFailure } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  };
}
