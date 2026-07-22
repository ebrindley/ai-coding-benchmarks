"""Unit tests for the category normalizer - 8 tests.

These pass on both the buggy baseline and the fixed version: the normalizer
itself is correct. They pin the canonical contract the rest of the system
relies on.
"""

from src.normalize import canonical_category, categories_equivalent


class TestCanonicalCategory:
    """Canonicalization rules."""

    def test_lowercases_and_trims(self):
        assert canonical_category("  Electronics  ") == "electronics"

    def test_collapses_internal_whitespace(self):
        assert canonical_category("Home    &   Kitchen") == "home & kitchen"

    def test_normalizes_ampersand_spacing(self):
        assert canonical_category("home&kitchen") == "home & kitchen"

    def test_applies_alias_table(self):
        assert canonical_category("Home and Kitchen") == "home & kitchen"

    def test_hardware_aliases_collapse(self):
        assert canonical_category("Tools and Hardware") == "tools & hardware"
        assert canonical_category("hardware") == "tools & hardware"

    def test_empty_becomes_uncategorized(self):
        assert canonical_category("   ") == "uncategorized"
        assert canonical_category("") == "uncategorized"

    def test_none_becomes_uncategorized(self):
        assert canonical_category(None) == "uncategorized"


class TestCategoriesEquivalent:
    """Equivalence helper."""

    def test_equivalent_labels(self):
        assert categories_equivalent("Home and Kitchen", "home & kitchen") is True
        assert categories_equivalent("ELECTRONICS", "  electronics ") is True
        assert categories_equivalent("Books", "Electronics") is False
