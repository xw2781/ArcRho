from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from .core import (
    DATASET_CACHE_DIR,
    DATASET_SIDECAR_DIR,
    _add_cached_dataset_name,
    _bool_value,
    _cached_dataset_names_from_file,
    _clean_name,
    _dataset_sidecar_path_for_cached_csv,
    _has_legacy_length_only_suffix,
    _is_result_selection_method_type,
    _normalize_cached_dataset_name,
    _safe_read_json,
    _write_json,
)


SERVER_ROOT = Path(r"E:\ArcRho Server")
PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1"
INDEX_FILE_NAME = "index.json"
INDEX_VERSION = 15
METHOD_DATA_DIR = "methods"


def configure_catalog(
    *,
    server_root: str | Path,
    project_name: str,
    rs_json_format: str,
    method_data_dir: str,
    index_file_name: str = "index.json",
    index_version: int = 15,
) -> None:
    global SERVER_ROOT, PROJECT_NAME, RS_JSON_FORMAT, METHOD_DATA_DIR, INDEX_FILE_NAME, INDEX_VERSION

    SERVER_ROOT = Path(server_root)
    PROJECT_NAME = str(project_name)
    RS_JSON_FORMAT = str(rs_json_format)
    METHOD_DATA_DIR = str(method_data_dir)
    INDEX_FILE_NAME = str(index_file_name)
    INDEX_VERSION = int(index_version)


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

def _dataset_type_lookup_key(value: object) -> str:
    return _canon_dataset_name(_normalize_cached_dataset_name(value))

def _dataset_type_keys(rows: list[dict] | None = None) -> set[str]:
    dataset_type_rows = _dataset_type_rows() if rows is None else rows
    return {
        _dataset_type_lookup_key(row.get("name"))
        for row in dataset_type_rows
        if _dataset_type_lookup_key(row.get("name"))
    }

def _is_known_dataset_type(dataset_type_name: object, known_keys: set[str] | None = None) -> bool:
    key = _dataset_type_lookup_key(dataset_type_name)
    if not key:
        return False
    return key in (_dataset_type_keys() if known_keys is None else known_keys)

def _dataset_type_row(dataset_type_name: object, rows: list[dict] | None = None) -> dict | None:
    key = _dataset_type_lookup_key(dataset_type_name)
    if not key:
        return None
    for row in (_dataset_type_rows() if rows is None else rows):
        if _dataset_type_lookup_key(row.get("name")) == key:
            return row
    return None

def _is_generated_dataset_type(dataset_type_name: object, rows: list[dict] | None = None) -> bool:
    row = _dataset_type_row(dataset_type_name, rows)
    return bool(row and row.get("generated"))

def _unknown_dataset_type_skip_detail(kind: str, name: object, dataset_type_name: object) -> str:
    display_type = _clean_name(dataset_type_name) or "<blank>"
    return f"    SKIP {kind} {_clean_name(name) or '<unnamed>'}: dataset type {display_type!r} not found in dataset_types.json"

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

def _rc_existing_dataset_keys(rc_dir: Path | None) -> set[str] | None:
    if rc_dir is None or not rc_dir.is_dir():
        return None
    keys: set[str] = set()
    for item in _scan_physical_dataset_files(rc_dir):
        names: set[str] = set()
        _add_cached_dataset_name(names, item.get("dataset_name"))
        _add_cached_dataset_name(names, item.get("dataset_type"))
        for value in item.get("dataset_names") or []:
            _add_cached_dataset_name(names, value)
        for name in names:
            key = _canon_dataset_name(name)
            if key:
                keys.add(key)
    return keys

def _filter_existing_dependents(names: list[str], existing_dataset_keys: set[str] | None) -> list[str]:
    if existing_dataset_keys is None:
        return names
    return [
        name
        for name in names
        if _canon_dataset_name(name) in existing_dataset_keys
    ]

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


