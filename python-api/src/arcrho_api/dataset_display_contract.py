"""Canonical persisted display settings shared by every dataset sidecar producer."""
from __future__ import annotations

from typing import Any


DEFAULT_SHOW_SUBTOTAL = True


def normalize_show_subtotal(value: Any) -> bool:
    """Return the canonical subtotal visibility, defaulting missing legacy values on."""

    return value if isinstance(value, bool) else DEFAULT_SHOW_SUBTOTAL


__all__ = ["DEFAULT_SHOW_SUBTOTAL", "normalize_show_subtotal"]
