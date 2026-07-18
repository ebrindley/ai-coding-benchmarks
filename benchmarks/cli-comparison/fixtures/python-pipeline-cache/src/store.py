"""In-memory product store.

The store is intentionally a "dumb" persistence layer: it holds products keyed
by SKU and preserves each product's category label *exactly as supplied* so the
original text is available for display and audit. It does no normalization.

To let higher layers keep derived data (reports, caches) fresh, the store keeps
a *dirty log* of the category labels touched by mutations since the last drain.
Because the store preserves labels verbatim, the dirty log naturally contains
the raw, un-normalized labels. Consumers that group by canonical category are
responsible for reconciling those raw labels with their own key space.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Set


@dataclass
class Product:
    """A product record.

    ``category`` holds the original, human-entered label verbatim -- it is never
    rewritten by the store, so downstream code can display exactly what was
    entered.
    """

    sku: str
    name: str
    category: str
    quantity: int
    price: float


class ProductStore:
    """Holds products and tracks which category labels changed."""

    def __init__(self) -> None:
        self._products: Dict[str, Product] = {}
        # Raw category labels touched since the last drain_dirty_categories().
        self._dirty_categories: Set[str] = set()

    def upsert(self, product: Product) -> None:
        """Insert or replace a product, marking affected categories dirty.

        If the product already existed under a different category label, both the
        old and new labels are marked dirty so consumers can refresh both.
        """
        existing = self._products.get(product.sku)
        if existing is not None:
            self._dirty_categories.add(existing.category)
        self._dirty_categories.add(product.category)
        self._products[product.sku] = product

    def adjust_quantity(self, sku: str, delta: int) -> Product:
        """Change a product's quantity by ``delta`` and mark its category dirty.

        Args:
            sku: Product SKU.
            delta: Signed change to apply to quantity.

        Returns:
            The updated product.

        Raises:
            KeyError: If the SKU is unknown.
        """
        product = self._products[sku]
        product.quantity += delta
        self._dirty_categories.add(product.category)
        return product

    def remove(self, sku: str) -> Optional[Product]:
        """Remove a product by SKU, marking its category dirty."""
        product = self._products.pop(sku, None)
        if product is not None:
            self._dirty_categories.add(product.category)
        return product

    def get(self, sku: str) -> Optional[Product]:
        """Return a product by SKU, or None if absent."""
        return self._products.get(sku)

    def all_products(self) -> List[Product]:
        """Return all products in insertion order."""
        return list(self._products.values())

    def drain_dirty_categories(self) -> List[str]:
        """Return and clear the set of raw category labels touched since last call.

        Returns:
            The raw (verbatim) labels of categories whose products changed.
        """
        dirty = sorted(self._dirty_categories)
        self._dirty_categories.clear()
        return dirty

    @property
    def dirty_count(self) -> int:
        """Number of raw category labels currently pending drain."""
        return len(self._dirty_categories)
