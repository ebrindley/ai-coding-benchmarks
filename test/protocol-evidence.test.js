/**
 * Neutral protocol evidence: outcomeKind/reasonCode persistence, fail-closed
 * verify for reportable build-adapter records, sanitized export (no raw text),
 * and chunk-boundary capture fidelity.
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
} from 'node:fs/promises';
import {
  completeTrialResult,
  completeManifestTrial,
  writeCompleteTrial,
} from './helpers/complete-trial.js';

/**
 * @param {string} campaign
 * @param {object} extras
 */
async function seedReportableBuildTrial(campaign, extras = {}) {
  const {
    quarantineRawOutput,
    writeTrialResult,
    buildTrialDigests,
    computeArtifactDigest,
    PROTOCOL_EVIDENCE_VERSION,
    PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
  } = await import('../harness/results.js');

  const trialId = extras.id ?? 't-proto';
  const q = await quarantineRawOutput(campaign, trialId, {
    stdout: extras.stdout ?? 'provider-stdout\n',
    stderr: extras.stderr ?? '',
  });
  const artDir = path.join(campaign, 'artifacts', trialId);
  await mkdir(artDir, { recursive: true });
  await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
  const artDig = await computeArtifactDigest(artDir);

  const posture = 'b'.repeat(64);
  const frozen = completeManifestTrial({
    id: trialId,
    experimentId: 'exp-proto',
    invocationPath: 'build-adapter',
    postureFingerprint: posture,
    state: extras.state ?? 'completed',
    requestedModel: extras.requestedModel ?? 'm-req',
  });

  const protocol =
    extras.omitProtocol === true
      ? {}
      : {
          outcomeKind: extras.outcomeKind ?? 'success',
          reasonCode: extras.reasonCode ?? 'SUCCESS',
          protocolEvidenceVersion:
            extras.protocolEvidenceVersion ?? PROTOCOL_EVIDENCE_VERSION,
          protocolSchema:
            extras.protocolSchema ?? PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
        };

  const written = await writeTrialResult(
    campaign,
    trialId,
    completeTrialResult({
      id: trialId,
      experimentId: 'exp-proto',
      invocationPath: 'build-adapter',
      postureFingerprint: posture,
      requestedModel: extras.requestedModel ?? 'm-req',
      state: extras.state ?? 'completed',
      classification: extras.classification ?? 'PASS',
      // Preserve explicit null transport exit (timeout / never-exited).
      exitCode: Object.prototype.hasOwnProperty.call(extras, 'exitCode')
        ? extras.exitCode
        : 0,
      digests: buildTrialDigests({
        artifactDigest: artDig,
        ...q.digests,
      }),
      ...protocol,
      ...(extras.resultExtras || {}),
    }),
    { manifestTrial: frozen },
  );

  return { trialId, frozen, result: written.result, artDir };
}

