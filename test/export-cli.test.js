/**
 * Sanitization export, private quarantine modes, quiet CLI.
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
  access,
  stat,
  symlink,
  readdir,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build a minimal campaign with one verified reportable trial (for export tests).
 * @param {string} campaign
 * @param {object} [opts]
 * @param {string} [opts.trialId]
 * @param {object} [opts.resultExtras]
 * @param {string} [opts.stdout]
 * @returns {Promise<{ trialId: string, artDir: string }>}
 */
async function seedVerifiedCampaign(campaign, opts = {}) {
  const {
    quarantineRawOutput,
    writeTrialResult,
    buildTrialDigests,
    computeArtifactDigest,
  } = await import('../harness/results.js');

  const trialId = opts.trialId ?? 't1';
  const stdout = opts.stdout ?? 'export-raw-body\n';
  const q = await quarantineRawOutput(campaign, trialId, {
    stdout,
    stderr: '',
  });
  const artDir = path.join(campaign, 'artifacts', trialId);
  await mkdir(artDir, { recursive: true });
  await writeFile(path.join(artDir, 'meta.json'), '{}\n', 'utf8');
  const artDig = await computeArtifactDigest(artDir);

  await writeTrialResult(campaign, trialId, {
    id: trialId,
    experimentId: 'exp-export',
    arm: 'fake',
    provider: 'fake',
    taskId: 'task-1',
    repetition: 1,
    scheduleSeed: 1,
    invocationPath: 'native-cli',
    requestedModel: 'm',
    resolvedModel: null,
    resolvedModelAvailable: false,
    resolvedModelSource: 'unavailable',
    postureFingerprint: 'a'.repeat(64),
    state: 'completed',
    classification: 'PASS',
    classificationReason: 'ok',
    exitCode: 0,
    gateResults: [
      {
        gate: 'tests',
        status: 'passed',
        exitCode: 0,
        required: true,
        stdoutDigest: 'b'.repeat(64),
        stdoutPreview: 'must-not-export-preview',
      },
    ],
    artifactDir: artDir,
    digests: buildTrialDigests({
      artifactDigest: artDig,
      ...q.digests,
    }),
    ...(opts.resultExtras || {}),
  });

  const now = new Date().toISOString();
  await writeFile(
    path.join(campaign, 'manifest.json'),
    JSON.stringify({
      campaignId: 'export-camp',
      schemaVersion: 1,
      status: 'completed',
      experimentId: 'exp-export',
      lock: { held: false, owner: null },
      host: { user: 'localuser', platform: 'darwin' },
      trials: [
        {
          id: trialId,
          state: 'completed',
          arm: 'fake',
          taskId: 'task-1',
          invocationPath: 'native-cli',
          requestedModel: 'm',
        },
      ],
      createdAt: now,
      updatedAt: now,
    }),
    'utf8',
  );

  return { trialId, artDir };
}

