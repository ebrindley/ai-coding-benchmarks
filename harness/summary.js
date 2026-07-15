/**
 * Human-readable and JSON summary reports (report.schema.json).
 *
 * Critical rule: never silently aggregate different invocationPath,
 * resolvedModel, or postureFingerprint into one stats cell. passRate is
 * computed only on homogeneous cells. Global totals may count n/completed
 * but leave passRate null when the set is heterogeneous.
 */

import { SCHEMA_VERSION, CLASSIFICATIONS } from './contracts.js';

/** Dimensions that must not be mixed inside a passRate cell. */
export const HOMOGENEITY_DIMS = Object.freeze([
  'invocationPath',
  'resolvedModel',
  'requestedModel',
  'postureFingerprint',
]);

/**
 * @returns {{ n: number, completed: number, pass: number, fail: number, noOp: number, infraFail: number, timeout: number, passRate: number|null, meanDurationMs: number|null }}
 */
function emptyStats() {
  return {
    n: 0,
    completed: 0,
    pass: 0,
    fail: 0,
    noOp: 0,
    infraFail: 0,
    timeout: 0,
    passRate: null,
    meanDurationMs: null,
  };
}

/**
 * @param {object} trial
 * @returns {boolean}
 */
function isTerminal(trial) {
  return (
    trial.state === 'completed' ||
    trial.state === 'failed' ||
    trial.state === 'skipped' ||
    (trial.classification != null && trial.classification !== '')
  );
}

/**
 * @param {ReturnType<typeof emptyStats>} stats
 * @param {object} trial
 * @param {{ durations: number[] }} acc
 */
function accumulate(stats, trial, acc) {
  stats.n += 1;
  if (isTerminal(trial)) {
    stats.completed += 1;
  }
  switch (trial.classification) {
    case 'PASS':
      stats.pass += 1;
      break;
    case 'FAIL':
      stats.fail += 1;
      break;
    case 'NO_OP':
      stats.noOp += 1;
      break;
    case 'INFRA_FAIL':
      stats.infraFail += 1;
      break;
    case 'TIMEOUT':
      stats.timeout += 1;
      break;
    default:
      break;
  }
  if (typeof trial.durationMs === 'number' && Number.isFinite(trial.durationMs)) {
    acc.durations.push(trial.durationMs);
  }
}

/**
 * @param {ReturnType<typeof emptyStats>} stats
 * @param {number[]} durations
 * @param {boolean} allowPassRate
 */
function finalizeStats(stats, durations, allowPassRate) {
  if (durations.length > 0) {
    const sum = durations.reduce((a, b) => a + b, 0);
    stats.meanDurationMs = sum / durations.length;
  } else {
    stats.meanDurationMs = null;
  }
  if (allowPassRate && stats.completed > 0) {
    stats.passRate = stats.pass / stats.completed;
  } else {
    stats.passRate = null;
  }
  return stats;
}

/**
 * @param {object} trial
 * @param {string} dim
 * @returns {unknown}
 */
function dimValue(trial, dim) {
  if (dim === 'resolvedModel') {
    // Honest: null when unavailable — never fall back to requestedModel
    return trial.resolvedModel ?? null;
  }
  if (dim === 'requestedModel') {
    return trial.requestedModel ?? null;
  }
  return trial[dim] ?? null;
}

/**
 * Assert that trials are homogeneous across the given dimensions.
 * Does not throw by default — returns { ok, refusals }.
 * When opts.throwOnFail is true, throws Error on failure.
 *
 * @param {object[]} trials
 * @param {object} [opts]
 * @param {string[]} [opts.dimensions]
 * @param {boolean} [opts.throwOnFail=false]
 * @returns {{ ok: boolean, refusals: object[], values?: Record<string, unknown[]> }}
 */
export function assertHomogeneous(trials, opts = {}) {
  const dimensions = opts.dimensions ?? [...HOMOGENEITY_DIMS];
  const list = Array.isArray(trials) ? trials : [];
  /** @type {object[]} */
  const refusals = [];
  /** @type {Record<string, Set<string>>} */
  const seen = {};

  for (const dim of dimensions) {
    seen[dim] = new Set();
  }

  for (const t of list) {
    for (const dim of dimensions) {
      const v = dimValue(t, dim);
      seen[dim].add(JSON.stringify(v));
    }
  }

  /** @type {Record<string, unknown[]>} */
  const values = {};
  for (const dim of dimensions) {
    values[dim] = [...seen[dim]].map((s) => JSON.parse(s));
    if (seen[dim].size > 1) {
      refusals.push({
        reason: `refused to aggregate mixed ${dim}`,
        dimensions: [dim],
        detail: `found ${seen[dim].size} distinct values: ${[...seen[dim]].join(', ')}`,
      });
    }
  }

  const ok = refusals.length === 0;
  if (!ok && opts.throwOnFail) {
    const msg = refusals.map((r) => r.reason).join('; ');
    const err = new Error(`assertHomogeneous failed: ${msg}`);
    /** @type {any} */ (err).refusals = refusals;
    throw err;
  }

  return { ok, refusals, values };
}

