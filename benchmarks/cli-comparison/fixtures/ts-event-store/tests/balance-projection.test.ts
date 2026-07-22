import { beforeEach, describe, expect, test } from '@jest/globals';
import { ManualClock } from '../src/clock';
import { EventStore } from '../src/event-store';
import { BalanceProjection } from '../src/balance-projection';
import type { AccountEvent } from '../src/events';

const STREAM = 'acc-1';

function open(): AccountEvent {
  return { type: 'AccountOpened', accountId: STREAM, owner: 'Ada' };
}
function deposit(amount: number): AccountEvent {
  return { type: 'MoneyDeposited', accountId: STREAM, amount };
}
function withdraw(amount: number): AccountEvent {
  return { type: 'MoneyWithdrawn', accountId: STREAM, amount };
}

describe('BalanceProjection', () => {
  let events: EventStore;
  let projection: BalanceProjection;

  beforeEach(() => {
    events = new EventStore(new ManualClock());
    projection = new BalanceProjection(events);
  });

  test('single-catch-up-from-empty-checkpoint-is-correct', () => {
    events.append(STREAM, 0, [open(), deposit(100), withdraw(30)]);
    projection.catchUp(STREAM);
    expect(projection.balanceOf(STREAM)).toBe(70);
    expect(projection.checkpointOf(STREAM)).toBe(3);
  });

  // The projection processes events incrementally: each catchUp reads only the
  // events after its checkpoint. If the checkpoint event is re-read, it is
  // folded in a second time and the running balance drifts.
  test('incremental-catch-up-does-not-reprocess-checkpoint-event', () => {
    events.append(STREAM, 0, [open(), deposit(100)]);
    projection.catchUp(STREAM);
    expect(projection.balanceOf(STREAM)).toBe(100);

    // A second batch of events arrives; only these should be processed.
    events.append(STREAM, 2, [deposit(50), withdraw(20)]);
    projection.catchUp(STREAM);

    expect(projection.balanceOf(STREAM)).toBe(130);
    expect(projection.checkpointOf(STREAM)).toBe(4);
  });

  test('catch-up-with-no-new-events-is-a-no-op', () => {
    events.append(STREAM, 0, [open(), deposit(100)]);
    projection.catchUp(STREAM);
    projection.catchUp(STREAM);
    expect(projection.balanceOf(STREAM)).toBe(100);
    expect(projection.checkpointOf(STREAM)).toBe(2);
  });
});
