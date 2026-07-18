# Python Inventory Pipeline Cache Fixture

Benchmark fixture for testing cross-module bug fixes.

> **Baseline Intentionally Fails**
>
> This fixture's tests are designed to **FAIL on the buggy baseline** and **PASS after the fix**.
> Do not "fix" the failing tests - they expose a stale-read bug that candidates must solve.
>
> | State | Tests Run | Results | Fix Applied |
> |-------|-----------|---------|-------------|
> | Baseline (current) | 33 | 26 PASS, 7 FAIL | Flush invalidates by raw label |
> | After fix | 33 | 33 PASS | Flush invalidates by canonical category |
>
> Time is injected via a `FakeClock` (see `tests/conftest.py`) and the cache TTL is set far
> larger than any test advances, so the staleness the failing tests observe is caused **only**
> by the invalidation bug, never by TTL expiry.

## Task: Fix Stale Cache Reads in the Inventory Pipeline

**Task ID**: `brownfield-014-python-pipeline-cache-invalidation`

### The Bug

The system is an inventory service split across four modules:

| Module | Responsibility |
|--------|----------------|
| `src/normalize.py` | Canonicalizes raw category labels (casing, whitespace, aliases) |
| `src/store.py` | Holds products; keeps category labels **verbatim**; logs raw dirty labels |
| `src/cache.py` | Tag-aware TTL cache; drops entries by **exact** tag string |
| `src/service.py` | Coordinates reads/writes; **bug lives here** |

Reads cache report results and **tag them by the canonical category**:

```python
canonical = canonical_category(category)      # e.g. "home & kitchen"
self._cache.set(key, summary, tags=[canonical])
```

Writes flush by draining the store's dirty labels and invalidating tags:

```python
def _flush(self):
    for raw_label in self._store.drain_dirty_categories():
        # BUG: raw_label is verbatim ("Home & Kitchen"), but the cache entry
        # was tagged with the canonical form ("home & kitchen"). The tag never
        # matches, so the stale summary survives the flush.
        self._cache.invalidate_tag(raw_label)
```

Because the store preserves labels verbatim while the cache is tagged by canonical category,
`invalidate_tag(raw_label)` misses whenever `raw_label != canonical_category(raw_label)`.
The read then returns a **stale** summary/low-stock report.

### Expected Fix

Route the drained label through the normalizer before invalidating, so the write path and the
read path agree on the tag namespace:

```python
def _flush(self):
    for raw_label in self._store.drain_dirty_categories():
        self._cache.invalidate_tag(canonical_category(raw_label))
```

The fix spans the seam between `store.py` (raw labels), `normalize.py` (canonical form), and
`cache.py` (exact-match tags), coordinated in `service.py`. Do **not** fix it by making the
store normalize labels (it must preserve them verbatim - `test_store.py` pins that) or by
weakening the cache's exact-match invalidation.

### Constraints

1. **No test modifications** - all shipped tests must pass as-is.
2. **Store keeps labels verbatim** - `Product.category` must round-trip unchanged.
3. **Cache stays exact-match** - `invalidate_tag` compares tag strings exactly.
4. **No API changes** - public method signatures stay identical.

## Quick Start

```bash
# Install dependencies
bash scripts/setup-venv.sh

# Run tests (8 fail on the baseline, all pass after the fix)
.venv/bin/python -m pytest tests/ -v

# Behavioural coherence check (fails on baseline, passes after fix)
.venv/bin/python scripts/check_cache_coherence.py
```

## File Structure

```
python-pipeline-cache/
├── src/
│   ├── __init__.py
│   ├── normalize.py       # Canonical category form (correct)
│   ├── cache.py           # Tag-aware TTL cache, injected clock (correct)
│   ├── store.py           # Verbatim product store + raw dirty log (correct)
│   └── service.py         # Coordinator - BUG in _flush()
├── tests/
│   ├── __init__.py
│   ├── conftest.py               # FakeClock + seeded service fixtures
│   ├── test_normalize.py         # 8 tests (pass on baseline)
│   ├── test_cache.py             # 8 tests (pass on baseline)
│   ├── test_store.py             # 6 tests (pass on baseline)
│   └── test_service_integration.py  # 12 tests (4 pass, 8 fail on baseline)
├── scripts/
│   ├── setup-venv.sh
│   ├── check_no_test_edits.py    # Gate: no test files modified
│   └── check_cache_coherence.py  # Must-have: reports fresh after mutation
└── pyproject.toml
```

## Test Categories

### Unit (22 tests, pass on baseline)
- `test_normalize.py` - canonicalization rules and equivalence
- `test_cache.py` - TTL, exact-match tag invalidation
- `test_store.py` - verbatim labels, raw dirty log

### Integration (12 tests)
- `TestReadCorrectness` (4) - cold reads, canonical aggregation (pass on baseline)
- `TestFreshAfterMutation` (8) - warm cache, mutate, re-read (**fail on baseline**)

## Exit Codes & Error IDs

All scripts emit grep-able error IDs in format `[ERROR_ID] message` to stderr.

### check_no_test_edits.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_NO_TEST_EDITS` | No test files modified |
| 10 | `FAIL_TEST_FILES_MODIFIED` | Test files were modified |
| 11 | `FAIL_GIT_ERROR` | Could not determine modified files |

### check_cache_coherence.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_CACHE_COHERENT` | Cached reports reflect mutations |
| 90 | `FAIL_STALE_SUMMARY` | Summary served a stale value after a mutation |
| 91 | `FAIL_STALE_LOW_STOCK` | Low-stock report served a stale value |
| 92 | `FAIL_IMPORT_ERROR` | Could not import the service package |

## CI Usage

```bash
# Run coherence check and extract the error ID
.venv/bin/python scripts/check_cache_coherence.py 2>&1 | grep -oE "^\[[A-Z_]+\]"
echo "Exit code: $?"
```
