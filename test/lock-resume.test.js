/**
 * Atomic resume, campaign lock, dead-owner recovery, and frozen input digests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(REPO, 'benchmarks');

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

  it('refuses to steal a live same-host lock', async () => {
    const {
      acquireLock,
      releaseLock,
      lockPath,
      isPidAlive,
    } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-live-lock-'));
    try {
      // Simulate a live owner: current process pid + matching owner metadata.
      assert.equal(isPidAlive(process.pid), true);
      const livePayload = {
        owner: `aicb-${process.pid}-${Date.now()}`,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        pid: process.pid,
        hostname: os.hostname(),
      };
      await writeFile(
        lockPath(dir),
        `${JSON.stringify(livePayload, null, 2)}\n`,
        'utf8',
      );

      const steal = await acquireLock(dir, 'other-owner', { minAgeMs: 0 });
      assert.equal(steal.ok, false);
      assert.equal(steal.acquired, false);
      assert.match(String(steal.error), /alive|held/i);

      // Cleanup via force unlink by matching owner release is not possible;
      // release with the live owner id.
      await releaseLock(dir, livePayload.owner);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers a dead-owner lock with pid + age evidence', async () => {
    const {
      acquireLock,
      releaseLock,
      lockPath,
      isPidAlive,
      canRecoverDeadLock,
    } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-dead-lock-'));
    try {
      // Obtain a definitely-dead pid by spawning a short-lived process.
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      });
      // child.pid may be reused; prefer a high unused pid if still alive.
      let deadPid = child.pid;
      if (deadPid == null || isPidAlive(deadPid) !== false) {
        deadPid = 2147483646;
        if (isPidAlive(deadPid) !== false) {
          // Extremely unlikely; skip recovery assertion path.
          deadPid = null;
        }
      }
      assert.ok(deadPid != null, 'need a dead pid for recovery test');
      assert.equal(isPidAlive(deadPid), false);

      const deadPayload = {
        owner: `aicb-${deadPid}-111`,
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        pid: deadPid,
        hostname: os.hostname(),
      };
      const decision = canRecoverDeadLock(deadPayload, { minAgeMs: 30_000 });
      assert.equal(decision.recoverable, true);

      await writeFile(
        lockPath(dir),
        `${JSON.stringify(deadPayload, null, 2)}\n`,
        'utf8',
      );

      const recovered = await acquireLock(dir, 'new-owner', { minAgeMs: 30_000 });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.acquired, true);
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.owner, 'new-owner');

      await releaseLock(dir, 'new-owner');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not recover ambiguous locks (missing pid or foreign host)', async () => {
    const { canRecoverDeadLock } = await import('../harness/lock.js');
    assert.equal(
      canRecoverDeadLock({
        owner: 'x',
        acquiredAt: new Date(0).toISOString(),
        hostname: os.hostname(),
      }).recoverable,
      false,
    );
    assert.equal(
      canRecoverDeadLock({
        owner: 'x',
        pid: 2147483646,
        acquiredAt: new Date(0).toISOString(),
        hostname: 'other-host-not-this-machine',
      }).recoverable,
      false,
    );
  });

  it('recovery guard serializes reclaimers (compare-then-unlink race)', async () => {
    const {
      acquireLock,
      releaseLock,
      lockPath,
      lockRecoverPath,
      isPidAlive,
      canRecoverDeadLock,
    } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-race-'));
    try {
      let deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      }).pid;
      if (deadPid == null || isPidAlive(deadPid) !== false) {
        deadPid = 2147483645;
        if (isPidAlive(deadPid) !== false) {
          assert.fail('need a dead pid for recovery race test');
        }
      }

      const deadPayload = {
        owner: `aicb-${deadPid}-race`,
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        pid: deadPid,
        hostname: os.hostname(),
      };
      assert.equal(
        canRecoverDeadLock(deadPayload, { minAgeMs: 30_000 }).recoverable,
        true,
      );
      await writeFile(
        lockPath(dir),
        `${JSON.stringify(deadPayload, null, 2)}\n`,
        'utf8',
      );

      // Hold the recovery guard with live identity so concurrent reclaimer fail closed
      // rather than unlinking a lock that may already be live.
      await writeFile(
        lockRecoverPath(dir),
        `${JSON.stringify({
          owner: 'guard-holder',
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { flag: 'wx' },
      );

      const blocked = await acquireLock(dir, 'racer-a', { minAgeMs: 30_000 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.acquired, false);
      assert.match(String(blocked.error), /recovery already in progress|fail closed|alive/i);

      // Original dead lock still present (blocked reclaimer must not have unlinked).
      const stillThere = JSON.parse(await readFile(lockPath(dir), 'utf8'));
      assert.equal(stillThere.owner, deadPayload.owner);

      // Release guard; single reclaimer then succeeds.
      await rm(lockRecoverPath(dir), { force: true });
      const recovered = await acquireLock(dir, 'racer-b', { minAgeMs: 30_000 });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.owner, 'racer-b');

      // Live lock held by racer-b must not be stolen.
      const steal = await acquireLock(dir, 'racer-c', { minAgeMs: 0 });
      assert.equal(steal.ok, false);
      assert.match(String(steal.error), /alive|held/i);

      await releaseLock(dir, 'racer-b');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to steal a live recovery guard', async () => {
    const {
      acquireLock,
      lockPath,
      lockRecoverPath,
      isPidAlive,
      canRecoverDeadGuard,
    } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-live-guard-'));
    try {
      let deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      }).pid;
      if (deadPid == null || isPidAlive(deadPid) !== false) {
        deadPid = 2147483644;
        if (isPidAlive(deadPid) !== false) {
          assert.fail('need a dead pid');
        }
      }

      // Dead main lock so recovery path is taken.
      await writeFile(
        lockPath(dir),
        `${JSON.stringify({
          owner: `aicb-${deadPid}-lg`,
          acquiredAt: new Date(Date.now() - 120_000).toISOString(),
          pid: deadPid,
          hostname: os.hostname(),
        }, null, 2)}\n`,
        'utf8',
      );

      const liveGuard = {
        owner: 'live-reclaimer',
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date(Date.now() - 120_000).toISOString(),
      };
      assert.equal(isPidAlive(process.pid), true);
      assert.equal(
        canRecoverDeadGuard(liveGuard, { minAgeMs: 0 }).recoverable,
        false,
      );
      await writeFile(
        lockRecoverPath(dir),
        `${JSON.stringify(liveGuard, null, 2)}\n`,
        { flag: 'wx' },
      );

      const steal = await acquireLock(dir, 'thief', { minAgeMs: 0 });
      assert.equal(steal.ok, false);
      assert.match(String(steal.error), /recovery already in progress|alive|fail closed/i);

      // Main lock must remain the original dead owner (not unlinked).
      const still = JSON.parse(await readFile(lockPath(dir), 'utf8'));
      assert.equal(still.pid, deadPid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a crashed/stale recovery guard (dead pid + age)', async () => {
    const {
      acquireLock,
      releaseLock,
      lockPath,
      lockRecoverPath,
      isPidAlive,
      canRecoverDeadGuard,
      readRecoveryGuard,
    } = await import('../harness/lock.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-stale-guard-'));
    try {
      let deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      }).pid;
      if (deadPid == null || isPidAlive(deadPid) !== false) {
        deadPid = 2147483643;
        if (isPidAlive(deadPid) !== false) {
          assert.fail('need a dead pid');
        }
      }

      // Dead main lock
      await writeFile(
        lockPath(dir),
        `${JSON.stringify({
          owner: `aicb-${deadPid}-main`,
          acquiredAt: new Date(Date.now() - 180_000).toISOString(),
          pid: deadPid,
          hostname: os.hostname(),
        }, null, 2)}\n`,
        'utf8',
      );

      // Stale guard left by crashed reclaimer (different dead pid)
      let guardDeadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      }).pid;
      if (guardDeadPid == null || isPidAlive(guardDeadPid) !== false) {
        guardDeadPid = deadPid; // same dead pid is fine for liveness
      }
      const staleGuard = {
        owner: 'crashed-reclaimer',
        pid: guardDeadPid,
        hostname: os.hostname(),
        startedAt: new Date(Date.now() - 180_000).toISOString(),
      };
      assert.equal(
        canRecoverDeadGuard(staleGuard, { minAgeMs: 30_000 }).recoverable,
        true,
      );
      await writeFile(
        lockRecoverPath(dir),
        `${JSON.stringify(staleGuard, null, 2)}\n`,
        { flag: 'wx' },
      );

      const recovered = await acquireLock(dir, 'new-owner', {
        minAgeMs: 30_000,
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.acquired, true);
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.owner, 'new-owner');

      // Guard must be released after successful reclaim.
      const guardAfter = await readRecoveryGuard(dir);
      assert.equal(guardAfter, null);

      await releaseLock(dir, 'new-owner');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reclaim ambiguous recovery guards', async () => {
    const { canRecoverDeadGuard } = await import('../harness/lock.js');
    // Missing pid
    assert.equal(
      canRecoverDeadGuard({
        owner: 'x',
        hostname: os.hostname(),
        startedAt: new Date(0).toISOString(),
      }).recoverable,
      false,
    );
    // Foreign host
    assert.equal(
      canRecoverDeadGuard({
        owner: 'x',
        pid: 2147483642,
        hostname: 'other-host-not-this-machine',
        startedAt: new Date(0).toISOString(),
      }).recoverable,
      false,
    );
    // Missing hostname
    assert.equal(
      canRecoverDeadGuard({
        owner: 'x',
        pid: 2147483642,
        startedAt: new Date(0).toISOString(),
      }).recoverable,
      false,
    );
    // Too young
    assert.equal(
      canRecoverDeadGuard(
        {
          owner: 'x',
          pid: 2147483642,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        },
        { minAgeMs: 30_000 },
      ).recoverable,
      false,
    );
  });

  it('rejects unsafe campaign ids (traversal/absolute/overlong)', async () => {
    const {
      createManifest,
      validateManifest,
    } = await import('../harness/manifest.js');
    const { assertSafeCampaignId, PathEscapeError } = await import(
      '../harness/paths.js'
    );
    const { preflight } = await import('../harness/preflight.js');

    assert.equal(assertSafeCampaignId('camp-ok'), 'camp-ok');
    assert.throws(() => assertSafeCampaignId('../escape'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('/abs/path'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('a/b'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId(''), /required/i);
    assert.throws(
      () => assertSafeCampaignId(`x${'y'.repeat(200)}`),
      PathEscapeError,
    );

    assert.throws(
      () =>
        createManifest({
          campaignId: '../escape',
          trials: [{ id: 'tr-1', state: 'pending' }],
        }),
      /campaign id|unsafe|invalid/i,
    );
    assert.throws(
      () =>
        createManifest({
          campaignId: '/tmp/abs',
          trials: [{ id: 'tr-1', state: 'pending' }],
        }),
      /campaign id|unsafe|invalid/i,
    );
    assert.throws(
      () =>
        validateManifest({
          campaignId: `overlong-${'z'.repeat(200)}`,
          schemaVersion: 1,
          status: 'pending',
          lock: { held: false, owner: null },
          trials: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      /campaignId|charset|length|invalid/i,
    );

    const pf = await preflight({
      experiment: {
        id: '../evil',
        schemaVersion: 1,
        suiteId: 'cli-comparison',
        arms: [
          {
            name: 'a',
            provider: 'p',
            model: 'm',
            invocationPath: 'native-cli',
          },
        ],
        repetitions: 1,
        seed: 1,
      },
      corpusRoot: CORPUS,
    });
    assert.equal(pf.ok, false);
    assert.ok(pf.errors.some((e) => /campaign id|experiment\.id/i.test(e)));
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

  it('rejects unsafe trial ids on create/load', async () => {
    const {
      createManifest,
      saveManifest,
      loadManifest,
      validateManifest,
    } = await import('../harness/manifest.js');

    assert.throws(
      () =>
        createManifest({
          campaignId: 'c',
          trials: [{ id: '../escape', state: 'pending' }],
        }),
      /unsafe|invalid|trial id/i,
    );
    assert.throws(
      () =>
        createManifest({
          campaignId: 'c',
          trials: [{ id: 'a/b', state: 'pending' }],
        }),
      /unsafe|invalid|trial id/i,
    );
    assert.throws(
      () =>
        validateManifest({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'pending',
          lock: { held: false, owner: null },
          trials: [{ id: 'ok', state: 'not-a-state' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      /state/i,
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bad-man-'));
    try {
      const m = createManifest({
        campaignId: 'camp-ok',
        trials: [{ id: 'tr-ok', state: 'pending' }],
        lock: { held: false, owner: null },
      });
      await saveManifest(dir, m);
      // Corrupt on disk with unsafe trial id
      const raw = JSON.parse(
        await readFile(path.join(dir, 'manifest.json'), 'utf8'),
      );
      raw.trials[0].id = '..';
      await writeFile(
        path.join(dir, 'manifest.json'),
        `${JSON.stringify(raw, null, 2)}\n`,
        'utf8',
      );
      await assert.rejects(() => loadManifest(dir), /unsafe|invalid|trial id/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('freezes input digests on create; resume matches; mutation fails closed', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const { loadManifest } = await import('../harness/manifest.js');
    const { sha256Json } = await import('../harness/digest.js');

    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-digest-'));
    try {
      const experiment = {
        id: 'digest-resume-test',
        schemaVersion: 1,
        suiteId: 'cli-comparison',
        taskIds: ['greenfield-003-js-event-emitter'],
        repetitions: 1,
        seed: 42,
        timeoutMs: 5000,
        arms: [
          {
            name: 'fake',
            provider: 'fake',
            model: 'none',
            invocationPath: 'native-cli',
            command: 'true',
            args: [],
          },
        ],
      };

      const created = await runCampaign({
        experiment,
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: false,
      });
      assert.equal(created.ok, true);
      assert.ok(created.manifest.inputDigests);
      assert.equal(created.manifest.inputDigests.schemaVersion, 1);
      assert.match(created.manifest.inputDigests.experiment, /^[a-f0-9]{64}$/);
      assert.match(created.manifest.inputDigests.suite, /^[a-f0-9]{64}$/);
      assert.match(created.manifest.inputDigests.tasks, /^[a-f0-9]{64}$/);
      assert.match(created.manifest.inputDigests.harness, /^[a-f0-9]{64}$/);
      assert.equal(
        created.manifest.inputDigests.experiment,
        sha256Json(experiment),
      );

      // Deterministic resume with same inputs succeeds.
      const resumed = await runCampaign({
        experiment,
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: true,
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.stage, 'expanded');
      assert.deepEqual(
        resumed.manifest.inputDigests,
        created.manifest.inputDigests,
      );

      // Mutated experiment fails closed on resume (even if digests of corpus match).
      const mutated = {
        ...experiment,
        arms: [
          {
            ...experiment.arms[0],
            model: 'mutated-model',
          },
        ],
      };
      const mismatchExp = await runCampaign({
        experiment: mutated,
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: true,
      });
      assert.equal(mismatchExp.ok, false);
      assert.equal(mismatchExp.stage, 'resume');
      assert.ok(
        mismatchExp.errors.some((e) =>
          /frozen manifest\.experiment|fail closed/i.test(e),
        ),
      );

      // Tamper frozen digests on disk → fail closed.
      const onDisk = await loadManifest(campaignDir);
      onDisk.inputDigests = {
        ...onDisk.inputDigests,
        experiment: '0'.repeat(64),
      };
      await writeFile(
        path.join(campaignDir, 'manifest.json'),
        `${JSON.stringify(onDisk, null, 2)}\n`,
        'utf8',
      );
      const mismatchDigest = await runCampaign({
        experiment,
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: true,
      });
      assert.equal(mismatchDigest.ok, false);
      assert.equal(mismatchDigest.stage, 'resume');
      assert.ok(
        mismatchDigest.errors.some((e) => /digest mismatch|fail closed/i.test(e)),
      );
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });
});

describe('path containment for trial ids', () => {
  it('assertSafeTrialId and trialPathUnder reject traversal', async () => {
    const {
      assertSafeTrialId,
      trialPathUnder,
      PathEscapeError,
    } = await import('../harness/paths.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'aicb-trial-path-'));
    try {
      assert.equal(assertSafeTrialId('tr-1'), 'tr-1');
      assert.throws(() => assertSafeTrialId('../x'), PathEscapeError);
      assert.throws(() => assertSafeTrialId('a/b'), PathEscapeError);
      assert.throws(() => assertSafeTrialId('a\\b'), PathEscapeError);
      assert.throws(() => assertSafeTrialId(''), /required/i);

      const inside = await trialPathUnder(root, 'trial-ok', 'request.json');
      assert.ok(inside.startsWith(root) || inside.includes('trial-ok'));

      await assert.rejects(
        () => trialPathUnder(root, '../escape'),
        /unsafe|escape|trial id/i,
      );
      await assert.rejects(
        () => trialPathUnder(root, 'ok', '../escape'),
        /unsafe|escape|segment/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
