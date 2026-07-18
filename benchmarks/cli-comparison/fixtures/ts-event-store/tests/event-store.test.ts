import { beforeEach, describe, expect, test } from '@jest/globals';
import { ManualClock } from '../src/clock';
import { EventStore, ConcurrencyError } from '../src/event-store';
import type { AccountEvent } from '../src/events';

const STREAM = 'acc-1';

function open(): AccountEvent {
  return { type: 'AccountOpened', accountId: STREAM, owner: 'Ada' };
}
function deposit(amount: number): AccountEvent {
  return { type: 'MoneyDeposited', accountId: STREAM, amount };
}

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(new ManualClock());
  });

  test('assigns sequential 1-based versions on append', () => {
    const appended = store.append(STREAM, 0, [open(), deposit(100), deposit(50)]);
    expect(appended.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(store.currentVersion(STREAM)).toBe(3);
  });

  test('rejects a stale expected version without writing', () => {
    store.append(STREAM, 0, [open()]);
    expect(() => store.append(STREAM, 0, [deposit(100)])).toThrow(ConcurrencyError);
    // The rejected append must not have been persisted.
    expect(store.currentVersion(STREAM)).toBe(1);
  });

  test('readStream with fromVersion 0 replays the whole stream', () => {
    store.append(STREAM, 0, [open(), deposit(100), deposit(50)]);
    const all = store.readStream(STREAM, 0);
    expect(all.map((e) => e.version)).toEqual([1, 2, 3]);
  });

  // The read boundary is documented as EXCLUSIVE: readStream(id, n) must return
  // only events whose version is strictly greater than n. Snapshot rehydration
  // and projection catch-up both depend on this to avoid re-applying an event.
  test('readStream-is-exclusive-of-fromVersion', () => {
    store.append(STREAM, 0, [open(), deposit(100), deposit(50)]);

    const afterV2 = store.readStream(STREAM, 2);
    expect(afterV2.map((e) => e.version)).toEqual([3]);

    const afterV3 = store.readStream(STREAM, 3);
    expect(afterV3.map((e) => e.version)).toEqual([]);
  });
});
