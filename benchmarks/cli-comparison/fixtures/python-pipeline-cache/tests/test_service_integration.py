"""End-to-end tests for InventoryService cache coherence - 12 tests.

Two groups:

* ``TestReadCorrectness`` exercises cold-cache reads and canonical aggregation.
  These pass on both the buggy baseline and the fixed version.

* ``TestFreshAfterMutation`` warms the cache, mutates, then reads again and
  expects the result to reflect the mutation. On the buggy baseline the flush
  invalidates by the store's *raw* label while the cache entry is tagged by the
  *canonical* category, so the stale value survives -- these FAIL before the fix
  and PASS after it.

The cache TTL (3600s, see conftest) far exceeds anything these tests advance, so
expiry cannot mask or explain the staleness: only correct invalidation refreshes
the value.
"""

from src.service import InventoryService


class TestReadCorrectness:
    """Cold-cache computation and canonical grouping (pass on baseline too)."""

    def test_summary_aggregates_equivalent_labels(self, seeded_service: InventoryService):
        # SKU-1 ("home and kitchen") + SKU-2 ("Home & Kitchen") share a canonical
        # category and must aggregate into one bucket.
        summary = seeded_service.category_summary("home & kitchen")
        assert summary["product_count"] == 2.0
        assert summary["total_quantity"] == 15.0  # 12 + 3
        assert summary["total_value"] == 555.0  # 12*40 + 3*25

    def test_summary_lookup_is_label_insensitive(self, seeded_service: InventoryService):
        # Any equivalent label resolves to the same summary.
        a = seeded_service.category_summary("Home and Kitchen")
        b = seeded_service.category_summary("HOME & KITCHEN")
        assert a == b

    def test_low_stock_report_cold(self, seeded_service: InventoryService):
        # threshold=5: SKU-2 (qty 3) and SKU-4 (qty 2) are low.
        assert seeded_service.low_stock_report("home & kitchen") == ["SKU-2"]
        assert seeded_service.low_stock_report("tools & hardware") == ["SKU-4"]

    def test_second_read_is_cache_hit(self, seeded_service: InventoryService):
        seeded_service.cache.clear()
        seeded_service.category_summary("electronics")
        hits_before = seeded_service.cache.hits
        seeded_service.category_summary("electronics")
        assert seeded_service.cache.hits == hits_before + 1


class TestFreshAfterMutation:
    """Cache must reflect mutations (FAIL before fix, PASS after)."""

    def test_summary_fresh_after_sell(self, seeded_service: InventoryService):
        # Warm the cache.
        assert seeded_service.category_summary("home & kitchen")["total_quantity"] == 15.0
        # Sell 2 kettles (SKU-2, raw label "Home & Kitchen").
        seeded_service.sell("SKU-2", 2)
        # Expect the cached summary to reflect the sale.
        assert seeded_service.category_summary("home & kitchen")["total_quantity"] == 13.0

    def test_summary_fresh_after_restock(self, seeded_service: InventoryService):
        seeded_service.category_summary("electronics")
        seeded_service.restock("SKU-3", 10)  # raw label "Electronics"
        assert seeded_service.category_summary("electronics")["total_quantity"] == 60.0

    def test_low_stock_fresh_after_restock(self, seeded_service: InventoryService):
        # SKU-2 (qty 3) is low initially.
        assert seeded_service.low_stock_report("home & kitchen") == ["SKU-2"]
        # Restock it above the threshold.
        seeded_service.restock("SKU-2", 10)  # qty -> 13
        assert seeded_service.low_stock_report("home & kitchen") == []

    def test_low_stock_fresh_after_sell(self, seeded_service: InventoryService):
        # SKU-1 (qty 12) is NOT low initially.
        assert seeded_service.low_stock_report("home & kitchen") == ["SKU-2"]
        # Sell it down to the threshold.
        seeded_service.sell("SKU-1", 8)  # qty -> 4, now low
        assert seeded_service.low_stock_report("home & kitchen") == ["SKU-1", "SKU-2"]

    def test_summary_fresh_after_add_via_alias_label(self, seeded_service: InventoryService):
        seeded_service.category_summary("home & kitchen")
        # Add a product using the alias spelling; it belongs to the same bucket.
        seeded_service.add_product(
            "SKU-5", "Toaster", "Home and Kitchen", quantity=7, price=30.0
        )
        summary = seeded_service.category_summary("home & kitchen")
        assert summary["product_count"] == 3.0
        assert summary["total_quantity"] == 22.0  # 15 + 7

    def test_summary_fresh_after_remove(self, seeded_service: InventoryService):
        seeded_service.category_summary("electronics")
        seeded_service.remove_product("SKU-3")
        summary = seeded_service.category_summary("electronics")
        assert summary["product_count"] == 0.0
        assert summary["total_quantity"] == 0.0

    def test_repeated_mutations_stay_fresh(self, seeded_service: InventoryService):
        # A sequence of read/mutate cycles must never serve a stale value.
        for expected_after in (11, 7, 8):
            seeded_service.category_summary("electronics")
            current = int(seeded_service.store.get("SKU-3").quantity)
            delta = expected_after - current
            if delta >= 0:
                seeded_service.restock("SKU-3", delta)
            else:
                seeded_service.sell("SKU-3", -delta)
            fresh = seeded_service.category_summary("electronics")
            assert fresh["total_quantity"] == float(expected_after)

    def test_mutation_only_invalidates_touched_category(
        self, seeded_service: InventoryService
    ):
        # The fix must invalidate by the *canonical category* touched, not clear
        # the whole cache. Warm two unrelated categories, mutate only one, and
        # confirm the untouched category's entry survives as a cache hit while the
        # mutated category is refreshed. A blunt cache.clear() in _flush() would
        # evict the untouched entry too and fail this test.
        seeded_service.category_summary("home & kitchen")
        seeded_service.category_summary("electronics")

        hits_before = seeded_service.cache.hits
        # Mutate only the home & kitchen category (SKU-2, raw label "Home & Kitchen").
        seeded_service.sell("SKU-2", 1)

        # The untouched electronics summary must still be a warm cache hit.
        seeded_service.category_summary("electronics")
        assert seeded_service.cache.hits == hits_before + 1, (
            "unrelated category was evicted -- _flush must invalidate only the "
            "touched category's tag, not clear the whole cache"
        )

        # The mutated category must be refreshed (not stale).
        assert (
            seeded_service.category_summary("home & kitchen")["total_quantity"] == 14.0
        )
