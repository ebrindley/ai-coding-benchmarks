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
 * @property {number} [stdoutTruncatedChars] - chars discarded above capture limit
 * @property {number} [stderrTruncatedChars] - chars discarded above capture limit
 * @property {boolean} [rawTruncated] - true when either stream was truncated
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
 * @param {string} opts.campaignDir - campaign control tree hidden via OS confinement
 * @param {import('./provider-confine.js').ProviderConfinementInfo} [opts.confinement]
 * @param {number} [opts.captureLimit] - optional override for test injection only; production omits (DEFAULT_CAPTURE_LIMIT)
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
  campaignDir,
  confinement,
  captureLimit,
  ...rest
}) {
  if (campaignDir == null || String(campaignDir).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      infraFailure:
        'campaignDir is required for provider confinement (fail closed; unconfined refused)',
      resolvedModel: null,
    };
  }
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
    campaignDir: String(campaignDir),
    confine: true,
    confinement,
    // Test-only injection; production callers never pass captureLimit.
    ...(captureLimit != null ? { captureLimit } : {}),
  });

  const stdoutTruncatedChars =
    typeof result.stdoutTruncatedChars === 'number' &&
    result.stdoutTruncatedChars > 0
      ? result.stdoutTruncatedChars
      : undefined;
  const stderrTruncatedChars =
    typeof result.stderrTruncatedChars === 'number' &&
    result.stderrTruncatedChars > 0
      ? result.stderrTruncatedChars
      : undefined;
  const rawTruncated =
    stdoutTruncatedChars != null || stderrTruncatedChars != null;

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    argv: args,
    confinedArgv: result.confinedArgv,
    resolvedModel: null,
    ...(result.executionUnavailable
      ? { executionUnavailable: true }
      : {}),
    ...(result.infraFailure ? { infraFailure: result.infraFailure } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    // Propagate capture truncation so digests fail closed on incomplete raw.
    ...(stdoutTruncatedChars != null ? { stdoutTruncatedChars } : {}),
    ...(stderrTruncatedChars != null ? { stderrTruncatedChars } : {}),
    ...(rawTruncated ? { rawTruncated: true } : {}),
  };
}
