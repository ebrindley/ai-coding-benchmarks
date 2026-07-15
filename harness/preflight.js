/**
 * Campaign preflight checks before trial expansion/execution.
 * No live provider calls. No corpus mutation.
 */

import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, INVOCATION_PATHS } from './contracts.js';
import { assertSafeCampaignId } from './paths.js';

/**
 * @typedef {object} PreflightResult
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {Record<string, unknown>} meta
 */

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function isReadableDir(p) {
  try {
    const st = await stat(p);
    if (!st.isDirectory()) return false;
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.experiment
 * @param {string} opts.corpusRoot
 * @param {string} [opts.campaignDir]
 * @param {string} [opts.harnessRoot]
 * @returns {Promise<PreflightResult>}
 */
export async function preflight({ experiment, corpusRoot, campaignDir, harnessRoot }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, unknown>} */
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  if (!experiment || typeof experiment !== 'object') {
    errors.push('experiment is required');
  } else {
    if (experiment.schemaVersion !== 1 && experiment.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`unsupported experiment.schemaVersion: ${experiment.schemaVersion}`);
    }
    if (!experiment.id) {
      errors.push('experiment.id is required');
    } else {
      try {
        // experiment.id doubles as default campaign path segment — must be safe.
        assertSafeCampaignId(experiment.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`experiment.id is not a safe campaign id: ${msg}`);
      }
    }
    if (!Array.isArray(experiment.arms) || experiment.arms.length === 0) {
      errors.push('experiment.arms must be a non-empty array');
    } else {
      for (const [i, arm] of experiment.arms.entries()) {
        if (!arm?.name) errors.push(`arms[${i}].name is required`);
        if (!arm?.provider) errors.push(`arms[${i}].provider is required`);
        if (!arm?.model) errors.push(`arms[${i}].model is required`);
        if (!INVOCATION_PATHS.includes(arm?.invocationPath)) {
          errors.push(
            `arms[${i}].invocationPath must be one of: ${INVOCATION_PATHS.join(', ')}`,
          );
        }
        if (arm?.invocationPath === 'native-cli' && !arm?.command) {
          warnings.push(`arms[${i}] (${arm.name}): native-cli without command`);
        }
      }
    }
    if (experiment.repetitions == null || Number(experiment.repetitions) < 1) {
      errors.push('experiment.repetitions must be >= 1');
    }
    if (experiment.seed == null) {
      errors.push('experiment.seed is required for deterministic ordering');
    }
    if (!experiment.suiteId && !experiment.suitePath) {
      errors.push('experiment.suiteId or experiment.suitePath is required');
    }
  }

  if (!corpusRoot) {
    errors.push('corpusRoot is required');
  } else if (!(await isReadableDir(corpusRoot))) {
    errors.push(`corpusRoot not a readable directory: ${corpusRoot}`);
  } else {
    meta.corpusRoot = path.resolve(corpusRoot);
  }

  if (campaignDir) {
    meta.campaignDir = path.resolve(campaignDir);
  }

  if (harnessRoot) {
    const cliPath = path.join(harnessRoot, 'harness', 'cli.js');
    try {
      await access(cliPath, constants.R_OK);
      meta.harnessRoot = path.resolve(harnessRoot);
    } catch {
      warnings.push(`harness cli not found at ${cliPath}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta,
  };
}

/**
 * Self-validation of harness package shape (no live trials).
 * @param {string} repoRoot
 * @returns {Promise<PreflightResult>}
 */
export async function selfValidate(repoRoot) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const root = path.resolve(repoRoot);

  const required = [
    'package.json',
    'harness/cli.js',
    'harness/run.js',
    'harness/contracts.js',
    'schemas/suite.schema.json',
    'schemas/task.schema.json',
    'schemas/experiment.schema.json',
    'schemas/trial.schema.json',
    'schemas/campaign-manifest.schema.json',
    'schemas/report.schema.json',
    'benchmarks/cli-comparison/suite.yaml',
  ];

  for (const rel of required) {
    try {
      await access(path.join(root, rel), constants.R_OK);
    } catch {
      errors.push(`missing required path: ${rel}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: { repoRoot: root },
  };
}
