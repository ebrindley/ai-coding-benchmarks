/**
 * Exact input/evidence binding: raw byte digests, tamper fail-closed,
 * pre-export/report verification.
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
  writeCompleteTrial,
  completeTrialResult,
  completeManifestTrial,
} from './helpers/complete-trial.js';

describe('digest evidence binding + tamper', () => {
  it('quarantine hashes exact raw stdout/stderr/output bytes (not lengths)', async () => {
    const {
      quarantineRawOutput,
      computeRawOutputDigests,
    } = await import('../harness/results.js');
    const { sha256Buffer, digestRawOutputBytes } = await import(
      '../harness/digest.js'
    );

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-digest-'));
    try {
      const stdout = 'SECRET_STDOUT_BODY\nline2\n';
      const stderr = 'err-bytes\n';
      const art = path.join(campaign, 'artifacts', 't1');
      await mkdir(art, { recursive: true });
      const outputPath = path.join(art, 'output.json');
      await writeFile(outputPath, '{"ok":true,"n":1}\n', 'utf8');

      const q = await quarantineRawOutput(campaign, 't1', {
        stdout,
        stderr,
        outputPath,
      });

      assert.ok(q.digests);
      assert.match(q.digests.rawStdoutSha256, /^[a-f0-9]{64}$/);
      assert.match(q.digests.rawStderrSha256, /^[a-f0-9]{64}$/);
      assert.match(q.digests.rawOutputFileSha256, /^[a-f0-9]{64}$/);
      assert.match(q.digests.rawOutputDigest, /^[a-f0-9]{64}$/);

      assert.equal(q.digests.rawStdoutSha256, sha256Buffer(stdout));
      assert.equal(q.digests.rawStderrSha256, sha256Buffer(stderr));
      assert.equal(
        q.digests.rawOutputFileSha256,
        sha256Buffer(await readFile(outputPath)),
      );
      assert.equal(
        q.digests.rawOutputDigest,
        digestRawOutputBytes({
          stdout,
          stderr,
          output: await readFile(outputPath),
        }),
      );

      // Length-only envelope must not equal byte digest
      const lengthOnly = digestRawOutputBytes({
        stdout: String(stdout.length),
        stderr: String(stderr.length),
      });
      assert.notEqual(q.digests.rawOutputDigest, lengthOnly);

      const recomputed = await computeRawOutputDigests(campaign, 't1');
      assert.equal(recomputed.rawOutputDigest, q.digests.rawOutputDigest);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('mutate raw stdout after write → evidence verification fails', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      verifyTrialEvidenceDigests,
      buildTrialDigests,
      computeResultDigest,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-tamper-raw-'));
    try {
      const q = await quarantineRawOutput(campaign, 'trial-a', {
        stdout: 'original-stdout\n',
        stderr: 'e\n',
      });
      const artDir = path.join(campaign, 'artifacts', 'trial-a');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest } = await import('../harness/results.js');
      const artDig = await computeArtifactDigest(artDir);
      const digests = buildTrialDigests({
        resultDigest: computeResultDigest({
          classification: 'PASS',
          gateResults: [],
          exitCode: 0,
        }),
        artifactDigest: artDig,
        ...q.digests,
      });
      const { manifestTrial: frozenA } = await writeCompleteTrial(
        campaign,
        'trial-a',
        {
          id: 'trial-a',
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          artifactDir: artDir,
          digests,
        },
      );

      const ok = await verifyTrialEvidenceDigests(campaign, 'trial-a', null, {
        manifestTrial: frozenA,
      });
      assert.equal(ok.ok, true);

      // Tamper on-disk raw stdout
      await writeFile(
        path.join(campaign, 'raw', 'trial-a', 'stdout.txt'),
        'TAMPERED\n',
        'utf8',
      );

      const bad = await verifyTrialEvidenceDigests(campaign, 'trial-a', null, {
        manifestTrial: frozenA,
      });
      assert.equal(bad.ok, false);
      assert.ok(bad.mismatches.includes('rawOutputDigest'));
      assert.match(String(bad.error), /fail closed|mismatch/i);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('mutate stored result digests → verification fail closed', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      readTrialResult,
      verifyTrialEvidenceDigests,
      buildTrialDigests,
      computeResultDigest,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-tamper-dig-'));
    try {
      const q = await quarantineRawOutput(campaign, 'trial-b', {
        stdout: 'body\n',
      });
      const artDir = path.join(campaign, 'artifacts', 'trial-b');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest } = await import('../harness/results.js');
      const artDig = await computeArtifactDigest(artDir);
      const { manifestTrial: frozenB } = await writeCompleteTrial(
        campaign,
        'trial-b',
        {
          id: 'trial-b',
          classification: 'FAIL',
          exitCode: 1,
          gateResults: [],
          artifactDir: artDir,
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        },
      );

      // Mutate digests in result.json while leaving raw bytes intact
      const result = await readTrialResult(campaign, 'trial-b');
      result.digests = {
        ...result.digests,
        rawOutputDigest: '0'.repeat(64),
        rawStdoutSha256: '1'.repeat(64),
      };
      await writeFile(
        path.join(campaign, 'results', 'trial-b', 'result.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8',
      );

      const bad = await verifyTrialEvidenceDigests(campaign, 'trial-b', result, {
        manifestTrial: frozenB,
      });
      assert.equal(bad.ok, false);
      assert.ok(
        bad.mismatches.includes('rawOutputDigest') ||
          bad.mismatches.includes('rawStdoutSha256'),
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('export fail-closed when digests mismatch; ok when consistent', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      buildTrialDigests,
    } = await import('../harness/results.js');
    const { exportSanitizedBundle } = await import('../harness/export.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-ev-'));
    const outOk = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-ok-'));
    const outBad = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-bad-'));
    try {
      const {
        computeResultDigest,
      } = await import('../harness/results.js');
      const q = await quarantineRawOutput(campaign, 't1', {
        stdout: 'export-raw\n',
        stderr: '',
      });
      const artDir = path.join(campaign, 'artifacts', 't1');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest: cad } = await import('../harness/results.js');
      const artDig = await cad(artDir);
      const frozenT1 = completeManifestTrial({ id: 't1', state: 'completed' });
      await writeCompleteTrial(
        campaign,
        't1',
        {
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          artifactDir: artDir,
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        },
        { manifestTrial: frozenT1 },
      );
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'completed',
          lock: { held: false, owner: null },
          trials: [frozenT1],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      // Consistent evidence exports
      const ok = await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: outOk,
        includeRaw: false,
      });
      assert.ok(ok);

      // Tamper raw then export must fail closed
      await writeFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'changed\n',
        'utf8',
      );
      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: campaign,
            outDir: outBad,
            includeRaw: false,
          }),
        /digest mismatch|fail closed|evidence integrity/i,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(outOk, { recursive: true, force: true });
      await rm(outBad, { recursive: true, force: true });
    }
  });

  it('campaign evidence verify fails closed on digest mismatch', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      buildTrialDigests,
      computeResultDigest,
      verifyCampaignEvidenceDigests,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-ev-'));
    try {
      const q = await quarantineRawOutput(campaign, 't1', {
        stdout: 'x\n',
        stderr: '',
      });
      const artDir = path.join(campaign, 'artifacts', 't1');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest: cad2 } = await import('../harness/results.js');
      const artDig = await cad2(artDir);
      const frozenT1 = completeManifestTrial({ id: 't1', state: 'completed' });
      await writeCompleteTrial(
        campaign,
        't1',
        {
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          artifactDir: artDir,
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        },
        { manifestTrial: frozenT1 },
      );

      const good = await verifyCampaignEvidenceDigests(campaign, [frozenT1]);
      assert.equal(good.ok, true);
      assert.equal(good.verified, 1);

      await writeFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'y\n',
        'utf8',
      );
      const bad = await verifyCampaignEvidenceDigests(campaign, [frozenT1]);
      assert.equal(bad.ok, false);
      assert.ok(bad.failures.length >= 1);
      assert.match(
        String(bad.error),
        /fail closed|mismatch|integrity failed|rawStdoutSha256|rawOutputDigest/i,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('resultDigest tamper and missing evidence fail closed; infra-without-raw is unavailable', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      buildTrialDigests,
      computeResultDigest,
      verifyTrialEvidenceDigests,
      verifyCampaignEvidenceDigests,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-res-dig-'));
    try {
      const q = await quarantineRawOutput(campaign, 't-good', {
        stdout: 'ok\n',
        stderr: '',
      });
      const goodDigest = computeResultDigest({
        classification: 'PASS',
        gateResults: [],
        exitCode: 0,
      });
      const artDir = path.join(campaign, 'artifacts', 't-good');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest: cad3 } = await import('../harness/results.js');
      const artDig = await cad3(artDir);
      const { manifestTrial: frozenGood } = await writeCompleteTrial(
        campaign,
        't-good',
        {
          id: 't-good',
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          artifactDir: artDir,
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        },
      );

      // Tamper resultDigest only
      const { readTrialResult } = await import('../harness/results.js');
      const r = await readTrialResult(campaign, 't-good');
      r.digests.resultDigest = 'f'.repeat(64);
      await writeFile(
        path.join(campaign, 'results', 't-good', 'result.json'),
        `${JSON.stringify(r, null, 2)}\n`,
        'utf8',
      );
      const tamper = await verifyTrialEvidenceDigests(campaign, 't-good', r, {
        manifestTrial: frozenGood,
      });
      assert.equal(tamper.ok, false);
      assert.ok(tamper.mismatches.includes('resultDigest'));

      // Missing result file for completed trial
      const missing = await verifyCampaignEvidenceDigests(campaign, [
        completeManifestTrial({ id: 'no-such-trial', state: 'completed' }),
      ]);
      assert.equal(missing.ok, false);
      assert.ok(missing.failures.some((f) => f.mismatches.includes('result')));

      // INFRA_FAIL without raw: unavailable (not verified)
      const frozenInfra = completeManifestTrial({
        id: 't-infra',
        state: 'failed',
      });
      await writeCompleteTrial(
        campaign,
        't-infra',
        {
          state: 'failed',
          classification: 'INFRA_FAIL',
          exitCode: null,
          gateResults: [],
          digests: {
            rawEvidenceUnavailable: true,
          },
        },
        { manifestTrial: frozenInfra },
      );
      const infra = await verifyTrialEvidenceDigests(
        campaign,
        't-infra',
        null,
        { manifestTrial: frozenInfra },
      );
      assert.equal(infra.ok, false);
      assert.equal(infra.unavailable, true);
      assert.equal(infra.mismatches.length, 0);

      // Report path (default failOnUnavailable): unavailable fails closed
      const campInfraReport = await verifyCampaignEvidenceDigests(campaign, [
        frozenInfra,
      ]);
      assert.equal(campInfraReport.ok, false);
      assert.equal(campInfraReport.verified, 0);
      assert.equal(campInfraReport.unavailable, 1);
      assert.ok(campInfraReport.failures.some((f) => f.trialId === 't-infra'));

      // Operational classification path may count unavailable without failing
      const campInfraOps = await verifyCampaignEvidenceDigests(
        campaign,
        [frozenInfra],
        undefined,
        { failOnUnavailable: false },
      );
      assert.equal(campInfraOps.ok, true);
      assert.equal(campInfraOps.verified, 0);
      assert.equal(campInfraOps.unavailable, 1);

      // Missing artifactDigest fails closed for reportable trials
      const q2 = await quarantineRawOutput(campaign, 't-no-art', {
        stdout: 'z\n',
        stderr: '',
      });
      const { manifestTrial: frozenNoArt } = await writeCompleteTrial(
        campaign,
        't-no-art',
        {
          id: 't-no-art',
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          digests: buildTrialDigests({
            ...q2.digests,
            // deliberately omit artifactDigest
          }),
        },
      );
      const noArt = await verifyTrialEvidenceDigests(
        campaign,
        't-no-art',
        null,
        { manifestTrial: frozenNoArt },
      );
      assert.equal(noArt.ok, false);
      assert.ok(
        noArt.mismatches.some((m) => m.includes('artifactDigest')),
        String(noArt.mismatches),
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('final-record resultDigest binds complete envelope; fixture authority is independent', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      readTrialResult,
      buildTrialDigests,
      computeFinalResultDigest,
      verifyTrialEvidenceDigests,
      verifyCampaignEvidenceDigests,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-final-dig-'));
    try {
      const q = await quarantineRawOutput(campaign, 't-env', {
        stdout: 'env-out\n',
        stderr: '',
      });
      const artDir = path.join(campaign, 'artifacts', 't-env');
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
      const { computeArtifactDigest } = await import('../harness/results.js');
      const artDig = await computeArtifactDigest(artDir);
      const frozenFixture = 'a'.repeat(64);

      const { result: written, manifestTrial: frozenEnv } =
        await writeCompleteTrial(campaign, 't-env', {
          id: 't-env',
          experimentId: 'exp-1',
          arm: 'arm-a',
          provider: 'p',
          taskId: 'task-1',
          repetition: 1,
          scheduleSeed: 9,
          invocationPath: 'native-cli',
          requestedModel: 'm-req',
          resolvedModel: 'm-res',
          resolvedModelAvailable: true,
          resolvedModelSource: 'invoker-explicit',
          postureFingerprint: 'b'.repeat(64),
          state: 'completed',
          classification: 'PASS',
          classificationReason: 'ok',
          exitCode: 0,
          gateResults: [],
          changedFileCount: 1,
          startedAt: '2026-07-15T00:00:00.000Z',
          finishedAt: '2026-07-15T00:00:01.000Z',
          durationMs: 1000,
          hashes: { fixtureHash: frozenFixture },
          artifactDir: artDir,
          digests: buildTrialDigests({
            artifactDigest: artDig,
            fixtureDigest: frozenFixture,
            ...q.digests,
          }),
        });

      assert.match(written.digests.resultDigest, /^[a-f0-9]{64}$/);
      // Recompute from stored record must match (full envelope, not partial)
      const recomputed = computeFinalResultDigest(written);
      assert.equal(written.digests.resultDigest, recomputed);

      // Identity/model/posture tamper breaks resultDigest
      const onDisk = await readTrialResult(campaign, 't-env');
      onDisk.resolvedModel = 'TAMPERED-MODEL';
      await writeFile(
        path.join(campaign, 'results', 't-env', 'result.json'),
        `${JSON.stringify(onDisk, null, 2)}\n`,
        'utf8',
      );
      const modelTamper = await verifyTrialEvidenceDigests(
        campaign,
        't-env',
        onDisk,
        { manifestTrial: frozenEnv },
      );
      assert.equal(modelTamper.ok, false);
      assert.ok(modelTamper.mismatches.includes('resultDigest'));

      // Restore and check fixture authority vs independent expectedFixtureDigest
      await writeCompleteTrial(
        campaign,
        't-env',
        {
          experimentId: 'exp-1',
          arm: 'arm-a',
          provider: 'p',
          taskId: 'task-1',
          scheduleSeed: 9,
          requestedModel: 'm-req',
          resolvedModel: 'm-res',
          resolvedModelAvailable: true,
          resolvedModelSource: 'invoker-explicit',
          postureFingerprint: 'b'.repeat(64),
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          digests: buildTrialDigests({
            artifactDigest: artDig,
            fixtureDigest: frozenFixture,
            ...q.digests,
          }),
        },
        { manifestTrial: frozenEnv },
      );
      const restored = await readTrialResult(campaign, 't-env');
      const good = await verifyTrialEvidenceDigests(
        campaign,
        't-env',
        restored,
        {
          expectedFixtureDigest: frozenFixture,
          manifestTrial: frozenEnv,
        },
      );
      assert.equal(good.ok, true);

      const badFix = await verifyTrialEvidenceDigests(
        campaign,
        't-env',
        restored,
        {
          expectedFixtureDigest: 'c'.repeat(64),
          manifestTrial: frozenEnv,
        },
      );
      assert.equal(badFix.ok, false);
      assert.ok(badFix.mismatches.includes('fixtureDigest'));

      // Campaign path with frozen trial metadata
      const frozenRow = completeManifestTrial({
        id: 't-env',
        experimentId: 'exp-1',
        arm: 'arm-a',
        provider: 'p',
        taskId: 'task-1',
        scheduleSeed: 9,
        requestedModel: 'm-req',
        postureFingerprint: 'b'.repeat(64),
        state: 'completed',
        expectedFixtureDigest: frozenFixture,
      });
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'completed',
          lock: { held: false, owner: null },
          trials: [frozenRow],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      // Rewrite so frozen identity matches; digests omit null rawOutputFileSha256
      await writeCompleteTrial(
        campaign,
        't-env',
        {
          experimentId: 'exp-1',
          arm: 'arm-a',
          provider: 'p',
          taskId: 'task-1',
          scheduleSeed: 9,
          requestedModel: 'm-req',
          resolvedModel: 'm-res',
          resolvedModelAvailable: true,
          resolvedModelSource: 'invoker-explicit',
          postureFingerprint: 'b'.repeat(64),
          classification: 'PASS',
          exitCode: 0,
          gateResults: [],
          digests: buildTrialDigests({
            artifactDigest: artDig,
            fixtureDigest: frozenFixture,
            ...q.digests,
          }),
        },
        { manifestTrial: frozenRow },
      );
      const campOk = await verifyCampaignEvidenceDigests(campaign, [
        frozenRow,
      ]);
      assert.equal(campOk.ok, true);
      assert.equal(campOk.reportableResults.length, 1);

      // Fixture mismatch via trial metadata fails closed (not two in-result fields)
      const campBad = await verifyCampaignEvidenceDigests(campaign, [
        {
          ...frozenRow,
          expectedFixtureDigest: 'd'.repeat(64),
        },
      ]);
      assert.equal(campBad.ok, false);
      assert.ok(
        campBad.failures.some((f) => f.mismatches.includes('fixtureDigest')),
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('strict manifest-bound evidence: identity, artifact path, schema, id binding', async () => {
    const {
      quarantineRawOutput,
      writeTrialResult,
      readTrialResult,
      buildTrialDigests,
      computeFinalResultDigest,
      verifyTrialEvidenceDigests,
      verifyCampaignEvidenceDigests,
      computeArtifactDigest,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-strict-ev-'));
    try {
      const trialId = 'trial-strict';
      const posture = 'c'.repeat(64);
      const frozen = {
        id: trialId,
        experimentId: 'exp-strict',
        arm: 'arm-a',
        provider: 'prov',
        taskId: 'task-1',
        repetition: 1,
        scheduleSeed: 7,
        invocationPath: 'native-cli',
        requestedModel: 'model-x',
        postureFingerprint: posture,
        state: 'completed',
      };

      const q = await quarantineRawOutput(campaign, trialId, {
        stdout: 'strict-out\n',
        stderr: '',
      });
      const artDir = path.join(campaign, 'artifacts', trialId);
      await mkdir(artDir, { recursive: true });
      await writeFile(path.join(artDir, 'meta.json'), '{"ok":true}\n', 'utf8');
      const artDig = await computeArtifactDigest(artDir);

      const baseResult = completeTrialResult({
        ...frozen,
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        executionRoot: '/tmp/exec-root',
        artifactDir: artDir,
        digests: buildTrialDigests({
          artifactDigest: artDig,
          ...q.digests,
        }),
      });

      const { result: written } = await writeCompleteTrial(
        campaign,
        trialId,
        baseResult,
        { manifestTrial: frozen },
      );
      assert.match(written.digests.resultDigest, /^[a-f0-9]{64}$/);
      assert.equal(written.id, trialId);

      // --- writeTrialResult rejects missing manifestTrial ---
      await assert.rejects(
        () => writeTrialResult(campaign, trialId, baseResult),
        /manifestTrial.*required|fail closed/i,
      );

      // --- writeTrialResult rejects result.id !== trialId ---
      await assert.rejects(
        () =>
          writeTrialResult(
            campaign,
            trialId,
            {
              ...baseResult,
              id: 'other-trial',
            },
            { manifestTrial: frozen },
          ),
        /result\.id.*!== trialId|fail closed/i,
      );

      // --- unknown-field rejected on write ---
      await assert.rejects(
        () =>
          writeTrialResult(
            campaign,
            trialId,
            {
              ...baseResult,
              notInContract: true,
            },
            { manifestTrial: frozen },
          ),
        /additional property|schema validation|fail closed/i,
      );

      // --- scheduleSeed type mismatch (number vs string) is exact ---
      await assert.rejects(
        () =>
          writeTrialResult(
            campaign,
            trialId,
            { ...baseResult, scheduleSeed: '7' },
            { manifestTrial: frozen },
          ),
        /identity|scheduleSeed|fail closed/i,
      );
      const seedTypeBad = await verifyTrialEvidenceDigests(
        campaign,
        trialId,
        { ...written, scheduleSeed: '7' },
        {
          manifestTrial: frozen,
        },
      );
      assert.equal(seedTypeBad.ok, false);
      assert.ok(
        seedTypeBad.mismatches.some((m) => String(m).includes('scheduleSeed')),
        String(seedTypeBad.mismatches),
      );

      // --- swapped / mismatched identity fails verify when manifestTrial provided ---
      const swapped = await readTrialResult(campaign, trialId);
      swapped.arm = 'arm-ATTACKER';
      // Keep stored resultDigest so identity is the failure mode (not only digest).
      await writeFile(
        path.join(campaign, 'results', trialId, 'result.json'),
        `${JSON.stringify(swapped, null, 2)}\n`,
        'utf8',
      );
      const idBad = await verifyTrialEvidenceDigests(
        campaign,
        trialId,
        swapped,
        { manifestTrial: frozen },
      );
      assert.equal(idBad.ok, false);
      assert.ok(
        idBad.mismatches.some(
          (m) => m === 'identity:arm' || m.includes('arm'),
        ),
        String(idBad.mismatches),
      );

      // Campaign path also binds identity from each manifest row
      const campIdBad = await verifyCampaignEvidenceDigests(campaign, [
        { ...frozen, state: 'completed' },
      ]);
      assert.equal(campIdBad.ok, false);
      assert.ok(
        campIdBad.failures.some((f) =>
          f.mismatches.some((m) => String(m).includes('arm')),
        ),
      );

      // Restore a correct result for further checks
      const { result: restored } = await writeCompleteTrial(
        campaign,
        trialId,
        {
          ...baseResult,
          // force recompute
          digests: buildTrialDigests({
            artifactDigest: artDig,
            ...q.digests,
          }),
        },
        { manifestTrial: frozen },
      );

      // --- external / tampered artifactDir is ignored; only campaign/artifacts/<id> ---
      const external = await mkdtemp(path.join(os.tmpdir(), 'aicb-ext-art-'));
      try {
        await writeFile(
          path.join(external, 'evil.json'),
          '{"evil":true}\n',
          'utf8',
        );
        const extDig = await computeArtifactDigest(external);
        // Plant a result that claims external artifactDir and matching-looking digest
        // for the *external* tree while campaign artifacts stay as originally digested.
        const tamperedPath = await readTrialResult(campaign, trialId);
        tamperedPath.artifactDir = external;
        // If verify trusted artifactDir, it would recompute extDig and mismatch
        // stored artifactDigest (campaign tree). If it ignores external path and
        // uses campaign/artifacts/<id>, the original artDig still matches.
        tamperedPath.digests = {
          ...tamperedPath.digests,
          // keep campaign artDig — external must not be trusted
          artifactDigest: artDig,
        };
        // Re-stamp resultDigest for the tampered artifactDir field (exportable field)
        tamperedPath.digests.resultDigest = computeFinalResultDigest(tamperedPath);
        await writeFile(
          path.join(campaign, 'results', trialId, 'result.json'),
          `${JSON.stringify(tamperedPath, null, 2)}\n`,
          'utf8',
        );

        const pathIgnored = await verifyTrialEvidenceDigests(
          campaign,
          trialId,
          tamperedPath,
          { manifestTrial: frozen },
        );
        // campaign artifacts still match artDig → ok (external path ignored)
        assert.equal(
          pathIgnored.ok,
          true,
          `expected external artifactDir ignored: ${pathIgnored.error}`,
        );
        assert.ok(
          String(pathIgnored.recomputed?.artifactDir || '').includes(
            path.join('artifacts', trialId),
          ),
        );
        assert.notEqual(extDig, artDig);

        // Empty/missing campaign artifacts while external has content → fail
        // (proves external is not consulted)
        await writeFile(
          path.join(artDir, 'meta.json'),
          '{"ok":false,"tampered":1}\n',
          'utf8',
        );
        const campChanged = await verifyTrialEvidenceDigests(
          campaign,
          trialId,
          await readTrialResult(campaign, trialId),
          { manifestTrial: frozen },
        );
        assert.equal(campChanged.ok, false);
        assert.ok(
          campChanged.mismatches.includes('artifactDigest'),
          String(campChanged.mismatches),
        );
      } finally {
        await rm(external, { recursive: true, force: true });
      }

      // Restore campaign artifacts + result
      await writeFile(path.join(artDir, 'meta.json'), '{"ok":true}\n', 'utf8');
      const artDig2 = await computeArtifactDigest(artDir);
      const { result: full } = await writeCompleteTrial(
        campaign,
        trialId,
        {
          ...baseResult,
          executionRoot: '/tmp/exec-root',
          error: null,
          digests: buildTrialDigests({
            artifactDigest: artDig2,
            ...q.digests,
          }),
        },
        { manifestTrial: frozen },
      );

      // --- exportable field is covered by resultDigest (changing it breaks digest) ---
      assert.equal(full.digests.resultDigest, computeFinalResultDigest(full));
      const mutated = { ...full, executionRoot: '/tmp/ATTACKER-ROOT' };
      // resultDigest field still the old one
      assert.notEqual(
        computeFinalResultDigest(mutated),
        full.digests.resultDigest,
      );
      await writeFile(
        path.join(campaign, 'results', trialId, 'result.json'),
        `${JSON.stringify(mutated, null, 2)}\n`,
        'utf8',
      );
      const digBreak = await verifyTrialEvidenceDigests(campaign, trialId, mutated, {
        manifestTrial: frozen,
      });
      assert.equal(digBreak.ok, false);
      assert.ok(digBreak.mismatches.includes('resultDigest'));

      // --- unknown-field rejected on verify ---
      const withUnknown = {
        ...restored,
        digests: {
          ...restored.digests,
          artifactDigest: artDig2,
        },
        smuggled: 'nope',
      };
      withUnknown.digests.resultDigest = computeFinalResultDigest(withUnknown);
      const schemaBad = await verifyTrialEvidenceDigests(
        campaign,
        trialId,
        withUnknown,
        { manifestTrial: frozen },
      );
      assert.equal(schemaBad.ok, false);
      assert.ok(
        schemaBad.mismatches.includes('schema') ||
          /additional property|schema/i.test(String(schemaBad.error)),
        String(schemaBad.error),
      );

      // rawEvidenceUnavailable still digests full record including the flag
      const infraId = 'trial-infra-dig';
      const { result: infraWritten } = await writeCompleteTrial(
        campaign,
        infraId,
        {
          id: infraId,
          experimentId: 'exp-strict',
          arm: 'arm-a',
          provider: 'prov',
          taskId: 'task-1',
          repetition: 1,
          scheduleSeed: 7,
          invocationPath: 'native-cli',
          requestedModel: 'model-x',
          postureFingerprint: posture,
          state: 'failed',
          classification: 'INFRA_FAIL',
          exitCode: null,
          digests: { rawEvidenceUnavailable: true },
        },
      );
      assert.equal(
        infraWritten.digests.resultDigest,
        computeFinalResultDigest(infraWritten),
      );
      assert.equal(infraWritten.digests.rawEvidenceUnavailable, true);
      // Flip flag off without updating digest → resultDigest mismatch
      const infraTamper = {
        ...infraWritten,
        digests: {
          ...infraWritten.digests,
          rawEvidenceUnavailable: false,
        },
      };
      assert.notEqual(
        computeFinalResultDigest(infraTamper),
        infraWritten.digests.resultDigest,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('summary and export refuse unavailable records and report bypass', async () => {
    const {
      buildTrialDigests,
      verifyCampaignEvidenceDigests,
    } = await import('../harness/results.js');
    const { main } = await import('../harness/cli.js');
    const { exportSanitizedBundle } = await import('../harness/export.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-sum-gate-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-sum-out-'));
    try {
      // Plant a tempting but unverified report.json
      await writeFile(
        path.join(campaign, 'report.json'),
        JSON.stringify({
          schemaVersion: 1,
          campaignId: 'bypass',
          generatedAt: new Date().toISOString(),
          totals: { n: 1, completed: 1, passRate: 1 },
          byArm: [],
          byTask: [],
          cells: [],
          refusals: [],
          classifications: { PASS: 1 },
        }),
        'utf8',
      );
      const frozenUnavail = completeManifestTrial({
        id: 't-unavail',
        experimentId: 'exp',
        arm: 'a',
        provider: 'fake',
        taskId: 't',
        state: 'failed',
      });
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'bypass',
          schemaVersion: 1,
          status: 'completed',
          experimentId: 'exp',
          lock: { held: false, owner: null },
          trials: [frozenUnavail],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      await writeCompleteTrial(
        campaign,
        't-unavail',
        {
          experimentId: 'exp',
          arm: 'a',
          provider: 'fake',
          taskId: 't',
          state: 'failed',
          classification: 'INFRA_FAIL',
          exitCode: null,
          digests: {
            ...buildTrialDigests({}),
            rawEvidenceUnavailable: true,
          },
        },
        { manifestTrial: frozenUnavail },
      );

      // verify fail closed for report path (unavailable is not reportable)
      const v = await verifyCampaignEvidenceDigests(campaign, [
        frozenUnavail,
      ]);
      assert.equal(v.ok, false);
      assert.equal(v.unavailable, 1);

      // summary must not reuse planted report.json
      const code = await main([
        'summary',
        '--campaign',
        campaign,
        '--json',
      ]);
      assert.equal(code, 1);

      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: campaign,
            outDir: out,
            includeRaw: false,
          }),
        /fail closed|unavailable|evidence integrity/i,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('stored PASS with rawEvidenceUnavailable true is unavailable, nonreportable, and export-excluded', async () => {
    const {
      buildTrialDigests,
      verifyTrialEvidenceDigests,
      verifyCampaignEvidenceDigests,
      isUnavailableForReport,
      hasRawEvidenceUnavailableFlag,
      isInfraFailureWithoutRawEvidence,
    } = await import('../harness/results.js');
    const { main } = await import('../harness/cli.js');
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const { buildReport } = await import('../harness/summary.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-pass-unavail-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-pass-unavail-out-'));
    try {
      // Deliberately mislabeled: classification PASS but digests flag unavailable.
      // Reportability must key on the flag, not classification.
      const frozenPass = completeManifestTrial({
        id: 't-pass-unavail',
        experimentId: 'exp-pass-unavail',
        arm: 'a',
        provider: 'fake',
        taskId: 't',
        state: 'completed',
      });
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'pass-unavail',
          schemaVersion: 1,
          status: 'completed',
          experimentId: 'exp-pass-unavail',
          lock: { held: false, owner: null },
          trials: [frozenPass],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      const { result: stored } = await writeCompleteTrial(
        campaign,
        't-pass-unavail',
        {
          experimentId: 'exp-pass-unavail',
          arm: 'a',
          provider: 'fake',
          taskId: 't',
          state: 'completed',
          classification: 'PASS',
          exitCode: 0,
          digests: {
            ...buildTrialDigests({}),
            rawEvidenceUnavailable: true,
          },
        },
        { manifestTrial: frozenPass },
      );

      assert.equal(stored.classification, 'PASS');
      assert.equal(stored.digests.rawEvidenceUnavailable, true);
      assert.equal(hasRawEvidenceUnavailableFlag(stored), true);
      // Old helper required INFRA_FAIL — must not be the only gate.
      assert.equal(isInfraFailureWithoutRawEvidence(stored), false);
      // Direct fail-closed on the digest flag, independent of classification.
      assert.equal(isUnavailableForReport(stored), true);

      const v = await verifyTrialEvidenceDigests(
        campaign,
        't-pass-unavail',
        stored,
        { manifestTrial: frozenPass },
      );
      assert.equal(v.ok, false);
      assert.equal(v.unavailable, true);
      assert.equal(v.reportable, false);
      assert.match(String(v.error), /unavailable|not verified|not reportable/i);

      const camp = await verifyCampaignEvidenceDigests(campaign, [frozenPass]);
      assert.equal(camp.ok, false);
      assert.equal(camp.unavailable, 1);
      assert.equal(camp.reportableResults.length, 0);
      assert.equal(camp.verified, 0);

      // Summary/report must not treat it as a PASS cell.
      const report = buildReport(
        { campaignId: 'pass-unavail', trials: [frozenPass] },
        camp.reportableResults,
      );
      assert.equal(report.totals?.n ?? 0, 0);
      assert.notEqual(report.classifications?.PASS, 1);

      const summaryCode = await main([
        'summary',
        '--campaign',
        campaign,
        '--json',
      ]);
      assert.equal(summaryCode, 1);

      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: campaign,
            outDir: out,
            includeRaw: false,
          }),
        /fail closed|unavailable|evidence integrity|no verified reportable/i,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('PASS + rawEvidenceUnavailable + mismatched resultDigest still unavailable and nonreportable', async () => {
    const {
      buildTrialDigests,
      verifyTrialEvidenceDigests,
      isUnavailableForReport,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(
      path.join(os.tmpdir(), 'aicb-pass-unavail-mismatch-'),
    );
    try {
      const frozen = completeManifestTrial({
        id: 't-pass-mismatch',
        state: 'completed',
      });
      const { result: written } = await writeCompleteTrial(
        campaign,
        't-pass-mismatch',
        {
          state: 'completed',
          classification: 'PASS',
          exitCode: 0,
          digests: {
            ...buildTrialDigests({}),
            rawEvidenceUnavailable: true,
          },
        },
        { manifestTrial: frozen },
      );

      // Coexist with another integrity failure: tamper resultDigest after write.
      const tampered = {
        ...written,
        digests: {
          ...written.digests,
          resultDigest: '0'.repeat(64),
          rawEvidenceUnavailable: true,
        },
      };
      assert.equal(tampered.classification, 'PASS');
      assert.equal(isUnavailableForReport(tampered), true);

      const v = await verifyTrialEvidenceDigests(
        campaign,
        't-pass-mismatch',
        tampered,
        { manifestTrial: frozen },
      );
      assert.equal(v.ok, false);
      // Flag alone forces unavailable true even when mismatches coexist.
      assert.equal(v.unavailable, true);
      assert.equal(v.reportable, false);
      assert.ok(
        v.mismatches.includes('resultDigest'),
        `expected resultDigest mismatch retained, got ${JSON.stringify(v.mismatches)}`,
      );
      assert.match(String(v.error), /unavailable|integrity/i);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });
});

describe('digest leaf swap / no-follow identity', () => {
  it('sha256File refuses leaf symlink (never follows to sentinel)', async () => {
    if (process.platform === 'win32') return;
    const { sha256File } = await import('../harness/digest.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const { symlink, lstat } = await import('node:fs/promises');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-dig-sym-'));
    try {
      const secret = path.join(dir, 'host-secret.txt');
      await writeFile(secret, 'DIGEST_SENTINEL_SECRET\n', 'utf8');
      const link = path.join(dir, 'artifact.bin');
      await symlink(secret, link);
      const st = await lstat(link);
      assert.equal(st.isSymbolicLink(), true);

      await assert.rejects(
        () => sha256File(link),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );
      assert.equal(await readFile(secret, 'utf8'), 'DIGEST_SENTINEL_SECRET\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collectDirEntries fails closed when regular file is swapped to symlink', async () => {
    if (process.platform === 'win32') return;
    const { collectDirEntries, sha256Buffer } = await import(
      '../harness/digest.js'
    );
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const { symlink } = await import('node:fs/promises');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-dig-swap-'));
    try {
      const secret = path.join(dir, 'outside-secret.txt');
      await writeFile(secret, 'DIGEST_SWAP_SENTINEL\n', 'utf8');
      const nested = path.join(dir, 'tree');
      await mkdir(nested, { recursive: true });
      const target = path.join(nested, 'payload.txt');
      await writeFile(target, 'original-payload\n', 'utf8');

      // Baseline: digest sees the regular file content.
      const before = await collectDirEntries(nested, '');
      const fileEntry = before.find((e) => e.type === 'file' && e.path === 'payload.txt');
      assert.ok(fileEntry);
      assert.equal(fileEntry.sha256, sha256Buffer('original-payload\n'));

      // Leaf swap race shape: replace file with symlink to host secret.
      await rm(target);
      await symlink(secret, target);

      // Directory walk records symlink metadata only (never reads secret bytes).
      const after = await collectDirEntries(nested, '');
      const sym = after.find((e) => e.path === 'payload.txt');
      assert.ok(sym);
      assert.equal(sym.type, 'symlink');
      assert.ok(!('sha256' in sym) || sym.sha256 == null);

      // Direct file hash of the swapped leaf must refuse follow.
      const { sha256File } = await import('../harness/digest.js');
      await assert.rejects(
        () => sha256File(target),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|fail closed/i.test(String(err)),
      );
      assert.equal(await readFile(secret, 'utf8'), 'DIGEST_SWAP_SENTINEL\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sha256File with identity pin refuses replaced inode at same path', async () => {
    if (process.platform === 'win32') return;
    const { readFileNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );
    const { sha256Buffer } = await import('../harness/digest.js');
    const { lstat, rename: fsRename } = await import('node:fs/promises');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-dig-id-'));
    try {
      const pathA = path.join(dir, 'a.txt');
      const pathB = path.join(dir, 'b.txt');
      await writeFile(pathA, 'content-a\n', 'utf8');
      await writeFile(pathB, 'content-b-SECRET\n', 'utf8');
      const st = await lstat(pathA);

      await rm(pathA);
      await fsRename(pathB, pathA);

      await assert.rejects(
        () =>
          readFileNoFollow(pathA, {
            expectedDev: st.dev,
            expectedIno: st.ino,
          }),
        (err) =>
          err instanceof UnsafePathError &&
          (err.code === 'IDENTITY_MISMATCH' ||
            /identity mismatch/i.test(err.message)),
      );

      // Unpinned nofollow still hashes the replacement (regular file) correctly.
      const { sha256File } = await import('../harness/digest.js');
      const h = await sha256File(pathA);
      assert.equal(h, sha256Buffer('content-b-SECRET\n'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clearTrialDurableState removes result/raw/artifacts for clean re-run', async () => {
    const {
      clearTrialDurableState,
      quarantineRawOutput,
      readTrialResult,
    } = await import('../harness/results.js');
    const { writeCompleteTrial, completeManifestTrial } = await import(
      './helpers/complete-trial.js'
    );

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-clear-dur-'));
    try {
      const trialId = 't-clear-1';
      await quarantineRawOutput(campaign, trialId, {
        stdout: 'secret-out\n',
        stderr: 'e\n',
      });
      await mkdir(path.join(campaign, 'artifacts', trialId), { recursive: true });
      await writeFile(
        path.join(campaign, 'artifacts', trialId, 'meta.json'),
        '{}\n',
        'utf8',
      );
      const manifestTrial = completeManifestTrial({ id: trialId, state: 'running' });
      await writeCompleteTrial(
        campaign,
        trialId,
        {
          state: 'completed',
          classification: 'PASS',
          digests: { rawEvidenceUnavailable: true },
        },
        { manifestTrial },
      );

      const before = await readTrialResult(campaign, trialId);
      assert.equal(before.id, trialId);

      const cleared = await clearTrialDurableState(campaign, trialId);
      assert.ok(cleared.cleared.includes('results'));
      assert.ok(cleared.cleared.includes('raw'));
      assert.ok(cleared.cleared.includes('artifacts'));

      await assert.rejects(() => readTrialResult(campaign, trialId));
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });
});
