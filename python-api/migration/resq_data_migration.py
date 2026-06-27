"""
resq_data_migration.py

Migrate ResQ triangles, vectors, Result Selections, and DFM methods to ArcRho dataset files.
Scope: ProjectName = '{PROJECT_NAME}'
Output: E:\\ArcRho Server\\projects\\{PROJECT_NAME}\\data\\<ReservingClassFolder>\\

Run:
  python resq_data_migration.py
  python resq_data_migration.py --no-cleanup-target
  python resq_dfm_export.py --export triangles
  python resq_dfm_export.py --export vectors
  python resq_dfm_export.py --export dfm
  python resq_dfm_export.py --export all
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import sys
import traceback
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


def _configured_rc_paths(value: object) -> list[str]:
    raw = value if isinstance(value, (list, tuple, set)) else [value]
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = str(item or "").strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out

# ── Configuration ──────────────────────────────────────────────────────────────
PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
# PROJECT_NAME = "NJ_Annual_Prod_2026 Q2-May"
# PROJECT_NAME = "NJ_Annual_Prod_2026 Q1-Feb"

# RC_PATH may be a string or a list of reserving-class paths.
RC_PATH = [
    r"PRNJ - PA\PA\NY\Direct Group\BI Total",
    r"PRNJ - PA\PA\NY\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\Penn+CT\Direct Group\BI Total",
    r"PRNJ - PA\PA\Penn+CT\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\All States\Direct Group\PD+UMPD",
    r"PRNJ - PA\PA\All States\Direct Group\COL",
    r"PRNJ - PA\PA\All States\Direct Group\CMPxCAT",
    r"PRNJ - PA\PA\NJ\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\NJ\Direct Group\BIR51+UMBIR51",
    r"PRNJ - PA\PA\NJ\Direct Group\BIx51+UMBIx51",
    r"HPPREF\HO+DF\NJ\Legacy\HOL",
    r"HPPREF\HO+DF\NJ\Legacy\HOPxCAT",
]


CONNECTION_NAME = "JGO_CO1SQLWPV22"
USER_NAME = ""
PASSWORD = ""

SERVER_ROOT = Path(r"E:\ArcRho Server")
PROJECT_DATA_DIR = SERVER_ROOT / "projects" / PROJECT_NAME / "data"
DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"
RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1"
INDEX_FILE_NAME = "index.json"
INDEX_VERSION = 10
DATASET_CACHE_DIR = "datasets"
METHOD_DATA_DIR = "methods"
DATASET_SIDECAR_DIR = "sidecars"
DEFAULT_CUMULATIVE = True
DEFAULT_CALENDAR = False
DEBUG_LOG_PATH = Path(__file__).resolve().parent / "logs" / "resq_data_migration_debug.log"

# Stop probing average formula rows after this many consecutive misses
MAX_AVERAGE_FORMULA_PROBE = 30

# Dataset export controls. CLI --export can override these.
EXPORT_DFMS = True
EXPORT_TRIANGLES = True
EXPORT_VECTORS = True
CLEAN_TARGET_RC = True
TRIANGLE_NAMES: list[str] = []  # Empty means export all triangles in RC_PATH
VECTOR_NAMES: list[str] = []  # Empty means export all vectors in RC_PATH
DFM_NAMES: list[str] = []  # Empty means export all DFM methods in RC_PATH

METHOD_TYPE_NONE_CODE = 0
METHOD_TYPE_DFM_CODE = 1
METHOD_TYPE_RESULT_SELECTION_CODE = 4
METHOD_TYPE_NAMES = {
    METHOD_TYPE_NONE_CODE: "None",
    METHOD_TYPE_DFM_CODE: "DFM",
    2: "BF",
    3: "CC",
    METHOD_TYPE_RESULT_SELECTION_CODE: "Result Selection",
}
ProgressCallback = Callable[[dict], None]


# ── JSON formatting ────────────────────────────────────────────────────────────

def _debug_log(event: str, **fields: object) -> None:
    try:
        DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "event": event,
            **fields,
        }
        with DEBUG_LOG_PATH.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False, default=str))
            fh.write("\n")
    except Exception:
        pass


def _is_row_array(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(row, list) for row in value)


def _format_json(data: object, indent: str = "") -> str:
    """Pretty-print JSON with compact single-line rows for 2D arrays."""
    if _is_row_array(data):
        if not data:
            return "[]"
        child = f"{indent}  "
        rows = ",\n".join(
            f"{child}[{', '.join(json.dumps(v, ensure_ascii=False) for v in row)}]"
            for row in data  # type: ignore[union-attr]
        )
        return f"[\n{rows}\n{indent}]"
    if isinstance(data, list):
        if not data:
            return "[]"
        child = f"{indent}  "
        lines = [
            f"{child}{_format_json(item, child)}{',' if i < len(data) - 1 else ''}"
            for i, item in enumerate(data)
        ]
        return f"[\n{chr(10).join(lines)}\n{indent}]"
    if isinstance(data, dict):
        if not data:
            return "{}"
        child = f"{indent}  "
        keys = list(data.keys())
        lines = [
            f"{child}{json.dumps(str(k), ensure_ascii=False)}: {_format_json(data[k], child)}"
            f"{',' if i < len(keys) - 1 else ''}"
            for i, k in enumerate(keys)
        ]
        return f"{{\n{chr(10).join(lines)}\n{indent}}}"
    return json.dumps(data, ensure_ascii=False)


# ── Path / filename encoding ───────────────────────────────────────────────────

def _encode_filename_segment(value: object) -> str:
    """Match the frontend app-server reversible _%XX_ filename escaping rule."""
    replacements = {
        "\\": "_%5C_",
        "/": "_%2F_",
        ":": "_%3A_",
        "*": "_%2A_",
        "?": "_%3F_",
        '"': "_%22_",
        "<": "_%3C_",
        ">": "_%3E_",
        "|": "_%7C_",
    }
    out: list[str] = []
    for ch in str(value if value is not None else "").strip():
        if ch in replacements:
            out.append(replacements[ch])
        elif ord(ch) < 32:
            out.append(f"_%{ord(ch):02X}_")
        else:
            out.append(ch)
    return "".join(out)


def _decode_filename_segment(value: object) -> str:
    """Match the frontend app-server reversible _%XX_ filename decoding rule."""
    def repl(match: re.Match[str]) -> str:
        try:
            return chr(int(match.group(1), 16))
        except Exception:
            return match.group(0)

    return re.sub(r"_%([0-9A-Fa-f]{2})_", repl, str(value if value is not None else ""))


def _encode_rc_folder(rc_path: str) -> str:
    """Encode a reserving class path exactly like frontend config.sanitize_reserving_class_folder."""
    text = _encode_filename_segment(rc_path)
    text = re.sub(r"[. ]+$", lambda match: "^" * len(match.group(0)), text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or "ReservingClass"


def _encode_name_part(name: str) -> str:
    """Encode a dataset / method name for use inside a filename."""
    text = _encode_filename_segment(name)
    text = re.sub(r"\s+", " ", text).strip()
    return text or "Dataset"


def _triangle_source_kind(name: str, dataset_type: str) -> str:
    return "engine" if _clean_name(dataset_type) == _clean_name(name) else "input"


def _mode_suffix(cumulative: bool = DEFAULT_CUMULATIVE, calendar: bool = DEFAULT_CALENDAR) -> str:
    cum_suffix = "cum" if cumulative else "inc"
    cal_suffix = "cal" if calendar else "dev"
    return f"@{cum_suffix}@{cal_suffix}"


def _dataset_cache_csv_file_name(
    name: str,
    origin_length: int,
    dev_length: int,
    *,
    cumulative: bool = DEFAULT_CUMULATIVE,
    calendar: bool = DEFAULT_CALENDAR,
) -> str:
    return f"{_encode_name_part(name)}@{origin_length}@{dev_length}{_mode_suffix(cumulative, calendar)}.csv"


def _csv_abs_path(
    rc_folder: str,
    name: str,
    origin_length: int,
    dev_length: int,
    *,
    cumulative: bool = DEFAULT_CUMULATIVE,
    calendar: bool = DEFAULT_CALENDAR,
) -> str:
    filename = _dataset_cache_csv_file_name(name, origin_length, dev_length, cumulative=cumulative, calendar=calendar)
    return str(PROJECT_DATA_DIR / rc_folder / DATASET_CACHE_DIR / filename)


def _json_sidecar_name(name: str) -> str:
    return f"{_encode_name_part(name)}.json"


def _safe_read_json(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(_format_json(payload))
        fh.write("\n")


def _dataset_type_rows() -> list[dict]:
    path = SERVER_ROOT / "projects" / PROJECT_NAME / "dataset_types.json"
    data = _safe_read_json(path)
    rows = data.get("rows") if isinstance(data, dict) else []
    columns = data.get("columns") if isinstance(data, dict) else []
    col_idx: dict[str, int] = {}
    if isinstance(columns, list):
        for idx, column in enumerate(columns):
            text = _clean_name(column)
            if text:
                col_idx[text.casefold()] = idx

    def row_value(row: list, column: str, fallback_idx: int, default: object = "") -> object:
        idx = col_idx.get(column.casefold(), fallback_idx)
        if 0 <= idx < len(row):
            return row[idx]
        return default

    out: list[dict] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, list):
            continue
        name = _clean_name(row_value(row, "Name", 0))
        if not name:
            continue
        out.append({
            "name": name,
            "data_format": _clean_name(row_value(row, "Data Format", 1, "Triangle")) or "Triangle",
            "category": _clean_name(row_value(row, "Category", 2)),
            "calculated": _bool_value(row_value(row, "Calculated", 3, False)),
            "formula": _clean_name(row_value(row, "Formula", 4)),
            "source": _clean_name(row_value(row, "Source", 5)),
            "generated": _bool_value(row_value(row, "Generated", 6, False)),
        })
    return out


def _bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return _clean_name(value).lower() in {"true", "1", "yes", "y"}


def _canon_dataset_name(value: object) -> str:
    return re.sub(r"\s+", " ", _clean_name(value)).casefold()


def _formula_components(formula: str, known_names: list[str]) -> list[str]:
    text = _clean_name(formula)
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    masked_parts: list[str] = []
    last = 0
    for match in re.finditer(r'"([^"]+)"', text):
        token = _clean_name(match.group(1))
        key = _canon_dataset_name(token)
        if token and key and key not in seen:
            seen.add(key)
            out.append(token)
        masked_parts.append(text[last:match.start()])
        masked_parts.append(" ")
        last = match.end()
    masked_parts.append(text[last:])
    unquoted_text = "".join(masked_parts)
    for name in sorted({item.strip() for item in known_names if item.strip()}, key=len, reverse=True):
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", flags=re.I)
        if pattern.search(unquoted_text):
            seen.add(key)
            out.append(name)
    return out


def _dataset_type_rows_by_key(rows: list[dict]) -> dict[str, dict]:
    return {
        _canon_dataset_name(row.get("name")): row
        for row in rows
        if _canon_dataset_name(row.get("name"))
    }


def _direct_precedent_names(rows: list[dict], dataset_type_name: str) -> list[str]:
    known_names = [row["name"] for row in rows]
    target_key = _canon_dataset_name(dataset_type_name)
    for row in rows:
        if _canon_dataset_name(row.get("name")) != target_key:
            continue
        formula = _clean_name(row.get("formula"))
        if not row.get("calculated") or row.get("generated") or not formula:
            return []
        return _formula_components(formula, known_names)
    return []


def _direct_dependent_names(rows: list[dict], dataset_type_name: str) -> list[str]:
    known_names = [row["name"] for row in rows]
    target_key = _canon_dataset_name(dataset_type_name)
    out: list[str] = []
    seen: set[str] = set()
    if not target_key:
        return out
    for row in rows:
        formula = _clean_name(row.get("formula"))
        if not row.get("calculated") or row.get("generated") or not formula:
            continue
        component_keys = {
            _canon_dataset_name(name)
            for name in _formula_components(formula, known_names)
        }
        if target_key not in component_keys:
            continue
        dep_key = _canon_dataset_name(row.get("name"))
        if dep_key and dep_key not in seen:
            seen.add(dep_key)
            out.append(row["name"])
    return out


def _physical_item_matches_dataset(item: dict, dataset_key: str) -> bool:
    names: set[str] = set()
    _add_cached_dataset_name(names, item.get("dataset_name"))
    _add_cached_dataset_name(names, item.get("dataset_type"))
    for value in item.get("dataset_names") or []:
        _add_cached_dataset_name(names, value)
    return dataset_key in {_canon_dataset_name(name) for name in names}


def _dependency_item_score(item: dict, dataset_key: str) -> tuple[int, float]:
    path = Path(_clean_name(item.get("path")))
    score = 0
    if path.suffix.lower() == ".csv":
        score += 30
    elif _clean_name(item.get("method_type")).lower() == "dfm":
        score += 25
    elif path.parent.name == DATASET_SIDECAR_DIR:
        score += 10
    if _canon_dataset_name(item.get("dataset_name")) == dataset_key:
        score += 4
    if _canon_dataset_name(item.get("dataset_type")) == dataset_key:
        score += 2
    return score, _numeric_timestamp(item.get("last_modified_timestamp") or item.get("mtime"))


def _dependency_file_info(rc_dir: Path | None, dataset_type_name: str) -> dict:
    if rc_dir is None or not rc_dir.is_dir():
        return {}
    dataset_key = _canon_dataset_name(dataset_type_name)
    if not dataset_key:
        return {}
    matches = [
        item
        for item in _scan_physical_dataset_files(rc_dir)
        if _physical_item_matches_dataset(item, dataset_key)
    ]
    if not matches:
        return {}
    item = sorted(matches, key=lambda entry: _dependency_item_score(entry, dataset_key), reverse=True)[0]
    out: dict = {}
    for key in ("path", "mtime", "mtime_ns"):
        if key in item:
            out[key] = item[key]
    dataset_name = _clean_name(item.get("dataset_name"))
    if dataset_name:
        out["dataset_name"] = dataset_name
    dataset_type = _clean_name(item.get("dataset_type"))
    if dataset_type:
        out["dataset_type"] = dataset_type
    method_type = _clean_name(item.get("method_type"))
    if method_type:
        out["method_type"] = method_type
    source_kind = _clean_name(item.get("source_kind"))
    if not source_kind and method_type.lower() == "dfm":
        source_kind = "dfm_method"
    if source_kind:
        out["source_kind"] = source_kind
    formula = _clean_name(item.get("formula"))
    if formula:
        out["formula"] = formula

    if method_type.lower() == "dfm" and _clean_name(out.get("path")):
        payload = _safe_read_json(Path(out["path"]))
        data_tab = payload.get("data tab") if isinstance(payload.get("data tab"), dict) else {}
        input_path = _clean_name(data_tab.get("input data triangle csv path"))
        if input_path:
            out["input_path"] = input_path
    return out


def _dependency_entry(
    name: str,
    rows_by_key: dict[str, dict],
    rc_dir: Path | None,
    *,
    include_formula: bool = False,
) -> dict:
    entry = {"dataset_type_name": name}
    entry.update(_dependency_file_info(rc_dir, name))
    row = rows_by_key.get(_canon_dataset_name(name))
    if include_formula and row:
        formula = _clean_name(row.get("formula"))
        if formula:
            entry["formula"] = formula
    return entry


def _dataset_type_graph_fields(dataset_type_name: str, rc_dir: Path | None = None) -> dict:
    rows = _dataset_type_rows()
    rows_by_key = _dataset_type_rows_by_key(rows)
    precedents = [
        _dependency_entry(name, rows_by_key, rc_dir)
        for name in _direct_precedent_names(rows, dataset_type_name)
    ]
    dependents = [
        _dependency_entry(name, rows_by_key, rc_dir, include_formula=True)
        for name in _direct_dependent_names(rows, dataset_type_name)
    ]
    return {"Precedents": precedents, "Dependents": dependents}


def _apply_sidecar_graph_meta(
    meta: dict,
    dataset_type_name: str,
    rc_dir: Path | None = None,
    *,
    preserve_precedents: bool = False,
) -> None:
    fields = _dataset_type_graph_fields(dataset_type_name, rc_dir)
    if preserve_precedents:
        meta["Dependents"] = fields["Dependents"]
    else:
        meta.update(fields)
    meta.pop("dependencies", None)


def _split_cache_variant_stem(stem: str) -> tuple[str, bool]:
    parts = str(stem or "").split("@")
    if (
        len(parts) >= 5
        and parts[-4].strip().isdigit()
        and parts[-3].strip().isdigit()
        and parts[-2].strip().lower() in {"cum", "inc", "cumulative", "incremental"}
        and parts[-1].strip().lower() in {"dev", "cal", "calendar"}
    ):
        return "@".join(parts[:-4]), True
    return str(stem or ""), False


def _has_legacy_length_only_suffix(stem: str) -> bool:
    parts = str(stem or "").split("@")
    return len(parts) >= 3 and parts[-1].strip().isdigit() and parts[-2].strip().isdigit()


def _normalize_cached_dataset_name(value: object) -> str:
    text = _clean_name(value)
    stem, _is_cache_variant = _split_cache_variant_stem(text)
    return _decode_filename_segment(stem.strip()).strip()


def _add_cached_dataset_name(names: set[str], value: object) -> None:
    text = _normalize_cached_dataset_name(value)
    if text:
        names.add(text)


def _dataset_sidecar_path_for_cached_csv(csv_path: Path) -> Path:
    stem = csv_path.stem
    dataset_stem, is_cache_variant = _split_cache_variant_stem(stem)
    sidecar_dir = csv_path.parent.parent / DATASET_SIDECAR_DIR if csv_path.parent.name == DATASET_CACHE_DIR else csv_path.parent / DATASET_SIDECAR_DIR
    if is_cache_variant:
        return sidecar_dir / f"{dataset_stem}.json"
    return sidecar_dir / f"{stem}.json"


def _cached_dataset_names_from_file(filename: str) -> set[str]:
    path = Path(filename)
    stem = path.stem
    ext = path.suffix.lower()
    names: set[str] = set()
    if ext == ".csv":
        _add_cached_dataset_name(names, stem)
        return names
    if ext != ".json":
        return names
    for prefix in ("ArcRhoTriNotes@", "DFM@"):
        if stem.startswith(prefix):
            _add_cached_dataset_name(names, stem[len(prefix):])
            return names
    _add_cached_dataset_name(names, stem)
    return names


def _cached_dataset_names_from_payload(payload: dict) -> set[str]:
    names: set[str] = set()
    _add_cached_dataset_name(names, payload.get("dataset_name"))
    if names:
        return names
    if _clean_name(payload.get("json_format")).lower() == RS_JSON_FORMAT:
        details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
        _add_cached_dataset_name(names, details_tab.get("name"))
        return names
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    _add_cached_dataset_name(names, details_tab.get("output type"))
    return names


def _dataset_type_from_payload(payload: dict) -> str:
    if _clean_name(payload.get("json_format")).lower() == RS_JSON_FORMAT:
        details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
        text = _normalize_cached_dataset_name(details_tab.get("output_type"))
        if text:
            return text
        return _normalize_cached_dataset_name(details_tab.get("name"))
    text = _normalize_cached_dataset_name(payload.get("dataset_type"))
    if text:
        return text
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    return _normalize_cached_dataset_name(details_tab.get("output type"))


def _metadata_text(metadata: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        text = _clean_name(metadata.get(key))
        if text:
            return text
    return ""


def _format_file_timestamp(value: float) -> str:
    try:
        return datetime.fromtimestamp(float(value)).isoformat(timespec="seconds")
    except Exception:
        return ""


def _numeric_timestamp(value: object) -> float:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else 0.0
    except Exception:
        return 0.0


def _parse_metadata_datetime(value: object) -> datetime | None:
    text = _clean_name(value)
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    try:
        return parsed.replace(tzinfo=None)
    except Exception:
        return parsed


def _metadata_modified_timestamp(metadata: dict) -> tuple[str, float]:
    raw = _metadata_text(metadata, (
        "last_modified",
        "last modified",
        "updated_at",
        "updated",
        "modified_at",
        "modified",
    ))
    parsed = _parse_metadata_datetime(raw)
    if parsed is None:
        return raw, 0.0
    return parsed.isoformat(), parsed.timestamp()


def _metadata_created_timestamp(metadata: dict) -> tuple[str, float]:
    raw = _metadata_text(metadata, (
        "created_at",
        "created",
        "creation_time",
    ))
    parsed = _parse_metadata_datetime(raw)
    if parsed is None:
        return raw, 0.0
    return parsed.isoformat(), parsed.timestamp()


def _scan_physical_dataset_files(folder_path: Path) -> list[dict]:
    files: list[dict] = []
    if not folder_path.is_dir():
        return files

    metadata_cache: dict[Path, dict] = {}
    entries: list[Path] = []
    dataset_dir = folder_path / DATASET_CACHE_DIR
    if dataset_dir.is_dir():
        entries.extend(entry for entry in dataset_dir.iterdir())
    method_dir = folder_path / METHOD_DATA_DIR
    if method_dir.is_dir():
        entries.extend(entry for entry in method_dir.iterdir())
    sidecar_dir = folder_path / DATASET_SIDECAR_DIR
    if sidecar_dir.is_dir():
        entries.extend(entry for entry in sidecar_dir.iterdir())

    for entry in sorted(entries, key=lambda item: str(item).lower()):
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        if ext not in {".csv", ".json"} or entry.name == INDEX_FILE_NAME:
            continue

        stat = entry.stat()
        file_names: set[str] = set()
        metadata: dict = {}
        method_type = ""
        method_dataset_name = ""
        method_dataset_type = ""
        legacy_length_only_name = _has_legacy_length_only_suffix(entry.stem)

        if ext == ".csv":
            file_names = _cached_dataset_names_from_file(entry.name)
            metadata_path = _dataset_sidecar_path_for_cached_csv(entry)
            metadata = metadata_cache.setdefault(metadata_path, _safe_read_json(metadata_path))
            metadata_is_sidecar = True
            legacy_length_only_name = legacy_length_only_name or _has_legacy_length_only_suffix(metadata_path.stem)
        else:
            metadata = metadata_cache.setdefault(entry, _safe_read_json(entry))
            is_sidecar = entry.parent.name == DATASET_SIDECAR_DIR
            metadata_is_sidecar = is_sidecar
            if not is_sidecar and entry.name.startswith("DFM@"):
                details_tab = metadata.get("details tab") if isinstance(metadata.get("details tab"), dict) else {}
                _add_cached_dataset_name(file_names, details_tab.get("output type"))
                method_dataset_name = _normalize_cached_dataset_name(details_tab.get("output type"))
                method_dataset_type = method_dataset_name
                method_type = "DFM" if file_names else ""
            elif not is_sidecar and entry.name.startswith("RS@"):
                details_tab = metadata.get("details_tab") if isinstance(metadata.get("details_tab"), dict) else {}
                _add_cached_dataset_name(file_names, details_tab.get("name"))
                method_dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
                method_dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type")) or method_dataset_name
                method_type = "Result Selection" if file_names else ""
            else:
                payload_names = set() if legacy_length_only_name else _cached_dataset_names_from_payload(metadata)
                file_names = payload_names or _cached_dataset_names_from_file(entry.name)

        if metadata and not entry.name.startswith("DFM@") and not legacy_length_only_name:
            file_names.update(_cached_dataset_names_from_payload(metadata))

        file_info = {
            "name": entry.name,
            "path": str(entry),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "mtime_ns": stat.st_mtime_ns,
            "last_modified": _format_file_timestamp(stat.st_mtime),
            "last_modified_timestamp": stat.st_mtime,
        }
        if file_names:
            file_info["dataset_names"] = sorted(file_names, key=lambda item: item.lower())
            first_name = file_info["dataset_names"][0]
            file_info["dataset_name"] = first_name
        if metadata:
            metadata_dataset_name = _normalize_cached_dataset_name(metadata.get("dataset_name"))
            dataset_type = _dataset_type_from_payload(metadata)
            if not legacy_length_only_name:
                if metadata_dataset_name:
                    file_info["dataset_name"] = metadata_dataset_name
                if dataset_type:
                    file_info["dataset_type"] = dataset_type
            file_info["source_kind"] = _clean_name(metadata.get("source_kind"))
            if "editable" in metadata:
                file_info["editable"] = metadata.get("editable")
            if "generated" in metadata:
                file_info["generated"] = metadata.get("generated")
            if "calculated" in metadata:
                file_info["calculated"] = metadata.get("calculated")
            formula = _clean_name(metadata.get("formula"))
            if formula:
                file_info["formula"] = formula
            file_info["user"] = _metadata_text(metadata, (
                "user",
                "user_name",
                "username",
                "UserName",
                "created_by",
                "modified_by",
                "updated_by",
                "owner",
                "author",
            ))
            metadata_modified, metadata_modified_ts = _metadata_modified_timestamp(metadata)
            if metadata_modified:
                file_info["last_modified"] = metadata_modified
                if metadata_is_sidecar:
                    file_info["_last_modified_from_sidecar"] = True
                if metadata_modified_ts > 0:
                    file_info["last_modified_timestamp"] = metadata_modified_ts
            metadata_created, metadata_created_ts = _metadata_created_timestamp(metadata)
            if metadata_created and metadata_is_sidecar:
                file_info["created"] = metadata_created
                file_info["_created_from_sidecar"] = True
                if metadata_created_ts > 0:
                    file_info["created_timestamp"] = metadata_created_ts
        if method_type:
            if method_dataset_name:
                file_info["dataset_name"] = method_dataset_name
            if method_dataset_type:
                file_info["dataset_type"] = method_dataset_type
            file_info["method_type"] = method_type
        files.append(file_info)
    return files


def _file_dataset_names(item: dict) -> set[str]:
    names: set[str] = set()
    _add_cached_dataset_name(names, item.get("dataset_name"))
    for value in item.get("dataset_names") or []:
        _add_cached_dataset_name(names, value)
    if names:
        return names
    _add_cached_dataset_name(names, item.get("name"))
    return names


def _merge_logical_file(existing: dict, source: dict) -> dict:
    last_modified_ts = _numeric_timestamp(source.get("last_modified_timestamp") or source.get("mtime"))
    source_sidecar_ts = bool(source.get("_last_modified_from_sidecar"))
    existing_sidecar_ts = bool(existing.get("_last_modified_from_sidecar"))
    should_update_modified = (
        last_modified_ts
        and (
            (source_sidecar_ts and not existing_sidecar_ts)
            or (source_sidecar_ts == existing_sidecar_ts and last_modified_ts >= _numeric_timestamp(existing.get("last_modified_timestamp")))
        )
    )
    if should_update_modified:
        existing["last_modified"] = _clean_name(source.get("last_modified"))
        existing["last_modified_timestamp"] = last_modified_ts
        if source_sidecar_ts:
            existing["_last_modified_from_sidecar"] = True
        user = _clean_name(source.get("user"))
        if user:
            existing["user"] = user

    created_ts = _numeric_timestamp(source.get("created_timestamp"))
    existing_created_ts = _numeric_timestamp(existing.get("created_timestamp"))
    source_created_sidecar = bool(source.get("_created_from_sidecar"))
    existing_created_sidecar = bool(existing.get("_created_from_sidecar"))
    should_update_created = (
        created_ts
        and (
            (source_created_sidecar and not existing_created_sidecar)
            or (source_created_sidecar == existing_created_sidecar and (not existing_created_ts or created_ts < existing_created_ts))
        )
    )
    if should_update_created:
        existing["created"] = _clean_name(source.get("created"))
        existing["created_timestamp"] = created_ts
        if source_created_sidecar:
            existing["_created_from_sidecar"] = True

    method_type = _clean_name(source.get("method_type"))
    if method_type:
        existing["method_type"] = method_type
    dataset_type = _clean_name(source.get("dataset_type"))
    if dataset_type and not _clean_name(existing.get("dataset_type")):
        existing["dataset_type"] = dataset_type
    source_kind = _clean_name(source.get("source_kind"))
    if source_kind and not _clean_name(existing.get("source_kind")):
        existing["source_kind"] = source_kind
    formula = _clean_name(source.get("formula"))
    if formula:
        existing["formula"] = formula
    for flag in ("editable", "generated", "calculated"):
        if flag in source and flag not in existing:
            existing[flag] = source.get(flag)
    return existing


def _logical_files_from_physical_files(files: list[dict]) -> list[dict]:
    by_name: dict[str, dict] = {}
    display_names: dict[str, str] = {}
    for item in files:
        for dataset_name in _file_dataset_names(item):
            key = dataset_name.lower()
            display_names.setdefault(key, dataset_name)
            logical = by_name.get(key)
            if logical is None:
                logical = {
                    "name": display_names[key],
                    "last_modified": "",
                    "last_modified_timestamp": 0,
                    "created": "",
                    "created_timestamp": 0,
                    "user": "",
                }
                by_name[key] = logical
            _merge_logical_file(logical, item)
    for item in by_name.values():
        item.pop("_last_modified_from_sidecar", None)
        item.pop("_created_from_sidecar", None)
    return sorted(by_name.values(), key=lambda item: _clean_name(item.get("name")).lower())


def _cached_folder_signature(files: list[dict], folder_paths: dict[str, str]) -> str:
    source = {
        "folders": {
            name: {
                "path": path,
                "exists": Path(path).is_dir(),
            }
            for name, path in sorted(folder_paths.items())
        },
        "files": [
            {
                "name": _clean_name(item.get("name")),
                "source_kind": _clean_name(item.get("source_kind")),
                "size": int(item.get("size") or 0),
                "mtime_ns": int(item.get("mtime_ns") or 0),
            }
            for item in sorted(files, key=lambda item: (
                _clean_name(item.get("name")).lower(),
            ))
        ],
    }
    signature_source = json.dumps(source, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(signature_source.encode("utf-8")).hexdigest()


def rebuild_dataset_instance_index(project_name: str, rc_path: str, rc_dir: Path) -> Path:
    folder_paths = {
        "data": str(rc_dir),
        "datasets": str(rc_dir / DATASET_CACHE_DIR),
        "methods": str(rc_dir / METHOD_DATA_DIR),
        "sidecars": str(rc_dir / DATASET_SIDECAR_DIR),
    }
    physical_files = _scan_physical_dataset_files(rc_dir)
    files = _logical_files_from_physical_files(physical_files)
    payload = {
        "ok": True,
        "version": INDEX_VERSION,
        "exists": rc_dir.is_dir(),
        "project_name": project_name,
        "reserving_class": rc_path,
        "folder_paths": folder_paths,
        "folder_signature": _cached_folder_signature(physical_files, folder_paths),
        "files": files,
    }

    rc_dir.mkdir(parents=True, exist_ok=True)
    index_path = rc_dir / INDEX_FILE_NAME
    temp_path = index_path.with_name(f"{index_path.name}.tmp")
    _write_json(temp_path, payload)
    temp_path.replace(index_path)
    print(f"    OK  {INDEX_FILE_NAME} ({len(files)} entries, version {INDEX_VERSION})")
    return index_path


# ── Average formula helpers ────────────────────────────────────────────────────

def _require_safe_target_rc_dir(rc_dir: Path) -> Path:
    target = rc_dir.resolve(strict=False)
    project_data = PROJECT_DATA_DIR.resolve(strict=False)
    if target == project_data or target.parent != project_data:
        raise ValueError(
            "Refusing to clean target reserving-class folder outside the configured project data directory: "
            f"{target}"
        )
    if not target.name:
        raise ValueError("Refusing to clean target reserving-class folder with an empty folder name.")
    return target


def cleanup_target_reserving_class_dir(rc_dir: Path) -> tuple[int, int]:
    """Remove the existing target reserving-class folder contents before export."""
    target = _require_safe_target_rc_dir(rc_dir)
    if not target.exists():
        return 0, 0
    if target.is_symlink():
        raise ValueError(f"Refusing to clean symlinked reserving-class folder: {target}")

    files = 0
    dirs = 0
    for item in target.rglob("*"):
        if item.is_dir():
            dirs += 1
        else:
            files += 1
    shutil.rmtree(target)
    return files, dirs


def refresh_sidecar_graphs_for_rc(rc_dir: Path) -> int:
    """Refresh formula-derived graph metadata for all dataset sidecars in one RC folder."""
    sidecar_dir = rc_dir / DATASET_SIDECAR_DIR
    if not sidecar_dir.is_dir():
        return 0
    updated = 0
    for path in sorted(sidecar_dir.glob("*.json"), key=lambda item: item.name.lower()):
        if path.name.startswith("ArcRhoTriNotes@"):
            continue
        meta = _safe_read_json(path)
        if not meta:
            continue
        dataset_type = _clean_name(meta.get("dataset_type") or meta.get("dataset_name"))
        if not dataset_type:
            continue
        before = json.dumps(meta, sort_keys=True, ensure_ascii=False, default=str)
        is_result_selection = (
            _clean_name(meta.get("source_kind")).lower() == "result_selection"
            or _is_result_selection_method_type(meta.get("method_type"))
        )
        _apply_sidecar_graph_meta(
            meta,
            dataset_type,
            rc_dir,
            preserve_precedents=is_result_selection,
        )
        after = json.dumps(meta, sort_keys=True, ensure_ascii=False, default=str)
        if before == after:
            continue
        _write_json(path, meta)
        updated += 1
    return updated


def _strip_formula_index_prefix(raw: str) -> str:
    """Remove leading '0: ' or '13: ' index that ResQ prepends to formula names."""
    raw = raw.strip()
    m = re.match(r"^\d+:\s*", raw)
    return raw[m.end():].strip() if m else raw


def _infer_avg_settings(label: str) -> dict:
    norm = " ".join(label.split()).strip()
    lower = norm.lower()
    if lower.startswith("user"):
        return {"averageType": "user_entry", "base": "simple", "periods": "all", "exclude": 0}
    if "benchmark" in lower:
        return {"averageType": "custom", "base": "benchmark", "periods": "all", "exclude": 0}
    m = re.match(
        r"^(volume|simple)\s*-\s*(all|[1-9]\d*)(\s+ex\s+hi/lo(?:\s*x\s*([1-9]\d*))?)?$",
        norm, re.I,
    )
    if m:
        base = m.group(1).lower()
        p = m.group(2).lower()
        periods: str | int = p if p == "all" else int(p)
        ex = int(m.group(4) or 0)
        if m.group(3) and ex == 0:
            ex = 1
        return {"averageType": "custom", "base": base, "periods": periods, "exclude": ex}
    return {"averageType": "custom", "base": "simple", "periods": "all", "exclude": 0}


# ── Development-label helpers ──────────────────────────────────────────────────

def _ratio_label_endpoints(label: str) -> tuple[int | None, int | None]:
    text = re.sub(r"^\(?\s*\d+\s*\)?\s*", "", label).strip()
    m = re.match(r"^(\d+)\s*[-–]\s*(\d+)$", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def _build_data_dev_labels(ratio_dev_labels: list[str]) -> list[str]:
    """
    Derive cumulative-age labels ('2m', '5m', …) for the data tab from
    the period-to-period ratio labels ('(1) 2-5', '(2) 5-8', …, '119 - Ult').
    """
    ages: list[int] = []
    for label in ratio_dev_labels:
        if "ult" in label.lower():
            break
        start, end = _ratio_label_endpoints(label)
        if start is not None and not ages:
            ages.append(start)
        if end is not None:
            ages.append(end)
    return [f"{a}m" for a in ages]


# ── Cell-notes parsing ─────────────────────────────────────────────────────────

def _parse_cell_notes(raw: str, origin_labels: list[str], avg_labels: list[str]) -> dict:
    """
    Parse ResQ CellNotes text into the JSON cell-notes dict.

    ResQ format per line:
        "Ratios.Ratios & Average Selection", Cell[<dev>, <row>], "<note>", User: ..., Date: ...

    If <row> matches an origin label → ratio main table.
    If <row> matches an average formula label → ratio summary table.
    """
    result: dict = {"ratio main table": {}, "ratio summary table": {}}
    if not raw:
        return result

    origin_lower = {l.strip().lower() for l in origin_labels}
    avg_lower = {l.strip().lower() for l in avg_labels}

    pattern = re.compile(r'"[^"]+",\s*Cell\[([^\]]+)\],\s*"([^"]*)"')
    for m in pattern.finditer(raw):
        cell_ref = m.group(1)
        note_text = m.group(2)
        parts = [p.strip() for p in cell_ref.split(",", 1)]
        if len(parts) != 2:
            continue
        dev_part, row_part = parts
        row_lower = row_part.lower()
        if row_lower in origin_lower or any(row_lower in ol for ol in origin_lower):
            table = "ratio main table"
        elif row_lower in avg_lower or any(row_lower in al for al in avg_lower):
            table = "ratio summary table"
        else:
            table = "ratio summary table"  # default
        result[table].setdefault(dev_part, {})[row_part] = note_text

    return result


# ── Core extraction ────────────────────────────────────────────────────────────

def _clean_name(value) -> str:
    return str(value if value is not None else "").strip()


def _dict_child(parent: dict, key: str) -> dict:
    value = parent.get(key)
    if isinstance(value, dict):
        return value
    value = {}
    parent[key] = value
    return value


def _dict_path(payload: dict, keys: tuple[str, ...]) -> dict:
    current = payload
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _merge_cell_note_dicts(remote_notes: dict, local_notes: dict) -> dict:
    merged = deepcopy(remote_notes) if isinstance(remote_notes, dict) else {}
    if not isinstance(local_notes, dict):
        return merged

    for table_name, local_rows in local_notes.items():
        if not isinstance(local_rows, dict):
            merged[table_name] = deepcopy(local_rows)
            continue
        merged_rows = merged.setdefault(table_name, {})
        if not isinstance(merged_rows, dict):
            merged_rows = {}
            merged[table_name] = merged_rows
        for row_label, local_cols in local_rows.items():
            if not isinstance(local_cols, dict):
                merged_rows[row_label] = deepcopy(local_cols)
                continue
            merged_cols = merged_rows.setdefault(row_label, {})
            if not isinstance(merged_cols, dict):
                merged_cols = {}
                merged_rows[row_label] = merged_cols
            for col_label, note_text in local_cols.items():
                merged_cols[col_label] = deepcopy(note_text)
    return merged


def _average_formula_user_entry_index(average_formulas: dict) -> int | None:
    settings = average_formulas.get("custom average formula settings")
    average_types = settings.get("averageType") if isinstance(settings, dict) else None
    if isinstance(average_types, list):
        for index, average_type in enumerate(average_types):
            if _clean_name(average_type).lower() == "user_entry":
                return index

    labels = average_formulas.get("label")
    if isinstance(labels, list):
        for index, label in enumerate(labels):
            normalized = _clean_name(label).lower()
            if normalized == "user entry" or normalized.startswith("user entry "):
                return index
    return None


def _dfm_ratio_development_labels(payload: dict) -> list[str]:
    ratio_triangle = _dict_path(payload, ("ratios tab", "ratio triangle"))
    labels = ratio_triangle.get("development labels")
    return [_clean_name(label) for label in labels] if isinstance(labels, list) else []


def _ensure_matrix_row(matrix: list, row_index: int) -> list:
    while len(matrix) <= row_index:
        matrix.append([])
    if not isinstance(matrix[row_index], list):
        matrix[row_index] = []
    return matrix[row_index]


def _copy_local_user_entry_inputs(remote_payload: dict, local_payload: dict) -> bool:
    remote_avg = _dict_path(remote_payload, ("ratios tab", "average formulas"))
    local_avg = _dict_path(local_payload, ("ratios tab", "average formulas"))
    remote_user_row = _average_formula_user_entry_index(remote_avg)
    local_user_row = _average_formula_user_entry_index(local_avg)
    if remote_user_row is None or local_user_row is None:
        return False

    local_inputs = local_avg.get("inputs")
    if not isinstance(local_inputs, list):
        local_inputs = local_avg.get("formulas")
    if (
        not isinstance(local_inputs, list)
        or local_user_row >= len(local_inputs)
        or not isinstance(local_inputs[local_user_row], list)
    ):
        return False

    remote_inputs = remote_avg.get("inputs")
    if not isinstance(remote_inputs, list):
        remote_inputs = []
        remote_avg["inputs"] = remote_inputs
    remote_row = _ensure_matrix_row(remote_inputs, remote_user_row)

    remote_dev_labels = _dfm_ratio_development_labels(remote_payload)
    local_dev_labels = _dfm_ratio_development_labels(local_payload)
    remote_label_to_col = {
        label.lower(): index
        for index, label in enumerate(remote_dev_labels)
        if label
    }

    copied = False
    for local_col, formula in enumerate(local_inputs[local_user_row]):
        formula_text = _clean_name(formula)
        if not formula_text:
            continue
        remote_col = local_col
        if local_col < len(local_dev_labels):
            remote_col = remote_label_to_col.get(local_dev_labels[local_col].lower(), local_col)
        while len(remote_row) <= remote_col:
            remote_row.append("")
        remote_row[remote_col] = formula_text
        copied = True
    return copied


def _preserve_local_dfm_data(remote_payload: dict, local_payload: dict) -> tuple[dict, set[str]]:
    """Keep local-only DFM annotations when refreshing from ResQ."""
    preserved: set[str] = set()
    if not isinstance(local_payload, dict):
        return remote_payload, preserved

    remote_ratios = _dict_child(remote_payload, "ratios tab")
    remote_notes = remote_ratios.get("cell notes")
    local_notes = _dict_path(local_payload, ("ratios tab", "cell notes"))
    if isinstance(local_notes, dict) and local_notes:
        remote_ratios["cell notes"] = _merge_cell_note_dicts(
            remote_notes if isinstance(remote_notes, dict) else {},
            local_notes,
        )
        preserved.add("cell notes")

    if _copy_local_user_entry_inputs(remote_payload, local_payload):
        preserved.add("user entry formulas")
    return remote_payload, preserved


def _iso_or_text(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "replace") and hasattr(value, "isoformat"):
        try:
            return value.replace(tzinfo=None).isoformat()
        except Exception:
            return value.isoformat()
    return str(value)


def _safe_attr(obj, attr: str, default=None):
    try:
        return getattr(obj, attr)
    except Exception:
        return default


def _safe_int_attr(obj, attr: str, default: int = 0) -> int:
    value = _safe_attr(obj, attr, default)
    try:
        return int(value)
    except Exception:
        return default


def _method_type_name(value: object) -> str:
    try:
        code = int(value)
    except (TypeError, ValueError):
        text = _clean_name(value)
        return text or "None"
    return METHOD_TYPE_NAMES.get(code, str(code))


def _method_type_code(value: object, default: int = -1) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        text = _clean_name(value).lower().replace("_", " ")
        for code, name in METHOD_TYPE_NAMES.items():
            if text == name.lower():
                return code
        return default


def _is_result_selection_method_type(method_type: object) -> bool:
    return _method_type_code(method_type) == METHOD_TYPE_RESULT_SELECTION_CODE or (
        _clean_name(method_type).lower().replace("_", " ") == "result selection"
    )


def _call_member(obj, name: str, *args, **kwargs):
    member = getattr(obj, name)
    if callable(member):
        return member(*args, **kwargs)
    if args or kwargs:
        raise TypeError(f"{name} is not callable")
    return member


def _try_call_member(obj, name: str, call_shapes: list[tuple[tuple, dict]]):
    for args, kwargs in call_shapes:
        try:
            return _call_member(obj, name, *args, **kwargs)
        except Exception:
            continue
    raise AttributeError(name)


def _origin_date_from_label(label: str) -> datetime | None:
    text = _clean_name(label)
    try:
        year = int(text)
    except ValueError:
        match = re.search(r"\d{4}", text)
        if not match:
            return None
        year = int(match.group(0))
    return datetime(year, 12, 31)


def _triangle_development_count(triangle, origin_index: int) -> int:
    origin_date = _origin_date_from_label(_triangle_origin_label(triangle, origin_index))
    call_shapes = [
        ((), {"OriginDate": origin_date}) if origin_date is not None else None,
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"arg0": origin_index}),
        ((), {}),
    ]
    call_shapes = [shape for shape in call_shapes if shape is not None]
    for name in ("DevelopmentCount", "DevCount"):
        try:
            return int(_try_call_member(triangle, name, call_shapes))
        except Exception:
            continue
    return _safe_int_attr(triangle, "DevelopmentCount", 0)


def _triangle_origin_label(triangle, origin_index: int) -> str:
    for name in ("OriginLabel", "OriginLabels"):
        try:
            return _clean_name(_try_call_member(triangle, name, [((origin_index,), {}), ((), {"OriginIndex": origin_index})]))
        except Exception:
            continue
    return str(origin_index)


def _triangle_development_label(triangle, dev_index: int) -> str:
    for name in ("DevelopmentLabel", "DevelopmentLabels", "DevLabel"):
        try:
            return _clean_name(_try_call_member(triangle, name, [((dev_index,), {}), ((), {"DevIndex": dev_index})]))
        except Exception:
            continue
    return str(dev_index)


def _triangle_value(triangle, origin_index: int, dev_index: int):
    call_shapes = [
        ((origin_index, dev_index), {}),
        ((), {"OriginIndex": origin_index, "DevIndex": dev_index}),
        ((), {"OriginIndex": origin_index, "DevelopmentIndex": dev_index}),
    ]
    for name in ("ValuesByIndex", "Values", "Value", "Data", "TriangleValues"):
        try:
            return _try_call_member(triangle, name, call_shapes)
        except Exception:
            continue
    raise AttributeError(
        "Could not read triangle values. Tried ValuesByIndex, Values, Value, Data, and TriangleValues "
        f"for cell ({origin_index}, {dev_index})."
    )


def _vector_origin_count(vector) -> int:
    for name in ("OriginCount", "Count", "Length"):
        value = _safe_int_attr(vector, name, 0)
        if value > 0:
            return value
        try:
            value = int(_call_member(vector, name))
            if value > 0:
                return value
        except Exception:
            continue
    return 0


def _vector_origin_label(vector, origin_index: int) -> str:
    for name in ("OriginLabel", "OriginLabels", "Label", "Labels"):
        try:
            return _clean_name(_try_call_member(vector, name, [((origin_index,), {}), ((), {"OriginIndex": origin_index})]))
        except Exception:
            continue
    return str(origin_index)


def _vector_value(vector, origin_index: int):
    origin_date = _origin_date_from_label(_vector_origin_label(vector, origin_index))
    call_shapes = [
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"Index": origin_index}),
        ((), {"arg0": origin_index}),
        ((), {"OriginDate": origin_date}) if origin_date is not None else None,
    ]
    call_shapes = [shape for shape in call_shapes if shape is not None]
    for name in ("ValuesByIndex", "Values", "Value", "Data", "VectorValues"):
        try:
            return _try_call_member(vector, name, call_shapes)
        except Exception:
            continue
    raise AttributeError(
        "Could not read vector values. Tried ValuesByIndex, Values, Value, Data, and VectorValues "
        f"for origin index {origin_index}."
    )


def _csv_cell(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"none", "nan"} else text


def _write_csv_matrix(path: Path, rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerows([[_csv_cell(cell) for cell in row] for row in rows])


def export_triangle(triangle) -> dict:
    """Extract a ResQ Triangle COM object into ArcRho CSV values and metadata."""
    name = _clean_name(triangle.Name)
    dataset_type = _clean_name(triangle.DatasetType.Name)
    data_format = _safe_int_attr(triangle.DatasetType, "DataFormat", 0)
    origin_length = _safe_int_attr(triangle, "OriginLength", 12)
    dev_length = _safe_int_attr(triangle, "DevelopmentLength", 12)
    origin_count = _safe_int_attr(triangle, "OriginCount", 0)
    if origin_count <= 0:
        try:
            origin_count = int(_call_member(triangle, "OriginCount"))
        except Exception:
            origin_count = 0
    if origin_count <= 0:
        raise ValueError(f"Triangle {name!r} does not expose a positive OriginCount.")

    max_dev_count = _triangle_development_count(triangle, 1)
    if max_dev_count <= 0:
        max_dev_count = _safe_int_attr(triangle, "DevelopmentCount", 0)
    if max_dev_count <= 0:
        raise ValueError(f"Triangle {name!r} does not expose a positive DevelopmentCount.")
    row_dev_counts = [_triangle_development_count(triangle, i) for i in range(1, origin_count + 1)]
    max_dev_count = max(row_dev_counts) if row_dev_counts else max_dev_count

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i, row_dev_count in enumerate(row_dev_counts, start=1):
        row: list = []
        for j in range(1, max_dev_count + 1):
            if row_dev_count and j > row_dev_count:
                row.append(None)
                continue
            attempted_cells += 1
            try:
                row.append(_triangle_value(triangle, i, j))
            except Exception as exc:
                value_errors.append(exc)
                row.append(None)
        values.append(row)
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any values for triangle {name!r}: {value_errors[0]}")

    user = _clean_name(_safe_attr(triangle, "User", ""))
    created = _iso_or_text(_safe_attr(triangle, "Created", ""))
    modified = _iso_or_text(_safe_attr(triangle, "Modified", ""))
    origin_labels = [_triangle_origin_label(triangle, i) for i in range(1, origin_count + 1)]
    dev_labels = [_triangle_development_label(triangle, j) for j in range(1, max_dev_count + 1)]

    return {
        "name": name,
        "dataset_type": dataset_type,
        "data_format": data_format,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": max_dev_count,
        "origin_labels": origin_labels,
        "development_labels": dev_labels,
        "values": values,
        "user": user,
        "created": created,
        "modified": modified,
    }


def write_triangle_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    name = payload["name"]
    dataset_type = payload.get("dataset_type") or name
    origin_length = int(payload["origin_length"])
    dev_length = int(payload["development_length"])
    csv_name = _dataset_cache_csv_file_name(
        name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
    _write_csv_matrix(csv_path, payload["values"])

    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    source_kind = _triangle_source_kind(name, dataset_type)
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "generated": source_kind == "engine",
        "editable": source_kind != "engine",
        "calculated": False,
        "source": "resq_triangle",
        "data_format": "Triangle",
        "data_format_code": payload.get("data_format", 0),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 0),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    _apply_sidecar_graph_meta(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path


def export_vector(vector) -> dict:
    """Extract a ResQ Vector COM object into ArcRho CSV values and metadata."""
    name = _clean_name(vector.Name)
    dataset_type_obj = _safe_attr(vector, "DatasetType", None)
    dataset_type = _clean_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 1)
    method_type_code = _safe_int_attr(vector, "MethodType", -1)
    method_type = _method_type_name(method_type_code)
    origin_length = _safe_int_attr(vector, "OriginLength", 12)
    dev_length = _safe_int_attr(vector, "DevelopmentLength", 12)
    origin_count = _vector_origin_count(vector)
    if origin_count <= 0:
        raise ValueError(f"Vector {name!r} does not expose a positive OriginCount/Count.")

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i in range(1, origin_count + 1):
        attempted_cells += 1
        try:
            values.append([_vector_value(vector, i)])
        except Exception as exc:
            value_errors.append(exc)
            values.append([None])
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any values for vector {name!r}: {value_errors[0]}")

    user = _clean_name(_safe_attr(vector, "User", ""))
    created = _iso_or_text(_safe_attr(vector, "Created", ""))
    modified = _iso_or_text(_safe_attr(vector, "Modified", ""))
    formula = _clean_name(_safe_attr(vector, "Formula", ""))
    origin_labels = [_vector_origin_label(vector, i) for i in range(1, origin_count + 1)]

    return {
        "name": name,
        "dataset_type": dataset_type,
        "data_format": data_format,
        "method_type": method_type,
        "method_type_code": method_type_code,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": 1,
        "origin_labels": origin_labels,
        "development_labels": ["Value"],
        "values": values,
        "formula": formula,
        "user": user,
        "created": created,
        "modified": modified,
    }


def write_vector_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    name = payload["name"]
    dataset_type = payload.get("dataset_type") or name
    origin_length = int(payload["origin_length"])
    dev_length = int(payload["development_length"])
    csv_name = _dataset_cache_csv_file_name(
        name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
    _write_csv_matrix(csv_path, payload["values"])

    formula = _clean_name(payload.get("formula"))
    method_type = _method_type_name(payload.get("method_type"))
    is_result_selection = _is_result_selection_method_type(method_type)
    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    source_kind = "result_selection" if is_result_selection else ("calculated" if formula else "input")
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "generated": bool(is_result_selection),
        "editable": not bool(formula or is_result_selection),
        "calculated": bool(formula or is_result_selection),
        "formula": formula,
        "source": "resq_result_selection_vector" if is_result_selection else "resq_vector",
        "method_type": method_type,
        "method_type_code": payload.get("method_type_code", _method_type_code(method_type, 0)),
        "data_format": "Vector",
        "data_format_code": payload.get("data_format", 1),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 1),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    if is_result_selection:
        meta["status"] = 0
        source_names = [
            _clean_name(item)
            for item in payload.get("precedents", [])
            if _clean_name(item)
        ]
        meta["Precedents"] = source_names
        meta["Dependents"] = []
    else:
        _apply_sidecar_graph_meta(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path


def _result_selection_dataset_count(result_selection) -> int:
    value = _safe_int_attr(result_selection, "DatasetCount", 0)
    if value > 0:
        return value
    try:
        return int(_call_member(result_selection, "DatasetCount"))
    except Exception:
        return 0


def _result_selection_origin_count(result_selection) -> int:
    value = _safe_int_attr(result_selection, "OriginCount", 0)
    if value > 0:
        return value
    try:
        return int(_call_member(result_selection, "OriginCount"))
    except Exception:
        return 0


def _result_selection_origin_label(result_selection, origin_index: int) -> str:
    try:
        return _clean_name(result_selection.OriginLabel(origin_index))
    except Exception:
        return str(origin_index)


def _result_selection_dataset(result_selection, dataset_index: int):
    return _call_member(result_selection, "Dataset", dataset_index)


def _result_selection_dataset_value(result_selection, dataset_index: int, origin_index: int, origin_length: int):
    call_shapes = [
        ((dataset_index, origin_index, origin_length), {}),
        ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index, "OriginLength": origin_length}),
    ]
    return _try_call_member(result_selection, "DatasetValues", call_shapes)


def _result_selection_weight(result_selection, dataset_index: int, origin_index: int):
    call_shapes = [
        ((dataset_index, origin_index), {}),
        ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index}),
    ]
    return _try_call_member(result_selection, "Weights", call_shapes)


def _result_selection_ultimate(result_selection, origin_index: int, origin_length: int):
    call_shapes = [
        ((origin_index, origin_length), {}),
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index, "OriginLength": origin_length}),
    ]
    return _try_call_member(result_selection, "Ultimates", call_shapes)


def _result_selection_ratio_basis_dataset_name(result_selection) -> str:
    call_shapes = [
        ((1,), {}),
        ((), {"DatasetIndex": 1}),
        ((), {"arg0": 1}),
    ]
    try:
        dataset = _try_call_member(result_selection, "RatioBasisDataset", call_shapes)
    except Exception:
        return ""
    return _clean_name(_safe_attr(dataset, "Name", ""))


def _result_selection_source_payload(result_selection, dataset_index: int, origin_count: int, origin_length: int) -> dict:
    dataset = _result_selection_dataset(result_selection, dataset_index)
    dataset_type_obj = _safe_attr(dataset, "DatasetType", None)
    data_format_code = _safe_int_attr(dataset_type_obj, "DataFormat", -1)
    data_format = "Triangle" if data_format_code == 0 else "Vector"
    method_type_code = _safe_int_attr(dataset, "MethodType", METHOD_TYPE_NONE_CODE)
    values: list = []
    weights: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            values.append(_result_selection_dataset_value(result_selection, dataset_index, origin_index, origin_length))
        except Exception:
            values.append(None)
        try:
            weights.append(_result_selection_weight(result_selection, dataset_index, origin_index))
        except Exception:
            weights.append(0)
    return {
        "name": _clean_name(_safe_attr(dataset, "Name", "")) or f"Source {dataset_index}",
        "dataset_type": _clean_name(_safe_attr(dataset_type_obj, "Name", "")),
        "data_format": data_format,
        "method_type": _method_type_name(method_type_code),
        "category": _clean_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", "")),
        "values": values,
        "weights": weights,
    }


def export_result_selection(result_selection) -> dict:
    """Extract a ResQ Result Selection method into ArcRho's method JSON shape."""
    output_vector = _safe_attr(result_selection, "OutputVector", None)
    name = _clean_name(_safe_attr(output_vector, "Name", "")) or _clean_name(_safe_attr(result_selection, "Name", ""))
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    output_type = _clean_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    origin_length = _safe_int_attr(result_selection, "OriginLength", 12)
    origin_count = _result_selection_origin_count(result_selection)
    if origin_count <= 0:
        raise ValueError(f"Result Selection {name!r} does not expose a positive OriginCount.")
    dataset_count = _result_selection_dataset_count(result_selection)
    origin_labels = [_result_selection_origin_label(result_selection, i) for i in range(1, origin_count + 1)]
    sources = [
        _result_selection_source_payload(result_selection, dataset_index, origin_count, origin_length)
        for dataset_index in range(1, dataset_count + 1)
    ]
    ratio_basis_dataset = _result_selection_ratio_basis_dataset_name(result_selection)
    selected_ultimate: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            selected_ultimate.append(_result_selection_ultimate(result_selection, origin_index, origin_length))
        except Exception:
            selected_ultimate.append(None)

    try:
        notes = _clean_name(result_selection.Notes)
    except Exception:
        notes = ""
    try:
        modified = _iso_or_text(output_vector.Modified)
    except Exception:
        modified = datetime.now(timezone.utc).astimezone().isoformat()

    return {
        "json_format": RS_JSON_FORMAT,
        "details_tab": {
            "name": name,
            "output_type": output_type,
            "origin_length": origin_length,
            "ratio_basis": ratio_basis_dataset,
            "ratio_basis_dataset": ratio_basis_dataset,
            "show_ratios_as_percentages": True,
            "statistic_decimal_places": 1,
        },
        "method_tab": {
            "origin_labels": origin_labels,
            "show_weights": True,
            "sources": sources,
            "selected_ultimate": selected_ultimate,
            "ratio_basis_values": [],
        },
        "results_tab": {},
        "validation_tab": {},
        "notes_tab": {
            "notes": notes,
        },
        "method_metadata": {
            "last_modified": modified,
        },
    }


