/**
 * No-execute campaign expansion over the real corpus.
 * Does not invoke live providers or mutate the corpus.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(REPO, 'benchmarks');

function minimalExperiment(id) {
  return {
    id,
    schemaVersion: 1,
    suiteId: 'cli-comparison',
    taskIds: ['greenfield-003-js-event-emitter'],
    repetitions: 1,
    seed: 7,
    arms: [
      {
        name: 'fake',
        provider: 'fake',
        model: 'none',
        invocationPath: 'native-cli',
        command: 'true',
      },
    ],
  };
}

describe('runCampaign expansion', () => {
  it('resolveSuiteLocation rejects suitePath/suiteId outside corpusRoot', async () => {
    const { resolveSuiteLocation } = await import('../harness/run.js');
    await assert.rejects(
      () =>
        resolveSuiteLocation(
          { suitePath: path.join(os.tmpdir(), 'outside-suite.yaml') },
          CORPUS,
        ),
      /escape|outside|PATH_ESCAPE|fail closed/i,
    );
    await assert.rejects(
      () =>
        resolveSuiteLocation({ suiteId: '../escape' }, CORPUS),
      /unsafe|suiteId|escape|traversal/i,
    );
    await assert.rejects(
      () =>
        resolveSuiteLocation({ suiteId: '/abs/suite' }, CORPUS),
      /absolute suiteId|not allowed/i,
    );
  });

  it('expandExperiment fails closed when arm is missing provider', async () => {
    const { expandExperiment } = await import('../harness/schedule.js');
    assert.throws(
      () =>
        expandExperiment(
          {
            id: 'no-provider',
            seed: 1,
            repetitions: 1,
            arms: [
              {
                name: 'x',
                model: 'm',
                invocationPath: 'native-cli',
                // provider intentionally omitted
              },
            ],
            taskIds: ['task-a'],
          },
          { tasks: [{ taskId: 'task-a' }] },
        ),
      /missing provider|fail closed/i,
    );
  });

  it('refuses a non-empty unowned campaign directory without changing mode or content', async () => {
    const { runCampaign } = await import('../harness/run.js');
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-unowned-'));
    const sentinel = path.join(campaignDir, 'sentinel.txt');
    await chmod(campaignDir, 0o755);
    await writeFile(sentinel, 'unchanged\n', 'utf8');
    const modeBefore = (await stat(campaignDir)).mode & 0o777;
    const listingBefore = await readdir(campaignDir);

    try {
      const result = await runCampaign({
        experiment: minimalExperiment('unowned-campaign-root'),
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: false,
      });

      assert.equal(result.ok, false);
      assert.equal(result.stage, 'campaign-boundary');
      assert.match((result.errors || []).join(' '), /not owned by AICB/i);
      assert.equal((await stat(campaignDir)).mode & 0o777, modeBefore);
      assert.deepEqual(await readdir(campaignDir), listingBefore);
      assert.equal(await readFile(sentinel, 'utf8'), 'unchanged\n');
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  it('claims an empty dedicated campaign leaf before creating campaign content', async () => {
    const { CAMPAIGN_OWNER_FILENAME, runCampaign } = await import('../harness/run.js');
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-empty-owned-'));
    try {
      const result = await runCampaign({
        experiment: minimalExperiment('empty-campaign-root'),
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: false,
      });

      assert.equal(result.ok, true);
      const marker = JSON.parse(
        await readFile(path.join(campaignDir, CAMPAIGN_OWNER_FILENAME), 'utf8'),
      );
      assert.equal(marker.schema, 'aicb.campaign-owner.v1');
      assert.ok((await readdir(campaignDir)).includes('manifest.json'));
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  it('expands over real corpus without execute', async () => {
    const {
      runCampaign,
      resolveSuiteLocation,
      tasksByIdFromLoad,
    } = await import('../harness/run.js');
    const { loadCorpusTasks, loadSuite } = await import('../harness/load.js');

    const { suitePath, suiteDir } = await resolveSuiteLocation(
      { suiteId: 'cli-comparison' },
      CORPUS,
    );
    assert.ok(suitePath.endsWith(`${path.sep}cli-comparison${path.sep}suite.yaml`));
    // suiteDir is realpath-canonical (macOS /var -> /private/var); compare via realpath.
    const { realpath } = await import('node:fs/promises');
    assert.equal(suiteDir, await realpath(path.join(CORPUS, 'cli-comparison')));

    const suite = await loadSuite(suitePath);
    const loaded = await loadCorpusTasks(suiteDir, {
      ...suite,
      tasks: suite.tasks.slice(0, 2),
    });
    const map = tasksByIdFromLoad(loaded);
    assert.ok(Object.keys(map).length >= 2);

    const campaignDir = await mkdtemp(path.join(os.tmpdir(), 'aicb-expand-'));
    try {
      const result = await runCampaign({
        experiment: {
          id: 'expand-test',
          schemaVersion: 1,
          suiteId: 'cli-comparison',
          taskIds: suite.tasks.slice(0, 2),
          repetitions: 1,
          seed: 7,
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
        corpusRoot: CORPUS,
        campaignDir,
        harnessRoot: REPO,
        execute: false,
        resume: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.stage, 'expanded');
      assert.ok(result.manifest);
      assert.equal(result.manifest.trials.length, 2);
      assert.ok(result.manifest.trials.every((t) => t.state === 'pending'));
      assert.ok(result.taskCount >= 2);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });
});
