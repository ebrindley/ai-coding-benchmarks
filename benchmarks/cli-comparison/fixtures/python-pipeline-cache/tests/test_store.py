"""Unit tests for ProductStore - 6 tests.

These pass on both baseline and fixed versions. They confirm the store keeps
category labels verbatim and reports raw dirty labels, which is the intended
(non-buggy) behaviour of the persistence layer.
"""

from src.store import Product, ProductStore


def make_store():
    store = ProductStore()
    store.upsert(Product("A", "Alpha", "Home and Kitchen", quantity=10, price=5.0))
    store.upsert(Product("B", "Beta", "Electronics", quantity=2, price=9.0))
    return store


class TestStore:
    def test_upsert_and_get(self):
        store = make_store()
        assert store.get("A").name == "Alpha"
        assert store.get("B").quantity == 2

    def test_category_preserved_verbatim(self):
        # The store must NOT normalize; the raw label round-trips exactly.
        store = make_store()
        assert store.get("A").category == "Home and Kitchen"

    def test_adjust_quantity(self):
        store = make_store()
        store.adjust_quantity("B", 5)
        assert store.get("B").quantity == 7

    def test_remove(self):
        store = make_store()
        removed = store.remove("A")
        assert removed.sku == "A"
        assert store.get("A") is None

    def test_drain_returns_raw_labels(self):
        store = make_store()
        store.drain_dirty_categories()  # clear seed churn
        store.adjust_quantity("A", -1)
        dirty = store.drain_dirty_categories()
        assert dirty == ["Home and Kitchen"]
        # Draining clears the log.
        assert store.drain_dirty_categories() == []

    def test_upsert_change_category_marks_both(self):
        store = make_store()
        store.drain_dirty_categories()
        store.upsert(Product("A", "Alpha", "Electronics", quantity=1, price=5.0))
        dirty = store.drain_dirty_categories()
        assert dirty == ["Electronics", "Home and Kitchen"]
