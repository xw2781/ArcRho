"""Reserving-class scoped dataset instance index cache."""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Dict, Iterable, List, Set, Tuple

from arcrho_api.dataset_index_contract import (
    RS_JSON_FORMAT,
    BF_JSON_FORMAT,
    BST_JSON_FORMAT,
    CC_JSON_FORMAT,
    DATASET_INDEX_VERSION,
    INDEX_FILE_NAME as DATASET_INDEX_FILE_NAME,
    build_dataset_index_payload,
    canonical_existing_directory,
    decode_filename_segment,
    index_update_lock,
    index_rebuild_reason,
    scan_folder_signature,
    write_index_json_unlocked,
)
from fastapi import HTTPException

from app_server import config
from app_server.helpers import _canon_dataset_name, sanitize_dataset_file_name
from app_server.services import (
    dataset_sidecar_status_service,
    runtime_cache_provenance_service,
)

# Machine-readable reason on the 409 a delete raises when the target is still
# some other object's input. The Project Instance delete flow switches on this
# code to show the dependents window instead of a plain error line.
DELETE_BLOCKED_BY_DEPENDENTS = "dataset_has_dependents"

INDEX_FILE_NAME = DATASET_INDEX_FILE_NAME
INDEX_VERSION = DATASET_INDEX_VERSION
DFM_METHOD_TYPE = "DFM"
RESULT_SELECTION_METHOD_TYPE = "Result Selection"
RESULT_SELECTION_JSON_FORMATS = {RS_JSON_FORMAT}
BF_METHOD_TYPE = dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON
BF_JSON_FORMATS = {BF_JSON_FORMAT}
CAPE_COD_METHOD_TYPE = dataset_sidecar_status_service.METHOD_TYPE_CAPE_COD
CAPE_COD_JSON_FORMATS = {CC_JSON_FORMAT}
BOOTSTRAP_METHOD_TYPE = dataset_sidecar_status_service.METHOD_TYPE_BOOTSTRAP
BOOTSTRAP_JSON_FORMATS = {BST_JSON_FORMAT}
BERQUIST_SHERMAN_METHOD_CONTRACTS = {
    "arcrho-berquist-sherman-sr-v4": {
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR,
        "source_kind": dataset_sidecar_status_service.SOURCE_KIND_BERQUIST_SHERMAN_SR,
        "filename_prefix": "BSSR@",
    },
    "arcrho-berquist-sherman-cra-v4": {
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_CRA,
        "source_kind": dataset_sidecar_status_service.SOURCE_KIND_BERQUIST_SHERMAN_CRA,
        "filename_prefix": "BSCRA@",
    },
}
METHOD_JSON_FILENAME_PREFIXES = (
    "DFM@",
    "RS@",
    "BF@",
    "CC@",
    "BST@",
    *(contract["filename_prefix"] for contract in BERQUIST_SHERMAN_METHOD_CONTRACTS.values()),
)
CACHED_JSON_FILENAME_PREFIXES = METHOD_JSON_FILENAME_PREFIXES
# Index work is latency-bound, not CPU-bound: every worker spends its time
# waiting on a network round trip for one small JSON file, so the width of this
# pool sets how long a rebuild takes on a mapped share. 32 is the ceiling the
# index contract itself clamps to, which keeps both scanners at one setting.
_INDEX_SCAN_MAX_WORKERS = 32
_INDEX_SCAN_EXECUTOR = ThreadPoolExecutor(
    max_workers=_INDEX_SCAN_MAX_WORKERS,
    thread_name_prefix="arcrho-index-scan",
)


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _write_index_file(index_path: str, data: Dict[str, Any]) -> bool:
    return write_index_json_unlocked(index_path, data)


def _require_project_dir(project_name: str) -> str:
    project = _clean_text(project_name)
    if not project:
        raise HTTPException(400, "project_name is required.")
    project_dir = config._find_existing_project_dir(project)
    if not project_dir:
        raise HTTPException(404, f"Project folder not found under projects: {project}")
    return project_dir


def _project_data_dir(project_name: str) -> str:
    return os.path.join(_require_project_dir(project_name), config.PROJECT_DATA_DIR)


def _reserving_class_folder(reserving_class: str) -> str:
    return config.sanitize_reserving_class_folder(reserving_class, "ReservingClass")


def _reserving_class_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(_project_data_dir(project_name), _reserving_class_folder(reserving_class))


def _method_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(_reserving_class_dir(project_name, reserving_class), config.METHOD_DATA_DIR)


def _method_json_path(project_name: str, reserving_class: str, method_name: str) -> str:
    name_part = sanitize_dataset_file_name(method_name, "Name")
    return os.path.join(_method_dir(project_name, reserving_class), f"DFM@{name_part}.json")


def _folder_paths(project_name: str, reserving_class: str) -> Dict[str, str]:
    data_dir = _reserving_class_dir(project_name, reserving_class)
    return {
        "data": data_dir,
        "datasets": os.path.join(data_dir, config.DATASET_CACHE_DIR),
        "methods": os.path.join(data_dir, config.METHOD_DATA_DIR),
        "sidecars": os.path.join(data_dir, config.DATASET_SIDECAR_DIR),
    }


