"""ArcRho runtime request operations."""
from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict

import pandas as pd
from fastapi import HTTPException

from app_server import config
from app_server.helpers import sanitize_dataset_file_name, set_data_path_like_vba, send_request_like_vba, wait_for_file
from app_server.services import dataset_instance_index_service, dataset_sidecar_status_service, project_settings_service
from app_server.services.data_processing_rules_service import (
    get_processing_config_hash,
    get_processing_provenance,
    is_imported_snapshot_payload,
)

def _pair_value(pairs: list, key: str) -> str:
    key_l = key.strip().lower()
    for pair_key, pair_value in pairs:
        if str(pair_key or "").strip().lower() == key_l:
            return str(pair_value or "").strip()
    return ""


def _dataset_sidecar_path(data_path: str, pairs: list) -> str:
    dataset_name = _pair_value(pairs, "InstanceName") or _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    dataset_file = sanitize_dataset_file_name(dataset_name)
    dataset_dir = os.path.dirname(data_path)
    if os.path.basename(dataset_dir).lower() == config.DATASET_CACHE_DIR.lower():
        sidecar_dir = os.path.join(os.path.dirname(dataset_dir), config.DATASET_SIDECAR_DIR)
    else:
        sidecar_dir = os.path.join(dataset_dir, config.DATASET_SIDECAR_DIR)
    return os.path.join(sidecar_dir, f"{dataset_file}.json")


def _utc_timestamp_from_stat(value: float) -> str:
    return datetime.utcfromtimestamp(value).isoformat(timespec="seconds") + "Z"


def _pair_int_value(pairs: list, key: str, default: int) -> int:
    try:
        return int(_pair_value(pairs, key) or default)
    except (TypeError, ValueError):
        return default


def _pair_bool_value(pairs: list, key: str, default: bool) -> bool:
    raw = _pair_value(pairs, key)
    if not raw:
        return default
    text = raw.strip().lower()
    if text in {"true", "yes", "1"}:
        return True
    if text in {"false", "no", "0"}:
        return False
    return default


def _clean_cache_text(value: Any) -> str:
    return str(value or "").strip()


def _cache_text_matches(left: Any, right: Any) -> bool:
    return _clean_cache_text(left) == _clean_cache_text(right)


def _cache_payload_name_matches(payload: Dict[str, Any], expected_name: str) -> bool:
    if not expected_name:
        return False
    return _cache_text_matches(payload.get("dataset_name"), expected_name)


def _safe_read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _request_dataset_name(pairs: list) -> str:
    return _pair_value(pairs, "InstanceName") or _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")


def _processing_config_matches(
    payload: Dict[str, Any],
    pairs: list,
    data_path: str = "",
) -> bool:
    source_kind = _clean_cache_text(payload.get("source_kind")).lower()
    if source_kind != "engine" or is_imported_snapshot_payload(payload):
        return True
    processing: Any = None
    filename = os.path.basename(str(data_path or "").strip())
    processing_by_csv = payload.get("processing_by_csv")
    if filename and isinstance(processing_by_csv, dict):
        processing = processing_by_csv.get(filename)
    elif filename:
        csv_file = _clean_cache_text(payload.get("csv_file"))
        if not csv_file or os.path.basename(csv_file) != filename:
            return False
        processing = payload.get("processing")
    else:
        processing = payload.get("processing")
    if not isinstance(processing, dict):
        return False
    stored_hash = _clean_cache_text(processing.get("config_hash"))
    project_name = _pair_value(pairs, "ProjectName")
    if not stored_hash or not project_name:
        return False
    try:
        return stored_hash == get_processing_config_hash(project_name)
    except Exception:
        return False


def _triangle_sidecar_payload(
    data_path: str,
    pairs: list,
    *,
    local_only: bool = False,
    validate_processing_for_path: bool = True,
) -> Dict[str, Any]:
    sidecar_path = _dataset_sidecar_path(data_path, pairs)
    payload = _safe_read_json(sidecar_path)
    if not payload:
        return {}
    expected_name = _request_dataset_name(pairs)
    if not _cache_payload_name_matches(payload, expected_name):
        return {}
    if not _cache_text_matches(payload.get("reserving_class"), _pair_value(pairs, "Path")):
        return {}
    if not _cache_text_matches(payload.get("project_name"), _pair_value(pairs, "ProjectName")):
        return {}
    source_kind = _clean_cache_text(payload.get("source_kind")).lower()
    if not local_only and source_kind != "input":
        return {}
    if validate_processing_for_path and not _processing_config_matches(payload, pairs, data_path):
        return {}
    data_format = _clean_cache_text(payload.get("data_format") or "Triangle").lower()
    if data_format and data_format != "triangle":
        return {}
    return payload


def _manual_input_sidecar_payload(data_path: str, pairs: list) -> Dict[str, Any]:
    return _triangle_sidecar_payload(data_path, pairs, local_only=False)


def _is_generated_triangle_payload(payload: Dict[str, Any]) -> bool:
    source_kind = _clean_cache_text(payload.get("source_kind")).lower()
    return source_kind == "engine"


