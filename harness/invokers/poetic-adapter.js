/**
 * Poetic adapter invoker: argv-safe `poetic provider invoke --request … --output …`.
 *
 * Does not pass arbitrary env from corpus task YAML. Only harness-controlled
 * env (explicit `env` or filtered process.env) is used. Tests inject `poeticBin`.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnControlled } from './spawn-controlled.js';

/**
 * @typedef {object} InvokerResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} outputPath
 * @property {string} [infraFailure]
 * @property {string} [signal]
 */

/**
 * Invoke Poetic via the provider-adapter path.
 *
 * @param {object} opts
 * @param {string} opts.poeticBin - path or name of poetic executable (injectable for tests)
 * @param {string} opts.requestPath - path to request JSON file
 * @param {string} opts.outputPath - path where poetic writes its response
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null} [opts.env] harness-controlled only
 * @param {number} [opts.timeoutMs]
 * @param {unknown} [opts.request] if provided, written as JSON to requestPath before spawn
 * @returns {Promise<InvokerResult>}
 */
export async function invokePoeticAdapter({
  poeticBin,
  requestPath,
  outputPath,
  cwd,
  env,
  timeoutMs,
  request,
}) {
  if (poeticBin == null || String(poeticBin).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      infraFailure: 'poeticBin is required',
    };
  }
  if (requestPath == null || String(requestPath).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: outputPath ?? '',
      infraFailure: 'requestPath is required',
    };
  }
  if (outputPath == null || String(outputPath).trim() === '') {
    return {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      outputPath: '',
      infraFailure: 'outputPath is required',
    };
  }

  if (request !== undefined) {
    await mkdir(path.dirname(requestPath), { recursive: true });
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  }

  await mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});

  const args = [
    'provider',
    'invoke',
    '--request',
    String(requestPath),
    '--output',
    String(outputPath),
  ];

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
    outputPath: String(outputPath),
    ...(result.infraFailure ? { infraFailure: result.infraFailure } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  };
}
