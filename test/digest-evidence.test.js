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
      await writeTrialResult(campaign, 'trial-a', {
        id: 'trial-a',
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        artifactDir: artDir,
        digests,
      });

      const ok = await verifyTrialEvidenceDigests(campaign, 'trial-a');
      assert.equal(ok.ok, true);

      // Tamper on-disk raw stdout
      await writeFile(
        path.join(campaign, 'raw', 'trial-a', 'stdout.txt'),
        'TAMPERED\n',
        'utf8',
      );

      const bad = await verifyTrialEvidenceDigests(campaign, 'trial-a');
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
      await writeTrialResult(campaign, 'trial-b', {
        id: 'trial-b',
        classification: 'FAIL',
        exitCode: 1,
        gateResults: [],
        artifactDir: artDir,
        digests: buildTrialDigests({
          resultDigest: computeResultDigest({
            classification: 'FAIL',
            gateResults: [],
            exitCode: 1,
          }),
          artifactDigest: artDig,
          ...q.digests,
        }),
      });

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

      const bad = await verifyTrialEvidenceDigests(campaign, 'trial-b');
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
      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        artifactDir: artDir,
        digests: buildTrialDigests({
          resultDigest: computeResultDigest({
            classification: 'PASS',
            gateResults: [],
            exitCode: 0,
          }),
          artifactDigest: artDig,
          ...q.digests,
        }),
      });
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'completed',
          lock: { held: false, owner: null },
          trials: [{ id: 't1', state: 'completed' }],
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
      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        artifactDir: artDir,
        digests: buildTrialDigests({
          resultDigest: computeResultDigest({
            classification: 'PASS',
            gateResults: [],
            exitCode: 0,
          }),
          artifactDigest: artDig,
          ...q.digests,
        }),
      });

      const good = await verifyCampaignEvidenceDigests(
        campaign,
        [{ id: 't1', state: 'completed' }],
      );
      assert.equal(good.ok, true);
      assert.equal(good.verified, 1);

      await writeFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'y\n',
        'utf8',
      );
      const bad = await verifyCampaignEvidenceDigests(
        campaign,
        [{ id: 't1', state: 'completed' }],
      );
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
      await writeTrialResult(campaign, 't-good', {
        id: 't-good',
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        artifactDir: artDir,
        digests: buildTrialDigests({
          resultDigest: goodDigest,
          artifactDigest: artDig,
          ...q.digests,
        }),
      });

      // Tamper resultDigest only
      const { readTrialResult } = await import('../harness/results.js');
      const r = await readTrialResult(campaign, 't-good');
      r.digests.resultDigest = 'f'.repeat(64);
      await writeFile(
        path.join(campaign, 'results', 't-good', 'result.json'),
        `${JSON.stringify(r, null, 2)}\n`,
        'utf8',
      );
      const tamper = await verifyTrialEvidenceDigests(campaign, 't-good');
      assert.equal(tamper.ok, false);
      assert.ok(tamper.mismatches.includes('resultDigest'));

      // Missing result file for completed trial
      const missing = await verifyCampaignEvidenceDigests(campaign, [
        { id: 'no-such-trial', state: 'completed' },
      ]);
      assert.equal(missing.ok, false);
      assert.ok(missing.failures.some((f) => f.mismatches.includes('result')));

      // INFRA_FAIL without raw: unavailable (not verified)
      const infraDigest = computeResultDigest({
        classification: 'INFRA_FAIL',
        gateResults: [],
        exitCode: null,
      });
      await writeTrialResult(campaign, 't-infra', {
        id: 't-infra',
        classification: 'INFRA_FAIL',
        exitCode: null,
        gateResults: [],
        digests: {
          resultDigest: infraDigest,
          rawEvidenceUnavailable: true,
        },
      });
      const infra = await verifyTrialEvidenceDigests(campaign, 't-infra');
      assert.equal(infra.ok, false);
      assert.equal(infra.unavailable, true);
      assert.equal(infra.mismatches.length, 0);

      // Report path (default failOnUnavailable): unavailable fails closed
      const campInfraReport = await verifyCampaignEvidenceDigests(campaign, [
        { id: 't-infra', state: 'failed' },
      ]);
      assert.equal(campInfraReport.ok, false);
      assert.equal(campInfraReport.verified, 0);
      assert.equal(campInfraReport.unavailable, 1);
      assert.ok(campInfraReport.failures.some((f) => f.trialId === 't-infra'));

      // Operational classification path may count unavailable without failing
      const campInfraOps = await verifyCampaignEvidenceDigests(
        campaign,
        [{ id: 't-infra', state: 'failed' }],
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
      await writeTrialResult(campaign, 't-no-art', {
        id: 't-no-art',
        classification: 'PASS',
        exitCode: 0,
        gateResults: [],
        digests: buildTrialDigests({
          resultDigest: computeResultDigest({
            classification: 'PASS',
            gateResults: [],
            exitCode: 0,
          }),
          ...q2.digests,
          // deliberately omit artifactDigest
        }),
      });
      const noArt = await verifyTrialEvidenceDigests(campaign, 't-no-art');
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

      const { result: written } = await writeTrialResult(campaign, 't-env', {
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
      const modelTamper = await verifyTrialEvidenceDigests(campaign, 't-env');
      assert.equal(modelTamper.ok, false);
      assert.ok(modelTamper.mismatches.includes('resultDigest'));

      // Restore and check fixture authority vs independent expectedFixtureDigest
      await writeTrialResult(campaign, 't-env', {
        ...written,
        digests: {
          ...written.digests,
          // omit resultDigest — rewrite recomputes
        },
      });
      // Drop stored resultDigest field by re-read after rewrite
      const restored = await readTrialResult(campaign, 't-env');
      const good = await verifyTrialEvidenceDigests(campaign, 't-env', restored, {
        expectedFixtureDigest: frozenFixture,
      });
      assert.equal(good.ok, true);

      const badFix = await verifyTrialEvidenceDigests(campaign, 't-env', restored, {
        expectedFixtureDigest: 'c'.repeat(64),
      });
      assert.equal(badFix.ok, false);
      assert.ok(badFix.mismatches.includes('fixtureDigest'));

      // Campaign path with frozen trial metadata
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'completed',
          lock: { held: false, owner: null },
          trials: [
            {
              id: 't-env',
              state: 'completed',
              expectedFixtureDigest: frozenFixture,
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      const campOk = await verifyCampaignEvidenceDigests(campaign, [
        {
          id: 't-env',
          state: 'completed',
          expectedFixtureDigest: frozenFixture,
        },
      ]);
      assert.equal(campOk.ok, true);
      assert.equal(campOk.reportableResults.length, 1);

      // Fixture mismatch via trial metadata fails closed (not two in-result fields)
      const campBad = await verifyCampaignEvidenceDigests(campaign, [
        {
          id: 't-env',
          state: 'completed',
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

      const baseResult = {
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
      };

      const { result: written } = await writeTrialResult(
        campaign,
        trialId,
        baseResult,
        { manifestTrial: frozen },
      );
      assert.match(written.digests.resultDigest, /^[a-f0-9]{64}$/);
      assert.equal(written.id, trialId);

      // --- writeTrialResult rejects result.id !== trialId ---
      await assert.rejects(
        () =>
          writeTrialResult(campaign, trialId, {
            ...baseResult,
            id: 'other-trial',
          }),
        /result\.id.*!== trialId|fail closed/i,
      );

      // --- unknown-field rejected on write ---
      await assert.rejects(
        () =>
          writeTrialResult(campaign, trialId, {
            ...baseResult,
            notInContract: true,
          }),
        /additional property|schema validation|fail closed/i,
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
      const { result: restored } = await writeTrialResult(
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
      const { result: full } = await writeTrialResult(
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
      const { result: infraWritten } = await writeTrialResult(campaign, infraId, {
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
      });
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
      writeTrialResult,
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
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'bypass',
          schemaVersion: 1,
          status: 'completed',
          experimentId: 'exp',
          lock: { held: false, owner: null },
          trials: [{ id: 't-unavail', state: 'failed' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      await writeTrialResult(campaign, 't-unavail', {
        id: 't-unavail',
        experimentId: 'exp',
        arm: 'a',
        taskId: 't',
        repetition: 1,
        scheduleSeed: 1,
        invocationPath: 'native-cli',
        requestedModel: 'm',
        resolvedModel: null,
        resolvedModelAvailable: false,
        state: 'failed',
        classification: 'INFRA_FAIL',
        exitCode: null,
        digests: {
          ...buildTrialDigests({}),
          rawEvidenceUnavailable: true,
        },
      });

      // verify fail closed for report path
      const v = await verifyCampaignEvidenceDigests(campaign, [
        { id: 't-unavail', state: 'failed' },
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
});