def _parse_cache_variant(filename: str) -> Dict[str, Any]:
    stem, ext = os.path.splitext(os.path.basename(filename))
    if ext.lower() != ".csv":
        return {}
    parts = stem.split("@")
    if len(parts) < 5:
        return {}
    origin = parts[-4].strip()
    dev = parts[-3].strip()
    cum = parts[-2].strip().lower()
    cal = parts[-1].strip().lower()
    if not origin.isdigit() or not dev.isdigit():
        return {}
    if cum not in {"cum", "inc"} or cal not in {"dev", "cal"}:
        return {}
    return {
        "base": "@".join(parts[:-4]),
        "origin_length": int(origin),
        "development_length": int(dev),
        "cumulative": cum == "cum",
        "calendar": cal == "cal",
    }


def _local_cache_candidates(data_path: str, pairs: list, *, local_only: bool = False) -> list[Dict[str, Any]]:
    payload = _triangle_sidecar_payload(
        data_path,
        pairs,
        local_only=local_only,
        validate_processing_for_path=False,
    )
    if not payload:
        return []
    dataset_dir = os.path.dirname(data_path)
    expected_base = sanitize_dataset_file_name(_request_dataset_name(pairs))
    if not os.path.isdir(dataset_dir):
        return []
    out: list[Dict[str, Any]] = []
    for filename in os.listdir(dataset_dir):
        parsed = _parse_cache_variant(filename)
        if not parsed or parsed["base"] != expected_base:
            continue
        path = os.path.join(dataset_dir, filename)
        if not os.path.isfile(path):
            continue
        if not _processing_config_matches(payload, pairs, path):
            continue
        out.append({
            **parsed,
            "path": path,
            "payload": payload,
        })
    return out


def _can_derive_cache(candidate: Dict[str, Any], pairs: list, target_path: str) -> tuple[bool, str]:
    if candidate.get("path") == target_path:
        return False, "exact target already handled"
    target_origin = _pair_int_value(pairs, "OriginLength", 12)
    target_dev = _pair_int_value(pairs, "DevelopmentLength", 12)
    source_origin = int(candidate.get("origin_length") or 0)
    source_dev = int(candidate.get("development_length") or 0)
    if source_origin <= 0 or source_dev <= 0 or target_origin <= 0 or target_dev <= 0:
        return False, "invalid period length"
    if bool(candidate.get("calendar")) != _pair_bool_value(pairs, "Calendar", False):
        return False, "calendar mode differs"
    if bool(candidate.get("cumulative")) != _pair_bool_value(pairs, "Cumulative", True):
        return False, "cumulative mode differs"
    if target_origin < source_origin or target_dev < source_dev:
        return False, "local caches can only derive from finer to coarser periods"
    if target_origin % source_origin != 0 or target_dev % source_dev != 0:
        return False, "requested periods are not whole multiples of the cached periods"
    return True, ""


def _derive_triangle_cache(candidate: Dict[str, Any], pairs: list, target_path: str) -> Dict[str, Any]:
    source_path = str(candidate["path"])
    source_origin = int(candidate["origin_length"])
    source_dev = int(candidate["development_length"])
    target_origin = _pair_int_value(pairs, "OriginLength", 12)
    target_dev = _pair_int_value(pairs, "DevelopmentLength", 12)
    origin_factor = target_origin // source_origin
    dev_factor = target_dev // source_dev
    df = pd.read_csv(source_path, header=None, dtype="float64", keep_default_na=True)
    source_rows, source_cols = df.shape
    target_rows = source_rows // origin_factor
    target_cols = source_cols // dev_factor
    if target_rows <= 0 or target_cols <= 0:
        raise ValueError("cached triangle is smaller than the requested output size")
    values: list[list[Any]] = []
    cumulative = _pair_bool_value(pairs, "Cumulative", True)
    for row_index in range(target_rows):
        row_values: list[Any] = []
        row_block = df.iloc[row_index * origin_factor:(row_index + 1) * origin_factor, :]
        for col_index in range(target_cols):
            if cumulative:
                source_col = (col_index + 1) * dev_factor - 1
                block = row_block.iloc[:, source_col]
            else:
                block = row_block.iloc[:, col_index * dev_factor:(col_index + 1) * dev_factor].to_numpy().ravel()
                block = pd.Series(block)
            row_values.append(float(block.sum(skipna=True)) if block.notna().any() else None)
        values.append(row_values)

    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    tmp_path = f"{target_path}.{uuid.uuid4()}.tmp"
    pd.DataFrame(values).to_csv(tmp_path, header=False, index=False)
    os.replace(tmp_path, target_path)
    return {
        "source_path": source_path,
        "source_origin_length": source_origin,
        "source_development_length": source_dev,
        "origin_factor": origin_factor,
        "development_factor": dev_factor,
        "target_rows": target_rows,
        "target_cols": target_cols,
    }


