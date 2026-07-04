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
import json
import re
import shutil
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

_MIGRATION_DIR = Path(__file__).resolve().parent
if str(_MIGRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_MIGRATION_DIR))

from resq_migration.catalog import (  # noqa: E402
    _dataset_type_keys,
    _is_known_dataset_type,
    _unknown_dataset_type_skip_detail,
    configure_catalog,
    rebuild_dataset_instance_index,
    refresh_sidecar_graphs_for_rc,
)
from resq_migration.core import (  # noqa: E402
    DATASET_CACHE_DIR,
    DATASET_SIDECAR_DIR,
    METHOD_TYPE_DFM_CODE,
    METHOD_TYPE_RESULT_SELECTION_CODE,
    _cached_dataset_names_from_file,
    _clean_name,
    _dataset_cache_csv_file_name,
    _encode_rc_folder,
    _normalize_cached_dataset_name,
    _normalize_import_name,
    _safe_attr,
    _safe_int_attr,
    _method_type_name,
    _triangle_source_kind,
    _vector_cache_csv_file_name,
)
from resq_migration.dfm import (  # noqa: E402
    configure_dfm,
    dfm_methods_by_output_name as _dfm_methods_by_output_name,
    export_dfm_output_dataset as _export_dfm_output_dataset,
)
from resq_migration.extractors import (  # noqa: E402
    _apply_result_selection_vector_metadata,
    _find_result_selection_for_vector,
    _result_selection_source_payload,
    configure_extractors,
    export_result_selection,
    export_triangle,
    export_vector,
    write_result_selection_export,
    write_triangle_export,
    write_vector_export,
)


def _configured_rc_paths(value: object) -> list[str]:
    raw = value if isinstance(value, (list, tuple, set)) else [value]
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = _normalize_import_name(item)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out

# ── Configuration ──────────────────────────────────────────────────────────────
# PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
PROJECT_NAME = "NJ_Annual_Prod_2026 Q2-May"
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
INDEX_VERSION = 15
METHOD_DATA_DIR = "methods"
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

ProgressCallback = Callable[[dict], None]


def _configure_migration_modules() -> None:
    configure_catalog(
        server_root=SERVER_ROOT,
        project_name=PROJECT_NAME,
        rs_json_format=RS_JSON_FORMAT,
        method_data_dir=METHOD_DATA_DIR,
        index_file_name=INDEX_FILE_NAME,
        index_version=INDEX_VERSION,
    )
    configure_extractors(
        project_name=PROJECT_NAME,
        rs_json_format=RS_JSON_FORMAT,
        method_data_dir=METHOD_DATA_DIR,
    )
    configure_dfm(dfm_json_format=DFM_JSON_FORMAT)


_configure_migration_modules()


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


# ── Path / filename encoding ───────────────────────────────────────────────────

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
    for item in list(target.iterdir()):
        if item.is_dir() and not item.is_symlink():
            shutil.rmtree(item)
        else:
            item.unlink()
    return files, dirs


def _normalized_name_keys(values: object) -> set[str]:
    raw = values if isinstance(values, (list, tuple, set)) else [values]
    out: set[str] = set()
    for value in raw:
        text = _normalize_import_name(value)
        if text:
            out.add(text.casefold())
    return out


def _matches_cleanup_names(values: object, target_keys: set[str]) -> bool:
    if not target_keys:
        return False
    return bool(_normalized_name_keys(values) & target_keys)


def _method_file_names(path: Path) -> set[str]:
    stem = path.stem
    for prefix in ("DFM@", "RS@"):
        if stem.startswith(prefix):
            name = _normalize_cached_dataset_name(stem[len(prefix):])
            return {name} if name else set()
    return set()


