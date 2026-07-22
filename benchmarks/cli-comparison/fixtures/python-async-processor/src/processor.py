"""Async task processor."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class TaskStatus(Enum):
    """Status of a task in the queue."""

    PENDING = "pending"
    CLAIMED = "claimed"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Task:
    """Represents a task to be processed."""

    id: str
    payload: Any
    status: TaskStatus = TaskStatus.PENDING
    claimed_by: Optional[str] = None
    result: Optional[Any] = None
    created_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None


class TaskProcessor:
    """Async task processor with multiple workers."""

    def __init__(self, num_workers: int = 4):
        """Initialize the processor.

        Args:
            num_workers: Number of concurrent workers to spawn
        """
        self._num_workers = num_workers
        self._tasks: Dict[str, Task] = {}
        self._pending_queue: List[str] = []
        self._results: Dict[str, Any] = {}
        self._processed_count = 0
        self._duplicate_count = 0

    def add_task(self, task_id: str, payload: Any) -> Task:
        """Add a task to the queue.

        Args:
            task_id: Unique identifier for the task
            payload: Data to be processed

        Returns:
            The created Task object
        """
        task = Task(id=task_id, payload=payload)
        self._tasks[task_id] = task
        self._pending_queue.append(task_id)
        return task

    async def claim_task(self, worker_id: str) -> Optional[Task]:
        """Claim the next available task for processing.

        Args:
            worker_id: Identifier of the worker claiming the task

        Returns:
            The claimed Task, or None if no tasks available
        """
        if not self._pending_queue:
            return None

        # Get next task ID from queue
        task_id = self._pending_queue[0]
        task = self._tasks.get(task_id)

        if task is None:
            self._pending_queue.pop(0)
            return None

        if task.status != TaskStatus.PENDING:
            # Task was already claimed by another worker
            return None

        # Simulate a small delay; in real code this might be a database
        # check or network call.
        await asyncio.sleep(0)

        # Update task status
        task.status = TaskStatus.CLAIMED
        task.claimed_by = worker_id

        # Remove from pending queue
        if task_id in self._pending_queue:
            self._pending_queue.remove(task_id)

        return task

    async def process_task(self, task: Task, handler: Callable[[Any], Any], worker_id: str) -> Any:
        """Process a claimed task.

        Args:
            task: The task to process
            handler: Function to call with task payload
            worker_id: Identifier of the worker processing the task

        Returns:
            Result from the handler function
        """
        task.status = TaskStatus.PROCESSING

        try:
            # Check for duplicate processing
            if task.id in self._results:
                self._duplicate_count += 1

            if asyncio.iscoroutinefunction(handler):
                result = await handler(task.payload)
            else:
                result = handler(task.payload)

            task.result = result
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()

            self._results[task.id] = result
            self._processed_count += 1

            return result

        except Exception as e:
            task.status = TaskStatus.FAILED
            task.result = str(e)
            raise

    async def _worker(self, worker_id: str, handler: Callable[[Any], Any]) -> List[str]:
        """Worker coroutine that claims and processes tasks.

        Args:
            worker_id: Unique identifier for this worker
            handler: Function to process task payloads

        Returns:
            List of task IDs processed by this worker
        """
        processed_ids = []

        while True:
            task = await self.claim_task(worker_id)

            if task is None:
                # No more tasks available
                break

            await self.process_task(task, handler, worker_id)
            processed_ids.append(task.id)

        return processed_ids

    async def run(self, handler: Callable[[Any], Any]) -> Dict[str, Any]:
        """Run all workers to process pending tasks.

        Args:
            handler: Function to process each task's payload

        Returns:
            Dictionary with processing results and statistics
        """
        # Reset counters
        self._processed_count = 0
        self._duplicate_count = 0

        # Spawn workers
        workers = [self._worker(f"worker-{i}", handler) for i in range(self._num_workers)]

        # Run all workers concurrently
        worker_results = await asyncio.gather(*workers)

        return {
            "results": dict(self._results),
            "processed_count": self._processed_count,
            "duplicate_count": self._duplicate_count,
            "worker_stats": {
                f"worker-{i}": {"processed": result} for i, result in enumerate(worker_results)
            },
        }

    @property
    def processed_count(self) -> int:
        """Number of tasks processed."""
        return self._processed_count

    @property
    def duplicate_count(self) -> int:
        """Number of duplicate processings detected."""
        return self._duplicate_count

    @property
    def pending_count(self) -> int:
        """Number of tasks still pending."""
        return len(self._pending_queue)

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get a task by ID."""
        return self._tasks.get(task_id)
