/**
 * Adversarial symlink-swap: provider replaces scratch request/output with a
 * symlink to a host sentinel; trusted harness must never copy sentinel bytes
 * into campaign artifacts/raw/results.
 *
 * Also covers authenticated-cwd helper write races (grandparent swap before
 * helper acquisition fails closed; swap after cwd auth leaves writes in the
 * original directory) and leaf no-follow identity checks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
  lstat,
  rename as fsRename,
  access,
} from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const SENTINEL = 'SENTINEL_HOST_SECRET_BYTES\n';

describe('safe scratch nofollow', () => {
  it('readFileNoFollow / copyFileNoFollow refuse symlinks (fail closed)', async () => {
    if (process.platform === 'win32') return;
    const {
      readFileNoFollow,
      copyFileNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-safe-'));
    try {
      const secret = path.join(dir, 'host-secret.txt');
      await writeFile(secret, SENTINEL, 'utf8');
      const link = path.join(dir, 'swapped.json');
      await symlink(secret, link);

      await assert.rejects(
        () => readFileNoFollow(link),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|UNSAFE|follow/i.test(String(err)),
      );

      const dest = path.join(dir, 'dest.json');
      await assert.rejects(
        () => copyFileNoFollow(link, dest),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|UNSAFE|follow/i.test(String(err)),
      );

      // Regular file still works
      const reg = path.join(dir, 'ok.json');
      await writeFile(reg, '{"ok":true}\n', 'utf8');
      const buf = await readFileNoFollow(reg);
      assert.equal(buf.toString('utf8'), '{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readFileNoFollow refuses leaf identity mismatch after lstat pin', async () => {
    if (process.platform === 'win32') return;
    const { readFileNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-leaf-id-'));
    try {
      const legit = path.join(dir, 'legit.txt');
      const other = path.join(dir, 'other.txt');
      await writeFile(legit, 'legit-body\n', 'utf8');
      await writeFile(other, SENTINEL, 'utf8');
      const st = await lstat(legit);

      // Simulate TOCTOU: path now names a different inode than the lstat pin.
      await rm(legit);
      await fsRename(other, legit);

      await assert.rejects(
        () =>
          readFileNoFollow(legit, {
            expectedDev: st.dev,
            expectedIno: st.ino,
          }),
        (err) =>
          err instanceof UnsafePathError &&
          (err.code === 'IDENTITY_MISMATCH' ||
            /identity mismatch/i.test(err.message)),
      );

      // Without identity pin, nofollow still reads the replacement regular file
      // (leaf symlink case is covered separately).
      const body = await readFileNoFollow(legit);
      assert.equal(body.toString('utf8'), SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantine and run post-copy never ingest symlink-swapped sentinel', async () => {
    if (process.platform === 'win32') return;
    const { quarantineRawOutput } = await import('../harness/results.js');
    const { writePrivateFile, ensurePrivateDir } = await import(
      '../harness/results.js'
    );
    const { readFileNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-sym-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-ws-sym-'));
    try {
      const hostSecret = path.join(os.tmpdir(), `aicb-host-secret-${Date.now()}.txt`);
      await writeFile(hostSecret, 'SENTINEL_SHOULD_NEVER_LAND\n', 'utf8');

      const scratch = path.join(workspace, '.aicb-scratch');
      await ensurePrivateDir(scratch);
      const scratchOut = path.join(scratch, 'output.json');
      // Provider-style attack: replace output with symlink to host secret
      await symlink(hostSecret, scratchOut);

      // Quarantine must refuse to follow the symlink
      const q = await quarantineRawOutput(campaign, 't1', {
        stdout: 'legit-stdout\n',
        stderr: '',
        outputPath: scratchOut,
      });
      // output.json should be missing or not contain sentinel
      let rawListing = await readdir(path.join(campaign, 'raw', 't1'));
      assert.ok(rawListing.includes('output-missing.txt') || !rawListing.includes('output.json'));
      if (rawListing.includes('output.json')) {
        const body = await readFile(
          path.join(campaign, 'raw', 't1', 'output.json'),
          'utf8',
        );
        assert.ok(!body.includes('SENTINEL_SHOULD_NEVER_LAND'));
      }
      // stdout should be the legitimate harness-captured stream only
      const stdout = await readFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'utf8',
      );
      assert.equal(stdout, 'legit-stdout\n');
      assert.ok(!stdout.includes('SENTINEL'));

      // Campaign artifact copy path (simulate run.js) refuses symlink
      const artDir = path.join(campaign, 'artifacts', 't1');
      await ensurePrivateDir(artDir);
      const dest = path.join(artDir, 'output.json');
      await assert.rejects(
        () => readFileNoFollow(scratchOut).then((b) => writePrivateFile(dest, b)),
        (err) => err instanceof UnsafePathError || /symlink|UNSAFE|ELOOP/i.test(String(err)),
      );
      // dest must not exist with sentinel
      let artFiles = [];
      try {
        artFiles = await readdir(artDir);
      } catch {
        artFiles = [];
      }
      if (artFiles.includes('output.json')) {
        const artBody = await readFile(dest, 'utf8');
        assert.ok(!artBody.includes('SENTINEL_SHOULD_NEVER_LAND'));
      }

      // results.json must not contain sentinel either
      const { writeCompleteTrial } = await import(
        './helpers/complete-trial.js'
      );
      await writeCompleteTrial(campaign, 't1', {
        classification: 'INFRA_FAIL',
        digests: {
          rawEvidenceUnavailable: true,
        },
      });
      const resultText = await readFile(
        path.join(campaign, 'results', 't1', 'result.json'),
        'utf8',
      );
      assert.ok(!resultText.includes('SENTINEL_SHOULD_NEVER_LAND'));

      await rm(hostSecret, { force: true });
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('authenticated-cwd helper ancestor races', () => {
  /**
   * Wait until a relative barrier file exists under an absolute dir.
   * @param {string} absPath
   * @param {number} timeoutMs
   */
  async function waitForFile(absPath, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await access(absPath);
        return;
      } catch {
        await sleep(20);
      }
    }
    throw new Error(`timeout waiting for ${absPath}`);
  }

  it('grandparent swap before helper acquisition fails closed (no write to replacement)', async () => {
    if (process.platform === 'win32') return;
    const {
      pinDirectoryBoundary,
      assertPinnedBoundary,
      releaseBoundaryPin,
      writeFileAtomicNoFollow,
      createFileExclusiveNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-gp-pre-'));
    const outside = path.join(base, 'outside');
    const external = path.join(outside, 'host-secret.txt');
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(external, SENTINEL, 'utf8');

      const grand = path.join(base, 'grand');
      const parent = path.join(grand, 'parent');
      await mkdir(parent, { recursive: true });

      const pin = await pinDirectoryBoundary(parent);
      try {
        // Swap before any helper spawn: pin path-walk must fail closed.
        await rm(grand, { recursive: true, force: true });
        await symlink(outside, grand);

        await assert.rejects(
          () => assertPinnedBoundary(pin),
          (err) =>
            err instanceof UnsafePathError &&
            (err.code === 'SYMLINK' ||
              err.code === 'IDENTITY_MISMATCH' ||
              err.code === 'MISSING' ||
              /symlink|identity|missing|fail closed/i.test(err.message)),
        );

        // Fresh write paths pin then spawn: either pin or helper identity fails.
        await assert.rejects(
          () =>
            writeFileAtomicNoFollow(
              path.join(parent, 'report.json'),
              '{"pwned":true}\n',
            ),
          (err) =>
            err instanceof UnsafePathError ||
            /symlink|fail closed|identity|missing|helper/i.test(String(err)),
        );
        await assert.rejects(
          () =>
            createFileExclusiveNoFollow(
              path.join(parent, 'campaign.lock'),
              '{"owner":"x"}\n',
            ),
          (err) =>
            err instanceof UnsafePathError ||
            /symlink|fail closed|identity|missing|helper/i.test(String(err)),
        );

        const outsideListing = await readdir(outside);
        assert.ok(
          !outsideListing.includes('report.json'),
          'must not write report through swapped grandparent',
        );
        assert.ok(
          !outsideListing.includes('campaign.lock'),
          'must not write lock through swapped grandparent',
        );
        assert.ok(
          !outsideListing.includes('parent'),
          'must not mkdir parent through swapped grandparent',
        );
        assert.equal(await readFile(external, 'utf8'), SENTINEL);
      } finally {
        await releaseBoundaryPin(pin);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('grandparent swap after helper cwd auth keeps atomic write in original dir', async () => {
    if (process.platform === 'win32') return;
    const { writeFileAtomicNoFollow } = await import('../harness/safe-fs.js');

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-gp-post-'));
    try {
      const grand = path.join(base, 'grand');
      const parent = path.join(grand, 'parent');
      await mkdir(parent, { recursive: true });
      const parentSt = await lstat(parent);

      const readyName = '.aicb-barrier-ready';
      const goName = '.aicb-barrier-go';
      const destName = 'report.json';
      const body = '{"anchored":true}\n';

      const writePromise = writeFileAtomicNoFollow(
        path.join(parent, destName),
        body,
        {
          mode: 0o600,
          fsync: true,
          testBarrier: { readyName, goName },
          helperTimeoutMs: 10_000,
        },
      );

      // Barrier ready is written relative to authenticated original cwd.
      await waitForFile(path.join(parent, readyName));

      // Swap grandparent after helper acquired/authenticated cwd.
      const moved = path.join(base, 'grand-moved');
      await fsRename(grand, moved);
      await mkdir(path.join(base, 'grand', 'parent'), { recursive: true });
      await writeFile(
        path.join(base, 'grand', 'parent', 'trap.txt'),
        'trap\n',
        'utf8',
      );

      // Release barrier via the held original directory (moved path).
      await writeFile(path.join(moved, 'parent', goName), '1', 'utf8');

      await writePromise;

      const originalListing = await readdir(path.join(moved, 'parent'));
      assert.ok(
        originalListing.includes(destName),
        'write must land in original authenticated directory',
      );
      assert.equal(
        await readFile(path.join(moved, 'parent', destName), 'utf8'),
        body,
      );
      const destSt = await lstat(path.join(moved, 'parent', destName));
      assert.equal(destSt.mode & 0o777, 0o600);

      const trapListing = await readdir(path.join(base, 'grand', 'parent'));
      assert.ok(
        !trapListing.includes(destName),
        'write must never reach replacement target',
      );
      assert.deepEqual(trapListing.filter((n) => n === destName), []);
      assert.ok(trapListing.includes('trap.txt'));

      // Original parent inode is still the one we wrote into.
      const movedParentSt = await lstat(path.join(moved, 'parent'));
      assert.equal(movedParentSt.dev, parentSt.dev);
      assert.equal(movedParentSt.ino, parentSt.ino);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('grandparent swap after helper cwd auth keeps exclusive create in original dir', async () => {
    if (process.platform === 'win32') return;
    const { createFileExclusiveNoFollow } = await import(
      '../harness/safe-fs.js'
    );

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-gp-excl-post-'));
    try {
      const grand = path.join(base, 'grand');
      const parent = path.join(grand, 'parent');
      await mkdir(parent, { recursive: true });

      const readyName = '.aicb-barrier-ready';
      const goName = '.aicb-barrier-go';
      const lockName = 'campaign.lock';
      const body = '{"owner":"anchored"}\n';

      const createPromise = createFileExclusiveNoFollow(
        path.join(parent, lockName),
        body,
        {
          mode: 0o600,
          fsync: true,
          testBarrier: { readyName, goName },
          helperTimeoutMs: 10_000,
        },
      );

      await waitForFile(path.join(parent, readyName));

      const moved = path.join(base, 'grand-moved');
      await fsRename(grand, moved);
      await mkdir(path.join(base, 'grand', 'parent'), { recursive: true });
      await writeFile(
        path.join(base, 'grand', 'parent', 'trap.txt'),
        'trap\n',
        'utf8',
      );
      await writeFile(path.join(moved, 'parent', goName), '1', 'utf8');

      await createPromise;

      assert.equal(
        await readFile(path.join(moved, 'parent', lockName), 'utf8'),
        body,
      );
      const trapListing = await readdir(path.join(base, 'grand', 'parent'));
      assert.ok(
        !trapListing.includes(lockName),
        'exclusive create must never reach replacement target',
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('ancestor directory replaced with different directory fails pin identity', async () => {
    if (process.platform === 'win32') return;
    const {
      pinDirectoryBoundary,
      assertPinnedBoundary,
      releaseBoundaryPin,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-anc-id-'));
    try {
      const mid = path.join(base, 'mid');
      const parent = path.join(mid, 'parent');
      await mkdir(parent, { recursive: true });
      const pin = await pinDirectoryBoundary(parent);
      try {
        const midMoved = path.join(base, 'mid-moved');
        await fsRename(mid, midMoved);
        await mkdir(path.join(base, 'mid', 'parent'), { recursive: true });

        await assert.rejects(
          () => assertPinnedBoundary(pin),
          (err) =>
            err instanceof UnsafePathError &&
            (err.code === 'IDENTITY_MISMATCH' ||
              err.code === 'MISSING' ||
              /identity|missing|fail closed/i.test(err.message)),
        );
      } finally {
        await releaseBoundaryPin(pin);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('revalidateBeforeRename rejects full-chain grandparent symlink without pin', async () => {
    if (process.platform === 'win32') return;
    const {
      revalidateBeforeRename,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-reval-gp-'));
    const outside = path.join(base, 'outside');
    try {
      await mkdir(outside, { recursive: true });
      const grand = path.join(base, 'grand');
      const parent = path.join(grand, 'parent');
      await mkdir(parent, { recursive: true });
      const dest = path.join(parent, 'manifest.json');

      await revalidateBeforeRename(parent, dest);

      await rm(grand, { recursive: true, force: true });
      await symlink(outside, grand);
      await mkdir(path.join(outside, 'parent'), { recursive: true });

      await assert.rejects(
        () => revalidateBeforeRename(parent, dest),
        (err) =>
          err instanceof UnsafePathError &&
          (err.code === 'SYMLINK' || /symlink|fail closed/i.test(err.message)),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('exclusive create still refuses leaf symlink and keeps mode 0600 on success', async () => {
    if (process.platform === 'win32') return;
    const {
      createFileExclusiveNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-excl-'));
    try {
      const external = path.join(dir, 'ext.txt');
      await writeFile(external, SENTINEL, 'utf8');
      const leaf = path.join(dir, 'campaign.lock');
      await symlink(external, leaf);

      await assert.rejects(
        () => createFileExclusiveNoFollow(leaf, '{"owner":"x"}\n'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|EEXIST/i.test(String(err)),
      );
      assert.equal(await readFile(external, 'utf8'), SENTINEL);

      await rm(leaf, { force: true });
      await createFileExclusiveNoFollow(leaf, '{"owner":"ok"}\n', {
        mode: 0o600,
        fsync: true,
      });
      const st = await lstat(leaf);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('atomic write happy path remains regular private file (no EXDEV weaken)', async () => {
    if (process.platform === 'win32') return;
    const { writeFileAtomicNoFollow } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-atomic-ok-'));
    try {
      const dest = path.join(dir, 'report.json');
      await writeFileAtomicNoFollow(dest, '{"ok":true}\n', {
        mode: 0o600,
        fsync: true,
      });
      const st = await lstat(dest);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(await readFile(dest, 'utf8'), '{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
