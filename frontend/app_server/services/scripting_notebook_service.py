"""Notebook persistence for the scripting console (.arcnb and .ipynb files)."""
from __future__ import annotations

import json
import os
import traceback
import types
from typing import Any, Dict, List, Optional, Tuple

from app_server import config
from app_server.services.scripting_service import _format_size

# ---------------------------------------------------------------------------
# Notebook persistence
# ---------------------------------------------------------------------------

def _get_notebooks_dir() -> str:
    """Return the notebooks directory, creating it if needed."""
    preferred = str(getattr(config, "SCRIPTING_DIR", "") or "").strip()
    if preferred:
        nb_dir = preferred
    else:
        nb_dir = os.path.join(config.DATA_DIR, "notebooks") if config.DATA_DIR else os.path.join(os.getcwd(), "notebooks")
    os.makedirs(nb_dir, exist_ok=True)
    return nb_dir


def _sanitize_notebook_filename(filename: str) -> str:
    """Normalize and sanitize user-provided notebook file names."""
    raw = str(filename or "").strip().replace("\\", "/")
    safe = os.path.basename(raw)
    if not safe:
        raise ValueError("Notebook filename is required.")
    return safe


def _normalize_save_filename(filename: str) -> str:
    """Ensure saved notebooks use .ipynb extension."""
    safe = _sanitize_notebook_filename(filename)
    stem, ext = os.path.splitext(safe)
    if ext.lower() == ".ipynb":
        return safe
    base = stem if stem else safe
    return f"{base}.ipynb"


def _path_within_dir(path: str, directory: str) -> bool:
    try:
        return os.path.normcase(os.path.commonpath([directory, path])) == os.path.normcase(directory)
    except ValueError:
        return False


def _source_to_text(source: Any) -> str:
    """Normalize notebook source value to a single string."""
    if isinstance(source, list):
        return "".join(str(part) for part in source)
    if source is None:
        return ""
    return str(source)


def _source_to_lines(source: str) -> List[str]:
    """Convert source text to ipynb-compatible list of lines with newlines."""
    return str(source or "").splitlines(keepends=True)


def _normalize_cell_type(raw_type: Any) -> str:
    """Map notebook cell type to frontend supported set."""
    value = str(raw_type or "").strip().lower()
    if value in {"markdown", "raw"}:
        return value
    return "code"


def _extract_plain_text(data_bundle: Any) -> str:
    """Extract plain text from display data payload."""
    if not isinstance(data_bundle, dict):
        return ""
    return _source_to_text(data_bundle.get("text/plain", ""))


def _convert_outputs_for_import(outputs: Any) -> Dict[str, Any]:
    """Convert ipynb outputs to frontend display fields."""
    if not isinstance(outputs, list):
        return {}

    stdout_parts: List[str] = []
    stderr_parts: List[str] = []
    error_parts: List[str] = []
    unsupported: set[str] = set()

    for item in outputs:
        if not isinstance(item, dict):
            unsupported.add("unknown-output")
            continue

        output_type = str(item.get("output_type", "")).strip().lower()
        if output_type == "stream":
            target = stderr_parts if str(item.get("name", "")).lower() == "stderr" else stdout_parts
            text = _source_to_text(item.get("text", ""))
            if text:
                target.append(text)
            continue

        if output_type == "error":
            traceback_lines = item.get("traceback")
            if isinstance(traceback_lines, list) and traceback_lines:
                error_parts.append("\n".join(str(line) for line in traceback_lines))
            else:
                ename = str(item.get("ename", "Error")).strip()
                evalue = str(item.get("evalue", "")).strip()
                msg = f"{ename}: {evalue}" if evalue else ename
                error_parts.append(msg)
            continue

        if output_type in {"execute_result", "display_data"}:
            data_bundle = item.get("data", {})
            text_plain = _extract_plain_text(data_bundle)
            if text_plain:
                stdout_parts.append(text_plain)

            if isinstance(data_bundle, dict):
                for mime_key in data_bundle.keys():
                    if mime_key != "text/plain":
                        unsupported.add(str(mime_key))
            else:
                unsupported.add(output_type)
            continue

        unsupported.add(output_type or "unknown-output")

    result: Dict[str, Any] = {}
    if stdout_parts:
        result["stdout"] = "".join(stdout_parts)
    if stderr_parts:
        result["stderr"] = "".join(stderr_parts)
    if error_parts:
        result["error"] = "\n".join(error_parts)
    if unsupported:
        result["unsupported"] = sorted(unsupported)
        result["unsupported_message"] = (
            "Imported output contains unsupported rich display types: "
            + ", ".join(sorted(unsupported))
            + "."
        )
    return result