def _result_selection_source_names(payload: dict) -> list[str]:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    sources = method_tab.get("sources") if isinstance(method_tab.get("sources"), list) else []
    names: list[str] = []
    seen: set[str] = set()
    for source in sources:
        name = _clean_name(source.get("name") if isinstance(source, dict) else "")
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


def _result_selection_origin_labels_from_payload(payload: dict) -> list[str]:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    labels = method_tab.get("origin_labels") if isinstance(method_tab.get("origin_labels"), list) else []
    return [_clean_name(label) for label in labels if _clean_name(label)]


def _apply_result_selection_vector_metadata(payload: dict, result_selection_payload: dict) -> None:
    payload["precedents"] = _result_selection_source_names(result_selection_payload)
    origin_labels = _result_selection_origin_labels_from_payload(result_selection_payload)
    if origin_labels:
        payload["origin_labels"] = origin_labels
        payload["origin_count"] = len(origin_labels)


def write_result_selection_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    name = _clean_name(details_tab.get("name")) or "Result Selection"
    file_name = f"RS@{_encode_name_part(name)}.json"
    out_path = rc_dir / METHOD_DATA_DIR / file_name
    _write_json(out_path, payload)
    return out_path


def _find_result_selection_for_vector(reserving_class, vector_name: str):
    try:
        return _call_member(reserving_class, "GetResultSelection", vector_name)
    except Exception:
        pass
    try:
        collection = _call_member(reserving_class, "ResultSelections")
        try:
            return collection.Item(vector_name)
        except Exception:
            pass
        for item in collection:
            output_vector = _safe_attr(item, "OutputVector", None)
            if _clean_name(_safe_attr(output_vector, "Name", "")).lower() == vector_name.lower():
                return item
    except Exception:
        return None
    return None


