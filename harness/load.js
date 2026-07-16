/**
 * Load suite and task YAML from the corpus layout.
 *
 * Task id convention used by this repo:
 *   brownfield-002-js-rate-limiter-bug
 *     -> tasks/brownfield/002-js-rate-limiter-bug.yaml
 *   greenfield-002-python-cli-csv-json
 *     -> tasks/greenfield/002-python-cli-csv-json.yaml
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  corpusPaths,
  resolveCorpusRoot,
  resolveFixtureDir,
  resolveUnder,
  PathEscapeError,
} from './paths.js';
import {
  ValidationError,
  parseSuiteYaml,
  parseTaskYaml,
  validateSuite,
  validateTask,
} from './validate.js';

/**
 * @typedef {object} SuiteDocument
 * @property {string} name
 * @property {number} repetitions
 * @property {string[]} tasks
 */

/**
 * Map a stable taskId to a corpus-relative task YAML path.
 * @param {string} taskId
 * @returns {string} POSIX-style relative path under corpus root
 */
export function taskIdToRelPath(taskId) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new ValidationError('taskId is required', {
      path: 'taskId',
      code: 'REQUIRED',
    });
  }
  const match = /^(greenfield|brownfield)-(.+)$/.exec(taskId);
  if (!match) {
    throw new ValidationError(
      `taskId "${taskId}" does not match greenfield-* or brownfield-* convention`,
      { path: 'taskId', code: 'PATTERN' },
    );
  }
  const kind = match[1];
  const rest = match[2];
  if (rest.includes('..') || rest.includes('/') || rest.includes('\\') || rest.includes('\0')) {
    throw new PathEscapeError(
      `taskId rest contains path separators or traversal: "${taskId}"`,
      { candidate: taskId, code: 'TASK_ID_TRAVERSAL' },
    );
  }
  // Always use forward slashes for stable relative keys; path.join for FS ops.
  return `tasks/${kind}/${rest}.yaml`;
}

/**
 * Resolve absolute path to a task YAML under the corpus.
 * @param {string} corpusRoot
 * @param {string} taskId
 * @returns {Promise<string>}
 */
export async function resolveTaskPath(corpusRoot, taskId) {
  const root = resolveCorpusRoot(corpusRoot);
  const rel = taskIdToRelPath(taskId);
  return resolveUnder(root, rel);
}

/**
 * Load and validate a suite.yaml file.
 * @param {string} suitePath - absolute or relative filesystem path
 * @returns {Promise<SuiteDocument & Record<string, unknown>>}
 */
export async function loadSuite(suitePath) {
  if (suitePath == null || String(suitePath).trim() === '') {
    throw new ValidationError('suitePath is required', { path: 'suitePath', code: 'REQUIRED' });
  }
  const abs = path.resolve(String(suitePath));
  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`failed to read suite: ${message}`, {
      path: abs,
      code: 'READ',
      cause: err,
    });
  }
  const suite = parseSuiteYaml(text, abs);
  return suite;
}

/**
 * Load and validate a task YAML file.
 * Canonicalizes relative fixturePath; rejects absolute fixture escape.
 *
 * @param {string} taskPath
 * @param {{ corpusRoot?: string }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadTask(taskPath, opts = {}) {
  if (taskPath == null || String(taskPath).trim() === '') {
    throw new ValidationError('taskPath is required', { path: 'taskPath', code: 'REQUIRED' });
  }
  const abs = path.resolve(String(taskPath));
  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`failed to read task: ${message}`, {
      path: abs,
      code: 'READ',
      cause: err,
    });
  }
  const task = parseTaskYaml(text, abs);

  // Canonicalize fixturePath when corpusRoot is known.
  if (opts.corpusRoot && typeof task.fixturePath === 'string') {
    const fixtureAbs = await resolveFixtureDir(opts.corpusRoot, task.fixturePath);
    // Keep relative (normalized) form only — never store absolute escape vectors on the task.
    task.fixturePath = path.posix.normalize(task.fixturePath.split(path.sep).join('/'));
    task._resolvedFixtureDir = fixtureAbs;
  } else if (typeof task.fixturePath === 'string') {
    if (path.isAbsolute(task.fixturePath) || task.fixturePath.includes('..')) {
      // Without corpus root, still reject obvious escape forms.
      if (path.isAbsolute(task.fixturePath)) {
        throw new ValidationError(
          'fixturePath must be relative to corpus fixtures/',
          { path: `${abs}.fixturePath`, code: 'ABSOLUTE_PATH' },
        );
      }
    }
    task.fixturePath = path.posix.normalize(task.fixturePath.split(path.sep).join('/'));
  }

  // Reject absolute oraclePath on gates.
  if (Array.isArray(task.eligibilityGates)) {
    for (let i = 0; i < task.eligibilityGates.length; i++) {
      const gate = /** @type {Record<string, unknown>} */ (task.eligibilityGates[i]);
      if (typeof gate.oraclePath === 'string') {
        if (path.isAbsolute(gate.oraclePath)) {
          throw new ValidationError(
            'oraclePath must be relative to corpus oracles/',
            { path: `${abs}.eligibilityGates[${i}].oraclePath`, code: 'ABSOLUTE_PATH' },
          );
        }
        gate.oraclePath = path.posix.normalize(gate.oraclePath.split(path.sep).join('/'));
      }
    }
  }

  return task;
}

/**
 * Load every task referenced by a suite from the corpus tree.
 *
 * @param {string} corpusRoot
 * @param {SuiteDocument | string[] | string} suite - suite object, task id list, or path to suite.yaml
 * @returns {Promise<{ suite: SuiteDocument & Record<string, unknown>, tasks: Record<string, unknown>[] }>}
 */
export async function loadCorpusTasks(corpusRoot, suite) {
  const root = resolveCorpusRoot(corpusRoot);
  const paths = corpusPaths(root);

  /** @type {SuiteDocument & Record<string, unknown>} */
  let suiteDoc;
  if (typeof suite === 'string') {
    // Treat as suite file path (absolute or under cwd); prefer corpus suite when relative name.
    const suitePath = path.isAbsolute(suite)
      ? suite
      : path.resolve(suite);
    suiteDoc = await loadSuite(suitePath);
  } else if (Array.isArray(suite)) {
    suiteDoc = validateSuite({
      name: path.basename(root),
      repetitions: 1,
      tasks: suite,
    });
  } else if (suite && typeof suite === 'object') {
    suiteDoc = validateSuite(suite);
  } else {
    // Default: load suite.yaml from corpus root.
    suiteDoc = await loadSuite(paths.suitePath);
  }

  /** @type {Record<string, unknown>[]} */
  const tasks = [];
  for (const taskId of suiteDoc.tasks) {
    const taskPath = await resolveTaskPath(root, taskId);
    const task = await loadTask(taskPath, { corpusRoot: root });
    if (task.taskId !== taskId) {
      throw new ValidationError(
        `task file taskId "${task.taskId}" does not match suite entry "${taskId}"`,
        { path: taskPath, code: 'TASK_ID_MISMATCH' },
      );
    }
    // Ensure type folder matches task type.
    if (task.type !== 'greenfield' && task.type !== 'brownfield') {
      throw new ValidationError(`invalid task type "${task.type}"`, {
        path: taskPath,
        code: 'ENUM',
      });
    }
    tasks.push(task);
  }

  return { suite: suiteDoc, tasks };
}

export { ValidationError, validateSuite, validateTask, parseSuiteYaml, parseTaskYaml };
