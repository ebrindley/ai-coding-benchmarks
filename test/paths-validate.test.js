/**
 * Schema/path validation and traversal/symlink escape refusal.
 * No live providers. No corpus mutation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdir,
  realpath,
  writeFile,
  symlink,
  readlink,
  rm,
  mkdtemp,
} from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CORPUS = path.join(REPO, 'benchmarks', 'cli-comparison');

describe('paths + validate', () => {
  it('assertInsideRoot rejects traversal (realpath-canonical roots)', async () => {
    const { assertInsideRoot, resolveUnder } = await import('../harness/paths.js');
    // Use mkdtemp-style path then realpath to account for macOS /tmp -> /private/tmp
    const rootRaw = path.join(os.tmpdir(), `aicb-path-root-${process.pid}`);
    await mkdir(rootRaw, { recursive: true });
    const root = await realpath(rootRaw);

    const inside = await resolveUnder(root, 'a/b');
    const insideCanon = path.resolve(inside);
    assert.ok(
      insideCanon === path.join(root, 'a', 'b') ||
        insideCanon.startsWith(root + path.sep),
      `expected ${insideCanon} under ${root}`,
    );

    await assert.rejects(
      () => resolveUnder(root, '../escape'),
      /escape|travers|outside|PATH_ESCAPE/i,
    );
    await assert.rejects(
      () => assertInsideRoot(root, path.join(root, '..', 'outside')),
      /escape|travers|outside|PATH_ESCAPE/i,
    );
  });

  it('loads and validates suite + task YAML from corpus (read-only)', async () => {
    const { loadSuite, loadTask } = await import('../harness/load.js');
    assert.equal(typeof loadSuite, 'function');
    assert.equal(typeof loadTask, 'function');

    const suite = await loadSuite(path.join(CORPUS, 'suite.yaml'));
    assert.equal(suite.name, 'cli-comparison');
    assert.ok(suite.repetitions >= 1);
    assert.ok(Array.isArray(suite.tasks) && suite.tasks.length > 0);

    const taskPath = path.join(
      CORPUS,
      'tasks',
      'brownfield',
      '002-js-rate-limiter-bug.yaml',
    );
    const task = await loadTask(taskPath);
    assert.equal(task.taskId, 'brownfield-002-js-rate-limiter-bug');
    assert.ok(task.eligibilityGates?.length >= 1);
    assert.ok(task.expectedOutcome?.mustHave?.length >= 1);
  });

  it('rejects invalid suite shape', async () => {
    const { validateSuite } = await import('../harness/validate.js');
    assert.throws(() => validateSuite({ name: '', tasks: [] }), /./);
  });

  it('rejects malformed baseline-diff allow policies', async () => {
    const { loadTask } = await import('../harness/load.js');
    const { validateTask } = await import('../harness/validate.js');
    const task = await loadTask(
      path.join(CORPUS, 'tasks', 'greenfield', '005-sqlite-schema.yaml'),
    );
    const gates = task.eligibilityGates.map((gate) =>
      gate.gate === 'baseline-diff'
        ? { ...gate, baselineDiffPolicy: { allow: 'schema.sql' } }
        : gate,
    );
    assert.throws(
      () => validateTask({ ...task, eligibilityGates: gates }),
      /baselineDiffPolicy\.allow|non-empty array/i,
    );
  });

  it('corpus oracle tasks declare oraclePath; static task declares evidenceGate', async () => {
    const { loadTask } = await import('../harness/load.js');
    const {
      resolveCommandlessOraclePath,
      runGates,
      buildOracleCommand,
    } = await import('../harness/gates.js');
    const oraclesRoot = path.join(CORPUS, 'oracles');

    const migration = await loadTask(
      path.join(CORPUS, 'tasks', 'brownfield', '008-js-to-ts-migration.yaml'),
    );
    const spring = await loadTask(
      path.join(CORPUS, 'tasks', 'greenfield', '004-java-spring-service.yaml'),
    );
    const rate = await loadTask(
      path.join(CORPUS, 'tasks', 'brownfield', '002-js-rate-limiter-bug.yaml'),
    );

    const migOracle = migration.eligibilityGates.find((g) => g.gate === 'oracle');
    const springOracle = spring.eligibilityGates.find((g) => g.gate === 'oracle');
    assert.ok(migOracle, 'migration task has oracle gate');
    assert.ok(springOracle, 'spring task has oracle gate');
    assert.equal(
      migOracle.oraclePath,
      'brownfield-008-js-to-ts-migration/check-consumer-import.js',
    );
    assert.equal(
      springOracle.oraclePath,
      'greenfield-004-java-spring-service/check-http-endpoints.sh',
    );
    // Commandless: no task-declared command to rewrite
    assert.ok(!migOracle.command);
    assert.ok(!springOracle.command);

    const migAbs = await resolveCommandlessOraclePath(
      oraclesRoot,
      migOracle.oraclePath,
    );
    const springAbs = await resolveCommandlessOraclePath(
      oraclesRoot,
      springOracle.oraclePath,
    );
    assert.ok(migAbs.includes('check-consumer-import.js'));
    assert.ok(springAbs.includes('check-http-endpoints.sh'));
    assert.match(buildOracleCommand(migAbs), /^node '/);
    assert.match(buildOracleCommand(springAbs), /^bash '/);

    // Static evidence binding present on rate-limiter clock-injection
    const clock = rate.expectedOutcome.mustHave.find(
      (m) => m.id === 'clock-injection',
    );
    assert.equal(clock.substantiation, 'static');
    assert.equal(clock.evidenceGate, 'clock-injection');
    assert.equal(clock.artifactRef, 'scripts/check-clock-injection.js');
    const clockGate = rate.eligibilityGates.find(
      (g) => g.gate === 'clock-injection',
    );
    assert.ok(clockGate?.command);
    assert.match(clockGate.command, /check-clock-injection/);

    // Structural oracle run with confinement unavailable fails closed for both corpus paths
    const ws = await mkdtemp(path.join(os.tmpdir(), 'aicb-corpus-oracle-'));
    try {
      for (const gate of [migOracle, springOracle]) {
        const results = await runGates({
          gates: [gate],
          workspaceDir: ws,
          oracleRoot: oraclesRoot,
          confinement: {
            available: false,
            reason: 'corpus-test-forced-unavailable',
            kind: null,
            binary: null,
          },
        });
        assert.equal(results[0].status, 'execution_unavailable');
        assert.equal(results[0].classificationSignal, 'INFRA_FAIL');
        // Unexecuted: oraclePath must not appear as execution evidence
        assert.equal(results[0].oraclePath, undefined);
        assert.equal(results[0].oracleExecuted, undefined);
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('assertSafeCampaignId rejects traversal, absolute, overlong', async () => {
    const {
      assertSafeCampaignId,
      assertSafeIdSegment,
      PathEscapeError,
    } = await import('../harness/paths.js');

    assert.equal(assertSafeCampaignId('exp-1'), 'exp-1');
    assert.equal(assertSafeIdSegment('seg', { label: 'seg' }), 'seg');
    assert.throws(() => assertSafeCampaignId('..'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('../x'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('/abs'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('a\\b'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId('a/b'), PathEscapeError);
    assert.throws(() => assertSafeCampaignId(''), /required/i);
    assert.throws(
      () => assertSafeCampaignId(`a${'b'.repeat(128)}`),
      PathEscapeError,
    );
  });

  it('assertSafeTrialId / trialPathUnder enforce safe filesystem identifiers', async () => {
    const {
      assertSafeTrialId,
      trialPathUnder,
      PathEscapeError,
    } = await import('../harness/paths.js');
    const rootRaw = path.join(os.tmpdir(), `aicb-trialid-${process.pid}`);
    await mkdir(rootRaw, { recursive: true });
    const root = await realpath(rootRaw);

    assert.equal(assertSafeTrialId('Arm__task__r1__abc123'), 'Arm__task__r1__abc123');
    assert.throws(() => assertSafeTrialId('..'), PathEscapeError);
    assert.throws(() => assertSafeTrialId('x/y'), PathEscapeError);

    const under = await trialPathUnder(root, 't1');
    assert.ok(under === path.join(root, 't1') || under.startsWith(root + path.sep));
    await assert.rejects(() => trialPathUnder(root, 't1', '..'), /unsafe|escape|segment/i);
  });

  it('copyFixtureTree rejects absolute symlinks and preserves relative internal ones', async () => {
    if (process.platform === 'win32') return;
    const { copyFixtureTree } = await import('../harness/workspace.js');
    const { PathEscapeError } = await import('../harness/paths.js');

    const fixture = await mkdtemp(path.join(os.tmpdir(), 'aicb-fx-'));
    const destOk = await mkdtemp(path.join(os.tmpdir(), 'aicb-dst-'));
    const destAbs = await mkdtemp(path.join(os.tmpdir(), 'aicb-dst-abs-'));
    try {
      await writeFile(path.join(fixture, 'target.txt'), 'hello\n', 'utf8');
      await symlink('target.txt', path.join(fixture, 'rel-link'));
      // absolute symlink (even if pointing inside fixture) is rejected
      await symlink(path.join(fixture, 'target.txt'), path.join(fixture, 'abs-link'));

      // Copy without the abs link first: relative preserved
      const fixtureRelOnly = await mkdtemp(path.join(os.tmpdir(), 'aicb-fxr-'));
      try {
        await writeFile(path.join(fixtureRelOnly, 'target.txt'), 'hello\n', 'utf8');
        await symlink('target.txt', path.join(fixtureRelOnly, 'rel-link'));
        await copyFixtureTree(fixtureRelOnly, destOk);
        const preserved = await readlink(path.join(destOk, 'rel-link'));
        assert.equal(preserved, 'target.txt');
        assert.ok(!path.isAbsolute(preserved));
      } finally {
        await rm(fixtureRelOnly, { recursive: true, force: true });
      }

      await assert.rejects(
        () => copyFixtureTree(fixture, destAbs),
        (err) => {
          assert.ok(err instanceof PathEscapeError || /absolute symlink/i.test(String(err)));
          assert.match(String(err.message || err), /absolute symlink/i);
          return true;
        },
      );

      // Relative escape outside fixture root also rejected
      const fixtureEsc = await mkdtemp(path.join(os.tmpdir(), 'aicb-fxe-'));
      const destEsc = await mkdtemp(path.join(os.tmpdir(), 'aicb-dste-'));
      try {
        await writeFile(path.join(fixtureEsc, 'keep.txt'), 'x\n', 'utf8');
        await symlink('../../outside', path.join(fixtureEsc, 'escape-link'));
        await assert.rejects(
          () => copyFixtureTree(fixtureEsc, destEsc),
          /escape|symlink/i,
        );
      } finally {
        await rm(fixtureEsc, { recursive: true, force: true });
        await rm(destEsc, { recursive: true, force: true });
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(destOk, { recursive: true, force: true });
      await rm(destAbs, { recursive: true, force: true });
    }
  });
});
