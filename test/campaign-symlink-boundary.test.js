/**
 * Adversarial campaign filesystem boundary attacks:
 * - symlink campaign root
 * - intermediate ancestor symlink
 * - manifest final / temp leaf symlinks
 * - report.json / summary.txt leaf symlinks
 * - request / output / result leaf symlinks
 * - resume-time preplanting
 * - revalidation race simulation
 *
 * Every attack asserts the external sentinel target is unchanged.
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
  symlink,
  lstat,
  open,
  readdir,
} from 'node:fs/promises';

const SENTINEL = 'SENTINEL_EXTERNAL_MUST_NOT_CHANGE\n';

/**
 * @returns {Promise<{
 *   base: string,
 *   outside: string,
 *   external: string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
async function makeArena() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aicb-fs-attack-'));
  const outside = path.join(base, 'outside');
  await mkdir(outside, { recursive: true });
  const external = path.join(outside, 'host-secret.txt');
  await writeFile(external, SENTINEL, 'utf8');
  return {
    base,
    outside,
    external,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} external
 */
async function assertExternalUnchanged(external) {
  const body = await readFile(external, 'utf8');
  assert.equal(body, SENTINEL, 'external target must be unchanged');
}

describe('campaign symlink / no-follow boundary', () => {
  it('rejects symlink campaign root before create/resume writes', async () => {
    if (process.platform === 'win32') return;
    const {
      assertCampaignFilesystemBoundary,
      ensurePrivateDirNoFollow,
      writeFileAtomicNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const realCamp = path.join(arena.base, 'real-camp');
      await mkdir(realCamp);
      const linkCamp = path.join(arena.base, 'link-camp');
      await symlink(arena.outside, linkCamp);

      await assert.rejects(
        () => assertCampaignFilesystemBoundary(linkCamp),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assert.rejects(
        () => ensurePrivateDirNoFollow(path.join(linkCamp, 'raw')),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assert.rejects(
        () =>
          writeFileAtomicNoFollow(
            path.join(linkCamp, 'report.json'),
            '{"pwned":true}\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('rejects intermediate ancestor symlink directories', async () => {
    if (process.platform === 'win32') return;
    const {
      assertCampaignFilesystemBoundary,
      mkdirpNoFollow,
      writeFileAtomicNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const parent = path.join(arena.base, 'parent');
      await mkdir(parent);
      const mid = path.join(parent, 'mid');
      // mid is a symlink directory pointing outside the campaign tree
      await symlink(arena.outside, mid);
      const camp = path.join(mid, 'campaign');

      await assert.rejects(
        () => assertCampaignFilesystemBoundary(camp),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assert.rejects(
        () => mkdirpNoFollow(path.join(camp, 'results')),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assert.rejects(
        () =>
          writeFileAtomicNoFollow(
            path.join(camp, 'summary.txt'),
            'pwned\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('loadManifest refuses pre-planted manifest.json symlink (fail closed)', async () => {
    if (process.platform === 'win32') return;
    const { createManifest, saveManifest, loadManifest, MANIFEST_FILENAME } =
      await import('../harness/manifest.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-load-manifest');
      await mkdir(camp);
      const manifest = createManifest({
        campaignId: 'camp-load-1',
        trials: [{ id: 't1', state: 'pending' }],
      });
      await saveManifest(camp, manifest);
      // Real load succeeds first.
      const ok = await loadManifest(camp);
      assert.equal(ok.campaignId, 'camp-load-1');

      // Resume-time preplant: replace leaf with symlink to external sentinel.
      await rm(path.join(camp, MANIFEST_FILENAME), { force: true });
      await symlink(arena.external, path.join(camp, MANIFEST_FILENAME));

      await assert.rejects(
        () => loadManifest(camp),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('readTrialResult / verify refuse pre-planted result.json symlink', async () => {
    if (process.platform === 'win32') return;
    const {
      ensurePrivateDir,
      readTrialResult,
      verifyTrialEvidenceDigests,
    } = await import('../harness/results.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-read-result');
      await mkdir(camp);
      await ensurePrivateDir(path.join(camp, 'results', 't1'));
      await symlink(
        arena.external,
        path.join(camp, 'results', 't1', 'result.json'),
      );

      await assert.rejects(
        () => readTrialResult(camp, 't1'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed|UNSAFE/i.test(String(err)),
      );

      const identity = {
        id: 't1',
        experimentId: 'exp1',
        arm: 'a',
        provider: 'p',
        taskId: 'task1',
        repetition: 0,
        scheduleSeed: 1,
        invocationPath: 'native-cli',
        requestedModel: 'm',
        postureFingerprint: 'fp',
      };
      // Verification loads result via readTrialResult when storedResult omitted.
      const v = await verifyTrialEvidenceDigests(camp, 't1', undefined, {
        manifestTrial: identity,
      });
      assert.equal(v.ok, false);
      assert.match(
        String(v.error || (v.mismatches || []).join(' ')),
        /symlink|fail closed|UNSAFE|read|missing|schema|identity|error/i,
      );

      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('saveManifest refuses pre-planted final and temp leaf symlinks', async () => {
    if (process.platform === 'win32') return;
    const { createManifest, saveManifest } = await import(
      '../harness/manifest.js'
    );
    const { MANIFEST_FILENAME, MANIFEST_TMP_FILENAME } = await import(
      '../harness/manifest.js'
    );
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-manifest');
      await mkdir(camp);

      const manifest = createManifest({
        campaignId: 'camp-manifest-1',
        trials: [{ id: 't1', state: 'pending' }],
      });

      // Final leaf symlink
      await symlink(
        arena.external,
        path.join(camp, MANIFEST_FILENAME),
      );
      await assert.rejects(
        () => saveManifest(camp, manifest),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );
      await assertExternalUnchanged(arena.external);

      // Clean final, plant predictable temp name (legacy attack surface)
      await rm(path.join(camp, MANIFEST_FILENAME), { force: true });
      await symlink(
        arena.external,
        path.join(camp, MANIFEST_TMP_FILENAME),
      );
      // Unpredictable temps mean legacy temp name is ignored; save must succeed
      // without writing through the planted temp symlink.
      const saved = await saveManifest(camp, manifest);
      assert.ok(saved.path.endsWith(MANIFEST_FILENAME));
      const st = await lstat(path.join(camp, MANIFEST_FILENAME));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      await assertExternalUnchanged(arena.external);
      // Planted temp symlink must still point at external and not have been opened
      const tmpSt = await lstat(path.join(camp, MANIFEST_TMP_FILENAME));
      assert.equal(tmpSt.isSymbolicLink(), true);
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('report/summary leaf symlinks are refused; external unchanged', async () => {
    if (process.platform === 'win32') return;
    const { writeFileAtomicNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-report');
      await mkdir(camp);
      await symlink(arena.external, path.join(camp, 'report.json'));
      await symlink(arena.external, path.join(camp, 'summary.txt'));

      await assert.rejects(
        () =>
          writeFileAtomicNoFollow(
            path.join(camp, 'report.json'),
            '{"ok":false}\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );
      await assert.rejects(
        () =>
          writeFileAtomicNoFollow(
            path.join(camp, 'summary.txt'),
            'pwned summary\n',
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('request/output/result leaf symlinks refuse private writes', async () => {
    if (process.platform === 'win32') return;
    const { writePrivateFile, ensurePrivateDir, writeTrialResult } =
      await import('../harness/results.js');
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-io');
      await mkdir(camp);
      const art = path.join(camp, 'artifacts', 't1');
      const res = path.join(camp, 'results', 't1');
      const raw = path.join(camp, 'raw', 't1');
      await ensurePrivateDir(art);
      await ensurePrivateDir(res);
      await ensurePrivateDir(raw);

      await symlink(arena.external, path.join(art, 'request.json'));
      await symlink(arena.external, path.join(art, 'output.json'));
      await symlink(arena.external, path.join(raw, 'stdout.txt'));
      await symlink(arena.external, path.join(res, 'result.json'));

      await assert.rejects(
        () => writePrivateFile(path.join(art, 'request.json'), '{"p":1}\n'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );
      await assert.rejects(
        () => writePrivateFile(path.join(art, 'output.json'), '{"o":1}\n'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );
      await assert.rejects(
        () => writePrivateFile(path.join(raw, 'stdout.txt'), 'stdout-pwn\n'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      const identity = {
        id: 't1',
        experimentId: 'exp1',
        arm: 'a',
        provider: 'p',
        taskId: 'task1',
        repetition: 0,
        scheduleSeed: 1,
        invocationPath: 'native-cli',
        requestedModel: 'm',
        postureFingerprint: 'fp',
      };
      await assert.rejects(
        () =>
          writeTrialResult(
            camp,
            't1',
            {
              ...identity,
              state: 'completed',
              classification: 'PASS',
              digests: {},
              resolvedModel: null,
              resolvedModelAvailable: false,
              resolvedModelSource: 'unavailable',
            },
            { manifestTrial: identity },
          ),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('resume-time preplanting: quarantine and manifest refuse leaf symlinks', async () => {
    if (process.platform === 'win32') return;
    const { quarantineRawOutput, ensurePrivateDir } = await import(
      '../harness/results.js'
    );
    const { createManifest, saveManifest, loadManifest } = await import(
      '../harness/manifest.js'
    );
    const { UnsafePathError } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-resume');
      await mkdir(camp);

      // First create a real campaign, then pre-plant leaf symlinks as if an
      // attacker prepared the tree between pause and resume.
      const manifest = createManifest({
        campaignId: 'camp-resume-1',
        trials: [{ id: 't1', state: 'pending' }],
      });
      await saveManifest(camp, manifest);
      const loaded = await loadManifest(camp);
      assert.equal(loaded.campaignId, 'camp-resume-1');

      // Pre-plant result + raw + report leaves as symlinks to external.
      await ensurePrivateDir(path.join(camp, 'raw', 't1'));
      await ensurePrivateDir(path.join(camp, 'results', 't1'));
      await symlink(arena.external, path.join(camp, 'raw', 't1', 'stdout.txt'));
      await symlink(arena.external, path.join(camp, 'raw', 't1', 'stderr.txt'));
      await symlink(arena.external, path.join(camp, 'raw', 't1', 'output.json'));
      await symlink(arena.external, path.join(camp, 'raw', 't1', 'meta.json'));
      await symlink(
        arena.external,
        path.join(camp, 'results', 't1', 'result.json'),
      );
      await symlink(arena.external, path.join(camp, 'report.json'));
      await symlink(arena.external, path.join(camp, 'summary.txt'));
      // Replace real manifest with a leaf symlink (resume-time preplant).
      await rm(path.join(camp, 'manifest.json'), { force: true });
      await symlink(arena.external, path.join(camp, 'manifest.json'));

      // Resume load must refuse planted final leaf symlink (nofollow).
      await assert.rejects(
        () => loadManifest(camp),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Resume write of manifest must refuse planted final leaf symlink.
      await assert.rejects(
        () => saveManifest(camp, loaded),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Quarantine must not follow raw leaf symlinks (stdout write fails closed).
      await assert.rejects(
        () =>
          quarantineRawOutput(camp, 't1', {
            stdout: 'legit\n',
            stderr: '',
          }),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Result read must refuse planted result.json leaf symlink.
      const { readTrialResult } = await import('../harness/results.js');
      await assert.rejects(
        () => readTrialResult(camp, 't1'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('revalidation race: dest swapped to symlink before rename is refused', async () => {
    if (process.platform === 'win32') return;
    const {
      revalidateBeforeRename,
      writeFileAtomicNoFollow,
      ensurePrivateDirNoFollow,
      randomTempPath,
      safeOpenExclusiveWriteFlags,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-race');
      await ensurePrivateDirNoFollow(camp);
      const dest = path.join(camp, 'report.json');

      // Simulate exclusive temp write then race that plants a dest symlink.
      const tmp = randomTempPath(camp);
      const flags = safeOpenExclusiveWriteFlags();
      const handle = await open(tmp, flags, 0o600);
      try {
        await handle.write(Buffer.from('NEW_CONTENT\n', 'utf8'));
        await handle.sync().catch(() => {});
      } finally {
        await handle.close();
      }

      // Race: destination becomes a symlink to external.
      await symlink(arena.external, dest);

      await assert.rejects(
        () => revalidateBeforeRename(camp, dest),
        (err) =>
          err instanceof UnsafePathError &&
          (err.code === 'SYMLINK_DEST' || /symlink/i.test(err.message)),
      );

      // Full atomic path also refuses when dest is already a symlink.
      await assert.rejects(
        () => writeFileAtomicNoFollow(dest, 'OTHER\n'),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Rename must not be performed when revalidation fails — clean up temp.
      await rm(tmp, { force: true });
      await assertExternalUnchanged(arena.external);

      // Control: after removing symlink, atomic write succeeds as regular file.
      await rm(dest, { force: true });
      await writeFileAtomicNoFollow(dest, 'SAFE\n');
      const st = await lstat(dest);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(await readFile(dest, 'utf8'), 'SAFE\n');
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('mkdirpNoFollow never follows a pre-existing symlink directory component', async () => {
    if (process.platform === 'win32') return;
    const { mkdirpNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-mkdir');
      await mkdir(camp);
      // Plant raw as symlink-to-outside before recursive create of raw/t1
      await symlink(arena.outside, path.join(camp, 'raw'));

      await assert.rejects(
        () => mkdirpNoFollow(path.join(camp, 'raw', 't1')),
        (err) =>
          err instanceof UnsafePathError ||
          /symlink|fail closed/i.test(String(err)),
      );

      // Outside must not have gained a t1 directory from followed mkdir.
      const outsideListing = await readdir(arena.outside);
      assert.ok(
        !outsideListing.includes('t1'),
        'must not create directories through symlink (outside polluted)',
      );
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('runCampaign refuses symlink campaign root at boundary stage', async () => {
    if (process.platform === 'win32') return;
    const { runCampaign } = await import('../harness/run.js');
    const arena = await makeArena();
    try {
      const linkCamp = path.join(arena.base, 'link-run-camp');
      await symlink(arena.outside, linkCamp);

      const result = await runCampaign({
        experiment: {
          id: 'exp-symlink-root',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: ['greenfield-003-js-event-emitter'],
          repetitions: 1,
          seed: 3,
          timeoutMs: 5_000,
          arms: [
            {
              name: 'fake',
              provider: 'fake',
              model: 'none',
              invocationPath: 'native-cli',
              command: 'true',
            },
          ],
        },
        corpusRoot: path.resolve('benchmarks', 'cli-comparison'),
        campaignDir: linkCamp,
        resume: false,
        execute: false,
      });
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'campaign-boundary');
      const errText = (result.errors || []).join(' ');
      assert.match(errText, /campaign root is a symlink|symlink/i);
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });

  it('happy path: atomic private write creates regular file, not symlink', async () => {
    if (process.platform === 'win32') return;
    const {
      writeFileAtomicNoFollow,
      ensurePrivateDirNoFollow,
      assertCampaignFilesystemBoundary,
    } = await import('../harness/safe-fs.js');
    const { saveManifest, createManifest, loadManifest } = await import(
      '../harness/manifest.js'
    );
    const arena = await makeArena();
    try {
      const camp = path.join(arena.base, 'camp-happy');
      const root = await assertCampaignFilesystemBoundary(camp);
      await ensurePrivateDirNoFollow(root);
      await ensurePrivateDirNoFollow(path.join(root, 'results'));

      await writeFileAtomicNoFollow(
        path.join(root, 'report.json'),
        '{"ok":true}\n',
      );
      await writeFileAtomicNoFollow(path.join(root, 'summary.txt'), 'ok\n');

      const m = createManifest({
        campaignId: 'camp-happy-1',
        trials: [{ id: 't1', state: 'pending' }],
      });
      await saveManifest(root, m);
      const loaded = await loadManifest(root);
      assert.equal(loaded.campaignId, 'camp-happy-1');

      for (const name of ['report.json', 'summary.txt', 'manifest.json']) {
        const st = await lstat(path.join(root, name));
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.isFile(), true);
      }
      await assertExternalUnchanged(arena.external);
    } finally {
      await arena.cleanup();
    }
  });
});