def _canonical_project_name(folder_paths: Dict[str, str], fallback: str) -> str:
    data_dir = os.path.normpath(_clean_text(folder_paths.get("data")))
    if data_dir:
        project_dir = os.path.dirname(os.path.dirname(data_dir))
        canonical_dir = canonical_existing_directory(project_dir)
        folder_name = os.path.basename(str(canonical_dir or project_dir))
        if folder_name:
            return folder_name
    return _clean_text(fallback)


def _canonical_reserving_class(
    folder_paths: Dict[str, str],
    fallback: str,
) -> str:
    data_dir = _clean_text(folder_paths.get("data"))
    canonical_dir = canonical_existing_directory(data_dir) if data_dir else None
    if canonical_dir is not None:
        decoded = _clean_text(decode_filename_segment(canonical_dir.name))
        if decoded:
            return decoded
    return _clean_text(fallback)


def _safe_read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _format_index_signature(stat: os.stat_result) -> str:
    return f"{round(stat.st_mtime * 1000.0, 3)}:{int(stat.st_size)}"


def _index_signature_of(index_path: str) -> str:
    """mtime+size fingerprint of index.json, ``"missing"`` when not on disk."""

    try:
        return _format_index_signature(os.stat(index_path))
    except OSError:
        return "missing"


def _read_index_file(path: str) -> Dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    except PermissionError:
        raise HTTPException(423, "Dataset instance index is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to read dataset instance index: {str(err)}")
    return data if isinstance(data, dict) else {}


def _safe_load_required_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as err:
        raise HTTPException(422, f"DFM method JSON is invalid: {str(err)}")
    except OSError as err:
        raise HTTPException(500, f"Failed to read DFM method JSON: {str(err)}")
    if not isinstance(data, dict):
        raise HTTPException(422, "DFM method JSON must be an object.")
    return data


def _json_tab(source: Dict[str, Any], key: str) -> Dict[str, Any]:
    value = source.get(key) if isinstance(source, dict) else None
    return value if isinstance(value, dict) else {}


def _add_cached_dataset_name(names: Set[str], value: Any) -> None:
    text = _clean_text(value)
    if text:
        names.add(text)


def _add_cached_dataset_name_from_filename(names: Set[str], value: Any) -> None:
    text = config.decode_filename_segment(_clean_text(value))
    if text:
        names.add(text)


def _split_cache_variant_stem(stem: str) -> Tuple[str, bool]:
    parts = str(stem or "").split("@")
    if (
        len(parts) >= 5
        and parts[-4].strip().isdigit()
        and parts[-3].strip().isdigit()
        and parts[-2].strip().lower() in {"cum", "inc", "cumulative", "incremental"}
        and parts[-1].strip().lower() in {"dev", "cal", "calendar"}
    ):
        return "@".join(parts[:-4]), True
    if len(parts) >= 2 and parts[-1].strip().isdigit():
        return "@".join(parts[:-1]), True
    return str(stem or ""), False


def _has_legacy_length_only_suffix(stem: str) -> bool:
    parts = str(stem or "").split("@")
    return len(parts) >= 3 and parts[-1].strip().isdigit() and parts[-2].strip().isdigit()


def _normalize_cached_dataset_name(value: Any) -> str:
    text = _clean_text(value)
    stem, _ = _split_cache_variant_stem(text)
    return config.decode_filename_segment(stem.strip()).strip()


def _dataset_sidecar_path_for_cached_csv(csv_path: str) -> str:
    folder = os.path.dirname(csv_path)
    stem = os.path.splitext(os.path.basename(csv_path))[0]
    dataset_stem, is_cache_variant = _split_cache_variant_stem(stem)
    if os.path.basename(folder).lower() == config.DATASET_CACHE_DIR.lower():
        sidecar_folder = os.path.join(os.path.dirname(folder), config.DATASET_SIDECAR_DIR)
    else:
        sidecar_folder = os.path.join(folder, config.DATASET_SIDECAR_DIR)
    if is_cache_variant:
        return os.path.join(sidecar_folder, f"{dataset_stem}.json")
    return os.path.join(sidecar_folder, f"{stem}.json")


def _cached_dataset_names_from_file(filename: str) -> Set[str]:
    stem, ext = os.path.splitext(str(filename or ""))
    ext_l = ext.lower()
    names: Set[str] = set()
    if ext_l == ".csv":
        _add_cached_dataset_name_from_filename(names, _normalize_cached_dataset_name(stem))
        return names
    if ext_l != ".json":
        return names

    for prefix in CACHED_JSON_FILENAME_PREFIXES:
        if stem.startswith(prefix):
            _add_cached_dataset_name_from_filename(names, stem[len(prefix):])
            return names
    _add_cached_dataset_name_from_filename(names, _normalize_cached_dataset_name(stem))
    return names


