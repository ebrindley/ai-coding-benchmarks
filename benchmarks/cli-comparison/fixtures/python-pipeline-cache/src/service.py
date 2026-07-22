"""Inventory service that coordinates the store, cache, and normalizer.

This is the layer clients talk to. It exposes mutation methods (restock, sell,
add/remove products) and cached read methods (category summaries, low-stock
reports). Reports are expensive to compute, so results are cached and tagged by
the *canonical* category they cover. After every batch of mutations the service
flushes: it asks the store which categories are dirty and invalidates the
matching cache tags so the next read recomputes.

BUG LOCATION: InventoryService._flush() -- the dirty labels drained from the
store are raw/verbatim, but cache tags were written using the *canonical*
category. Invalidating by the raw label misses the canonical tag whenever the
two differ, leaving stale report values in the cache.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional

from .cache import QueryCache
from .normalize import canonical_category
from .store import Product, ProductStore

# Cache key prefixes for the two report families.
_SUMMARY_PREFIX = "summary::"
_LOW_STOCK_PREFIX = "low_stock::"


class InventoryService:
    """Coordinates persistence, normalization, and cached reads."""

    def __init__(
        self,
        store: Optional[ProductStore] = None,
        cache: Optional[QueryCache] = None,
        low_stock_threshold: int = 5,
    ):
        """Initialize the service.

        Args:
            store: Backing product store (created if omitted).
            cache: Query cache for report results (created if omitted).
            low_stock_threshold: Quantity at or below which a product is "low".
        """
        self._store = store if store is not None else ProductStore()
        self._cache = cache if cache is not None else QueryCache()
        self._low_stock_threshold = low_stock_threshold

    # -------------------------------------------------------------------------
    # MUTATIONS
    # -------------------------------------------------------------------------

    def add_product(
        self, sku: str, name: str, category: str, quantity: int, price: float
    ) -> Product:
        """Add or replace a product, then flush stale cache entries."""
        product = Product(
            sku=sku, name=name, category=category, quantity=quantity, price=price
        )
        self._store.upsert(product)
        self._flush()
        return product

    def restock(self, sku: str, amount: int) -> Product:
        """Increase a product's quantity, then flush stale cache entries."""
        product = self._store.adjust_quantity(sku, amount)
        self._flush()
        return product

    def sell(self, sku: str, amount: int) -> Product:
        """Decrease a product's quantity, then flush stale cache entries."""
        product = self._store.adjust_quantity(sku, -amount)
        self._flush()
        return product

    def remove_product(self, sku: str) -> Optional[Product]:
        """Remove a product, then flush stale cache entries."""
        product = self._store.remove(sku)
        self._flush()
        return product

    # -------------------------------------------------------------------------
    # CACHED READS
    # -------------------------------------------------------------------------

    def category_summary(self, category: str) -> Dict[str, float]:
        """Return aggregate stats for a category, using the cache when warm.

        The result covers *all* products whose canonical category matches
        ``category`` (so "Home & Kitchen" and "home and kitchen" aggregate
        together). The cache entry is tagged with the canonical category.

        Args:
            category: Any raw label naming the category of interest.

        Returns:
            Dict with ``total_quantity``, ``total_value``, and ``product_count``.
        """
        canonical = canonical_category(category)
        key = _SUMMARY_PREFIX + canonical

        cached = self._cache.get(key)
        if cached is not None:
            return cached

        summary = self._compute_summary(canonical)
        # Tag the entry by the canonical category so a change to any product in
        # that category can invalidate it.
        self._cache.set(key, summary, tags=[canonical])
        return summary

    def low_stock_report(self, category: str) -> List[str]:
        """Return SKUs at or below the low-stock threshold for a category.

        Cached and tagged by the canonical category, like ``category_summary``.

        Args:
            category: Any raw label naming the category of interest.

        Returns:
            Sorted list of low-stock SKUs in the canonical category.
        """
        canonical = canonical_category(category)
        key = _LOW_STOCK_PREFIX + canonical

        cached = self._cache.get(key)
        if cached is not None:
            return cached

        skus = self._compute_low_stock(canonical)
        self._cache.set(key, skus, tags=[canonical])
        return skus

    # -------------------------------------------------------------------------
    # INTERNALS
    # -------------------------------------------------------------------------

    def _compute_summary(self, canonical: str) -> Dict[str, float]:
        """Aggregate quantity/value/count over a canonical category."""
        total_quantity = 0
        total_value = 0.0
        product_count = 0
        for product in self._store.all_products():
            if canonical_category(product.category) == canonical:
                total_quantity += product.quantity
                total_value += product.quantity * product.price
                product_count += 1
        return {
            "total_quantity": float(total_quantity),
            "total_value": round(total_value, 2),
            "product_count": float(product_count),
        }

    def _compute_low_stock(self, canonical: str) -> List[str]:
        """Collect SKUs at or below threshold within a canonical category."""
        skus = []
        for product in self._store.all_products():
            if canonical_category(product.category) == canonical:
                if product.quantity <= self._low_stock_threshold:
                    skus.append(product.sku)
        return sorted(skus)

    def _flush(self) -> None:
        """Invalidate cache entries for every category touched since last flush.

        BUG: ``drain_dirty_categories`` returns the store's *raw* labels, but the
        report caches were tagged with the *canonical* category. Passing the raw
        label straight to ``invalidate_tag`` misses the canonical tag whenever
        the raw and canonical forms differ, so stale summaries survive the flush.
        """
        for raw_label in self._store.drain_dirty_categories():
            # BUG: should invalidate by canonical_category(raw_label), not the
            # raw label. When they differ, the matching tag is never found.
            self._cache.invalidate_tag(raw_label)

    @property
    def cache(self) -> QueryCache:
        """Expose the cache for diagnostics/tests."""
        return self._cache

    @property
    def store(self) -> ProductStore:
        """Expose the store for diagnostics/tests."""
        return self._store

    def set_clock(self, clock: Callable[[], float]) -> None:
        """Replace the cache clock (test helper). No-op if cache lacks one."""
        self._cache._clock = clock  # noqa: SLF001 - deliberate test seam
