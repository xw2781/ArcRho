"""Reserving-class scoped dataset instance index cache."""
from __future__ import annotations

import json
import os
import re
import stat
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Set, Tuple

from arcrho_api.dataset_index_contract import (
    DATASET_INDEX_VERSION,
    INDEX_FILE_NAME as DATASET_INDEX_FILE_NAME,
    build_dataset_index_payload,
    canonical_existing_directory,
    decode_filename_segment,
    index_update_lock,
    index_rebuild_reason,
    write_index_json_unlocked,
)
from fastapi import HTTPException

from app_server import config
from app_server.helpers import sanitize_dataset_file_name
from app_server.services import (
    dataset_sidecar_status_service,
    runtime_cache_provenance_service,
)

INDEX_FILE_NAME = DATASET_INDEX_FILE_NAME
INDEX_VERSION = DATASET_INDEX_VERSION
DFM_METHOD_TYPE = "DFM"
RESULT_SELECTION_METHOD_TYPE = "Result Selection"
RESULT_SELECTION_JSON_FORMATS = {
    "arcrho-result-selection-method-by-tab-v1",
    "arcrho-result-selection-method-by-tab-v2",
}
BF_METHOD_TYPE = dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON
BF_JSON_FORMAT = "arcrho-bornhuetter-ferguson-method-by-tab-v2"
BERQUIST_SHERMAN_METHOD_CONTRACTS = {
    "arcrho-berquist-sherman-sr-method-by-tab-v1": {
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR,
        "source_kind": dataset_sidecar_status_service.SOURCE_KIND_BERQUIST_SHERMAN_SR,
        "filename_prefix": "BSSR@",
    },
    "arcrho-berquist-sherman-cra-method-by-tab-v1": {
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_CRA,
        "source_kind": dataset_sidecar_status_service.SOURCE_KIND_BERQUIST_SHERMAN_CRA,
        "filename_prefix": "BSCRA@",
    },
}
METHOD_JSON_FILENAME_PREFIXES = (
    "DFM@",
    "RS@",
    "BF@",
    *(contract["filename_prefix"] for contract in BERQUIST_SHERMAN_METHOD_CONTRACTS.values()),
)
CACHED_JSON_FILENAME_PREFIXES = METHOD_JSON_FILENAME_PREFIXES
_INDEX_SCAN_MAX_WORKERS = 12
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
    if json_format == BF_JSON_FORMAT or json_format in BERQUIST_SHERMAN_METHOD_CONTRACTS:
        details_tab = _json_tab(payload, "details_tab")
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(details_tab.get("name")))
        return names
    details_tab = _json_tab(payload, "details tab")
    _add_cached_dataset_name(
        names,
        _normalize_cached_dataset_name(
            details_tab.get("output dataset")
            or details_tab.get("output vector")
            or details_tab.get("name")
        ),
    )
    return names


def _format_file_timestamp(value: float) -> str:
    try:
        return datetime.fromtimestamp(float(value)).isoformat(timespec="seconds")
    except (OSError, TypeError, ValueError):
        return ""


def _metadata_text(metadata: Dict[str, Any], keys: Tuple[str, ...]) -> str:
    for key in keys:
        value = metadata.get(key)
        text = _clean_text(value)
        if text:
            return text
    return ""


def _method_entry_from_payload(payload: Dict[str, Any]) -> Dict[str, Any] | None:
    json_format = _clean_text(payload.get("json_format") or payload.get("json format")).lower()
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
    if json_format == BF_JSON_FORMAT:
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
    details_tab = _json_tab(payload, "details tab")
    method_name = _normalize_cached_dataset_name(details_tab.get("name"))
    dataset_name = _normalize_cached_dataset_name(
        details_tab.get("output dataset")
        or details_tab.get("output vector")
        or method_name
    )
    dataset_type = _normalize_cached_dataset_name(details_tab.get("output type"))
    dataset_category = _clean_text(details_tab.get("output dataset_category") or details_tab.get("output category"))
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


def _parse_metadata_datetime(value: Any) -> datetime | None:
    text = _clean_text(value)
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        return parsed.astimezone().replace(tzinfo=None)
    return parsed


