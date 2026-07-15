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
});
