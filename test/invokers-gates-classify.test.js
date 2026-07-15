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
fs.writeFileSync(out, JSON.stringify({
  ok: true,
  receivedRequest: req,
  model: { resolved: { availability: 'available', value: 'resolved-from-provider' } },
  args
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

      const requestPath = path.join(dir, 'req.json');
      const outputPath = path.join(dir, 'out.json');
      const result = await invokePoeticAdapter({
        poeticBin: bin,
        requestPath,
        outputPath,
        request,
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0);

      const written = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(written.receivedRequest.schema, POETIC_INVOKE_REQUEST_SCHEMA);
      const evidence = parseResolvedModelEvidence(written);
      assert.equal(evidence.available, true);
      assert.equal(evidence.resolvedModel, 'resolved-from-provider');
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
    // No matching static gate → unavailable, not silent PASS
    assert.equal(staticOnly.status, 'execution_unavailable');
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
  });
});
