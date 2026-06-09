// Greenfield task: implement an immutable Money value type.
//
// Requirements are pinned by tests/money.test.ts. Implement every method so the
// tests pass. Money holds an integer number of minor units (e.g. cents) plus a
// 3-letter ISO currency code. Operations on mismatched currencies must throw.
//
// Do not change these signatures; do not edit the tests.

export class Money {
  readonly amount: number; // integer minor units (cents)
  readonly currency: string; // 3-letter ISO code, uppercase

  constructor(_amount: number, _currency: string) {
    throw new Error('TODO: implement');
  }

  static fromDollars(_value: number, _currency: string): Money {
    throw new Error('TODO: implement');
  }

  plus(_other: Money): Money {
    throw new Error('TODO: implement');
  }

  minus(_other: Money): Money {
    throw new Error('TODO: implement');
  }

  times(_factor: number): Money {
    throw new Error('TODO: implement');
  }

  equals(_other: Money): boolean {
    throw new Error('TODO: implement');
  }

  toString(): string {
    throw new Error('TODO: implement');
  }
}