def _normalize_output_text(value: Any) -> str:
    if isinstance(value, list):
        return "".join(str(part) for part in value)
    if value is None:
        return ""
    return str(value)


def _json_safe_value(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _normalize_output_data(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    result: Dict[str, Any] = {}
    for key, value in data.items():
        mime_key = str(key or "").strip()
        if not mime_key:
            continue
        result[mime_key] = _json_safe_value(value)
    return result


def _normalize_ipynb_output(output: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(output, dict):
        return None
    output_type = str(output.get("output_type", "")).strip()
    if output_type == "stream":
        name = "stderr" if str(output.get("name", "")).lower() == "stderr" else "stdout"
        text = _normalize_output_text(output.get("text", ""))
        if not text:
            return None
        return {"output_type": "stream", "name": name, "text": text}
    if output_type == "error":
        traceback = output.get("traceback")
        if not isinstance(traceback, list):
            traceback = []
        return {
            "output_type": "error",
            "ename": str(output.get("ename", "Error")),
            "evalue": str(output.get("evalue", "")),
            "traceback": [str(line) for line in traceback],
        }
    if output_type in {"execute_result", "display_data"}:
        result: Dict[str, Any] = {
            "output_type": output_type,
            "data": _normalize_output_data(output.get("data")),
            "metadata": output.get("metadata") if isinstance(output.get("metadata"), dict) else {},
        }
        if output_type == "execute_result":
            execution_count = output.get("execution_count")
            result["execution_count"] = execution_count if isinstance(execution_count, int) else None
        return result
    return None


def _normalize_ipynb_outputs(outputs: Any) -> List[Dict[str, Any]]:
    if not isinstance(outputs, list):
        return []
    result: List[Dict[str, Any]] = []
    for output in outputs:
        normalized = _normalize_ipynb_output(output)
        if normalized:
            result.append(normalized)
    return result


def _to_ipynb_cell(cell: Dict[str, Any]) -> Dict[str, Any]:
    """Convert frontend cell payload to a v4 ipynb cell."""
    cell_type = _normalize_cell_type(cell.get("type"))
    source_text = _source_to_text(cell.get("source", ""))
    base: Dict[str, Any] = {
        "cell_type": cell_type,
        "metadata": {},
        "source": _source_to_lines(source_text),
    }
    if cell_type == "code":
        execution_count = cell.get("execution_count")
        base["execution_count"] = execution_count if isinstance(execution_count, int) else None
        base["outputs"] = _normalize_ipynb_outputs(cell.get("outputs"))
    return base


def _from_ipynb_cell(cell: Dict[str, Any]) -> Dict[str, Any]:
    """Convert one ipynb cell to frontend cell payload."""
    cell_type = _normalize_cell_type(cell.get("cell_type"))
    source = _source_to_text(cell.get("source", ""))
    frontend_cell: Dict[str, Any] = {
        "type": cell_type,
        "source": source,
    }
    if cell_type == "code":
        execution_count = cell.get("execution_count")
        if isinstance(execution_count, int):
            frontend_cell["execution_count"] = execution_count
        outputs = _normalize_ipynb_outputs(cell.get("outputs"))
        frontend_cell["outputs"] = outputs
        output_info = _convert_outputs_for_import(outputs)
        if output_info:
            frontend_cell["import_output"] = output_info
    return frontend_cell


def _load_arcnb_cells(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Load legacy .arcnb files and normalize to frontend cells."""
    raw_cells = data.get("cells", [])
    if not isinstance(raw_cells, list):
        return []
    result: List[Dict[str, Any]] = []
    for entry in raw_cells:
        if not isinstance(entry, dict):
            continue
        result.append({
            "type": _normalize_cell_type(entry.get("type")),
            "source": _source_to_text(entry.get("source", "")),
        })
    return result


def save_notebook(filename: str, cells: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Save cells to a .ipynb notebook file."""
    try:
        filename = _normalize_save_filename(filename)
    except ValueError as exc:
        return {"success": False, "message": str(exc)}
    nb_dir = _get_notebooks_dir()
    filepath = os.path.join(nb_dir, filename)
    data: Dict[str, Any] = {
        "cells": [_to_ipynb_cell(c if isinstance(c, dict) else {}) for c in (cells or [])],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {
                "name": "python",
            },
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    tmp = filepath + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, filepath)
    return {"success": True, "path": filepath, "message": f"Saved to {filename}"}


def _resolve_notebook_load_path(filename: str) -> Tuple[str, str]:
    nb_dir = os.path.abspath(_get_notebooks_dir())
    raw = str(filename or "").strip()
    safe_name = _sanitize_notebook_filename(raw)
    name_stem, name_ext = os.path.splitext(safe_name)

    if os.path.isabs(raw):
        path = os.path.abspath(raw)
        if not _path_within_dir(path, nb_dir):
            raise ValueError("Scripting files must be inside the scripting directory.")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"File not found: {raw}")
        return path, safe_name

    candidates: List[str] = []
    if name_ext:
        candidates.append(safe_name)
    else:
        candidates.extend([f"{safe_name}.ipynb", f"{safe_name}.arcnb", f"{safe_name}.py"])
    if name_ext.lower() == ".ipynb":
        candidates.append(f"{name_stem}.arcnb")

    for candidate in candidates:
        candidate_path = os.path.abspath(os.path.join(nb_dir, candidate))
        if not _path_within_dir(candidate_path, nb_dir):
            continue
        if os.path.isfile(candidate_path):
            return candidate_path, safe_name

    requested = safe_name if safe_name else raw
    raise FileNotFoundError(f"File not found: {requested}")


def load_notebook(filename: str) -> Dict[str, Any]:
    """Load cells from a notebook or Python scripting file."""
    try:
        filepath, safe_name = _resolve_notebook_load_path(filename)
    except (FileNotFoundError, ValueError) as exc:
        return {"success": False, "message": str(exc), "cells": []}
    if not os.path.isfile(filepath):
        return {"success": False, "message": f"File not found: {safe_name}", "cells": []}
    _, ext = os.path.splitext(filepath)
    if ext.lower() == ".py":
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
        return {"success": True, "cells": [{"type": "code", "source": source}], "path": filepath}
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    if ext.lower() == ".ipynb":
        raw_cells = data.get("cells", [])
        if not isinstance(raw_cells, list):
            raw_cells = []
        cells = [_from_ipynb_cell(c) for c in raw_cells if isinstance(c, dict)]
    else:
        cells = _load_arcnb_cells(data)
    return {"success": True, "cells": cells, "path": filepath}


def list_notebooks() -> List[Dict[str, str]]:
    """List available notebook files."""
    nb_dir = _get_notebooks_dir()
    result = []
    for entry in sorted(os.listdir(nb_dir)):
        lower = entry.lower()
        if lower.endswith(".ipynb") or lower.endswith(".arcnb"):
            filepath = os.path.join(nb_dir, entry)
            stat = os.stat(filepath)
            result.append({
                "name": entry,
                "size": _format_size(stat.st_size),
                "modified": str(int(stat.st_mtime)),
            })
    return result


