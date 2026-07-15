/**
 * Capability isolation (execution workspaces outside campaign tree) and
 * fresh poetic-adapter result binding (requestId + secure outputPath prep).
 *
 * Honesty bound for isolation tests: filesystem-tree separation only —
 * not OS-level read isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  symlink,
  lstat,
  realpath,
  access,
} from 'node:fs/promises';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('capability isolation: workspaces outside campaign tree', () => {
  it('resolveExecutionRoot is under aicb-exec, not under campaign', async () => {
    const {
      resolveExecutionRoot,
      EXECUTION_TMP_PREFIX,
      assertWorkspaceOutsideCampaign,
      createIsolatedWorkspace,
      cleanupExecutionWorkspace,
    } = await import('../harness/workspace.js');
    const { PathEscapeError } = await import('../harness/paths.js');

    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-camp-iso-'));
    const baseTmp = await mkdtemp(path.join(os.tmpdir(), 'aicb-base-iso-'));
    try {
      const executionRoot = resolveExecutionRoot({
        campaignId: 'camp-safe-1',
        baseTmp,
      });
      assert.ok(executionRoot.includes(EXECUTION_TMP_PREFIX));
      assert.ok(executionRoot.includes('camp-safe-1'));
      assert.equal(
        path.resolve(executionRoot).startsWith(path.resolve(campaign) + path.sep),
        false,
      );

      // Fixture under a temp dir
      const fixture = path.join(baseTmp, 'fixture');
      await mkdir(fixture, { recursive: true });
      await writeFile(path.join(fixture, 'hello.txt'), 'hi\n', 'utf8');

      const created = await createIsolatedWorkspace({
        fixtureDir: fixture,
        workspaceRoot: executionRoot,
        campaignId: 'camp-safe-1',
        campaignDir: campaign,
        trialId: 'trial-1',
        gitSpawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      });

      assert.ok(created.workspaceDir);
      assert.equal(created.executionRoot, path.resolve(executionRoot));

      const W = await realpath(created.workspaceDir);
      const C = await realpath(campaign);

      // W is NOT under C
      assert.equal(W === C || W.startsWith(C + path.sep), false);

      // Walk .. from workspace; campaign must never appear as ancestor
      let cur = W;
      const root = path.parse(cur).root;
      while (cur !== root) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        assert.notEqual(parent, C, `ancestor ${parent} must not be campaign`);
        cur = parent;
      }

      await assertWorkspaceOutsideCampaign(created.workspaceDir, campaign);

      // Under-campaign workspace is rejected
      const under = path.join(campaign, 'workspaces', 'evil');
      await mkdir(under, { recursive: true });
      await assert.rejects(
        () => assertWorkspaceOutsideCampaign(under, campaign),
        (err) =>
          err instanceof PathEscapeError ||
          /under campaign|ancestor/i.test(String(err?.message ?? err)),
      );

      const cleaned = await cleanupExecutionWorkspace(created.workspaceDir, {
        executionRoot,
      });
      assert.equal(cleaned.removed, true);
      await assert.rejects(() => access(created.workspaceDir), /ENOENT/);
    } finally {
      await rm(campaign, { recursive: true, force: true });
      await rm(baseTmp, { recursive: true, force: true });
    }
  });

  it('runCampaign places workspaceRoot outside campaignDir', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-run-iso-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'iso-expand',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: ['greenfield-002-python-cli-csv-json'],
          repetitions: 1,
          seed: 1,
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
        corpusRoot: path.join(REPO, 'benchmarks'),
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: false,
      });
      assert.equal(result.ok, true);
      assert.ok(result.manifest?.workspaceRoot);
      const wr = path.resolve(result.manifest.workspaceRoot);
      const cd = await realpath(campaignDir).catch(() => path.resolve(campaignDir));
      assert.equal(wr === cd || wr.startsWith(cd + path.sep), false);
      assert.match(wr, /aicb-exec/);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });
});

describe('fresh adapter result binding', () => {
  it('rejects pre-written success artifact with wrong requestId', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bind-wrong-'));
    try {
      const {
        invokePoeticAdapter,
        POETIC_INVOKE_RESULT_SCHEMA,
      } = await import('../harness/invokers/index.js');

      // Fake poetic exits 0 without overwriting output (stale file would remain if not cleared).
      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
// Deliberately does not write --output (tests harness prep + binding).
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const artDir = path.join(dir, 'artifacts');
      await mkdir(artDir, { recursive: true, mode: 0o700 });
      const requestPath = path.join(artDir, 'req.json');
      const outputPath = path.join(artDir, 'out.json');

      // Pre-plant a full success artifact for a *different* requestId.
      await writeFile(
        outputPath,
        JSON.stringify({
          schema: POETIC_INVOKE_RESULT_SCHEMA,
          requestId: 'stale-other-request',
          outcome: { kind: 'success', reasonCode: 'planted' },
          model: { resolved: { availability: 'unavailable', reason: 'n/a' } },
        }),
        'utf8',
      );

      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'current-request-id',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
      });

      assert.equal(result.success, false);
      assert.notEqual(result.outcomeKind, 'success');
      // Either empty/cleared output fails parse, or requestId mismatch — never success.
      assert.ok(result.infraFailure);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects successful artifact written with mismatched requestId', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bind-mis-'));
    try {
      const { invokePoeticAdapter } = await import(
        '../harness/invokers/index.js'
      );

      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: 'wrong-id',
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: { resolved: { availability: 'unavailable', reason: 'n/a' } }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const requestPath = path.join(dir, 'req.json');
      const outputPath = path.join(dir, 'out.json');
      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'expected-id',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.success, false);
      assert.match(String(result.infraFailure), /requestId mismatch/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts matching requestId as success', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bind-ok-'));
    try {
      const { invokePoeticAdapter } = await import(
        '../harness/invokers/index.js'
      );

      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: { resolved: { availability: 'available', value: 'm1' } }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const requestPath = path.join(dir, 'req.json');
      const outputPath = path.join(dir, 'out.json');
      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'match-me',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.success, true);
      assert.equal(result.outcomeKind, 'success');
      assert.equal(result.infraFailure, undefined);
      const written = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(written.requestId, 'match-me');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlink output path (fail closed)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-bind-sym-'));
    try {
      const {
        invokePoeticAdapter,
        prepareFreshOutputPath,
      } = await import('../harness/invokers/index.js');

      const target = path.join(dir, 'planted-target.json');
      await writeFile(
        target,
        JSON.stringify({
          schema: 'poetic.provider.invoke.result.v1',
          requestId: 'via-symlink',
          outcome: { kind: 'success', reasonCode: 'planted' },
        }),
        'utf8',
      );

      const outputPath = path.join(dir, 'out.json');
      await symlink(target, outputPath);
      const st = await lstat(outputPath);
      assert.equal(st.isSymbolicLink(), true);

      const prep = await prepareFreshOutputPath(outputPath);
      assert.equal(prep.ok, false);
      assert.match(String(prep.infraFailure), /symlink/i);

      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath: path.join(dir, 'req.json'),
        outputPath,
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'current',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
      });

      assert.equal(result.success, false);
      assert.match(String(result.infraFailure), /symlink/i);
      // Symlink still present (we refuse to write through it)
      assert.equal((await lstat(outputPath)).isSymbolicLink(), true);
      // Planted target content unchanged
      const planted = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(planted.requestId, 'via-symlink');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