def _metadata_modified_timestamp(metadata: Dict[str, Any]) -> Tuple[str, float]:
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


def _metadata_created_timestamp(metadata: Dict[str, Any]) -> Tuple[str, float]:
    raw = _metadata_text(metadata, (
        "created_at",
        "created",
        "creation_time",
    ))
    parsed = _parse_metadata_datetime(raw)
    if parsed is None:
        return raw, 0.0
    return parsed.isoformat(), parsed.timestamp()


def _file_dataset_names(item: Dict[str, Any]) -> Set[str]:
    names: Set[str] = set()
    _add_cached_dataset_name(names, _normalize_cached_dataset_name(item.get("dataset_name")))
    for value in item.get("dataset_names") or []:
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(value))
    if names:
        return names
    for key in ("name",):
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(item.get(key)))
    return names


def _scan_cached_dataset_folder(folder_path: str) -> Tuple[Set[str], List[Dict[str, Any]], List[Dict[str, Any]]]:
    names: Set[str] = set()
    files: List[Dict[str, Any]] = []
    methods: List[Dict[str, Any]] = []
    if not os.path.isdir(folder_path):
        return names, files, methods

    entries: List[Tuple[str, str, bool]] = []
    def collect_entries(directory: str, *, sidecar_metadata: bool = False) -> None:
        if not os.path.isdir(directory):
            return
        with os.scandir(directory) as iterator:
            for entry in iterator:
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in {".csv", ".json"} or _is_index_file(entry.name):
                    continue
                entries.append((entry.path, entry.name, sidecar_metadata))

    collect_entries(os.path.join(folder_path, config.DATASET_CACHE_DIR))
    collect_entries(os.path.join(folder_path, config.METHOD_DATA_DIR))
    collect_entries(
        os.path.join(folder_path, config.DATASET_SIDECAR_DIR),
        sidecar_metadata=True,
    )

    metadata_paths: Set[str] = set()
    for entry_path, entry_name, _sidecar_metadata in entries:
        ext = os.path.splitext(entry_name)[1].lower()
        metadata_paths.add(
            _dataset_sidecar_path_for_cached_csv(entry_path)
            if ext == ".csv"
            else entry_path
        )

    stat_futures: Dict[str, Future] = {
        entry_path: _INDEX_SCAN_EXECUTOR.submit(os.stat, entry_path)
        for entry_path, _entry_name, _sidecar_metadata in entries
    }
    metadata_futures: Dict[str, Future] = {
        metadata_path: _INDEX_SCAN_EXECUTOR.submit(_safe_read_json, metadata_path)
        for metadata_path in metadata_paths
    }

    def process_entry(entry_path: str, entry_name: str, *, sidecar_metadata: bool = False) -> None:
            entry_stat = stat_futures[entry_path].result()
            if not stat.S_ISREG(entry_stat.st_mode):
                return
            ext = os.path.splitext(entry_name)[1].lower()
            file_names: Set[str] = set()
            metadata: Dict[str, Any] = {}
            metadata_path = entry_path
            method_entry = None
            entry_stem = os.path.splitext(entry_name)[0]
            legacy_length_only_name = _has_legacy_length_only_suffix(entry_stem)

            if ext == ".csv":
                file_names = set(_cached_dataset_names_from_file(entry_name))
                metadata_path = _dataset_sidecar_path_for_cached_csv(entry_path)
                metadata = metadata_futures[metadata_path].result()
                metadata_is_sidecar = True
                legacy_length_only_name = legacy_length_only_name or _has_legacy_length_only_suffix(
                    os.path.splitext(os.path.basename(metadata_path))[0]
                )
            elif ext == ".json":
                metadata = metadata_futures[entry_path].result()
                metadata_is_sidecar = sidecar_metadata
                payload_names = set() if legacy_length_only_name else _cached_dataset_names_from_payload(metadata)
                if not sidecar_metadata and entry_name.startswith(METHOD_JSON_FILENAME_PREFIXES):
                    method_entry = _method_entry_from_payload(metadata)
                    if method_entry:
                        methods.append(method_entry)
                        _add_cached_dataset_name(file_names, method_entry.get("dataset_name"))
                if not file_names:
                    file_names.update(payload_names or _cached_dataset_names_from_file(entry_name))

            if metadata and not legacy_length_only_name:
                payload_names = _cached_dataset_names_from_payload(metadata)
                file_names.update(payload_names)

            names.update(file_names)

            file_info = {
                "name": entry_name,
                "path": entry_path,
                "size": entry_stat.st_size,
                "mtime": entry_stat.st_mtime,
                "mtime_ns": entry_stat.st_mtime_ns,
                "last_modified": _format_file_timestamp(entry_stat.st_mtime),
                "last_modified_timestamp": entry_stat.st_mtime,
            }
            if file_names:
                file_info["dataset_names"] = sorted(file_names, key=lambda item: item.lower())
            if metadata:
                dataset_type = _normalize_cached_dataset_name(metadata.get("dataset_type"))
                if not legacy_length_only_name:
                    file_info["dataset_name"] = _normalize_cached_dataset_name(metadata.get("dataset_name"))
                    file_info["dataset_type"] = dataset_type
                    file_info["dataset_category"] = _clean_text(metadata.get("dataset_category") or metadata.get("category"))
                file_info["csv_file"] = _clean_text(metadata.get("csv_file"))
                file_info["source_kind"] = _clean_text(metadata.get("source_kind"))
                file_info["data_format"] = _clean_text(metadata.get("data_format"))
                file_info["method_type"] = dataset_sidecar_status_service.normalize_method_type(
                    metadata.get("method_type"),
                    metadata.get("source_kind"),
                )
                file_info["status"] = dataset_sidecar_status_service.normalize_status(metadata.get("status"))
                if file_info["data_format"].strip().lower() == "vector":
                    file_info["origin_length"] = metadata.get("period_length")
                else:
                    file_info["origin_length"] = metadata.get("origin_length")
                file_info["development_length"] = metadata.get("development_length")
                file_info["calculated"] = metadata.get("calculated")
                file_info["formula"] = _clean_text(metadata.get("formula"))
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
            if method_entry:
                file_info["dataset_name"] = method_entry["dataset_name"]
                file_info["dataset_type"] = method_entry["dataset_type"]
                file_info["dataset_category"] = method_entry.get("dataset_category", "")
                file_info["source_kind"] = method_entry.get("source_kind", "")
                file_info["method_type"] = method_entry["method_type"]
                file_info["status"] = method_entry.get("status", dataset_sidecar_status_service.STATUS_CURRENT)
                file_info["data_format"] = method_entry.get("data_format", "")
                if method_entry.get("origin_length") not in (None, ""):
                    file_info["origin_length"] = method_entry["origin_length"]
                if method_entry.get("development_length") not in (None, ""):
                    file_info["development_length"] = method_entry["development_length"]
            files.append(file_info)

    for entry_path, entry_name, sidecar_metadata in entries:
        process_entry(entry_path, entry_name, sidecar_metadata=sidecar_metadata)

    return names, files, methods