def _arcrho_dataset_id(data_path: str, pairs: list | None = None) -> str:
    function_name = _pair_value(pairs or [], "Function").strip().lower()
    prefix = "arcrhovec_" if function_name == "arcrhovec" else "arcrhotri_"
    return prefix + hashlib.sha1(data_path.encode("utf-8")).hexdigest()[:16]


def _register_arcrho_dataset(data_path: str, pairs: list | None = None) -> str:
    ds_id = _arcrho_dataset_id(data_path, pairs)
    config.DATASETS[ds_id] = data_path
    return ds_id


def resolve_local_triangle_cache(
    data_path: str,
    pairs: list,
    allow_derived: bool = True,
    materialize: bool = True,
    local_only: bool = False,
    materialize_path: str | None = None,
    refresh_index_on_materialize: bool = True,
) -> Dict[str, Any]:
    target_path = materialize_path or data_path
    if arcrho_tri_cache_matches(data_path, pairs):
        payload = _triangle_sidecar_payload(data_path, pairs, local_only=True)
        return {
            "ok": True,
            "status": "cache_exact",
            "data_path": data_path,
            "manual_source_found": bool(_manual_input_sidecar_payload(data_path, pairs)),
            "generated_source_found": bool(payload and _is_generated_triangle_payload(payload)),
            "local_source_found": True,
        }

    payload = _triangle_sidecar_payload(
        data_path,
        pairs,
        local_only=local_only,
        validate_processing_for_path=False,
    )
    if not payload:
        return {
            "ok": False,
            "status": "missing_sidecar",
            "manual_source_found": False,
            "generated_source_found": False,
            "local_source_found": False,
            "message": f"Input triangle cache sidecar was not found for '{_request_dataset_name(pairs)}'.",
            "data_path": data_path,
        }
    generated_source_found = _is_generated_triangle_payload(payload)
    manual_source_found = bool(_manual_input_sidecar_payload(data_path, pairs))
    candidates = _local_cache_candidates(data_path, pairs, local_only=local_only)
    if not candidates:
        return {
            "ok": False,
            "status": "cache_missing",
            "manual_source_found": manual_source_found,
            "generated_source_found": generated_source_found,
            "local_source_found": True,
            "message": f"Input triangle cache was not found for '{_request_dataset_name(pairs)}'.",
            "data_path": data_path,
        }

    if not allow_derived:
        return {
            "ok": False,
            "status": "cache_missing",
            "manual_source_found": manual_source_found,
            "generated_source_found": generated_source_found,
            "local_source_found": True,
            "message": f"Input triangle cache was not found for '{_request_dataset_name(pairs)}'.",
            "data_path": data_path,
        }

    rejected: list[str] = []
    candidates.sort(key=lambda item: (int(item.get("origin_length") or 999999), int(item.get("development_length") or 999999)))
    for candidate in candidates:
        can_derive, reason = _can_derive_cache(candidate, pairs, target_path)
        if not can_derive:
            if reason:
                rejected.append(reason)
            continue
        if not materialize:
            return {
                "ok": True,
                "status": "cache_derivable",
                "data_path": target_path,
                "manual_source_found": manual_source_found,
                "generated_source_found": generated_source_found,
                "local_source_found": True,
                "derived": {
                    "source_path": str(candidate["path"]),
                    "source_origin_length": int(candidate.get("origin_length") or 0),
                    "source_development_length": int(candidate.get("development_length") or 0),
                },
            }
        try:
            derived = _derive_triangle_cache(candidate, pairs, target_path)
        except Exception as err:
            rejected.append(str(err))
            continue
        if refresh_index_on_materialize:
            try:
                dataset_instance_index_service.rebuild_index(_pair_value(pairs, "ProjectName"), _pair_value(pairs, "Path"))
            except Exception:
                pass
        return {
            "ok": True,
            "status": "cache_derived",
            "data_path": target_path,
            "manual_source_found": manual_source_found,
            "generated_source_found": generated_source_found,
            "local_source_found": True,
            "derived": derived,
        }

    detail = rejected[0] if rejected else "no compatible finer cache was found"
    return {
        "ok": False,
        "status": "cache_missing" if generated_source_found else "cache_not_derivable",
        "manual_source_found": manual_source_found,
        "generated_source_found": generated_source_found,
        "local_source_found": True,
        "message": (
            f"Input triangle '{_request_dataset_name(pairs)}' exists as a local cache that cannot derive "
            f"{_pair_int_value(pairs, 'OriginLength', 12)}x{_pair_int_value(pairs, 'DevelopmentLength', 12)} periods: {detail}."
        ),
        "data_path": data_path,
    }


def _apply_dataset_sidecar_shape_fields(payload: Dict[str, Any], pairs: list, *, is_vector: bool) -> None:
    if is_vector:
        payload["period_length"] = _pair_int_value(pairs, "OriginLength", 12)
        for obsolete_key in ("origin_length", "development_length", "development_count", "cumulative", "calendar"):
            payload.pop(obsolete_key, None)
        return
    payload["origin_length"] = _pair_int_value(pairs, "OriginLength", 12)
    payload["development_length"] = _pair_int_value(pairs, "DevelopmentLength", 12)
    payload["cumulative"] = _pair_bool_value(pairs, "Cumulative", True)
    payload["calendar"] = _pair_bool_value(pairs, "Calendar", False)
    payload.pop("period_length", None)


