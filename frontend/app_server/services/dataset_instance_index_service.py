"""Reserving-class scoped dataset instance index cache."""
from __future__ import annotations

import json
import os
import re
import hashlib
from datetime import datetime
from typing import Any, Dict, List, Set, Tuple

from fastapi import HTTPException

from app_server import config
from app_server.helpers import sanitize_dataset_file_name

INDEX_FILE_NAME = "index.json"
INDEX_VERSION = 7
DFM_METHOD_TYPE = "DFM"


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


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


def _sidecar_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(_reserving_class_dir(project_name, reserving_class), config.DATASET_SIDECAR_DIR)


def _dataset_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(_reserving_class_dir(project_name, reserving_class), config.DATASET_CACHE_DIR)


def _method_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(_reserving_class_dir(project_name, reserving_class), config.METHOD_DATA_DIR)


def _method_json_path(project_name: str, reserving_class: str, method_name: str) -> str:
    name_part = sanitize_dataset_file_name(method_name, "Name")
    return os.path.join(_method_dir(project_name, reserving_class), f"DFM@{name_part}.json")


def _folder_paths(project_name: str, reserving_class: str) -> Dict[str, str]:
    return {
        "data": _reserving_class_dir(project_name, reserving_class),
        "datasets": _dataset_dir(project_name, reserving_class),
        "methods": _method_dir(project_name, reserving_class),
        "sidecars": _sidecar_dir(project_name, reserving_class),
    }


def _index_path(project_name: str, reserving_class: str) -> str:
    return os.path.join(_reserving_class_dir(project_name, reserving_class), INDEX_FILE_NAME)


def _safe_read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
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

    for prefix in ("ArcRhoTriNotes@", "DFM@"):
        if stem.startswith(prefix):
            _add_cached_dataset_name_from_filename(names, stem[len(prefix):])
            return names
    _add_cached_dataset_name_from_filename(names, _normalize_cached_dataset_name(stem))
    return names


def _cached_dataset_names_from_payload(payload: Dict[str, Any]) -> Set[str]:
    names: Set[str] = set()
    for key in ("dataset_name", "instance_name"):
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(payload.get(key)))
    if names:
        return names
    details_tab = _json_tab(payload, "details tab")
    _add_cached_dataset_name(names, _normalize_cached_dataset_name(details_tab.get("output type")))
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
    details_tab = _json_tab(payload, "details tab")
    dataset_name = _normalize_cached_dataset_name(details_tab.get("output type"))
    if not dataset_name:
        return None
    return {
        "dataset_name": dataset_name,
        "dataset_type_name": dataset_name,
        "method_type": DFM_METHOD_TYPE,
    }


def _is_index_file(filename: str) -> bool:
    return filename == INDEX_FILE_NAME


def _cached_folder_signature(files: List[Dict[str, Any]], folder_paths: Dict[str, str]) -> str:
    source = {
        "folders": {
            name: {
                "path": path,
                "exists": os.path.isdir(path),
            }
            for name, path in sorted(folder_paths.items())
        },
        "files": [
            {
                "name": _clean_text(item.get("name")),
                "source_kind": _clean_text(item.get("source_kind")),
                "size": int(item.get("size") or 0),
                "mtime_ns": int(item.get("mtime_ns") or 0),
            }
            for item in sorted(files, key=lambda item: (
                _clean_text(item.get("name")).lower(),
            ))
        ],
    }
    signature_source = json.dumps(source, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(signature_source.encode("utf-8")).hexdigest()


def _numeric_timestamp(value: Any) -> float:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


def _file_dataset_names(item: Dict[str, Any]) -> Set[str]:
    names: Set[str] = set()
    for key in ("dataset_name", "instance_name"):
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(item.get(key)))
    for value in item.get("dataset_names") or []:
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(value))
    if names:
        return names
    for key in ("name",):
        _add_cached_dataset_name(names, _normalize_cached_dataset_name(item.get(key)))
    return names


