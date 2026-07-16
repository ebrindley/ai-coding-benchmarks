/**
 * Posture fingerprints and digests (unit-level, no I/O campaigns).
 * Includes harness content digest + symlink-safe directory digests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';

describe('posture + digest', () => {
  it('posture fingerprint is stable and sensitive to path/model-adjacent config', async () => {
    const { computePostureFingerprint } = await import('../harness/posture.js');
    const a = computePostureFingerprint({
      invocationPath: 'poetic-adapter',
      envAllowlist: ['B', 'A'],
      sandboxMode: 'strict',
    });
    const b = computePostureFingerprint({
      invocationPath: 'poetic-adapter',
      envAllowlist: ['A', 'B'],
      sandboxMode: 'strict',
    });
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);

    const c = computePostureFingerprint({
      invocationPath: 'native-cli',
      envAllowlist: ['A', 'B'],
      sandboxMode: 'strict',
    });
    assert.notEqual(a, c);
  });

  it('canonical json digest sorts keys', async () => {
    const { sha256Json, canonicalize } = await import('../harness/digest.js');
    assert.deepEqual(canonicalize({ b: 1, a: 2 }), { a: 2, b: 1 });
    assert.equal(sha256Json({ b: 1, a: 2 }), sha256Json({ a: 2, b: 1 }));
  });

  it('harness content digest changes when source changes even if package.json is fixed', async () => {
    const {
      digestHarnessContent,
      sha256Json,
    } = await import('../harness/digest.js');

    const root = await mkdtemp(path.join(os.tmpdir(), 'aicb-harness-digest-'));
    try {
      await mkdir(path.join(root, 'harness'), { recursive: true });
      await mkdir(path.join(root, 'schemas'), { recursive: true });
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'demo-harness', version: '1.0.0' }),
        'utf8',
      );
      await writeFile(
        path.join(root, 'harness', 'run.js'),
        'export const marker = "v1";\n',
        'utf8',
      );
      await writeFile(
        path.join(root, 'schemas', 'task.schema.json'),
        '{"type":"object"}\n',
        'utf8',
      );

      const d1 = await digestHarnessContent(root);
      assert.match(d1, /^[a-f0-9]{64}$/);

      // Source edit only — package.json unchanged.
      await writeFile(
        path.join(root, 'harness', 'run.js'),
        'export const marker = "v2-source-edit";\n',
        'utf8',
      );
      const d2 = await digestHarnessContent(root);
      assert.notEqual(
        d1,
        d2,
        'harness source edit must change harness content digest',
      );

      // Same package metadata alone is not the only input: a sibling tree with
      // identical package.json but different harness source differs.
      const rootB = await mkdtemp(path.join(os.tmpdir(), 'aicb-harness-digest-b-'));
      try {
        await mkdir(path.join(rootB, 'harness'), { recursive: true });
        await mkdir(path.join(rootB, 'schemas'), { recursive: true });
        await writeFile(
          path.join(rootB, 'package.json'),
          JSON.stringify({ name: 'demo-harness', version: '1.0.0' }),
          'utf8',
        );
        await writeFile(
          path.join(rootB, 'harness', 'run.js'),
          'export const marker = "other-tree";\n',
          'utf8',
        );
        await writeFile(
          path.join(rootB, 'schemas', 'task.schema.json'),
          '{"type":"object"}\n',
          'utf8',
        );
        const dB = await digestHarnessContent(rootB);
        assert.notEqual(
          d2,
          dB,
          'identical package.json with different harness source must differ',
        );

        // Metadata-only digest (old behavior) would match; prove content is used.
        const metaOnly = sha256Json({
          name: 'demo-harness',
          version: '1.0.0',
          schemaVersion: 1,
        });
        assert.notEqual(d2, metaOnly);
        assert.notEqual(dB, metaOnly);
      } finally {
        await rm(rootB, { recursive: true, force: true });
      }

      // Schema content is also an input.
      await writeFile(
        path.join(root, 'schemas', 'task.schema.json'),
        '{"type":"object","title":"changed"}\n',
        'utf8',
      );
      const d3 = await digestHarnessContent(root);
      assert.notEqual(d2, d3, 'schema edit must change harness content digest');

      // Null root is stable.
      const nullDigest = await digestHarnessContent(null);
      assert.match(nullDigest, /^[a-f0-9]{64}$/);
      assert.equal(nullDigest, await digestHarnessContent(undefined));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computeCampaignInputDigests.harness uses content digest not package metadata alone', async () => {
    const { computeCampaignInputDigests } = await import('../harness/manifest.js');
    const { digestHarnessContent } = await import('../harness/digest.js');

    const root = await mkdtemp(path.join(os.tmpdir(), 'aicb-input-digest-'));
    try {
      await mkdir(path.join(root, 'harness'), { recursive: true });
      await mkdir(path.join(root, 'schemas'), { recursive: true });
      await mkdir(path.join(root, 'fixtures'), { recursive: true });
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'demo', version: '0.0.1' }),
        'utf8',
      );
      await writeFile(path.join(root, 'harness', 'a.js'), 'export const a = 1;\n', 'utf8');
      await writeFile(
        path.join(root, 'schemas', 'x.json'),
        '{}\n',
        'utf8',
      );

      const baseOpts = {
        experiment: { id: 'e1', schemaVersion: 1 },
        suite: { id: 's1', schemaVersion: 1 },
        tasks: [],
        suiteDir: root,
        harnessRoot: root,
      };

      const digests1 = await computeCampaignInputDigests(baseOpts);
      const expected = await digestHarnessContent(root);
      assert.equal(digests1.harness, expected);

      await writeFile(
        path.join(root, 'harness', 'a.js'),
        'export const a = 2;\n',
        'utf8',
      );
      const digests2 = await computeCampaignInputDigests(baseOpts);
      assert.notEqual(digests1.harness, digests2.harness);
      // package.json still identical — proves package metadata is not the sole input.
      assert.equal(
        digests1.experiment,
        digests2.experiment,
        'unrelated digests stay stable',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('directory digest does not read external symlink target content', async () => {
    const {
      digestArtifactDir,
      collectDirEntries,
    } = await import('../harness/digest.js');

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'aicb-symlink-digest-'));
    try {
      const outsideDir = path.join(tmp, 'outside');
      const fixtureDir = path.join(tmp, 'fixture');
      await mkdir(outsideDir, { recursive: true });
      await mkdir(fixtureDir, { recursive: true });

      const outsideFile = path.join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'secret-v1\n', 'utf8');
      await writeFile(path.join(fixtureDir, 'inside.txt'), 'fixture-body\n', 'utf8');

      // Symlink inside fixture points at a file outside the fixture root.
      const linkPath = path.join(fixtureDir, 'escape-link');
      await symlink(outsideFile, linkPath);

      const d1 = await digestArtifactDir(fixtureDir);
      assert.match(d1, /^[a-f0-9]{64}$/);

      const entries1 = await collectDirEntries(fixtureDir, '');
      const linkEntry = entries1.find((e) => e.path === 'escape-link');
      assert.ok(linkEntry, 'symlink entry must be recorded');
      assert.equal(linkEntry.type, 'symlink');
      assert.equal(linkEntry.target, outsideFile);
      // No content hash of the external file.
      assert.equal(/** @type {any} */ (linkEntry).sha256, undefined);

      // Mutate external target content — digest must not change.
      await writeFile(outsideFile, 'secret-v2-CHANGED\n', 'utf8');
      const d2 = await digestArtifactDir(fixtureDir);
      assert.equal(
        d1,
        d2,
        'changing external symlink target content must not change fixture digest',
      );

      // Relative external symlink (escapes via ..) also records link text only.
      const relLink = path.join(fixtureDir, 'rel-escape');
      await symlink(path.join('..', 'outside', 'secret.txt'), relLink);
      const d3 = await digestArtifactDir(fixtureDir);
      assert.notEqual(d2, d3, 'adding a symlink entry changes the digest');

      await writeFile(outsideFile, 'secret-v3-AGAIN\n', 'utf8');
      const d4 = await digestArtifactDir(fixtureDir);
      assert.equal(
        d3,
        d4,
        'external content change via relative symlink must not affect digest',
      );

      // Symlink-to-directory must not be walked into outside content.
      const outsideNested = path.join(outsideDir, 'nested');
      await mkdir(outsideNested, { recursive: true });
      await writeFile(path.join(outsideNested, 'deep.txt'), 'deep-v1\n', 'utf8');
      await symlink(outsideNested, path.join(fixtureDir, 'dir-link'));
      const d5 = await digestArtifactDir(fixtureDir);
      const entries5 = await collectDirEntries(fixtureDir, '');
      assert.ok(
        entries5.every((e) => !e.path.includes('deep.txt')),
        'must not walk through symlink-to-dir into outside files',
      );
      await writeFile(path.join(outsideNested, 'deep.txt'), 'deep-v2\n', 'utf8');
      const d6 = await digestArtifactDir(fixtureDir);
      assert.equal(d5, d6);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('directory digest includes empty directories and portable mode bits', async () => {
    const {
      digestArtifactDir,
      collectDirEntries,
      portableModeBits,
    } = await import('../harness/digest.js');
    const { chmod } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'aicb-empty-mode-'));
    try {
      await mkdir(path.join(root, 'empty-dir'), { recursive: true });
      await writeFile(path.join(root, 'a.txt'), 'hello\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(path.join(root, 'a.txt'), 0o640);
      }

      const entries = await collectDirEntries(root, '');
      const empty = entries.find((e) => e.path === 'empty-dir');
      assert.ok(empty, 'empty directory must be recorded');
      assert.equal(empty.type, 'dir');
      assert.equal(typeof empty.mode, 'number');

      const file = entries.find((e) => e.path === 'a.txt');
      assert.ok(file);
      assert.equal(file.type, 'file');
      assert.equal(typeof file.mode, 'number');
      if (process.platform !== 'win32') {
        assert.equal(file.mode, portableModeBits(0o640));
      }

      const d1 = await digestArtifactDir(root);
      // Adding another empty dir changes the digest
      await mkdir(path.join(root, 'empty-2'), { recursive: true });
      const d2 = await digestArtifactDir(root);
      assert.notEqual(d1, d2, 'empty directory must affect digest');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips .git and node_modules in digests (aligned with fixture copy)', async () => {
    const {
      digestArtifactDir,
      collectDirEntries,
      isSkippedFixtureEntry,
      FIXTURE_SKIP_DIR_NAMES,
    } = await import('../harness/digest.js');
    const { copyFixtureTree } = await import('../harness/workspace.js');

    assert.equal(isSkippedFixtureEntry('.git'), true);
    assert.equal(isSkippedFixtureEntry('node_modules'), true);
    assert.ok(FIXTURE_SKIP_DIR_NAMES.has('.git'));
    assert.ok(FIXTURE_SKIP_DIR_NAMES.has('node_modules'));

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'aicb-skip-align-'));
    try {
      const src = path.join(tmp, 'src');
      const dst = path.join(tmp, 'dst');
      await mkdir(path.join(src, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(path.join(src, '.git'), { recursive: true });
      await mkdir(path.join(src, 'nested', 'node_modules'), { recursive: true });
      await writeFile(path.join(src, 'keep.txt'), 'keep\n', 'utf8');
      await writeFile(
        path.join(src, 'node_modules', 'pkg', 'index.js'),
        'secret\n',
        'utf8',
      );
      await writeFile(path.join(src, '.git', 'HEAD'), 'ref: x\n', 'utf8');
      await writeFile(
        path.join(src, 'nested', 'node_modules', 'x.js'),
        'x\n',
        'utf8',
      );
      await mkdir(path.join(src, 'nested', 'ok'), { recursive: true });
      await writeFile(path.join(src, 'nested', 'ok', 'y.txt'), 'y\n', 'utf8');

      const entries = await collectDirEntries(src, '');
      assert.ok(entries.every((e) => !e.path.includes('node_modules')));
      assert.ok(entries.every((e) => !e.path.includes('.git')));
      assert.ok(entries.some((e) => e.path === 'keep.txt'));
      assert.ok(entries.some((e) => e.path === 'nested/ok/y.txt'));

      await copyFixtureTree(src, dst);
      // Copy must not include skipped trees either
      const { access } = await import('node:fs/promises');
      await assert.rejects(() => access(path.join(dst, 'node_modules')));
      await assert.rejects(() => access(path.join(dst, '.git')));
      await access(path.join(dst, 'keep.txt'));
      await access(path.join(dst, 'nested', 'ok', 'y.txt'));

      // Shared exclusion: path sets match; digests match when modes preserved.
      const pathsSrc = (await collectDirEntries(src, ''))
        .map((e) => e.path)
        .sort();
      const pathsDst = (await collectDirEntries(dst, ''))
        .map((e) => e.path)
        .sort();
      assert.deepEqual(pathsSrc, pathsDst);
      if (process.platform !== 'win32') {
        const dSrc = await digestArtifactDir(src);
        const dDst = await digestArtifactDir(dst);
        assert.equal(
          dSrc,
          dDst,
          'source and post-copy digests match under shared skip/mode policy',
        );
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