def _cached_dataset_names_from_payload(payload: Dict[str, Any]) -> Set[str]:
    names: Set[str] = set()
    _add_cached_dataset_name(names, _normalize_cached_dataset_name(payload.get("dataset_name")))
    if names:
        return names
    json_format = _clean_text(payload.get("json_format")).lower()
    if json_format in RESULT_SELECTION_JSON_FORMATS:
        details_tab = _json_tab(payload, "details_tab")
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(details_tab.get("name")))
        return names
    if json_format in BF_JSON_FORMATS \
            or json_format in CAPE_COD_JSON_FORMATS \
            or json_format in BOOTSTRAP_JSON_FORMATS \
            or json_format in BERQUIST_SHERMAN_METHOD_CONTRACTS:
        details_tab = _json_tab(payload, "details_tab")
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(details_tab.get("name")))
        return names
    details_tab = _json_tab(payload, "details_tab")
    _add_cached_dataset_name(
        names,
        _normalize_cached_dataset_name(
            details_tab.get("output_dataset")
            or details_tab.get("name")
        ),
    )
    return names


def _method_entry_from_payload(payload: Dict[str, Any]) -> Dict[str, Any] | None:
    json_format = _clean_text(payload.get("json_format") or payload.get("json_format")).lower()
    if json_format in RESULT_SELECTION_JSON_FORMATS:
        details_tab = _json_tab(payload, "details_tab")
        dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
        dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
        dataset_category = _clean_text(details_tab.get("dataset_category") or details_tab.get("output_category"))
        if not dataset_name:
            return None
        return {
            "dataset_name": dataset_name,
            "dataset_type": dataset_type or dataset_name,
            "dataset_category": dataset_category,
            "method_type": RESULT_SELECTION_METHOD_TYPE,
            "data_format": "Vector",
            "source_kind": "result_selection",
            "status": dataset_sidecar_status_service.STATUS_CURRENT,
        }
    if json_format in BF_JSON_FORMATS:
        details_tab = _json_tab(payload, "details_tab")
        dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
        dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
        dataset_category = _clean_text(details_tab.get("dataset_category") or details_tab.get("output_category"))
        if not dataset_name:
            return None
        return {
            "dataset_name": dataset_name,
            "dataset_type": dataset_type or dataset_name,
            "dataset_category": dataset_category,
            "method_type": BF_METHOD_TYPE,
            "data_format": "Vector",
            "source_kind": "bornhuetter_ferguson",
            "status": dataset_sidecar_status_service.STATUS_CURRENT,
        }
    if json_format in CAPE_COD_JSON_FORMATS:
        details_tab = _json_tab(payload, "details_tab")
        dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
        dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
        dataset_category = _clean_text(details_tab.get("dataset_category") or details_tab.get("output_category"))
        if not dataset_name:
            return None
        return {
            "dataset_name": dataset_name,
            "dataset_type": dataset_type or dataset_name,
            "dataset_category": dataset_category,
            "method_type": CAPE_COD_METHOD_TYPE,
            "data_format": "Vector",
            "source_kind": "cape_cod",
            "status": dataset_sidecar_status_service.STATUS_CURRENT,
        }
    if json_format in BOOTSTRAP_JSON_FORMATS:
        details_tab = _json_tab(payload, "details_tab")
        dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
        dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
        dataset_category = _clean_text(details_tab.get("dataset_category") or details_tab.get("output_category"))
        if not dataset_name:
            return None
        return {
            "dataset_name": dataset_name,
            "dataset_type": dataset_type or dataset_name,
            "dataset_category": dataset_category,
            "method_type": BOOTSTRAP_METHOD_TYPE,
            "data_format": "Vector",
            "source_kind": "bootstrap",
            "status": dataset_sidecar_status_service.STATUS_CURRENT,
        }
    berquist_sherman_contract = BERQUIST_SHERMAN_METHOD_CONTRACTS.get(json_format)
    if berquist_sherman_contract:
        details_tab = _json_tab(payload, "details_tab")
        dataset_name = _normalize_cached_dataset_name(details_tab.get("name"))
        dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
        dataset_category = _clean_text(details_tab.get("dataset_category") or details_tab.get("output_category"))
        if not dataset_name:
            return None
        return {
            "dataset_name": dataset_name,
            "dataset_type": dataset_type or dataset_name,
            "dataset_category": dataset_category,
            "method_type": berquist_sherman_contract["method_type"],
            "data_format": "Triangle",
            "source_kind": berquist_sherman_contract["source_kind"],
            "origin_length": details_tab.get("origin_length"),
            "development_length": details_tab.get("development_length"),
            "status": dataset_sidecar_status_service.STATUS_CURRENT,
        }
    details_tab = _json_tab(payload, "details_tab")
    method_name = _normalize_cached_dataset_name(details_tab.get("name"))
    dataset_name = _normalize_cached_dataset_name(
        details_tab.get("output_dataset")
        or method_name
    )
    dataset_type = _normalize_cached_dataset_name(details_tab.get("output_type"))
    dataset_category = _clean_text(details_tab.get("output_category"))
    if not dataset_name:
        return None
    entry = {
        "dataset_name": dataset_name,
        "dataset_type": dataset_type or dataset_name,
        "dataset_category": dataset_category,
        "method_type": DFM_METHOD_TYPE,
        "data_format": "Vector",
        "source_kind": "dfm",
        "status": dataset_sidecar_status_service.STATUS_CURRENT,
    }
    if method_name and method_name.casefold() != dataset_name.casefold():
        entry["method_name"] = method_name
    return entry