def _set_processing_provenance(
    payload: Dict[str, Any],
    project_name: str,
    data_path: str,
) -> None:
    provenance = get_processing_provenance(project_name)
    payload["processing"] = provenance
    processing_by_csv = payload.get("processing_by_csv")
    if not isinstance(processing_by_csv, dict):
        processing_by_csv = {}
    processing_by_csv[os.path.basename(data_path)] = provenance
    payload["processing_by_csv"] = processing_by_csv


def _write_dataset_sidecar(data_path: str, pairs: list) -> None:
    dataset_type = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    instance_name = _pair_value(pairs, "InstanceName") or dataset_type
    if not instance_name:
        return
    sidecar_path = _dataset_sidecar_path(data_path, pairs)
    project_name = _pair_value(pairs, "ProjectName")
    reserving_class = _pair_value(pairs, "Path")
    is_vector = _pair_value(pairs, "Function").strip().lower() == "arcrhovec"
    data_format = "Vector" if is_vector else "Triangle"
    user_name = getpass.getuser()
    updated_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    if os.path.exists(sidecar_path):
        payload = dataset_sidecar_status_service.read_sidecar(sidecar_path)
        if not payload:
            return
        payload["method_type"] = dataset_sidecar_status_service.METHOD_TYPE_NONE
        payload["status"] = dataset_sidecar_status_service.STATUS_CURRENT
        payload["updated_at"] = updated_at
        payload["modified_by"] = user_name
        payload["user"] = user_name
        payload["data_format"] = data_format
        payload["data_format_code"] = 1 if is_vector else 0
        if _clean_cache_text(payload.get("source_kind")).lower() == "engine":
            _set_processing_provenance(payload, project_name, data_path)
        _apply_dataset_sidecar_shape_fields(payload, pairs, is_vector=is_vector)
        payload["csv_file"] = os.path.basename(data_path)
        from app_server.services.dataset_service import _append_dataset_audit_entry

        _append_dataset_audit_entry(payload, "Update", event_date=updated_at, user_name=user_name)
        dataset_sidecar_status_service.write_sidecar(sidecar_path, payload)
        dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
            project_name,
            reserving_class,
            [instance_name, dataset_type],
        )
        return
    created = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    try:
        created = _utc_timestamp_from_stat(os.stat(data_path).st_ctime)
    except OSError:
        pass
    payload = {
        "dataset_name": instance_name,
        "dataset_type": dataset_type,
        "reserving_class": reserving_class,
        "project_name": project_name,
        "source_kind": "engine",
        "data_format": data_format,
        "data_format_code": 1 if is_vector else 0,
        "csv_file": os.path.basename(data_path),
        "user": user_name,
        "created": created,
        "modified_by": user_name,
        "updated_at": updated_at,
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_NONE,
        "status": dataset_sidecar_status_service.STATUS_CURRENT,
    }
    _set_processing_provenance(payload, project_name, data_path)
    _apply_dataset_sidecar_shape_fields(payload, pairs, is_vector=is_vector)
    from app_server.services import calculated_dataset_service
    from app_server.services.dataset_service import _append_dataset_audit_entry

    calculated_dataset_service.apply_sidecar_graph_fields(
        payload,
        _pair_value(pairs, "ProjectName"),
        dataset_type,
    )
    _append_dataset_audit_entry(payload, "Insert", event_date=updated_at, user_name=user_name)
    tmp_path = f"{sidecar_path}.{uuid.uuid4()}.tmp"
    os.makedirs(os.path.dirname(sidecar_path), exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp_path, sidecar_path)
    dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
        project_name,
        reserving_class,
        [instance_name, dataset_type],
    )


def _refresh_dataset_instance_index_after_cache_write(pairs: list) -> None:
    project_name = _pair_value(pairs, "ProjectName")
    reserving_class = _pair_value(pairs, "Path")
    if not project_name or not reserving_class:
        return
    try:
        dataset_instance_index_service.rebuild_index(project_name, reserving_class)
    except Exception:
        return


def arcrho_tri_cache_matches(data_path: str, pairs: list) -> bool:
    if not os.path.exists(data_path):
        return False
    sidecar_path = _dataset_sidecar_path(data_path, pairs)
    if not os.path.exists(sidecar_path):
        return False
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    expected_name = _pair_value(pairs, "InstanceName")
    dataset_type = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    if not expected_name:
        expected_name = dataset_type
    if not _cache_payload_name_matches(payload, expected_name):
        return False
    if not _cache_text_matches(payload.get("reserving_class"), _pair_value(pairs, "Path")):
        return False
    if not _cache_text_matches(payload.get("project_name"), _pair_value(pairs, "ProjectName")):
        return False
    if not _processing_config_matches(payload, pairs, data_path):
        return False
    if not _pair_value(pairs, "InstanceName") and dataset_type:
        payload_type = payload.get("dataset_type")
        if payload_type and not _cache_text_matches(payload_type, dataset_type):
            return False
    return True


