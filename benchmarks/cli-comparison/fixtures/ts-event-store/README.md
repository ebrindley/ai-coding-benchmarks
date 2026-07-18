# ts-event-store fixture

Brownfield TypeScript fixture: an event-sourced bank-account ledger with a
single seeded bug that only surfaces on the incremental read paths (snapshot
rehydration and projection catch-up), not on a naive full replay.

The module spans several files that share one contract — the event store's
"read events after a version" boundary:

- `src/events.ts` — domain events (discriminated union) and the stored-event
  envelope with a per-stream `version`.
- `src/event-store.ts` — append-only, per-stream store with optimistic
  concurrency and an exclusive `readStream(streamId, fromVersionExclusive)`.
- `src/account.ts` — the aggregate state and a pure, accumulating reducer.
- `src/snapshot-store.ts` — in-memory snapshots of aggregate state at a version.
- `src/account-repository.ts` — rehydrates from snapshot + tail read, or full
  replay.
- `src/balance-projection.ts` — a read model that catches up from a checkpoint.

The bug is a boundary error: events applied on the incremental path are
double-counted, so balances loaded via a snapshot or projected via a checkpoint
drift from the ground truth produced by a full replay. Full replay from version
0 looks correct, which masks the defect.

## Working with the fixture

```
npm install --no-audit --no-fund --package-lock=false
npm run typecheck   # tsc --noEmit (strict); the bug is a runtime defect, so this is clean
npm run lint        # eslint (flat config, eslint 9)
npm test            # jest
```

- Find and fix the bug so all tests in `tests/` pass.
- Do not edit `tests/`. `npm run check-no-test-edits` enforces this.
- The fix must keep the public API and the documented read-boundary semantics
  intact.
