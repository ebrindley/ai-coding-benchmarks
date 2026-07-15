/**
 * Schema/path validation and traversal/symlink escape refusal.
 * No live providers. No corpus mutation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, realpath } from 'node:fs/promises';
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
});
