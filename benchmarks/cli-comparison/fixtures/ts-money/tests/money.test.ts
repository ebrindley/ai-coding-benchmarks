import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money.ts';

test('construct-and-read', () => {
  const m = new Money(500, 'usd');
  assert.equal(m.amount, 500);
  assert.equal(m.currency, 'USD'); // normalized to uppercase
});

test('reject-non-integer-amount', () => {
  assert.throws(() => new Money(1.5, 'USD'));
});

test('reject-bad-currency', () => {
  assert.throws(() => new Money(100, 'US'));
  assert.throws(() => new Money(100, 'usdd'));
});

test('from-dollars', () => {
  assert.equal(Money.fromDollars(5, 'USD').amount, 500);
  assert.equal(Money.fromDollars(5.99, 'USD').amount, 599);
  // rounds to nearest cent
  assert.equal(Money.fromDollars(0.015, 'USD').amount, 2);
});

test('plus-same-currency', () => {
  const r = new Money(500, 'USD').plus(new Money(250, 'USD'));
  assert.equal(r.amount, 750);
  assert.equal(r.currency, 'USD');
});

test('minus-same-currency', () => {
  assert.equal(new Money(500, 'USD').minus(new Money(200, 'USD')).amount, 300);
});

test('arithmetic-rejects-currency-mismatch', () => {
  assert.throws(() => new Money(500, 'USD').plus(new Money(100, 'EUR')));
  assert.throws(() => new Money(500, 'USD').minus(new Money(100, 'EUR')));
});

test('times-rounds-to-integer-cents', () => {
  assert.equal(new Money(100, 'USD').times(3).amount, 300);
  assert.equal(new Money(100, 'USD').times(0.085).amount, 9); // 8.5 -> 9
});

test('immutability', () => {
  const a = new Money(500, 'USD');
  a.plus(new Money(500, 'USD'));
  assert.equal(a.amount, 500); // original unchanged
});

test('equals', () => {
  assert.ok(new Money(500, 'USD').equals(new Money(500, 'USD')));
  assert.ok(!new Money(500, 'USD').equals(new Money(500, 'EUR')));
  assert.ok(!new Money(500, 'USD').equals(new Money(400, 'USD')));
});

test('to-string', () => {
  assert.equal(new Money(1234, 'USD').toString(), 'USD 12.34');
  assert.equal(new Money(5, 'USD').toString(), 'USD 0.05');
});