def _dfm_ultimate_value(dfm, origin_index: int):
    call_shapes = [
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"arg0": origin_index}),
    ]
    try:
        return _try_call_member(dfm, "Ultimates", call_shapes)
    except Exception as exc:
        raise AttributeError(f"Could not read DFM ultimate value for origin index {origin_index}.") from exc


def export_dfm_ultimate_vector(
    dfm,
    origin_labels: list[str],
    origin_length: int,
    dev_length: int,
) -> dict:
    """Extract the DFM output vector from ResQ DFM.Ultimates into ArcRho CSV payload shape."""
    output_vector = dfm.OutputVector
    name = _clean_name(output_vector.Name)
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    dataset_type = _clean_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 1)
    method_type_code = _safe_int_attr(output_vector, "MethodType", -1)
    method_type = _method_type_name(method_type_code)
    origin_count = len(origin_labels)
    if origin_count <= 0:
        raise ValueError(f"DFM output vector {name!r} does not have origin labels.")

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i in range(1, origin_count + 1):
        attempted_cells += 1
        try:
            values.append([_dfm_ultimate_value(dfm, i)])
        except Exception as exc:
            value_errors.append(exc)
            values.append([None])
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any DFM ultimate values for {name!r}: {value_errors[0]}")

    user = _clean_name(_safe_attr(output_vector, "User", ""))
    created = _iso_or_text(_safe_attr(output_vector, "Created", ""))
    modified = _iso_or_text(_safe_attr(output_vector, "Modified", ""))

    return {
        "name": name,
        "dataset_type": dataset_type,
        "data_format": data_format,
        "method_type": method_type,
        "method_type_code": method_type_code,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": 1,
        "origin_labels": origin_labels,
        "development_labels": ["Ultimate"],
        "values": values,
        "method_name": _clean_name(dfm.Name),
        "user": user,
        "created": created,
        "modified": modified,
    }


