'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WildcardEventEmitter } = require('../src/emitter.js');

test('basic-emit', () => {
  const emitter = new WildcardEventEmitter();
  const calls = [];
  emitter.on('user.created', (data) => calls.push(data));
  emitter.emit('user.created', { id: 1 });
  assert.deepEqual(calls, [{ id: 1 }]);
});

test('wildcard-single', () => {
  const emitter = new WildcardEventEmitter();
  const calls = [];
  emitter.on('user.*', (event, data) => calls.push([event, data]));
  emitter.emit('user.created', 1);
  emitter.emit('user.deleted', 2);
  emitter.emit('user.profile.updated', 3);
  assert.deepEqual(calls, [
    ['user.created', 1],
    ['user.deleted', 2],
  ]);
});

test('wildcard-multi', () => {
  const emitter = new WildcardEventEmitter();
  const calls = [];
  emitter.on('user.**', (event) => calls.push(event));
  emitter.emit('user.profile.updated', null);
  emitter.emit('user.created', null);
  assert.deepEqual(calls, ['user.profile.updated', 'user.created']);
});

test('once-listener', () => {
  const emitter = new WildcardEventEmitter();
  let count = 0;
  emitter.once('user.created', () => {
    count += 1;
  });
  emitter.emit('user.created', null);
  emitter.emit('user.created', null);
  assert.equal(count, 1);
});

test('off-unsubscribe', () => {
  const emitter = new WildcardEventEmitter();
  let count = 0;
  const handler = () => {
    count += 1;
  };
  emitter.on('user.created', handler);
  emitter.off('user.created', handler);
  emitter.emit('user.created', null);
  assert.equal(count, 0);
});

test('error-isolation', () => {
  const emitter = new WildcardEventEmitter();
  const calls = [];
  emitter.on('user.created', () => {
    throw new Error('boom');
  });
  emitter.on('user.created', () => {
    calls.push('ok');
  });
  emitter.emit('user.created', null);
  assert.deepEqual(calls, ['ok']);
});
