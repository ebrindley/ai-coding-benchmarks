# ts-lru-cache fixture

Brownfield TypeScript fixture: a seeded LRU cache with an eviction-order bug.
Zero third-party dependencies — `node --test` for tests, `tsc` for type checking.

- `src/lru-cache.ts` contains a working-looking LRU cache with one bug.
- Fix the bug so all tests in `tests/lru-cache.test.ts` pass.
- Do not edit `tests/`.
