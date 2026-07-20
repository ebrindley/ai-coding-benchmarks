/**
 * Lightweight structural validators for suite and task YAML documents.
 * No AJV — hand-written checks matching schemas/suite.schema.json and schemas/task.schema.json.
 */

import { parse as parseYaml } from 'yaml';

/**
 * Validation error with dotted/bracket path context.
 */
export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {{ path?: string, code?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    const pathLabel = details.path ? ` at ${details.path}` : '';
    super(`${message}${pathLabel}`);
    this.name = 'ValidationError';
    this.path = details.path ?? '';
    this.code = details.code ?? 'VALIDATION_ERROR';
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {asserts value is Record<string, unknown>}
 */
function assertObject(value, path) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('expected object', { path, code: 'TYPE' });
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('expected non-empty string', { path, code: 'TYPE' });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number}
 */
function requireInteger(value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('expected integer', { path, code: 'TYPE' });
  }
  return value;
}

/**
 * Parse YAML text into a plain JS value.
 * @param {string} text
 * @param {string} [sourceLabel]
 * @returns {unknown}
 */
export function parseYamlDocument(text, sourceLabel = 'yaml') {
  if (typeof text !== 'string') {
    throw new ValidationError('YAML source must be a string', {
      path: sourceLabel,
      code: 'TYPE',
    });
  }
  try {
    return parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`YAML parse failed: ${message}`, {
      path: sourceLabel,
      code: 'YAML_PARSE',
      cause: err,
    });
  }
}

/**
 * Validate a suite document (name, repetitions >= 1, non-empty task id list).
 * @param {unknown} data
 * @param {string} [basePath]
 * @returns {{ name: string, repetitions: number, tasks: string[] } & Record<string, unknown>}
 */
export function validateSuite(data, basePath = '') {
  assertObject(data, basePath || '/');
  const obj = /** @type {Record<string, unknown>} */ (data);

  const name = requireNonEmptyString(obj.name, joinPath(basePath, 'name'));
  const repetitions = requireInteger(obj.repetitions, joinPath(basePath, 'repetitions'));
  if (repetitions < 1) {
    throw new ValidationError('repetitions must be >= 1', {
      path: joinPath(basePath, 'repetitions'),
      code: 'MIN',
    });
  }

  if (!Array.isArray(obj.tasks)) {
    throw new ValidationError('tasks must be a non-empty array of task id strings', {
      path: joinPath(basePath, 'tasks'),
      code: 'TYPE',
    });
  }
  if (obj.tasks.length < 1) {
    throw new ValidationError('tasks must be non-empty', {
      path: joinPath(basePath, 'tasks'),
      code: 'MIN_ITEMS',
    });
  }

  /** @type {string[]} */
  const tasks = [];
  for (let i = 0; i < obj.tasks.length; i++) {
    const id = requireNonEmptyString(obj.tasks[i], joinPath(basePath, `tasks[${i}]`));
    tasks.push(id);
  }

  return {
    ...obj,
    name,
    repetitions,
    tasks,
  };
}

/**
 * @param {unknown} item
 * @param {string} path
 */
function validateOutcomeItem(item, path) {
  assertObject(item, path);
  const obj = /** @type {Record<string, unknown>} */ (item);
  requireNonEmptyString(obj.id, joinPath(path, 'id'));
  if (obj.description == null || typeof obj.description !== 'string') {
    throw new ValidationError('expected string', {
      path: joinPath(path, 'description'),
      code: 'TYPE',
    });
  }
}

/**
 * @param {unknown} gate
 * @param {string} path
 */
function validateEligibilityGate(gate, path) {
  assertObject(gate, path);
  const obj = /** @type {Record<string, unknown>} */ (gate);
  requireNonEmptyString(obj.gate, joinPath(path, 'gate'));
  const order = requireInteger(obj.order, joinPath(path, 'order'));
  if (order < 1) {
    throw new ValidationError('order must be >= 1', {
      path: joinPath(path, 'order'),
      code: 'MIN',
    });
  }
  if (obj.command !== undefined && obj.command !== null && typeof obj.command !== 'string') {
    throw new ValidationError('command must be a string when present', {
      path: joinPath(path, 'command'),
      code: 'TYPE',
    });
  }
  if (obj.expectedExitCode !== undefined && obj.expectedExitCode !== null) {
    if (typeof obj.expectedExitCode !== 'number' || !Number.isInteger(obj.expectedExitCode)) {
      throw new ValidationError('expectedExitCode must be an integer', {
        path: joinPath(path, 'expectedExitCode'),
        code: 'TYPE',
      });
    }
  }
  if (obj.required !== undefined && typeof obj.required !== 'boolean') {
    throw new ValidationError('required must be a boolean', {
      path: joinPath(path, 'required'),
      code: 'TYPE',
    });
  }
  if (obj.oraclePath !== undefined && obj.oraclePath !== null) {
    if (typeof obj.oraclePath !== 'string' || obj.oraclePath.trim() === '') {
      throw new ValidationError('oraclePath must be a non-empty string when present', {
        path: joinPath(path, 'oraclePath'),
        code: 'TYPE',
      });
    }
  }
  if (obj.baselineDiffPolicy !== undefined) {
    const policyPath = joinPath(path, 'baselineDiffPolicy');
    assertObject(obj.baselineDiffPolicy, policyPath);
    const policy = /** @type {Record<string, unknown>} */ (obj.baselineDiffPolicy);
    if (!Array.isArray(policy.allow) || policy.allow.length < 1) {
      throw new ValidationError(
        'baselineDiffPolicy.allow must be a non-empty array',
        { path: joinPath(policyPath, 'allow'), code: 'TYPE' },
      );
    }
    for (let i = 0; i < policy.allow.length; i++) {
      const entryPath = joinPath(policyPath, `allow[${i}]`);
      const entry = requireNonEmptyString(policy.allow[i], entryPath);
      if (
        entry.startsWith('/') ||
        entry.startsWith('\\') ||
        entry.split(/[\\/]+/).includes('..')
      ) {
        throw new ValidationError(
          'baselineDiffPolicy.allow entries must be workspace-relative paths without traversal',
          { path: entryPath, code: 'PATH' },
        );
      }
    }
  }
}

