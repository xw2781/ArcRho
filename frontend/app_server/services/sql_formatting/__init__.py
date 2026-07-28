"""Parser-backed SQL formatting domain for Arcode."""

from typing import Any


__all__ = ["SqlFormatter", "formatter_engine_info"]


def __getattr__(name: str) -> Any:
    if name == "SqlFormatter":
        from .engine import SqlFormatter

        return SqlFormatter
    if name == "formatter_engine_info":
        from .engine import formatter_engine_info

        return formatter_engine_info
    raise AttributeError(name)