/**
 * Build a report.schema.json SummaryReport from a manifest and trial results.
 *
 * Cells are keyed by (arm, taskId, invocationPath, resolvedModel, postureFingerprint).
 * passRate is only set on those homogeneous cells (and on byArm/byTask slices
 * that remain path/model/posture-homogeneous). Global totals leave passRate null
 * when the campaign spans multiple cells.
 *
 * @param {object} manifest
 * @param {object[]} trialResults
 * @returns {object}
 */
export function buildReport(manifest, trialResults) {
  const results = Array.isArray(trialResults) ? trialResults : [];
  const campaignId =
    manifest?.campaignId != null
      ? String(manifest.campaignId)
      : 'unknown-campaign';
  const experimentId =
    manifest?.experimentId != null ? String(manifest.experimentId) : null;

  // Aggregate ONLY the supplied trialResults. Do not seed from
  // manifest.trials — pending/skipped/unverified rows must not inflate
  // n/completed/classifications. Callers pass verified reportableResults.
  /** @type {object[]} */
  const trials = [];
  for (const r of results) {
    if (r == null || typeof r !== 'object') continue;
    trials.push(r);
  }

  /** @type {Map<string, { cell: object, stats: ReturnType<typeof emptyStats>, durations: number[] }>} */
  const cellMap = new Map();

  for (const t of trials) {
    const arm = t.arm != null ? String(t.arm) : 'unknown';
    const taskId = t.taskId != null ? String(t.taskId) : 'unknown';
    const invocationPath = t.invocationPath != null ? String(t.invocationPath) : 'unknown';
    const requestedModel =
      t.requestedModel != null ? String(t.requestedModel) : null;
    // Honest: resolvedModel stays null when unavailable (no invent from requested)
    const resolvedModel =
      t.resolvedModel != null ? String(t.resolvedModel) : null;
    const postureFingerprint =
      t.postureFingerprint != null ? String(t.postureFingerprint) : null;
    // Separate cells by requestedModel when resolved is unavailable
    const key = [
      arm,
      taskId,
      invocationPath,
      requestedModel ?? '',
      resolvedModel ?? '',
      postureFingerprint ?? '',
    ].join('\0');

    let entry = cellMap.get(key);
    if (!entry) {
      entry = {
        cell: {
          arm,
          taskId,
          invocationPath,
          requestedModel: requestedModel ?? undefined,
          resolvedModel,
          postureFingerprint,
          provider: t.provider != null ? String(t.provider) : undefined,
        },
        stats: emptyStats(),
        durations: [],
      };
      cellMap.set(key, entry);
    }
    accumulate(entry.stats, t, { durations: entry.durations });
  }

  /** @type {object[]} */
  const cells = [];
  for (const entry of cellMap.values()) {
    finalizeStats(entry.stats, entry.durations, true);
    cells.push({
      ...entry.cell,
      stats: entry.stats,
    });
  }
  cells.sort((a, b) => {
    const ka = `${a.arm}\0${a.taskId}\0${a.invocationPath}`;
    const kb = `${b.arm}\0${b.taskId}\0${b.invocationPath}`;
    return ka.localeCompare(kb);
  });

  // Global totals: counts always; passRate only if the whole set is one homogeneous cell
  const totals = emptyStats();
  const totalDurations = [];
  for (const t of trials) {
    accumulate(totals, t, { durations: totalDurations });
  }
  const globalHomogeneous = assertHomogeneous(trials);
  const singleCell = cellMap.size <= 1;
  finalizeStats(
    totals,
    totalDurations,
    globalHomogeneous.ok && singleCell,
  );

  /** @type {object[]} */
  const refusals = [];
  if (!globalHomogeneous.ok && trials.length > 0) {
    // Record that global passRate was refused (not an error — expected multi-arm campaigns)
    refusals.push({
      reason:
        'global totals passRate withheld: campaign spans mixed invocationPath/resolvedModel/postureFingerprint',
      dimensions: globalHomogeneous.refusals.flatMap((r) => r.dimensions),
      detail: `cells=${cellMap.size}; ${globalHomogeneous.refusals.map((r) => r.detail).join('; ')}`,
    });
  }

  // byArm: one entry per (arm, invocationPath, requestedModel, resolvedModel, postureFingerprint)
  /** @type {Map<string, { row: object, stats: ReturnType<typeof emptyStats>, durations: number[], trials: object[] }>} */
  const armMap = new Map();
  for (const t of trials) {
    const arm = t.arm != null ? String(t.arm) : 'unknown';
    const invocationPath =
      t.invocationPath != null ? String(t.invocationPath) : 'unknown';
    const requestedModel =
      t.requestedModel != null ? String(t.requestedModel) : undefined;
    const resolvedModel =
      t.resolvedModel != null ? String(t.resolvedModel) : null;
    const postureFingerprint =
      t.postureFingerprint != null ? String(t.postureFingerprint) : null;
    const key = [
      arm,
      invocationPath,
      requestedModel ?? '',
      resolvedModel ?? '',
      postureFingerprint ?? '',
    ].join('\0');
    let entry = armMap.get(key);
    if (!entry) {
      entry = {
        row: {
          arm,
          provider: t.provider != null ? String(t.provider) : undefined,
          invocationPath,
          requestedModel,
          resolvedModel,
          postureFingerprint,
        },
        stats: emptyStats(),
        durations: [],
        trials: [],
      };
      armMap.set(key, entry);
    }
    entry.trials.push(t);
    accumulate(entry.stats, t, { durations: entry.durations });
  }

  /** @type {object[]} */
  const byArm = [];
  for (const entry of armMap.values()) {
    const h = assertHomogeneous(entry.trials);
    if (!h.ok) {
      refusals.push(...h.refusals);
    }
    finalizeStats(entry.stats, entry.durations, h.ok);
    byArm.push({ ...entry.row, stats: entry.stats });
  }
  byArm.sort((a, b) => String(a.arm).localeCompare(String(b.arm)));

  // byTask with nested byArm slices (also path/model/posture homogeneous)
  /** @type {Map<string, { taskId: string, stats: ReturnType<typeof emptyStats>, durations: number[], armMap: Map<string, any> }>} */
  const taskMap = new Map();
  for (const t of trials) {
    const taskId = t.taskId != null ? String(t.taskId) : 'unknown';
    let taskEntry = taskMap.get(taskId);
    if (!taskEntry) {
      taskEntry = {
        taskId,
        stats: emptyStats(),
        durations: [],
        armMap: new Map(),
        trials: [],
      };
      taskMap.set(taskId, taskEntry);
    }
    taskEntry.trials.push(t);
    accumulate(taskEntry.stats, t, { durations: taskEntry.durations });

    const arm = t.arm != null ? String(t.arm) : 'unknown';
    const invocationPath =
      t.invocationPath != null ? String(t.invocationPath) : 'unknown';
    const requestedModel =
      t.requestedModel != null ? String(t.requestedModel) : null;
    const resolvedModel =
      t.resolvedModel != null ? String(t.resolvedModel) : null;
    const postureFingerprint =
      t.postureFingerprint != null ? String(t.postureFingerprint) : null;
    const akey = [
      arm,
      invocationPath,
      requestedModel ?? '',
      resolvedModel ?? '',
      postureFingerprint ?? '',
    ].join('\0');
    let aEntry = taskEntry.armMap.get(akey);
    if (!aEntry) {
      aEntry = {
        row: {
          arm,
          invocationPath,
          requestedModel: requestedModel ?? undefined,
          resolvedModel,
          postureFingerprint,
        },
        stats: emptyStats(),
        durations: [],
        trials: [],
      };
      taskEntry.armMap.set(akey, aEntry);
    }
    aEntry.trials.push(t);
    accumulate(aEntry.stats, t, { durations: aEntry.durations });
  }

  /** @type {object[]} */
  const byTask = [];
  for (const taskEntry of taskMap.values()) {
    // Task-level passRate only if all nested slices share path/model/posture
    const taskHomogeneous = assertHomogeneous(taskEntry.trials);
    finalizeStats(
      taskEntry.stats,
      taskEntry.durations,
      taskHomogeneous.ok,
    );
    if (!taskHomogeneous.ok) {
      refusals.push({
        reason: `byTask[${taskEntry.taskId}] passRate withheld: mixed dimensions`,
        dimensions: taskHomogeneous.refusals.flatMap((r) => r.dimensions),
        detail: taskHomogeneous.refusals.map((r) => r.detail).join('; '),
      });
    }

    /** @type {object[]} */
    const nested = [];
    for (const aEntry of taskEntry.armMap.values()) {
      const h = assertHomogeneous(aEntry.trials);
      finalizeStats(aEntry.stats, aEntry.durations, h.ok);
      nested.push({ ...aEntry.row, stats: aEntry.stats });
    }
    nested.sort((a, b) => String(a.arm).localeCompare(String(b.arm)));

    byTask.push({
      taskId: taskEntry.taskId,
      stats: taskEntry.stats,
      byArm: nested,
    });
  }
  byTask.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));

  /** @type {Record<string, number>} */
  const classifications = {
    PASS: 0,
    FAIL: 0,
    NO_OP: 0,
    INFRA_FAIL: 0,
    TIMEOUT: 0,
  };
  for (const c of CLASSIFICATIONS) {
    classifications[c] = 0;
  }
  for (const t of trials) {
    if (t.classification && classifications[t.classification] != null) {
      classifications[t.classification] += 1;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    campaignId,
    experimentId,
    generatedAt: new Date().toISOString(),
    totals,
    byArm,
    byTask,
    cells,
    refusals,
    classifications,
  };
}

