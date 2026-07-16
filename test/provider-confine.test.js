/**
 * Provider OS confinement: campaign tree inaccessible while provider runs.
 * Scratch I/O outside campaign. Fail closed when primitive unavailable.
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
  chmod,
  rm,
  access,
} from 'node:fs/promises';

describe('provider confinement', () => {
  it('scratch paths must sit outside campaign; seatbelt/bwrap mask campaign', async () => {
    const {
      buildProviderSeatbeltProfile,
      buildProviderConfinedArgv,
      campaignDenyPaths,
      assertPathOutsideCampaign,
      detectProviderConfinement,
      wrapProviderCommand,
    } = await import('../harness/invokers/provider-confine.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-prov-camp-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-prov-ws-'));
    const scratch = path.join(workspace, '.aicb-scratch');
    await mkdir(scratch, { recursive: true });
    try {
      await assertPathOutsideCampaign(scratch, campaign);
      await assert.rejects(
        () => assertPathOutsideCampaign(path.join(campaign, 'raw'), campaign),
        /outside campaign/i,
      );

      const deny = await campaignDenyPaths(campaign);
      assert.ok(deny.length >= 1);
      const profile = buildProviderSeatbeltProfile(deny);
      assert.match(profile, /\(allow default\)/);
      assert.match(profile, /deny file-read\*/);
      assert.match(profile, /deny file-write\*/);
      for (const p of deny) {
        assert.ok(profile.includes(path.basename(p)) || profile.includes(p));
      }

      const conf = await detectProviderConfinement();
      if (conf.available && conf.kind === 'sandbox-exec') {
        const wrapped = buildProviderConfinedArgv({
          confinement: conf,
          command: '/bin/echo',
          args: ['hi'],
          cwd: workspace,
          campaignPaths: deny,
          profilePath: '/tmp/fake.sb',
        });
        assert.equal(wrapped.command, conf.binary);
        assert.ok(wrapped.args.includes('-f'));
        assert.ok(wrapped.args.includes('/bin/echo'));
        assert.ok(wrapped.args.includes('hi'));
      }
      if (conf.available && conf.kind === 'bwrap') {
        const wrapped = buildProviderConfinedArgv({
          confinement: conf,
          command: '/bin/echo',
          args: ['hi'],
          cwd: workspace,
          campaignPaths: deny,
          extraBindPaths: [scratch],
        });
        assert.equal(wrapped.command, conf.binary);
        assert.ok(wrapped.args.includes('--tmpfs'));
        // campaign path masked
        assert.ok(deny.some((d) => wrapped.args.includes(path.resolve(d))));
        assert.ok(wrapped.args.includes('--bind'));
        assert.ok(wrapped.args.includes(path.resolve(workspace)));
      }

      // Unavailable confinement → wrap fails closed without spawning
      const forced = await wrapProviderCommand({
        command: '/bin/echo',
        args: ['x'],
        cwd: workspace,
        campaignDir: campaign,
        confinement: {
          available: false,
          kind: null,
          binary: null,
          reason: 'test-forced-unavailable',
        },
      });
      assert.equal(forced.ok, false);
      assert.equal(forced.executionUnavailable, true);
      assert.match(String(forced.infraFailure), /fail closed|unavailable/i);
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('spawnControlled refuses provider spawn without campaignDir when confine required', async () => {
    const { spawnControlled } = await import(
      '../harness/invokers/spawn-controlled.js'
    );
    const r = await spawnControlled({
      command: 'true',
      args: [],
      cwd: os.tmpdir(),
      confine: true,
    });
    assert.equal(r.executionUnavailable, true);
    assert.match(String(r.infraFailure), /campaignDir|fail closed/i);
  });

  it('platform probe: confined child cannot read campaign sentinel; can use workspace', async (t) => {
    const {
      detectProviderConfinement,
    } = await import('../harness/invokers/provider-confine.js');
    const { spawnControlled } = await import(
      '../harness/invokers/spawn-controlled.js'
    );

    const conf = await detectProviderConfinement();
    if (!conf.available) {
      t.skip(
        `provider confinement not available on this host (${conf.reason}); production fails closed`,
      );
      return;
    }

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-probe-camp-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-probe-ws-'));
    try {
      const sentinel = path.join(campaign, 'raw', 'SECRET.txt');
      await mkdir(path.dirname(sentinel), { recursive: true });
      await writeFile(sentinel, 'campaign-secret-body\n', 'utf8');
      const marker = path.join(workspace, 'ws-write.txt');

      // Try to read campaign sentinel — must fail under confinement
      const readCamp = await spawnControlled({
        command: '/bin/cat',
        args: [sentinel],
        cwd: workspace,
        campaignDir: campaign,
        confine: true,
        confinement: conf,
        timeoutMs: 10_000,
      });
      assert.ok(
        readCamp.exitCode !== 0 ||
          readCamp.executionUnavailable ||
          !(readCamp.stdout || '').includes('campaign-secret-body'),
      );
      assert.ok(!(readCamp.stdout || '').includes('campaign-secret-body'));

      // Argv-safe workspace write/read: no shell. Trusted harness seeds a file in
      // the workspace *before* spawn; confined child must /bin/cp it to the marker
      // and later /bin/cat it back (no harness write fallback after spawn).
      const seed = path.join(workspace, 'seed.txt');
      await writeFile(seed, 'workspace-ok\n', 'utf8');
      const cpBin = (await access('/bin/cp').then(() => '/bin/cp').catch(() => null))
        || (await access('/usr/bin/cp').then(() => '/usr/bin/cp').catch(() => null));
      if (!cpBin) {
        t.skip('/bin/cp unavailable for workspace probe');
        return;
      }

      const writeWs = await spawnControlled({
        command: cpBin,
        args: [seed, marker],
        cwd: workspace,
        campaignDir: campaign,
        confine: true,
        confinement: conf,
        timeoutMs: 10_000,
      });
      assert.equal(
        writeWs.exitCode,
        0,
        `confined cp must succeed in workspace: ${writeWs.infraFailure || writeWs.stderr || writeWs.stdout}`,
      );
      assert.equal(writeWs.executionUnavailable, undefined);
      await access(marker);

      const readWs = await spawnControlled({
        command: '/bin/cat',
        args: [marker],
        cwd: workspace,
        campaignDir: campaign,
        confine: true,
        confinement: conf,
        timeoutMs: 10_000,
      });
      assert.equal(readWs.exitCode, 0, readWs.infraFailure || readWs.stderr);
      assert.equal((readWs.stdout || '').trim(), 'workspace-ok');
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('adapter rejects free-form reasonCode at parse boundary', async () => {
    const {
      parseInvokeResult,
      sanitizeAdapterReasonCode,
      POETIC_INVOKE_RESULT_SCHEMA,
    } = await import('../harness/invokers/poetic-adapter.js');

    assert.equal(sanitizeAdapterReasonCode('ok'), 'ok');
    assert.equal(sanitizeAdapterReasonCode('rc-timeout'), 'rc-timeout');
    assert.equal(
      sanitizeAdapterReasonCode('Authorization: Bearer sk-secret leak'),
      null,
    );
    assert.equal(sanitizeAdapterReasonCode('a'.repeat(129)), null);

    const { buildValidInvokeResultV1 } = await import(
      './helpers/poetic-result-v1.js'
    );

    // Free-form reasonCode is not a ProviderInvokeReasonCode → invalid
    const free = parseInvokeResult(
      buildValidInvokeResultV1({
        requestId: 'r1',
        provider: 'fake',
        requestedModel: null,
        outcomeKind: 'provider_error',
        reasonCode: 'PROVIDER_ERROR',
        overrides: {
          outcome: {
            kind: 'provider_error',
            exitCode: 1,
            reasonCode: 'secret dump: password=hunter2 and free form',
          },
        },
      }),
    );
    assert.equal(free.valid, false);
    assert.equal(free.artifact, null);
    assert.match(String(free.parseError), /reasonCode|invalid/i);

    const ok = parseInvokeResult(
      buildValidInvokeResultV1({
        requestId: 'r1',
        provider: 'fake',
        requestedModel: 'm1',
        resolvedModel: 'm1',
        outcomeKind: 'success',
        reasonCode: 'SUCCESS',
      }),
    );
    assert.equal(ok.valid, true);
    assert.equal(ok.reasonCode, 'SUCCESS');
    assert.equal(ok.reasonCodeRejected, false);
  });

  it('deterministic private temp + TMPDIR/TMP/TEMP construction (runs everywhere)', async () => {
    const {
      createProviderPrivateTemp,
      applyProviderTempEnv,
      wrapProviderCommand,
      PROVIDER_PRIVATE_TEMP_PREFIX,
      buildProviderConfinedArgv,
    } = await import('../harness/invokers/provider-confine.js');
    const { resolveHarnessEnv } = await import(
      '../harness/invokers/spawn-controlled.js'
    );
    const { access: fsAccess } = await import('node:fs/promises');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-ptemp-camp-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-ptemp-ws-'));
    const scratch = path.join(workspace, '.aicb-scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    try {
      // Private temp under scratch/workspace bind — never campaign.
      const privateTemp = await createProviderPrivateTemp(scratch);
      assert.ok(
        privateTemp.startsWith(scratch + path.sep) ||
          privateTemp.startsWith(path.resolve(scratch) + path.sep),
      );
      assert.ok(path.basename(privateTemp).startsWith(PROVIDER_PRIVATE_TEMP_PREFIX));
      if (process.platform !== 'win32') {
        const { stat } = await import('node:fs/promises');
        assert.equal((await stat(privateTemp)).mode & 0o777, 0o700);
      }
      // Must not land under campaign control storage
      assert.ok(!privateTemp.startsWith(path.resolve(campaign) + path.sep));
      assert.notEqual(privateTemp, path.resolve(campaign));

      // applyProviderTempEnv constrains only temp keys; no task-env merge.
      const base = resolveHarnessEnv({
        PATH: '/usr/bin',
        HOST_ONLY: 'keep-me',
        TMPDIR: '/host-tmp-must-be-overwritten',
      });
      const childEnv = applyProviderTempEnv(base, privateTemp);
      assert.equal(childEnv.TMPDIR, path.resolve(privateTemp));
      assert.equal(childEnv.TMP, path.resolve(privateTemp));
      assert.equal(childEnv.TEMP, path.resolve(privateTemp));
      assert.equal(childEnv.PATH, '/usr/bin');
      assert.equal(childEnv.HOST_ONLY, 'keep-me');
      // Explicit absence of task-like smuggled keys
      assert.equal(childEnv.TASK_SECRET, undefined);
      assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);

      // wrapProviderCommand: private temp under privateTempParent, outside campaign
      const forcedBwrap = {
        available: true,
        kind: 'bwrap',
        binary: '/usr/bin/bwrap',
      };
      const wrapped = await wrapProviderCommand({
        command: '/bin/echo',
        args: ['ok'],
        cwd: workspace,
        campaignDir: campaign,
        privateTempParent: scratch,
        extraBindPaths: [scratch],
        confinement: forcedBwrap,
      });
      assert.equal(wrapped.ok, true);
      assert.ok(wrapped.privateTempDir);
      assert.ok(
        wrapped.privateTempDir.startsWith(path.resolve(scratch) + path.sep) ||
          wrapped.privateTempDir.startsWith(scratch + path.sep),
      );
      // bwrap argv must RW-bind workspace + private temp; mask campaign with tmpfs
      assert.ok(wrapped.args.includes('--ro-bind'));
      assert.ok(wrapped.args.includes('--tmpfs'));
      assert.ok(wrapped.args.includes('--bind'));
      assert.ok(wrapped.args.includes(path.resolve(workspace)));
      assert.ok(wrapped.args.includes(path.resolve(wrapped.privateTempDir)));
      // Campaign path must not appear as a --bind source (only --tmpfs mask)
      const campAbs = path.resolve(campaign);
      for (let i = 0; i < wrapped.args.length; i += 1) {
        if (wrapped.args[i] === '--bind') {
          assert.notEqual(wrapped.args[i + 1], campAbs);
          assert.notEqual(wrapped.args[i + 2], campAbs);
        }
      }
      // Env overlay for the confined child matches private temp
      const envForChild = applyProviderTempEnv(
        resolveHarnessEnv(undefined),
        wrapped.privateTempDir,
      );
      assert.equal(envForChild.TMPDIR, path.resolve(wrapped.privateTempDir));
      assert.equal(envForChild.TMP, path.resolve(wrapped.privateTempDir));
      assert.equal(envForChild.TEMP, path.resolve(wrapped.privateTempDir));

      // buildProviderConfinedArgv pure construction coverage (no spawn)
      const argvOnly = buildProviderConfinedArgv({
        confinement: forcedBwrap,
        command: '/bin/true',
        args: [],
        cwd: workspace,
        campaignPaths: [campAbs],
        extraBindPaths: [scratch, wrapped.privateTempDir],
      });
      assert.equal(argvOnly.command, '/usr/bin/bwrap');
      assert.ok(argvOnly.args.includes('--die-with-parent'));
      assert.ok(argvOnly.args.includes('/bin/true'));

      // Lifecycle: cleanup removes private temp
      await wrapped.cleanup();
      await assert.rejects(() => fsAccess(wrapped.privateTempDir), /ENOENT/);

      const outside = await mkdtemp(
        path.join(os.tmpdir(), 'aicb-ptemp-outside-'),
      );
      try {
        const refused = await wrapProviderCommand({
          command: '/bin/echo',
          args: ['no'],
          cwd: workspace,
          campaignDir: campaign,
          privateTempParent: outside,
          confinement: forcedBwrap,
        });
        assert.equal(refused.ok, false);
        assert.match(
          refused.infraFailure,
          /private temp parent must be inside cwd or an explicit writable bind/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
      await rm(privateTemp, { recursive: true, force: true });
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('spawnControlled injects constrained TMPDIR under workspace and cleans up', async () => {
    const { detectProviderConfinement } = await import(
      '../harness/invokers/provider-confine.js'
    );
    const { spawnControlled } = await import(
      '../harness/invokers/spawn-controlled.js'
    );

    const conf = await detectProviderConfinement();
    if (!conf.available) {
      // Still cover env path without OS confinement by unit-testing apply only —
      // the deterministic construction test above already does. Skip live spawn.
      return;
    }

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-ptemp-live-c-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-ptemp-live-w-'));
    try {
      // Child prints TMPDIR/TMP/TEMP and proves os.tmpdir()-style write works.
      const r = await spawnControlled({
        command: process.execPath,
        args: [
          '-e',
          `
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = process.env.TMPDIR || '';
const report = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  osTmpdir: os.tmpdir(),
};
try {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'poetic-probe-'));
  fs.writeFileSync(path.join(d, 'spool.bin'), 'raw-ok');
  report.spoolOk = true;
  report.spoolDir = d;
  fs.rmSync(d, { recursive: true, force: true });
} catch (e) {
  report.spoolOk = false;
  report.spoolErr = e && e.message ? e.message : String(e);
}
process.stdout.write(JSON.stringify(report));
`,
        ],
        cwd: workspace,
        campaignDir: campaign,
        confine: true,
        confinement: conf,
        // Harness-controlled env only — no task secrets
        env: { PATH: process.env.PATH, TMPDIR: '/should-be-overwritten' },
        timeoutMs: 15_000,
      });
      assert.equal(
        r.exitCode,
        0,
        `confined tmp probe failed: ${r.infraFailure || r.stderr || r.stdout}`,
      );
      assert.equal(r.executionUnavailable, undefined);
      const report = JSON.parse(r.stdout || '{}');
      assert.ok(report.TMPDIR, 'TMPDIR must be set');
      assert.equal(report.TMPDIR, report.TMP);
      assert.equal(report.TMPDIR, report.TEMP);
      // Private temp under workspace bind
      assert.ok(
        String(report.TMPDIR).startsWith(path.resolve(workspace) + path.sep) ||
          String(report.TMPDIR).startsWith(workspace + path.sep),
        `TMPDIR must be under workspace, got ${report.TMPDIR}`,
      );
      // Never under campaign
      assert.ok(
        !String(report.TMPDIR).startsWith(path.resolve(campaign) + path.sep),
      );
      assert.equal(report.spoolOk, true, report.spoolErr || 'spool write failed');
      // privateTempDir reported then cleaned by spawnControlled finally
      if (r.privateTempDir) {
        await assert.rejects(
          () => access(r.privateTempDir),
          /ENOENT/,
        );
      }
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('poetic-adapter refuses taskEnv (no task-env injection)', async () => {
    const { invokePoeticAdapter } = await import(
      '../harness/invokers/poetic-adapter.js'
    );
    const r = await invokePoeticAdapter({
      poeticBin: 'poetic',
      requestPath: '/tmp/req.json',
      outputPath: '/tmp/out.json',
      campaignDir: '/tmp/camp',
      taskEnv: { SECRET: 'nope' },
    });
    assert.equal(r.success, false);
    assert.match(String(r.infraFailure), /taskEnv|refusing/i);
  });

  it('bwrap Poetic-invocation: os.tmpdir() spool writable under confined TMPDIR', async (t) => {
    const {
      detectProviderConfinement,
    } = await import('../harness/invokers/provider-confine.js');
    const conf = await detectProviderConfinement();
    if (!conf.available || conf.kind !== 'bwrap') {
      t.skip(
        conf.available
          ? `provider confinement is ${conf.kind}, not bwrap; skip Linux bubblewrap Poetic integration`
          : `bwrap not available (${conf.reason}); skip Linux bubblewrap Poetic integration`,
      );
      return;
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bwrap-poetic-'));
    try {
      // Fake Poetic mirrors real raw-stream-capture: mkdtemp under os.tmpdir()
      // then writes a valid result v1. Under bwrap without constrained TMPDIR
      // this fails because host /tmp is RO; with the fix it succeeds.
      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
const reqIdx = args.indexOf('--request');
const outIdx = args.indexOf('--output');
if (reqIdx < 0 || outIdx < 0) { process.stderr.write('bad args'); process.exit(2); }
const reqPath = args[reqIdx + 1];
const out = args[outIdx + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
// --- Poetic-like private spool under os.tmpdir() (must be writable) ---
let spoolDir;
try {
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poetic-invoke-raw-'));
  fs.chmodSync(spoolDir, 0o700);
  fs.writeFileSync(
    path.join(spoolDir, 'stdout.spool'),
    'provider-stdout-body TMPDIR=' + (process.env.TMPDIR || '') + '\\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(spoolDir, 'stderr.spool'), 'provider-stderr-body\\n', { mode: 0o600 });
} catch (e) {
  process.stderr.write('SPOOL_FAIL:' + (e && e.message ? e.message : String(e)));
  process.exit(3);
}
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(path.join(spoolDir, 'stdout.spool'), path.join(rawDir, 'stdout.txt'));
fs.copyFileSync(path.join(spoolDir, 'stderr.spool'), path.join(rawDir, 'stderr.txt'));
fs.rmSync(spoolDir, { recursive: true, force: true });
const avail = (v) => ({ availability: 'available', value: v });
const unavail = (r) => ({ availability: 'unavailable', reason: r });
const now = new Date().toISOString();
const rm = req.model != null && String(req.model).trim() !== '' ? String(req.model) : null;
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', exitCode: 0, reasonCode: 'SUCCESS' },
  provider: { requested: avail(req.provider), resolved: avail(req.provider) },
  model: {
    requested: rm ? avail(rm) : unavail('no model requested'),
    resolved: avail('bwrap-resolved'),
    resolutionSource: 'provider-result',
  },
  versions: { poetic: avail('t'), providerCli: unavail('n/a') },
  posture: {
    fingerprint: avail('${'e'.repeat(64)}'),
    argvRedacted: avail(['x']),
    commandPath: unavail('n/a'),
    sourceClasses: ['cli'],
    workspaceMode: unavail('n/a'),
  },
  stateIsolation: 'unsupported',
  attempts: [{ attempt: 1, startedAt: now, endedAt: now, durationMs: 1, exitCode: 0 }],
  timing: { startedAt: now, endedAt: now, durationMs: 1 },
  process: { exitCode: 0, transportStatus: unavail('n/a') },
  cleanup: { status: 'not-needed' },
  diagnostics: unavail('n/a'),
  usage: unavail('n/a'),
  cost: unavail('n/a'),
  artifacts: {
    result: path.resolve(out),
    quarantineDir: rawDir,
    stdout: path.join(rawDir, 'stdout.txt'),
    stderr: path.join(rawDir, 'stderr.txt'),
  },
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const {
        buildInvocationRequest,
        invokePoeticAdapter,
      } = await import('../harness/invokers/index.js');

      const workspaceDir = path.join(dir, 'ws');
      const campaignDir = path.join(dir, '_campaign');
      const scratchDir = path.join(workspaceDir, '.aicb-scratch');
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      await mkdir(scratchDir, { recursive: true, mode: 0o700 });
      // Campaign sentinel must remain unreadable under confinement
      await writeFile(
        path.join(campaignDir, 'SECRET.txt'),
        'campaign-secret\n',
        'utf8',
      );

      const request = buildInvocationRequest({
        arm: { provider: 'fake', model: 'm-bwrap' },
        task: { description: 'bwrap tmp probe' },
        workspaceDir,
        requestId: 'req-bwrap-tmp',
        timeoutMs: 30_000,
      });
      const requestPath = path.join(scratchDir, 'request.json');
      const outputPath = path.join(scratchDir, 'output.json');

      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request,
        cwd: workspaceDir,
        timeoutMs: 30_000,
        campaignDir,
        confinement: conf,
        // Harness-controlled env only (PATH so node is findable if needed)
        env: { PATH: process.env.PATH },
      });

      assert.equal(
        result.executionUnavailable,
        undefined,
        result.infraFailure || 'execution unavailable',
      );
      assert.equal(
        result.exitCode,
        0,
        `bwrap poetic invoke failed: ${result.infraFailure || result.stderr || result.stdout}`,
      );
      assert.equal(result.success, true);
      assert.equal(result.outcomeKind, 'success');
      assert.match(result.stdout, /provider-stdout-body/);
      // Raw provider evidence proves TMPDIR was constrained under the
      // workspace/scratch bind without adding non-schema fields to result.v1.
      const tmpMatch = /TMPDIR=([^\n]+)/.exec(result.stdout);
      assert.ok(tmpMatch, `TMPDIR marker missing from raw stdout: ${result.stdout}`);
      const observedTmpDir = tmpMatch[1];
      assert.ok(
        String(observedTmpDir).startsWith(
          path.resolve(scratchDir) + path.sep,
        ) ||
          String(observedTmpDir).startsWith(
            path.resolve(workspaceDir) + path.sep,
          ),
        `TMPDIR under scratch/workspace expected, got ${observedTmpDir}`,
      );
      assert.ok(
        !String(observedTmpDir).startsWith(
          path.resolve(campaignDir) + path.sep,
        ),
        'TMPDIR must not expose campaign-control storage',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