def write_dfm_ultimate_vector_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    name = payload["name"]
    dataset_type = payload.get("dataset_type") or name
    origin_length = int(payload["origin_length"])
    dev_length = int(payload["development_length"])
    csv_name = _dataset_cache_csv_file_name(
        name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
    _write_csv_matrix(csv_path, payload["values"])

    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": "dfm",
        "generated": True,
        "editable": False,
        "calculated": True,
        "source": "resq_dfm_ultimates",
        "method_name": payload.get("method_name", ""),
        "method_type": _method_type_name(payload.get("method_type")),
        "method_type_code": payload.get("method_type_code", _method_type_code(payload.get("method_type"), -1)),
        "data_format": "Vector",
        "data_format_code": payload.get("data_format", 1),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 1),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    _apply_sidecar_graph_meta(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path


def _dfm_methods_by_output_name(reserving_class, dfm_names: list[str] | None = None) -> dict[str, tuple[str, object]]:
    try:
        dfm_collection = reserving_class.DFMMethods()
    except Exception:
        return {}
    names = list(dfm_names) if dfm_names is not None else _dfm_export_names(reserving_class)
    out: dict[str, tuple[str, object]] = {}
    for dfm_name in names:
        clean_name = _clean_name(dfm_name)
        if not clean_name:
            continue
        try:
            dfm = dfm_collection.Item(clean_name)
        except Exception:
            continue
        output_vector = _safe_attr(dfm, "OutputVector", None)
        output_name = _clean_name(_safe_attr(output_vector, "Name", ""))
        key = output_name.lower()
        if key and key not in out:
            out[key] = (clean_name, dfm)
    return out


def _export_dfm_output_dataset(
    dfm,
    rc_path: str,
    rc_dir: Path,
    *,
    verbose: bool = True,
) -> tuple[str, str]:
    dfm_name = _clean_name(_safe_attr(dfm, "Name", ""))
    file_name = f"DFM@{_encode_name_part(dfm_name)}.json"
    out_path = rc_dir / METHOD_DATA_DIR / file_name
    payload = export_dfm(dfm, rc_path)
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    output_dataset_name = _clean_name(details_tab.get("output type")) or dfm_name
    _debug_log(
        "dfm_export_payload",
        project_name=PROJECT_NAME,
        reserving_class=rc_path,
        method_name=payload.get("details tab", {}).get("name") if isinstance(payload.get("details tab"), dict) else dfm_name,
        input_triangle=payload.get("details tab", {}).get("input triangle") if isinstance(payload.get("details tab"), dict) else "",
        origin_length=payload.get("details tab", {}).get("origin length") if isinstance(payload.get("details tab"), dict) else "",
        development_length=payload.get("details tab", {}).get("development length") if isinstance(payload.get("details tab"), dict) else "",
        input_csv_path=payload.get("data tab", {}).get("input data triangle csv path") if isinstance(payload.get("data tab"), dict) else "",
    )
    _warn_if_dfm_input_sidecar_missing(payload, verbose=verbose)
    ultimate_payload = export_dfm_ultimate_vector(
        dfm,
        payload["data tab"]["origin labels"],
        payload["details tab"]["origin length"],
        payload["details tab"]["development length"],
    )
    ultimate_csv_path = write_dfm_ultimate_vector_export(ultimate_payload, rc_path, rc_dir)
    existing_payload = _safe_read_json(out_path)
    payload, preserved = _preserve_local_dfm_data(payload, existing_payload)
    _write_json(out_path, payload)

    suffix = f" (preserved {', '.join(sorted(preserved))})" if preserved else ""
    _log(verbose, f"    OK  {_clean_name(ultimate_csv_path.name)}")
    detail = f"    OK  {file_name}{suffix}"
    _log(verbose, detail)
    return output_dataset_name, detail


def _log(verbose: bool, message: str) -> None:
    if verbose:
        print(message)


def _report_progress(progress_callback: ProgressCallback | None, **payload: object) -> None:
    if not progress_callback:
        return
    try:
        progress_callback(dict(payload))
    except Exception:
        pass


def _triangle_export_names(reserving_class) -> list[str]:
    triangle_collection = reserving_class.Triangles()
    if TRIANGLE_NAMES:
        return [name.strip() for name in TRIANGLE_NAMES if str(name or "").strip()]
    return [_clean_name(_safe_attr(item, "Name", "")) for item in triangle_collection if _clean_name(_safe_attr(item, "Name", ""))]


def _vector_export_names(reserving_class) -> list[str]:
    vector_collection = reserving_class.Vectors()
    if VECTOR_NAMES:
        return [name.strip() for name in VECTOR_NAMES if str(name or "").strip()]
    return [_clean_name(_safe_attr(item, "Name", "")) for item in vector_collection if _clean_name(_safe_attr(item, "Name", ""))]


def _dfm_export_names(reserving_class) -> list[str]:
    dfm_collection = reserving_class.DFMMethods()
    if DFM_NAMES:
        return [name.strip() for name in DFM_NAMES if str(name or "").strip()]
    return [_clean_name(_safe_attr(item, "Name", "")) for item in dfm_collection if _clean_name(_safe_attr(item, "Name", ""))]


def resq_export_dataset_counts(
    reserving_class,
    *,
    run_triangles: bool = True,
    run_vectors: bool = True,
    run_dfms: bool = True,
) -> dict:
    """Return ResQ dataset counts plus method counts for one reserving class."""

    triangle_names = _triangle_export_names(reserving_class) if run_triangles else []
    vector_names = _vector_export_names(reserving_class) if run_vectors else []
    dfm_names = _dfm_export_names(reserving_class) if run_dfms else []
    return {
        "triangles": len(triangle_names),
        "vectors": len(vector_names),
        "dfms": len(dfm_names),
        "methods": len(dfm_names),
        "total": len(triangle_names) + len(vector_names),
        "triangle_names": triangle_names,
        "vector_names": vector_names,
        "dfm_names": dfm_names,
    }


def export_triangles_for_rc(
    reserving_class,
    rc_path: str,
    rc_dir: Path,
    *,
    progress_callback: ProgressCallback | None = None,
    progress_state: dict | None = None,
    triangle_names: list[str] | None = None,
    verbose: bool = True,
) -> tuple[int, int]:
    """Export triangle datasets for one reserving class. Returns (written, errors)."""
    triangle_collection = reserving_class.Triangles()
    triangle_names = list(triangle_names) if triangle_names is not None else _triangle_export_names(reserving_class)

    _log(verbose, f"Triangles: {len(triangle_names)}")
    written = errors = 0
    progress_state = progress_state if isinstance(progress_state, dict) else {"completed": 0, "total": len(triangle_names)}
    for triangle_name in triangle_names:
        _report_progress(
            progress_callback,
            event="start",
            kind="triangle",
            name=triangle_name,
            completed=int(progress_state.get("completed") or 0),
            total=int(progress_state.get("total") or len(triangle_names)),
            message=f"Importing triangle: {triangle_name}",
        )
        try:
            triangle = triangle_collection.Item(triangle_name)
            payload = export_triangle(triangle)
            write_triangle_export(payload, rc_path, rc_dir)
            source_kind = _triangle_source_kind(payload["name"], payload.get("dataset_type", ""))
            detail = (
                f"    OK  {source_kind} "
                f"{_dataset_cache_csv_file_name(payload['name'], payload['origin_length'], payload['development_length'])}"
            )
            _log(verbose, detail)
            written += 1
            progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="finish",
                kind="triangle",
                name=payload.get("name") or triangle_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or len(triangle_names)),
                status="success",
                message=detail.strip(),
            )
        except Exception as exc:
            detail = f"    ERR triangle {triangle_name}: {exc}"
            _log(verbose, detail)
            if verbose:
                traceback.print_exc(file=sys.stdout)
            errors += 1
            progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="finish",
                kind="triangle",
                name=triangle_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or len(triangle_names)),
                status="error",
                message=detail.strip(),
            )
    return written, errors