def _require_valid_header_project_settings(pairs: list) -> Dict[str, Any]:
    project_name = _pair_value(pairs, "ProjectName")
    settings = project_settings_service.get_general_settings(project_name)
    data = settings.get("data") if isinstance(settings.get("data"), dict) else {}
    origin_start = str(data.get("origin_start_date") or "").strip()
    match = re.fullmatch(r"(\d{4})(0[1-9]|1[0-2])", origin_start)
    if not settings.get("exists") or not match or int(match.group(1)) <= 0:
        raise HTTPException(
            422,
            f"Cannot load ArcRho project headers for '{project_name}': Origin Start Date is missing or invalid. "
            "Set a valid Origin Start Date in Project Settings, then try again.",
        )
    return settings


def arcrho_headers(pairs: list, timeout_sec: float) -> Dict[str, Any]:
    settings = _require_valid_header_project_settings(pairs)
    data_path = set_data_path_like_vba(pairs)
    request_file = None

    settings_path = str(settings.get("path") or "").strip()
    if os.path.exists(data_path) and settings_path and os.path.exists(settings_path):
        try:
            if os.path.getmtime(data_path) < os.path.getmtime(settings_path):
                os.remove(data_path)
        except PermissionError:
            raise HTTPException(423, "ArcRho project headers cache is locked or inaccessible.")
        except OSError as err:
            raise HTTPException(500, f"Failed to refresh ArcRho project headers cache: {str(err)}")

    if not os.path.exists(data_path):
        try:
            os.makedirs(os.path.dirname(data_path), exist_ok=True)
        except OSError as err:
            raise HTTPException(500, f"Failed to create ArcRho headers data folder: {str(err)}")
        request_info = "#".join([f"{k} = {v}" for k, v in pairs] + [f"DataPath = {data_path}"])
        request_file = send_request_like_vba(request_info)

        ok = wait_for_file(data_path, timeout_sec=max(0.1, float(timeout_sec)))
        if not ok:
            return {
                "ok": False,
                "status": "timeout",
                "message": "Timed out while loading ArcRho project headers. Verify the data engine is running, then try again.",
                "request_file": request_file,
                "data_path": data_path,
            }

    with open(data_path, "r", encoding="utf-8") as f:
        raw = f.read().strip()

    parts = [x.strip() for x in raw.replace("\n", ",").split(",") if x.strip()]

    return {
        "ok": True,
        "labels": parts,
        "request_file": request_file,
        "data_path": data_path,
    }


def _header_cache_pairs(project_name: str, period_type: int, transposed: bool, period_length: int, calendar: bool = False) -> list:
    return [
        ("Function", "ArcRhoHeaders"),
        ("periodType", str(period_type)),
        ("Transposed", str(transposed)),
        ("Calendar", str(calendar)),
        ("PeriodLength", str(period_length)),
        ("ProjectName", project_name),
        ("StoredPeriodLength", str(-1)),
    ]


def get_project_headers(
    project_name: str,
    period_length: int,
    timeout_sec: float,
    *,
    period_type: int = 0,
    transposed: bool = False,
    calendar: bool = False,
) -> Dict[str, Any]:
    """Load ArcRho headers for a project without exposing request-pair details."""
    project = str(project_name or "").strip()
    if not project:
        raise HTTPException(400, "ProjectName is required")
    try:
        length = int(period_length)
    except (TypeError, ValueError):
        raise HTTPException(400, "PeriodLength must be a positive integer")
    if length <= 0:
        raise HTTPException(400, "PeriodLength must be a positive integer")
    pairs = _header_cache_pairs(project, int(period_type), bool(transposed), length, bool(calendar))
    return arcrho_headers(pairs, timeout_sec=max(0.1, float(timeout_sec)))


def _target_header_cache_paths(project_name: str, origin_length: Any, development_length: Any) -> list[str]:
    targets: list[str] = []
    seen = set()
    specs = (
        (0, False, origin_length, False),
        (1, True, development_length, False),
        (1, True, development_length, True),
    )
    for period_type, transposed, length, calendar in specs:
        try:
            period_length = int(length)
        except (TypeError, ValueError):
            continue
        if period_length <= 0:
            continue
        path = set_data_path_like_vba(_header_cache_pairs(project_name, period_type, transposed, period_length, calendar))
        normalized = os.path.normcase(os.path.abspath(path))
        if normalized in seen:
            continue
        seen.add(normalized)
        targets.append(path)
    return targets


