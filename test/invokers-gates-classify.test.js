/**
 * Fake Poetic invocation, gate confinement, classification, bridge model evidence,
 * system argv, structural gates, meaningful change counts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp,
  writeFile,
  chmod,
  rm,
  readFile,
  mkdir,
} from 'node:fs/promises';

describe('invokers + gates + classify', () => {
  it('parseResolvedModelEvidence handles bridge available/unavailable shapes', async () => {
    const { parseResolvedModelEvidence } = await import(
      '../harness/invokers/index.js'
    );

    const available = parseResolvedModelEvidence({
      model: {
        resolved: { availability: 'available', value: 'claude-sonnet-4' },
      },
    });
    assert.equal(available.available, true);
    assert.equal(available.resolvedModel, 'claude-sonnet-4');

    const unavailable = parseResolvedModelEvidence({
      model: {
        resolved: {
          availability: 'unavailable',
          reason: 'provider did not report model',
        },
      },
    });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.resolvedModel, null);
    assert.match(String(unavailable.reason), /provider did not report/i);

    // Never stringify the resolved object
    const bareObject = parseResolvedModelEvidence({
      model: { resolved: { availability: 'available' } },
    });
    assert.equal(bareObject.available, false);
    assert.equal(bareObject.resolvedModel, null);

    // Never accept bare string as model id (old incorrect shape)
    const bareString = parseResolvedModelEvidence({
      model: { resolved: 'should-not-use' },
    });
    assert.equal(bareString.available, false);
    assert.equal(bareString.resolvedModel, null);

    // Never invent from requested-model-shaped top-level fields
    const noFallback = parseResolvedModelEvidence({
      requestedModel: 'requested-only',
      model: { requested: 'requested-only' },
    });
    assert.equal(noFallback.available, false);
    assert.equal(noFallback.resolvedModel, null);
  });

  it('poetic-adapter request matches bridge contract and fake receives it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-poetic-'));
    try {
      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const reqIdx = args.indexOf('--request');
const outIdx = args.indexOf('--output');
if (reqIdx < 0 || outIdx < 0) { process.stderr.write('bad args'); process.exit(2); }
const reqPath = args[reqIdx + 1];
const out = args[outIdx + 1];
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
// Report modes seen at invoke time (request already written by harness with 0600).
const reqMode = fs.statSync(reqPath).mode & 0o777;
const outModeBefore = fs.existsSync(out) ? (fs.statSync(out).mode & 0o777) : null;
fs.writeFileSync(out, JSON.stringify({
  schema: 'poetic.provider.invoke.result.v1',
  requestId: req.requestId,
  outcome: { kind: 'success', reasonCode: 'ok' },
  receivedRequest: req,
  model: { resolved: { availability: 'available', value: 'resolved-from-provider' } },
  args,
  modes: { reqMode, outModeBefore }
}));
process.stdout.write('done');
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const {
        buildInvocationRequest,
        invokePoeticAdapter,
        parseResolvedModelEvidence,
        POETIC_INVOKE_REQUEST_SCHEMA,
      } = await import('../harness/invokers/index.js');
      const { stat } = await import('node:fs/promises');

      const workspaceDir = path.join(dir, 'ws');
      await mkdir(workspaceDir, { recursive: true });
      const request = buildInvocationRequest({
        arm: { provider: 'openai', model: 'gpt-test' },
        task: { description: 'do the thing' },
        workspaceDir,
        requestId: 'req-1',
        timeoutMs: 120_000,
      });

      assert.equal(request.schema, POETIC_INVOKE_REQUEST_SCHEMA);
      assert.equal(request.requestId, 'req-1');
      assert.equal('trialId' in request, false);
      assert.equal('workspace' in request, false);

      // Nested private parent dirs for request/output.
      const artDir = path.join(dir, 'artifacts', 't1');
      const requestPath = path.join(artDir, 'req.json');
      const outputPath = path.join(artDir, 'out.json');
      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request,
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.success, true);
      assert.equal(result.outcomeKind, 'success');
      assert.equal(result.reasonCode, 'ok');
      assert.equal(result.timedOut, false);
      assert.equal(result.infraFailure, undefined);

      const written = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(written.receivedRequest.schema, POETIC_INVOKE_REQUEST_SCHEMA);
      const evidence = parseResolvedModelEvidence(written);
      assert.equal(evidence.available, true);
      assert.equal(evidence.resolvedModel, 'resolved-from-provider');

      // Request created with 0600 at write time (posix).
      if (process.platform !== 'win32') {
        assert.equal(written.modes.reqMode, 0o600);
        assert.equal(written.modes.outModeBefore, 0o600);
        assert.equal((await stat(requestPath)).mode & 0o777, 0o600);
        assert.equal((await stat(artDir)).mode & 0o777, 0o700);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('poetic-adapter maps all bridge outcome kinds with CLI exit 0', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-poetic-out-'));
    try {
      const {
        invokePoeticAdapter,
        parseInvokeResult,
        POETIC_INVOKE_RESULT_SCHEMA,
        POETIC_OUTCOME_KINDS,
      } = await import('../harness/invokers/index.js');
      const { classifyTrial } = await import('../harness/classify.js');

      assert.deepEqual([...POETIC_OUTCOME_KINDS], [
        'success',
        'timeout',
        'provider_error',
        'refusal',
        'aborted',
        'internal_error',
      ]);

      /** @type {Record<string, { timedOut: boolean, success: boolean, classif: string }>} */
      const expectByKind = {
        success: { timedOut: false, success: true, classif: 'PASS' },
        timeout: { timedOut: true, success: false, classif: 'TIMEOUT' },
        provider_error: { timedOut: false, success: false, classif: 'INFRA_FAIL' },
        refusal: { timedOut: false, success: false, classif: 'INFRA_FAIL' },
        aborted: { timedOut: false, success: false, classif: 'INFRA_FAIL' },
        internal_error: { timedOut: false, success: false, classif: 'INFRA_FAIL' },
      };

      for (const kind of POETIC_OUTCOME_KINDS) {
        const bin = path.join(dir, `fake-poetic-${kind}`);
        await writeFile(
          bin,
          `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out, JSON.stringify({
  schema: ${JSON.stringify(POETIC_INVOKE_RESULT_SCHEMA)},
  requestId: 'r-${kind}',
  outcome: { kind: ${JSON.stringify(kind)}, reasonCode: 'rc-${kind}' },
  model: { resolved: { availability: 'unavailable', reason: 'n/a' } }
}));
process.exit(0);
`,
          'utf8',
        );
        await chmod(bin, 0o755);

        const requestPath = path.join(dir, `req-${kind}.json`);
        const outputPath = path.join(dir, `out-${kind}.json`);
        const result = await invokePoeticAdapter({
          poeticBin: bin,
          requestPath,
          outputPath,
          request: {
            schema: 'poetic.provider.invoke.request.v1',
            requestId: `r-${kind}`,
            provider: 'fake',
            prompt: 'x',
            workingDirectory: dir,
            timeoutMs: 1000,
          },
          timeoutMs: 10_000,
        });

        const exp = expectByKind[kind];
        assert.equal(result.exitCode, 0, kind);
        assert.equal(result.outcomeKind, kind, kind);
        assert.equal(result.reasonCode, `rc-${kind}`, kind);
        assert.equal(result.timedOut, exp.timedOut, kind);
        assert.equal(result.success, exp.success, kind);

        if (kind === 'success') {
          assert.equal(result.infraFailure, undefined, kind);
          assert.equal(result.providerFailure, undefined, kind);
        } else {
          // Non-success must never look like clean success
          assert.notEqual(result.success, true, kind);
          assert.ok(
            result.infraFailure || result.providerFailure || result.timedOut,
            `non-success ${kind} needs failure evidence`,
          );
        }

        if (kind === 'provider_error' || kind === 'refusal') {
          assert.ok(result.providerFailure, kind);
        }

        const parsed = parseInvokeResult(await readFile(outputPath, 'utf8'));
        assert.equal(parsed.valid, true, kind);
        assert.equal(parsed.outcomeKind, kind, kind);

        const classified = classifyTrial({
          invokerResult: result,
          gateResults: [],
          changedFileCount: 1,
          timedOut: false,
        });
        assert.equal(
          classified.classification,
          exp.classif,
          `${kind} → ${exp.classif} (got ${classified.classification}: ${classified.reason})`,
        );
      }

      // Invalid / missing outcome with exit 0 must not PASS
      const badBin = path.join(dir, 'fake-poetic-bad');
      await writeFile(
        badBin,
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out, JSON.stringify({ ok: true, notAResult: true }));
process.exit(0);
`,
        'utf8',
      );
      await chmod(badBin, 0o755);
      const badResult = await invokePoeticAdapter({
        poeticBin: badBin,
        requestPath: path.join(dir, 'req-bad.json'),
        outputPath: path.join(dir, 'out-bad.json'),
        request: { schema: 'x', requestId: 'b', provider: 'p', prompt: 'p', workingDirectory: dir, timeoutMs: 1 },
        timeoutMs: 10_000,
      });
      assert.equal(badResult.exitCode, 0);
      assert.equal(badResult.success, false);
      assert.ok(badResult.infraFailure);
      assert.equal(
        classifyTrial({
          invokerResult: badResult,
          gateResults: [],
          changedFileCount: 1,
          timedOut: false,
        }).classification,
        'INFRA_FAIL',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('poetic-system uses exact public argv including --in-place', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-psys-'));
    try {
      const bin = path.join(dir, 'fake-poetic');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const out = process.env.AICB_ARGV_OUT;
fs.writeFileSync(out, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);
      const argvOut = path.join(dir, 'argv.json');

      const {
        buildPoeticSystemArgv,
        invokePoeticSystem,
        timeoutMsToWholeMinutes,
      } = await import('../harness/invokers/poetic-system.js');

      assert.equal(timeoutMsToWholeMinutes(90_000), 2);
      const expected = buildPoeticSystemArgv({
        prompt: 'fix the bug',
        provider: 'anthropic',
        model: 'claude-x',
        timeoutMs: 90_000,
      });
      assert.deepEqual(expected, [
        'run',
        'fix the bug',
        '--provider',
        'anthropic',
        '--model',
        'claude-x',
        '--in-place',
        '--no-push',
        '--profile',
        'fast-local',
        '--timeout',
        '2',
      ]);

      const result = await invokePoeticSystem({
        poeticBin: bin,
        prompt: 'fix the bug',
        provider: 'anthropic',
        model: 'claude-x',
        timeoutMs: 90_000,
        cwd: dir,
        env: { ...process.env, AICB_ARGV_OUT: argvOut },
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.resolvedModel, null);
      const got = JSON.parse(await readFile(argvOut, 'utf8'));
      assert.deepEqual(got, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('workspace initializes non-protected run/aicb-* branch (injectable git)', async () => {
    const {
      initWorkspaceGit,
      trialBranchName,
    } = await import('../harness/workspace.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-git-'));
    try {
      /** @type {string[][]} */
      const log = [];
      const gitSpawn = async (args) => {
        log.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const trialId = 'arm__task__r1__abc';
      const result = await initWorkspaceGit(dir, { trialId, gitSpawn });
      assert.equal(result.branch, trialBranchName(trialId));
      assert.match(result.branch, /^run\/aicb-/);
      assert.ok(log.some((a) => a[0] === 'init'));
      const checkout = log.find((a) => a[0] === 'checkout' && a[1] === '-B');
      assert.ok(checkout);
      assert.equal(checkout[2], result.branch);
      // Branch is not a protected path name
      assert.ok(!result.branch.startsWith('main'));
      assert.ok(!result.branch.startsWith('master'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('meaningful change count excludes .poetic bookkeeping', async () => {
    const {
      countMeaningfulChangedFiles,
      parseChangedPaths,
      filterMeaningfulChangedPaths,
    } = await import('../harness/gates.js');
    const porcelain =
      ' M .poetic/telemetry.json\n M .poetic/run.log\n M src/app.js\n';
    const all = parseChangedPaths(porcelain);
    assert.ok(all.some((p) => p.startsWith('.poetic/')));
    const meaningful = filterMeaningfulChangedPaths(all);
    assert.deepEqual(meaningful, ['src/app.js']);
    assert.equal(countMeaningfulChangedFiles(porcelain), 1);
    assert.equal(
      countMeaningfulChangedFiles(' M .poetic/only.json\n'),
      0,
    );
  });

  it('native-cli refuses taskEnv smuggling', async () => {
    const { invokeNativeCli } = await import('../harness/invokers/native-cli.js');
    const result = await invokeNativeCli({
      command: 'true',
      args: [],
      taskEnv: { API_KEY: 'secret' },
    });
    assert.ok(result.infraFailure);
    assert.match(result.infraFailure, /taskEnv|refus/i);
  });

  it('native-cli delivers exact prompt via stdin (default transport)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-native-stdin-'));
    try {
      const bin = path.join(dir, 'fake-cli');
      const capture = path.join(dir, 'stdin.txt');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AICB_CAPTURE, chunks.join(''));
  process.exit(0);
});
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      const prompt =
        'exact task prompt\nwith "quotes" and $SHELL; rm -rf / && echo done';
      const result = await invokeNativeCli({
        command: bin,
        args: [],
        prompt,
        // default promptTransport is stdin
        env: { ...process.env, AICB_CAPTURE: capture },
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.promptTransport, 'stdin');
      assert.equal(await readFile(capture, 'utf8'), prompt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('native-cli delivers exact prompt via prompt-file transport and cleans up', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-native-pfile-'));
    try {
      const bin = path.join(dir, 'fake-cli');
      const capture = path.join(dir, 'from-file.txt');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
// harness appends absolute prompt path as final argv for prompt-file transport
const promptPath = process.argv[process.argv.length - 1];
const body = fs.readFileSync(promptPath, 'utf8');
fs.writeFileSync(process.env.AICB_CAPTURE, body);
fs.writeFileSync(process.env.AICB_PATH_CAPTURE, promptPath);
process.exit(0);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      const prompt = 'prompt-file body\nline2\n';
      const pathCap = path.join(dir, 'path.txt');
      const result = await invokeNativeCli({
        command: bin,
        args: ['--mode', 'edit'],
        prompt,
        promptTransport: 'prompt-file',
        env: {
          ...process.env,
          AICB_CAPTURE: capture,
          AICB_PATH_CAPTURE: pathCap,
        },
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.promptTransport, 'prompt-file');
      assert.equal(result.promptFileUsed, true);
      // Stale absolute path must not be returned after cleanup.
      assert.equal(result.promptFilePath, undefined);
      assert.equal(await readFile(capture, 'utf8'), prompt);
      // Child saw a real temp path while it ran; harness cleaned it up after.
      const usedPath = await readFile(pathCap, 'utf8');
      assert.ok(usedPath.includes('aicb-prompt-'));
      await assert.rejects(() => readFile(usedPath, 'utf8'), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('native-cli prompt-file cleans up temp dir on spawn failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-native-pfile-fail-'));
    try {
      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      // Capture temp path by wrapping a missing binary: child fails but prompt
      // file is still created first. Use a spy-like command that records argv
      // then exits via a wrapper that fails after reading path… simpler: use
      // a script that writes the path then the harness cleans up after spawn
      // returns (even with non-zero). Also test missing command infraFailure.
      const bin = path.join(dir, 'record-and-fail');
      const pathCap = path.join(dir, 'path.txt');
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require('fs');
const promptPath = process.argv[process.argv.length - 1];
fs.writeFileSync(process.env.AICB_PATH_CAPTURE, promptPath);
process.exit(1);
`,
        'utf8',
      );
      await chmod(bin, 0o755);

      const result = await invokeNativeCli({
        command: bin,
        args: [],
        prompt: 'secret-prompt-body',
        promptTransport: 'prompt-file',
        env: { ...process.env, AICB_PATH_CAPTURE: pathCap },
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.promptFileUsed, true);
      assert.equal(result.promptFilePath, undefined);
      const usedPath = await readFile(pathCap, 'utf8');
      await assert.rejects(() => readFile(usedPath, 'utf8'), /ENOENT/);

      // Spawn of non-existent command also cleans up (prompt written before spawn).
      // Use a path that cannot exist; prompt-file still creates temp then finally removes it.
      const missing = await invokeNativeCli({
        command: path.join(dir, 'definitely-missing-binary-xyz'),
        args: [],
        prompt: 'cleanup-on-spawn-fail',
        promptTransport: 'prompt-file',
        timeoutMs: 5_000,
      });
      assert.ok(missing.infraFailure || missing.exitCode !== 0);
      assert.equal(missing.promptFileUsed, true);
      assert.equal(missing.promptFilePath, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('native-cli rejects unknown promptTransport and task YAML env marker', async () => {
    const { invokeNativeCli } = await import(
      '../harness/invokers/native-cli.js'
    );
    const badTransport = await invokeNativeCli({
      command: 'true',
      args: [],
      prompt: 'x',
      promptTransport: 'shell-template',
    });
    assert.ok(badTransport.infraFailure);
    assert.match(badTransport.infraFailure, /promptTransport/i);

    const badEnv = await invokeNativeCli({
      command: 'true',
      args: [],
      env: Object.assign(Object.create(null), {
        PATH: '/usr/bin',
        __source: 'task-yaml',
      }),
    });
    assert.ok(badEnv.infraFailure);
    assert.match(badEnv.infraFailure, /task YAML/i);
  });

  it('gates fail closed when confinement unavailable', async () => {
    const { runGates } = await import('../harness/gates.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-'));
    try {
      const results = await runGates({
        gates: [
          {
            gate: 'tests',
            command: 'npm test',
            expectedExitCode: 0,
            order: 1,
            required: true,
          },
        ],
        workspaceDir: dir,
        oracleRoot: dir,
        confinement: { available: false, reason: 'test-forced-unavailable' },
      });
      assert.equal(results[0].status, 'execution_unavailable');
      assert.equal(results[0].classificationSignal, 'INFRA_FAIL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('buildGateEnv is minimal; credential allowlist names fail closed', async () => {
    const {
      buildGateEnv,
      normalizeEnvAllowlist,
      isCredentialLikeEnvKey,
      isRestrictiveSandboxMode,
      sanitizeGateResultsForStorage,
    } = await import('../harness/gates.js');

    assert.equal(isCredentialLikeEnvKey('AICB_SENTINEL_SECRET'), true);
    assert.equal(isCredentialLikeEnvKey('AWS_SECRET_ACCESS_KEY'), true);
    assert.equal(isCredentialLikeEnvKey('OPENAI_API_KEY'), true);
    assert.equal(isCredentialLikeEnvKey('GITHUB_TOKEN'), true);
    assert.equal(isCredentialLikeEnvKey('SSH_AUTH_SOCK'), true);
    assert.equal(isCredentialLikeEnvKey('ALLOWED_TOOL_FLAG'), false);
    assert.equal(isCredentialLikeEnvKey('CFLAGS'), false);

    const parent = {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
      LANG: 'C',
      USER: 'harness',
      AICB_SENTINEL_SECRET: 'super-secret-value-do-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-should-not-leak',
      OPENAI_API_KEY: 'sk-test',
      GITHUB_TOKEN: 'ghp_test',
      NODE_OPTIONS: 'should-not-leak',
      ALLOWED_TOOL_FLAG: 'ok-when-allowlisted',
    };

    const minimal = buildGateEnv({
      envAllowlist: [],
      sandboxMode: 'restrictive',
      parentEnv: parent,
    });
    assert.equal(minimal.PATH, '/usr/bin:/bin');
    assert.equal(minimal.HOME, '/tmp/home');
    assert.equal(minimal.AICB_SENTINEL_SECRET, undefined);
    assert.equal(minimal.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(minimal.OPENAI_API_KEY, undefined);
    assert.equal(minimal.NODE_OPTIONS, undefined);
    assert.equal(minimal.ALLOWED_TOOL_FLAG, undefined);
    assert.equal(minimal.LANG, undefined); // restrictive drops optional platform keys
    assert.ok(isRestrictiveSandboxMode('restrictive'));
    assert.ok(isRestrictiveSandboxMode('strict'));

    // Ordinary non-secret build flags may be allowlisted
    const withAllow = buildGateEnv({
      envAllowlist: ['ALLOWED_TOOL_FLAG'],
      sandboxMode: null,
      parentEnv: parent,
    });
    assert.equal(withAllow.ALLOWED_TOOL_FLAG, 'ok-when-allowlisted');
    assert.equal(withAllow.AICB_SENTINEL_SECRET, undefined);
    assert.equal(withAllow.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(withAllow.LANG, 'C');

    // Credential-like names in envAllowlist fail closed (even if arm asks)
    for (const bad of [
      'AICB_SENTINEL_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'SSH_AUTH_SOCK',
      'AUTHORIZATION',
      'MY_PASSWORD',
      'BEARER_TOKEN',
    ]) {
      assert.throws(
        () => normalizeEnvAllowlist([bad]),
        /credential|capability|envAllowlist/i,
      );
      assert.throws(
        () =>
          buildGateEnv({
            envAllowlist: ['ALLOWED_TOOL_FLAG', bad],
            parentEnv: parent,
          }),
        /credential|capability|envAllowlist/i,
      );
    }

    // Object-form allowlist uses keys only (non-secret)
    const objAllow = buildGateEnv({
      envAllowlist: { ALLOWED_TOOL_FLAG: 'ignored-value' },
      parentEnv: parent,
    });
    assert.equal(objAllow.ALLOWED_TOOL_FLAG, 'ok-when-allowlisted');
    assert.throws(
      () =>
        buildGateEnv({
          envAllowlist: { AWS_SECRET_ACCESS_KEY: 'x' },
          parentEnv: parent,
        }),
      /credential|capability|envAllowlist/i,
    );

    // sanitize strips previews
    const cleaned = sanitizeGateResultsForStorage([
      {
        gate: 'tests',
        status: 'passed',
        stdoutDigest: 'abc',
        stdoutPreview: 'SECRET in preview',
        stderrPreview: 'more secret',
      },
    ]);
    assert.equal(cleaned[0].stdoutDigest, 'abc');
    assert.equal(cleaned[0].stdoutPreview, undefined);
    assert.equal(cleaned[0].stderrPreview, undefined);
  });

  it('runGates refuses task YAML env injection and omits previews', async () => {
    const { runGates } = await import('../harness/gates.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-env-'));
    try {
      await assert.rejects(
        () =>
          runGates({
            gates: [{ gate: 'tests', command: 'true', order: 1, required: true }],
            workspaceDir: dir,
            confinement: { available: false, reason: 'forced' },
            task: { env: { API_KEY: 'nope' } },
          }),
        /must not inject environment/i,
      );

      const results = await runGates({
        gates: [
          {
            gate: 'tests',
            command: 'true',
            expectedExitCode: 0,
            order: 1,
            required: true,
          },
        ],
        workspaceDir: dir,
        confinement: { available: false, reason: 'forced' },
        envAllowlist: [],
        sandboxMode: 'restrictive',
        parentEnv: {
          PATH: process.env.PATH,
          AICB_SENTINEL_SECRET: 'should-not-reach-gate-process',
        },
      });
      assert.equal(results[0].status, 'execution_unavailable');
      assert.equal(results[0].stdoutPreview, undefined);
      assert.equal(results[0].stderrPreview, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sentinel and provider credentials never enter gate env (incl. network-allowed)', async () => {
    const {
      runGates,
      detectConfinement,
      buildGateEnv,
      normalizeEnvAllowlist,
      isCredentialLikeEnvKey,
    } = await import('../harness/gates.js');
    const SENTINEL = `aicb-sentinel-${Date.now()}-secret-value`;
    const parent = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      LANG: process.env.LANG || 'C',
      USER: process.env.USER,
      AICB_SENTINEL_SECRET: SENTINEL,
      AWS_SECRET_ACCESS_KEY: 'aws-leaked-if-present',
      OPENAI_API_KEY: 'sk-leaked-if-present',
      GITHUB_TOKEN: 'ghp-leaked-if-present',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      ALLOWED_TOOL_FLAG: 'build-flag-ok',
    };

    // Even when an arm requests credential names, fail closed — never admit them
    for (const bad of [
      'AICB_SENTINEL_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
    ]) {
      assert.equal(isCredentialLikeEnvKey(bad), true);
      assert.throws(
        () =>
          buildGateEnv({
            envAllowlist: [bad],
            parentEnv: parent,
          }),
        /credential|capability|envAllowlist/i,
      );
      assert.throws(() => normalizeEnvAllowlist([bad]), /credential|capability/i);
    }

    // Non-secret allowlist still works
    const okEnv = buildGateEnv({
      envAllowlist: ['ALLOWED_TOOL_FLAG'],
      sandboxMode: 'restrictive',
      parentEnv: parent,
    });
    assert.equal(okEnv.ALLOWED_TOOL_FLAG, 'build-flag-ok');
    assert.equal(okEnv.AICB_SENTINEL_SECRET, undefined);
    assert.equal(okEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(okEnv.OPENAI_API_KEY, undefined);
    assert.equal(okEnv.GITHUB_TOKEN, undefined);
    assert.equal(okEnv.SSH_AUTH_SOCK, undefined);
    assert.ok(!JSON.stringify(okEnv).includes(SENTINEL));
    assert.ok(!JSON.stringify(okEnv).includes('aws-leaked'));
    assert.ok(!JSON.stringify(okEnv).includes('sk-leaked'));
    assert.ok(!JSON.stringify(okEnv).includes('ghp-leaked'));

    // network-allowed posture uses the same fail-closed builder
    const netEnv = buildGateEnv({
      envAllowlist: ['ALLOWED_TOOL_FLAG'],
      sandboxMode: 'restrictive',
      parentEnv: parent,
    });
    assert.equal(netEnv.AICB_SENTINEL_SECRET, undefined);
    assert.ok(!JSON.stringify(netEnv).includes(SENTINEL));

    // runGates must not accept credential allowlist (throws before gate run)
    const dirThrow = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-cred-'));
    try {
      await assert.rejects(
        () =>
          runGates({
            gates: [
              {
                gate: 'tests',
                command: 'true',
                expectedExitCode: 0,
                order: 1,
                required: true,
              },
            ],
            workspaceDir: dirThrow,
            confinement: { available: false, reason: 'forced' },
            envAllowlist: ['OPENAI_API_KEY'],
            parentEnv: parent,
            task: { networkPolicy: { allowed: true } },
          }),
        /credential|capability|envAllowlist/i,
      );
    } finally {
      await rm(dirThrow, { recursive: true, force: true });
    }

    const confinement = await detectConfinement();
    if (!confinement.available) {
      return;
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-gate-sent-'));
    try {
      // Probe: fail if any of these credential names are present in the gate env.
      const results = await runGates({
        gates: [
          {
            gate: 'tests',
            command:
              'case "${AICB_SENTINEL_SECRET+set}${AWS_SECRET_ACCESS_KEY+set}${OPENAI_API_KEY+set}${GITHUB_TOKEN+set}${SSH_AUTH_SOCK+set}" in *set*) exit 1;; *) exit 0;; esac',
            expectedExitCode: 0,
            order: 1,
            required: true,
          },
        ],
        workspaceDir: dir,
        confinement,
        envAllowlist: ['ALLOWED_TOOL_FLAG'],
        sandboxMode: 'restrictive',
        parentEnv: parent,
        task: { networkPolicy: { allowed: true } },
        timeoutMs: 30_000,
      });
      assert.ok(results[0]);
      assert.equal(results[0].stdoutPreview, undefined);
      assert.equal(results[0].stderrPreview, undefined);
      if (results[0].exitCode === 0 || results[0].exitCode === 1) {
        assert.equal(
          results[0].status,
          'passed',
          `credential leaked into gate env: ${results[0].evidence}`,
        );
        assert.equal(results[0].exitCode, 0);
      } else {
        assert.notEqual(
          results[0].status,
          'passed',
          'infra/confinement failure must not be reported as PASS',
        );
      }
      const serialized = JSON.stringify(results[0]);
      assert.ok(!serialized.includes(SENTINEL));
      assert.ok(!serialized.includes('aws-leaked'));
      assert.ok(!serialized.includes('sk-leaked'));
      assert.ok(!serialized.includes('ghp-leaked'));
      assert.ok(!serialized.includes('/tmp/ssh-agent.sock'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('confinement policy rejects unrestricted reads and root binds', async () => {
    const {
      buildSeatbeltProfile,
      buildConfinedArgv,
      escapeSeatbeltPath,
    } = await import('../harness/gates.js');
    const ws = '/tmp/aicb-ws-example';
    const tmp = '/tmp/aicb-private-tmp';
    const roots = ['/usr', '/bin'];
    const profile = buildSeatbeltProfile(ws, tmp, false, roots);
    assert.match(profile, /\(deny default\)/);
    assert.doesNotMatch(profile, /\(allow default\)/);
    assert.doesNotMatch(profile, /(?:^|\n)\(allow file-read\*\)\s*(?:\n|$)/);
    assert.match(profile, new RegExp(escapeSeatbeltPath(ws)));
    assert.match(profile, /subpath "\/usr"/);
    // Paths with quotes must be escaped
    const nasty = buildSeatbeltProfile('/tmp/ws"x', '/tmp/t', false, []);
    assert.ok(nasty.includes('\\"') || !nasty.includes('ws"x'));

    assert.throws(
      () =>
        buildConfinedArgv(
          { available: true, kind: 'bwrap', binary: '/usr/bin/bwrap' },
          ws,
          'npm test',
          { networkAllowed: false, readRoots: [] },
        ),
      /toolchain|fail closed|roots/i,
    );

    const bwrap = buildConfinedArgv(
      { available: true, kind: 'bwrap', binary: '/usr/bin/bwrap' },
      ws,
      'npm test',
      { networkAllowed: false, readRoots: roots },
    );
    assert.ok(bwrap.args.includes('--ro-bind'));
    assert.ok(bwrap.args.includes('--unshare-net'));
    for (let i = 0; i < bwrap.args.length; i += 1) {
      if (bwrap.args[i] === '--ro-bind' || bwrap.args[i] === '--bind') {
        assert.notEqual(bwrap.args[i + 1], '/');
        assert.notEqual(bwrap.args[i + 2], '/');
      }
    }
    const cIdx = bwrap.args.indexOf('-c');
    assert.equal(bwrap.args[cIdx + 1], 'npm test');
  });

  it('requirements uses prior gate results: pass with tests, unavailable without', async () => {
    const { evaluateRequirements } = await import('../harness/gates.js');
    const task = {
      expectedOutcome: {
        mustHave: [
          {
            id: 'existing-tests-pass',
            description: 'tests pass',
            substantiation: 'test',
            artifactRef: 'npm test',
          },
        ],
      },
    };

    const withTests = await evaluateRequirements({
      gate: { gate: 'requirements', order: 5, required: true },
      task,
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
          exitCode: 0,
        },
      ],
    });
    assert.equal(withTests.status, 'passed');
    assert.equal(withTests.classificationSignal, 'PASS');

    const without = await evaluateRequirements({
      gate: { gate: 'requirements', order: 5, required: true },
      task,
      priorGateResults: [
        {
          gate: 'baseline-diff',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    assert.equal(without.status, 'execution_unavailable');
    assert.equal(without.classificationSignal, 'INFRA_FAIL');

    const staticOnly = await evaluateRequirements({
      gate: { gate: 'requirements', order: 5, required: true },
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'clock',
              description: 'static check',
              substantiation: 'static',
              artifactRef: 'scripts/check.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    // No explicit evidenceGate → unavailable, not silent PASS via tests
    assert.equal(staticOnly.status, 'execution_unavailable');
    assert.match(String(staticOnly.evidence), /evidenceGate|oraclePath/i);
  });

  it('evaluateRequirements explicit evidence binding: pass/fail/unavailable', async () => {
    const { evaluateRequirements } = await import('../harness/gates.js');
    const reqGate = { gate: 'requirements', order: 9, required: true };

    // PASS: test + static each bound to their declared gates
    const passBoth = await evaluateRequirements({
      gate: reqGate,
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'tests-pass',
              description: 'tests',
              substantiation: 'test',
              evidenceGate: 'tests',
              artifactRef: 'npm test',
            },
            {
              id: 'clock-injection',
              description: 'static',
              substantiation: 'static',
              evidenceGate: 'clock-injection',
              artifactRef: 'scripts/check-clock-injection.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
        {
          gate: 'clock-injection',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    assert.equal(passBoth.status, 'passed');

    // FAIL: bound evidence gate ran and failed
    const failStatic = await evaluateRequirements({
      gate: reqGate,
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'clock-injection',
              description: 'static',
              substantiation: 'static',
              evidenceGate: 'clock-injection',
              artifactRef: 'scripts/check-clock-injection.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'clock-injection',
          required: true,
          status: 'failed',
          classificationSignal: 'FAIL',
        },
      ],
    });
    assert.equal(failStatic.status, 'failed');
    assert.equal(failStatic.classificationSignal, 'FAIL');

    // UNAVAILABLE: test substantiation missing artifactRef
    const missingRef = await evaluateRequirements({
      gate: reqGate,
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'bare-test',
              description: 'no artifact',
              substantiation: 'test',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    assert.equal(missingRef.status, 'execution_unavailable');
    assert.match(String(missingRef.evidence), /artifactRef/);

    // UNAVAILABLE: static must not be substantiated by an arbitrary passed tests gate
    const noSilentTests = await evaluateRequirements({
      gate: reqGate,
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'clock',
              description: 'static',
              substantiation: 'static',
              // deliberate: no evidenceGate — old substring would wrongly match nothing or "static"
              artifactRef: 'scripts/check.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'tests',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
        {
          gate: 'static-linter',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
        },
      ],
    });
    assert.equal(noSilentTests.status, 'execution_unavailable');
    // Must NOT silently pass via substring match on "static-linter"
    assert.notEqual(noSilentTests.status, 'passed');

    // PASS via oraclePath explicit binding
    const oracleBind = await evaluateRequirements({
      gate: reqGate,
      task: {
        expectedOutcome: {
          mustHave: [
            {
              id: 'consumer',
              description: 'oracle',
              substantiation: 'static',
              oraclePath: 'task-x/check.js',
              artifactRef: 'oracles/task-x/check.js',
            },
          ],
        },
      },
      priorGateResults: [
        {
          gate: 'oracle',
          required: true,
          status: 'passed',
          classificationSignal: 'PASS',
          oraclePath: 'task-x/check.js',
        },
      ],
    });
    assert.equal(oracleBind.status, 'passed');
  });

  it('commandless oracle path resolves under oracleRoot; confinement unavailable fails closed', async () => {
    const {
      runGates,
      buildOracleCommand,
      resolveCommandlessOraclePath,
      evaluateOracleGate,
      buildGateEnv,
    } = await import('../harness/gates.js');
    const { PathEscapeError } = await import('../harness/paths.js');

    const oracleRoot = await mkdtemp(path.join(os.tmpdir(), 'aicb-oracles-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aicb-ows-'));
    try {
      const scriptDir = path.join(oracleRoot, 'demo-task');
      await mkdir(scriptDir, { recursive: true });
      const scriptRel = 'demo-task/check-ok.js';
      await writeFile(
        path.join(oracleRoot, scriptRel),
        'process.exit(0);\n',
        'utf8',
      );

      const abs = await resolveCommandlessOraclePath(oracleRoot, scriptRel);
      // macOS: resolveUnder may realpath /var -> /private/var; compare canonically
      const { isPathInside } = await import('../harness/paths.js');
      let rootCanon = path.resolve(oracleRoot);
      try {
        const { realpath } = await import('node:fs/promises');
        rootCanon = await realpath(rootCanon);
      } catch {
        /* keep resolved */
      }
      assert.ok(
        isPathInside(rootCanon, abs) || abs.startsWith(rootCanon + path.sep) || abs === rootCanon,
        `oracle abs ${abs} must be under ${rootCanon}`,
      );
      assert.match(buildOracleCommand(abs), /^node '/);

      await assert.rejects(
        () => resolveCommandlessOraclePath(oracleRoot, '../escape.js'),
        (err) => err instanceof PathEscapeError || /escape|outside/i.test(String(err)),
      );
      await assert.rejects(
        () =>
          resolveCommandlessOraclePath(oracleRoot, '/abs/oracle.js'),
        /absolute/i,
      );

      // Confinement unavailable → execution_unavailable (never silent PASS)
      const results = await runGates({
        gates: [
          {
            gate: 'oracle',
            oraclePath: scriptRel,
            order: 1,
            required: true,
            check: 'demo oracle',
          },
        ],
        workspaceDir: workspace,
        oracleRoot,
        confinement: { available: false, reason: 'test-forced-unavailable', kind: null, binary: null },
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'execution_unavailable');
      assert.equal(results[0].classificationSignal, 'INFRA_FAIL');
      assert.equal(results[0].oraclePath, scriptRel);
      assert.match(String(results[0].command), /node/);

      // Missing oraclePath commandless → unavailable
      const missing = await evaluateOracleGate({
        workspaceDir: workspace,
        gate: { gate: 'oracle', order: 1, required: true },
        oracleRoot,
        confinement: { available: false, reason: 'x', kind: null, binary: null },
        env: buildGateEnv({ parentEnv: { PATH: '/usr/bin:/bin' } }),
      });
      assert.equal(missing.status, 'execution_unavailable');
      assert.match(String(missing.evidence), /oraclePath/);

      // Path escape via evaluateOracleGate
      const escaped = await evaluateOracleGate({
        workspaceDir: workspace,
        gate: {
          gate: 'oracle',
          oraclePath: '../outside.js',
          order: 1,
          required: true,
        },
        oracleRoot,
        confinement: { available: true, kind: 'sandbox-exec', binary: '/usr/bin/sandbox-exec' },
        env: buildGateEnv({ parentEnv: { PATH: '/usr/bin:/bin' } }),
      });
      assert.equal(escaped.status, 'execution_unavailable');
      assert.match(String(escaped.infraFailure), /oracle_path/);
    } finally {
      await rm(oracleRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('classification precedence: TIMEOUT > INFRA_FAIL > NO_OP > FAIL > PASS', async () => {
    const { classifyTrial } = await import('../harness/classify.js');
    const { CLASSIFICATION_PRECEDENCE } = await import('../harness/contracts.js');

    assert.ok(CLASSIFICATION_PRECEDENCE.TIMEOUT > CLASSIFICATION_PRECEDENCE.INFRA_FAIL);
    assert.ok(CLASSIFICATION_PRECEDENCE.INFRA_FAIL > CLASSIFICATION_PRECEDENCE.NO_OP);
    assert.ok(CLASSIFICATION_PRECEDENCE.NO_OP > CLASSIFICATION_PRECEDENCE.FAIL);
    assert.ok(CLASSIFICATION_PRECEDENCE.FAIL > CLASSIFICATION_PRECEDENCE.PASS);

    assert.equal(
      classifyTrial({
        invokerResult: { exitCode: 0, timedOut: true },
        gateResults: [],
        changedFileCount: 1,
        timedOut: true,
      }).classification,
      'TIMEOUT',
    );
    assert.equal(
      classifyTrial({
        invokerResult: { exitCode: null, timedOut: false, infraFailure: 'boom' },
        gateResults: [],
        changedFileCount: 1,
        timedOut: false,
      }).classification,
      'INFRA_FAIL',
    );
    assert.equal(
      classifyTrial({
        invokerResult: { exitCode: 0, timedOut: false },
        gateResults: [
          { gate: 'tests', exitCode: 0, required: true, status: 'passed' },
        ],
        changedFileCount: 0,
        timedOut: false,
      }).classification,
      'NO_OP',
    );
    assert.equal(
      classifyTrial({
        invokerResult: { exitCode: 0, timedOut: false },
        gateResults: [
          {
            gate: 'tests',
            exitCode: 1,
            required: true,
            status: 'failed',
            classificationSignal: 'FAIL',
          },
        ],
        changedFileCount: 3,
        timedOut: false,
      }).classification,
      'FAIL',
    );
    assert.equal(
      classifyTrial({
        invokerResult: { exitCode: 0, timedOut: false },
        gateResults: [
          {
            gate: 'tests',
            exitCode: 0,
            required: true,
            status: 'passed',
            classificationSignal: 'PASS',
          },
        ],
        changedFileCount: 2,
        timedOut: false,
      }).classification,
      'PASS',
    );

    // Adapter exit 0 + non-success outcome must not PASS; TIMEOUT still wins
    assert.equal(
      classifyTrial({
        invokerResult: {
          exitCode: 0,
          timedOut: true,
          success: false,
          outcomeKind: 'timeout',
          reasonCode: 'wall-clock',
          infraFailure: 'adapter outcome timeout',
        },
        gateResults: [],
        changedFileCount: 1,
        timedOut: false,
      }).classification,
      'TIMEOUT',
    );
    assert.equal(
      classifyTrial({
        invokerResult: {
          exitCode: 0,
          timedOut: false,
          success: false,
          outcomeKind: 'provider_error',
          providerFailure: 'provider_error: rate-limit',
          infraFailure: 'adapter provider_error',
        },
        gateResults: [],
        changedFileCount: 1,
        timedOut: false,
      }).classification,
      'INFRA_FAIL',
    );
  });
});
