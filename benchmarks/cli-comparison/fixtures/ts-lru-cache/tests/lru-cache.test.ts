import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru-cache.ts';

test('basic-get-set', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('missing'), undefined);
});

test('evicts-when-over-capacity', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3); // evicts 'a' (least recently used)
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

test('get-marks-recently-used', () => {
  // This is the bug: get() must refresh recency.
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');     // 'a' is now most-recently-used; 'b' is least
  c.set('c', 3);  // should evict 'b', NOT 'a'
  assert.equal(c.get('a'), 1, "'a' was accessed and must survive");
  assert.equal(c.get('b'), undefined, "'b' was least-recently-used and should be evicted");
  assert.equal(c.get('c'), 3);
});

test('set-updates-recency', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10); // re-setting 'a' refreshes it; 'b' is now LRU
  c.set('c', 3);  // evicts 'b'
  assert.equal(c.get('a'), 10);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
});

test('respects-capacity-size', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.size, 2);
});

test('rejects-bad-capacity', () => {
  assert.throws(() => new LRUCache<string, number>(0));
});
