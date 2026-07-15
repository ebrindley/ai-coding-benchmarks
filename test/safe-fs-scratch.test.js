/**
 * Adversarial symlink-swap: provider replaces scratch request/output with a
 * symlink to a host sentinel; trusted harness must never copy sentinel bytes
 * into campaign artifacts/raw/results.
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
  readdir,
} from 'node:fs/promises';

describe('safe scratch nofollow', () => {
  it('readFileNoFollow / copyFileNoFollow refuse symlinks (fail closed)', async () => {
    if (process.platform === 'win32') return;
    const {
      readFileNoFollow,
      copyFileNoFollow,
      UnsafePathError,
    } = await import('../harness/safe-fs.js');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-safe-'));
    try {
      const secret = path.join(dir, 'host-secret.txt');
      await writeFile(secret, 'SENTINEL_HOST_SECRET_BYTES\n', 'utf8');
      const link = path.join(dir, 'swapped.json');
      await symlink(secret, link);

      await assert.rejects(
        () => readFileNoFollow(link),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|UNSAFE|follow/i.test(String(err)),
      );

      const dest = path.join(dir, 'dest.json');
      await assert.rejects(
        () => copyFileNoFollow(link, dest),
        (err) =>
          err instanceof UnsafePathError ||
          err?.code === 'ELOOP' ||
          /symlink|UNSAFE|follow/i.test(String(err)),
      );

      // Regular file still works
      const reg = path.join(dir, 'ok.json');
      await writeFile(reg, '{"ok":true}\n', 'utf8');
      const buf = await readFileNoFollow(reg);
      assert.equal(buf.toString('utf8'), '{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantine and run post-copy never ingest symlink-swapped sentinel', async () => {
    if (process.platform === 'win32') return;
    const { quarantineRawOutput } = await import('../harness/results.js');
    const { writePrivateFile, ensurePrivateDir } = await import(
      '../harness/results.js'
    );
    const { readFileNoFollow, UnsafePathError } = await import(
      '../harness/safe-fs.js'
    );

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-sym-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-ws-sym-'));
    try {
      const hostSecret = path.join(os.tmpdir(), `aicb-host-secret-${Date.now()}.txt`);
      await writeFile(hostSecret, 'SENTINEL_SHOULD_NEVER_LAND\n', 'utf8');

      const scratch = path.join(workspace, '.aicb-scratch');
      await ensurePrivateDir(scratch);
      const scratchOut = path.join(scratch, 'output.json');
      // Provider-style attack: replace output with symlink to host secret
      await symlink(hostSecret, scratchOut);

      // Quarantine must refuse to follow the symlink
      const q = await quarantineRawOutput(campaign, 't1', {
        stdout: 'legit-stdout\n',
        stderr: '',
        outputPath: scratchOut,
      });
      // output.json should be missing or not contain sentinel
      let rawListing = await readdir(path.join(campaign, 'raw', 't1'));
      assert.ok(rawListing.includes('output-missing.txt') || !rawListing.includes('output.json'));
      if (rawListing.includes('output.json')) {
        const body = await readFile(
          path.join(campaign, 'raw', 't1', 'output.json'),
          'utf8',
        );
        assert.ok(!body.includes('SENTINEL_SHOULD_NEVER_LAND'));
      }
      // stdout should be the legitimate harness-captured stream only
      const stdout = await readFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'utf8',
      );
      assert.equal(stdout, 'legit-stdout\n');
      assert.ok(!stdout.includes('SENTINEL'));

      // Campaign artifact copy path (simulate run.js) refuses symlink
      const artDir = path.join(campaign, 'artifacts', 't1');
      await ensurePrivateDir(artDir);
      const dest = path.join(artDir, 'output.json');
      await assert.rejects(
        () => readFileNoFollow(scratchOut).then((b) => writePrivateFile(dest, b)),
        (err) => err instanceof UnsafePathError || /symlink|UNSAFE|ELOOP/i.test(String(err)),
      );
      // dest must not exist with sentinel
      let artFiles = [];
      try {
        artFiles = await readdir(artDir);
      } catch {
        artFiles = [];
      }
      if (artFiles.includes('output.json')) {
        const artBody = await readFile(dest, 'utf8');
        assert.ok(!artBody.includes('SENTINEL_SHOULD_NEVER_LAND'));
      }

      // results.json must not contain sentinel either
      const { writeTrialResult, buildTrialDigests, computeResultDigest } =
        await import('../harness/results.js');
      await writeTrialResult(campaign, 't1', {
        id: 't1',
        classification: 'INFRA_FAIL',
        digests: {
          resultDigest: computeResultDigest({
            classification: 'INFRA_FAIL',
            gateResults: [],
            exitCode: null,
          }),
          rawEvidenceUnavailable: true,
        },
      });
      const resultText = await readFile(
        path.join(campaign, 'results', 't1', 'result.json'),
        'utf8',
      );
      assert.ok(!resultText.includes('SENTINEL_SHOULD_NEVER_LAND'));

      await rm(hostSecret, { force: true });
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
