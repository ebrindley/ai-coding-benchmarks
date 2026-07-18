// An in-memory, per-stream event store with optimistic concurrency control.
//
// Streams are append-only. Each event is assigned a 1-based `version` equal to
// its position in the stream. Readers can either replay a whole stream or fetch
// only the tail after a version they have already seen (used by snapshots and
// projection checkpoints).

import type { AccountEvent, StoredEvent } from './events';
import type { Clock } from './clock';

export class ConcurrencyError extends Error {
  constructor(streamId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Concurrency conflict on stream "${streamId}": expected version ` +
        `${expectedVersion} but stream is at ${actualVersion}`,
    );
    this.name = 'ConcurrencyError';
  }
}

export class EventStore {
  private readonly streams = new Map<string, StoredEvent[]>();

  constructor(private readonly clock: Clock) {}

  /** Current version of a stream (0 if it does not exist yet). */
  currentVersion(streamId: string): number {
    const stream = this.streams.get(streamId);
    return stream ? stream.length : 0;
  }

  /**
   * Append events to a stream under optimistic concurrency control.
   *
   * `expectedVersion` is the version the caller believes the stream is at; if
   * the stream has advanced past that, a ConcurrencyError is thrown so no
   * writes are applied. On success each new event is assigned the next
   * sequential version.
   */
  append(streamId: string, expectedVersion: number, events: AccountEvent[]): StoredEvent[] {
    const stream = this.streams.get(streamId) ?? [];
    const actualVersion = stream.length;

    if (actualVersion !== expectedVersion) {
      throw new ConcurrencyError(streamId, expectedVersion, actualVersion);
    }

    const appended: StoredEvent[] = [];
    for (const event of events) {
      const stored: StoredEvent = {
        streamId,
        version: stream.length + 1,
        recordedAt: this.clock.now(),
        event,
      };
      stream.push(stored);
      appended.push(stored);
    }

    this.streams.set(streamId, stream);
    return appended;
  }

  /**
   * Read events from a stream whose version is strictly greater than
   * `fromVersionExclusive`.
   *
   * The parameter is EXCLUSIVE: passing 0 replays the whole stream, and passing
   * the version of an already-seen event returns only the events recorded after
   * it. Snapshot rehydration and projection checkpoints both rely on this
   * exclusivity to avoid re-applying an event they have already folded in.
   */
  readStream(streamId: string, fromVersionExclusive = 0): StoredEvent[] {
    const stream = this.streams.get(streamId);
    if (!stream) return [];

    return stream.filter((stored) => stored.version >= fromVersionExclusive);
  }
}
