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
});
