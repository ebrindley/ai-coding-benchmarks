/**
 * Capture truncation must fail closed: retained prefixes are incomplete raw.
 * native-cli / poetic-system propagate stdoutTruncatedChars / stderrTruncatedChars
 * so isRawEvidenceUnavailable marks digests non-reportable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';

/** Tiny capture limit so tests do not need multi-hundred-KiB output. */
const TINY_CAPTURE_LIMIT = 64;

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 */
async function writeExecutable(dir, name, body) {
  const bin = path.join(dir, name);
  await writeFile(bin, body, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

describe('capture truncation propagation', () => {
  it('native-cli returns truncation metadata when stdout exceeds captureLimit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-trunc-native-'));
    try {
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      // Emit more than TINY_CAPTURE_LIMIT chars on stdout.
      const bin = await writeExecutable(
        dir,
        'big-stdout',
        `#!/usr/bin/env node
process.stdout.write('A'.repeat(${TINY_CAPTURE_LIMIT + 40}));
process.exit(0);
`,
      );

      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      const result = await invokeNativeCli({
        command: bin,
        args: [],
        cwd: dir,
        campaignDir,
        timeoutMs: 10_000,
        captureLimit: TINY_CAPTURE_LIMIT,
        // Avoid stdin prompt noise for this path.
        prompt: '',
      });

      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stdout.length, TINY_CAPTURE_LIMIT);
      assert.ok(
        typeof result.stdoutTruncatedChars === 'number' &&
          result.stdoutTruncatedChars > 0,
        `expected stdoutTruncatedChars > 0, got ${result.stdoutTruncatedChars}`,
      );
      assert.equal(result.stdoutTruncatedChars, 40);
      assert.equal(result.rawTruncated, true);

      const { isRawEvidenceUnavailable } = await import('../harness/run.js');
      assert.equal(
        isRawEvidenceUnavailable('native-cli', result),
        true,
        'truncated raw must be unavailable for reportable digests',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('native-cli returns truncation metadata when stderr exceeds captureLimit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-trunc-native-err-'));
    try {
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const bin = await writeExecutable(
        dir,
        'big-stderr',
        `#!/usr/bin/env node
process.stderr.write('E'.repeat(${TINY_CAPTURE_LIMIT + 25}));
process.exit(0);
`,
      );

      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      const result = await invokeNativeCli({
        command: bin,
        args: [],
        cwd: dir,
        campaignDir,
        timeoutMs: 10_000,
        captureLimit: TINY_CAPTURE_LIMIT,
        prompt: '',
      });

      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stderr.length, TINY_CAPTURE_LIMIT);
      assert.equal(result.stderrTruncatedChars, 25);
      assert.equal(result.rawTruncated, true);

      const { isRawEvidenceUnavailable } = await import('../harness/run.js');
      assert.equal(isRawEvidenceUnavailable('native-cli', result), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('native-cli under limit does not set truncation metadata', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-trunc-native-ok-'));
    try {
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const bin = await writeExecutable(
        dir,
        'small-stdout',
        `#!/usr/bin/env node
process.stdout.write('ok\\n');
process.exit(0);
`,
      );

      const { invokeNativeCli } = await import(
        '../harness/invokers/native-cli.js'
      );
      const result = await invokeNativeCli({
        command: bin,
        args: [],
        cwd: dir,
        campaignDir,
        timeoutMs: 10_000,
        captureLimit: TINY_CAPTURE_LIMIT,
        prompt: '',
      });

      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stdoutTruncatedChars, undefined);
      assert.equal(result.stderrTruncatedChars, undefined);
      assert.equal(result.rawTruncated, undefined);

      const { isRawEvidenceUnavailable } = await import('../harness/run.js');
      assert.equal(isRawEvidenceUnavailable('native-cli', result), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('poetic-system returns truncation metadata when stdout exceeds captureLimit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-trunc-poetic-'));
    try {
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      // Fake poetic binary: ignore argv, emit oversized stdout.
      const bin = await writeExecutable(
        dir,
        'fake-poetic',
        `#!/usr/bin/env node
process.stdout.write('P'.repeat(${TINY_CAPTURE_LIMIT + 17}));
process.exit(0);
`,
      );

      const { invokePoeticSystem } = await import(
        '../harness/invokers/poetic-system.js'
      );
      const result = await invokePoeticSystem({
        poeticBin: bin,
        prompt: 'do something',
        provider: 'test-provider',
        model: 'test-model',
        cwd: dir,
        campaignDir,
        timeoutMs: 10_000,
        captureLimit: TINY_CAPTURE_LIMIT,
      });

      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stdout.length, TINY_CAPTURE_LIMIT);
      assert.equal(result.stdoutTruncatedChars, 17);
      assert.equal(result.rawTruncated, true);

      const { isRawEvidenceUnavailable } = await import('../harness/run.js');
      assert.equal(
        isRawEvidenceUnavailable('poetic-system', result),
        true,
        'truncated poetic-system raw must be unavailable',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('poetic-system under limit does not set truncation metadata', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aicb-trunc-poetic-ok-'));
    try {
      const campaignDir = path.join(dir, '_campaign');
      await mkdir(campaignDir, { recursive: true, mode: 0o700 });
      const bin = await writeExecutable(
        dir,
        'fake-poetic',
        `#!/usr/bin/env node
process.stdout.write('ok\\n');
process.exit(0);
`,
      );

      const { invokePoeticSystem } = await import(
        '../harness/invokers/poetic-system.js'
      );
      const result = await invokePoeticSystem({
        poeticBin: bin,
        prompt: 'do something',
        provider: 'test-provider',
        model: 'test-model',
        cwd: dir,
        campaignDir,
        timeoutMs: 10_000,
        captureLimit: TINY_CAPTURE_LIMIT,
      });

      assert.equal(result.exitCode, 0, result.infraFailure || result.stderr);
      assert.equal(result.stdoutTruncatedChars, undefined);
      assert.equal(result.stderrTruncatedChars, undefined);
      assert.equal(result.rawTruncated, undefined);

      const { isRawEvidenceUnavailable } = await import('../harness/run.js');
      assert.equal(isRawEvidenceUnavailable('poetic-system', result), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isRawEvidenceUnavailable truncation fail-closed', () => {
  it('synthetic invokerResult with truncated counts → unavailable', async () => {
    const { isRawEvidenceUnavailable } = await import('../harness/run.js');

    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 0,
        stdout: 'prefix-only',
        stderr: '',
        stdoutTruncatedChars: 100,
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('poetic-system', {
        exitCode: 0,
        stdout: '',
        stderr: 'err-prefix',
        stderrTruncatedChars: 1,
      }),
      true,
    );
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 0,
        stdout: 'kept',
        stderr: '',
        rawTruncated: true,
      }),
      true,
    );
    // Zero / missing truncation is available when exit is clean.
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 0,
        stdout: 'full',
        stderr: '',
        stdoutTruncatedChars: 0,
        stderrTruncatedChars: 0,
      }),
      false,
    );
    assert.equal(
      isRawEvidenceUnavailable('native-cli', {
        exitCode: 0,
        stdout: 'full',
        stderr: '',
      }),
      false,
    );
  });

  it('truncation forces digests onto rawEvidenceUnavailable path (unit)', async () => {
    const { isRawEvidenceUnavailable } = await import('../harness/run.js');
    const { buildTrialDigests } = await import('../harness/results.js');

    const invokerResult = {
      exitCode: 0,
      stdout: 'A'.repeat(64),
      stderr: '',
      stdoutTruncatedChars: 40,
      rawTruncated: true,
    };
    const rawUnavailable = isRawEvidenceUnavailable('native-cli', invokerResult);
    assert.equal(rawUnavailable, true);

    // Mirror run.js digest branch when rawUnavailable is true.
    const digests = buildTrialDigests({
      artifactDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      rawEvidenceUnavailable: true,
    });
    assert.equal(digests.rawEvidenceUnavailable, true);
    assert.equal(digests.rawOutputDigest, undefined);
    assert.equal(digests.rawStdoutSha256, undefined);
    assert.equal(digests.rawStderrSha256, undefined);
  });
});
