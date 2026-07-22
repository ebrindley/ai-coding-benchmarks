// The account repository ties the event store, reducer, and snapshot store
// together. It is the read/write API the rest of the application uses.
//
// Rehydration strategy:
//   - If a snapshot exists, start from the snapshot state and fold in only the
//     events recorded *after* the snapshot's version.
//   - Otherwise replay the whole stream from the beginning.
//
// Because the reducer accumulates deposits/withdrawals (see account.ts), the
// tail read after a snapshot must be strictly exclusive of the snapshot
// version, or the snapshot's boundary event is counted twice.

import { apply, emptyState, type AccountState } from './account';
import type { AccountEvent } from './events';
import { EventStore } from './event-store';
import { SnapshotStore } from './snapshot-store';

export class AccountRepository {
  constructor(
    private readonly events: EventStore,
    private readonly snapshots: SnapshotStore,
  ) {}

  /** Rehydrate the current state of an account from storage. */
  load(streamId: string): AccountState {
    const snapshot = this.snapshots.load(streamId);

    let state: AccountState;
    let fromVersion: number;

    if (snapshot) {
      state = snapshot.state;
      fromVersion = snapshot.version;
    } else {
      state = emptyState();
      fromVersion = 0;
    }

    // Fold in every event recorded after the point we already have state for.
    const tail = this.events.readStream(streamId, fromVersion);
    for (const stored of tail) {
      state = apply(state, stored.event, stored.version);
    }

    return state;
  }

  /**
   * Append new events to an account under optimistic concurrency control. The
   * caller supplies the version it last observed; a stale version is rejected
   * by the event store.
   */
  save(streamId: string, expectedVersion: number, newEvents: AccountEvent[]): AccountState {
    this.events.append(streamId, expectedVersion, newEvents);
    return this.load(streamId);
  }

  /** Persist a snapshot of the current state so future loads can skip replay. */
  snapshot(streamId: string): void {
    const state = this.load(streamId);
    this.snapshots.save({ streamId, version: state.version, state });
  }
}
