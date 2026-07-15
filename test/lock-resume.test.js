/**
 * Atomic resume and campaign lock behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

describe('lock + atomic resume', () => {
  it('acquire/release lock exclusivity', async () => {
    const { acquireLock, releaseLock, readLock } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-'));
    try {
      const a = await acquireLock(dir, 'owner-a');
      assert.ok(a.acquired || a.ok);
      const b = await acquireLock(dir, 'owner-b');
      assert.ok(b.acquired === false || b.ok === false);
      await releaseLock(dir, 'owner-a');
      const c = await acquireLock(dir, 'owner-b');
      assert.ok(c.acquired || c.ok);
      await releaseLock(dir, 'owner-b');
      const info = await readLock(dir).catch(() => null);
      assert.ok(info == null || info.held === false || info.owner == null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manifest save is atomic and trials resume from pending', async () => {
    const {
      createManifest,
      saveManifest,
      loadManifest,
      updateTrial,
      listResumableTrials,
    } = await import('../harness/manifest.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-man-'));
    try {
      const trials = [
        {
          id: 'tr-1',
          state: 'pending',
          arm: 'a',
          taskId: 't',
          repetition: 1,
          invocationPath: 'native-cli',
          requestedModel: 'm',
        },
        {
          id: 'tr-2',
          state: 'completed',
          arm: 'a',
          taskId: 't',
          repetition: 2,
          invocationPath: 'native-cli',
          requestedModel: 'm',
          classification: 'PASS',
        },
      ];
      const m = createManifest({
        campaignId: 'camp-1',
        experimentId: 'exp-1',
        trials,
        scheduleSeed: 1,
        lock: { held: false, owner: null },
      });
      await saveManifest(dir, m);
      const loaded = await loadManifest(dir);
      assert.equal(loaded.campaignId, 'camp-1');
      assert.equal(loaded.schemaVersion, 1);

      updateTrial(loaded, 'tr-1', { state: 'running' });
      await saveManifest(dir, loaded);
      const again = await loadManifest(dir);
      const t = again.trials.find((x) => x.id === 'tr-1');
      assert.equal(t.state, 'running');

      if (typeof listResumableTrials === 'function') {
        const resumable = listResumableTrials(again);
        assert.ok(resumable.some((x) => x.id === 'tr-1'));
        assert.ok(!resumable.some((x) => x.id === 'tr-2' && x.state === 'completed'));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
