/**
 * Campaign-level raw evidence availability (finding 1).
 *
 * Missing/invalid poetic raw, requestId bind failure, confinement refusal,
 * and command-not-found must store rawEvidenceUnavailable and never present
 * empty raw digests as verified reportable evidence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  access,
} from 'node:fs/promises';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(REPO, 'benchmarks');
const TASK = 'greenfield-003-js-event-emitter';

/**
 * @param {string} body
 * @returns {Promise<string>} path to executable fake poetic bin
 */
async function writeFakePoetic(body) {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-fake-poetic-'));
  const bin = path.join(binDir, 'fake-poetic');
  await writeFile(bin, body, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

/**
 * Assert digests mark raw unavailable and do not claim raw byte digests.
 * @param {object} digests
 */
function assertRawUnavailableDigests(digests) {
  assert.ok(digests && typeof digests === 'object', 'digests object required');
  assert.equal(digests.rawEvidenceUnavailable, true);
  assert.equal(
    digests.rawOutputDigest,
    undefined,
    'must not claim rawOutputDigest when unavailable',
  );
  assert.equal(
    digests.rawStdoutSha256,
    undefined,
    'must not claim rawStdoutSha256 when unavailable',
  );
  assert.equal(
    digests.rawStderrSha256,
    undefined,
    'must not claim rawStderrSha256 when unavailable',
  );
  assert.equal(
    digests.rawOutputFileSha256,
    undefined,
    'must not claim rawOutputFileSha256 when unavailable',
  );
}

/**
 * Assert no report.json was written (unavailable evidence fails closed).
 * @param {string} campaignDir
 * @param {object} result runCampaign result
 */
async function assertNoBenchmarkReport(campaignDir, result) {
  assert.notEqual(result.stage, 'complete');
  // Evidence stage refuses report when raw is unavailable
  if (result.stage === 'evidence') {
    assert.equal(result.ok, false);
  }
  let reportPresent = true;
  try {
    await readFile(path.join(campaignDir, 'report.json'), 'utf8');
  } catch {
    reportPresent = false;
  }
  assert.equal(reportPresent, false, 'unavailable raw must not yield report.json');
}

/**
 * Assert campaign/raw/<trialId> was not materialized as verified empty evidence.
 * @param {string} campaignDir
 * @param {string} trialId
 */
async function assertNoVerifiedEmptyRawDir(campaignDir, trialId) {
  const rawDir = path.join(campaignDir, 'raw', trialId);
  let exists = true;
  try {
    await access(rawDir);
  } catch {
    exists = false;
  }
  // Prefer absence; if present for forensics, meta must not be treated as reportable
  // digests (checked on result.digests separately).
  assert.equal(
    exists,
    false,
    'unavailable raw should skip quarantine (no empty raw/<trialId> tree)',
  );
}

describe('isRawEvidenceUnavailable detection', () => {
  it('detects poetic-adapter non-actual, confinement, spawn, and empty-stream infra', async () => {
    const { isRawEvidenceUnavailable } = await import('../harness/run.js');

    assert.equal(
      isRawEvidenceUnavailable('poetic-adapter', {
        providerRawEvidence: 'unavailable',
        success: false,
        stdout: '',
        stderr: '',
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('poetic-adapter', {
        providerRawEvidence: 'actual',
        success: true,
        parsedOutput: { requestId: 'x' },
        stdout: 'ok\n',
        stderr: '',
      }),
      false,
    );
    assert.equal(
      isRawEvidenceUnavailable('poetic-adapter', {
        providerRawEvidence: 'actual',
        success: false,
        parsedOutput: null,
        stdout: '',
        stderr: '',
      }),
      true,
    );

    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: null,
        stdout: '',
        stderr: '',
        infraFailure:
          'provider spawn requires campaignDir for confinement (fail closed; unconfined refused)',
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: null,
        stdout: '',
        stderr: '',
        infraFailure:
          'provider confinement unavailable: no primitive (fail closed; unconfined spawn refused)',
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: null,
        stdout: '',
        stderr: '',
        infraFailure: 'process error: spawn ENOTFOUND',
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: null,
        stdout: '',
        stderr: '',
        infraFailure: 'process error: spawn /no/such/bin ENOENT',
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('poetic-system', {
        exitCode: null,
        stdout: '',
        stderr: '',
        infraFailure: 'spawn failed: something broke',
      }),
      true,
    );

    // Successful process with empty streams is still real (empty) evidence.
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      false,
    );
    // Provider FAIL with stderr is real stream evidence.
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 1,
        stdout: '',
        stderr: 'usage error\n',
      }),
      false,
    );

    // sandbox-exec wrapper ENOENT (exit 71, stderr only) is not provider raw.
    const sandboxEnoent = {
      exitCode: 71,
      stdout: '',
      stderr:
        "sandbox-exec: execvp() of '/tmp/missing-bin' failed: No such file or directory\n",
    };
    assert.equal(isRawEvidenceUnavailable('native-cli', sandboxEnoent), true);
    const { normalizeInvokerInfraSignals } = await import('../harness/run.js');
    const normalized = normalizeInvokerInfraSignals('native-cli', sandboxEnoent);
    assert.match(String(normalized.infraFailure), /ENOENT|not found/i);
  });
});