/**
 * Quiet multi-line human summary of a report.
 * @param {object} report
 * @returns {string}
 */
export function formatHumanSummary(report) {
  if (!report || typeof report !== 'object') {
    return 'summary: empty report';
  }

  const lines = [];
  lines.push(`Campaign: ${report.campaignId ?? 'unknown'}`);
  if (report.experimentId) {
    lines.push(`Experiment: ${report.experimentId}`);
  }
  if (report.generatedAt) {
    lines.push(`Generated: ${report.generatedAt}`);
  }

  const t = report.totals || {};
  lines.push(
    `Totals: n=${t.n ?? 0} completed=${t.completed ?? 0}` +
      (t.passRate != null ? ` passRate=${t.passRate.toFixed(3)}` : ' passRate=n/a'),
  );

  if (report.classifications) {
    const c = report.classifications;
    lines.push(
      `Classifications: PASS=${c.PASS ?? 0} FAIL=${c.FAIL ?? 0} NO_OP=${c.NO_OP ?? 0} INFRA_FAIL=${c.INFRA_FAIL ?? 0} TIMEOUT=${c.TIMEOUT ?? 0}`,
    );
  }

  if (Array.isArray(report.byArm) && report.byArm.length > 0) {
    lines.push('By arm:');
    for (const row of report.byArm) {
      const s = row.stats || {};
      const rate =
        s.passRate != null ? s.passRate.toFixed(3) : 'n/a';
      lines.push(
        `  ${row.arm} path=${row.invocationPath ?? '?'} model=${row.resolvedModel ?? row.requestedModel ?? '?'} posture=${short(row.postureFingerprint)}: n=${s.n ?? 0} completed=${s.completed ?? 0} passRate=${rate}`,
      );
    }
  }

  if (Array.isArray(report.cells) && report.cells.length > 0) {
    lines.push(`Cells (${report.cells.length}):`);
    for (const cell of report.cells) {
      const s = cell.stats || {};
      const rate =
        s.passRate != null ? s.passRate.toFixed(3) : 'n/a';
      lines.push(
        `  ${cell.arm} / ${cell.taskId} / ${cell.invocationPath} / model=${cell.resolvedModel ?? '?'} / posture=${short(cell.postureFingerprint)}: pass=${s.pass ?? 0}/${s.completed ?? 0} rate=${rate}`,
      );
    }
  }

  if (Array.isArray(report.refusals) && report.refusals.length > 0) {
    lines.push(`Refusals: ${report.refusals.length}`);
    for (const r of report.refusals.slice(0, 5)) {
      lines.push(`  - ${r.reason}`);
    }
    if (report.refusals.length > 5) {
      lines.push(`  … ${report.refusals.length - 5} more`);
    }
  }

  return lines.join('\n');
}

/**
 * @param {unknown} fp
 * @returns {string}
 */
function short(fp) {
  if (fp == null || fp === '') return 'none';
  const s = String(fp);
  return s.length <= 12 ? s : `${s.slice(0, 12)}…`;
}