def export_vectors_for_rc(
    reserving_class,
    rc_path: str,
    rc_dir: Path,
    *,
    progress_callback: ProgressCallback | None = None,
    progress_state: dict | None = None,
    vector_names: list[str] | None = None,
    include_dfm_methods: bool = False,
    dfm_names: list[str] | None = None,
    method_counts: dict | None = None,
    verbose: bool = True,
) -> tuple[int, int]:
    """Export vector datasets for one reserving class. Returns (written, errors)."""
    vector_collection = reserving_class.Vectors()
    vector_names = list(vector_names) if vector_names is not None else _vector_export_names(reserving_class)
    dfm_by_output = _dfm_methods_by_output_name(reserving_class, dfm_names) if include_dfm_methods else {}

    _log(verbose, "Vectors: " + str(len(vector_names)))
    written = errors = 0
    progress_state = progress_state if isinstance(progress_state, dict) else {"completed": 0, "total": len(vector_names)}
    for vector_name in vector_names:
        _report_progress(
            progress_callback,
            event="start",
            kind="vector",
            name=vector_name,
            completed=int(progress_state.get("completed") or 0),
            total=int(progress_state.get("total") or len(vector_names)),
            message=f"Importing vector: {vector_name}",
        )
        try:
            vector = vector_collection.Item(vector_name)
            method_type = _safe_int_attr(vector, "MethodType", -1)
            dfm_entry = dfm_by_output.get(vector_name.lower()) if method_type == METHOD_TYPE_DFM_CODE else None
            if dfm_entry is not None:
                dfm_name, dfm = dfm_entry
                output_dataset_name, detail = _export_dfm_output_dataset(dfm, rc_path, rc_dir, verbose=verbose)
                if isinstance(method_counts, dict):
                    method_counts["dfms_written"] = int(method_counts.get("dfms_written") or 0) + 1
                written += 1
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
                _report_progress(
                    progress_callback,
                    event="finish",
                    kind="vector",
                    name=output_dataset_name or vector_name,
                    dataset_name=output_dataset_name or vector_name,
                    method_name=dfm_name,
                    completed=int(progress_state.get("completed") or 0),
                    total=int(progress_state.get("total") or len(vector_names)),
                    status="success",
                    message=detail.strip(),
                )
                continue
            if method_type == METHOD_TYPE_DFM_CODE and include_dfm_methods:
                _log(verbose, f"    WARN DFM method not found for vector {vector_name}; exporting vector only")

            result_selection_payload = None
            if method_type == METHOD_TYPE_RESULT_SELECTION_CODE:
                result_selection = _find_result_selection_for_vector(reserving_class, vector_name)
                if result_selection is None:
                    _log(verbose, f"    WARN result selection method not found for vector {vector_name}; exporting vector only")
                else:
                    result_selection_payload = export_result_selection(result_selection)
            payload = export_vector(vector)
            if result_selection_payload:
                _apply_result_selection_vector_metadata(payload, result_selection_payload)
            write_vector_export(payload, rc_path, rc_dir)
            detail = (
                f"    OK  {_method_type_name(method_type)} vector "
                f"{_dataset_cache_csv_file_name(payload['name'], payload['origin_length'], payload['development_length'])}"
            )
            _log(verbose, detail)
            if result_selection_payload:
                method_path = write_result_selection_export(result_selection_payload, rc_path, rc_dir)
                _log(verbose, f"    OK  {method_path.name}")
            written += 1
            progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="finish",
                kind="vector",
                name=payload.get("name") or vector_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or len(vector_names)),
                status="success",
                message=detail.strip(),
            )
        except Exception as exc:
            detail = f"    ERR vector {vector_name}: {exc}"
            _log(verbose, detail)
            if verbose:
                traceback.print_exc(file=sys.stdout)
            errors += 1
            progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="finish",
                kind="vector",
                name=vector_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or len(vector_names)),
                status="error",
                message=detail.strip(),
            )
    return written, errors