def _is_index_file(filename: str) -> bool:
    return filename == INDEX_FILE_NAME


_DELETE_SCAN_FOLDER_KEYS = ("datasets", "methods", "sidecars")


def _enumerate_cached_files(folder_paths: Dict[str, str]) -> List[Tuple[str, str, str]]:
    """List the three instance folders, keeping the data ``scandir`` returned.

    ``DirEntry.is_file()`` is answered from the directory listing on Windows, so
    this costs one listing per folder. Re-statting each path would add a network
    round trip per file for information already in hand.
    """

    entries: List[Tuple[str, str, str]] = []
    for folder_key in _DELETE_SCAN_FOLDER_KEYS:
        directory = _clean_text(folder_paths.get(folder_key))
        if not directory or not os.path.isdir(directory):
            continue
        with os.scandir(directory) as iterator:
            for entry in iterator:
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in {".csv", ".json"} or _is_index_file(entry.name):
                    continue
                if not entry.is_file():
                    continue
                entries.append((entry.path, entry.name, folder_key))
    return entries


def _cached_file_metadata_path(entry_path: str, folder_key: str) -> str:
    return (
        _dataset_sidecar_path_for_cached_csv(entry_path)
        if folder_key == "datasets"
        else entry_path
    )


def _cached_file_dataset_names(
    entry_path: str,
    entry_name: str,
    folder_key: str,
    metadata: Dict[str, Any],
) -> Set[str]:
    """Dataset names one cached file belongs to.

    ``metadata`` is empty on the filename-only path, which is what makes the
    common delete cheap: a cached CSV and a sidecar are named after their
    dataset, so their membership is readable from the directory listing, while a
    method JSON keeps its dataset name in the payload and must be opened.
    """

    entry_stem = os.path.splitext(entry_name)[0]
    legacy_length_only_name = _has_legacy_length_only_suffix(entry_stem)
    if folder_key == "datasets":
        legacy_length_only_name = legacy_length_only_name or _has_legacy_length_only_suffix(
            os.path.splitext(os.path.basename(_cached_file_metadata_path(entry_path, folder_key)))[0]
        )
    payload_names = set() if legacy_length_only_name else _cached_dataset_names_from_payload(metadata)

    names: Set[str] = set()
    if folder_key == "methods" and entry_name.startswith(METHOD_JSON_FILENAME_PREFIXES):
        method_entry = _method_entry_from_payload(metadata)
        if method_entry:
            _add_cached_dataset_name(names, method_entry.get("dataset_name"))
    if not names:
        names.update(payload_names or _cached_dataset_names_from_file(entry_name))
    if metadata and not legacy_length_only_name:
        names.update(payload_names)
    return names


def _read_cached_metadata(paths: Set[str]) -> Dict[str, Dict[str, Any]]:
    futures: Dict[str, Future] = {
        path: _INDEX_SCAN_EXECUTOR.submit(_safe_read_json, path)
        for path in paths
    }
    return {path: future.result() for path, future in futures.items()}


def _cached_delete_targets(
    folder_paths: Dict[str, str],
    requested: Set[str],
    *,
    read_sidecar_payloads: bool,
) -> Tuple[List[Dict[str, str]], Set[str]]:
    """Resolve which cached files the requested dataset names own.

    ``read_sidecar_payloads`` opens every sidecar as well, which is only needed
    when a file's payload names a dataset its filename does not. That is the
    slow path and stays reserved for the verification pass in
    ``delete_cached_datasets``.
    """

    entries = _enumerate_cached_files(folder_paths)
    payload_paths = {
        _cached_file_metadata_path(entry_path, folder_key)
        for entry_path, _entry_name, folder_key in entries
        if folder_key == "methods" or read_sidecar_payloads
    }
    payloads = _read_cached_metadata(payload_paths)

    data_folder = _clean_text(folder_paths.get("data"))
    targets: List[Dict[str, str]] = []
    matched_keys: Set[str] = set()
    seen_paths: Set[str] = set()
    for entry_path, entry_name, folder_key in entries:
        metadata = payloads.get(_cached_file_metadata_path(entry_path, folder_key), {})
        item_names = {
            _clean_text(name).lower()
            for name in _cached_file_dataset_names(entry_path, entry_name, folder_key, metadata)
            if _clean_text(name)
        }
        matched = item_names.intersection(requested)
        if not matched:
            continue
        if not _path_is_within_folder(entry_path, data_folder):
            raise HTTPException(500, "Refusing to delete a cached dataset file outside the selected cache folder.")
        path_key = os.path.normcase(os.path.abspath(entry_path))
        if path_key in seen_paths:
            continue
        seen_paths.add(path_key)
        matched_keys.update(matched)
        targets.append({"name": entry_name, "path": entry_path})
    return targets, matched_keys


