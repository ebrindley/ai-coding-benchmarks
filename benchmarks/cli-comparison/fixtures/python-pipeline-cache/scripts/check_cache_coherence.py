#!/usr/bin/env python3
"""Check that cached reports stay coherent with the store after a mutation.

This is a *behavioural* check: it drives the real InventoryService the way a
client would, so it passes for any correct fix regardless of which module the
fix lives in (service, store, cache, or normalizer). It deliberately uses a raw
category label whose canonical form differs from the label ("home and kitchen"
vs canonical "home & kitchen") so the raw-vs-canonical invalidation gap is
exercised.

The cache TTL is set far larger than the (fake) clock ever advances, so the only
mechanism that can refresh a warm entry is correct invalidation.

Exit codes:
    0: PASS - Cached reports reflect mutations
    90: FAIL_STALE_SUMMARY - Summary served a stale value after a mutation
    91: FAIL_STALE_LOW_STOCK - Low-stock report served a stale value
    92: FAIL_IMPORT_ERROR - Could not import the service package

Error IDs (grep-able):
    PASS_CACHE_COHERENT
    FAIL_STALE_SUMMARY
    FAIL_STALE_LOW_STOCK
    FAIL_IMPORT_ERROR

Output: JSON on stdout with machine-readable results + human message.
"""

import json
import sys
from pathlib import Path

# Make the fixture root importable so `src` resolves regardless of CWD.
FIXTURE_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(FIXTURE_ROOT))


def run_probe() -> dict:
    """Drive the service and report any observed staleness."""
    try:
        from src.cache import QueryCache
        from src.service import InventoryService
        from src.store import ProductStore
    except Exception as exc:  # pragma: no cover - import guard
        return {"error_id": "FAIL_IMPORT_ERROR", "exit_code": 92, "detail": str(exc)}

    class FakeClock:
        def __init__(self) -> None:
            self._now = 1000.0

        def __call__(self) -> float:
            return self._now

    clock = FakeClock()
    cache = QueryCache(ttl_seconds=3600.0, clock=clock)
    service = InventoryService(store=ProductStore(), cache=cache, low_stock_threshold=5)

    # Seed products across categories, using non-canonical raw labels on purpose.
    # SKU-2 starts *above* the low-stock threshold so the low-stock report is
    # discriminating: the sale below drives it across the threshold, so a stale
    # low-stock cache returns the wrong (empty) value.
    service.add_product("SKU-1", "Blender", "home and kitchen", quantity=12, price=40.0)
    service.add_product("SKU-2", "Kettle", "Home & Kitchen", quantity=8, price=25.0)

    # Warm both report caches on the canonical category.
    warm_summary = service.category_summary("home & kitchen")
    warm_low = service.low_stock_report("home & kitchen")

    if warm_summary["total_quantity"] != 20.0:
        return {
            "error_id": "FAIL_STALE_SUMMARY",
            "exit_code": 90,
            "detail": f"unexpected warm summary: {warm_summary}",
        }

    # Precondition: neither product is low stock yet (SKU-1 at 12, SKU-2 at 8).
    if warm_low != []:
        return {
            "error_id": "FAIL_STALE_LOW_STOCK",
            "exit_code": 91,
            "detail": f"expected no low stock before sale, got {warm_low}",
        }

    # Mutate via SKU-2 (raw label "Home & Kitchen") then re-read.
    service.sell("SKU-2", 5)  # quantity 8 -> 3, crossing the threshold of 5
    after_summary = service.category_summary("home & kitchen")
    if after_summary["total_quantity"] != 15.0:
        return {
            "error_id": "FAIL_STALE_SUMMARY",
            "exit_code": 90,
            "detail": (
                f"expected total_quantity 15.0 after sale, got "
                f"{after_summary['total_quantity']} (stale cache not invalidated)"
            ),
        }

    # SKU-2 crossed from 8 -> 3, now below threshold; low-stock report must
    # include it. A stale low-stock cache still returns the pre-sale [] value.
    after_low = service.low_stock_report("home & kitchen")
    if after_low != ["SKU-2"]:
        return {
            "error_id": "FAIL_STALE_LOW_STOCK",
            "exit_code": 91,
            "detail": f"expected ['SKU-2'] low stock, got {after_low}",
        }

    return {"error_id": "PASS_CACHE_COHERENT", "exit_code": 0, "detail": "reports fresh"}


def main() -> int:
    """Main check logic."""
    probe = run_probe()
    error_id = probe["error_id"]
    exit_code = probe["exit_code"]

    messages = {
        "PASS_CACHE_COHERENT": "✓ Cached reports reflect mutations across modules",
        "FAIL_STALE_SUMMARY": "✗ category_summary served a stale value after a mutation",
        "FAIL_STALE_LOW_STOCK": "✗ low_stock_report served a stale value after a mutation",
        "FAIL_IMPORT_ERROR": "✗ Could not import the inventory service package",
    }
    message = messages.get(error_id, "check failed") + f" ({probe.get('detail', '')})"

    result = {
        "check": "cache_coherence",
        "error_id": error_id,
        "exit_code": exit_code,
        "passed": exit_code == 0,
        "message": message,
    }

    print(json.dumps(result, indent=2))
    print(f"[{error_id}] {message}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
