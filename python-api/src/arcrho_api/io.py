"""JSON IO helpers with explicit errors and atomic writes."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .exceptions import ArcRhoApiError, InvalidDfmJsonError, ReadOnlyError


def read_json(path: Path, *, required_object: bool = True) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as err:
        raise InvalidDfmJsonError(f"Invalid JSON in {path}: {err}") from err
    except OSError as err:
        raise ArcRhoApiError(f"Failed to read JSON file {path}: {err}") from err
    if required_object and not isinstance(data, dict):
        raise InvalidDfmJsonError(f"JSON file must contain an object: {path}")
    return data


def _is_row_array(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(row, list) for row in value)


def _format_row_array_lines(rows: list[list[Any]], indent: str) -> str:
    return ",\n".join(
        f"{indent}[{', '.join(json.dumps(value, ensure_ascii=False) for value in row)}]"
        for row in rows
    )


def format_json_for_save(data: Any, indent: str = "") -> str:
    """Canonical on-disk text for persisted ArcRho JSON.

    Two-dimensional arrays -- triangles, vectors of vectors, table rows -- render
    one row per line instead of one scalar per line. A reviewer reads a triangle
    as a triangle, and the file loses roughly half its bytes, which is what a
    network-drive read actually pays for. Every other node keeps the familiar
    two-space layout.

    This is the single owner of that layout. Producers must call it rather than
    ``json.dumps(..., indent=2)`` so the same payload cannot land on disk in two
    different shapes depending on which component saved it.
    """
    if _is_row_array(data):
        if not data:
            return "[]"
        child_indent = f"{indent}  "
        return f"[\n{_format_row_array_lines(data, child_indent)}\n{indent}]"
    if isinstance(data, list):
        if not data:
            return "[]"
        child_indent = f"{indent}  "
        lines = []
        for index, item in enumerate(data):
            rendered = f"{child_indent}{format_json_for_save(item, child_indent)}"
            lines.append(f"{rendered}," if index < len(data) - 1 else rendered)
        return f"[\n{chr(10).join(lines)}\n{indent}]"
    if isinstance(data, dict):
        if not data:
            return "{}"
        child_indent = f"{indent}  "
        lines = []
        keys = list(data.keys())
        for index, key in enumerate(keys):
            rendered = (
                f"{child_indent}{json.dumps(str(key), ensure_ascii=False)}: "
                f"{format_json_for_save(data[key], child_indent)}"
            )
            lines.append(f"{rendered}," if index < len(keys) - 1 else rendered)
        return f"{{\n{chr(10).join(lines)}\n{indent}}}"
    return json.dumps(data, ensure_ascii=False)


def persisted_json_text(data: Any) -> str:
    """The complete on-disk text of a persisted ArcRho JSON document."""
    return format_json_for_save(data) + "\n"


def write_json_atomic(path: Path, data: dict[str, Any], *, read_only: bool = False) -> Path:
    if read_only:
        raise ReadOnlyError(f"Cannot write {path}; client is read-only.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as fh:
            fh.write(format_json_for_save(data))
            fh.write("\n")
        os.replace(temp_path, path)
    except OSError as err:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ArcRhoApiError(f"Failed to write JSON file {path}: {err}") from err
    return path
