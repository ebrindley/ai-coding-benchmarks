/**
 * Validate representative harness artifacts against public JSON schemas.
 *
 * No AJV / extra deps: minimal draft-07 subset validator covering type,
 * required, properties, enum, const, additionalProperties, items, $ref
 * (local definitions), minimum/maximum, minLength/maxLength, pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} name
 * @returns {Promise<object>}
 */
async function loadSchema(name) {
  const text = await readFile(path.join(REPO, 'schemas', name), 'utf8');
  return JSON.parse(text);
}

/**
 * JSON-schema-ish type check (draft-07 single type or type union).
 * @param {unknown} value
 * @param {string} t
 * @returns {boolean}
 */
function matchesType(value, t) {
  if (t === 'null') return value === null;
  if (t === 'array') return Array.isArray(value);
  if (t === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (t === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (t === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === t;
}

/**
 * Resolve a local `#/definitions/...` or `#/properties/...` style $ref.
 * @param {object} root
 * @param {string} ref
 * @returns {object}
 */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const parts = ref.slice(2).split('/');
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`$ref not found: ${ref}`);
    }
    cur = cur[p];
  }
  if (!cur || typeof cur !== 'object') {
    throw new Error(`$ref target not an object: ${ref}`);
  }
  return cur;
}

/**
 * Minimal recursive validator.
 * @param {unknown} data
 * @param {object} schema
 * @param {object} root
 * @param {string} pathStr
 * @returns {string[]} error messages
 */
