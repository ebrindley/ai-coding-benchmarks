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

      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
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
        campaignDir,
        cwd: dir,
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
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
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
        campaignDir,
        cwd: dir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.success, false);
      assert.match(String(result.infraFailure), /requestId mismatch/i);
      // Invalid adapter evidence cleared — no model/artifact leakage
      assert.equal(result.parsedOutput, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.providerRawEvidence, 'unavailable');
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
const path = require('path');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'actual-provider-out\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), '');
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
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
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
        campaignDir,
        cwd: dir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.success, true);
      assert.equal(result.outcomeKind, 'success');
      assert.equal(result.infraFailure, undefined);
      assert.equal(result.providerRawEvidence, 'actual');
      assert.match(result.stdout, /actual-provider-out/);
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

      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
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
        campaignDir,
        cwd: dir,
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

  it('Poetic path contract: output.json → output.invoke-artifacts/<requestId>/; multi-dot; e2e ingest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-contract-'));
    try {
      const {
        expectedProviderRawPaths,
        resolveProviderRawArtifactsDirName,
        ingestProviderRawEvidence,
        invokePoeticAdapter,
        PROVIDER_RAW_ARTIFACTS_SUFFIX,
      } = await import('../harness/invokers/index.js');

      // Contract: /tmp/.../output.json → .../output.invoke-artifacts/<requestId>/
      const outputPath = path.join(dir, 'scratch', 'output.json');
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      assert.equal(
        resolveProviderRawArtifactsDirName(outputPath),
        `output${PROVIDER_RAW_ARTIFACTS_SUFFIX}`,
      );
      const paths = expectedProviderRawPaths(outputPath, 'req-contract-1');
      assert.ok(!('error' in paths));
      assert.equal(paths.artifactsDirName, 'output.invoke-artifacts');
      assert.equal(
        paths.dir,
        path.join(dir, 'scratch', 'output.invoke-artifacts', 'req-contract-1'),
      );
      assert.equal(
        paths.stdoutPath,
        path.join(
          dir,
          'scratch',
          'output.invoke-artifacts',
          'req-contract-1',
          'stdout.txt',
        ),
      );
      // Must NOT use the stale generic invoke-artifacts/ layout
      assert.ok(!paths.dir.includes(`${path.sep}invoke-artifacts${path.sep}`));
      assert.ok(paths.dir.includes('output.invoke-artifacts'));

      // Multi-dot .json: only trailing .json stripped (not path.extname)
      const multi = path.join(dir, 'scratch', 'foo.bar.json');
      assert.equal(
        resolveProviderRawArtifactsDirName(multi),
        'foo.bar.invoke-artifacts',
      );
      const multiPaths = expectedProviderRawPaths(multi, 'rid-2');
      assert.ok(!('error' in multiPaths));
      assert.equal(
        multiPaths.dir,
        path.join(dir, 'scratch', 'foo.bar.invoke-artifacts', 'rid-2'),
      );

      // Non-.json extension is NOT stripped
      const txt = path.join(dir, 'scratch', 'foo.txt');
      assert.equal(
        resolveProviderRawArtifactsDirName(txt),
        'foo.txt.invoke-artifacts',
      );

      // Case-insensitive .json strip
      assert.equal(
        resolveProviderRawArtifactsDirName(path.join(dir, 'out.JSON')),
        'out.invoke-artifacts',
      );

      // No-extension basename
      const noExt = path.join(dir, 'scratch', 'payload');
      assert.equal(
        resolveProviderRawArtifactsDirName(noExt),
        'payload.invoke-artifacts',
      );

      // End-to-end: fake Poetic writes under output.invoke-artifacts/<id>/
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      await writeFile(paths.stdoutPath, 'CONTRACT_STDOUT\n', 'utf8');
      await writeFile(paths.stderrPath, 'CONTRACT_STDERR\n', 'utf8');
      const ingested = await ingestProviderRawEvidence(
        outputPath,
        'req-contract-1',
      );
      assert.equal(ingested.ok, true);
      assert.equal(ingested.stdout, 'CONTRACT_STDOUT\n');
      assert.equal(ingested.stderr, 'CONTRACT_STDERR\n');

      const bin = path.join(dir, 'fake-poetic-contract');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const reqPath = args[args.indexOf('--request') + 1];
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const base = path.basename(path.resolve(out));
const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -5) : base;
const rawDir = path.join(path.dirname(path.resolve(out)), stem + '.invoke-artifacts', req.requestId);
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(rawDir, 'stdout.txt'), 'E2E_CONTRACT_OUT\\n');
fs.writeFileSync(path.join(rawDir, 'stderr.txt'), 'E2E_CONTRACT_ERR\\n');
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: { resolved: { availability: 'available', value: 'm-contract' } }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);
      const campaignDir = path.join(dir, '_camp');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const e2eOut = path.join(dir, 'scratch', 'output.json');
      const e2e = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath: path.join(dir, 'scratch', 'request.json'),
        outputPath: e2eOut,
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'e2e-req',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(e2e.success, true, e2e.infraFailure);
      assert.equal(e2e.providerRawEvidence, 'actual');
      assert.match(e2e.stdout, /E2E_CONTRACT_OUT/);
      assert.match(e2e.stderr, /E2E_CONTRACT_ERR/);
      // Confirm bytes lived under the contract path, not invoke-artifacts/
      const contractStdout = await readFile(
        path.join(
          dir,
          'scratch',
          'output.invoke-artifacts',
          'e2e-req',
          'stdout.txt',
        ),
        'utf8',
      );
      assert.match(contractStdout, /E2E_CONTRACT_OUT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ingests actual provider raw; rejects escape/symlink/wrong-requestId; clears model on bind fail', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-raw-path-'));
    try {
      const {
        invokePoeticAdapter,
        expectedProviderRawPaths,
        ingestProviderRawEvidence,
        bindInvokeResultToRequestId,
        parseInvokeResult,
      } = await import('../harness/invokers/index.js');

      const outputPath = path.join(dir, 'scratch', 'output.json');
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const paths = expectedProviderRawPaths(outputPath, 'req-raw-1');
      assert.ok(!('error' in paths));
      assert.equal(
        paths.stdoutPath,
        path.join(
          dir,
          'scratch',
          'output.invoke-artifacts',
          'req-raw-1',
          'stdout.txt',
        ),
      );

      // Valid ingest
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      await writeFile(paths.stdoutPath, 'REAL_PROVIDER_STDOUT\n', 'utf8');
      await writeFile(paths.stderrPath, 'REAL_PROVIDER_STDERR\n', 'utf8');
      const ok = await ingestProviderRawEvidence(outputPath, 'req-raw-1');
      assert.equal(ok.ok, true);
      assert.equal(ok.stdout, 'REAL_PROVIDER_STDOUT\n');
      assert.equal(ok.stderr, 'REAL_PROVIDER_STDERR\n');

      // Wrong requestId directory is not accepted for this id
      const wrongId = await ingestProviderRawEvidence(outputPath, 'other-id');
      assert.equal(wrongId.ok, false);
      assert.equal(wrongId.unavailable, true);

      // Symlink final path attack
      const hostSecret = path.join(dir, 'host-secret.txt');
      await writeFile(hostSecret, 'EXFIL\n', 'utf8');
      await rm(paths.stdoutPath, { force: true });
      await symlink(hostSecret, paths.stdoutPath);
      const sym = await ingestProviderRawEvidence(outputPath, 'req-raw-1');
      assert.equal(sym.ok, false);
      assert.match(String(sym.error), /symlink|fail closed|UNSAFE/i);

      // Restore regular files
      await rm(paths.stdoutPath, { force: true });
      await writeFile(paths.stdoutPath, 'E2E_STDOUT\n', 'utf8');
      await writeFile(paths.stderrPath, 'E2E_STDERR\n', 'utf8');

      // Path escape via wrong requestId is rejected by id segment rules
      const escape = expectedProviderRawPaths(outputPath, '../escape');
      assert.ok('error' in escape);

      // bind clears artifact on mismatch so model cannot leak
      const stale = parseInvokeResult({
        schema: 'poetic.provider.invoke.result.v1',
        requestId: 'stale-model-id',
        outcome: { kind: 'success', reasonCode: 'ok' },
        model: {
          resolved: { availability: 'available', value: 'should-not-attribute' },
        },
      });
      assert.equal(stale.valid, true);
      assert.ok(stale.artifact);
      const bound = bindInvokeResultToRequestId(stale, 'current-id');
      assert.equal(bound.valid, false);
      assert.equal(bound.artifact, null);
      assert.equal(bound.success, false);

      // Full adapter: missing raw → no success
      const bin = path.join(dir, 'fake-poetic-noraw');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
const req = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', reasonCode: 'ok' },
  model: { resolved: { availability: 'available', value: 'm-x' } }
}));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);
      const campaignDir = path.join(dir, '_camp');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const noRaw = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath: path.join(dir, 'req-nr.json'),
        outputPath: path.join(dir, 'out-nr.json'),
        request: {
          schema: 'poetic.provider.invoke.request.v1',
          requestId: 'no-raw-req',
          provider: 'fake',
          prompt: 'x',
          workingDirectory: dir,
          timeoutMs: 1000,
        },
        timeoutMs: 10_000,
        campaignDir,
        cwd: dir,
      });
      assert.equal(noRaw.success, false);
      assert.equal(noRaw.providerRawEvidence, 'unavailable');
      assert.equal(noRaw.stdout, '');
      assert.equal(noRaw.stderr, '');
      assert.ok(noRaw.parsedOutput == null || noRaw.success === false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