def _index_response(
    data: Dict[str, Any],
    *,
    persisted: bool,
    warning: str = "",
    folder_paths: Dict[str, str] | None = None,
    rebuild_reason: str = "",
    started_at: float | None = None,
) -> Dict[str, Any]:
    """Wrap a payload for the wire, reporting whether it cost a rebuild.

    Serving the persisted file costs three directory listings; rebuilding reads
    every sidecar and method payload and rewrites index.json. Over a network
    share those differ by orders of magnitude, so the response says which one the
    caller paid for and why, instead of leaving a slow reload unexplained.
    """

    response = dict(data)
    response["folder_paths"] = dict(
        folder_paths
        or _folder_paths(
            _clean_text(data.get("project_name")),
            _clean_text(data.get("reserving_class")),
        )
    )
    response["index_file_name"] = INDEX_FILE_NAME
    data_dir = _clean_text(response["folder_paths"].get("data"))
    # Statted by the process that just wrote or validated index.json — the
    # Gateway for hosted reads — so a client can baseline its staleness watch
    # on a value no SMB metadata cache has had a chance to distort. A client
    # stat over the mapped drive can echo pre-write metadata for ~10s after a
    # server-side write, which made the watch flag the user's own save.
    response["index_signature"] = (
        _index_signature_of(os.path.join(data_dir, INDEX_FILE_NAME)) if data_dir else "missing"
    )
    response["index_persisted"] = bool(persisted)
    response["index_warning"] = _clean_text(warning)
    response["index_rebuild_reason"] = _clean_text(rebuild_reason)
    response["index_rebuilt"] = bool(_clean_text(rebuild_reason))
    response["index_elapsed_ms"] = (
        round((time.monotonic() - started_at) * 1000.0, 1)
        if started_at is not None
        else 0.0
    )
    return response


def _unpersisted_index_warning(err: OSError) -> str:
    return (
        "Dataset table loaded from the dataset folder, but index.json could not be updated: "
        f"{str(err)}"
    )


def _canonical_identity(
    folder_paths: Dict[str, str],
    project_name: str,
    reserving_class: str,
) -> Tuple[str, str]:
    """Resolve the filesystem-preserved project and reserving-class names.

    Each half enumerates a parent folder, so callers resolve identity once and
    hand the result down instead of letting every layer repeat the listing.
    """

    return (
        _canonical_project_name(folder_paths, project_name),
        _canonical_reserving_class(folder_paths, reserving_class),
    )


def rebuild_index(
    project_name: str,
    reserving_class: str,
    *,
    allow_unpersisted: bool = False,
    _resolved_folder_paths: Dict[str, str] | None = None,
    _resolved_identity: Tuple[str, str] | None = None,
    _rebuild_reason: str = "explicit-rebuild",
    _started_at: float | None = None,
) -> Dict[str, Any]:
    requested_project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    started_at = _started_at if _started_at is not None else time.monotonic()
    reason = _clean_text(_rebuild_reason) or "explicit-rebuild"
    folder_paths = _resolved_folder_paths or _folder_paths(requested_project, rc)
    project, rc = _resolved_identity or _canonical_identity(folder_paths, requested_project, rc)
    if not os.path.isdir(folder_paths["data"]):
        return _index_response(
            build_dataset_index_payload(
                project,
                rc,
                folder_paths["data"],
                max_workers=_INDEX_SCAN_MAX_WORKERS,
            ),
            persisted=False,
            warning="Dataset instance folder does not exist; index.json was not written.",
            folder_paths=folder_paths,
            rebuild_reason=reason,
            started_at=started_at,
        )

    index_path = os.path.join(folder_paths["data"], INDEX_FILE_NAME)
    with index_update_lock(
        index_path,
        project_name=project,
        reserving_class=rc,
    ):
        try:
            data = build_dataset_index_payload(
                project,
                rc,
                folder_paths["data"],
                max_workers=_INDEX_SCAN_MAX_WORKERS,
            )
        except PermissionError:
            raise HTTPException(423, "Dataset instance folder is locked or inaccessible.")
        except OSError as err:
            raise HTTPException(500, f"Failed to read dataset instance folder: {str(err)}")

        try:
            _write_index_file(index_path, data)
        except PermissionError as err:
            if allow_unpersisted:
                return _index_response(
                    data,
                    persisted=False,
                    warning=_unpersisted_index_warning(err),
                    folder_paths=folder_paths,
                    rebuild_reason=reason,
                    started_at=started_at,
                )
            raise HTTPException(423, "Dataset instance index is locked or inaccessible.")
        except OSError as err:
            if allow_unpersisted:
                return _index_response(
                    data,
                    persisted=False,
                    warning=_unpersisted_index_warning(err),
                    folder_paths=folder_paths,
                    rebuild_reason=reason,
                    started_at=started_at,
                )
            raise HTTPException(500, f"Failed to write dataset instance index: {str(err)}")
        return _index_response(
            data,
            persisted=True,
            folder_paths=folder_paths,
            rebuild_reason=reason,
            started_at=started_at,
        )


