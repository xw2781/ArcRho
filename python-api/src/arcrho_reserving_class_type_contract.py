"""Which reserving-class paths a project's own type table can resolve.

A reserving-class path names one type per level, joined with backslashes
(``PRNJ - PA\\PA\\All States\\Direct Group\\BI Total``). The Engine builds a
class's generated datasets from source rows by resolving every level of that
path against the project's ``reserving_class_types.json``, with the levels
taken from the Reserving Class rows of ``field_mapping.json``. A path with a
level the table does not know cannot be built, so the ResQ import keeps such a
class's values from ResQ instead of handing it to the Engine.

This module owns the one name key both sides compare type names on, and the
one "does the Engine know every level of this path" rule. It uses only the
standard library so the frozen Engine, the Bridge's migration and the app
server load the same file.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

_SPACE_RE = re.compile(r"\s+")


def reserving_class_type_key(name: Any) -> str:
    """One comparison key for a type name: outer space dropped, inner runs of space collapsed, case ignored."""

    text = str(name if name is not None else "").strip()
    return _SPACE_RE.sub(" ", text).casefold()


def _table_records(payload: Any) -> Iterable[dict]:
    if not isinstance(payload, dict):
        return []
    columns = [str(column if column is not None else "").strip() for column in payload.get("columns") or []]
    return [
        dict(zip(columns, row))
        for row in payload.get("rows") or []
        if isinstance(row, list)
    ]


def reserving_class_levels(field_mapping_payload: Any) -> tuple[int, ...]:
    """The levels of the project's Reserving Class fields, in path order."""

    rows = field_mapping_payload.get("rows") if isinstance(field_mapping_payload, dict) else None
    levels = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("significance", "") or "").strip() != "Reserving Class":
            continue
        try:
            levels.append(int(str(row.get("level")).strip()))
        except (TypeError, ValueError):
            continue
    return tuple(sorted(levels))


def reserving_class_type_keys(reserving_class_types_payload: Any) -> frozenset[tuple[int, str]]:
    """Every (level, type key) the project's type table defines."""

    keys = set()
    for record in _table_records(reserving_class_types_payload):
        key = reserving_class_type_key(record.get("Name"))
        try:
            level = int(str(record.get("Level")).strip())
        except (TypeError, ValueError):
            continue
        if key:
            keys.add((level, key))
    return frozenset(keys)


def reserving_class_path_is_known(
    path: str,
    field_mapping_payload: Any,
    reserving_class_types_payload: Any,
) -> bool:
    """True when every level of *path* is a type the project's table defines.

    Levels pair with the path's parts in order, a blank part names no level,
    and a path with more named parts than the project has levels is unknown.
    """

    levels = reserving_class_levels(field_mapping_payload)
    known = reserving_class_type_keys(reserving_class_types_payload)
    parts = [part.strip() for part in str(path or "").split("\\")]
    if any(parts[len(levels):]):
        return False
    named = [(level, part) for level, part in zip(levels, parts) if part]
    return bool(named) and all(
        (level, reserving_class_type_key(part)) in known for level, part in named
    )
