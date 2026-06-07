"""
resq_data_migration.py

Migrate ResQ triangles and DFM methods to ArcRho dataset files.
Scope: ProjectName = 'NJ_Annual_Prod_202605_Fake'
Output: E:\\ArcRho Server\\projects\\NJ_Annual_Prod_202605_Fake\\data\\manual\\

Run:
  python resq_data_migration.py
  python resq_dfm_export.py --export triangles
  python resq_dfm_export.py --export dfm
  python resq_dfm_export.py --export all
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────
PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
RC_PATH = r"PRNJ - PA\PA\NY\Direct Group\MP+PIP"
# RC_PATH = r"HPPREF\HO+DF\NJ\Legacy\HOL"
CONNECTION_NAME = "JGO_CO1SQLWPV22"
USER_NAME = ""
PASSWORD = ""

SERVER_ROOT = Path(r"E:\ArcRho Server")
PROJECT_DATA_DIR = SERVER_ROOT / "projects" / PROJECT_NAME / "data"
MANUAL_OUTPUT_BASE = PROJECT_DATA_DIR / "manual"
GENERATED_OUTPUT_BASE = PROJECT_DATA_DIR / "generated"
OUTPUT_BASE = MANUAL_OUTPUT_BASE  # Backward-compatible default for DFM/manual outputs.
DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"
DATASET_INSTANCE_INDEX_FILE_NAME = "dataset_instance_index.json"
LEGACY_METHOD_INDEX_FILE_NAME = "method_index.json"

# Stop probing average formula rows after this many consecutive misses
MAX_AVERAGE_FORMULA_PROBE = 30

# Dataset export controls. CLI --export can override these.
EXPORT_DFMS = True
EXPORT_TRIANGLES = True
TRIANGLE_NAMES: list[str] = []  # Empty means export all triangles in RC_PATH
DFM_NAMES: list[str] = []  # Empty means export all DFM methods in RC_PATH


# ── JSON formatting ────────────────────────────────────────────────────────────

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

def _encode_rc_folder(rc_path: str) -> str:
    """Encode a reserving class path (backslashes and slashes) for use as a directory name."""
    return rc_path.replace("\\", "_%5C_").replace("/", "_%2F_")


def _encode_name_part(name: str) -> str:
    """Encode a dataset / method name for use inside a filename."""
    return (
        name
        .replace("\\", "_%5C_")
        .replace("/", "_%2F_")
        .replace(":", "_%3A_")
        .replace("*", "_%2A_")
        .replace("?", "_%3F_")
        .replace('"', "_%22_")
        .replace("<", "_%3C_")
        .replace(">", "_%3E_")
        .replace("|", "_%7C_")
    )


def _dataset_storage(name: str, dataset_type: str) -> str:
    """ArcRho storage rule for migrated ResQ datasets."""
    return "generated" if _clean_name(dataset_type) == _clean_name(name) else "manual"


def _dataset_output_base(name: str, dataset_type: str) -> Path:
    return GENERATED_OUTPUT_BASE if _dataset_storage(name, dataset_type) == "generated" else MANUAL_OUTPUT_BASE


def _csv_abs_path(rc_folder: str, name: str, origin_length: int, dev_length: int, dataset_type: str = "") -> str:
    filename = f"{_encode_name_part(name)}@{origin_length}@{dev_length}.csv"
    return str(_dataset_output_base(name, dataset_type) / rc_folder / filename)


def _csv_file_name(name: str, origin_length: int, dev_length: int) -> str:
    return f"{_encode_name_part(name)}@{origin_length}@{dev_length}.csv"


def _json_sidecar_name(name: str) -> str:
    return f"{_encode_name_part(name)}.json"


def _safe_read_json(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _remove_legacy_dfm_sidecar(path: Path, encoded_name: str) -> None:
    if not path.exists():
        return
    data = _safe_read_json(path)
    if (
        _clean_name(data.get("source")).lower() == "dfm"
        and _clean_name(data.get("dataset_name")) == encoded_name
        and _clean_name(data.get("instance_name")) == encoded_name
    ):
        path.unlink()
        print(f"    OK  removed obsolete DFM metadata sidecar {path.name}")


def _remove_legacy_method_index(rc_dir: Path) -> None:
    index_path = rc_dir / LEGACY_METHOD_INDEX_FILE_NAME
    if index_path.exists():
        index_path.unlink()
        print(f"    OK  removed obsolete {LEGACY_METHOD_INDEX_FILE_NAME}")


def _split_length_scoped_stem(stem: str) -> tuple[str, bool]:
    parts = str(stem or "").split("@")
    if len(parts) >= 3 and parts[-1].strip().isdigit() and parts[-2].strip().isdigit():
        return "@".join(parts[:-2]), True
    if (
        len(parts) >= 5
        and parts[-4].strip().isdigit()
        and parts[-3].strip().isdigit()
        and parts[-2].strip().lower() in {"cum", "inc", "cumulative", "incremental"}
        and parts[-1].strip().lower() in {"dev", "cal", "calendar"}
    ):
        return "@".join(parts[:-4]), True
    return str(stem or ""), False


def _normalize_cached_dataset_name(value: object) -> str:
    text = _clean_name(value)
    stem, _is_length_scoped = _split_length_scoped_stem(text)
    return stem.strip()


def _add_cached_dataset_name(names: set[str], value: object) -> None:
    text = _normalize_cached_dataset_name(value)
    if text:
        names.add(text)


def _dataset_sidecar_path_for_cached_csv(csv_path: Path) -> Path:
    stem = csv_path.stem
    dataset_stem, is_length_scoped = _split_length_scoped_stem(stem)
    if is_length_scoped:
        plain_sidecar = csv_path.with_name(f"{dataset_stem}.json")
        if plain_sidecar.exists():
            return plain_sidecar
    return csv_path.with_suffix(".json")


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
    for key in ("dataset_name", "instance_name"):
        _add_cached_dataset_name(names, payload.get(key))
    if names:
        return names
    for key in ("dataset_type", "dataset_type_name"):
        _add_cached_dataset_name(names, payload.get(key))
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    _add_cached_dataset_name(names, details_tab.get("output type"))
    return names


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


def _is_legacy_dfm_sidecar(payload: dict) -> bool:
    if _clean_name(payload.get("source")).lower() != "dfm":
        return False
    dataset_name = _clean_name(payload.get("dataset_name"))
    instance_name = _clean_name(payload.get("instance_name"))
    return bool(dataset_name and dataset_name == instance_name)


def _scan_physical_dataset_files(folder_path: Path, storage: str) -> list[dict]:
    files: list[dict] = []
    if not folder_path.is_dir():
        return files

    metadata_cache: dict[Path, dict] = {}
    for entry in sorted(folder_path.iterdir(), key=lambda item: item.name.lower()):
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        if ext not in {".csv", ".json"} or entry.name in {DATASET_INSTANCE_INDEX_FILE_NAME, LEGACY_METHOD_INDEX_FILE_NAME}:
            continue

        stat = entry.stat()
        file_names: set[str] = set()
        metadata: dict = {}
        method_type = ""

        if ext == ".csv":
            file_names = _cached_dataset_names_from_file(entry.name)
            metadata_path = _dataset_sidecar_path_for_cached_csv(entry)
            metadata = metadata_cache.setdefault(metadata_path, _safe_read_json(metadata_path))
        else:
            metadata = metadata_cache.setdefault(entry, _safe_read_json(entry))
            if entry.name.startswith("DFM@"):
                details_tab = metadata.get("details tab") if isinstance(metadata.get("details tab"), dict) else {}
                _add_cached_dataset_name(file_names, details_tab.get("output type"))
                method_type = "DFM" if file_names else ""
            elif _is_legacy_dfm_sidecar(metadata):
                continue
            else:
                file_names = _cached_dataset_names_from_payload(metadata) or _cached_dataset_names_from_file(entry.name)

        if metadata and not entry.name.startswith("DFM@"):
            file_names.update(_cached_dataset_names_from_payload(metadata))

        file_info = {
            "physical_name": entry.name,
            "storage": storage,
            "path": str(entry),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "mtime_ns": stat.st_mtime_ns,
            "last_modified": _format_file_timestamp(stat.st_mtime),
            "last_modified_timestamp": stat.st_mtime,
            "created": _format_file_timestamp(stat.st_ctime),
            "created_timestamp": stat.st_ctime,
        }
        if file_names:
            file_info["dataset_names"] = sorted(file_names, key=lambda item: item.lower())
            first_name = file_info["dataset_names"][0]
            file_info["dataset_name"] = first_name
        if metadata:
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
            file_info["metadata_last_modified"] = _metadata_text(metadata, (
                "last_modified",
                "last modified",
                "updated_at",
                "updated",
                "modified_at",
                "modified",
            ))
            file_info["metadata_created"] = _metadata_text(metadata, (
                "created_at",
                "created",
                "creation_time",
            ))
        if method_type:
            file_info["method_type"] = method_type
        files.append(file_info)
    return files


def _file_dataset_names(item: dict) -> set[str]:
    names: set[str] = set()
    for key in ("dataset_name", "instance_name"):
        _add_cached_dataset_name(names, item.get(key))
    for value in item.get("dataset_names") or []:
        _add_cached_dataset_name(names, value)
    return names


def _merge_logical_file(existing: dict, source: dict) -> dict:
    last_modified_ts = _numeric_timestamp(source.get("last_modified_timestamp") or source.get("mtime"))
    if last_modified_ts and last_modified_ts >= _numeric_timestamp(existing.get("last_modified_timestamp")):
        existing["last_modified"] = _clean_name(source.get("last_modified"))
        existing["last_modified_timestamp"] = last_modified_ts
        user = _clean_name(source.get("user"))
        if user:
            existing["user"] = user

    created_ts = _numeric_timestamp(source.get("created_timestamp"))
    existing_created_ts = _numeric_timestamp(existing.get("created_timestamp"))
    if created_ts and (not existing_created_ts or created_ts < existing_created_ts):
        existing["created"] = _clean_name(source.get("created"))
        existing["created_timestamp"] = created_ts

    for target, source_key in (
        ("metadata_last_modified", "metadata_last_modified"),
        ("metadata_created", "metadata_created"),
    ):
        value = _clean_name(source.get(source_key))
        if value and not _clean_name(existing.get(target)):
            existing[target] = value

    method_type = _clean_name(source.get("method_type"))
    if method_type:
        existing["method_type"] = method_type
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
                    "dataset_name": display_names[key],
                    "last_modified": "",
                    "last_modified_timestamp": 0,
                    "created": "",
                    "created_timestamp": 0,
                    "user": "",
                }
                by_name[key] = logical
            _merge_logical_file(logical, item)
    return sorted(by_name.values(), key=lambda item: _clean_name(item.get("dataset_name")).lower())


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
                "storage": _clean_name(item.get("storage")),
                "name": _clean_name(item.get("physical_name")),
                "size": int(item.get("size") or 0),
                "mtime_ns": int(item.get("mtime_ns") or 0),
            }
            for item in sorted(files, key=lambda item: (
                _clean_name(item.get("storage")),
                _clean_name(item.get("physical_name")).lower(),
            ))
        ],
    }
    return json.dumps(source, sort_keys=True, separators=(",", ":"))


def rebuild_dataset_instance_index(project_name: str, rc_path: str, manual_rc_dir: Path, generated_rc_dir: Path) -> Path:
    folder_paths = {
        "generated": str(generated_rc_dir),
        "manual": str(manual_rc_dir),
    }
    physical_files = (
        _scan_physical_dataset_files(generated_rc_dir, "generated")
        + _scan_physical_dataset_files(manual_rc_dir, "manual")
    )
    files = _logical_files_from_physical_files(physical_files)
    dataset_names = sorted(
        {_clean_name(item.get("dataset_name")) for item in files if _clean_name(item.get("dataset_name"))},
        key=lambda item: item.lower(),
    )
    payload = {
        "ok": True,
        "version": 3,
        "exists": bool(generated_rc_dir.is_dir() or manual_rc_dir.is_dir()),
        "project_name": project_name,
        "reserving_class": rc_path,
        "folder_path": str(generated_rc_dir),
        "folder_paths": folder_paths,
        "folder_signature": _cached_folder_signature(physical_files, folder_paths),
        "dataset_names": dataset_names,
        "files": files,
    }

    manual_rc_dir.mkdir(parents=True, exist_ok=True)
    index_path = manual_rc_dir / DATASET_INSTANCE_INDEX_FILE_NAME
    temp_path = index_path.with_name(f"{index_path.name}.tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(_format_json(payload))
        fh.write("\n")
    temp_path.replace(index_path)
    print(f"    OK  {DATASET_INSTANCE_INDEX_FILE_NAME} ({len(files)} entries, version 3)")
    return index_path


# ── Average formula helpers ────────────────────────────────────────────────────

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


def _iso_or_text(value) -> str:
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


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


def write_triangle_export(payload: dict, rc_path: str, rc_dir: Path, storage: str) -> Path:
    name = payload["name"]
    origin_length = int(payload["origin_length"])
    dev_length = int(payload["development_length"])
    csv_name = _csv_file_name(name, origin_length, dev_length)
    csv_path = rc_dir / csv_name
    _write_csv_matrix(csv_path, payload["values"])

    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    meta = {
        "dataset_name": name,
        "dataset_type": payload.get("dataset_type") or name,
        "instance_name": name,
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "storage": storage,
        "source": "resq_triangle",
        "data_format": "Triangle",
        "data_format_code": payload.get("data_format", 0),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 0),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "updated_at": updated_at,
    }
    meta_path = rc_dir / _json_sidecar_name(name)
    with meta_path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(_format_json(meta))
        fh.write("\n")
    return csv_path


def export_triangles_for_rc(
    reserving_class,
    rc_path: str,
    manual_rc_dir: Path,
    generated_rc_dir: Path,
) -> tuple[int, int]:
    """Export triangle datasets for one reserving class. Returns (written, errors)."""
    triangle_collection = reserving_class.Triangles()
    all_triangle_names = [t.Name.strip() for t in triangle_collection]
    triangle_names = [name.strip() for name in TRIANGLE_NAMES] if TRIANGLE_NAMES else all_triangle_names

    print(f"Triangles: {len(triangle_names)}")
    written = errors = 0
    for triangle_name in triangle_names:
        try:
            triangle = triangle_collection.Item(triangle_name)
            payload = export_triangle(triangle)
            storage = _dataset_storage(payload["name"], payload.get("dataset_type", ""))
            rc_dir = generated_rc_dir if storage == "generated" else manual_rc_dir
            write_triangle_export(payload, rc_path, rc_dir, storage)
            print(
                f"    OK  {storage}/"
                f"{_csv_file_name(payload['name'], payload['origin_length'], payload['development_length'])}"
            )
            written += 1
        except Exception as exc:
            print(f"    ERR triangle {triangle_name}: {exc}")
            traceback.print_exc(file=sys.stdout)
            errors += 1
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
    try:
        input_tri_type = _clean_name(dfm.InputTriangle.DatasetType.Name)
    except Exception:
        input_tri_type = input_tri_name
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
        last_modified = modified.isoformat() if hasattr(modified, "isoformat") else str(modified)
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
    input_csv = _csv_abs_path(rc_folder, input_tri_name, origin_length, dev_length, input_tri_type)
    output_csv = _csv_abs_path(rc_folder, name, origin_length, dev_length)

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


# ── Main ───────────────────────────────────────────────────────────────────────

def export_dfms_for_rc(reserving_class, rc_path: str, rc_dir: Path) -> tuple[int, int]:
    """Export DFM method JSON/metadata for one reserving class. Returns (written, errors)."""
    dfm_collection = reserving_class.DFMMethods()
    all_dfm_names = [d.Name.strip() for d in dfm_collection]
    dfm_names = [name.strip() for name in DFM_NAMES] if DFM_NAMES else all_dfm_names

    print(f"DFMs: {len(dfm_names)}")
    written = errors = 0
    for dfm_name in dfm_names:
        file_name = f"DFM@{_encode_name_part(dfm_name)}.json"
        out_path = rc_dir / file_name
        try:
            dfm = dfm_collection.Item(dfm_name)
            payload = export_dfm(dfm, rc_path)
            with out_path.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(_format_json(payload))
                fh.write("\n")

            encoded_name = _encode_name_part(dfm_name)
            _remove_legacy_dfm_sidecar(rc_dir / f"{encoded_name}.json", encoded_name)

            print(f"    OK  {file_name}")
            written += 1
        except Exception as exc:
            print(f"    ERR {dfm_name}: {exc}")
            traceback.print_exc(file=sys.stdout)
            errors += 1

    return written, errors


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export ResQ triangles and/or DFM methods to ArcRho dataset files.")
    parser.add_argument(
        "--export",
        choices=("configured", "all", "triangles", "dfm", "dfms"),
        default="configured",
        help="Export phase to run. 'configured' uses EXPORT_DFMS/EXPORT_TRIANGLES constants.",
    )
    return parser.parse_args(argv)


def _selected_exports(export_mode: str) -> tuple[bool, bool]:
    if export_mode == "all":
        return True, True
    if export_mode == "triangles":
        return True, False
    if export_mode in {"dfm", "dfms"}:
        return False, True
    return bool(EXPORT_TRIANGLES), bool(EXPORT_DFMS)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    run_triangles, run_dfms = _selected_exports(args.export)
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
        MANUAL_OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
        if run_triangles:
            GENERATED_OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

        rc_path = RC_PATH
        rc_folder = _encode_rc_folder(rc_path)
        manual_rc_dir = MANUAL_OUTPUT_BASE / rc_folder
        generated_rc_dir = GENERATED_OUTPUT_BASE / rc_folder

        reserving_class = project.ReservingClasses().Item(rc_path)
        print(f"RC: {rc_path}")
        print(f"Export mode: {args.export} (triangles={run_triangles}, dfm={run_dfms})")
        manual_rc_dir.mkdir(parents=True, exist_ok=True)
        if run_triangles:
            generated_rc_dir.mkdir(parents=True, exist_ok=True)

        rc_written = 0

        if run_triangles:
            written, errors = export_triangles_for_rc(reserving_class, rc_path, manual_rc_dir, generated_rc_dir)
            rc_written += written
            total_written += written
            total_errors += errors

        if run_dfms:
            written, errors = export_dfms_for_rc(reserving_class, rc_path, manual_rc_dir)
            rc_written += written
            total_written += written
            total_errors += errors

        if rc_written:
            _remove_legacy_method_index(manual_rc_dir)
            rebuild_dataset_instance_index(PROJECT_NAME, rc_path, manual_rc_dir, generated_rc_dir)

    finally:
        ResQApp.Disconnect()
        print(f"\nFinished — written: {total_written}, errors: {total_errors}")


if __name__ == "__main__":
    main()