def _index_response(
    data: Dict[str, Any],
    *,
    persisted: bool,
    warning: str = "",
    folder_paths: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    response = dict(data)
    response["folder_paths"] = dict(
        folder_paths
        or _folder_paths(
            _clean_text(data.get("project_name")),
            _clean_text(data.get("reserving_class")),
        )
    )
    response["index_file_name"] = INDEX_FILE_NAME
    response["index_persisted"] = bool(persisted)
    response["index_warning"] = _clean_text(warning)
    return response


def _unpersisted_index_warning(err: OSError) -> str:
    return (
        "Dataset table loaded from the dataset folder, but index.json could not be updated: "
        f"{str(err)}"
    )


def rebuild_index(
    project_name: str,
    reserving_class: str,
    *,
    allow_unpersisted: bool = False,
    _resolved_folder_paths: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    requested_project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    folder_paths = _resolved_folder_paths or _folder_paths(requested_project, rc)
    project = _canonical_project_name(folder_paths, requested_project)
    rc = _canonical_reserving_class(folder_paths, rc)
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
                )
            raise HTTPException(423, "Dataset instance index is locked or inaccessible.")
        except OSError as err:
            if allow_unpersisted:
                return _index_response(
                    data,
                    persisted=False,
                    warning=_unpersisted_index_warning(err),
                    folder_paths=folder_paths,
                )
            raise HTTPException(500, f"Failed to write dataset instance index: {str(err)}")
        return _index_response(data, persisted=True, folder_paths=folder_paths)


def get_index(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    requested_project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    folder_paths = _folder_paths(requested_project, rc)
    path = os.path.join(folder_paths["data"], INDEX_FILE_NAME)
    if refresh:
        project = _canonical_project_name(folder_paths, requested_project)
        rc = _canonical_reserving_class(folder_paths, rc)
        return rebuild_index(
            project,
            rc,
            allow_unpersisted=True,
            _resolved_folder_paths=folder_paths,
        )
    data = _read_index_file(path)
    if data is None:
        project = _canonical_project_name(folder_paths, requested_project)
        rc = _canonical_reserving_class(folder_paths, rc)
        return rebuild_index(
            project,
            rc,
            allow_unpersisted=True,
            _resolved_folder_paths=folder_paths,
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
    rebuild_reason = index_rebuild_reason(
        data,
        expected_project_name=project,
        expected_reserving_class=rc,
    )
    if rebuild_reason:
        return rebuild_index(
            project,
            rc,
            allow_unpersisted=True,
            _resolved_folder_paths=folder_paths,
        )
    return _index_response(
        data,
        persisted=True,
        folder_paths=folder_paths,
    )


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


def delete_cached_datasets(project_name: str, reserving_class: str, dataset_names: List[str]) -> Dict[str, Any]:
    project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")

    requested = _requested_dataset_keys(dataset_names)
    folder_paths = _folder_paths(project, rc)
    delete_items: List[Dict[str, Any]] = []
    matched_keys: Set[str] = set()
    seen_paths: Set[str] = set()

    try:
        folder_path = folder_paths["data"]
        _folder_names, files, _methods = _scan_cached_dataset_folder(folder_path)
        for item in files:
            item_names = {_clean_text(name).lower() for name in _file_dataset_names(item) if _clean_text(name)}
            matched = item_names.intersection(requested)
            if not matched:
                continue
            path = _clean_text(item.get("path"))
            if not path:
                continue
            if not _path_is_within_folder(path, folder_path):
                raise HTTPException(500, "Refusing to delete a cached dataset file outside the selected cache folder.")
            path_key = os.path.normcase(os.path.abspath(path))
            if path_key in seen_paths:
                continue
            seen_paths.add(path_key)
            matched_keys.update(matched)
            delete_items.append({
                "name": _clean_text(item.get("name")) or os.path.basename(path),
                "path": path,
            })
    except PermissionError:
        raise HTTPException(423, "Cached dataset folder is locked or inaccessible.")
    except HTTPException:
        raise
    except OSError as err:
        raise HTTPException(500, f"Failed to read cached dataset folder: {str(err)}")

    deleted: List[Dict[str, Any]] = []
    for item in delete_items:
        path = item["path"]
        try:
            os.remove(path)
            if os.path.splitext(path)[1].lower() == ".csv":
                try:
                    runtime_cache_provenance_service.remove(path)
                except OSError:
                    pass
            deleted.append(item)
        except FileNotFoundError:
            continue
        except PermissionError:
            raise HTTPException(423, f"Cached dataset file is locked or inaccessible: {item['name']}")
        except OSError as err:
            raise HTTPException(500, f"Failed to delete cached dataset file '{item['name']}': {str(err)}")

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
    data_tab = _json_tab(payload, "data tab")
    ratios_tab = _json_tab(payload, "ratios tab")
    ratio_triangle = _json_tab(ratios_tab, "ratio triangle")
    average = _json_tab(ratios_tab, "average formulas")
    data_labels = data_tab.get("development labels")
    data_labels = data_labels if isinstance(data_labels, list) else []
    ratio_labels = ratio_triangle.get("development labels")
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