def clear_arcrho_headers_cache(project_name: str, origin_length: Any = None, development_length: Any = None) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "ProjectName is required")

    try:
        data_dir = config.get_project_data_dir(project_name_clean)
    except ValueError as e:
        raise HTTPException(404, str(e))

    cleared_files = []
    target_paths = _target_header_cache_paths(project_name_clean, origin_length, development_length)
    if target_paths:
        try:
            for path in target_paths:
                if not os.path.exists(path):
                    continue
                os.remove(path)
                cleared_files.append(os.path.basename(path))
        except PermissionError:
            raise HTTPException(423, "Cannot clear ArcRhoHeaders cache files because the project data folder is locked.")
        except OSError as e:
            raise HTTPException(500, f"Failed to clear ArcRhoHeaders cache files: {str(e)}")

        return {
            "ok": True,
            "project_name": project_name_clean,
            "data_dir": data_dir,
            "cleared_count": len(cleared_files),
            "cleared_files": cleared_files,
            "targeted": True,
        }

    if not os.path.isdir(data_dir):
        return {
            "ok": True,
            "project_name": project_name_clean,
            "data_dir": data_dir,
            "cleared_count": 0,
            "cleared_files": [],
            "targeted": False,
        }

    try:
        with os.scandir(data_dir) as it:
            for entry in it:
                if not entry.is_file():
                    continue
                name_l = entry.name.strip().lower()
                if not name_l.endswith(".csv"):
                    continue
                if not name_l.startswith("arcrhoheaders"):
                    continue
                os.remove(entry.path)
                cleared_files.append(entry.name)
    except PermissionError:
        raise HTTPException(423, "Cannot clear ArcRhoHeaders cache files because the project data folder is locked.")
    except OSError as e:
        raise HTTPException(500, f"Failed to clear ArcRhoHeaders cache files: {str(e)}")

    return {
        "ok": True,
        "project_name": project_name_clean,
        "data_dir": data_dir,
        "cleared_count": len(cleared_files),
        "cleared_files": cleared_files,
        "targeted": False,
    }


def arcrho_projects() -> Dict[str, Any]:
    seen = set()
    out = []
    index_data = project_settings_service._read_project_index()
    for item in index_data.get("projects", []):
        name = str(item.get("name", "") or "").strip()
        if name and name not in seen:
            out.append(name)
            seen.add(name)

    return {"sheet": "Virtual Projects", "projects": out, "folders": index_data.get("folders", [])}


def _local_cache_response(local_result: Dict[str, Any], data_path: str, pairs: list | None = None) -> Dict[str, Any]:
    ds_id = _register_arcrho_dataset(data_path, pairs)
    return {
        "ok": True,
        "need_request": False,
        "ds_id": ds_id,
        "request_file": None,
        "data_path": data_path,
        "local_cache_status": local_result.get("status"),
        "derived": local_result.get("derived"),
        "calculated_updates": None,
    }


def _normalize_temporary_session_id(value: Any) -> str:
    try:
        return str(uuid.UUID(str(value or "").strip()))
    except (AttributeError, TypeError, ValueError) as err:
        raise HTTPException(422, "TemporarySessionId must be a valid UUID.") from err


def _path_is_within_folder(path: str, folder: str) -> bool:
    child = os.path.normcase(os.path.abspath(path))
    parent = os.path.normcase(os.path.abspath(folder))
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def _temporary_dataset_path(data_path: str, pairs: list) -> str:
    project_name = _pair_value(pairs, "ProjectName")
    reserving_class = _pair_value(pairs, "Path")
    if not project_name:
        raise HTTPException(400, "ProjectName is required for a temporary dataset request.")
    if not reserving_class:
        raise HTTPException(400, "Path is required for a temporary dataset request.")

    temporary_cache_dir = config.get_project_temporary_view_dataset_cache_dir(
        project_name,
        reserving_class,
    )

    dataset_filename = os.path.basename(data_path)
    if not dataset_filename:
        raise HTTPException(400, "Temporary dataset cache file name is invalid.")
    temporary_data_path = os.path.join(temporary_cache_dir, dataset_filename)
    if not _path_is_within_folder(temporary_data_path, temporary_cache_dir):
        raise HTTPException(400, "Temporary dataset path is outside its cache folder.")
    return temporary_data_path


def _temporary_dataset_response(
    data_path: str,
    pairs: list,
    temporary_session_id: str,
    *,
    need_request: bool,
    request_file: str | None,
    local_result: Dict[str, Any] | None = None,
    force_refresh: bool = False,
    cache_cleared: bool = False,
) -> Dict[str, Any]:
    ds_id = _register_arcrho_dataset(data_path, pairs)
    out: Dict[str, Any] = {
        "ok": True,
        "need_request": need_request,
        "ds_id": ds_id,
        "request_file": request_file,
        "data_path": data_path,
        "local_cache_status": (local_result or {}).get("status") or "temporary_cache",
        "derived": (local_result or {}).get("derived"),
        "calculated_updates": None,
        "sidecar_written": False,
        "temporary_cache": True,
        "temporary_session_id": temporary_session_id,
    }
    if force_refresh:
        out["cache_cleared"] = cache_cleared
    return out


