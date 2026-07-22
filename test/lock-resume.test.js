/**
 * Atomic resume, campaign lock, dead-owner recovery, and frozen input digests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  symlink,
  lstat,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(REPO, 'benchmarks');

async function writeAdoptableTrial(campaignDir, trialId, partial, manifestTrial) {
  const {
    quarantineRawOutput,
    computeArtifactDigest,
    buildTrialDigests,
  } = await import('../harness/results.js');
  const { writeCompleteTrial } = await import('./helpers/complete-trial.js');

  const raw = await quarantineRawOutput(campaignDir, trialId, {
    stdout: 'provider stdout\n',
    stderr: '',
  });
  const artifactDir = path.join(campaignDir, 'artifacts', trialId);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'output.json'), '{"ok":true}\n', 'utf8');
  const artifactDigest = await computeArtifactDigest(artifactDir);
  return writeCompleteTrial(
    campaignDir,
    trialId,
    {
      ...partial,
      artifactDir,
      digests: buildTrialDigests({
        artifactDigest,
        ...raw.digests,
      }),
    },
    { manifestTrial },
  );
}

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

  it('planted campaign.lock symlink: acquire/read fail closed; sentinel unchanged', async () => {
    if (process.platform === 'win32') return;
    const {
      acquireLock,
      readLock,
      lockPath,
    } = await import('../harness/lock.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-sym-'));
    const external = path.join(dir, 'host-secret.txt');
    const SENTINEL = 'LOCK_SENTINEL_EXTERNAL\n';
    try {
      await writeFile(external, SENTINEL, 'utf8');
      await symlink(external, lockPath(dir));

      // Exclusive create must not open/overwrite through the leaf symlink.
      const acq = await acquireLock(dir, 'attacker-owner', { minAgeMs: 0 });
      assert.equal(acq.ok, false);
      assert.equal(acq.acquired, false);
      assert.match(
        String(acq.error || ''),
        /symlink|unreadable|fail closed|unsafe|EEXIST|held/i,
      );

      // Direct read must not follow into host content.
      await assert.rejects(
        () => readLock(dir),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );

      // Still a symlink; external body untouched; never reclaimed as our lock.
      const st = await lstat(lockPath(dir));
      assert.equal(st.isSymbolicLink(), true);
      assert.equal(await readFile(external, 'utf8'), SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('intermediate ancestor symlink: acquireLock fails closed; no write outside', async () => {
    if (process.platform === 'win32') return;
    const { acquireLock, lockPath } = await import('../harness/lock.js');
    const { createFileExclusiveNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-anc-'));
    const outside = path.join(base, 'outside');
    const external = path.join(outside, 'host-secret.txt');
    const SENTINEL = 'ANC_LOCK_SENTINEL\n';
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(external, SENTINEL, 'utf8');

      const parent = path.join(base, 'parent');
      await mkdir(parent, { recursive: true });
      // Intermediate component is a symlink directory → outside the tree.
      const mid = path.join(parent, 'mid');
      await symlink(outside, mid);
      // Campaign-shaped path under the intermediate symlink (does not exist).
      const camp = path.join(mid, 'campaign');
      // Pre-create the lexical camp path by following would land under outside;
      // we deliberately leave camp missing so create sees mid as symlink ancestor.

      // Direct exclusive create refuses full parent chain (mid is user symlink).
      await assert.rejects(
        () =>
          createFileExclusiveNoFollow(
            path.join(camp, 'campaign.lock'),
            '{"owner":"x"}\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Also refuse when the immediate parent exists under the symlink chain:
      // plant campaign as a real dir under outside, address it via mid/campaign.
      await mkdir(path.join(outside, 'campaign'), { recursive: true });
      await assert.rejects(
        () =>
          createFileExclusiveNoFollow(
            path.join(camp, 'campaign.lock'),
            '{"owner":"pwn"}\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // acquireLock must not create a lock through the intermediate symlink.
      const acq = await acquireLock(camp, 'owner-anc', { minAgeMs: 0 });
      assert.equal(acq.ok, false);
      assert.equal(acq.acquired, false);
      assert.match(
        String(acq.error || ''),
        /symlink|fail closed|parent|unreadable|unsafe|EEXIST|missing/i,
      );

      // Outside campaign dir must not contain a successfully written lock.
      const campOutsideListing = await readdir(path.join(outside, 'campaign'));
      assert.ok(
        !campOutsideListing.includes('campaign.lock'),
        'must not write campaign.lock through intermediate ancestor symlink',
      );
      try {
        await lstat(lockPath(camp));
        // Path may resolve through mid; must not be a regular private lock we created.
        const st = await lstat(path.join(outside, 'campaign', 'campaign.lock'));
        assert.fail(
          `lock must not exist outside (symlink=${st.isSymbolicLink()})`,
        );
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        assert.equal(code, 'ENOENT');
      }

      assert.equal(await readFile(external, 'utf8'), SENTINEL);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('planted recovery-guard symlink: recovery fails closed; no reclaim from external', async () => {
    if (process.platform === 'win32') return;
    const {
      acquireLock,
      releaseLock,
      lockPath,
      lockRecoverPath,
      readRecoveryGuard,
      isPidAlive,
      canRecoverDeadLock,
    } = await import('../harness/lock.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-guard-sym-'));
    const external = path.join(dir, 'host-secret.txt');
    const SENTINEL = 'GUARD_SENTINEL_EXTERNAL\n';
    try {
      await writeFile(external, SENTINEL, 'utf8');

      // Dead recoverable lock (would normally reclaim).
      let deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
      }).pid;
      if (deadPid == null || isPidAlive(deadPid) !== false) {
        deadPid = 2147483641;
        if (isPidAlive(deadPid) !== false) {
          assert.fail('need a dead pid for guard symlink test');
        }
      }
      const deadPayload = {
        owner: `aicb-${deadPid}-guard-sym`,
        acquiredAt: new Date(Date.now() - 180_000).toISOString(),
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

      // Plant recovery guard as symlink to external sentinel.
      await symlink(external, lockRecoverPath(dir));

      const acq = await acquireLock(dir, 'new-owner', { minAgeMs: 30_000 });
      assert.equal(acq.ok, false);
      assert.equal(acq.acquired, false);
      assert.match(
        String(acq.error || ''),
        /symlink|unreadable|fail closed|recovery|unsafe/i,
      );

      await assert.rejects(
        () => readRecoveryGuard(dir),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );

      // Dead lock still present (not unlinked/replaced based on external content).
      const lockBody = await readFile(lockPath(dir), 'utf8');
      assert.ok(lockBody.includes(String(deadPid)));
      assert.ok(!lockBody.includes('new-owner'));

      const guardSt = await lstat(lockRecoverPath(dir));
      assert.equal(guardSt.isSymbolicLink(), true);
      assert.equal(await readFile(external, 'utf8'), SENTINEL);

      // Clean for isolation: force-remove planted guard and recover for real.
      await rm(lockRecoverPath(dir), { force: true });
      const recovered = await acquireLock(dir, 'new-owner', { minAgeMs: 30_000 });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.acquired, true);
      await releaseLock(dir, 'new-owner');
      assert.equal(await readFile(external, 'utf8'), SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe('lock acquire under grandparent swap / pinned boundary', () => {
  it('acquireLock fails closed when grandparent is swapped to symlink', async () => {
    if (process.platform === 'win32') return;
    const { acquireLock, lockPath } = await import('../harness/lock.js');
    const {
      pinDirectoryBoundary,
      assertPinnedBoundary,
      releaseBoundaryPin,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-gp-'));
    const outside = path.join(base, 'outside');
    const external = path.join(outside, 'host-secret.txt');
    const SENTINEL = 'LOCK_GP_SENTINEL\n';
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(external, SENTINEL, 'utf8');

      const grand = path.join(base, 'grand');
      const camp = path.join(grand, 'campaign');
      await mkdir(camp, { recursive: true });

      // Pin succeeds on the clean chain.
      const pin = await pinDirectoryBoundary(camp);
      try {
        await assertPinnedBoundary(pin);

        // Deterministic grandparent swap before lock create.
        await rm(grand, { recursive: true, force: true });
        await symlink(outside, grand);

        await assert.rejects(
          () => assertPinnedBoundary(pin),
          (err) =>
            err instanceof UnsafePathError ||
            /symlink|identity|missing|fail closed/i.test(String(err)),
        );

        const acq = await acquireLock(camp, 'owner-gp', { minAgeMs: 0 });
        assert.equal(acq.ok, false);
        assert.equal(acq.acquired, false);
        assert.match(
          String(acq.error || ''),
          /symlink|fail closed|parent|missing|identity|unsafe|unreadable/i,
        );

        // No lock file under outside (escape target).
        const outsideListing = await readdir(outside);
        assert.ok(
          !outsideListing.includes('campaign.lock'),
          'must not write campaign.lock through swapped grandparent',
        );
        assert.ok(
          !outsideListing.includes('campaign'),
          'must not create campaign dir through swapped grandparent for lock',
        );
        // Lexical lock path under the symlink must not be a successful private lock.
        try {
          await lstat(path.join(outside, 'campaign.lock'));
          assert.fail('lock must not exist at outside/campaign.lock');
        } catch (err) {
          const code = /** @type {NodeJS.ErrnoException} */ (err).code;
          assert.equal(code, 'ENOENT');
        }
        assert.equal(await readFile(external, 'utf8'), SENTINEL);
      } finally {
        await releaseBoundaryPin(pin);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('readLock refuses leaf symlink at campaign.lock (nofollow)', async () => {
    if (process.platform === 'win32') return;
    const { readLock, lockPath } = await import('../harness/lock.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-lock-leaf-'));
    const external = path.join(dir, 'host-secret.txt');
    const SENTINEL = 'LOCK_LEAF_SENTINEL\n';
    try {
      await writeFile(external, SENTINEL, 'utf8');
      await symlink(external, lockPath(dir));

      await assert.rejects(
        () => readLock(dir),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );
      assert.equal(await readFile(external, 'utf8'), SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('durable-result crash-window: adopt verified result for running trial', async () => {
    const {
      tryAdoptDurableTrialResult,
      clearTrialDurableState,
    } = await import('../harness/results.js');
    const { completeManifestTrial } = await import(
      './helpers/complete-trial.js'
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-adopt-'));
    try {
      const trialId = 'arm__task__r1__adopt1';
      const manifestTrial = completeManifestTrial({
        id: trialId,
        state: 'running',
        experimentId: 'exp-adopt',
        arm: 'a1',
        provider: 'fake',
        taskId: 'task-a',
        invocationPath: 'native-cli',
        requestedModel: 'm1',
      });

      // Simulate crash after durable result write, before manifest terminal update.
      const written = await writeAdoptableTrial(
        dir,
        trialId,
        {
          experimentId: 'exp-adopt',
          arm: 'a1',
          provider: 'fake',
          taskId: 'task-a',
          invocationPath: 'native-cli',
          requestedModel: 'm1',
          state: 'completed',
          classification: 'PASS',
        },
        manifestTrial,
      );

      const adopted = await tryAdoptDurableTrialResult(dir, {
        ...manifestTrial,
        state: 'running',
      });
      assert.equal(adopted.ok, true, adopted.reason);
      assert.equal(adopted.state, 'completed');
      assert.equal(adopted.classification, 'PASS');
      assert.equal(
        adopted.result.digests.resultDigest,
        written.result.digests.resultDigest,
      );

      // Invalid identity must not adopt.
      const rejected = await tryAdoptDurableTrialResult(dir, {
        ...manifestTrial,
        taskId: 'other-task',
        state: 'running',
      });
      assert.equal(rejected.ok, false);
      assert.match(String(rejected.reason), /identity/i);

      // After clear, no durable result remains.
      await clearTrialDurableState(dir, trialId);
      const gone = await tryAdoptDurableTrialResult(dir, {
        ...manifestTrial,
        state: 'running',
      });
      assert.equal(gone.ok, false);
      assert.match(String(gone.reason), /no durable result|ENOENT|unreadable|fail/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('invalid/stale result rejected; clear enables clean rerun', async () => {
    const {
      tryAdoptDurableTrialResult,
      clearTrialDurableState,
      readTrialResult,
    } = await import('../harness/results.js');
    const { completeManifestTrial } = await import(
      './helpers/complete-trial.js'
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-stale-'));
    try {
      const trialId = 'arm__task__r1__stale1';
      const manifestTrial = completeManifestTrial({
        id: trialId,
        state: 'running',
      });
      await writeAdoptableTrial(
        dir,
        trialId,
        {
          state: 'completed',
          classification: 'PASS',
        },
        manifestTrial,
      );

      // Tamper resultDigest → adoption fails closed.
      const resultPath = path.join(dir, 'results', trialId, 'result.json');
      const raw = JSON.parse(await readFile(resultPath, 'utf8'));
      raw.digests.resultDigest = '0'.repeat(64);
      await writeFile(resultPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

      const bad = await tryAdoptDurableTrialResult(dir, manifestTrial);
      assert.equal(bad.ok, false);
      assert.match(String(bad.reason), /resultDigest/i);

      // Clear stale state and write a fresh durable result (clean rerun path).
      await clearTrialDurableState(dir, trialId);
      await assert.rejects(
        () => readTrialResult(dir, trialId),
        /ENOENT|unreadable|fail|required|schema/i,
      );

      const fresh = await writeAdoptableTrial(
        dir,
        trialId,
        {
          state: 'completed',
          classification: 'FAIL',
        },
        manifestTrial,
      );
      const ok = await tryAdoptDurableTrialResult(dir, manifestTrial);
      assert.equal(ok.ok, true, ok.reason);
      assert.equal(ok.classification, 'FAIL');
      assert.equal(
        ok.result.digests.resultDigest,
        fresh.result.digests.resultDigest,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
