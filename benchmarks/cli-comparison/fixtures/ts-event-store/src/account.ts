// The account aggregate: its state shape and the pure reducer that folds a
// stream of events into that state. The reducer is deliberately NOT idempotent
// on re-applied events — deposits and withdrawals accumulate — so applying the
// same event twice corrupts the balance. That property is what turns an
// off-by-one in the store's read boundary into a visible balance error.

import type { AccountEvent } from './events';

export type AccountState = {
  accountId: string;
  owner: string;
  balance: number;
  frozen: boolean;
  /** Version of the last event folded into this state. */
  version: number;
  exists: boolean;
};

export function emptyState(): AccountState {
  return {
    accountId: '',
    owner: '',
    balance: 0,
    frozen: false,
    version: 0,
    exists: false,
  };
}

/**
 * Apply a single event to the state, returning the next state. Pure: never
 * mutates its input.
 */
export function apply(state: AccountState, event: AccountEvent, version: number): AccountState {
  switch (event.type) {
    case 'AccountOpened':
      return {
        ...state,
        accountId: event.accountId,
        owner: event.owner,
        exists: true,
        version,
      };
    case 'MoneyDeposited':
      return { ...state, balance: state.balance + event.amount, version };
    case 'MoneyWithdrawn':
      return { ...state, balance: state.balance - event.amount, version };
    case 'AccountFrozen':
      return { ...state, frozen: true, version };
    case 'AccountUnfrozen':
      return { ...state, frozen: false, version };
    default: {
      // Exhaustiveness guard: if a new event type is added without a case
      // above, this line stops compiling.
      const unreachable: never = event;
      return unreachable;
    }
  }
}
