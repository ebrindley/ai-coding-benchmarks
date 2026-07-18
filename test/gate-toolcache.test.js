/**
 * Per-trial harness-owned tool-cache dir for confined gates:
 * env overlay, confinement binds, cacheDir security-boundary validation,
 * TMPDIR overlay, warm-cache reuse across gates, and cleanup lifecycle.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises';

describe('gate tool-cache dir', () => {
  it('buildGateEnv with cacheDir sets fixed HOME + cache vars and still fails closed', async () => {
    const { buildGateEnv, buildGateCacheEnv } = await import('../harness/gates.js');

    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-cache-env-'));
    try {
      const env = buildGateEnv({
        parentEnv: {
          PATH: '/usr/bin:/bin',
          HOME: '/host/home',
          NUGET_PACKAGES: '/host/nuget',
          MAVEN_OPTS: '-Dmaven.repo.local=/host/m2 -XleakSecret',
        },
        cacheDir,
      });
      // HOME redirected to the cache dir (not host HOME).
      assert.equal(env.HOME, path.resolve(cacheDir));
      assert.notEqual(env.HOME, '/host/home');
      // Per-tool cache vars are fixed paths under cacheDir.
      assert.equal(env.NUGET_PACKAGES, path.join(cacheDir, 'nuget'));
      assert.equal(env.npm_config_cache, path.join(cacheDir, 'npm'));
      assert.equal(env.PIP_CACHE_DIR, path.join(cacheDir, 'pip'));
      assert.equal(env.CARGO_HOME, path.join(cacheDir, 'cargo'));
      assert.equal(env.GOPATH, path.join(cacheDir, 'go'));
      assert.equal(env.GOMODCACHE, path.join(cacheDir, 'go', 'pkg', 'mod'));
      // Maven local repo is a fixed harness value; host MAVEN_OPTS never inherited.
      assert.equal(
        env.MAVEN_OPTS,
        `-Dmaven.repo.local=${path.join(cacheDir, 'm2')}`,
      );
      assert.ok(!String(env.MAVEN_OPTS).includes('XleakSecret'));

      // buildGateCacheEnv matches the overlay exactly.
      const direct = buildGateCacheEnv(cacheDir);
      for (const [k, v] of Object.entries(direct)) {
        assert.equal(env[k], v);
      }

      // Still fails closed: a credential-like allowlist name throws even with a cacheDir.
      assert.throws(
        () =>
          buildGateEnv({
            parentEnv: { PATH: '/usr/bin:/bin', AWS_SECRET_ACCESS_KEY: 'x' },
            envAllowlist: ['AWS_SECRET_ACCESS_KEY'],
            cacheDir,
          }),
        /allowlist|credential|capability|safe/i,
      );

      // And a credential value present in parent is never emitted alongside the overlay.
      const env2 = buildGateEnv({
        parentEnv: {
          PATH: '/usr/bin:/bin',
          OPENAI_API_KEY: 'sk-leak',
          GITHUB_TOKEN: 'ghp-leak',
        },
        cacheDir,
      });
      const serialized = JSON.stringify(env2);
      assert.ok(!serialized.includes('sk-leak'));
      assert.ok(!serialized.includes('ghp-leak'));
      assert.equal(env2.OPENAI_API_KEY, undefined);
      assert.equal(env2.GITHUB_TOKEN, undefined);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('buildGateEnv without cacheDir is unchanged (backward compatible)', async () => {
    const { buildGateEnv } = await import('../harness/gates.js');
    const env = buildGateEnv({
      parentEnv: { PATH: '/usr/bin:/bin', HOME: '/host/home' },
    });
    // No cacheDir → HOME stays as host, no cache vars added.
    assert.equal(env.HOME, '/host/home');
    assert.equal(env.NUGET_PACKAGES, undefined);
    assert.equal(env.CARGO_HOME, undefined);
    assert.equal(env.MAVEN_OPTS, undefined);
  });

  it('buildSeatbeltProfile + buildConfinedArgv include cacheDir writable and refuse / and $HOME', async () => {
    const { buildSeatbeltProfile, buildConfinedArgv, escapeSeatbeltPath } =
      await import('../harness/gates.js');
    const ws = '/tmp/aicb-ws-cache';
    const tmp = '/tmp/aicb-private-tmp';
    const cache = '/tmp/aicb-toolcache';
    const roots = ['/usr', '/bin'];

    // Seatbelt: cache dir is a read+write root.
    const profile = buildSeatbeltProfile(ws, tmp, false, roots, cache);
    assert.match(profile, /\(deny default\)/);
    assert.match(
      profile,
      new RegExp(`\\(allow file-write\\* \\(subpath "${escapeSeatbeltPath(cache)}"\\)\\)`),
    );
    assert.match(
      profile,
      new RegExp(`\\(allow file-read\\* \\(subpath "${escapeSeatbeltPath(cache)}"\\)\\)`),
    );

    // Seatbelt refuses / and real $HOME as cache dir.
    assert.throws(
      () => buildSeatbeltProfile(ws, tmp, false, roots, '/'),
      /refusing tool-cache bind/i,
    );
    assert.throws(
      () => buildSeatbeltProfile(ws, tmp, false, roots, os.homedir()),
      /refusing tool-cache bind/i,
    );

    // bwrap: cache dir bound writable via --bind.
    const bwrap = buildConfinedArgv(
      { available: true, kind: 'bwrap', binary: '/usr/bin/bwrap' },
      ws,
      'npm ci',
      { networkAllowed: false, readRoots: roots, cacheDir: cache },
    );
    let cacheBound = false;
    for (let i = 0; i < bwrap.args.length; i += 1) {
      if (
        bwrap.args[i] === '--bind' &&
        bwrap.args[i + 1] === path.resolve(cache) &&
        bwrap.args[i + 2] === path.resolve(cache)
      ) {
        cacheBound = true;
      }
      // No bind of / or real $HOME regardless of cacheDir.
      if (bwrap.args[i] === '--bind' || bwrap.args[i] === '--ro-bind') {
        assert.notEqual(bwrap.args[i + 1], '/');
        assert.notEqual(bwrap.args[i + 1], path.resolve(os.homedir()));
      }
    }
    assert.ok(cacheBound, 'cacheDir must be a writable --bind under bwrap');

    // bwrap refuses / and real $HOME as cache dir.
    assert.throws(
      () =>
        buildConfinedArgv(
          { available: true, kind: 'bwrap', binary: '/usr/bin/bwrap' },
          ws,
          'npm ci',
          { networkAllowed: false, readRoots: roots, cacheDir: '/' },
        ),
      /refusing tool-cache bind/i,
    );
    assert.throws(
      () =>
        buildConfinedArgv(
          { available: true, kind: 'bwrap', binary: '/usr/bin/bwrap' },
          ws,
          'npm ci',
          { networkAllowed: false, readRoots: roots, cacheDir: os.homedir() },
        ),
      /refusing tool-cache bind/i,
    );
  });

  it('assertHarnessCacheDir rejects /, real $HOME, workspace overlap, and symlinks', async () => {
    const { assertHarnessCacheDir } = await import('../harness/gates.js');

    const root = await mkdtemp(path.join(os.tmpdir(), 'aicb-exec-root-'));
    try {
      const workspace = path.join(root, 'ws');
      const cache = path.join(root, 'cache');
      await mkdir(workspace, { recursive: true });
      await mkdir(cache, { recursive: true });

      // Happy path: disjoint sibling dir validates and returns a realpath.
      const ok = await assertHarnessCacheDir({
        cacheDir: cache,
        workspaceDir: workspace,
        executionRoot: root,
      });
      assert.ok(path.isAbsolute(ok));

      // Reject filesystem root.
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: '/',
            workspaceDir: workspace,
            executionRoot: root,
          }),
        /root|\$HOME/i,
      );

      // Reject real $HOME.
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: os.homedir(),
            workspaceDir: workspace,
            executionRoot: root,
          }),
        /\$HOME|home/i,
      );

      // Reject cache dir inside the workspace (overlap).
      const inside = path.join(workspace, 'nested-cache');
      await mkdir(inside, { recursive: true });
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: inside,
            workspaceDir: workspace,
            executionRoot: root,
          }),
        /disjoint|workspace/i,
      );

      // Reject workspace inside cache dir (other direction).
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: root,
            workspaceDir: workspace,
            executionRoot: path.join(root, '..'),
          }),
        /disjoint|workspace|root/i,
      );

      // Reject a symlinked cache dir (could retarget the writable bind).
      const linkCache = path.join(root, 'cache-link');
      await symlink(cache, linkCache);
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: linkCache,
            workspaceDir: workspace,
            executionRoot: root,
          }),
        /symlink/i,
      );

      // Reject cache dir equal to the execution root itself.
      await assert.rejects(
        () =>
          assertHarnessCacheDir({
            cacheDir: root,
            workspaceDir: path.join(os.tmpdir(), 'aicb-elsewhere-ws'),
            executionRoot: root,
          }),
        /execution root/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('confined: TMPDIR overlay + warm cache reuse across gates; cleaned on failure path', async (t) => {
    const { runGates, detectConfinement } = await import('../harness/gates.js');
    const { cleanupExecutionWorkspace } = await import('../harness/workspace.js');
    const { assertHarnessCacheDir } = await import('../harness/gates.js');

    const confinement = await detectConfinement();
    if (!confinement.available) {
      t.skip(`confinement unavailable: ${confinement.reason}`);
      return;
    }

    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'aicb-tc-exec-'));
    const workspace = path.join(executionRoot, 'ws');
    await mkdir(workspace, { recursive: true });
    const cacheDir = await mkdtemp(path.join(executionRoot, 'toolcache-'));
    await assertHarnessCacheDir({ cacheDir, workspaceDir: workspace, executionRoot });

    // Probe: some CI/dev hosts have sandbox-exec/bwrap present but forbid a
    // deny-default profile from actually applying (nested-sandbox / SIGABRT).
    // In that case the primitive is nominally "available" but cannot execute a
    // gate — skip the semantic assertions cleanly (same tolerance the existing
    // credential-sentinel gate test uses).
    const probe = await runGates({
      gates: [
        { gate: 'probe', order: 1, required: true, expectedExitCode: 0, command: 'exit 0' },
      ],
      workspaceDir: workspace,
      confinement,
      cacheDir,
      parentEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      timeoutMs: 30_000,
    });
    if (probe[0].exitCode !== 0) {
      await rm(executionRoot, { recursive: true, force: true });
      t.skip(
        `confinement present but cannot execute a deny-default gate here: ${probe[0].evidence}`,
      );
      return;
    }

    let cleanedOk = false;
    try {
      const results = await runGates({
        gates: [
          // Gate 1: prove TMPDIR points at a writable private tmp (aicb-gate-tmp-*),
          // and HOME points at the cache dir; write a sentinel into the cache.
          {
            gate: 'warm',
            order: 1,
            required: true,
            expectedExitCode: 0,
            command:
              'case "$TMPDIR" in *aicb-gate-tmp-*) : ;; *) echo "bad TMPDIR=$TMPDIR" >&2; exit 3;; esac; ' +
              'test -w "$TMPDIR" || { echo "TMPDIR not writable" >&2; exit 4; }; ' +
              'echo warmed > "$HOME/sentinel.txt"',
          },
          // Gate 2 (same trial): read the sentinel written by gate 1 → warm-cache reuse.
          {
            gate: 'reuse',
            order: 2,
            required: true,
            expectedExitCode: 0,
            command: 'grep -q warmed "$HOME/sentinel.txt"',
          },
        ],
        workspaceDir: workspace,
        confinement,
        cacheDir,
        parentEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        timeoutMs: 30_000,
      });

      // Both gates ran under confinement; interpret only when they truly executed.
      assert.equal(results.length, 2);
      for (const r of results) {
        if (r.classificationSignal === 'INFRA_FAIL') {
          t.skip(`confined gate infra failure: ${r.evidence}`);
          return;
        }
      }
      assert.equal(results[0].status, 'passed', `gate1: ${results[0].evidence}`);
      assert.equal(
        results[1].status,
        'passed',
        `warm-cache reuse failed: ${results[1].evidence}`,
      );

      // Sentinel really landed in the cache dir on the host side.
      const sentinelStat = await stat(path.join(cacheDir, 'sentinel.txt'));
      assert.ok(sentinelStat.isFile());

      // Simulate the run.js failure/timeout path: throw AFTER gates, cleanup in finally.
      throw new Error('simulated trial failure after gates');
    } catch (err) {
      assert.match(String(err), /simulated trial failure/);
    } finally {
      // Mirror run.js finally: cleanup removes the populated cache dir.
      const res = await cleanupExecutionWorkspace(cacheDir, { executionRoot });
      cleanedOk = res.removed === true;
      await rm(executionRoot, { recursive: true, force: true });
    }

    assert.ok(cleanedOk, 'cache dir must be removed on the failure path');
    await assert.rejects(() => stat(cacheDir), /ENOENT/);
  });

  it('cleanup removes a populated cache dir on the failure path (no confinement needed)', async () => {
    const { cleanupExecutionWorkspace } = await import('../harness/workspace.js');
    const { assertHarnessCacheDir } = await import('../harness/gates.js');
    const { writeFile, mkdir: mkdirp } = await import('node:fs/promises');

    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'aicb-tc-fail-'));
    const workspace = path.join(executionRoot, 'ws');
    await mkdirp(workspace, { recursive: true });
    const cacheDir = await mkdtemp(path.join(executionRoot, 'toolcache-'));
    await assertHarnessCacheDir({ cacheDir, workspaceDir: workspace, executionRoot });

    // Populate the cache the way a toolchain would (nested dirs + artifacts).
    await mkdirp(path.join(cacheDir, 'nuget', 'pkg'), { recursive: true });
    await writeFile(path.join(cacheDir, 'nuget', 'pkg', 'a.dll'), 'x');
    await writeFile(path.join(cacheDir, 'sentinel.txt'), 'warmed');

    let removed = false;
    try {
      // Mirror run.js: throw mid-trial (failure/timeout), cleanup runs in finally.
      throw new Error('simulated trial failure/timeout');
    } catch (err) {
      assert.match(String(err), /simulated trial failure/);
    } finally {
      const res = await cleanupExecutionWorkspace(cacheDir, { executionRoot });
      removed = res.removed === true;
      await rm(executionRoot, { recursive: true, force: true });
    }
    assert.ok(removed, 'populated cache dir must be removed on the failure path');
  });

  it('cleanup refuses a cache dir outside the execution root', async () => {
    const { cleanupExecutionWorkspace } = await import('../harness/workspace.js');
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'aicb-tc-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aicb-tc-outside-'));
    try {
      const res = await cleanupExecutionWorkspace(outside, { executionRoot });
      assert.equal(res.removed, false);
      assert.match(String(res.reason), /outside-execution-root/);
      // The outside dir must survive the refusal.
      const st = await stat(outside);
      assert.ok(st.isDirectory());
    } finally {
      await rm(executionRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
