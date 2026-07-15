/**
 * Posture fingerprints and digests (unit-level, no I/O campaigns).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});
