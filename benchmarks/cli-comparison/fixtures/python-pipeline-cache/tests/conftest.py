"""Shared fixtures for deterministic pipeline-cache testing.

Time is fully injected via ``FakeClock`` so TTL behaviour is deterministic and
no test sleeps. Unless a test explicitly advances the clock, entries never
expire -- which means any staleness a test observes is caused by the
invalidation bug, not by TTL expiry.
"""

from __future__ import annotations

import pytest

from src.cache import QueryCache
from src.service import InventoryService
from src.store import ProductStore


class FakeClock:
    """A manually advanced monotonic clock."""

    def __init__(self, start: float = 1000.0):
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        """Move the clock forward by ``seconds``."""
        self._now += seconds


@pytest.fixture
def clock() -> FakeClock:
    """A deterministic clock starting at t=1000.0."""
    return FakeClock()


@pytest.fixture
def service(clock: FakeClock) -> InventoryService:
    """An InventoryService wired to a long-TTL cache on the fake clock.

    The TTL (3600s) is far larger than anything a test advances, so cache
    entries stay live and invalidation is the only thing that can refresh them.
    """
    cache = QueryCache(ttl_seconds=3600.0, clock=clock)
    return InventoryService(store=ProductStore(), cache=cache, low_stock_threshold=5)


@pytest.fixture
def seeded_service(service: InventoryService) -> InventoryService:
    """A service pre-loaded with products across a few categories.

    Note the raw labels are intentionally *non-canonical* for the home category
    ("home and kitchen" vs canonical "home & kitchen") to exercise the gap
    between the store's verbatim labels and the cache's canonical tags.
    """
    service.add_product("SKU-1", "Blender", "home and kitchen", quantity=12, price=40.0)
    service.add_product("SKU-2", "Kettle", "Home & Kitchen", quantity=3, price=25.0)
    service.add_product("SKU-3", "USB Cable", "Electronics", quantity=50, price=8.0)
    service.add_product("SKU-4", "Hammer", "Tools and Hardware", quantity=2, price=15.0)
    return service
