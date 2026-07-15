/**
 * Strict poetic.provider.invoke.result.v1 contract (ProviderInvokeResultV1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, chmod, mkdir, rm } from 'node:fs/promises';
import {
  buildValidInvokeResultV1,
  available,
  unavailable,
} from './helpers/poetic-result-v1.js';

describe('poetic-adapter strict ProviderInvokeResultV1 contract', () => {
  it('rejects missing each required top-level section', async () => {
    const { parseInvokeResult } = await import(
      '../harness/invokers/poetic-adapter.js'
    );
    const full = buildValidInvokeResultV1();
    const required = [
      'schema',
      'requestId',
      'outcome',
      'provider',
      'model',
      'versions',
      'posture',
      'stateIsolation',
      'attempts',
      'timing',
      'process',
      'cleanup',
      'diagnostics',
      'usage',
      'cost',
      'artifacts',
    ];
    for (const key of required) {
      const copy = { ...full };
      delete copy[key];
      const parsed = parseInvokeResult(copy);
      assert.equal(parsed.valid, false, `missing ${key} should be invalid`);
      assert.equal(parsed.artifact, null, `missing ${key} must clear artifact`);
      assert.equal(parsed.success, false);
    }
  });

  it('rejects malformed availability-coded values', async () => {
    const { parseInvokeResult } = await import(
      '../harness/invokers/poetic-adapter.js'
    );
    const base = buildValidInvokeResultV1();

    const badAvailable = {
      ...base,
      model: {
        .../** @type {object} */ (base.model),
        resolved: { availability: 'available' }, // missing value
      },
    };
    assert.equal(parseInvokeResult(badAvailable).valid, false);

    const badProviderRequested = {
      ...base,
      provider: {
        requested: unavailable('nope'), // must be AvailableValue
        resolved: available('fake'),
      },
    };
    assert.equal(parseInvokeResult(badProviderRequested).valid, false);

    const badResolutionSource = {
      ...base,
      model: {
        .../** @type {object} */ (base.model),
        resolutionSource: 'not-a-source',
      },
    };
    assert.equal(parseInvokeResult(badResolutionSource).valid, false);

    const freeReason = {
      ...base,
      outcome: {
        kind: 'provider_error',
        exitCode: 1,
        reasonCode: 'secret dump free form',
      },
    };
    assert.equal(parseInvokeResult(freeReason).valid, false);
  });

  it('provider mismatch and requested-model mismatch fail bind', async () => {
    const {
      parseInvokeResult,
      bindInvokeResultToRequest,
    } = await import('../harness/invokers/poetic-adapter.js');

    const parsed = parseInvokeResult(
      buildValidInvokeResultV1({
        requestId: 'id-1',
        provider: 'openai',
        requestedModel: 'gpt-test',
        resolvedModel: 'gpt-test',
      }),
    );
    assert.equal(parsed.valid, true);

    const wrongProv = bindInvokeResultToRequest(parsed, {
      requestId: 'id-1',
      provider: 'anthropic',
      requestedModel: 'gpt-test',
    });
    assert.equal(wrongProv.valid, false);
    assert.equal(wrongProv.artifact, null);
    assert.match(String(wrongProv.parseError), /provider/i);

    const wrongModel = bindInvokeResultToRequest(parsed, {
      requestId: 'id-1',
      provider: 'openai',
      requestedModel: 'other-model',
    });
    assert.equal(wrongModel.valid, false);
    assert.equal(wrongModel.artifact, null);
    assert.match(String(wrongModel.parseError), /requested-model/i);

    // request has no model; result claims available model
    const claimed = parseInvokeResult(
      buildValidInvokeResultV1({
        requestId: 'id-2',
        provider: 'openai',
        requestedModel: 'sneaky',
      }),
    );
    const claimWhenNone = bindInvokeResultToRequest(claimed, {
      requestId: 'id-2',
      provider: 'openai',
      requestedModel: null,
    });
    assert.equal(claimWhenNone.valid, false);
    assert.match(String(claimWhenNone.parseError), /requested-model/i);

    // no model both sides
    const none = parseInvokeResult(
      buildValidInvokeResultV1({
        requestId: 'id-3',
        provider: 'openai',
        requestedModel: null,
        resolvedModel: null,
      }),
    );
    const boundNone = bindInvokeResultToRequest(none, {
      requestId: 'id-3',
      provider: 'openai',
      requestedModel: null,
    });
    assert.equal(boundNone.valid, true);
    assert.ok(boundNone.artifact);
  });

  it('valid full success and refusal artifacts parse and bind', async () => {
    const {
      parseInvokeResult,
      bindInvokeResultToRequest,
      parseResolvedModelEvidence,
    } = await import('../harness/invokers/index.js');

    const success = buildValidInvokeResultV1({
      requestId: 'ok-1',
      provider: 'openai',
      requestedModel: 'm1',
      resolvedModel: 'm1-resolved',
      outcomeKind: 'success',
      reasonCode: 'SUCCESS',
      exitCode: 0,
    });
    const ps = parseInvokeResult(success);
    assert.equal(ps.valid, true);
    assert.equal(ps.success, true);
    const bs = bindInvokeResultToRequest(ps, {
      requestId: 'ok-1',
      provider: 'openai',
      requestedModel: 'm1',
    });
    assert.equal(bs.valid, true);
    assert.equal(bs.success, true);
    const ev = parseResolvedModelEvidence(bs.artifact);
    assert.equal(ev.available, true);
    assert.equal(ev.resolvedModel, 'm1-resolved');

    const refusal = buildValidInvokeResultV1({
      requestId: 'ref-1',
      provider: 'openai',
      requestedModel: null,
      resolvedModel: null,
      outcomeKind: 'refusal',
      reasonCode: 'PROVIDER_ERROR',
      exitCode: 1,
    });
    const pr = parseInvokeResult(refusal);
    assert.equal(pr.valid, true);
    assert.equal(pr.success, false);
    assert.equal(pr.outcomeKind, 'refusal');
    const br = bindInvokeResultToRequest(pr, {
      requestId: 'ref-1',
      provider: 'openai',
      requestedModel: null,
    });
    assert.equal(br.valid, true);
    assert.equal(br.success, false);
    assert.ok(br.artifact);
  });

  it('end-to-end adapter: full valid result + raw → success; mismatch → fail', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-v1-e2e-'));
    try {
      const { invokePoeticAdapter } = await import(
        '../harness/invokers/poetic-adapter.js'
      );

      const binOk = path.join(dir, 'fake-ok');
      await writeFile(
        binOk,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const qDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(qDir, 'stdout.txt'), 'full-v1-out\\n');
fs.writeFileSync(path.join(qDir, 'stderr.txt'), '');
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
    resolved: rm ? avail(rm) : unavail('model not resolved'),
    resolutionSource: rm ? 'provider-result' : 'unavailable',
  },
  versions: { poetic: avail('t'), providerCli: unavail('n/a') },
  posture: {
    fingerprint: avail('${'c'.repeat(64)}'),
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
    quarantineDir: qDir,
    stdout: path.join(qDir, 'stdout.txt'),
    stderr: path.join(qDir, 'stderr.txt'),
  },
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(binOk, 0o755);

      const campaignDir = path.join(dir, '_camp');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const ok = await invokePoeticAdapter({
        poeticBin: binOk,
        requestPath: path.join(dir, 'req.json'),
        outputPath: path.join(dir, 'out.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'e2e-ok',
          provider: 'openai',
          model: 'm1',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 5000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(ok.success, true, ok.infraFailure);
      assert.equal(ok.providerRawEvidence, 'actual');
      assert.match(ok.stdout, /full-v1-out/);

      // Wrong provider in result
      const binBad = path.join(dir, 'fake-bad');
      await writeFile(
        binBad,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const qDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(qDir, 'stdout.txt'), 'x\\n');
fs.writeFileSync(path.join(qDir, 'stderr.txt'), '');
const avail = (v) => ({ availability: 'available', value: v });
const unavail = (r) => ({ availability: 'unavailable', reason: r });
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', exitCode: 0, reasonCode: 'SUCCESS' },
  provider: { requested: avail('WRONG-PROVIDER'), resolved: avail('WRONG-PROVIDER') },
  model: {
    requested: unavail('no model requested'),
    resolved: unavail('n/a'),
    resolutionSource: 'unavailable',
  },
  versions: { poetic: avail('t'), providerCli: unavail('n/a') },
  posture: {
    fingerprint: avail('${'d'.repeat(64)}'),
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
  artifacts: { result: path.resolve(out), quarantineDir: qDir },
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(binBad, 0o755);
      const bad = await invokePoeticAdapter({
        poeticBin: binBad,
        requestPath: path.join(dir, 'req2.json'),
        outputPath: path.join(dir, 'out2.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'e2e-bad',
          provider: 'openai',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 5000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(bad.success, false);
      assert.equal(bad.parsedOutput, null);
      assert.match(String(bad.infraFailure), /provider/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