/**
 * Validate a task document against the structural task contract.
 * @param {unknown} data
 * @param {string} [basePath]
 * @returns {Record<string, unknown>}
 */
export function validateTask(data, basePath = '') {
  assertObject(data, basePath || '/');
  const obj = /** @type {Record<string, unknown>} */ (data);

  const taskId = requireNonEmptyString(obj.taskId, joinPath(basePath, 'taskId'));
  if (!/^(greenfield|brownfield)-.+/.test(taskId)) {
    throw new ValidationError(
      'taskId must match ^(greenfield|brownfield)-.+',
      { path: joinPath(basePath, 'taskId'), code: 'PATTERN' },
    );
  }

  const type = requireNonEmptyString(obj.type, joinPath(basePath, 'type'));
  if (type !== 'greenfield' && type !== 'brownfield') {
    throw new ValidationError('type must be "greenfield" or "brownfield"', {
      path: joinPath(basePath, 'type'),
      code: 'ENUM',
    });
  }

  requireNonEmptyString(obj.description, joinPath(basePath, 'description'));

  assertObject(obj.expectedOutcome, joinPath(basePath, 'expectedOutcome'));
  const expectedOutcome = /** @type {Record<string, unknown>} */ (obj.expectedOutcome);
  if (!Array.isArray(expectedOutcome.mustHave) || expectedOutcome.mustHave.length < 1) {
    throw new ValidationError('expectedOutcome.mustHave must be a non-empty array', {
      path: joinPath(basePath, 'expectedOutcome.mustHave'),
      code: 'MIN_ITEMS',
    });
  }
  for (let i = 0; i < expectedOutcome.mustHave.length; i++) {
    validateOutcomeItem(
      expectedOutcome.mustHave[i],
      joinPath(basePath, `expectedOutcome.mustHave[${i}]`),
    );
  }
  if (expectedOutcome.niceToHave !== undefined) {
    if (!Array.isArray(expectedOutcome.niceToHave)) {
      throw new ValidationError('niceToHave must be an array', {
        path: joinPath(basePath, 'expectedOutcome.niceToHave'),
        code: 'TYPE',
      });
    }
    for (let i = 0; i < expectedOutcome.niceToHave.length; i++) {
      validateOutcomeItem(
        expectedOutcome.niceToHave[i],
        joinPath(basePath, `expectedOutcome.niceToHave[${i}]`),
      );
    }
  }

  if (!Array.isArray(obj.eligibilityGates) || obj.eligibilityGates.length < 1) {
    throw new ValidationError('eligibilityGates must be a non-empty array', {
      path: joinPath(basePath, 'eligibilityGates'),
      code: 'MIN_ITEMS',
    });
  }
  for (let i = 0; i < obj.eligibilityGates.length; i++) {
    validateEligibilityGate(
      obj.eligibilityGates[i],
      joinPath(basePath, `eligibilityGates[${i}]`),
    );
  }

  if (obj.fixturePath !== undefined && obj.fixturePath !== null) {
    requireNonEmptyString(obj.fixturePath, joinPath(basePath, 'fixturePath'));
    if (typeof obj.fixturePath === 'string' && obj.fixturePath.startsWith('/')) {
      throw new ValidationError(
        'fixturePath must be relative (absolute paths are not allowed)',
        { path: joinPath(basePath, 'fixturePath'), code: 'ABSOLUTE_PATH' },
      );
    }
  }

  // Normalize expectedExitCode defaults on gates (load-time convenience).
  const eligibilityGates = obj.eligibilityGates.map((g) => {
    const gate = /** @type {Record<string, unknown>} */ (g);
    const expectedExitCode =
      gate.expectedExitCode === undefined || gate.expectedExitCode === null
        ? 0
        : gate.expectedExitCode;
    const required = gate.required === undefined ? true : gate.required;
    return { ...gate, expectedExitCode, required };
  });

  return {
    ...obj,
    taskId,
    type,
    eligibilityGates,
  };
}

/**
 * Parse and validate suite YAML text.
 * @param {string} text
 * @param {string} [sourceLabel]
 */
export function parseSuiteYaml(text, sourceLabel = 'suite.yaml') {
  const data = parseYamlDocument(text, sourceLabel);
  return validateSuite(data, sourceLabel);
}

/**
 * Parse and validate task YAML text.
 * @param {string} text
 * @param {string} [sourceLabel]
 */
export function parseTaskYaml(text, sourceLabel = 'task.yaml') {
  const data = parseYamlDocument(text, sourceLabel);
  return validateTask(data, sourceLabel);
}

/**
 * @param {string} base
 * @param {string} segment
 * @returns {string}
 */
function joinPath(base, segment) {
  if (!base) return segment;
  return `${base}.${segment}`;
}