def _method_payload_dataset_names(path: Path) -> set[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    if not isinstance(payload, dict):
        return set()

    names: set[str] = set()
    if path.name.startswith("DFM@"):
        details = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
        for key in ("output dataset", "output vector", "output type"):
            name = _normalize_import_name(details.get(key))
            if name:
                names.add(name)
    elif path.name.startswith("RS@"):
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
        for key in ("name", "output_type"):
            name = _normalize_import_name(details.get(key))
            if name:
                names.add(name)
    return names


def cleanup_target_dataset_artifacts(
    rc_dir: Path,
    *,
    dataset_names: list[str] | tuple[str, ...] | set[str] | None = None,
    method_names: list[str] | tuple[str, ...] | set[str] | None = None,
) -> tuple[int, int]:
    """Remove stale cached files for selected datasets/methods before single-item export."""
    target = _require_safe_target_rc_dir(rc_dir)
    if not target.exists():
        return 0, 0
    if target.is_symlink():
        raise ValueError(f"Refusing to clean symlinked reserving-class folder: {target}")

    dataset_keys = _normalized_name_keys(dataset_names or [])
    method_keys = _normalized_name_keys(method_names or [])
    files = 0

    dataset_dir = target / DATASET_CACHE_DIR
    if dataset_dir.is_dir():
        for path in sorted(dataset_dir.glob("*.csv"), key=lambda item: item.name.lower()):
            if _matches_cleanup_names(_cached_dataset_names_from_file(path.name), dataset_keys):
                path.unlink()
                files += 1

    sidecar_dir = target / DATASET_SIDECAR_DIR
    if sidecar_dir.is_dir():
        for path in sorted(sidecar_dir.glob("*.json"), key=lambda item: item.name.lower()):
            if _matches_cleanup_names(_cached_dataset_names_from_file(path.name), dataset_keys):
                path.unlink()
                files += 1

    method_dir = target / METHOD_DATA_DIR
    if method_dir.is_dir():
        for path in sorted(method_dir.glob("*.json"), key=lambda item: item.name.lower()):
            method_file_names = _method_file_names(path)
            if (
                _matches_cleanup_names(method_file_names, method_keys)
                or _matches_cleanup_names(method_file_names, dataset_keys)
                or _matches_cleanup_names(_method_payload_dataset_names(path), dataset_keys)
            ):
                path.unlink()
                files += 1

    return files, 0


# ── Development-label helpers ──────────────────────────────────────────────────

# ── Cell-notes parsing ─────────────────────────────────────────────────────────

# ── Core extraction ────────────────────────────────────────────────────────────

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


def _record_skipped(progress_state: dict) -> None:
    progress_state["skipped"] = int(progress_state.get("skipped") or 0) + 1


def _record_error_detail(progress_state: dict, *, kind: str, name: str, detail: str) -> None:
    details = progress_state.setdefault("error_details", [])
    if isinstance(details, list) and len(details) < 12:
        details.append({
            "kind": kind,
            "name": name,
            "message": detail,
        })


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
        return [_clean_name(name) for name in DFM_NAMES if _clean_name(name)]
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
    known_dataset_type_keys = _dataset_type_keys()
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
            dataset_type_obj = _safe_attr(triangle, "DatasetType", None)
            dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", ""))
            if not _is_known_dataset_type(dataset_type, known_dataset_type_keys):
                detail = _unknown_dataset_type_skip_detail("triangle", triangle_name, dataset_type)
                _log(verbose, detail)
                _record_skipped(progress_state)
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
                _report_progress(
                    progress_callback,
                    event="finish",
                    kind="triangle",
                    name=triangle_name,
                    completed=int(progress_state.get("completed") or 0),
                    total=int(progress_state.get("total") or len(triangle_names)),
                    status="skipped",
                    message=detail.strip(),
                )
                continue
            payload = export_triangle(triangle)
            if not _is_known_dataset_type(payload.get("dataset_type"), known_dataset_type_keys):
                detail = _unknown_dataset_type_skip_detail("triangle", payload.get("name") or triangle_name, payload.get("dataset_type"))
                _log(verbose, detail)
                _record_skipped(progress_state)
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
                _report_progress(
                    progress_callback,
                    event="finish",
                    kind="triangle",
                    name=payload.get("name") or triangle_name,
                    completed=int(progress_state.get("completed") or 0),
                    total=int(progress_state.get("total") or len(triangle_names)),
                    status="skipped",
                    message=detail.strip(),
                )
                continue
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
            _record_error_detail(progress_state, kind="triangle", name=triangle_name, detail=str(exc))
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
    known_dataset_type_keys = _dataset_type_keys()
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
            dfm_entry = dfm_by_output.get(_normalize_import_name(vector_name).lower()) if method_type == METHOD_TYPE_DFM_CODE else None
            if dfm_entry is not None:
                dfm_name, dfm = dfm_entry
                output_dataset_name, detail, skipped = _export_dfm_output_dataset(
                    dfm,
                    rc_path,
                    rc_dir,
                    project_name=PROJECT_NAME,
                    project_data_dir=PROJECT_DATA_DIR,
                    method_data_dir=METHOD_DATA_DIR,
                    debug_log=_debug_log,
                    log=_log,
                    known_dataset_type_keys=known_dataset_type_keys,
                    max_average_formula_probe=MAX_AVERAGE_FORMULA_PROBE,
                    verbose=verbose,
                )
                if skipped:
                    _record_skipped(progress_state)
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
                        status="skipped",
                        message=detail.strip(),
                    )
                    continue
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

            dataset_type_obj = _safe_attr(vector, "DatasetType", None)
            dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or vector_name
            if not _is_known_dataset_type(dataset_type, known_dataset_type_keys):
                detail = _unknown_dataset_type_skip_detail("vector", vector_name, dataset_type)
                _log(verbose, detail)
                _record_skipped(progress_state)
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
                _report_progress(
                    progress_callback,
                    event="finish",
                    kind="vector",
                    name=vector_name,
                    completed=int(progress_state.get("completed") or 0),
                    total=int(progress_state.get("total") or len(vector_names)),
                    status="skipped",
                    message=detail.strip(),
                )
                continue
            result_selection_payload = None
            if method_type == METHOD_TYPE_RESULT_SELECTION_CODE:
                result_selection = _find_result_selection_for_vector(reserving_class, vector_name)
                if result_selection is None:
                    _log(verbose, f"    WARN result selection method not found for vector {vector_name}; exporting vector only")
                else:
                    result_selection_payload = export_result_selection(result_selection)
            payload = export_vector(vector)
            if not _is_known_dataset_type(payload.get("dataset_type"), known_dataset_type_keys):
                detail = _unknown_dataset_type_skip_detail("vector", payload.get("name") or vector_name, payload.get("dataset_type"))
                _log(verbose, detail)
                _record_skipped(progress_state)
                progress_state["completed"] = int(progress_state.get("completed") or 0) + 1
                _report_progress(
                    progress_callback,
                    event="finish",
                    kind="vector",
                    name=payload.get("name") or vector_name,
                    completed=int(progress_state.get("completed") or 0),
                    total=int(progress_state.get("total") or len(vector_names)),
                    status="skipped",
                    message=detail.strip(),
                )
                continue
            if result_selection_payload:
                _apply_result_selection_vector_metadata(payload, result_selection_payload)
            write_vector_export(payload, rc_path, rc_dir)
            detail = (
                f"    OK  {_method_type_name(method_type)} vector "
                f"{_vector_cache_csv_file_name(payload['name'], payload['origin_length'])}"
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
            _record_error_detail(progress_state, kind="vector", name=vector_name, detail=str(exc))
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


# Main

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
    known_dataset_type_keys = _dataset_type_keys()
    for dfm_name in dfm_names:
        output_dataset_name = ""
        try:
            dfm = dfm_collection.Item(dfm_name)
            output_dataset_name, detail, skipped = _export_dfm_output_dataset(
                dfm,
                rc_path,
                rc_dir,
                project_name=PROJECT_NAME,
                project_data_dir=PROJECT_DATA_DIR,
                method_data_dir=METHOD_DATA_DIR,
                debug_log=_debug_log,
                log=_log,
                known_dataset_type_keys=known_dataset_type_keys,
                max_average_formula_probe=MAX_AVERAGE_FORMULA_PROBE,
                verbose=verbose,
            )
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
                status="skipped" if skipped else "success",
                message=detail.strip(),
            )
            if skipped:
                _record_skipped(progress_state)
                continue
            written += 1
        except Exception as exc:
            detail = f"    ERR {dfm_name}: {exc}"
            _log(verbose, detail)
            if verbose:
                traceback.print_exc(file=sys.stdout)
            _record_error_detail(progress_state, kind="dfm", name=dfm_name, detail=str(exc))
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
    _configure_migration_modules()
    return previous


