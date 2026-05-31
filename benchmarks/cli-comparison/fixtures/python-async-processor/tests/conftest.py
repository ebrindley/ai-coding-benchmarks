"""Pytest configuration and fixtures for deterministic async testing.

This module provides fixtures for reproducible concurrency testing:
- DeterministicScheduler: Controls task execution order for reliable race reproduction
- Fixed seed for random operations
- Controlled yield points

The key insight is that race conditions become 100% reproducible when you
control the order in which coroutines resume after yielding.
"""

from __future__ import annotations

import asyncio
import random
from collections import deque
from dataclasses import dataclass
from typing import Any, Coroutine, Deque, Dict, List, Optional

import pytest


@dataclass
class ScheduledTask:
    """A coroutine scheduled for execution."""

    coro: Coroutine[Any, Any, Any]
    name: str
    priority: int = 0


class DeterministicScheduler:
    """A scheduler that controls coroutine execution order for deterministic testing.

    This scheduler allows tests to:
    1. Queue coroutines in a specific order
    2. Step through execution one yield at a time
    3. Force specific interleavings that expose race conditions

    Usage:
        scheduler = DeterministicScheduler(seed=42)
        scheduler.schedule(coro1, "worker-1")
        scheduler.schedule(coro2, "worker-2")

        # Run until all complete, with deterministic interleaving
        await scheduler.run_all()
    """

    def __init__(self, seed: int = 42, interleave_strategy: str = "round_robin"):
        """Initialize the scheduler.

        Args:
            seed: Random seed for reproducible "random" scheduling
            interleave_strategy: How to interleave coroutines:
                - "round_robin": Strict alternation between tasks
                - "random": Seeded random selection (reproducible)
                - "race_prone": Designed to expose race conditions
        """
        self._seed = seed
        self._random = random.Random(seed)
        self._strategy = interleave_strategy
        self._ready: Deque[ScheduledTask] = deque()
        self._waiting: Dict[str, ScheduledTask] = {}
        self._completed: List[str] = []
        self._step_count = 0

    def schedule(self, coro: Coroutine[Any, Any, Any], name: str, priority: int = 0) -> None:
        """Schedule a coroutine for execution.

        Args:
            coro: The coroutine to schedule
            name: Name for debugging/logging
            priority: Higher priority runs first (in some strategies)
        """
        task = ScheduledTask(coro=coro, name=name, priority=priority)
        self._ready.append(task)

    def _select_next(self) -> Optional[ScheduledTask]:
        """Select the next task to run based on strategy."""
        if not self._ready:
            return None

        if self._strategy == "round_robin":
            return self._ready.popleft()

        elif self._strategy == "random":
            idx = self._random.randint(0, len(self._ready) - 1)
            task = self._ready[idx]
            del self._ready[idx]
            return task

        elif self._strategy == "race_prone":
            # Strategy designed to maximize race condition probability:
            # - Run all coroutines up to their first yield
            # - Then run them all through their second yield
            # This creates maximum overlap in the race window
            return self._ready.popleft()

        return self._ready.popleft()

    async def step(self) -> bool:
        """Execute one step of one coroutine.

        Returns:
            True if a step was executed, False if no tasks remain
        """
        task = self._select_next()
        if task is None:
            return False

        self._step_count += 1

        try:
            # Run until next yield
            task.coro.send(None)
            # Task yielded, put back in queue
            self._ready.append(task)
        except StopIteration:
            # Task completed
            self._completed.append(task.name)

        return True

    async def run_all(self) -> List[str]:
        """Run all scheduled coroutines to completion.

        Returns:
            List of task names in completion order
        """
        while self._ready:
            await self.step()
            # Small yield to prevent blocking
            await asyncio.sleep(0)

        return self._completed

    @property
    def step_count(self) -> int:
        """Number of steps executed."""
        return self._step_count


@pytest.fixture
def deterministic_seed() -> int:
    """Fixed seed for reproducible tests."""
    return 42


@pytest.fixture
def deterministic_scheduler(deterministic_seed: int) -> DeterministicScheduler:
    """Create a deterministic scheduler for controlled testing."""
    return DeterministicScheduler(seed=deterministic_seed, interleave_strategy="race_prone")


@pytest.fixture
def seeded_random(deterministic_seed: int) -> random.Random:
    """Create a seeded random generator for reproducible tests."""
    return random.Random(deterministic_seed)
