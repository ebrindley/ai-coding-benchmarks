// A minimal injectable clock so event timestamps are deterministic in tests.
// Production code would wire in a wall-clock implementation; tests use a
// hand-advanced clock so no real timers are involved.

export interface Clock {
  now(): string;
}

/**
 * A clock that advances by a fixed step every time it is read, starting from a
 * fixed epoch. Deterministic and dependency-free.
 */
export class ManualClock implements Clock {
  private current: number;
  private readonly stepMs: number;

  constructor(startIso = '2024-01-01T00:00:00.000Z', stepMs = 1000) {
    this.current = Date.parse(startIso);
    this.stepMs = stepMs;
  }

  now(): string {
    const iso = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return iso;
  }
}
