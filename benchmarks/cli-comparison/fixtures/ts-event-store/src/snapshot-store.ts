// A trivial in-memory snapshot store. A snapshot captures an aggregate's state
// at a particular version so rehydration can skip replaying the whole stream
// from the beginning and only fold in the events recorded after the snapshot.

import type { AccountState } from './account';

export type Snapshot = {
  streamId: string;
  version: number;
  state: AccountState;
};

export class SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();

  save(snapshot: Snapshot): void {
    this.snapshots.set(snapshot.streamId, snapshot);
  }

  load(streamId: string): Snapshot | undefined {
    return this.snapshots.get(streamId);
  }
}