describe('protocol evidence extract + persist shape', () => {
  it('extractProtocolEvidence stamps versioned build fields; ignores free-form', async () => {
    const {
      extractProtocolEvidence,
      PROTOCOL_EVIDENCE_VERSION,
      PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
    } = await import('../harness/results.js');

    const success = extractProtocolEvidence('build-adapter', {
      outcomeKind: 'success',
      reasonCode: 'SUCCESS',
      exitCode: 0,
    });
    assert.deepEqual(success, {
      outcomeKind: 'success',
      reasonCode: 'SUCCESS',
      protocolEvidenceVersion: PROTOCOL_EVIDENCE_VERSION,
      protocolSchema: PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
    });

    const modelUnresolved = extractProtocolEvidence('build-adapter', {
      outcomeKind: 'provider_error',
      reasonCode: 'MODEL_UNRESOLVED',
      exitCode: 0,
      // Free-form must never flow into protocol fields
      providerFailure: 'secret dump Authorization: Bearer sk-test',
    });
    assert.equal(modelUnresolved.outcomeKind, 'provider_error');
    assert.equal(modelUnresolved.reasonCode, 'MODEL_UNRESOLVED');
    assert.equal(
      modelUnresolved.protocolSchema,
      PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
    );
    assert.ok(!JSON.stringify(modelUnresolved).includes('Bearer'));
    assert.ok(!JSON.stringify(modelUnresolved).includes('sk-test'));

    const timeout = extractProtocolEvidence('build-adapter', {
      outcomeKind: 'timeout',
      reasonCode: 'PROVIDER_TIMEOUT',
      exitCode: null,
    });
    assert.equal(timeout.outcomeKind, 'timeout');
    assert.equal(timeout.reasonCode, 'PROVIDER_TIMEOUT');

    const freeFormDropped = extractProtocolEvidence('build-adapter', {
      outcomeKind: 'provider said nope with spaces',
      reasonCode: 'free form secret=hunter2',
    });
    assert.deepEqual(freeFormDropped, {});

    const empty = extractProtocolEvidence('build-adapter', {
      exitCode: 1,
      success: false,
    });
    assert.deepEqual(empty, {});

    const native = extractProtocolEvidence('native-cli', {
      outcomeKind: 'success',
      reasonCode: 'SUCCESS',
    });
    assert.equal(native.outcomeKind, 'success');
    assert.equal(native.reasonCode, 'SUCCESS');
    assert.equal(native.protocolSchema, null);
  });
});

