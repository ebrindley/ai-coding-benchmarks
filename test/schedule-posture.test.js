/**
 * Deterministic matrix order and cross-path/model/posture aggregation refusal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('schedule + aggregation refusal', () => {
  it('expands experiment deterministically for the same seed', async () => {
    const { expandExperiment } = await import('../harness/schedule.js');
    const experiment = {
      id: 'exp-1',
      schemaVersion: 1,
      seed: 42,
      repetitions: 2,
      arms: [
        {
          name: 'a-poetic',
          provider: 'poetic',
          model: 'model-x',
          invocationPath: 'poetic-adapter',
        },
        {
          name: 'b-native',
          provider: 'native',
          model: 'model-y',
          invocationPath: 'native-cli',
          command: 'true',
        },
      ],
    };
    const tasks = [{ taskId: 't1' }, { taskId: 't2' }];
    const once = expandExperiment(experiment, { tasks, arms: experiment.arms });
    const twice = expandExperiment(experiment, { tasks, arms: experiment.arms });
    assert.equal(once.length, 2 * 2 * 2);
    assert.deepEqual(
      once.map((t) => t.id),
      twice.map((t) => t.id),
    );
    // Different seed → different order (or at least allowed to differ)
    const other = expandExperiment(
      { ...experiment, seed: 99 },
      { tasks, arms: experiment.arms },
    );
    assert.equal(other.length, once.length);
  });

  it('nextTrial respects one-active-trial-per-provider', async () => {
    const { nextTrial } = await import('../harness/schedule.js');
    const pending = [
      {
        id: '1',
        provider: 'p1',
        arm: 'a',
        taskId: 't',
        state: 'pending',
        invocationPath: 'native-cli',
      },
      {
        id: '2',
        provider: 'p1',
        arm: 'a',
        taskId: 't',
        state: 'pending',
        invocationPath: 'native-cli',
      },
      {
        id: '3',
        provider: 'p2',
        arm: 'b',
        taskId: 't',
        state: 'pending',
        invocationPath: 'poetic-adapter',
      },
    ];
    const active = [
      {
        id: '0',
        provider: 'p1',
        arm: 'a',
        state: 'running',
        invocationPath: 'native-cli',
      },
    ];
    const pick = nextTrial(pending, { oneActivePerProvider: true, active });
    assert.ok(pick);
    assert.equal(pick.provider, 'p2');
  });

  it('refuses silent aggregation across invocationPath/model/posture', async () => {
    const { buildReport } = await import('../harness/summary.js');
    const manifest = {
      campaignId: 'c1',
      schemaVersion: 1,
      status: 'completed',
      trials: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lock: { held: false, owner: null },
    };
    const results = [
      {
        id: 't1',
        arm: 'a',
        taskId: 'task',
        invocationPath: 'poetic-adapter',
        requestedModel: 'm1',
        resolvedModel: null,
        postureFingerprint: 'a'.repeat(64),
        classification: 'PASS',
        state: 'completed',
      },
      {
        id: 't2',
        arm: 'a',
        taskId: 'task',
        invocationPath: 'native-cli',
        requestedModel: 'm1',
        resolvedModel: null,
        postureFingerprint: 'a'.repeat(64),
        classification: 'PASS',
        state: 'completed',
      },
      {
        id: 't3',
        arm: 'a',
        taskId: 'task',
        invocationPath: 'native-cli',
        requestedModel: 'm2',
        resolvedModel: null,
        postureFingerprint: 'a'.repeat(64),
        classification: 'FAIL',
        state: 'completed',
      },
    ];
    const report = buildReport(manifest, results);
    assert.ok(Array.isArray(report.cells));
    const mixed = report.cells.filter(
      (c) => c.taskId === 'task' && c.arm === 'a' && !c.invocationPath,
    );
    assert.equal(mixed.length, 0);
    const paths = new Set(report.cells.map((c) => c.invocationPath));
    assert.ok(paths.has('poetic-adapter'));
    assert.ok(paths.has('native-cli'));
    // When resolvedModel is unavailable, distinct requestedModels stay separate
    const nativeCells = report.cells.filter((c) => c.invocationPath === 'native-cli');
    assert.ok(nativeCells.length >= 2);
    for (const cell of report.cells) {
      assert.ok(cell.invocationPath);
      assert.ok('postureFingerprint' in cell);
      // Never invent resolvedModel from requested
      if (cell.resolvedModel != null) {
        assert.equal(typeof cell.resolvedModel, 'string');
      }
    }
  });

  it('pools terminal observations while preserving conditional capability rates', async () => {
    const { buildReport } = await import('../harness/summary.js');
    const base = { arm: 'a', invocationPath: 'native-cli', requestedModel: 'm', resolvedModel: null, postureFingerprint: null, state: 'completed' };
    const results = [
      { ...base, id: 'a', taskId: 'one', classification: 'PASS', durationMs: 10 },
      { ...base, id: 'b', taskId: 'two', classification: 'TIMEOUT', durationMs: 100 },
      { ...base, id: 'c', taskId: 'two', classification: 'TIMEOUT', durationMs: 100 },
    ];
    const report = buildReport({ trials: results }, results);
    const stats = report.byArm[0].stats;
    assert.equal(stats.passRate, 1 / 3);
    assert.equal(stats.timeoutRate, 2 / 3);
    assert.equal(stats.infraRate, 0);
    assert.equal(stats.meanDurationMs, 70);
    assert.equal(stats.capabilityPassRate, 1);
    assert.equal(report.byTask.find((t) => t.taskId === 'two').stats.capabilityPassRate, null);
  });

  it('excludes unfinished and off-schedule rows, withholding incomplete slice rates', async () => {
    const { buildReport } = await import('../harness/summary.js');
    const base = { arm: 'a', taskId: 't', invocationPath: 'native-cli', requestedModel: null, classification: 'PASS', durationMs: 10 };
    const scheduled = ['done', 'pending', 'running', 'skipped', 'unavailable'].map((id) => ({ ...base, id }));
    const results = [
      { ...base, id: 'done', state: 'completed' },
      { ...base, id: 'pending', state: 'pending', durationMs: 1000 },
      { ...base, id: 'running', state: 'running', durationMs: 1000 },
      { ...base, id: 'skipped', state: 'skipped', durationMs: 1000 },
      { ...base, id: 'off-schedule', state: 'completed', durationMs: 1000 },
    ];
    const report = buildReport({ trials: scheduled }, results);
    assert.equal(report.totals.completed, 1);
    assert.equal(report.totals.pass, 1);
    assert.equal(report.byArm[0].stats.meanDurationMs, 10);
    for (const name of ['passRate', 'capabilityPassRate', 'infraRate', 'timeoutRate']) {
      assert.equal(report.byArm[0].stats[name], null, name);
      assert.equal(report.cells[0].stats[name], null, name);
    }
    assert.match(report.refusals[0].reason, /incomplete/);
  });

  it('keeps null and empty requested-model identities in separate cells', async () => {
    const { buildReport } = await import('../harness/summary.js');
    const results = [null, ''].map((requestedModel, i) => ({
      id: String(i), arm: 'a', taskId: 't', invocationPath: 'native-cli',
      requestedModel, classification: 'PASS', state: 'completed',
    }));
    const report = buildReport({ trials: results }, results);
    assert.equal(report.cells.length, 2);
    assert.equal(report.byArm.length, 2);
    assert.equal(report.byTask[0].byArm.length, 2);
    assert.equal(report.totals.passRate, null);
  });

  it('withholds rates from resolved-model partitions of one frozen scheduled slice', async () => {
    const { buildReport } = await import('../harness/summary.js');
    const base = { arm: 'a', taskId: 't', invocationPath: 'poetic-adapter', requestedModel: 'm', postureFingerprint: null };
    const schedule = ['pass', 'unattested'].map((id) => ({ ...base, id }));
    for (const classification of ['TIMEOUT', 'INFRA_FAIL']) {
      const results = [
        { ...base, id: 'pass', state: 'completed', classification: 'PASS', resolvedModel: 'actual-model', durationMs: 10 },
        { ...base, id: 'unattested', state: 'failed', classification, resolvedModel: null, durationMs: 100 },
      ];
      const report = buildReport({ trials: schedule }, results);
      assert.equal(report.totals.completed, 2);
      assert.equal(report.totals.meanDurationMs, 55);
      assert.equal(report.cells.length, 2);
      for (const row of [...report.cells, ...report.byArm, ...report.byTask[0].byArm]) {
        assert.equal(row.stats.completed, 1);
        assert.equal(row.stats.meanDurationMs, row.resolvedModel === null ? 100 : 10);
        for (const rate of ['passRate', 'capabilityPassRate', 'infraRate', 'timeoutRate']) assert.equal(row.stats[rate], null);
      }
      assert.equal(report.byTask[0].stats.passRate, null);
    }
  });
});
