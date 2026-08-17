"""Result shaping shared by the Arcode SQL consoles.

The Snowflake and SQL Server consoles render the same grid from the same JSON,
so the row ceiling and the driver-value conversion are defined once here rather
than once per engine service.
"""
from __future__ import annotations

from typing import Any


# A console grid is for inspecting a query, not for exporting it, so a result
# is capped well below what a driver would happily stream into memory.
MAX_QUERY_ROWS = 5000
DEFAULT_QUERY_ROWS = 1000


def clamp_row_limit(limit: Any) -> int:
    """Bound a caller-supplied row limit to what a console grid may fetch."""

    try:
        requested = int(limit or DEFAULT_QUERY_ROWS)
    except (TypeError, ValueError):
        requested = DEFAULT_QUERY_ROWS
    return max(1, min(MAX_QUERY_ROWS, requested))


def json_safe_cell(value: Any) -> Any:
    """Convert one driver cell into something the results grid can render."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    try:
        return value.isoformat()
    except Exception:
        return str(value)