def arcrho_precheck(
    data_path: str,
    pairs: list,
    *,
    local_only: bool = False,
    allow_derived: bool = True,
    temporary_session_id: str | None = None,
) -> Dict[str, Any]:
    session_id = _normalize_temporary_session_id(temporary_session_id) if temporary_session_id else None
    temporary_data_path = _temporary_dataset_path(data_path, pairs) if session_id else None
    local_result = resolve_local_triangle_cache(
        data_path,
        pairs,
        allow_derived=allow_derived,
        materialize=False,
        local_only=local_only,
    )
    local_available = bool(local_result.get("ok"))
    canonical_cache_exact = local_result.get("status") == "cache_exact"
    temporary_cache_exists = bool(temporary_data_path and os.path.isfile(temporary_data_path))
    use_temporary_cache = temporary_cache_exists and not canonical_cache_exact
    cache_exists = local_available or temporary_cache_exists
    manual_source_found = bool(local_result.get("manual_source_found"))
    generated_source_found = bool(local_result.get("generated_source_found"))
    need_request = not cache_exists and not manual_source_found and (not local_only or generated_source_found)
    resolved_data_path = (
        temporary_data_path
        if temporary_data_path and not canonical_cache_exact
        else data_path
    )
    result = {
        "ok": True,
        "need_request": need_request,
        "cache_exists": cache_exists,
        "data_path": resolved_data_path,
        "ds_id": _arcrho_dataset_id(resolved_data_path, pairs),
        "local_cache_status": "temporary_cache" if use_temporary_cache else local_result.get("status"),
        "local_cache_message": None if use_temporary_cache else local_result.get("message"),
        "manual_source_found": manual_source_found,
        "generated_source_found": generated_source_found,
    }
    if session_id:
        result["temporary_session_id"] = session_id
        result["temporary_cache"] = use_temporary_cache
    return result


def _run_temporary_arcrho_tri(
    pairs: list,
    data_path: str,
    timeout_sec: float,
    *,
    temporary_session_id: str,
    force_refresh: bool,
    local_only: bool,
    allow_derived: bool,
) -> Dict[str, Any]:
    session_id = _normalize_temporary_session_id(temporary_session_id)
    temporary_data_path = _temporary_dataset_path(data_path, pairs)

    local_result = resolve_local_triangle_cache(
        data_path,
        pairs,
        allow_derived=allow_derived,
        materialize=False,
        local_only=local_only,
    )
    if local_result.get("ok") and local_result.get("status") == "cache_exact" and not force_refresh:
        out = _local_cache_response(local_result, data_path, pairs)
        out["temporary_cache"] = False
        out["temporary_session_id"] = session_id
        return out

    temporary_cache_exists = os.path.isfile(temporary_data_path)
    if temporary_cache_exists and not force_refresh:
        return _temporary_dataset_response(
            temporary_data_path,
            pairs,
            session_id,
            need_request=False,
            request_file=None,
        )

    if local_result.get("ok") and local_result.get("status") == "cache_derivable" and not force_refresh:
        derived_result = resolve_local_triangle_cache(
            data_path,
            pairs,
            allow_derived=allow_derived,
            materialize=True,
            local_only=local_only,
            materialize_path=temporary_data_path,
            refresh_index_on_materialize=False,
        )
        if derived_result.get("ok"):
            derived_data_path = str(derived_result.get("data_path") or temporary_data_path)
            if os.path.normcase(os.path.abspath(derived_data_path)) == os.path.normcase(os.path.abspath(data_path)):
                out = _local_cache_response(derived_result, data_path, pairs)
                out["temporary_cache"] = False
                out["temporary_session_id"] = session_id
                return out
            return _temporary_dataset_response(
                derived_data_path,
                pairs,
                session_id,
                need_request=False,
                request_file=None,
                local_result=derived_result,
            )
        local_result = derived_result

    manual_source_found = bool(local_result.get("manual_source_found"))
    generated_source_found = bool(local_result.get("generated_source_found"))
    if (local_only and not generated_source_found) or manual_source_found:
        message = str(local_result.get("message") or "Input triangle cache is not available.")
        if force_refresh and manual_source_found:
            message = "Manual input triangle caches cannot be refreshed from the DFM/Dataset loader."
        return {
            "ok": False,
            "status": local_result.get("status") or "local_cache_unavailable",
            "need_request": False,
            "data_path": temporary_data_path,
            "message": message,
            "local_only": bool(local_only),
            "manual_source_found": manual_source_found,
            "temporary_session_id": session_id,
        }

    cache_cleared = False
    if (force_refresh or not temporary_cache_exists) and os.path.exists(temporary_data_path):
        try:
            os.remove(temporary_data_path)
            cache_cleared = True
        except OSError as err:
            raise HTTPException(423, f"Cannot clear temporary ArcRho tri file: {str(err)}") from err

    need_request = force_refresh or not temporary_cache_exists
    request_file = None
    if need_request:
        try:
            os.makedirs(os.path.dirname(temporary_data_path), exist_ok=True)
        except OSError as err:
            raise HTTPException(500, f"Failed to create temporary ArcRho tri data folder: {str(err)}") from err
        request_info = "#".join([f"{k} = {v}" for k, v in pairs] + [f"DataPath = {temporary_data_path}"])
        request_file = send_request_like_vba(request_info)

        ok = wait_for_file(temporary_data_path, timeout_sec=max(0.1, float(timeout_sec)))
        if not ok:
            timeout_out: Dict[str, Any] = {
                "ok": False,
                "status": "timeout",
                "need_request": True,
                "request_file": request_file,
                "data_path": temporary_data_path,
                "temporary_cache": True,
                "temporary_session_id": session_id,
            }
            if force_refresh:
                timeout_out["cache_cleared"] = cache_cleared
            return timeout_out

    return _temporary_dataset_response(
        temporary_data_path,
        pairs,
        session_id,
        need_request=need_request,
        request_file=request_file,
        force_refresh=force_refresh,
        cache_cleared=cache_cleared,
    )