describe('protocol evidence verify fail-closed', () => {
  it('rejects hidden capability misses while respecting refusal and gate precedence', async () => {
    const { verifyTrialEvidenceDigests } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-classification-'));
    try {
      const cases = [
        { id: 'hidden-gate-fail', classification: 'PASS', resultExtras: { changedFileCount: 1, gateResults: [{ gate: 'tests', status: 'failed', required: true, exitCode: 1 }] }, ok: false },
        { id: 'hidden-no-op', classification: 'PASS', resultExtras: { changedFileCount: 0 }, ok: false },
        { id: 'unknown-change-count', classification: 'PASS', resultExtras: { changedFileCount: null }, ok: false },
        { id: 'model-unresolved', outcomeKind: 'refusal', reasonCode: 'MODEL_UNRESOLVED', classification: 'INFRA_FAIL', resultExtras: { changedFileCount: 0 }, ok: true },
        { id: 'provider-not-ready', outcomeKind: 'refusal', reasonCode: 'NOT_READY', classification: 'INFRA_FAIL', resultExtras: { changedFileCount: 1 }, ok: true },
        { id: 'refusal-timeout', outcomeKind: 'refusal', reasonCode: 'NOT_READY', classification: 'TIMEOUT', resultExtras: { changedFileCount: 1, gateResults: [{ gate: 'tests', required: true, timedOut: true }] }, ok: true },
        { id: 'accepted-cli-exit', classification: 'PASS', exitCode: 1, resultExtras: { changedFileCount: 1, gateResults: [{ gate: 'tests', required: true, status: 'passed', exitCode: 0 }] }, ok: true },
        // Unstored invoker failures cannot be reconstructed from a clean exit.
        { id: 'unstored-infra', classification: 'INFRA_FAIL', resultExtras: { changedFileCount: 1 }, ok: true },
      ];
      for (const c of cases) {
        const { frozen, result } = await seedReportableBuildTrial(campaign, c);
        const verified = await verifyTrialEvidenceDigests(campaign, c.id, result, { manifestTrial: frozen });
        assert.equal(verified.ok, c.ok, `${c.id}: ${verified.error}`);
        if (!c.ok) assert.ok(verified.mismatches.includes('classification:established-outcome'), c.id);
      }
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('adopts a clean unavailable terminal record without scoring it or ignoring tampering', async () => {
    const { tryAdoptDurableTrialResult, verifyCampaignEvidenceDigests, buildTrialDigests } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-terminal-unavailable-'));
    try {
      const frozen = completeManifestTrial({ id: 'unavailable', invocationPath: 'build-adapter', state: 'failed' });
      const { result } = await writeCompleteTrial(campaign, frozen.id, {
        invocationPath: 'build-adapter', state: 'failed', classification: 'INFRA_FAIL',
        digests: buildTrialDigests({ rawEvidenceUnavailable: true }),
      }, { manifestTrial: frozen });
      const adopted = await tryAdoptDurableTrialResult(campaign, { ...frozen, state: 'running' });
      assert.equal(adopted.ok, true, adopted.reason);
      assert.equal(adopted.state, 'failed');
      const check = await verifyCampaignEvidenceDigests(campaign, [frozen], [result], { failOnUnavailable: false });
      assert.equal(check.ok, true, check.error);
      assert.equal(check.unavailable, 1);
      assert.deepEqual(check.reportableResults, []);
      const allUnavailable = await verifyCampaignEvidenceDigests(campaign, [frozen], [result]);
      assert.equal(allUnavailable.ok, false);
      const sibling = await seedReportableBuildTrial(campaign, { id: 'reportable' });
      const partial = await verifyCampaignEvidenceDigests(campaign, [frozen, sibling.frozen], [result, sibling.result]);
      assert.equal(partial.ok, true, partial.error);
      assert.equal(partial.unavailable, 1);
      assert.equal(partial.verified, 1);
      assert.deepEqual(partial.reportableResults.map((r) => r.id), ['reportable']);
      const damaged = { ...result, classificationReason: 'changed after write' };
      const rejected = await verifyCampaignEvidenceDigests(campaign, [frozen, sibling.frozen], [damaged, sibling.result]);
      assert.equal(rejected.ok, false);
      assert.ok(rejected.failures[0].mismatches.includes('resultDigest'));
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('reportable build-adapter success/timeout/provider_error/MODEL_UNRESOLVED verify', async () => {
    const { verifyTrialEvidenceDigests } = await import(
      '../harness/results.js'
    );
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-ok-'));
    try {
      const cases = [
        {
          id: 't-success',
          outcomeKind: 'success',
          reasonCode: 'SUCCESS',
          classification: 'PASS',
          exitCode: 0,
        },
        {
          id: 't-timeout',
          outcomeKind: 'timeout',
          reasonCode: 'PROVIDER_TIMEOUT',
          classification: 'TIMEOUT',
          state: 'failed',
          exitCode: null,
        },
        {
          id: 't-provider',
          outcomeKind: 'provider_error',
          reasonCode: 'PROVIDER_ERROR',
          classification: 'INFRA_FAIL',
          state: 'failed',
          exitCode: 0,
        },
        {
          id: 't-model',
          outcomeKind: 'provider_error',
          reasonCode: 'MODEL_UNRESOLVED',
          classification: 'INFRA_FAIL',
          state: 'failed',
          exitCode: 0,
        },
      ];

      for (const c of cases) {
        const { frozen, result } = await seedReportableBuildTrial(campaign, c);
        const v = await verifyTrialEvidenceDigests(
          campaign,
          c.id,
          result,
          { manifestTrial: frozen },
        );
        assert.equal(v.ok, true, `${c.id}: ${v.error}`);
        assert.equal(v.reportable, true, c.id);
        assert.equal(result.outcomeKind, c.outcomeKind);
        assert.equal(result.reasonCode, c.reasonCode);
        assert.equal(result.exitCode, c.exitCode);
        // Transport exit is independent of outcome kind
        if (c.outcomeKind === 'provider_error') {
          assert.equal(result.exitCode, 0);
        }
      }
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('reportable build-adapter without protocol fields fails closed', async () => {
    const {
      verifyTrialEvidenceDigests,
      collectProtocolEvidenceIssues,
      claimsBuildAdapterProtocolEvidence,
    } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-miss-'));
    try {
      const { frozen, result } = await seedReportableBuildTrial(campaign, {
        id: 't-old',
        omitProtocol: true,
      });
      assert.equal(claimsBuildAdapterProtocolEvidence(result), true);
      const issues = collectProtocolEvidenceIssues(result);
      assert.ok(issues.includes('outcomeKind'));
      assert.ok(issues.includes('reasonCode'));
      assert.ok(issues.includes('protocolEvidenceVersion'));
      assert.ok(issues.includes('protocolSchema'));

      const v = await verifyTrialEvidenceDigests(campaign, 't-old', result, {
        manifestTrial: frozen,
      });
      assert.equal(v.ok, false);
      assert.equal(v.reportable, false);
      assert.ok(v.mismatches.some((m) => String(m).startsWith('protocol:')));
      assert.match(String(v.error), /protocol evidence/i);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('raw-unavailable build-adapter does not require protocol fields (back-compat soft path)', async () => {
    const { verifyTrialEvidenceDigests, buildTrialDigests } = await import(
      '../harness/results.js'
    );
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-unavail-'));
    try {
      const frozen = completeManifestTrial({
        id: 't-unavail',
        experimentId: 'exp-proto',
        invocationPath: 'build-adapter',
        state: 'failed',
      });
      const { result } = await writeCompleteTrial(
        campaign,
        't-unavail',
        {
          experimentId: 'exp-proto',
          invocationPath: 'build-adapter',
          state: 'failed',
          classification: 'INFRA_FAIL',
          digests: buildTrialDigests({ rawEvidenceUnavailable: true }),
        },
        { manifestTrial: frozen },
      );
      const v = await verifyTrialEvidenceDigests(campaign, 't-unavail', result, {
        manifestTrial: frozen,
      });
      assert.equal(v.ok, false);
      assert.equal(v.unavailable, true);
      assert.equal(v.reportable, false);
      assert.ok(!v.mismatches.some((m) => String(m).startsWith('protocol:')));
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('native-cli reportable records do not require build protocol fields', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      buildTrialDigests,
      computeArtifactDigest,
      verifyTrialEvidenceDigests,
    } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-native-'));
    try {
      const trialId = 't-native';
      const q = await quarantineRawOutput(campaign, trialId, {
        stdout: 'ok\n',
        stderr: '',
      });
      const artDir = path.join(campaign, 'artifacts', trialId);
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const artDig = await computeArtifactDigest(artDir);
      const frozen = completeManifestTrial({
        id: trialId,
        experimentId: 'exp-native',
        invocationPath: 'native-cli',
      });
      const { result } = await writeTrialResult(
        campaign,
        trialId,
        completeTrialResult({
          id: trialId,
          experimentId: 'exp-native',
          invocationPath: 'native-cli',
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        }),
        { manifestTrial: frozen },
      );
      const v = await verifyTrialEvidenceDigests(campaign, trialId, result, {
        manifestTrial: frozen,
      });
      assert.equal(v.ok, true, v.error);
      assert.equal(v.reportable, true);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });
});

describe('protocol evidence sanitized export', () => {
  it('export keeps bounded protocol fields; strips free-form provider text', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const {
      PROTOCOL_EVIDENCE_VERSION,
      PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-export-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-proto-export-out-'));
    try {
      const { trialId, frozen } = await seedReportableBuildTrial(campaign, {
        id: 't1',
        outcomeKind: 'provider_error',
        reasonCode: 'MODEL_UNRESOLVED',
        classification: 'INFRA_FAIL',
        state: 'failed',
        exitCode: 0,
        resultExtras: {
          classificationReason:
            'invoker infra failure: provider said Authorization: Bearer sk-leaked-token',
          error: 'Connection refused cookie=session-secret',
        },
      });

      const now = new Date().toISOString();
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'proto-export',
          schemaVersion: 1,
          status: 'completed',
          experimentId: 'exp-proto',
          lock: { held: false, owner: null },
          host: { user: 'localuser', platform: 'darwin' },
          trials: [{ ...frozen, state: 'failed' }],
          createdAt: now,
          updatedAt: now,
        }),
        'utf8',
      );

      await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: false,
      });

      const body = await readFile(
        path.join(out, 'results', trialId, 'result.json'),
        'utf8',
      );
      const parsed = JSON.parse(body);

      assert.equal(parsed.outcomeKind, 'provider_error');
      assert.equal(parsed.reasonCode, 'MODEL_UNRESOLVED');
      assert.equal(parsed.protocolEvidenceVersion, PROTOCOL_EVIDENCE_VERSION);
      assert.equal(
        parsed.protocolSchema,
        PROTOCOL_SCHEMA_BUILD_INVOKE_RESULT_V1,
      );
      assert.equal(parsed.exitCode, 0);
      // Free-form stripped
      assert.equal(parsed.classificationReason, undefined);
      assert.equal(parsed.error, undefined);
      assert.ok(!body.includes('Bearer'));
      assert.ok(!body.includes('sk-leaked'));
      assert.ok(!body.includes('cookie=session'));
      assert.ok(!body.includes('provider-stdout'));
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('chunk-boundary capture fidelity', () => {
  it('spawnRaw preserves multi-byte UTF-8 split across write chunks', async () => {
    const { spawnRaw } = await import(
      '../harness/invokers/spawn-controlled.js'
    );

    // Emit a 4-byte emoji (U+1F680 🚀) as two 2-byte TCP-style flushes via
    // two sequential writes of partial UTF-8 so a naive per-chunk decoder
    // would corrupt. Joined Buffer decode must recover the character.
    const rocket = Buffer.from('🚀', 'utf8');
    assert.equal(rocket.length, 4);
    const half1 = rocket.subarray(0, 2);
    const half2 = rocket.subarray(2, 4);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-utf8-'));
    try {
      const script = path.join(dir, 'emit-split.js');
      await writeFile(
        script,
        `#!/usr/bin/env node
const h1 = Buffer.from([${[...half1].join(',')}]);
const h2 = Buffer.from([${[...half2].join(',')}]);
process.stdout.write(h1);
setImmediate(() => {
  process.stdout.write(h2);
  process.stdout.write(Buffer.from('ok', 'utf8'));
  process.exit(0);
});
`,
        'utf8',
      );

      const result = await spawnRaw({
        command: process.execPath,
        args: [script],
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stdout, '🚀ok');
      assert.ok(Buffer.isBuffer(result.stdoutBytes));
      assert.deepEqual(
        result.stdoutBytes,
        Buffer.concat([rocket, Buffer.from('ok', 'utf8')]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ingestProviderRawEvidence retains exact file bytes for quarantine', async () => {
    const { ingestProviderRawEvidence, expectedProviderRawPaths } =
      await import('../harness/invokers/build-adapter.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-bytes-'));
    try {
      const outputPath = path.join(dir, 'output.json');
      await writeFile(outputPath, '{}\n', 'utf8');
      const requestId = 'req-bytes-1';
      const paths = expectedProviderRawPaths(outputPath, requestId);
      assert.ok(!('error' in paths));
      await mkdir(path.dirname(paths.stdoutPath), { recursive: true });
      // Valid multi-byte + a deliberate invalid UTF-8 sequence
      const rawStdout = Buffer.from([0xe2, 0x9c, 0x93, 0xff, 0xfe, 0x41]);
      const rawStderr = Buffer.from('err-€\n', 'utf8');
      await writeFile(paths.stdoutPath, rawStdout);
      await writeFile(paths.stderrPath, rawStderr);

      const ing = await ingestProviderRawEvidence(outputPath, requestId);
      assert.equal(ing.ok, true);
      assert.ok(Buffer.isBuffer(ing.stdoutBytes));
      assert.deepEqual(ing.stdoutBytes, rawStdout);
      assert.deepEqual(ing.stderrBytes, rawStderr);
      // String view may replace invalid bytes — documented limitation
      assert.equal(typeof ing.stdout, 'string');
      assert.ok(ing.stdout.includes('A'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
