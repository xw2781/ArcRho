"""The datasets and methods a reserving class's last ResQ transfer covered.

The Import and Export macros both open the same review table and both let a
person tick the rows the run should cover.  What they ticked is remembered
here, beside the synchronization baseline on the ArcRho server, so the next
run in that direction opens with the same rows already ticked -- for whoever
opens it next, not only for the person who saved it.

One document holds both directions.  They are kept apart because they cannot
hold the same answer: an item ResQ has and ArcRho does not can be imported and
can never be exported, so a single shared list would keep offering each
direction rows the other one chose.

The document is a default, never a decision.  Nothing is written from it
without the review table being accepted, so an unreadable or foreign document
falls back to "everything ticked" rather than stopping the run.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from arcrho_api.io import persisted_json_text

from .sync import (  # noqa: F401 -- the direction vocabulary is re-exported for callers
    DIRECTION_EXPORT,
    DIRECTION_IMPORT,
    TRANSFER_DIRECTIONS,
    clean_name,
    logical_key,
    sync_state_path,
    transfer_direction,
)


TRANSFER_SELECTION_VERSION = 1


def selection_path(
    server_root: str | os.PathLike[str],
    project_name: Any,
    rc_path: Any,
    connection_name: Any,
) -> Path:
    """The project-owned selection document for one reserving class and ResQ connection.

    It sits beside the synchronization baseline and is scoped by the same
    digest, so both documents describe exactly the same pairing of project,
    reserving class, and connection.
    """

    baseline = sync_state_path(server_root, project_name, rc_path, connection_name)
    return baseline.with_name(f"{baseline.stem}.selection.json")


def empty_selection(project_name: Any, rc_path: Any, connection_name: Any) -> dict[str, Any]:
    return {
        "version": TRANSFER_SELECTION_VERSION,
        "project_name": clean_name(project_name),
        "reserving_class": clean_name(rc_path),
        "connection_name": clean_name(connection_name),
        "updated_at": "",
        "selections": {direction: _empty_direction() for direction in TRANSFER_DIRECTIONS},
    }


def _empty_direction() -> dict[str, Any]:
    return {"updated_at": "", "updated_by": "", "names": []}


def read_selection(
    path: str | os.PathLike[str],
    project_name: Any,
    rc_path: Any,
    connection_name: Any,
) -> dict[str, Any]:
    """Read the saved selections, or return empty ones when there is nothing usable.

    A missing, unreadable, or foreign document means only that no default has
    been saved yet, which the review table shows as every row ticked.
    """

    expected = empty_selection(project_name, rc_path, connection_name)
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return expected
    if (
        not isinstance(payload, Mapping)
        or payload.get("version") != TRANSFER_SELECTION_VERSION
        or clean_name(payload.get("project_name")) != expected["project_name"]
        or clean_name(payload.get("reserving_class")) != expected["reserving_class"]
        or clean_name(payload.get("connection_name")) != expected["connection_name"]
        or not isinstance(payload.get("selections"), Mapping)
    ):
        return expected
    document = dict(expected)
    document["updated_at"] = str(payload.get("updated_at") or "")
    selections = {}
    for direction in TRANSFER_DIRECTIONS:
        entry = payload["selections"].get(direction)
        entry = entry if isinstance(entry, Mapping) else {}
        selections[direction] = {
            "updated_at": str(entry.get("updated_at") or ""),
            "updated_by": str(entry.get("updated_by") or ""),
            "names": _clean_names(entry.get("names")),
        }
    document["selections"] = selections
    return document


def _clean_names(value: Any) -> list[str]:
    """The saved names, de-duplicated by logical identity and display-ordered."""

    if not isinstance(value, list):
        return []
    names: dict[str, str] = {}
    for raw in value:
        name = clean_name(raw)
        key = logical_key(name)
        if key and key not in names:
            names[key] = name
    return [names[key] for key in sorted(names)]


def selected_names(document: Mapping[str, Any], direction: Any) -> list[str]:
    """The names saved for one direction, empty when none were ever saved."""

    entry = _direction_entry(document, transfer_direction(direction))
    return list(entry.get("names") or [])


def selection_keys(names: Iterable[Any]) -> set[str]:
    """The logical identities of a saved name list, for ticking review rows."""

    return {key for key in (logical_key(name) for name in names or ()) if key}


def _direction_entry(document: Mapping[str, Any], direction: str) -> Mapping[str, Any]:
    selections = document.get("selections") if isinstance(document, Mapping) else None
    entry = selections.get(direction) if isinstance(selections, Mapping) else None
    return entry if isinstance(entry, Mapping) else _empty_direction()


def record_selection(
    document: Mapping[str, Any],
    direction: Any,
    names: Iterable[Any],
    *,
    updated_by: Any = "",
    updated_at: str | None = None,
) -> dict[str, Any]:
    """Return the document with one direction's saved names replaced."""

    normalized = transfer_direction(direction)
    timestamp = str(updated_at or datetime.now(timezone.utc).isoformat()).strip()
    updated = dict(document)
    selections = dict(document.get("selections") or {})
    selections[normalized] = {
        "updated_at": timestamp,
        "updated_by": clean_name(updated_by),
        "names": _clean_names(list(names or ())),
    }
    for other in TRANSFER_DIRECTIONS:
        if not isinstance(selections.get(other), Mapping):
            selections[other] = _empty_direction()
    updated["selections"] = selections
    updated["updated_at"] = timestamp
    return updated


def write_selection(path: str | os.PathLike[str], document: Mapping[str, Any]) -> Path:
    """Atomically persist the selection document."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(persisted_json_text(dict(document)), encoding="utf-8", newline="\n")
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return target


def save_selection(
    server_root: str | os.PathLike[str],
    project_name: Any,
    rc_path: Any,
    connection_name: Any,
    direction: Any,
    names: Iterable[Any],
    *,
    updated_by: Any = "",
) -> Path:
    """Read, update, and write one direction's selection in one call."""

    path = selection_path(server_root, project_name, rc_path, connection_name)
    document = read_selection(path, project_name, rc_path, connection_name)
    return write_selection(
        path,
        record_selection(document, direction, names, updated_by=updated_by),
    )