def run_arcrho_tri(
    pairs: list,
    data_path: str,
    timeout_sec: float,
    force_refresh: bool = False,
    local_only: bool = False,
    allow_derived: bool = True,
    write_sidecar: bool = True,
    temporary_session_id: str | None = None,
) -> Dict[str, Any]:
    if temporary_session_id:
        return _run_temporary_arcrho_tri(
            pairs,
            data_path,
            timeout_sec,
            temporary_session_id=temporary_session_id,
            force_refresh=force_refresh,
            local_only=local_only,
            allow_derived=allow_derived,
        )

    request_file = None
    cache_cleared = False

    local_result = resolve_local_triangle_cache(data_path, pairs, allow_derived=allow_derived, local_only=local_only)
    if local_result.get("ok") and not force_refresh:
        return _local_cache_response(local_result, data_path, pairs)
    manual_source_found = bool(local_result.get("manual_source_found"))
    generated_source_found = bool(local_result.get("generated_source_found"))
    if (local_only and not generated_source_found) or manual_source_found:
        message = str(local_result.get("message") or "Input triangle cache is not available.")
        if force_refresh and manual_source_found:
            message = "Manual input triangle caches cannot be refreshed from the DFM/Dataset loader."
        return {
            "ok": False,
            "status": local_result.get("status") or "local_cache_unavailable",
            "need_request": False,
            "data_path": data_path,
            "message": message,
            "local_only": bool(local_only),
            "manual_source_found": manual_source_found,
        }

    cache_matches = arcrho_tri_cache_matches(data_path, pairs)
    if (force_refresh or not cache_matches) and os.path.exists(data_path):
        try:
            os.remove(data_path)
            cache_cleared = True
        except OSError as e:
            raise HTTPException(423, f"Cannot clear cached ArcRho tri file: {str(e)}")

    need_request = force_refresh or (not cache_matches)
    if need_request:
        try:
            os.makedirs(os.path.dirname(data_path), exist_ok=True)
        except OSError as err:
            raise HTTPException(500, f"Failed to create ArcRho tri data folder: {str(err)}")
        request_info = "#".join([f"{k} = {v}" for k, v in pairs] + [f"DataPath = {data_path}"])
        request_file = send_request_like_vba(request_info)

        ok = wait_for_file(data_path, timeout_sec=max(0.1, float(timeout_sec)))
        if not ok:
            timeout_out: Dict[str, Any] = {
                "ok": False,
                "status": "timeout",
                "need_request": True,
                "request_file": request_file,
                "data_path": data_path,
            }
            if force_refresh:
                timeout_out["cache_cleared"] = cache_cleared
            return timeout_out

    if not write_sidecar:
        try:
            _refresh_dataset_instance_index_after_cache_write(pairs)
        except Exception:
            pass
        ds_id = _register_arcrho_dataset(data_path, pairs)
        out: Dict[str, Any] = {
            "ok": True,
            "need_request": need_request,
            "ds_id": ds_id,
            "request_file": request_file,
            "data_path": data_path,
            "calculated_updates": None,
            "sidecar_written": False,
        }
        if force_refresh:
            out["cache_cleared"] = cache_cleared
        return out

    calculated_updates = None
    try:
        _write_dataset_sidecar(data_path, pairs)
        _refresh_dataset_instance_index_after_cache_write(pairs)
        try:
            from app_server.services import calculated_dataset_service

            calculated_updates = calculated_dataset_service.recalculate_dependents(
                _pair_value(pairs, "ProjectName"),
                _pair_value(pairs, "Path"),
                _pair_value(pairs, "InstanceName") or _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName"),
                _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName"),
            )
        except Exception as err:
            calculated_updates = {"ok": False, "skipped": True, "reason": str(err)}
    except OSError as err:
        raise HTTPException(500, f"Failed to write ArcRho tri dataset metadata: {str(err)}")

    ds_id = _register_arcrho_dataset(data_path, pairs)

    out: Dict[str, Any] = {
        "ok": True,
        "need_request": need_request,
        "ds_id": ds_id,
        "request_file": request_file,
        "data_path": data_path,
        "calculated_updates": calculated_updates,
    }
    if force_refresh:
        out["cache_cleared"] = cache_cleared
    return out