def _get_ratio_value(dfm, i: int, j: int) -> float | None:
    try:
        v = dfm.Ratios(OriginIndex=i, DevIndex=j)
        return float(v) if v is not None else None
    except Exception:
        return None


def export_dfm(dfm, rc_path: str) -> dict:
    """Extract all DFM data from a ResQ DFM COM object and return a JSON-ready dict."""
    name = dfm.Name.strip()
    input_tri_name = dfm.InputTriangle.Name.strip()
    output_vec_name = dfm.OutputVector.Name.strip()
    origin_length: int = dfm.OriginLength
    dev_length: int = dfm.DevelopmentLength
    decimal_places: int = dfm.RatioDecimalPlaces

    try:
        ultimate_dp: int = dfm.SummaryRatioDecimalPlaces
    except Exception:
        ultimate_dp = 2

    try:
        ratio_basis = dfm.SummaryRatioBasis.Name.strip()
    except Exception:
        ratio_basis = ""

    try:
        modified = dfm.OutputVector.Modified
        last_modified = _iso_or_text(modified)
    except Exception:
        last_modified = datetime.now(timezone.utc).astimezone().isoformat()

    origin_count: int = dfm.OriginCount
    dev_count: int = dfm.DevelopmentCount(1) if origin_count > 0 else 0
    org_rng = range(1, origin_count + 1)
    dev_rng = range(1, dev_count + 1)

    origin_labels = [dfm.OriginLabel(i) for i in org_rng]
    ratio_dev_labels = [dfm.DevelopmentLabel(j) for j in dev_rng]
    data_dev_labels = _build_data_dev_labels(ratio_dev_labels)

    # Ratio triangle values (staircase shape)
    ratio_values: list[list] = []
    excluded: list[list] = []
    for i in org_rng:
        row_dev = dfm.DevelopmentCount(i)
        rv_row: list = []
        ex_row: list = []
        for j in range(1, row_dev + 1):
            val = _get_ratio_value(dfm, i, j)
            rv_row.append(round(val, decimal_places) if val is not None else 0)
            try:
                ex_row.append(int(dfm.ExcludedRatios(i, j)))
            except Exception:
                ex_row.append(0)
        ratio_values.append(rv_row)
        excluded.append(ex_row)

    # Enumerate average formula names from ResQ (1-based, strip index prefix)
    raw_names: list[str] = []
    for idx in range(1, MAX_AVERAGE_FORMULA_PROBE + 1):
        try:
            f = dfm.AverageFormula(idx)
            if f is None:
                break
            raw_names.append(f)
        except Exception:
            break

    # Deduplicate: keep only the first User Entry; record its ResQ index
    formula_labels: list[str] = []
    resq_idx_map: list[int] = []   # formula_labels[k] came from ResQ formula index resq_idx_map[k]+1
    user_entry_seen = False
    for list_idx, raw in enumerate(raw_names):
        cleaned = _strip_formula_index_prefix(raw)
        is_user = cleaned.lower().startswith("user")
        if is_user:
            if not user_entry_seen:
                user_entry_seen = True
                formula_labels.append("User Entry")
                resq_idx_map.append(list_idx)
        else:
            formula_labels.append(cleaned)
            resq_idx_map.append(list_idx)

    n_formulas = len(formula_labels)

    # selected[formula_row][dev_col] = 1 when that formula is selected
    selected = [[0] * dev_count for _ in range(n_formulas)]
    for j in dev_rng:
        try:
            sel = int(dfm.SelectedRatios(DevIndex=j))  # 1-based ResQ formula index
        except Exception:
            continue
        # sel is 1-based index into raw_names; find in resq_idx_map
        raw_idx_0 = sel - 1  # 0-based into raw_names
        for k, mapped_raw_idx in enumerate(resq_idx_map):
            if mapped_raw_idx == raw_idx_0:
                selected[k][j - 1] = 1
                break

    # values[formula_row][dev_col] = computed average LDF
    values: list[list] = []
    for k, raw_idx_0 in enumerate(resq_idx_map):
        resq_formula_idx = raw_idx_0 + 1  # back to 1-based
        row: list = []
        for j in dev_rng:
            try:
                v = dfm.AverageRatioValues(j, resq_formula_idx)
                row.append(round(float(v), decimal_places) if v is not None else None)
            except Exception:
                row.append(None)
        # trim trailing None
        while row and row[-1] is None:
            row.pop()
        values.append(row)

    # Custom average formula settings
    avg_settings: dict = {"averageType": [], "base": [], "periods": [], "exclude": []}
    for label in formula_labels:
        s = _infer_avg_settings(label)
        avg_settings["averageType"].append(s["averageType"])
        avg_settings["base"].append(s["base"])
        avg_settings["periods"].append(s["periods"])
        avg_settings["exclude"].append(s["exclude"])

    # Notes
    try:
        notes_text: str = dfm.Notes or ""
    except Exception:
        notes_text = ""

    # Cell notes
    try:
        cell_notes_raw: str = dfm.CellNotes or ""
    except Exception:
        cell_notes_raw = ""
    cell_notes = _parse_cell_notes(cell_notes_raw, origin_labels, formula_labels)

    # CSV paths
    rc_folder = _encode_rc_folder(rc_path)
    input_csv = _csv_abs_path(
        rc_folder,
        input_tri_name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    output_csv = _csv_abs_path(
        rc_folder,
        output_vec_name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )

    return {
        "json format": DFM_JSON_FORMAT,
        "details tab": {
            "name": name,
            "output type": output_vec_name,
            "input triangle": input_tri_name,
            "origin length": origin_length,
            "development length": dev_length,
            "decimal places": decimal_places,
        },
        "data tab": {
            "origin labels": origin_labels,
            "development labels": data_dev_labels,
            "input data triangle csv path": input_csv,
        },
        "ratios tab": {
            "ratio triangle": {
                "origin labels": origin_labels,
                "development labels": ratio_dev_labels,
                "ratio values": ratio_values,
                "excluded": excluded,
            },
            "average formulas": {
                "label": formula_labels,
                "custom average formula settings": avg_settings,
                "selected": selected,
                "values": values,
            },
            "cell notes": cell_notes,
        },
        "results tab": {
            "ratio basis dataset": ratio_basis,
            "ultimate ratio decimal places": ultimate_dp,
            "ultimate vector csv path": output_csv,
        },
        "notes tab": {
            "notes": notes_text,
        },
        "method metadata": {
            "last modified": last_modified,
        },
    }


# Main

def _warn_if_dfm_input_sidecar_missing(payload: dict, *, verbose: bool = True) -> None:
    details = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    data_tab = payload.get("data tab") if isinstance(payload.get("data tab"), dict) else {}
    input_path = _clean_name(data_tab.get("input data triangle csv path"))
    if not input_path:
        _debug_log("dfm_input_sidecar_check", method_name=_clean_name(details.get("name")), input_path="", skipped=True)
        return
    path = Path(input_path)
    sidecar_path = _dataset_sidecar_path_for_cached_csv(path)
    _debug_log(
        "dfm_input_sidecar_check",
        method_name=_clean_name(details.get("name")),
        input_triangle=_clean_name(details.get("input triangle")),
        origin_length=details.get("origin length"),
        development_length=details.get("development length"),
        input_csv_path=str(path),
        input_csv_exists=path.is_file(),
        sidecar_path=str(sidecar_path),
        sidecar_exists=sidecar_path.is_file(),
    )
    if sidecar_path.is_file():
        return
    _log(
        verbose,
        "    WARN missing DFM input sidecar "
        f"{sidecar_path.name} for {_clean_name(details.get('name')) or 'DFM method'}; "
        "export the input triangle before opening the DFM in ArcRho."
    )


def export_dfms_for_rc(
    reserving_class,
    rc_path: str,
    rc_dir: Path,
    *,
    progress_callback: ProgressCallback | None = None,
    progress_state: dict | None = None,
    dfm_names: list[str] | None = None,
    verbose: bool = True,
) -> tuple[int, int]:
    """Export DFM method JSON/metadata for one reserving class. Returns (written, errors)."""
    dfm_collection = reserving_class.DFMMethods()
    dfm_names = list(dfm_names) if dfm_names is not None else _dfm_export_names(reserving_class)

    _log(verbose, f"DFMs: {len(dfm_names)}")
    written = errors = 0
    progress_state = progress_state if isinstance(progress_state, dict) else {"completed": 0, "total": len(dfm_names)}
    methods_increment_progress = progress_state.get("count_methods", True) is not False
    for dfm_name in dfm_names:
        file_name = f"DFM@{_encode_name_part(dfm_name)}.json"
        out_path = rc_dir / METHOD_DATA_DIR / file_name
        output_dataset_name = ""
        try:
            dfm = dfm_collection.Item(dfm_name)
            payload = export_dfm(dfm, rc_path)
            details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
            output_dataset_name = _clean_name(details_tab.get("output type")) or dfm_name
            _report_progress(
                progress_callback,
                event="method",
                kind="dfm",
                name=output_dataset_name,
                dataset_name=output_dataset_name,
                method_name=dfm_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or 0),
                message=f"Finalizing dataset: {output_dataset_name}",
            )
            _debug_log(
                "dfm_export_payload",
                project_name=PROJECT_NAME,
                reserving_class=rc_path,
                method_name=payload.get("details tab", {}).get("name") if isinstance(payload.get("details tab"), dict) else dfm_name,
                input_triangle=payload.get("details tab", {}).get("input triangle") if isinstance(payload.get("details tab"), dict) else "",
                origin_length=payload.get("details tab", {}).get("origin length") if isinstance(payload.get("details tab"), dict) else "",
                development_length=payload.get("details tab", {}).get("development length") if isinstance(payload.get("details tab"), dict) else "",
                input_csv_path=payload.get("data tab", {}).get("input data triangle csv path") if isinstance(payload.get("data tab"), dict) else "",
            )
            _warn_if_dfm_input_sidecar_missing(payload, verbose=verbose)
            ultimate_payload = export_dfm_ultimate_vector(
                dfm,
                payload["data tab"]["origin labels"],
                payload["details tab"]["origin length"],
                payload["details tab"]["development length"],
            )
            ultimate_csv_path = write_dfm_ultimate_vector_export(ultimate_payload, rc_path, rc_dir)
            existing_payload = _safe_read_json(out_path)
            payload, preserved = _preserve_local_dfm_data(payload, existing_payload)
            _write_json(out_path, payload)

            suffix = f" (preserved {', '.join(sorted(preserved))})" if preserved else ""
            _log(verbose, f"    OK  {_clean_name(ultimate_csv_path.name)}")
            detail = f"    OK  {file_name}{suffix}"
            _log(verbose, detail)
            if methods_increment_progress:
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="method",
                kind="dfm",
                name=output_dataset_name or dfm_name,
                dataset_name=output_dataset_name or dfm_name,
                method_name=dfm_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or 0),
                status="success",
                message=detail.strip(),
            )
            written += 1
        except Exception as exc:
            detail = f"    ERR {dfm_name}: {exc}"
            _log(verbose, detail)
            if verbose:
                traceback.print_exc(file=sys.stdout)
            if methods_increment_progress:
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
            _report_progress(
                progress_callback,
                event="method",
                kind="dfm",
                name=output_dataset_name or dfm_name,
                dataset_name=output_dataset_name or dfm_name,
                method_name=dfm_name,
                completed=int(progress_state.get("completed") or 0),
                total=int(progress_state.get("total") or 0),
                status="error",
                message=detail.strip(),
            )
            errors += 1

    return written, errors


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export ResQ triangles, vectors, Result Selections, and/or DFM methods to ArcRho dataset files.")
    parser.add_argument(
        "--export",
        choices=("configured", "all", "triangles", "vectors", "vector", "dfm", "dfms"),
        default="configured",
        help="Export phase to run. 'configured' uses EXPORT_TRIANGLES/EXPORT_VECTORS/EXPORT_DFMS constants.",
    )
    parser.add_argument(
        "--cleanup-target",
        dest="cleanup_target",
        action="store_true",
        default=CLEAN_TARGET_RC,
        help="Clean the target reserving-class data folder before export. Enabled by default.",
    )
    parser.add_argument(
        "--no-cleanup-target",
        dest="cleanup_target",
        action="store_false",
        help="Preserve existing files in the target reserving-class data folder before export.",
    )
    return parser.parse_args(argv)