def _restore_runtime_scope(previous: tuple[Path, str, Path]) -> None:
    global SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR

    SERVER_ROOT, PROJECT_NAME, PROJECT_DATA_DIR = previous
    _configure_migration_modules()


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
                "skipped": 0,
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
            skipped = int(progress_state.get("skipped") or 0)
            result = {
                "project_name": PROJECT_NAME,
                "reserving_class": rc_path,
                "rc_dir": str(rc_dir),
                "datasets_imported": datasets_written,
                "total_written": total_written,
                "skipped": skipped,
                "datasets_total": progress_state["total"],
                "triangles_total": dataset_counts.get("triangles", 0),
                "vectors_total": dataset_counts.get("vectors", 0),
                "dfms_total": dataset_counts.get("dfms", 0),
                "methods_total": dataset_counts.get("methods", 0),
                "grand_total": progress_state["total"],
                "error_details": progress_state.get("error_details", []),
                **counts,
            }
            _report_progress(
                progress_callback,
                event="complete",
                completed=progress_state["completed"],
                total=progress_state["total"],
                status="error" if counts["errors"] else "success",
                message=f"Finished - written: {total_written}, skipped: {skipped}, errors: {counts['errors']}",
            )
            _log(verbose, f"\nFinished - written: {total_written}, skipped: {skipped}, errors: {counts['errors']}")
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
