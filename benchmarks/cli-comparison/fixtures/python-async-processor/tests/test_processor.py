"""Tests for TaskProcessor - designed to reliably expose the race condition.

These tests use deterministic scheduling to make the race condition 100%
reproducible, rather than relying on timing luck.

Test count: 12 tests
- 4 basic functionality tests
- 4 race condition exposure tests
- 4 throughput/performance tests
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from src.processor import TaskProcessor, TaskStatus

# =============================================================================
# BASIC FUNCTIONALITY TESTS (4 tests)
# =============================================================================


class TestBasicFunctionality:
    """Tests for basic processor operations."""

    async def test_add_task(self):
        """Tasks can be added to the processor."""
        processor = TaskProcessor(num_workers=1)
        task = processor.add_task("task-1", {"data": "test"})

        assert task.id == "task-1"
        assert task.status == TaskStatus.PENDING
        assert task.payload == {"data": "test"}
        assert processor.pending_count == 1

    async def test_single_worker_processes_all_tasks(self):
        """Single worker processes all tasks without issues."""
        processor = TaskProcessor(num_workers=1)

        for i in range(10):
            processor.add_task(f"task-{i}", i)

        async def handler(payload: int) -> int:
            return payload * 2

        result = await processor.run(handler)

        assert result["processed_count"] == 10
        assert result["duplicate_count"] == 0
        assert processor.pending_count == 0

    async def test_task_status_transitions(self):
        """Tasks transition through correct status states."""
        processor = TaskProcessor(num_workers=1)
        task = processor.add_task("task-1", "payload")

        assert task.status == TaskStatus.PENDING

        async def handler(payload: Any) -> str:
            return f"processed-{payload}"

        await processor.run(handler)

        task = processor.get_task("task-1")
        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "processed-payload"

    async def test_handler_receives_correct_payload(self):
        """Handler receives the correct payload for each task."""
        processor = TaskProcessor(num_workers=1)
        received_payloads = []

        processor.add_task("task-1", {"key": "value1"})
        processor.add_task("task-2", {"key": "value2"})

        async def handler(payload: dict) -> dict:
            received_payloads.append(payload)
            return payload

        await processor.run(handler)

        assert len(received_payloads) == 2
        assert {"key": "value1"} in received_payloads
        assert {"key": "value2"} in received_payloads


# =============================================================================
# RACE CONDITION EXPOSURE TESTS (4 tests)
# =============================================================================


class TestRaceCondition:
    """Tests that expose the race condition in claim_task().

    These tests use controlled concurrency patterns to reliably
    reproduce the race condition, making it 100% reproducible
    rather than probabilistic.
    """

    async def test_no_duplicate_processing(self):
        """MUST PASS AFTER FIX: Same task should never be processed twice.

        This test runs multiple workers concurrently and checks for duplicates.
        With the bug present, this test will fail due to duplicate processing.
        """
        processor = TaskProcessor(num_workers=10)

        # Add enough tasks to create contention
        for i in range(100):
            processor.add_task(f"task-{i}", i)

        processed_ids: list[str] = []

        async def tracking_handler(payload: int) -> int:
            # Record which task was processed
            task_id = f"task-{payload}"
            processed_ids.append(task_id)
            # Small delay to increase race window
            await asyncio.sleep(0.001)
            return payload

        result = await processor.run(tracking_handler)

        # Check for duplicates
        unique_ids = set(processed_ids)
        duplicate_count = len(processed_ids) - len(unique_ids)

        # This assertion will FAIL with the bug present
        assert duplicate_count == 0, (
            f"Duplicate processing detected: {duplicate_count} duplicates. "
            f"Processed {len(processed_ids)} total, {len(unique_ids)} unique."
        )
        assert result["duplicate_count"] == 0

    async def test_concurrent_claim_race_window(self):
        """Expose race condition by forcing concurrent claims.

        This test creates a specific interleaving that maximizes
        the probability of hitting the race window in claim_task().
        """
        processor = TaskProcessor(num_workers=5)

        # Add just a few tasks so workers compete heavily
        for i in range(5):
            processor.add_task(f"task-{i}", i)

        claim_order: list[tuple[str, str]] = []

        async def tracking_handler(payload: int) -> int:
            worker_id = asyncio.current_task().get_name() if asyncio.current_task() else "unknown"
            task_id = f"task-{payload}"
            claim_order.append((worker_id, task_id))
            return payload

        # Run multiple times to increase chance of race
        for _ in range(10):
            processor._tasks.clear()
            processor._pending_queue.clear()
            processor._results.clear()
            claim_order.clear()

            for i in range(5):
                processor.add_task(f"task-{i}", i)

            result = await processor.run(tracking_handler)

            # With the bug, we might see more than 5 processings
            # because multiple workers claim the same task
            if result["duplicate_count"] > 0:
                pytest.fail(
                    f"Race condition detected: {result['duplicate_count']} duplicates "
                    f"in claim order: {claim_order}"
                )

    async def test_high_contention_scenario(self):
        """Test under high contention with many workers and few tasks.

        This scenario maximizes the chance of multiple workers
        reading the same task as PENDING before any updates the status.
        """
        # Many workers, few tasks = high contention
        processor = TaskProcessor(num_workers=20)

        for i in range(10):
            processor.add_task(f"task-{i}", i)

        process_count = 0

        async def counting_handler(payload: int) -> int:
            nonlocal process_count
            process_count += 1
            await asyncio.sleep(0)  # Yield point
            return payload

        result = await processor.run(counting_handler)

        # Without the fix, process_count might be > 10
        assert process_count == 10, (
            f"Expected 10 processings but got {process_count}. "
            f"Duplicate processing indicates race condition."
        )
        assert result["duplicate_count"] == 0

    async def test_deterministic_interleaving_exposes_race(self):
        """MUST FAIL ON BASELINE: Forces deterministic race via coordinated yield.

        This test monkey-patches asyncio.sleep to synchronize workers at the
        yield point, guaranteeing they both pass the status check before either
        writes. This makes the race 100% reproducible.

        Race scenario forced by this test:
        1. Worker A: enters claim_task, passes status check (PENDING)
        2. Worker A: reaches asyncio.sleep(0), waits at barrier
        3. Worker B: enters claim_task, passes status check (PENDING) <-- A hasn't written!
        4. Worker B: reaches asyncio.sleep(0), releases barrier
        5. Both workers continue past yield simultaneously
        6. Worker A: sets status=CLAIMED, returns task
        7. Worker B: sets status=CLAIMED (overwrites!), returns same task
        8. BOTH workers have the task = duplicate processing!

        After adding asyncio.Lock to claim_task, only one worker will claim.
        """
        processor = TaskProcessor(num_workers=2)
        processor.add_task("task-1", 1)

        claims: list[tuple[str, str]] = []
        workers_at_yield = 0
        release_barrier = asyncio.Event()
        coordination_lock = asyncio.Lock()

        original_sleep = asyncio.sleep

        async def synchronized_sleep(delay):
            """Force both workers to be at the yield point before either continues."""
            nonlocal workers_at_yield

            async with coordination_lock:
                workers_at_yield += 1
                if workers_at_yield >= 2:
                    release_barrier.set()

            await release_barrier.wait()
            await original_sleep(0)

        # Monkey-patch asyncio.sleep
        asyncio.sleep = synchronized_sleep

        try:

            async def racing_worker(worker_id: str):
                task = await processor.claim_task(worker_id)
                if task:
                    claims.append((worker_id, task.id))

            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        racing_worker("worker-A"),
                        racing_worker("worker-B"),
                    ),
                    timeout=1.0,
                )
            except asyncio.TimeoutError:
                pytest.fail(
                    "DEADLOCK DETECTED: workers blocked at coordinated yield.\n"
                    "This commonly happens if claim_task() holds a lock while awaiting.\n"
                    "Fix by making the claim operation atomic with a lock, but do not await\n"
                    "inside the locked section (remove/move the asyncio.sleep(0) yield)."
                )
        finally:
            asyncio.sleep = original_sleep

        # CRITICAL ASSERTION:
        # BASELINE (buggy): Both workers claim task-1 → len(claims) == 2
        # FIXED (with lock): Only one worker claims task-1 → len(claims) == 1
        assert len(claims) == 1, (
            f"RACE CONDITION DETECTED: {len(claims)} workers claimed task-1!\n"
            f"Claims: {claims}\n"
            f"This happens because claim_task() lacks atomicity.\n"
            f"FIX: Add asyncio.Lock to protect the read-modify-write sequence."
        )


# =============================================================================
# THROUGHPUT TESTS (4 tests) - Marked as performance, excluded by default
# Run with: pytest -m performance
# =============================================================================


@pytest.mark.performance
class TestThroughput:
    """Tests for processing throughput requirements.

    These tests are time-based and may be flaky across different machines/CI load.
    They are marked @pytest.mark.performance and excluded from default test runs.
    Run explicitly with: pytest -m performance
    """

    async def test_throughput_maintained(self):
        """MUST PASS: Process 100 tasks in under 2 seconds.

        The fix should not significantly degrade throughput.
        """
        processor = TaskProcessor(num_workers=10)

        for i in range(100):
            processor.add_task(f"task-{i}", i)

        async def simple_handler(payload: int) -> int:
            # Simulate minimal work
            await asyncio.sleep(0.001)
            return payload

        start = time.monotonic()
        result = await processor.run(simple_handler)
        elapsed = time.monotonic() - start

        assert result["processed_count"] == 100
        assert elapsed < 2.0, f"Throughput too slow: {elapsed:.2f}s > 2.0s"

    async def test_throughput_scales_with_workers(self):
        """More workers should improve throughput (up to a point)."""
        times = {}

        for num_workers in [1, 4, 8]:
            processor = TaskProcessor(num_workers=num_workers)

            for i in range(50):
                processor.add_task(f"task-{i}", i)

            async def handler(payload: int) -> int:
                await asyncio.sleep(0.01)  # Simulate IO-bound work
                return payload

            start = time.monotonic()
            await processor.run(handler)
            times[num_workers] = time.monotonic() - start

        # With more workers, processing should be faster (for IO-bound work)
        assert times[4] < times[1], "4 workers should be faster than 1"
        assert times[8] <= times[4] * 1.5, "8 workers shouldn't be much slower than 4"

    async def test_no_throughput_regression_with_fix(self):
        """Throughput should remain within 10% of baseline after fix.

        Baseline: ~0.5s for 100 tasks with 10 workers (1ms each)
        Acceptable: < 0.55s (10% regression)
        """
        processor = TaskProcessor(num_workers=10)

        for i in range(100):
            processor.add_task(f"task-{i}", i)

        async def timed_handler(payload: int) -> int:
            await asyncio.sleep(0.001)  # 1ms per task
            return payload

        start = time.monotonic()
        result = await processor.run(timed_handler)
        elapsed = time.monotonic() - start

        # With 10 workers and 100 tasks of 1ms each, theoretical minimum is 10ms
        # Practical minimum is ~100ms due to overhead
        # We allow up to 550ms (10% over a 500ms baseline)
        assert result["processed_count"] == 100
        assert elapsed < 0.55, f"Throughput regression: {elapsed:.3f}s > 0.55s"

    async def test_cpu_bound_throughput(self):
        """CPU-bound tasks should still complete in reasonable time."""
        processor = TaskProcessor(num_workers=4)

        for i in range(20):
            processor.add_task(f"task-{i}", i)

        def cpu_work(payload: int) -> int:
            # Simulate CPU work
            total = 0
            for j in range(10000):
                total += j * payload
            return total

        start = time.monotonic()
        result = await processor.run(cpu_work)
        elapsed = time.monotonic() - start

        assert result["processed_count"] == 20
        # CPU-bound work doesn't benefit much from async, but shouldn't be terribly slow
        assert elapsed < 5.0, f"CPU-bound throughput too slow: {elapsed:.2f}s"