def _entry_names(entries: object) -> list[str]:
    if not isinstance(entries, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in entries:
        if isinstance(item, dict):
            name = _clean_name(item.get("dataset_type_name") or item.get("dataset_name") or item.get("name"))
        else:
            name = _clean_name(item)
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


def _merge_dependency_entries(existing: object, additions: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for item in (existing if isinstance(existing, list) else []):
        if isinstance(item, dict):
            name = _clean_name(item.get("dataset_type_name") or item.get("dataset_name") or item.get("name"))
            entry = dict(item)
            if name and not _clean_name(entry.get("dataset_type_name")):
                entry["dataset_type_name"] = name
        else:
            name = _clean_name(item)
            entry = {"dataset_type_name": name}
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(entry)
    for item in additions:
        name = _clean_name(item.get("dataset_type_name") or item.get("dataset_name") or item.get("name"))
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(dict(item))
    return out


def _dataset_type_graph_fields(
    dataset_type_name: str,
    rc_dir: Path | None = None,
    *,
    existing_dataset_keys: set[str] | None = None,
) -> dict:
    rows = _dataset_type_rows()
    rows_by_key = _dataset_type_rows_by_key(rows)
    rc_dataset_keys = _rc_existing_dataset_keys(rc_dir) if existing_dataset_keys is None else existing_dataset_keys
    precedents = [
        _dependency_entry(name, rows_by_key, rc_dir)
        for name in _direct_precedent_names(rows, dataset_type_name)
    ]
    dependents = [
        _dependency_entry(name, rows_by_key, rc_dir, include_formula=True)
        for name in _filter_existing_dependents(
            _direct_dependent_names(rows, dataset_type_name),
            rc_dataset_keys,
        )
    ]
    return {"Precedents": precedents, "Dependents": dependents}


def _apply_sidecar_graph_meta(
    meta: dict,
    dataset_type_name: str,
    rc_dir: Path | None = None,
    *,
    preserve_precedents: bool = False,
    existing_dataset_keys: set[str] | None = None,
) -> None:
    fields = _dataset_type_graph_fields(dataset_type_name, rc_dir, existing_dataset_keys=existing_dataset_keys)
    if preserve_precedents:
        meta["Dependents"] = fields["Dependents"]
    else:
        meta.update(fields)
    meta.pop("dependencies", None)


def _reconcile_sidecar_dependents(sidecars: list[tuple[Path, dict]], rc_dir: Path) -> int:
    rows_by_key = _dataset_type_rows_by_key(_dataset_type_rows())
    by_key: dict[str, tuple[Path, dict]] = {}
    additions_by_key: dict[str, list[dict]] = {}
    for path, meta in sidecars:
        dataset_identity = _clean_name(meta.get("dataset_name") or meta.get("dataset_type") or path.stem)
        dataset_type = _clean_name(meta.get("dataset_type") or dataset_identity)
        dataset_key = _canon_dataset_name(dataset_identity)
        if dataset_key:
            by_key.setdefault(dataset_key, (path, meta))
        type_key = _canon_dataset_name(dataset_type)
        if type_key:
            by_key.setdefault(type_key, (path, meta))
        for precedent_name in _entry_names(meta.get("Precedents")):
            precedent_key = _canon_dataset_name(precedent_name)
            if not precedent_key or not dataset_identity:
                continue
            additions_by_key.setdefault(precedent_key, []).append(
                _dependency_entry(dataset_identity, rows_by_key, rc_dir, include_formula=True)
            )

    updated = 0
    for key, additions in additions_by_key.items():
        target = by_key.get(key)
        if not target:
            continue
        _path, meta = target
        before = json.dumps(meta.get("Dependents"), sort_keys=True, ensure_ascii=False, default=str)
        meta["Dependents"] = _merge_dependency_entries(meta.get("Dependents"), additions)
        after = json.dumps(meta.get("Dependents"), sort_keys=True, ensure_ascii=False, default=str)
        if before != after:
            updated += 1
    return updated


def _sidecar_status_timestamp(path: Path, meta: dict) -> float:
    for key in ("updated_at", "updated", "modified_at", "modified", "last_modified"):
        parsed = _parse_metadata_datetime(meta.get(key))
        if parsed is not None:
            try:
                return parsed.timestamp()
            except Exception:
                pass
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _sidecar_is_method(meta: dict) -> bool:
    source_kind = _clean_name(meta.get("source_kind")).lower()
    if source_kind in {"dfm", "result_selection"}:
        return True
    method_type = _clean_name(meta.get("method_type")).lower().replace("_", " ")
    return method_type in {"dfm", "result selection"}


def _refresh_sidecar_statuses(sidecars: list[tuple[Path, dict]]) -> None:
    by_key: dict[str, tuple[Path, dict]] = {}
    for path, meta in sidecars:
        for name in (
            meta.get("dataset_name"),
            meta.get("dataset_type"),
            path.stem,
        ):
            key = _canon_dataset_name(name)
            if key:
                by_key.setdefault(key, (path, meta))

    for path, meta in sidecars:
        if not _sidecar_is_method(meta):
            continue
        current_ts = _sidecar_status_timestamp(path, meta)
        status = 0
        if current_ts > 0:
            for precedent_name in _entry_names(meta.get("Precedents")):
                source = by_key.get(_canon_dataset_name(precedent_name))
                if not source:
                    continue
                source_path, source_meta = source
                if _sidecar_status_timestamp(source_path, source_meta) > current_ts + 0.000001:
                    status = 2
                    break
        else:
            try:
                status = 2 if int(meta.get("status")) == 2 else 0
            except Exception:
                status = 0
        meta["status"] = status


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
    _add_cached_dataset_name(names, details_tab.get("output dataset") or details_tab.get("output vector") or details_tab.get("output type"))
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


def _category_from_payload(payload: dict) -> str:
    if _clean_name(payload.get("json_format")).lower() == RS_JSON_FORMAT:
        details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
        return _clean_name(details_tab.get("dataset_category") or details_tab.get("output_category"))
    text = _clean_name(payload.get("dataset_category") or payload.get("category"))
    if text:
        return text
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    return _clean_name(details_tab.get("output dataset_category") or details_tab.get("output category"))


def _dataset_type_category(dataset_type_name: object, rows_by_key: dict[str, dict] | None = None) -> str:
    key = _canon_dataset_name(dataset_type_name)
    if not key:
        return ""
    lookup = rows_by_key if rows_by_key is not None else _dataset_type_rows_by_key(_dataset_type_rows())
    row = lookup.get(key)
    return _clean_name(row.get("category")) if row else ""

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
                output_dataset = details_tab.get("output dataset") or details_tab.get("output vector")
                _add_cached_dataset_name(file_names, output_dataset or details_tab.get("output type"))
                method_dataset_name = _normalize_cached_dataset_name(output_dataset)
                method_dataset_type = _normalize_cached_dataset_name(details_tab.get("output type"))
                if not method_dataset_name:
                    method_dataset_name = method_dataset_type
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
            category = _category_from_payload(metadata)
            if not legacy_length_only_name:
                if metadata_dataset_name:
                    file_info["dataset_name"] = metadata_dataset_name
                if dataset_type:
                    file_info["dataset_type"] = dataset_type
            if category:
                file_info["dataset_category"] = category
            file_info["source_kind"] = _clean_name(metadata.get("source_kind"))
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
    dataset_category = _clean_name(source.get("dataset_category") or source.get("category"))
    if dataset_category and not _clean_name(existing.get("dataset_category")):
        existing["dataset_category"] = dataset_category
    source_kind = _clean_name(source.get("source_kind"))
    if source_kind and not _clean_name(existing.get("source_kind")):
        existing["source_kind"] = source_kind
    formula = _clean_name(source.get("formula"))
    if formula:
        existing["formula"] = formula
    for flag in ("calculated",):
        if flag in source and flag not in existing:
            existing[flag] = source.get(flag)
    return existing

def _logical_files_from_physical_files(files: list[dict]) -> list[dict]:
    by_name: dict[str, dict] = {}
    display_names: dict[str, str] = {}
    dataset_type_rows_by_key = _dataset_type_rows_by_key(_dataset_type_rows())
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
        if not _clean_name(item.get("dataset_type")):
            item["dataset_type"] = _clean_name(item.get("name"))
        if not _clean_name(item.get("dataset_category")):
            item["dataset_category"] = _dataset_type_category(item.get("dataset_type"), dataset_type_rows_by_key)
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

def refresh_sidecar_graphs_for_rc(rc_dir: Path) -> int:
    """Refresh formula-derived graph metadata for all dataset sidecars in one RC folder."""
    sidecar_dir = rc_dir / DATASET_SIDECAR_DIR
    if not sidecar_dir.is_dir():
        return 0
    sidecars: list[tuple[Path, dict]] = []
    existing_dataset_keys = _rc_existing_dataset_keys(rc_dir)
    for path in sorted(sidecar_dir.glob("*.json"), key=lambda item: item.name.lower()):
        if path.name.startswith("ArcRhoTriNotes@"):
            continue
        meta = _safe_read_json(path)
        if not meta:
            continue
        dataset_type = _clean_name(meta.get("dataset_type") or meta.get("dataset_name"))
        if not dataset_type:
            continue
        is_result_selection = (
            _clean_name(meta.get("source_kind")).lower() == "result_selection"
            or _is_result_selection_method_type(meta.get("method_type"))
        )
        _apply_sidecar_graph_meta(
            meta,
            dataset_type,
            rc_dir,
            preserve_precedents=is_result_selection,
            existing_dataset_keys=existing_dataset_keys,
        )
        sidecars.append((path, meta))
    _reconcile_sidecar_dependents(sidecars, rc_dir)
    _refresh_sidecar_statuses(sidecars)
    updated = 0
    for path, meta in sidecars:
        before = _safe_read_json(path)
        if json.dumps(before, sort_keys=True, ensure_ascii=False, default=str) == json.dumps(meta, sort_keys=True, ensure_ascii=False, default=str):
            continue
        _write_json(path, meta)
        updated += 1
    return updated
