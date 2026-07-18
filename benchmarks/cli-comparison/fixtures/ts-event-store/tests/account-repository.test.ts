import { beforeEach, describe, expect, test } from '@jest/globals';
import { ManualClock } from '../src/clock';
import { EventStore } from '../src/event-store';
import { SnapshotStore } from '../src/snapshot-store';
import { AccountRepository } from '../src/account-repository';
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

describe('AccountRepository', () => {
  let events: EventStore;
  let snapshots: SnapshotStore;
  let repo: AccountRepository;

  beforeEach(() => {
    events = new EventStore(new ManualClock());
    snapshots = new SnapshotStore();
    repo = new AccountRepository(events, snapshots);
  });

  test('full-replay-load-is-correct', () => {
    repo.save(STREAM, 0, [open(), deposit(100), deposit(50), withdraw(30)]);
    const state = repo.load(STREAM);
    expect(state.balance).toBe(120);
    expect(state.version).toBe(4);
    expect(state.exists).toBe(true);
  });

  // A snapshot captures state at version N. A later load starts from the
  // snapshot and must fold in ONLY the events after N. If the boundary event
  // (version N) is re-applied, the accumulating reducer double-counts it.
  test('snapshot-rehydration-does-not-double-count-boundary-event', () => {
    repo.save(STREAM, 0, [open(), deposit(100), deposit(50)]);
    // State is now: balance 150 at version 3. Snapshot it.
    repo.snapshot(STREAM);

    // Append one more event after the snapshot boundary.
    repo.save(STREAM, 3, [withdraw(30)]);

    const state = repo.load(STREAM);
    expect(state.balance).toBe(120);
    expect(state.version).toBe(4);
  });

  test('snapshot-with-no-new-events-returns-snapshot-state', () => {
    repo.save(STREAM, 0, [open(), deposit(100), deposit(50)]);
    repo.snapshot(STREAM);

    // No events appended after the snapshot: load must equal the snapshot.
    const state = repo.load(STREAM);
    expect(state.balance).toBe(150);
    expect(state.version).toBe(3);
  });
});
