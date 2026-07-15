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
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-tamper-raw-'));
    try {
      const q = await quarantineRawOutput(campaign, 'trial-a', {
        stdout: 'original-stdout\n',
        stderr: 'e\n',
      });
      const digests = buildTrialDigests({
        resultDigest: 'a'.repeat(64),
        ...q.digests,
      });
      await writeTrialResult(campaign, 'trial-a', {
        id: 'trial-a',
        classification: 'PASS',
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
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-tamper-dig-'));
    try {
      const q = await quarantineRawOutput(campaign, 'trial-b', {
        stdout: 'body\n',
      });
      await writeTrialResult(campaign, 'trial-b', {
        id: 'trial-b',
        classification: 'FAIL',
        digests: buildTrialDigests({
          resultDigest: 'b'.repeat(64),
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
      const q = await quarantineRawOutput(campaign, 't1', {
        stdout: 'export-raw\n',
      });
      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'PASS',
        digests: buildTrialDigests({
          resultDigest: 'c'.repeat(64),
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
      verifyCampaignEvidenceDigests,
    } = await import('../harness/results.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-ev-'));
    try {
      const q = await quarantineRawOutput(campaign, 't1', { stdout: 'x\n' });
      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'PASS',
        digests: buildTrialDigests({
          resultDigest: 'd'.repeat(64),
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
});
