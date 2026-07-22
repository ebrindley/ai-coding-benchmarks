"""Tag-aware query cache with TTL and an injected clock.

The cache stores computed report values under a string key. Each entry is also
associated with a set of *tags* (here, canonical category names). When the data
behind a tag changes, callers invalidate every entry carrying that tag rather
than tracking individual keys.

The clock is injected so tests can advance time deterministically instead of
sleeping. Production code passes ``time.monotonic``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Set


@dataclass
class _Entry:
    """A single cached value with its expiry and tag membership."""

    value: Any
    expires_at: float
    tags: Set[str] = field(default_factory=set)


class QueryCache:
    """A small tag-invalidation cache used by the inventory reports.

    Invalidation is *tag-based*: entries are grouped by the tags supplied at
    ``set`` time, and ``invalidate_tag`` drops every entry that carries the tag.
    The tag namespace is the caller's responsibility -- the cache does no
    normalization of its own, so callers must agree on exactly what string a tag
    is before they store or invalidate it.
    """

    def __init__(self, ttl_seconds: float = 60.0, clock: Optional[Callable[[], float]] = None):
        """Initialize the cache.

        Args:
            ttl_seconds: Lifetime of each entry, in seconds.
            clock: Zero-arg callable returning a monotonically increasing time.
                Defaults to ``time.monotonic``.
        """
        if clock is None:
            import time

            clock = time.monotonic

        self._ttl = ttl_seconds
        self._clock = clock
        self._entries: Dict[str, _Entry] = {}
        # Reverse index: tag -> set of keys carrying that tag.
        self._tag_index: Dict[str, Set[str]] = {}
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[Any]:
        """Return the cached value for ``key`` or None if absent/expired."""
        entry = self._entries.get(key)
        if entry is None:
            self._misses += 1
            return None

        if self._clock() >= entry.expires_at:
            # Expired: evict and count as a miss.
            self._evict(key)
            self._misses += 1
            return None

        self._hits += 1
        return entry.value

    def set(self, key: str, value: Any, tags: Iterable[str]) -> None:
        """Store ``value`` under ``key``, associated with ``tags``.

        Args:
            key: Cache key.
            value: Value to cache.
            tags: Tags this entry belongs to (canonical category names).
        """
        # Drop any previous entry so its stale tag links do not linger.
        if key in self._entries:
            self._evict(key)

        tag_set = set(tags)
        self._entries[key] = _Entry(
            value=value,
            expires_at=self._clock() + self._ttl,
            tags=tag_set,
        )
        for tag in tag_set:
            self._tag_index.setdefault(tag, set()).add(key)

    def invalidate_tag(self, tag: str) -> int:
        """Evict every entry carrying ``tag``.

        Args:
            tag: The tag to invalidate.

        Returns:
            Number of entries evicted.
        """
        keys = self._tag_index.get(tag)
        if not keys:
            return 0

        # Snapshot before eviction: _evict mutates the index set we are iterating,
        # so both the loop and the count must run off the copy, not the live set.
        snapshot = list(keys)
        for key in snapshot:
            self._evict(key)
        return len(snapshot)

    def _evict(self, key: str) -> None:
        """Remove a key and detach it from every tag it belonged to."""
        entry = self._entries.pop(key, None)
        if entry is None:
            return
        for tag in entry.tags:
            keys = self._tag_index.get(tag)
            if keys is not None:
                keys.discard(key)
                if not keys:
                    del self._tag_index[tag]

    def keys_for_tag(self, tag: str) -> List[str]:
        """Return the keys currently indexed under ``tag`` (for diagnostics)."""
        return sorted(self._tag_index.get(tag, set()))

    def clear(self) -> None:
        """Drop all entries and tag links."""
        self._entries.clear()
        self._tag_index.clear()

    @property
    def hits(self) -> int:
        """Number of successful, non-expired lookups."""
        return self._hits

    @property
    def misses(self) -> int:
        """Number of lookups that returned None."""
        return self._misses

    @property
    def size(self) -> int:
        """Number of live entries."""
        return len(self._entries)
