"""Unit tests for the tag-aware QueryCache - 8 tests.

These pass on both baseline and fixed versions; the cache primitive is correct.
They document the exact tag-matching contract the service depends on: an entry
is only dropped when the *same string* it was tagged with is invalidated.
"""

from src.cache import QueryCache
from tests.conftest import FakeClock


def make_cache(ttl: float = 100.0):
    clock = FakeClock()
    return QueryCache(ttl_seconds=ttl, clock=clock), clock


class TestBasics:
    def test_set_and_get(self):
        cache, _ = make_cache()
        cache.set("k", 42, tags=["a"])
        assert cache.get("k") == 42
        assert cache.hits == 1

    def test_missing_key_returns_none(self):
        cache, _ = make_cache()
        assert cache.get("nope") is None
        assert cache.misses == 1

    def test_ttl_expiry(self):
        cache, clock = make_cache(ttl=10.0)
        cache.set("k", "v", tags=["a"])
        clock.advance(9.0)
        assert cache.get("k") == "v"
        clock.advance(2.0)
        assert cache.get("k") is None


class TestTagInvalidation:
    def test_invalidate_tag_drops_matching_entry(self):
        cache, _ = make_cache()
        cache.set("k1", 1, tags=["cat"])
        cache.set("k2", 2, tags=["cat"])
        dropped = cache.invalidate_tag("cat")
        assert dropped == 2
        assert cache.get("k1") is None
        assert cache.get("k2") is None

    def test_invalidate_tag_is_exact_match(self):
        # Invalidating a *different* string must not drop the entry. This is the
        # property the service bug hinges on: raw != canonical means no match.
        cache, _ = make_cache()
        cache.set("k", 1, tags=["home & kitchen"])
        assert cache.invalidate_tag("home and kitchen") == 0
        assert cache.get("k") == 1

    def test_invalidate_unknown_tag_is_noop(self):
        cache, _ = make_cache()
        cache.set("k", 1, tags=["a"])
        assert cache.invalidate_tag("z") == 0
        assert cache.get("k") == 1

    def test_reset_key_updates_tag_index(self):
        cache, _ = make_cache()
        cache.set("k", 1, tags=["old"])
        cache.set("k", 2, tags=["new"])
        assert cache.invalidate_tag("old") == 0
        assert cache.get("k") == 2
        assert cache.invalidate_tag("new") == 1
        assert cache.get("k") is None

    def test_size_tracks_live_entries(self):
        cache, _ = make_cache()
        cache.set("k1", 1, tags=["a"])
        cache.set("k2", 2, tags=["b"])
        assert cache.size == 2
        cache.invalidate_tag("a")
        assert cache.size == 1
