/**
 * Strict poetic.provider.invoke.result.v1 parse + identity bind contract.
 *
 * Invariant: bridge artifact must be fully schema-valid and identity-bound
 * to the frozen request before model/raw success claims.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';

const RESULT_SCHEMA = 'poetic.provider.invoke.result.v1';

/**
 * Minimal valid full v1 result (schema-valid; identity bind is separate).
 * @param {Record<string, unknown>} [overrides]
 */
function fullResult(overrides = {}) {
  return {
    schema: RESULT_SCHEMA,
    requestId: 'req-1',
    provider: 'openai',
    model: {
      requested: 'gpt-test',
      resolved: { availability: 'available', value: 'resolved-model' },
    },
    outcome: { kind: 'success', reasonCode: 'ok' },
    ...overrides,
  };
}

describe('poetic-adapter strict result.v1 contract', () => {
  it('missing/malformed required fields → invalid, no artifact', async () => {
    const {
      parseInvokeResult,
      POETIC_INVOKE_RESULT_SCHEMA,
    } = await import('../harness/invokers/poetic-adapter.js');

    assert.equal(POETIC_INVOKE_RESULT_SCHEMA, RESULT_SCHEMA);

    /** @type {Array<[string, unknown, string]>} */
    const cases = [
      ['not-object', null, 'not-object'],
      ['array', [], 'not-object'],
      ['schema-mismatch', { schema: 'wrong', requestId: 'r', provider: 'p' }, 'schema-mismatch'],
      [
        'missing-requestId',
        {
          schema: RESULT_SCHEMA,
          provider: 'p',
          model: {
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
          outcome: { kind: 'success' },
        },
        'missing-requestId',
      ],
      [
        'empty-requestId',
        {
          schema: RESULT_SCHEMA,
          requestId: '  ',
          provider: 'p',
          model: {
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
          outcome: { kind: 'success' },
        },
        'missing-requestId',
      ],
      [
        'missing-provider',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          model: {
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
          outcome: { kind: 'success' },
        },
        'missing-provider',
      ],
      [
        'missing-model',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          outcome: { kind: 'success' },
        },
        'missing-model',
      ],
      [
        'invalid-model-resolved',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          model: { resolved: 'bare-string' },
          outcome: { kind: 'success' },
        },
        'invalid-model-resolved',
      ],
      [
        'available-missing-value',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          model: { resolved: { availability: 'available' } },
          outcome: { kind: 'success' },
        },
        'model-resolved-available-missing-value',
      ],
      [
        'invalid-model-requested',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          model: {
            requested: 42,
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
          outcome: { kind: 'success' },
        },
        'invalid-model-requested',
      ],
      [
        'missing-outcome',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          model: {
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
        },
        'missing-outcome',
      ],
      [
        'unknown-kind',
        {
          schema: RESULT_SCHEMA,
          requestId: 'r1',
          provider: 'p',
          model: {
            resolved: { availability: 'unavailable', reason: 'n/a' },
          },
          outcome: { kind: 'not-a-real-kind' },
        },
        'unknown-kind',
      ],
      [
        'invalid-process',
        {
          ...fullResult(),
          process: 'not-an-object',
        },
        'invalid-process',
      ],
      [
        'invalid-evidence',
        {
          ...fullResult(),
          evidence: ['array'],
        },
        'invalid-evidence',
      ],
    ];

    for (const [label, input, expectedParseError] of cases) {
      const parsed = parseInvokeResult(input);
      assert.equal(parsed.valid, false, label);
      assert.equal(parsed.success, false, label);
      assert.equal(parsed.artifact, null, label);
      assert.equal(parsed.parseError, expectedParseError, label);
    }
  });

  it('provider mismatch → not fullyBound / no success / no model attribution', async () => {
    const {
      parseInvokeResult,
      bindInvokeResultToRequest,
    } = await import('../harness/invokers/poetic-adapter.js');

    const parsed = parseInvokeResult(
      fullResult({ provider: 'other-provider' }),
    );
    assert.equal(parsed.valid, true);
    assert.ok(parsed.artifact);

    const bound = bindInvokeResultToRequest(parsed, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: 'gpt-test',
    });
    assert.equal(bound.valid, false);
    assert.equal(bound.success, false);
    assert.equal(bound.artifact, null);
    assert.equal(bound.parseError, 'provider-mismatch');
    assert.match(String(bound.infraFailure), /provider mismatch/i);
  });

  it('requested-model mismatch → not fullyBound / no success / no model attribution', async () => {
    const {
      parseInvokeResult,
      bindInvokeResultToRequest,
    } = await import('../harness/invokers/poetic-adapter.js');

    // Result claims a different requested model than the frozen request.
    const wrongClaim = parseInvokeResult(
      fullResult({
        model: {
          requested: 'other-model',
          resolved: { availability: 'available', value: 'resolved-model' },
        },
      }),
    );
    assert.equal(wrongClaim.valid, true);
    const boundWrong = bindInvokeResultToRequest(wrongClaim, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: 'gpt-test',
    });
    assert.equal(boundWrong.valid, false);
    assert.equal(boundWrong.success, false);
    assert.equal(boundWrong.artifact, null);
    assert.equal(boundWrong.parseError, 'requested-model-mismatch');

    // Request pinned no model; result must not claim a non-null requested model.
    const claimWhenNone = parseInvokeResult(
      fullResult({
        model: {
          requested: 'sneaky-model',
          resolved: { availability: 'available', value: 'resolved-model' },
        },
      }),
    );
    const boundClaim = bindInvokeResultToRequest(claimWhenNone, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: null,
    });
    assert.equal(boundClaim.valid, false);
    assert.equal(boundClaim.artifact, null);
    assert.equal(boundClaim.parseError, 'requested-model-mismatch');

    // Request pinned a model; result omitted model.requested → mismatch.
    const omittedObj = fullResult();
    delete /** @type {any} */ (omittedObj.model).requested;
    const omittedParsed = parseInvokeResult(omittedObj);
    assert.equal(omittedParsed.valid, true);
    const boundOmitted = bindInvokeResultToRequest(omittedParsed, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: 'gpt-test',
    });
    assert.equal(boundOmitted.valid, false);
    assert.equal(boundOmitted.artifact, null);
    assert.equal(boundOmitted.parseError, 'requested-model-mismatch');

    // Both sides null/absent → match
    const noneParsed = parseInvokeResult(omittedObj);
    const boundNone = bindInvokeResultToRequest(noneParsed, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: null,
    });
    assert.equal(boundNone.valid, true);
    assert.ok(boundNone.artifact);
    assert.equal(boundNone.success, true);
  });

  it('valid full result with matching identity + provider raw files → success', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-contract-ok-'));
    try {
      const { invokePoeticAdapter, parseResolvedModelEvidence } = await import(
        '../harness/invokers/index.js'
      );

      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'contract-provider-stdout\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), 'contract-provider-stderr\\n');
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  provider: req.provider,
  model: {
    requested: req.model != null ? req.model : null,
    resolved: { availability: 'available', value: 'resolved-from-bridge' }
  },
  outcome: { kind: 'success', reasonCode: 'ok' }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath: path.join(dir, 'req.json'),
        outputPath: path.join(dir, 'out.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'contract-req-1',
          provider: 'openai',
          model: 'gpt-test',
          prompt: 'do the thing',
          workingDirectory: dir,
          timeoutMs: 5000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.success, true);
      assert.equal(result.outcomeKind, 'success');
      assert.equal(result.infraFailure, undefined);
      assert.equal(result.providerRawEvidence, 'actual');
      assert.match(result.stdout, /contract-provider-stdout/);
      assert.ok(result.parsedOutput);
      assert.equal(result.parsedOutput.provider, 'openai');
      assert.equal(
        /** @type {any} */ (result.parsedOutput).model.requested,
        'gpt-test',
      );
      const evidence = parseResolvedModelEvidence(result.parsedOutput);
      assert.equal(evidence.available, true);
      assert.equal(evidence.resolvedModel, 'resolved-from-bridge');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refusal with valid schema still non-success but identity-bound', async () => {
    const {
      parseInvokeResult,
      bindInvokeResultToRequest,
    } = await import('../harness/invokers/poetic-adapter.js');

    const parsed = parseInvokeResult(
      fullResult({
        outcome: { kind: 'refusal', reasonCode: 'policy_block' },
        model: {
          requested: 'gpt-test',
          resolved: {
            availability: 'unavailable',
            reason: 'provider refused before resolve',
          },
        },
      }),
    );
    assert.equal(parsed.valid, true);
    assert.equal(parsed.success, false);
    assert.equal(parsed.outcomeKind, 'refusal');
    assert.equal(parsed.reasonCode, 'policy_block');
    assert.ok(parsed.artifact);

    const bound = bindInvokeResultToRequest(parsed, {
      requestId: 'req-1',
      provider: 'openai',
      requestedModel: 'gpt-test',
    });
    assert.equal(bound.valid, true, 'identity-bound refusal remains valid');
    assert.equal(bound.success, false);
    assert.equal(bound.outcomeKind, 'refusal');
    assert.ok(bound.artifact, 'identity-bound non-success may retain artifact');
    assert.equal(bound.artifact.provider, 'openai');
  });

  it('adapter invoke rejects provider/model identity mismatches (no model evidence)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-contract-mis-'));
    try {
      const { invokePoeticAdapter } = await import(
        '../harness/invokers/index.js'
      );

      // Fake echoes wrong provider
      const badProviderBin = path.join(dir, 'fake-wrong-provider');
      await writeFile(
        badProviderBin,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
const out = args[args.indexOf('--output') + 1];
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'x\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), '');
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  provider: 'WRONG',
  model: {
    requested: req.model != null ? req.model : null,
    resolved: { availability: 'available', value: 'TEMPTING-MODEL' }
  },
  outcome: { kind: 'success', reasonCode: 'ok' }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(badProviderBin, 0o755);

      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const badProv = await invokePoeticAdapter({
        poeticBin: badProviderBin,
        requestPath: path.join(dir, 'req-p.json'),
        outputPath: path.join(dir, 'out-p.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'id-p',
          provider: 'openai',
          model: 'gpt-test',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(badProv.success, false);
      assert.equal(badProv.parsedOutput, null);
      assert.match(String(badProv.infraFailure), /provider mismatch/i);
      assert.equal(badProv.providerRawEvidence, 'unavailable');

      // Fake echoes wrong model.requested
      const badModelBin = path.join(dir, 'fake-wrong-model');
      await writeFile(
        badModelBin,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
const out = args[args.indexOf('--output') + 1];
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'x\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), '');
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  provider: req.provider,
  model: {
    requested: 'NOT-THE-REQUESTED-MODEL',
    resolved: { availability: 'available', value: 'TEMPTING-MODEL' }
  },
  outcome: { kind: 'success', reasonCode: 'ok' }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(badModelBin, 0o755);

      const badModel = await invokePoeticAdapter({
        poeticBin: badModelBin,
        requestPath: path.join(dir, 'req-m.json'),
        outputPath: path.join(dir, 'out-m.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'id-m',
          provider: 'openai',
          model: 'gpt-test',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(badModel.success, false);
      assert.equal(badModel.parsedOutput, null);
      assert.match(String(badModel.infraFailure), /model\.requested mismatch/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
