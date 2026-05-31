# Python Async Processor Fixture

Benchmark fixture for testing async concurrency bug fixes.

> **Baseline Intentionally Fails**
>
> This fixture's tests are designed to **FAIL on the buggy baseline** and **PASS after the fix**.
> Do not "fix" the failing tests - they expose the race condition that candidates must solve.
>
> | State | Tests Run | Results | Fix Applied |
> |-------|-----------|---------|-------------|
> | Baseline (current) | 8 (excl. perf) | 4 PASS, 4 FAIL | No `asyncio.Lock` |
> | After fix | 8 (excl. perf) | 8 PASS | `asyncio.Lock` in `claim_task()` |
>
> Performance tests are excluded by default (`-m 'not performance'`) to avoid CI flakiness.
> The deterministic test (`test_deterministic_interleaving_exposes_race`) forces the exact
> interleaving that causes duplicate task claims, making the race 100% reproducible.

## Task: Fix Race Condition in Task Processor

**Task ID**: `brownfield-003-python-async-race`

### The Bug

The `claim_task()` method in `src/processor.py` has a race condition:

```python
async def claim_task(self, worker_id: str) -> Optional[Task]:
    # BUG: No lock protecting this read-modify-write sequence!

    if task.status != TaskStatus.PENDING:  # Read
        return None

    await asyncio.sleep(0)  # Yield - race window!

    task.status = TaskStatus.CLAIMED  # Write - another worker may have claimed!
```

### Expected Fix

Add an `asyncio.Lock` to protect the critical section:

```python
def __init__(self, ...):
    self._lock = asyncio.Lock()  # Add this

async def claim_task(self, worker_id: str) -> Optional[Task]:
    async with self._lock:  # Wrap the critical section
        # ... existing code ...
```

### Constraints

1. **Must use asyncio primitives** - `asyncio.Lock`, `asyncio.Semaphore`, etc.
2. **No threading.Lock** - Wrong primitive for async code
3. **Throughput maintained** - Fix should not degrade performance by >10%
4. **All tests must pass** - Including race condition detection tests

## Quick Start

```bash
# Install dependencies
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# Run tests
.venv/bin/pytest tests/ -v

# Check for asyncio primitives
.venv/bin/python scripts/check_asyncio_primitives.py
```

## File Structure

```
python-async-processor/
├── src/
│   ├── __init__.py
│   └── processor.py         # TaskProcessor with race condition bug
├── tests/
│   ├── __init__.py
│   ├── conftest.py          # Deterministic scheduler fixtures
│   └── test_processor.py    # 12 tests (4 basic, 4 race, 4 throughput)
├── scripts/
│   ├── check_asyncio_primitives.py  # Verifies correct fix
│   └── check_fix_documented.py      # Nice-to-have: comments
└── pyproject.toml
```

## Test Categories

### Basic Functionality (4 tests)
- `test_add_task` - Tasks can be added
- `test_single_worker_processes_all_tasks` - Single worker works correctly
- `test_task_status_transitions` - Status transitions correctly
- `test_handler_receives_correct_payload` - Payloads are passed correctly

### Race Condition Detection (4 tests)
- `test_no_duplicate_processing` - Same task never processed twice
- `test_concurrent_claim_race_window` - Concurrent claims don't duplicate
- `test_high_contention_scenario` - Many workers, few tasks
- `test_deterministic_interleaving_exposes_race` - Forced interleaving test

### Throughput (4 tests)
- `test_throughput_maintained` - 100 tasks in <2 seconds
- `test_throughput_scales_with_workers` - More workers = faster
- `test_no_throughput_regression_with_fix` - Fix doesn't slow things down
- `test_cpu_bound_throughput` - CPU-bound tasks complete reasonably

## Exit Codes & Error IDs

### check_asyncio_primitives.py
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_ASYNCIO_PRIMITIVES` | asyncio.Lock properly used |
| 70 | `FAIL_NO_LOCK` | No asyncio primitive found |
| 71 | `FAIL_WRONG_PRIMITIVE` | Used threading.Lock instead |
| 72 | `FAIL_FILE_NOT_FOUND` | processor.py not found |

### check_fix_documented.py (nice-to-have)
| Exit | Error ID | Meaning |
|------|----------|---------|
| 0 | `PASS_FIX_DOCUMENTED` | Documentation found |
| 80 | `FAIL_NO_DOCUMENTATION` | No explanatory comments |
| 81 | `FAIL_FILE_NOT_FOUND` | File not found |

## Deterministic Testing

The `conftest.py` provides a `DeterministicScheduler` for controlled testing:

```python
@pytest.fixture
def deterministic_scheduler(deterministic_seed: int) -> DeterministicScheduler:
    return DeterministicScheduler(seed=deterministic_seed, interleave_strategy="race_prone")
```

This allows tests to:
- Use a fixed seed (42 by default) for reproducibility
- Control coroutine interleaving order
- Force specific execution patterns that expose race conditions
