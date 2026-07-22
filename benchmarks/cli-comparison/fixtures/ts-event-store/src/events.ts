// Domain events for a simple bank-account ledger, modelled as a discriminated
// union on the `type` field. Every persisted event carries an envelope with a
// monotonically increasing per-stream `version` (1-based) assigned by the
// store at append time.

export type AccountOpened = {
  type: 'AccountOpened';
  accountId: string;
  owner: string;
};

export type MoneyDeposited = {
  type: 'MoneyDeposited';
  accountId: string;
  amount: number;
};

export type MoneyWithdrawn = {
  type: 'MoneyWithdrawn';
  accountId: string;
  amount: number;
};

export type AccountFrozen = {
  type: 'AccountFrozen';
  accountId: string;
  reason: string;
};

export type AccountUnfrozen = {
  type: 'AccountUnfrozen';
  accountId: string;
};

/** The union of all domain event payloads. */
export type AccountEvent =
  | AccountOpened
  | MoneyDeposited
  | MoneyWithdrawn
  | AccountFrozen
  | AccountUnfrozen;

/**
 * A persisted event: the domain payload plus store-assigned metadata.
 * `version` is the 1-based position of this event within its stream.
 */
export type StoredEvent<E extends AccountEvent = AccountEvent> = {
  streamId: string;
  version: number;
  recordedAt: string;
  event: E;
};