def _merge_logical_file(existing: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, Any]:
    last_modified_ts = _numeric_timestamp(source.get("last_modified_timestamp") or source.get("mtime"))
    if last_modified_ts and last_modified_ts >= _numeric_timestamp(existing.get("last_modified_timestamp")):
        existing["last_modified"] = _clean_text(source.get("last_modified"))
        existing["last_modified_timestamp"] = last_modified_ts
        user = _clean_text(source.get("user"))
        if user:
            existing["user"] = user

    created_ts = _numeric_timestamp(source.get("created_timestamp"))
    existing_created_ts = _numeric_timestamp(existing.get("created_timestamp"))
    if created_ts and (not existing_created_ts or created_ts < existing_created_ts):
        existing["created"] = _clean_text(source.get("created"))
        existing["created_timestamp"] = created_ts

    metadata_last_modified = _clean_text(source.get("metadata_last_modified"))
    if metadata_last_modified and not _clean_text(existing.get("metadata_last_modified")):
        existing["metadata_last_modified"] = metadata_last_modified
    metadata_created = _clean_text(source.get("metadata_created"))
    if metadata_created and not _clean_text(existing.get("metadata_created")):
        existing["metadata_created"] = metadata_created
    dataset_type_name = _clean_text(source.get("dataset_type_name") or source.get("dataset_type"))
    if dataset_type_name and not _clean_text(existing.get("dataset_type_name")):
        existing["dataset_type_name"] = dataset_type_name
    source_kind = _clean_text(source.get("source_kind"))
    if source_kind and not _clean_text(existing.get("source_kind")):
        existing["source_kind"] = source_kind
    for flag in ("editable", "generated", "calculated"):
        if flag in source and flag not in existing:
            existing[flag] = source.get(flag)
    return existing


