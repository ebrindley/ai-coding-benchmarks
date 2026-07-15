/**
 * No-execute campaign expansion over the real corpus.
 * Does not invoke live providers or mutate the corpus.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(REPO, 'benchmarks');

describe('runCampaign expansion', () => {
  it('expands over real corpus without execute', async () => {
    const {
      runCampaign,
      resolveSuiteLocation,
      tasksByIdFromLoad,
    } = await import('../harness/run.js');
    const { loadCorpusTasks, loadSuite } = await import('../harness/load.js');

    const { suitePath, suiteDir } = resolveSuiteLocation(
      { suiteId: 'cli-comparison' },
      CORPUS,
    );
    assert.ok(suitePath.endsWith(`${path.sep}cli-comparison${path.sep}suite.yaml`));
    assert.equal(suiteDir, path.join(CORPUS, 'cli-comparison'));

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
