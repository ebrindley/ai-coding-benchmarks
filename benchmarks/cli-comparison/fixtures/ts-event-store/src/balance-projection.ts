// A read-model projection that maintains a running balance per account by
// consuming events incrementally. Unlike a full rehydrate, a projection keeps a
// checkpoint (the last version it has processed) and, when asked to catch up,
// reads only the events after that checkpoint and folds them into the existing
// read model.
//
// This is the second place that depends on the store's exclusive read
// boundary: if the tail read includes the checkpoint event itself, that event
// is applied a second time and the projected balance drifts.

import type { AccountEvent } from './events';
import { EventStore } from './event-store';

type ProjectedBalance = {
  balance: number;
  checkpoint: number;
};

export class BalanceProjection {
  private readonly balances = new Map<string, ProjectedBalance>();

  constructor(private readonly events: EventStore) {}

  /** Fold a single event into the running balance for a stream. */
  private applyEvent(current: number, event: AccountEvent): number {
    switch (event.type) {
      case 'MoneyDeposited':
        return current + event.amount;
      case 'MoneyWithdrawn':
        return current - event.amount;
      default:
        return current;
    }
  }

  /**
   * Bring the projection for a single stream up to date by reading only the
   * events recorded after the stored checkpoint.
   */
  catchUp(streamId: string): void {
    const existing = this.balances.get(streamId) ?? { balance: 0, checkpoint: 0 };

    const tail = this.events.readStream(streamId, existing.checkpoint);
    let balance = existing.balance;
    let checkpoint = existing.checkpoint;

    for (const stored of tail) {
      balance = this.applyEvent(balance, stored.event);
      checkpoint = stored.version;
    }

    this.balances.set(streamId, { balance, checkpoint });
  }

  balanceOf(streamId: string): number {
    return this.balances.get(streamId)?.balance ?? 0;
  }

  checkpointOf(streamId: string): number {
    return this.balances.get(streamId)?.checkpoint ?? 0;
  }
}
