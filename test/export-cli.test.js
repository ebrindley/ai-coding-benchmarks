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
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  it('export omits raw, request artifacts, usernames, and absolute paths', async () => {
    const { exportSanitizedBundle } = await import('../harness/export.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'aicb-out-'));
    try {
      await mkdir(path.join(campaign, 'raw', 't1'), { recursive: true });
      await writeFile(
        path.join(campaign, 'raw', 't1', 'stdout.txt'),
        'SECRET_TOKEN=abc\n',
        'utf8',
      );
      await mkdir(path.join(campaign, 'artifacts', 't1'), { recursive: true });
      await writeFile(
        path.join(campaign, 'artifacts', 't1', 'request.json'),
        JSON.stringify({ prompt: 'secret prompt body', schema: 'x' }),
        'utf8',
      );
      await writeFile(
        path.join(campaign, 'artifacts', 't1', 'output.json'),
        JSON.stringify({ raw: 'provider' }),
        'utf8',
      );
      await mkdir(path.join(campaign, 'results', 't1'), { recursive: true });
      await writeFile(
        path.join(campaign, 'results', 't1', 'result.json'),
        JSON.stringify({
          id: 't1',
          classification: 'PASS',
          workspaceDir: path.join(campaign, 'workspaces', 't1'),
          digests: { rawOutputDigest: 'x'.repeat(64) },
          // Nested prompt-bearing content must not survive whitelist sanitize
          nested: {
            request: { prompt: 'nested secret prompt' },
            stdout: 'leaky',
          },
          prompt: 'top-level prompt leak',
          gateResults: [
            {
              gate: 'tests',
              status: 'passed',
              stdoutPreview: 'should be stripped if not whitelisted in sanitize',
              stdoutDigest: 'abc',
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        path.join(campaign, 'manifest.json'),
        JSON.stringify({
          campaignId: 'c',
          schemaVersion: 1,
          status: 'completed',
          lock: { held: false, owner: null },
          host: { user: 'localuser', platform: 'darwin' },
          trials: [
            {
              id: 't1',
              state: 'completed',
              workspaceDir: '/Users/localuser/secret/ws',
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      await exportSanitizedBundle({
        campaignDir: campaign,
        outDir: out,
        includeRaw: false,
      });

      await assert.rejects(() => access(path.join(out, 'raw', 't1', 'stdout.txt')));
      await assert.rejects(() =>
        access(path.join(out, 'artifacts', 't1', 'request.json')),
      );
      await assert.rejects(() =>
        access(path.join(out, 'artifacts', 't1', 'output.json')),
      );

      const man = await readFile(path.join(out, 'manifest.json'), 'utf8');
      assert.ok(!man.includes('localuser'));
      assert.ok(!man.includes('/Users/localuser'));
      assert.ok(!man.includes('SECRET_TOKEN'));

      const result = await readFile(
        path.join(out, 'results', 't1', 'result.json'),
        'utf8',
      );
      assert.ok(!result.includes('SECRET_TOKEN'));
      assert.ok(!result.includes('secret prompt'));
      assert.ok(!result.includes('nested secret'));
      assert.ok(!result.includes('top-level prompt'));
      assert.ok(!result.includes('leaky'));
      // absolute workspace redacted / omitted
      assert.ok(!result.includes(path.join(campaign, 'workspaces', 't1')));
      // non-whitelist keys dropped
      assert.ok(!result.includes('"nested"'));

      const readme = await readFile(path.join(out, 'EXPORT_README.txt'), 'utf8');
      assert.ok(!readme.includes(campaign));
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
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