function validate(data, schema, root, pathStr = '$') {
  if (!schema || typeof schema !== 'object') return [];

  if (schema.$ref) {
    return validate(data, resolveRef(root, schema.$ref), root, pathStr);
  }

  /** @type {string[]} */
  const errors = [];

  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    }
  }

  if (schema.enum) {
    const ok = schema.enum.some(
      (e) => e === data || (Number.isNaN(e) && Number.isNaN(data)),
    );
    if (!ok) {
      errors.push(`${pathStr}: value ${JSON.stringify(data)} not in enum`);
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(
        `${pathStr}: expected type ${types.join('|')}, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`,
      );
      return errors;
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && data.length > schema.maxLength) {
      errors.push(`${pathStr}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(data)) {
        errors.push(`${pathStr}: string does not match pattern ${schema.pattern}`);
      }
    }
    if (schema.format === 'date-time') {
      // Accept ISO-8601 subsets produced by Date#toISOString
      if (Number.isNaN(Date.parse(data))) {
        errors.push(`${pathStr}: invalid date-time`);
      }
    }
  }

  if (typeof data === 'number' && Number.isFinite(data)) {
    if (schema.minimum != null && data < schema.minimum) {
      errors.push(`${pathStr}: ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && data > schema.maximum) {
      errors.push(`${pathStr}: ${data} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(data) && schema.items) {
    for (let i = 0; i < data.length; i += 1) {
      errors.push(
        ...validate(data[i], schema.items, root, `${pathStr}[${i}]`),
      );
    }
  }

  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (schema.properties ||
      schema.required ||
      schema.additionalProperties !== undefined)
  ) {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data) || data[key] === undefined) {
          errors.push(`${pathStr}: missing required property "${key}"`);
        }
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(
          ...validate(value, props[key], root, `${pathStr}.${key}`),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathStr}: additional property "${key}" not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        errors.push(
          ...validate(
            value,
            schema.additionalProperties,
            root,
            `${pathStr}.${key}`,
          ),
        );
      }
    }
  }

  return errors;
}

/**
 * @param {unknown} data
 * @param {object} schema
 */
function assertValid(data, schema) {
  const errors = validate(data, schema, schema, '$');
  assert.equal(
    errors.length,
    0,
    `schema validation failed:\n${errors.join('\n')}`,
  );
}

/**
 * Round-trip through JSON to match on-disk public artifact shape
 * (omits undefined keys, as writeFile(JSON.stringify) does).
 * @param {unknown} value
 * @returns {unknown}
 */
function asJsonArtifact(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('schema artifacts (trial + report)', () => {
  it('writeTrialResult payload validates against trial.schema.json', async () => {
    const schema = await loadSchema('trial.schema.json');
    const { writeTrialResult, readTrialResult } = await import(
      '../harness/results.js'
    );
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-schema-trial-'));
    try {
      const trialId = 'trial-schema-1';
      const fp = 'a'.repeat(64);
      // Representative complete trial as run.js feeds writeTrialResult
      const input = {
        id: trialId,
        experimentId: 'exp-demo',
        arm: 'claude-native',
        provider: 'claude',
        taskId: 'brownfield-002-js-rate-limiter-bug',
        repetition: 1,
        scheduleSeed: 42,
        invocationPath: 'native-cli',
        requestedModel: 'claude-sonnet-4',
        resolvedModel: 'claude-sonnet-4-20250514',
        resolvedModelAvailable: true,
        resolvedModelSource: 'model.resolved.value',
        postureFingerprint: fp,
        state: 'completed',
        classification: 'PASS',
        classificationReason: 'all required gates passed',
        hashes: {
          fixtureHash: 'b'.repeat(64),
          promptHash: 'c'.repeat(64),
        },
        digests: {
          resultDigest: 'd'.repeat(64),
          rawOutputDigest: 'e'.repeat(64),
        },
        gateResults: [
          {
            gate: 'tests',
            status: 'passed',
            exitCode: 0,
            required: true,
            stdoutDigest: 'f'.repeat(64),
          },
        ],
        changedFileCount: 3,
        startedAt: '2026-07-15T12:00:00.000Z',
        finishedAt: '2026-07-15T12:00:05.000Z',
        durationMs: 5000,
        workspaceDir: path.join(campaign, 'workspaces', trialId),
        artifactDir: path.join(campaign, 'artifacts', trialId),
      };

      const { writeCompleteTrial } = await import(
        './helpers/complete-trial.js'
      );
      const { result: written } = await writeCompleteTrial(
        campaign,
        trialId,
        input,
      );
      // Public on-disk artifact
      const onDisk = await readTrialResult(campaign, trialId);

      assert.equal(written.schemaVersion, 1);
      assert.equal(typeof written.writtenAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(written.writtenAt)));
      assert.equal(written.resolvedModelAvailable, true);
      assert.equal(written.resolvedModelSource, 'model.resolved.value');
      // Previews must not survive write
      assert.ok(
        !JSON.stringify(onDisk).includes('stdoutPreview'),
      );

      assertValid(asJsonArtifact(written), schema);
      assertValid(onDisk, schema);

      // Negative: extra public-looking property rejected by additionalProperties
      const bad = { ...onDisk, notInContract: true };
      const badErrors = validate(bad, schema, schema, '$');
      assert.ok(
        badErrors.some((e) => e.includes('notInContract')),
        'expected additionalProperties rejection',
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('writeTrialResult unavailable-model path validates', async () => {
    const schema = await loadSchema('trial.schema.json');
    const { writeCompleteTrial } = await import(
      './helpers/complete-trial.js'
    );
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-schema-trial2-'));
    try {
      const { result } = await writeCompleteTrial(campaign, 't-unavail', {
        experimentId: 'exp-demo',
        arm: 'codex',
        provider: 'openai',
        taskId: 'greenfield-003-js-event-emitter',
        repetition: 2,
        scheduleSeed: 'seed-1',
        invocationPath: 'poetic-adapter',
        requestedModel: 'o4-mini',
        resolvedModel: null,
        resolvedModelAvailable: false,
        resolvedModelSource: 'unavailable',
        postureFingerprint: null,
        state: 'failed',
        classification: 'INFRA_FAIL',
        classificationReason: 'provider error',
        error: 'provider error',
        digests: { rawEvidenceUnavailable: true },
      });
      assertValid(asJsonArtifact(result), schema);
      assert.equal(result.resolvedModel, null);
      assert.equal(result.resolvedModelAvailable, false);
      assert.equal(result.provider, 'openai');
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('buildReport payload validates against report.schema.json', async () => {
    const schema = await loadSchema('report.schema.json');
    const { buildReport } = await import('../harness/summary.js');

    const fpA = '1'.repeat(64);
    const fpB = '2'.repeat(64);
    const manifest = {
      campaignId: 'camp-schema-1',
      experimentId: 'exp-demo',
      schemaVersion: 1,
      status: 'completed',
      trials: [],
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:10:00.000Z',
      lock: { held: false, owner: null },
    };

    // Mixed paths/models → multiple cells, global passRate refused
    const trialResults = [
      {
        id: 't1',
        arm: 'a',
        provider: 'p1',
        taskId: 'task-x',
        invocationPath: 'poetic-adapter',
        requestedModel: 'm1',
        resolvedModel: null,
        resolvedModelAvailable: false,
        postureFingerprint: fpA,
        classification: 'PASS',
        state: 'completed',
        durationMs: 100,
      },
      {
        id: 't2',
        arm: 'a',
        provider: 'p1',
        taskId: 'task-x',
        invocationPath: 'native-cli',
        requestedModel: 'm1',
        resolvedModel: 'm1-resolved',
        resolvedModelAvailable: true,
        resolvedModelSource: 'invoker-explicit',
        postureFingerprint: fpA,
        classification: 'FAIL',
        state: 'completed',
        durationMs: 200,
      },
      {
        id: 't3',
        arm: 'b',
        provider: 'p2',
        taskId: 'task-y',
        invocationPath: 'poetic-system',
        requestedModel: 'm2',
        resolvedModel: null,
        resolvedModelAvailable: false,
        resolvedModelSource: 'unavailable',
        postureFingerprint: fpB,
        classification: 'NO_OP',
        state: 'completed',
        durationMs: 50,
      },
    ];

    const report = buildReport(manifest, trialResults);
    const artifact = asJsonArtifact(report);

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.campaignId, 'camp-schema-1');
    assert.equal(artifact.experimentId, 'exp-demo');
    assert.equal(typeof artifact.generatedAt, 'string');
    assert.ok(Array.isArray(artifact.cells));
    assert.ok(artifact.cells.length >= 2);
    assert.ok(Array.isArray(artifact.refusals));
    assert.ok(artifact.refusals.length >= 1);
    assert.equal(artifact.totals.passRate, null);
    assert.ok(artifact.classifications);
    assert.equal(artifact.classifications.PASS, 1);
    assert.equal(artifact.classifications.FAIL, 1);
    assert.equal(artifact.classifications.NO_OP, 1);

    // byTask nested byArm must carry requestedModel when present
    for (const task of artifact.byTask) {
      for (const row of task.byArm || []) {
        if (row.requestedModel != null) {
          assert.equal(typeof row.requestedModel, 'string');
        }
      }
    }

    assertValid(artifact, schema);

    // Homogeneous single-cell campaign also validates with passRate set
    const homo = asJsonArtifact(
      buildReport(manifest, [trialResults[0]]),
    );
    assert.equal(typeof homo.totals.passRate, 'number');
    assertValid(homo, schema);
  });

  it('minimal validator rejects wrong types and missing required fields', async () => {
    const trialSchema = await loadSchema('trial.schema.json');
    const reportSchema = await loadSchema('report.schema.json');

    const missing = validate({ id: 'x' }, trialSchema, trialSchema, '$');
    assert.ok(missing.some((e) => e.includes('missing required')));

    const badType = validate(
      {
        schemaVersion: '1',
        campaignId: 'c',
        generatedAt: '2026-07-15T00:00:00.000Z',
        totals: { n: 0, completed: 0 },
        byArm: [],
        byTask: [],
        cells: [],
        refusals: [],
        classifications: {},
      },
      reportSchema,
      reportSchema,
      '$',
    );
    assert.ok(badType.some((e) => e.includes('schemaVersion')));
  });

  it('writeTrialResult enforces additionalProperties and id binding; strict load/verify', async () => {
    const {
      writeTrialResult,
      readTrialResult,
      validateTrialResultSchema,
      collectManifestIdentityMismatches,
      verifyTrialEvidenceDigests,
    } = await import('../harness/results.js');
    const {
      completeTrialResult,
      completeManifestTrial,
      writeCompleteTrial,
    } = await import('./helpers/complete-trial.js');
    const campaign = await mkdtemp(path.join(os.tmpdir(), 'aicb-schema-bind-'));
    try {
      const trialId = 'bind-1';
      const manifestTrial = completeManifestTrial({
        id: trialId,
        experimentId: 'exp-bind',
        arm: 'a1',
        provider: 'p1',
        taskId: 'task-bind',
        scheduleSeed: 3,
        invocationPath: 'poetic-adapter',
        requestedModel: 'm1',
        postureFingerprint: 'e'.repeat(64),
      });
      const base = completeTrialResult({
        id: trialId,
        experimentId: 'exp-bind',
        arm: 'a1',
        provider: 'p1',
        taskId: 'task-bind',
        scheduleSeed: 3,
        invocationPath: 'poetic-adapter',
        requestedModel: 'm1',
        postureFingerprint: 'e'.repeat(64),
      });

      // Mismatched id rejected
      await assert.rejects(
        () =>
          writeTrialResult(campaign, trialId, {
            ...base,
            id: 'not-bind-1',
          }),
        /result\.id.*trialId|fail closed/i,
      );

      // Unknown field rejected
      await assert.rejects(
        () =>
          writeTrialResult(campaign, trialId, {
            ...base,
            sneakyExtra: 1,
          }),
        /additional property|schema validation/i,
      );

      // Missing required property rejected on write
      await assert.rejects(
        () =>
          writeTrialResult(campaign, trialId, {
            id: trialId,
            digests: {},
          }),
        /missing required|schema validation|fail closed/i,
      );

      // Identity mismatch against manifestTrial rejected on write
      await assert.rejects(
        () =>
          writeTrialResult(
            campaign,
            trialId,
            { ...base, arm: 'WRONG' },
            { manifestTrial },
          ),
        /identity|manifest trial|fail closed/i,
      );

      // Partial frozen row fails closed (missing identity authority)
      await assert.rejects(
        () =>
          writeTrialResult(
            campaign,
            trialId,
            base,
            { manifestTrial: { id: trialId } },
          ),
        /manifest:|identity|fail closed/i,
      );

      const { result } = await writeTrialResult(
        campaign,
        trialId,
        base,
        { manifestTrial },
      );
      assert.equal(result.id, trialId);
      assert.equal(
        collectManifestIdentityMismatches(result, manifestTrial).length,
        0,
      );

      // Load always validates by default
      const onDisk = await readTrialResult(campaign, trialId);
      assert.equal(onDisk.id, trialId);
      const schemaErrors = await validateTrialResultSchema(onDisk);
      assert.equal(schemaErrors.length, 0, schemaErrors.join('\n'));

      // Missing required on ordinary load fails closed
      await writeFile(
        path.join(campaign, 'results', trialId, 'result.json'),
        `${JSON.stringify({ id: trialId, digests: {} })}\n`,
        'utf8',
      );
      await assert.rejects(
        () => readTrialResult(campaign, trialId),
        /missing required|schema validation|fail closed/i,
      );

      // Restore valid result for verify path
      await writeCompleteTrial(campaign, trialId, base, { manifestTrial });
      // Verify without frozen authority fails when required
      const noAuth = await verifyTrialEvidenceDigests(
        campaign,
        trialId,
        undefined,
        { requireManifestTrial: true },
      );
      assert.equal(noAuth.ok, false);
      assert.ok(
        noAuth.mismatches.includes('manifestTrial') ||
          /manifest/i.test(String(noAuth.error)),
      );

      // requireRequired:false is not permitted
      await assert.rejects(
        () => validateTrialResultSchema(onDisk, { requireRequired: false }),
        /not permitted|fail closed/i,
      );
    } finally {
      await rm(campaign, { recursive: true, force: true });
    }
  });

  it('runCampaign success and infra result.json validate against trial.schema.json', async () => {
    const schema = await loadSchema('trial.schema.json');
    const reportSchema = await loadSchema('report.schema.json');
    const { runCampaign } = await import('../harness/run.js');
    const { readTrialResult } = await import('../harness/results.js');
    const CORPUS = path.join(REPO, 'benchmarks');

    // Success path: real execute with native-cli `true` (gates may FAIL/NO_OP).
    const campaignOk = await mkdtemp(path.join(os.tmpdir(), 'aicb-schema-run-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'schema-run-ok',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: ['greenfield-003-js-event-emitter'],
          repetitions: 1,
          seed: 11,
          timeoutMs: 30_000,
          arms: [
            {
              name: 'fake',
              provider: 'fake',
              model: 'none',
              invocationPath: 'native-cli',
              command: 'true',
              args: [],
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir: campaignOk,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });
      // May complete with FAIL/NO_OP gates or evidence fail if infra gates — still write results.
      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      const onDisk = await readTrialResult(campaignOk, trialId);
      assert.ok(
        onDisk.exitCode === 0 || onDisk.exitCode === null,
        `exitCode=${onDisk.exitCode}`,
      );
      assert.ok(
        typeof onDisk.executionRoot === 'string' || onDisk.executionRoot === null,
      );
      assert.ok(onDisk.digests?.resultDigest);
      assertValid(asJsonArtifact(onDisk), schema);

      // If report was written, it must match report schema
      try {
        const report = JSON.parse(
          await readFile(path.join(campaignOk, 'report.json'), 'utf8'),
        );
        assertValid(asJsonArtifact(report), reportSchema);
      } catch (err) {
        // evidence stage may refuse report for unavailable — only assert when present
        if (result.ok && result.report) {
          assertValid(asJsonArtifact(result.report), reportSchema);
        } else if (result.stage !== 'evidence') {
          throw err;
        }
      }
    } finally {
      await rm(campaignOk, { recursive: true, force: true });
    }

    // Infra path: invoker command missing → INFRA_FAIL / rawEvidenceUnavailable
    const campaignInfra = await mkdtemp(path.join(os.tmpdir(), 'aicb-schema-infra-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'schema-run-infra',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: ['greenfield-003-js-event-emitter'],
          repetitions: 1,
          seed: 12,
          timeoutMs: 5_000,
          arms: [
            {
              name: 'broken',
              provider: 'fake',
              model: 'none',
              invocationPath: 'native-cli',
              command: path.join(os.tmpdir(), 'aicb-definitely-missing-bin-xyz'),
              args: [],
            },
          ],
        },
        corpusRoot: CORPUS,
        campaignDir: campaignInfra,
        harnessRoot: REPO,
        execute: true,
        resume: false,
        maxTrials: 1,
      });
      assert.ok(result.manifest);
      const trialId = result.manifest.trials[0].id;
      let onDisk;
      try {
        onDisk = await readTrialResult(campaignInfra, trialId);
      } catch {
        // Some failures may not write results; skip schema when absent
        return;
      }
      assertValid(asJsonArtifact(onDisk), schema);
      if (onDisk.digests?.rawEvidenceUnavailable === true) {
        assert.equal(onDisk.classification, 'INFRA_FAIL');
      }
      // Unavailable must not produce a benchmark report
      if (result.stage === 'evidence' || onDisk.digests?.rawEvidenceUnavailable) {
        assert.equal(result.ok, false);
        let reportPresent = true;
        try {
          await readFile(path.join(campaignInfra, 'report.json'), 'utf8');
        } catch {
          reportPresent = false;
        }
        assert.equal(reportPresent, false);
      }
    } finally {
      await rm(campaignInfra, { recursive: true, force: true });
    }
  });
});