def get_index(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    """Serve the reserving-class index, rebuilding only when the folder moved on.

    A normal read enumerates the three instance folders and compares the result
    against the persisted ``folder_signature``. That costs one directory listing
    per folder and reads no sidecar or method payload, so an unchanged folder is
    served straight from ``index.json``, and any durable mutation another
    producer made is picked up without waiting for a manual refresh.

    ``refresh=True`` still forces an unconditional rebuild for callers that want
    the index rewritten regardless of what the folder listing says.

    The response reports ``index_rebuild_reason`` so a caller that waited on a
    slow read can tell which of the two paths it paid for, and which check
    rejected the persisted file.
    """

    requested_project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    started_at = time.monotonic()
    folder_paths = _folder_paths(requested_project, rc)
    path = os.path.join(folder_paths["data"], INDEX_FILE_NAME)

    data = None if refresh else _read_index_file(path)
    if data is None:
        identity = _canonical_identity(folder_paths, requested_project, rc)
        return rebuild_index(
            *identity,
            allow_unpersisted=True,
            _resolved_folder_paths=folder_paths,
            _resolved_identity=identity,
            _rebuild_reason="refresh-requested" if refresh else "index-missing",
            _started_at=started_at,
        )

    saved_project = _clean_text(data.get("project_name"))
    project = (
        saved_project
        if saved_project.casefold() == requested_project.casefold()
        else _canonical_project_name(folder_paths, requested_project)
    )
    saved_rc = _clean_text(data.get("reserving_class"))
    rc = (
        saved_rc
        if saved_rc.casefold() == rc.casefold()
        else _canonical_reserving_class(folder_paths, rc)
    )
    folder_scan = scan_folder_signature(
        folder_paths["data"],
        max_workers=_INDEX_SCAN_MAX_WORKERS,
    )
    rebuild_reason = index_rebuild_reason(
        data,
        expected_project_name=project,
        expected_reserving_class=rc,
        expected_folder_signature=folder_scan.signature,
    )
    if rebuild_reason:
        return rebuild_index(
            project,
            rc,
            allow_unpersisted=True,
            _resolved_folder_paths=folder_paths,
            _resolved_identity=(project, rc),
            _rebuild_reason=rebuild_reason,
            _started_at=started_at,
        )
    return _index_response(
        data,
        persisted=True,
        folder_paths=folder_paths,
        started_at=started_at,
    )


def get_index_signature(project_name: str, reserving_class: str) -> Dict[str, Any]:
    """Report index.json's size and mtime so a client can poll for staleness.

    One stat instead of the three directory listings get_index() costs, because
    callers poll this on a timer and only need to know whether the file they
    already loaded still matches the one on disk.
    """

    project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not project or not rc:
        raise HTTPException(400, "project_name and reserving_class are required.")
    response: Dict[str, Any] = {
        "ok": True,
        "project_name": project,
        "reserving_class": rc,
        "index_file_name": INDEX_FILE_NAME,
        "exists": False,
        "mtime_ms": 0.0,
        "size": 0,
        "signature": "missing",
    }
    try:
        index_path = os.path.join(_reserving_class_dir(project, rc), INDEX_FILE_NAME)
    except HTTPException:
        # A project folder that has gone missing is a staleness answer, not a
        # polling failure: report "missing" and let the caller keep polling.
        return response
    response["path"] = index_path
    try:
        stat = os.stat(index_path)
    except OSError:
        return response
    response["exists"] = True
    response["mtime_ms"] = round(stat.st_mtime * 1000.0, 3)
    response["size"] = int(stat.st_size)
    response["signature"] = _format_index_signature(stat)
    return response


def get_cached_dataset_index(project_name: str, reserving_class: str) -> Dict[str, Any]:
    return get_index(project_name, reserving_class, refresh=False)


def _path_is_within_folder(path: str, folder: str) -> bool:
    child = os.path.normcase(os.path.abspath(path))
    parent = os.path.normcase(os.path.abspath(folder))
    return child.startswith(parent + os.sep)


def _requested_dataset_keys(dataset_names: List[str]) -> Set[str]:
    keys: Set[str] = set()
    for name in dataset_names or []:
        normalized = _normalize_cached_dataset_name(name)
        if normalized:
            keys.add(normalized.lower())
    if not keys:
        raise HTTPException(400, "At least one dataset name is required.")
    return keys


def _index_row_names(index: Dict[str, Any]) -> Set[str]:
    rows = index.get("files") if isinstance(index, dict) else None
    if not isinstance(rows, list):
        return set()
    return {
        _clean_text(row.get("name")).lower()
        for row in rows
        if isinstance(row, dict) and _clean_text(row.get("name"))
    }


def _read_sidecars_by_name(sidecar_dir: str, dataset_names: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """Read the named datasets' sidecars concurrently, keyed by canonical name.

    Reads resolve against the folder the caller is already working in rather
    than re-deriving it from the project name, so a caller that redirected its
    folders reaches the same files for both passes. The reads share the module's
    latency-bound pool instead of a per-name awaited loop, because each one is a
    network round trip on a mapped share.
    """

    names: Dict[str, str] = {}
    for raw in dataset_names or []:
        name = _clean_text(raw)
        key = _canon_dataset_name(name)
        if key and key not in names:
            names[key] = name
    if not names:
        return {}
    futures = {
        key: _INDEX_SCAN_EXECUTOR.submit(
            _safe_read_json,
            os.path.join(sidecar_dir, f"{sanitize_dataset_file_name(name)}.json"),
        )
        for key, name in names.items()
    }
    return {key: payload for key, future in futures.items() if (payload := future.result())}


def _surviving_dependents(
    folder_paths: Dict[str, str],
    dataset_names: List[str],
) -> List[Dict[str, Any]]:
    """Name the objects that would still read each requested dataset after the delete.

    An upstream object may only be deleted once nothing consumes it, so this
    reads the requested datasets' own sidecars and reports their direct
    ``dependents`` edges. Only direct dependents matter: a deeper descendant
    reaches this dataset through one of them, so clearing the direct edge is
    always the user's next step and listing the whole closure would name
    objects the user cannot act on yet.

    A dependent that is itself being deleted in the same request is not
    reported. Deleting a method together with the input it consumes leaves no
    dangling reference behind, and refusing that would make "select the chain,
    press Delete" fail for no reason the user can act on.
    """

    sidecar_dir = _clean_text(folder_paths.get("sidecars"))
    canon_requested = {
        _canon_dataset_name(name)
        for name in dataset_names or []
        if _canon_dataset_name(name)
    }
    payloads = _read_sidecars_by_name(sidecar_dir, dataset_names)
    # The dependents' own sidecars are read only to label each one with its
    # method type, and only for edges that actually block; a request that is
    # going through reads nothing beyond the first pass.
    dependent_payloads = _read_sidecars_by_name(
        sidecar_dir,
        [
            name
            for payload in payloads.values()
            for name in dataset_sidecar_status_service.entry_names(payload.get("dependents"))
            if _canon_dataset_name(name) not in canon_requested
        ],
    )

    blocked: List[Dict[str, Any]] = []
    for name in dataset_names or []:
        dataset_name = _clean_text(name)
        key = _canon_dataset_name(dataset_name)
        payload = payloads.get(key) if key else None
        if not payload:
            continue
        dependents: List[Dict[str, str]] = []
        for dependent_name in dataset_sidecar_status_service.entry_names(payload.get("dependents")):
            dependent_key = _canon_dataset_name(dependent_name)
            if not dependent_key or dependent_key in canon_requested:
                continue
            dependent_payload = dependent_payloads.get(dependent_key, {})
            dependents.append({
                "dataset_name": dependent_name,
                "method_type": dataset_sidecar_status_service.normalize_method_type(
                    dependent_payload.get("method_type"),
                    dependent_payload.get("source_kind"),
                ),
            })
        if dependents:
            blocked.append({"dataset_name": dataset_name, "dependents": dependents})
    return blocked


def _dependents_refusal_detail(blocked: List[Dict[str, Any]]) -> Dict[str, Any]:
    if len(blocked) == 1:
        subject = f"'{blocked[0]['dataset_name']}' is"
    else:
        subject = f"{len(blocked)} of the selected datasets are"
    return {
        "error": DELETE_BLOCKED_BY_DEPENDENTS,
        "message": (
            f"{subject} used as input by other objects in this reserving class. "
            "Open each dependent listed below and clear this input there, then delete again."
        ),
        "blocked_datasets": blocked,
    }


def delete_cached_datasets(project_name: str, reserving_class: str, dataset_names: List[str]) -> Dict[str, Any]:
    project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")

    requested = _requested_dataset_keys(dataset_names)
    folder_paths = _folder_paths(project, rc)

    # Nothing is removed while another object still names this one as an input.
    # The check covers the whole request before the first unlink, so a refused
    # delete leaves the selection exactly as the user found it rather than
    # half-applied.
    blocked = _surviving_dependents(folder_paths, list(dataset_names or []))
    if blocked:
        raise HTTPException(409, _dependents_refusal_detail(blocked))

    def resolve(*, read_sidecar_payloads: bool) -> Tuple[List[Dict[str, str]], Set[str]]:
        try:
            return _cached_delete_targets(
                folder_paths,
                requested,
                read_sidecar_payloads=read_sidecar_payloads,
            )
        except PermissionError:
            raise HTTPException(423, "Cached dataset folder is locked or inaccessible.")
        except HTTPException:
            raise
        except OSError as err:
            raise HTTPException(500, f"Failed to read cached dataset folder: {str(err)}")

    def remove_targets(targets: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        removed: List[Dict[str, Any]] = []
        for item in targets:
            path = item["path"]
            try:
                os.remove(path)
                if os.path.splitext(path)[1].lower() == ".csv":
                    try:
                        runtime_cache_provenance_service.remove(path)
                    except OSError:
                        pass
                removed.append(item)
            except FileNotFoundError:
                continue
            except PermissionError:
                raise HTTPException(423, f"Cached dataset file is locked or inaccessible: {item['name']}")
            except OSError as err:
                raise HTTPException(500, f"Failed to delete cached dataset file '{item['name']}': {str(err)}")
        return removed

    delete_items, matched_keys = resolve(read_sidecar_payloads=False)
    deleted = remove_targets(delete_items)
    index = rebuild_index(project, rc)

    # The filename-only pass cannot see a file whose payload names a dataset its
    # filename does not, so it is verified rather than trusted: the rebuild is
    # authoritative, and a requested dataset that still owns a row means files
    # survived. Only then is the payload read repeated for every sidecar.
    if _index_row_names(index).intersection(requested):
        stragglers, straggler_keys = resolve(read_sidecar_payloads=True)
        done_paths = {os.path.normcase(os.path.abspath(item["path"])) for item in deleted}
        stragglers = [
            item for item in stragglers
            if os.path.normcase(os.path.abspath(item["path"])) not in done_paths
        ]
        if stragglers:
            deleted.extend(remove_targets(stragglers))
            matched_keys.update(straggler_keys)
            index = rebuild_index(project, rc)

    missing_names = [
        _clean_text(name)
        for name in dataset_names or []
        if _normalize_cached_dataset_name(name).lower() not in matched_keys
    ]
    return {
        "ok": True,
        "project_name": project,
        "reserving_class": rc,
        "requested_dataset_names": [_clean_text(name) for name in dataset_names or [] if _clean_text(name)],
        "deleted_count": len(deleted),
        "deleted_files": deleted,
        "missing_dataset_names": missing_names,
        "index": index,
    }


def get_percent_developed_curve(project_name: str, reserving_class: str, method_name: str) -> Dict[str, Any]:
    project = _clean_text(project_name)
    path = _method_json_path(project, reserving_class, method_name)
    if not os.path.exists(path):
        raise HTTPException(
            404,
            (
                "DFM instance not found for project "
                f"'{project}', path '{_clean_text(reserving_class)}', method '{_clean_text(method_name)}'."
            ),
        )

    payload = _safe_load_required_json(path)
    data_tab = _json_tab(payload, "data_tab")
    ratios_tab = _json_tab(payload, "ratios_tab")
    ratio_triangle = _json_tab(ratios_tab, "ratio_triangle")
    average = _json_tab(ratios_tab, "average_formulas")
    data_labels = data_tab.get("development_labels")
    data_labels = data_labels if isinstance(data_labels, list) else []
    ratio_labels = ratio_triangle.get("development_labels")
    ratio_labels = ratio_labels if isinstance(ratio_labels, list) else []
    formulas = average.get("label")
    selected = average.get("selected")
    values = average.get("values")
    formulas = formulas if isinstance(formulas, list) else []
    selected = selected if isinstance(selected, list) else []
    values = values if isinstance(values, list) else []
    col_count = max(len(data_labels), len(ratio_labels), _matrix_width(selected), _matrix_width(values))
    if not col_count or not formulas or not selected or not values:
        raise HTTPException(422, "DFM instance does not contain average formula selections and values.")

    selected_values: List[float | None] = [None] * col_count
    selected_formula_labels: List[str] = [""] * col_count
    for col in range(col_count):
        selected_row_index = -1
        for row_index, row in enumerate(selected):
            if isinstance(row, list) and col < len(row) and _selected_value(row[col]):
                selected_row_index = row_index
                break
        if selected_row_index < 0:
            continue
        row_values = values[selected_row_index] if selected_row_index < len(values) else []
        value = row_values[col] if isinstance(row_values, list) and col < len(row_values) else None
        parsed = _number_or_none(value)
        if parsed is None:
            continue
        selected_values[col] = parsed
        selected_formula_labels[col] = str(formulas[selected_row_index] if selected_row_index < len(formulas) else "")

    cumulative_values: List[float | None] = [None] * col_count
    running: float | None = None
    for col in range(col_count - 1, -1, -1):
        selected_value = selected_values[col]
        if selected_value is None:
            running = None
            continue
        if col == col_count - 1:
            running = selected_value
        elif running is not None:
            running = selected_value * running
        else:
            running = None
            continue
        cumulative_values[col] = round(running, 6)

    points: List[Dict[str, Any]] = []
    for col, cumulative_value in enumerate(cumulative_values):
        if cumulative_value is None or cumulative_value == 0:
            continue
        label = str(ratio_labels[col] if col < len(ratio_labels) else f"Dev {col + 1}")
        x_label = data_labels[col] if col < len(data_labels) else label
        month = _parse_dev_month(x_label)
        if month is None:
            continue
        points.append({
            "x": month,
            "y": round(1 / cumulative_value, 6),
            "label": label,
            "col": col,
            "formula": selected_formula_labels[col],
        })

    points.sort(key=lambda item: float(item.get("x") or 0))
    if not points:
        raise HTTPException(422, "DFM instance did not contain enough % Developed values to plot.")
    return {
        "ok": True,
        "project_name": project,
        "reserving_class": _clean_text(reserving_class),
        "method_name": _clean_text(method_name),
        "points": points,
    }


def _number_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def _selected_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = _clean_text(value).lower()
    return text in {"1", "true", "yes", "y", "selected"}


def _parse_dev_month(label: Any) -> float | None:
    nums = [
        float(match.group(0))
        for match in re.finditer(r"\d*\.?\d+", str(label or ""))
        if match.group(0)
    ]
    if not nums:
        return None
    return nums[-1]


def _matrix_width(matrix: Any) -> int:
    if not isinstance(matrix, list):
        return 0
    width = 0
    for row in matrix:
        if isinstance(row, list):
            width = max(width, len(row))
    return width