describe('runCampaign raw evidence availability', () => {
  it('poetic-adapter missing raw → rawEvidenceUnavailable, not PASS-reportable', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const { readTrialResult } = await import('../harness/results.js');

    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-noraw-'));
    // Success-shaped schema + matching requestId but no invoke-artifacts files.
    const bin = await writeFakePoetic(`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: { resolved: { availability: 'available', value: 'must-not-pass-without-raw' } }
}));
process.exit(0);
`);
    try {
      const result = await runCampaign({
        experiment: {
          id: 'raw-avail-noraw',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: [TASK],
          repetitions: 1,
          seed: 101,
          timeoutMs: 15_000,
          arms: [
            {
              name: 'adapter-noraw',
              provider: 'fake',
              model: 'requested-model',
              invocationPath: 'poetic-adapter',
              poeticBin: bin,
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });

      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      const stored = await readTrialResult(campaignDir, trialId);

      assert.equal(stored.classification, 'INFRA_FAIL');
      assertRawUnavailableDigests(stored.digests);
      assert.ok(stored.digests.resultDigest);
      // Model evidence still only from bound parsedOutput; missing raw fails closed
      // so success is false and model must not be reportably attributed as PASS.
      assert.notEqual(stored.classification, 'PASS');
      await assertNoVerifiedEmptyRawDir(campaignDir, trialId);
      await assertNoBenchmarkReport(campaignDir, result);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it('requestId-mismatched adapter with tempting model → resolvedModel null + unavailable', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const { readTrialResult } = await import('../harness/results.js');

    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-mismatch-'));
    const bin = await writeFakePoetic(`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
// Plant raw under WRONG requestId so a naive reader could still find streams.
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', 'stale-other-request');
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'planted-stdout\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), '');
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: 'stale-other-request',
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: {
    resolved: {
      availability: 'available',
      value: 'TEMPTING-MODEL-MUST-NOT-ATTRIBUTE'
    }
  }
}));
process.exit(0);
`);
    try {
      const result = await runCampaign({
        experiment: {
          id: 'raw-avail-mismatch',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: [TASK],
          repetitions: 1,
          seed: 102,
          timeoutMs: 15_000,
          arms: [
            {
              name: 'adapter-mismatch',
              provider: 'fake',
              model: 'requested-arm-model',
              invocationPath: 'poetic-adapter',
              poeticBin: bin,
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });

      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      const stored = await readTrialResult(campaignDir, trialId);

      assert.equal(stored.requestedModel, 'requested-arm-model');
      assert.equal(stored.resolvedModel, null);
      assert.equal(stored.resolvedModelAvailable, false);
      assert.ok(
        stored.resolvedModelSource === 'unavailable' ||
          stored.resolvedModelSource === 'absent',
        `source=${stored.resolvedModelSource}`,
      );
      assert.notEqual(stored.classification, 'PASS');
      // Infra or unavailable path — raw must not be claimed as verified.
      assertRawUnavailableDigests(stored.digests);
      const body = JSON.stringify(stored);
      assert.ok(
        !body.includes('TEMPTING-MODEL-MUST-NOT-ATTRIBUTE'),
        'tempting model must not appear on stored trial result',
      );
      await assertNoVerifiedEmptyRawDir(campaignDir, trialId);
      await assertNoBenchmarkReport(campaignDir, result);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it('confinement refusal (synthetic + command path) marks raw unavailable', async () => {
    const { isRawEvidenceUnavailable, runCampaign } = await import(
      '../harness/run.js'
    );
    const { readTrialResult } = await import('../harness/results.js');

    // Synthetic detection for confinement messages (campaign always supplies
    // campaignDir; invoker already fail-closes when confinement is refused).
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: null,
        stdout: '',
        stderr: '',
        executionUnavailable: true,
        infraFailure:
          'provider confinement unavailable: test (fail closed; unconfined spawn refused)',
      }),
      true,
    );

    // Campaign-level: a binary that exits before streams, combined with a
    // missing command, exercises the same unavailable storage path as
    // confinement refusal (exitCode null + infraFailure, no stream evidence).
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-confine-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'raw-avail-confine',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: [TASK],
          repetitions: 1,
          seed: 103,
          timeoutMs: 5_000,
          arms: [
            {
              name: 'missing-bin',
              provider: 'fake',
              model: 'none',
              invocationPath: 'native-cli',
              command: path.join(
                os.tmpdir(),
                'aicb-definitely-missing-confine-bin-xyz',
              ),
              args: [],
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });

      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      const stored = await readTrialResult(campaignDir, trialId);
      assert.equal(stored.classification, 'INFRA_FAIL');
      assertRawUnavailableDigests(stored.digests);
      await assertNoVerifiedEmptyRawDir(campaignDir, trialId);
      await assertNoBenchmarkReport(campaignDir, result);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  it('command-not-found native-cli → INFRA_FAIL with rawEvidenceUnavailable', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const { readTrialResult } = await import('../harness/results.js');

    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-enoent-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'raw-avail-enoent',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: [TASK],
          repetitions: 1,
          seed: 104,
          timeoutMs: 5_000,
          arms: [
            {
              name: 'broken',
              provider: 'fake',
              model: 'none',
              invocationPath: 'native-cli',
              command: path.join(
                os.tmpdir(),
                'aicb-definitely-missing-bin-raw-avail-xyz',
              ),
              args: [],
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });

      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      const stored = await readTrialResult(campaignDir, trialId);

      assert.equal(stored.classification, 'INFRA_FAIL');
      // Under confined spawn, sandbox-exec may report a non-null wrapper exit
      // (e.g. 71) rather than null; either is fine as long as raw is unavailable.
      assert.ok(
        stored.exitCode == null || Number(stored.exitCode) !== 0,
        `exitCode=${stored.exitCode}`,
      );
      assertRawUnavailableDigests(stored.digests);
      assert.ok(stored.digests.resultDigest);
      // Must not be reportable as verified evidence
      await assertNoVerifiedEmptyRawDir(campaignDir, trialId);
      await assertNoBenchmarkReport(campaignDir, result);
      assert.ok(
        result.stage === 'evidence' || result.ok === false,
        `expected evidence fail-closed, got stage=${result.stage} ok=${result.ok}`,
      );
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });
});