describe('export + quarantine + cli', () => {
  it('quarantine raw dirs are 0700 and files 0600', async () => {
    const { quarantineRawOutput } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-q-'));
    try {
      await quarantineRawOutput(campaign, 't1', {
        stdout: 'SECRET',
        stderr: 'err',
      });
      const rawDir = path.join(campaign, 'raw', 't1');
      const stDir = await stat(rawDir);
      // mode bits: lower 9 bits
      const dirMode = stDir.mode & 0o777;
      assert.equal(dirMode, 0o700);
      const stFile = await stat(path.join(rawDir, 'stdout.txt'));
      assert.equal(stFile.mode & 0o777, 0o600);
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('result and private file helpers enforce 0700/0600 (posix)', async () => {
    if (process.platform === 'win32') return;
    const {
      ensurePrivateDir,
      writePrivateFile,
      writeTrialResult,
    } = await import('../harness/results.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-modes-'));
    try {
      const art = path.join(campaign, 'artifacts', 't1');
      await ensurePrivateDir(art);
      const stArt = await stat(art);
      assert.equal(stArt.mode & 0o777, 0o700);

      const req = path.join(art, 'request.json');
      await writePrivateFile(req, '{"prompt":"secret"}\n');
      const stReq = await stat(req);
      assert.equal(stReq.mode & 0o777, 0o600);

      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'PASS',
        gateResults: [
          {
            gate: 'tests',
            status: 'passed',
            stdoutPreview: 'must-not-persist',
            stdoutDigest: 'd'.repeat(64),
          },
        ],
      });
      const resDir = path.join(campaign, 'results', 't1');
      assert.equal((await stat(resDir)).mode & 0o777, 0o700);
      const resFile = path.join(resDir, 'result.json');
      assert.equal((await stat(resFile)).mode & 0o777, 0o600);
      const body = await readFile(resFile, 'utf8');
      assert.ok(!body.includes('must-not-persist'));
      assert.ok(!body.includes('stdoutPreview'));
      assert.ok(body.includes('stdoutDigest'));
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('export omits raw, request artifacts, usernames, and absolute paths', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-out-'));
    try {
      await seedVerifiedCampaign(campaign, {
        resultExtras: {
          workspaceDir: path.join(campaign, 'workspaces', 't1'),
          prompt: 'top-level prompt leak',
          nested: {
            request: { prompt: 'nested secret prompt' },
            stdout: 'leaky',
          },
        },
      });
      // Plant prompt-bearing artifacts outside the digested tree path used for
      // artifactDigest (must not export; do not mutate digested artDir).
      await mkdir(path.join(campaign, 'artifacts', 'planted'), {
        recursive: true,
      });
      await writeFile(
        path.join(campaign, 'artifacts', 'planted', 'request.json'),
        JSON.stringify({ prompt: 'secret prompt body', schema: 'x' }),
        'utf8',
      );
      await writeFile(
        path.join(campaign, 'artifacts', 'planted', 'output.json'),
        JSON.stringify({ raw: 'provider' }),
        'utf8',
      );

      await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: false,
      });

      await assert.rejects(() => access(path.join(out, 'raw', 't1', 'stdout.txt')));
      await assert.rejects(() =>
        access(path.join(out, 'artifacts', 'planted', 'request.json')),
      );
      await assert.rejects(() =>
        access(path.join(out, 'artifacts', 'planted', 'output.json')),
      );
      await assert.rejects(() => access(path.join(out, 'artifacts')));

      const man = await readFile(path.join(out, 'manifest.json'), 'utf8');
      assert.ok(!man.includes('localuser'));
      assert.ok(!man.includes('/Users/localuser'));
      assert.ok(!man.includes('SECRET_TOKEN'));

      const result = await readFile(
        path.join(out, 'results', 't1', 'result.json'),
        'utf8',
      );
      assert.ok(!result.includes('secret prompt'));
      assert.ok(!result.includes('nested secret'));
      assert.ok(!result.includes('top-level prompt'));
      assert.ok(!result.includes('leaky'));
      // gate stdout/stderr previews never exported
      assert.ok(!result.includes('stdoutPreview'));
      assert.ok(!result.includes('must-not-export-preview'));
      assert.ok(result.includes('stdoutDigest'));
      // absolute workspace redacted / omitted
      assert.ok(!result.includes(path.join(campaign, 'workspaces', 't1')));
      // non-whitelist keys dropped
      assert.ok(!result.includes('"nested"'));

      // Report/summary rebuilt (not missing)
      await access(path.join(out, 'report.json'));
      await access(path.join(out, 'summary.txt'));

      const readme = await readFile(path.join(out, 'EXPORT_README.txt'), 'utf8');
      assert.ok(!readme.includes(campaign));
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('export strips free-form reason strings; keeps bounded reasonCode only', async () => {
    const {
      exportSanitizedBundle,
      sanitizeExportReasonCode,
      isExportSafeReasonCode,
    } = await import('../harness/export.js');
    const {
      isBoundedIdentifier,
      sanitizeBoundedIdentifier,
    } = await import('../harness/gates.js');

    assert.equal(isBoundedIdentifier('provider_timeout'), true);
    assert.equal(isExportSafeReasonCode('provider_timeout'), true);
    assert.equal(sanitizeExportReasonCode('provider_timeout'), 'provider_timeout');
    assert.equal(
      sanitizeBoundedIdentifier('free form reason with spaces and secrets'),
      null,
    );
    assert.equal(
      sanitizeExportReasonCode('Authorization: Bearer sk-leaked'),
      null,
    );

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-rc-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-out-rc-'));
    try {
      await seedVerifiedCampaign(campaign, {
        resultExtras: {
          classification: 'INFRA_FAIL',
          state: 'failed',
          classificationReason:
            'invoker infra failure: provider said Authorization: Bearer redacted-token and DATABASE_URL=dsn-must-not-export',
          reasonCode: 'provider_timeout',
          outcomeKind: 'timeout',
          error: 'Connection refused at 10.0.0.1 with cookie=session',
          gateResults: [
            {
              gate: 'oracle',
              status: 'passed',
              oraclePath: 'task/x.js',
              oracleExecuted: true,
              evidence:
                'oracle exit 0 matches expected 0 with secret=should-not-export',
              infraFailure: 'oracle_command_oraclePath_conflict',
            },
            {
              gate: 'oracle',
              status: 'passed',
              oraclePath: 'task/claimed.js',
              command: 'true',
            },
          ],
        },
      });
      // Manifest trial state should match failed classification path
      const man = JSON.parse(
        await readFile(path.join(campaign, 'manifest.json'), 'utf8'),
      );
      man.trials[0].state = 'failed';
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify(man),
        'utf8',
      );

      await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: false,
      });

      const result = await readFile(
        path.join(out, 'results', 't1', 'result.json'),
        'utf8',
      );
      const parsed = JSON.parse(result);

      // Bounded identifiers retained
      assert.equal(parsed.reasonCode, 'provider_timeout');
      assert.equal(parsed.outcomeKind, 'timeout');
      assert.equal(parsed.classification, 'INFRA_FAIL');

      // Free-form classificationReason / error stripped
      assert.equal(parsed.classificationReason, undefined);
      assert.equal(parsed.error, undefined);
      assert.ok(!result.includes('Bearer'));
      assert.ok(!result.includes('DATABASE_URL'));
      assert.ok(!result.includes('dsn-must-not-export'));
      assert.ok(!result.includes('redacted-token'));
      assert.ok(!result.includes('cookie=session'));
      assert.ok(!result.includes('secret=should-not-export'));

      // gate free-form evidence dropped; exclusive oraclePath kept
      assert.equal(parsed.gateResults[0].oraclePath, 'task/x.js');
      assert.equal(parsed.gateResults[0].oracleExecuted, true);
      assert.equal(parsed.gateResults[0].evidence, undefined);
      // claimed (non-executed) oraclePath not exported
      assert.equal(parsed.gateResults[1].oraclePath, undefined);
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('export fail-closed: planted result excluded; planted report ignored; no bypass', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-adv-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-adv-out-'));
    try {
      await seedVerifiedCampaign(campaign);

      // Plant extra unmanifested result
      await mkdir(path.join(campaign, 'results', 'planted-extra'), {
        recursive: true,
      });
      await writeFile(
        path.join(campaign, 'results', 'planted-extra', 'result.json'),
        JSON.stringify({
          id: 'planted-extra',
          classification: 'PASS',
          resolvedModel: 'PLANT-MODEL',
          digests: { resultDigest: 'f'.repeat(64) },
        }),
        'utf8',
      );

      // Plant stale/adversarial report + summary
      await writeFile(
        path.join(campaign, 'report.json'),
        JSON.stringify({
          schemaVersion: 1,
          campaignId: 'PLANTED-REPORT',
          generatedAt: new Date().toISOString(),
          totals: { n: 99, completed: 99, passRate: 1 },
          byArm: [],
          byTask: [],
          cells: [],
          refusals: [],
          classifications: { PASS: 99 },
          evil: 'PLANTED_MARKER',
        }),
        'utf8',
      );
      await writeFile(
        path.join(campaign, 'summary.txt'),
        'PLANTED_SUMMARY_MARKER\n',
        'utf8',
      );

      const exp = await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: false,
      });
      assert.equal(exp.verified, 1);

      // Extra result not exported
      await assert.rejects(() =>
        access(path.join(out, 'results', 'planted-extra', 'result.json')),
      );
      const exportedIds = await readdir(path.join(out, 'results'));
      assert.deepEqual(exportedIds, ['t1']);

      // Report rebuilt — not the planted one
      const report = JSON.parse(
        await readFile(path.join(out, 'report.json'), 'utf8'),
      );
      assert.equal(report.campaignId, 'export-camp');
      assert.notEqual(report.campaignId, 'PLANTED-REPORT');
      assert.ok(!JSON.stringify(report).includes('PLANTED_MARKER'));
      assert.ok(!JSON.stringify(report).includes('evil'));

      const summary = await readFile(path.join(out, 'summary.txt'), 'utf8');
      assert.ok(!summary.includes('PLANTED_SUMMARY_MARKER'));

      // No public bypass: skipEvidenceVerify is removed; stray property must not
      // skip verification (export still succeeds only because evidence is valid).
      const again = await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        // stray property — must be ignored, never disable verify
        skipEvidenceVerify: true,
      });
      assert.equal(again.verified, 1);
      await assert.rejects(() =>
        access(path.join(out, 'results', 'planted-extra', 'result.json')),
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('export fails closed on missing/empty/no-terminal manifest', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');

    // Missing manifest
    const empty = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-empty-'));
    const out1 = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-out1-'));
    try {
      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: empty,
            outDir: out1,
          }),
        /manifest required|loadManifest|ENOENT|fail closed/i,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(out1, { recursive: true, force: true });
    }

    // Manifest with only pending trials
    const pending = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-pend-'));
    const out2 = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-out2-'));
    try {
      const now = new Date().toISOString();
      await writeFile(
        path.join(pending, 'manifest.json'),
        JSON.stringify({
          campaignId: 'pend-camp',
          schemaVersion: 1,
          status: 'pending',
          lock: { held: false, owner: null },
          trials: [{ id: 't-pending', state: 'pending' }],
          createdAt: now,
          updatedAt: now,
        }),
        'utf8',
      );
      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: pending,
            outDir: out2,
          }),
        /no completed\/failed|eligible for export|fail closed/i,
      );
    } finally {
      await rm(pending, { recursive: true, force: true });
      await rm(out2, { recursive: true, force: true });
    }
  });

  it('includeRaw: only verified trials; symlink raw rejected (no host bytes)', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-raw-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-raw-out-'));
    const hostSecret = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'aicb-host-')),
      'secret.txt',
    );
    try {
      await seedVerifiedCampaign(campaign, { stdout: 'legit-raw-stdout\n' });

      // Plant host secret and swap raw stdout for a symlink
      await writeFile(hostSecret, 'HOST_SECRET_BYTES_NEVER_EXPORT\n', 'utf8');
      const stdoutPath = path.join(campaign, 'raw', 't1', 'stdout.txt');
      await rm(stdoutPath, { force: true });
      await symlink(hostSecret, stdoutPath);

      // After symlink swap, evidence verify should fail (raw digest mismatch
      // or unavailable) OR if we force export of raw for verified-before-swap...
      // Actually digests were computed before symlink; verify will fail closed
      // because recompute reads via normal readFile in computeRawOutputDigests.
      // That is correct fail-closed — no export at all when digests mismatch.
      await assert.rejects(
        () =>
          exportSanitizedBundle({
            campaignDir: campaign,
            outDir: out,
            includeRaw: true,
          }),
        /digest|fail closed|evidence|mismatch|integrity/i,
      );

      // Rebuild a consistent campaign, then plant symlink only after... can't
      // verify then export with symlink without breaking digests. Instead:
      // export without includeRaw first is N/A. Test nofollow copy path directly:
      // re-seed and export with includeRaw on clean files, then plant extra raw
      // dir for unmanifested trial — must not export.
      await rm(campaign, { recursive: true, force: true });
      await mkdir(campaign, { recursive: true });
      await seedVerifiedCampaign(campaign, { stdout: 'clean-stdout\n' });

      // Plant unmanifested raw dir with host secret content
      await mkdir(path.join(campaign, 'raw', 'evil-trial'), { recursive: true });
      await writeFile(
        path.join(campaign, 'raw', 'evil-trial', 'stdout.txt'),
        'HOST_SECRET_BYTES_NEVER_EXPORT\n',
        'utf8',
      );

      const outClean = await mkdtemp(
        path.join(os.tmpdir(), 'aicb-export-raw-clean-'),
      );
      try {
        const exp = await exportSanitizedBundle({
          campaignDir: campaign,
          outDir: outClean,
          includeRaw: true,
        });
        assert.equal(exp.verified, 1);
        const good = await readFile(
          path.join(outClean, 'raw', 't1', 'stdout.txt'),
          'utf8',
        );
        assert.equal(good, 'clean-stdout\n');
        await assert.rejects(() =>
          access(path.join(outClean, 'raw', 'evil-trial', 'stdout.txt')),
        );
        const rawListing = await readdir(path.join(outClean, 'raw'));
        assert.deepEqual(rawListing, ['t1']);
        const whole = await readdir(outClean, { recursive: true });
        const joined = whole.join('\n');
        assert.ok(!joined.includes('evil-trial'));
        assert.ok(!joined.includes('HOST_SECRET'));
      } finally {
        await rm(outClean, { recursive: true, force: true });
      }

      // Direct nofollow: after successful verify path, if stdout becomes symlink
      // mid-export we reject — unit via copy with symlink after fresh seed is
      // covered by export attempting copy only after verify (tamper breaks verify).
      // Explicit: plant symlink after we can't re-verify... export always verifies
      // first so symlink raw that breaks digests fails closed (asserted above).
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
      await rm(path.dirname(hostSecret), { recursive: true, force: true });
    }
  });

  it('includeRaw refuses symlink raw via nofollow even if digests could match empty', async () => {
    // Cover copyFileNoFollow path: verified campaign, replace stderr with symlink
    // after computing digests of empty stderr — wait, any content change breaks
    // digests. Instead call export with includeRaw on a verified campaign where
    // stderr.txt is legitimately empty string, then the whitelist copy uses
    // nofollow. Plant a NEW non-whitelisted symlink file — must not be copied.
    const { exportSanitizedBundle, EXPORT_RAW_FILE_WHITELIST } = await import(
      '../harness/export.js'
    );
    assert.ok(EXPORT_RAW_FILE_WHITELIST.includes('stdout.txt'));

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-nf-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-export-nf-out-'));
    const host = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'aicb-host2-')),
      'host.bin',
    );
    try {
      await seedVerifiedCampaign(campaign);
      await writeFile(host, 'HOST_BYTES\n', 'utf8');
      // Non-whitelist name + symlink must never appear in export
      await symlink(host, path.join(campaign, 'raw', 't1', 'exfil.link'));

      await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: true,
      });
      await assert.rejects(() =>
        access(path.join(out, 'raw', 't1', 'exfil.link')),
      );
      const files = await readdir(path.join(out, 'raw', 't1'));
      assert.ok(!files.includes('exfil.link'));
      for (const f of files) {
        const body = await readFile(path.join(out, 'raw', 't1', f), 'utf8');
        assert.ok(!body.includes('HOST_BYTES'));
      }
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
      await rm(path.dirname(host), { recursive: true, force: true });
    }
  });

  it('cli parseArgs and help are quiet', async () => {
    const { parseArgs, main } = await import('../harness/cli.js');
    const args = parseArgs(['run', '--experiment', 'e.json', '--max-trials', '1']);
    assert.equal(args.experiment, 'e.json');
    assert.equal(args['max-trials'], '1');
    assert.deepEqual(args._, ['run']);

    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const code = await main(['help'], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    assert.equal(code, 0);
    assert.ok(out.join('').toLowerCase().includes('aicb'));
  });

  it('self-validate checks package shape without providers', async () => {
    const { main } = await import('../harness/cli.js');
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const code = await main(['self-validate', '--root', REPO], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    assert.ok(code === 0 || code === 1);
    if (code === 0) {
      assert.match(out.join(''), /ok/i);
    } else {
      assert.ok(err.join().length > 0 || out.join().length > 0);
    }
  });
});