def _selected_exports(export_mode: str) -> tuple[bool, bool, bool]:
    if export_mode == "all":
        return True, True, True
    if export_mode == "triangles":
        return True, False, False
    if export_mode in {"vector", "vectors"}:
        return False, True, False
    if export_mode in {"dfm", "dfms"}:
        return False, False, True
    return bool(EXPORT_TRIANGLES), bool(EXPORT_VECTORS), bool(EXPORT_DFMS)


def _apply_runtime_scope(project_name: str, server_root: str | Path | None = None) -> tuple[Path, str, Path]:
    global SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR

    previous = (SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR)
    clean_project_name = str(project_name or "").strip()
    if not clean_project_name:
        raise ValueError("project_name is required.")
    if server_root is not None:
        SERVER_ROOT = Path(server_root).expanduser().resolve()
    PROJECT_NAME = clean_project_name
    PROJECT_DATA_DIR = SERVER_ROOT / "projects" / PROJECT_NAME / "data"
    return previous


def _restore_runtime_scope(previous: tuple[Path, str, Path]) -> None:
    global SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR

    SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR = previous


def import_reserving_class_from_resq(
    project_name: str,
    rc_path: str,
    *,
    server_root: str | Path | None = None,
    export_mode: str = "configured",
    cleanup_target: bool | None = None,
    connection_name: str = CONNECTION_NAME,
    user_name: str = USER_NAME,
    password: str = PASSWORD,
    progress_callback: ProgressCallback | None = None,
    verbose: bool = True,
) -> dict:
    """Import one ResQ reserving class into ArcRho using caller-provided UI context."""

    previous_scope = _apply_runtime_scope(project_name, server_root)
    try:
        rc_path = str(rc_path or "").strip()
        if not rc_path:
            raise ValueError("rc_path is required.")
        run_triangles, run_vectors, run_dfms = _selected_exports(str(export_mode or "configured"))
        should_cleanup = CLEAN_TARGET_RC if cleanup_target is None else bool(cleanup_target)
        try:
            import win32com.client
        except ImportError as exc:
            raise RuntimeError("pywin32 is required: pip install pywin32") from exc

        _report_progress(
            progress_callback,
            event="connect",
            completed=0,
            total=0,
            message=f"Connecting to ResQ: {connection_name}",
        )
        _log(verbose, f"Connecting to ResQ: {connection_name}")
        ResQApp = win32com.client.Dispatch("ResQ3Automation.ResQApplication")
        try:
            ResQApp.ConnectByName(connection_name, user_name, password)
        except Exception as exc:
            raise RuntimeError(f"Could not connect to ResQ COM API ({connection_name}): {exc}") from exc
        _report_progress(progress_callback, event="connect", completed=0, total=0, message="Connected to ResQ.")
        _log(verbose, "Connected.\n")

        counts = {
            "triangles_written": 0,
            "vectors_written": 0,
            "dfms_written": 0,
            "errors": 0,
        }

        try:
            project = ResQApp.Projects().Item(PROJECT_NAME)
            _log(verbose, f"Project: {PROJECT_NAME}")
            PROJECT_DATA_DIR.mkdir(parents=True, exist_ok=True)

            rc_folder = _encode_rc_folder(rc_path)
            rc_dir = PROJECT_DATA_DIR / rc_folder

            reserving_class = project.ReservingClasses().Item(rc_path)
            dataset_counts = resq_export_dataset_counts(
                reserving_class,
                run_triangles=run_triangles,
                run_vectors=run_vectors,
                run_dfms=run_dfms,
            )
            method_only_progress = bool(run_dfms and not run_triangles and not run_vectors)
            progress_total = int(dataset_counts.get("dfms") or 0) if method_only_progress else int(dataset_counts.get("total") or 0)
            progress_state = {
                "completed": 0,
                "total": progress_total,
                "count_methods": method_only_progress,
            }
            total_message = (
                f"Found {progress_state['total']} DFM method(s)."
                if method_only_progress
                else (
                    f"Found {progress_state['total']} dataset(s) "
                    f"({dataset_counts.get('triangles', 0)} triangle(s), "
                    f"{dataset_counts.get('vectors', 0)} vector(s))."
                )
            )
            _report_progress(
                progress_callback,
                event="total",
                completed=0,
                total=progress_state["total"],
                triangles=dataset_counts.get("triangles", 0),
                vectors=dataset_counts.get("vectors", 0),
                dfms=dataset_counts.get("dfms", 0),
                methods=dataset_counts.get("methods", 0),
                message=total_message,
            )
            _log(verbose, f"RC: {rc_path}")
            _log(verbose, f"Export mode: {export_mode} (triangles={run_triangles}, vectors={run_vectors}, dfm={run_dfms})")
            if should_cleanup:
                cleaned_files, cleaned_dirs = cleanup_target_reserving_class_dir(rc_dir)
                _log(verbose, f"    OK  cleaned target RC folder ({cleaned_files} files, {cleaned_dirs} folders)")
            else:
                _log(verbose, "    SKIP target RC folder cleanup")
            rc_dir.mkdir(parents=True, exist_ok=True)
            (rc_dir / DATASET_CACHE_DIR).mkdir(parents=True, exist_ok=True)
            (rc_dir / METHOD_DATA_DIR).mkdir(parents=True, exist_ok=True)
            (rc_dir / DATASET_SIDECAR_DIR).mkdir(parents=True, exist_ok=True)

            rc_written = 0

            if run_triangles:
                written, errors = export_triangles_for_rc(
                    reserving_class,
                    rc_path,
                    rc_dir,
                    progress_callback=progress_callback,
                    progress_state=progress_state,
                    triangle_names=dataset_counts.get("triangle_names") if isinstance(dataset_counts.get("triangle_names"), list) else None,
                    verbose=verbose,
                )
                rc_written += written
                counts["triangles_written"] += written
                counts["errors"] += errors

            if run_vectors:
                written, errors = export_vectors_for_rc(
                    reserving_class,
                    rc_path,
                    rc_dir,
                    progress_callback=progress_callback,
                    progress_state=progress_state,
                    vector_names=dataset_counts.get("vector_names") if isinstance(dataset_counts.get("vector_names"), list) else None,
                    include_dfm_methods=run_dfms,
                    dfm_names=dataset_counts.get("dfm_names") if isinstance(dataset_counts.get("dfm_names"), list) else None,
                    method_counts=counts,
                    verbose=verbose,
                )
                rc_written += written
                counts["vectors_written"] += written
                counts["errors"] += errors

            if run_dfms and not run_vectors:
                written, errors = export_dfms_for_rc(
                    reserving_class,
                    rc_path,
                    rc_dir,
                    progress_callback=progress_callback,
                    progress_state=progress_state,
                    dfm_names=dataset_counts.get("dfm_names") if isinstance(dataset_counts.get("dfm_names"), list) else None,
                    verbose=verbose,
                )
                rc_written += written
                counts["dfms_written"] += written
                counts["errors"] += errors

            if rc_written:
                refreshed = refresh_sidecar_graphs_for_rc(rc_dir)
                if refreshed:
                    _log(verbose, f"    OK  refreshed sidecar graph metadata ({refreshed} files)")
                rebuild_dataset_instance_index(PROJECT_NAME, rc_path, rc_dir)

            datasets_written = counts["triangles_written"] + counts["vectors_written"]
            total_written = datasets_written + counts["dfms_written"]
            result = {
                "project_name": PROJECT_NAME,
                "reserving_class": rc_path,
                "rc_dir": str(rc_dir),
                "datasets_imported": datasets_written,
                "total_written": total_written,
                "datasets_total": progress_state["total"],
                "triangles_total": dataset_counts.get("triangles", 0),
                "vectors_total": dataset_counts.get("vectors", 0),
                "dfms_total": dataset_counts.get("dfms", 0),
                "methods_total": dataset_counts.get("methods", 0),
                "grand_total": progress_state["total"],
                **counts,
            }
            _report_progress(
                progress_callback,
                event="complete",
                completed=progress_state["completed"],
                total=progress_state["total"],
                status="error" if counts["errors"] else "success",
                message=f"Finished - written: {total_written}, errors: {counts['errors']}",
            )
            _log(verbose, f"\nFinished - written: {total_written}, errors: {counts['errors']}")
            return result
        finally:
            try:
                ResQApp.Disconnect()
            except Exception:
                pass
    finally:
        _restore_runtime_scope(previous_scope)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    run_triangles, run_vectors, run_dfms = _selected_exports(args.export)
    try:
        import win32com.client
    except ImportError:
        sys.exit("pywin32 is required: pip install pywin32")

    print(f"Connecting to ResQ: {CONNECTION_NAME}")
    ResQApp = win32com.client.Dispatch("ResQ3Automation.ResQApplication")
    ResQApp.ConnectByName(CONNECTION_NAME, USER_NAME, PASSWORD)
    print("Connected.\n")

    total_written = total_errors = 0

    try:
        project = ResQApp.Projects().Item(PROJECT_NAME)
        print(f"Project: {PROJECT_NAME}")
        PROJECT_DATA_DIR.mkdir(parents=True, exist_ok=True)

        rc_paths = _configured_rc_paths(RC_PATH)
        if not rc_paths:
            sys.exit("No reserving-class paths configured in RC_PATH.")
        print(f"Reserving classes: {len(rc_paths)}")

        for rc_index, rc_path in enumerate(rc_paths, start=1):
            rc_folder = _encode_rc_folder(rc_path)
            rc_dir = PROJECT_DATA_DIR / rc_folder

            reserving_class = project.ReservingClasses().Item(rc_path)
            print(f"\nRC {rc_index}/{len(rc_paths)}: {rc_path}")
            print(f"Export mode: {args.export} (triangles={run_triangles}, vectors={run_vectors}, dfm={run_dfms})")
            if args.cleanup_target:
                cleaned_files, cleaned_dirs = cleanup_target_reserving_class_dir(rc_dir)
                print(f"    OK  cleaned target RC folder ({cleaned_files} files, {cleaned_dirs} folders)")
            else:
                print("    SKIP target RC folder cleanup (--no-cleanup-target)")
            rc_dir.mkdir(parents=True, exist_ok=True)
            (rc_dir / DATASET_CACHE_DIR).mkdir(parents=True, exist_ok=True)
            (rc_dir / METHOD_DATA_DIR).mkdir(parents=True, exist_ok=True)
            (rc_dir / DATASET_SIDECAR_DIR).mkdir(parents=True, exist_ok=True)

            rc_written = 0

            if run_triangles:
                written, errors = export_triangles_for_rc(reserving_class, rc_path, rc_dir)
                rc_written += written
                total_written += written
                total_errors += errors

            if run_vectors:
                method_counts = {"dfms_written": 0}
                written, errors = export_vectors_for_rc(
                    reserving_class,
                    rc_path,
                    rc_dir,
                    include_dfm_methods=run_dfms,
                    method_counts=method_counts,
                )
                rc_written += written
                total_written += written + int(method_counts.get("dfms_written") or 0)
                total_errors += errors

            if run_dfms and not run_vectors:
                written, errors = export_dfms_for_rc(reserving_class, rc_path, rc_dir)
                rc_written += written
                total_written += written
                total_errors += errors

            if rc_written:
                refreshed = refresh_sidecar_graphs_for_rc(rc_dir)
                if refreshed:
                    print(f"    OK  refreshed sidecar graph metadata ({refreshed} files)")
                rebuild_dataset_instance_index(PROJECT_NAME, rc_path, rc_dir)

    finally:
        ResQApp.Disconnect()
        print(f"\nFinished — written: {total_written}, errors: {total_errors}")


if __name__ == "__main__":
    main()