def _logical_files_from_physical_files(files: List[Dict[str, Any]], methods: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_name: Dict[str, Dict[str, Any]] = {}
    display_names: Dict[str, str] = {}
    method_types = _method_type_by_name(methods)

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

    for key, method_type in method_types.items():
        logical = by_name.get(key)
        if logical is None:
            name = display_names.get(key) or next(
                (
                    _clean_text(item.get("dataset_name"))
                    for item in methods
                    if _clean_text(item.get("dataset_name")).lower() == key
                ),
                key,
            )
            logical = {
                "name": name,
                "dataset_name": name,
                "last_modified": "",
                "last_modified_timestamp": 0,
                "created": "",
                "created_timestamp": 0,
                "user": "",
            }
            by_name[key] = logical
        logical["method_type"] = method_type

    return sorted(by_name.values(), key=lambda item: _clean_text(item.get("dataset_name")).lower())


def _scan_cached_dataset_folder(folder_path: str) -> Tuple[Set[str], List[Dict[str, Any]], List[Dict[str, Any]]]:
    names: Set[str] = set()
    files: List[Dict[str, Any]] = []
    methods: List[Dict[str, Any]] = []
    metadata_cache: Dict[str, Dict[str, Any]] = {}
    if not os.path.isdir(folder_path):
        return names, files, methods

    def process_entry(entry: os.DirEntry, *, sidecar_metadata: bool = False) -> None:
            if not entry.is_file():
                return
            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in {".csv", ".json"} or _is_index_file(entry.name):
                return

            stat = entry.stat()
            file_names: Set[str] = set()
            metadata: Dict[str, Any] = {}
            metadata_path = entry.path
            method_entry = None
            entry_stem = os.path.splitext(entry.name)[0]
            legacy_length_only_name = _has_legacy_length_only_suffix(entry_stem)

            if ext == ".csv":
                file_names = set(_cached_dataset_names_from_file(entry.name))
                metadata_path = _dataset_sidecar_path_for_cached_csv(entry.path)
                metadata = metadata_cache.setdefault(metadata_path, _safe_read_json(metadata_path))
                legacy_length_only_name = legacy_length_only_name or _has_legacy_length_only_suffix(
                    os.path.splitext(os.path.basename(metadata_path))[0]
                )
            elif ext == ".json":
                metadata = metadata_cache.setdefault(entry.path, _safe_read_json(entry.path))
                payload_names = set() if legacy_length_only_name else _cached_dataset_names_from_payload(metadata)
                if not sidecar_metadata and entry.name.startswith("DFM@"):
                    method_entry = _method_entry_from_payload(metadata)
                    if method_entry:
                        methods.append(method_entry)
                        _add_cached_dataset_name(file_names, method_entry.get("dataset_name"))
                if not file_names:
                    file_names.update(payload_names or _cached_dataset_names_from_file(entry.name))

            if metadata and not legacy_length_only_name:
                payload_names = _cached_dataset_names_from_payload(metadata)
                file_names.update(payload_names)

            names.update(file_names)

            file_info = {
                "name": entry.name,
                "path": entry.path,
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
            if metadata:
                dataset_type_name = _normalize_cached_dataset_name(metadata.get("dataset_type_name") or metadata.get("dataset_type"))
                if not legacy_length_only_name:
                    file_info["dataset_name"] = _normalize_cached_dataset_name(metadata.get("dataset_name") or metadata.get("instance_name"))
                    file_info["dataset_type_name"] = dataset_type_name
                    file_info["dataset_type"] = dataset_type_name
                file_info["csv_file"] = _clean_text(metadata.get("csv_file"))
                file_info["source_kind"] = _clean_text(metadata.get("source_kind"))
                file_info["editable"] = metadata.get("editable")
                file_info["generated"] = metadata.get("generated")
                file_info["calculated"] = metadata.get("calculated")
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
            if method_entry:
                file_info["dataset_name"] = method_entry["dataset_name"]
                file_info["dataset_type_name"] = method_entry["dataset_type_name"]
                file_info["dataset_type"] = method_entry["dataset_type_name"]
                file_info["method_type"] = method_entry["method_type"]
            files.append(file_info)

    dataset_folder = os.path.join(folder_path, config.DATASET_CACHE_DIR)
    if os.path.isdir(dataset_folder):
        with os.scandir(dataset_folder) as it:
            for entry in it:
                process_entry(entry)

    method_folder = os.path.join(folder_path, config.METHOD_DATA_DIR)
    if os.path.isdir(method_folder):
        with os.scandir(method_folder) as it:
            for entry in it:
                process_entry(entry)

    sidecar_folder = os.path.join(folder_path, config.DATASET_SIDECAR_DIR)
    if os.path.isdir(sidecar_folder):
        with os.scandir(sidecar_folder) as it:
            for entry in it:
                process_entry(entry, sidecar_metadata=True)
    return names, files, methods


def _dedupe_methods(methods: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()
    for item in methods:
        dataset_name = _normalize_cached_dataset_name(item.get("dataset_name"))
        method_type = _clean_text(item.get("method_type")) or "None"
        key = (dataset_name.lower(), method_type.lower())
        if not dataset_name or key in seen:
            continue
        seen.add(key)
        out.append({
            "dataset_name": dataset_name,
            "method_type": method_type,
        })
    out.sort(key=lambda item: (
        _clean_text(item.get("dataset_name")).lower(),
        _clean_text(item.get("method_type")).lower(),
    ))
    return out


def _method_type_by_name(methods: List[Dict[str, Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for item in methods:
        name = _normalize_cached_dataset_name(item.get("dataset_name"))
        method_type = _clean_text(item.get("method_type"))
        if name and method_type:
            out[name.lower()] = method_type
    return out


def _apply_method_types_to_files(files: List[Dict[str, Any]], methods: List[Dict[str, Any]]) -> None:
    by_name = _method_type_by_name(methods)
    if not by_name:
        return
    for item in files:
        names = list(item.get("dataset_names") or [])
        direct_name = _clean_text(item.get("dataset_name"))
        if direct_name:
            names.append(direct_name)
        for name in names:
            method_type = by_name.get(_clean_text(name).lower())
            if method_type:
                item["method_type"] = method_type
                break


def _empty_index(project: str, reserving_class: str, folder_paths: Dict[str, str]) -> Dict[str, Any]:
    return {
        "ok": True,
        "version": INDEX_VERSION,
        "exists": False,
        "project_name": project,
        "reserving_class": reserving_class,
        "folder_paths": folder_paths,
        "folder_signature": _cached_folder_signature([], folder_paths),
        "files": [],
    }


def rebuild_index(project_name: str, reserving_class: str) -> Dict[str, Any]:
    project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    folder_paths = _folder_paths(project, rc)
    if not os.path.isdir(folder_paths["data"]):
        return _empty_index(project, rc, folder_paths)

    physical_files: List[Dict[str, Any]] = []
    methods: List[Dict[str, Any]] = []
    try:
        _folder_names, physical_files, methods = _scan_cached_dataset_folder(folder_paths["data"])
    except PermissionError:
        raise HTTPException(423, "Dataset instance folder is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to read dataset instance folder: {str(err)}")

    methods = _dedupe_methods(methods)
    _apply_method_types_to_files(physical_files, methods)
    files = _logical_files_from_physical_files(physical_files, methods)
    data = {
        "ok": True,
        "version": INDEX_VERSION,
        "exists": True,
        "project_name": project,
        "reserving_class": rc,
        "folder_paths": folder_paths,
        "folder_signature": _cached_folder_signature(physical_files, folder_paths),
        "files": files,
    }

    index_path = _index_path(project, rc)
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    temp_path = f"{index_path}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(temp_path, index_path)
    except OSError as err:
        try:
            os.remove(temp_path)
        except OSError:
            pass
        raise HTTPException(500, f"Failed to write dataset instance index: {str(err)}")
    return data


def _is_current_index(data: Dict[str, Any]) -> bool:
    return (
        data.get("version") == INDEX_VERSION
        and isinstance(data.get("files"), list)
        and _clean_text(data.get("folder_signature")) != ""
    )


def get_index(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    project = _clean_text(project_name)
    rc = _clean_text(reserving_class)
    if not rc:
        raise HTTPException(400, "reserving_class is required.")
    path = _index_path(project, rc)
    if refresh or not os.path.exists(path):
        return rebuild_index(project, rc)
    data = _safe_read_json(path)
    if not data or not _is_current_index(data):
        return rebuild_index(project, rc)
    return data


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
