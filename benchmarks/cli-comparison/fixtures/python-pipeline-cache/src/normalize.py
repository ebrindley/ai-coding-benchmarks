"""Category normalization pipeline.

Product records arrive with human-entered category labels that vary in casing,
whitespace, and spelling ("Home  &  Kitchen", "home and kitchen", "HOME&KITCHEN").
The rest of the system keys reports, cache tags, and roll-ups off a single
*canonical* category so that equivalent labels collapse into one bucket.

This module is the single source of truth for that canonical form. Any code that
needs to compare, group, or tag-by category MUST route the raw label through
``canonical_category`` first. Comparing raw labels directly is a bug.
"""

from __future__ import annotations

import re

# Known aliases mapped onto their canonical spelling. Applied *after* the label
# has been lowercased and had its whitespace/punctuation collapsed.
_ALIASES = {
    "home and kitchen": "home & kitchen",
    "homeandkitchen": "home & kitchen",
    "hardware and tools": "tools & hardware",
    "tools and hardware": "tools & hardware",
    "hardware": "tools & hardware",
    "electronic": "electronics",
    "electronic devices": "electronics",
}

_WHITESPACE = re.compile(r"\s+")
# Collapse runs of spaces that surround an ampersand: "home  &  kitchen" -> "home & kitchen".
_AMPERSAND = re.compile(r"\s*&\s*")


def canonical_category(label: str) -> str:
    """Return the canonical form of a raw category label.

    The canonical form is:
      1. Trimmed of leading/trailing whitespace.
      2. Lowercased.
      3. Internal whitespace collapsed to a single space.
      4. Whitespace around ``&`` normalized to " & ".
      5. Mapped through the alias table (exact match on the collapsed form).

    Args:
        label: Raw, human-entered category label.

    Returns:
        Canonical category string. Empty/whitespace-only input yields "uncategorized".
    """
    if label is None:
        return "uncategorized"

    collapsed = _WHITESPACE.sub(" ", label.strip()).lower()
    collapsed = _AMPERSAND.sub(" & ", collapsed)

    if not collapsed:
        return "uncategorized"

    return _ALIASES.get(collapsed, collapsed)


def categories_equivalent(a: str, b: str) -> bool:
    """Return True if two raw labels map to the same canonical category."""
    return canonical_category(a) == canonical_category(b)
