"""ArcRho runtime request operations."""
from __future__ import annotations

import os
import hashlib
import getpass
import json
import uuid
from datetime import datetime
from typing import Any, Dict

from fastapi import HTTPException

from app_server import config
from app_server.helpers import sanitize_dataset_file_name, set_data_path_like_vba, send_request_like_vba, wait_for_file
from app_server.services import dataset_instance_index_service, project_settings_service


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


def _write_dataset_sidecar(data_path: str, pairs: list) -> None:
    dataset_type = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    instance_name = _pair_value(pairs, "InstanceName") or dataset_type
    if not instance_name:
        return
    sidecar_path = _dataset_sidecar_path(data_path, pairs)
    if os.path.exists(sidecar_path):
        return
    user_name = getpass.getuser()
    created = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    try:
        created = _utc_timestamp_from_stat(os.stat(data_path).st_ctime)
    except OSError:
        pass
    payload = {
        "dataset_name": instance_name,
        "dataset_type": dataset_type,
        "instance_name": instance_name,
        "reserving_class": _pair_value(pairs, "Path"),
        "project_name": _pair_value(pairs, "ProjectName"),
        "source_kind": "engine",
        "generated": True,
        "editable": False,
        "data_format": "Triangle",
        "data_format_code": 0,
        "origin_length": _pair_int_value(pairs, "OriginLength", 12),
        "development_length": _pair_int_value(pairs, "DevelopmentLength", 12),
        "cumulative": _pair_bool_value(pairs, "Cumulative", True),
        "calendar": _pair_bool_value(pairs, "Calendar", False),
        "csv_file": os.path.basename(data_path),
        "user": user_name,
        "created": created,
        "modified_by": user_name,
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    tmp_path = f"{sidecar_path}.{uuid.uuid4()}.tmp"
    os.makedirs(os.path.dirname(sidecar_path), exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp_path, sidecar_path)


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
    checks = {
        "dataset_name": _pair_value(pairs, "InstanceName") or _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName"),
        "reserving_class": _pair_value(pairs, "Path"),
        "project_name": _pair_value(pairs, "ProjectName"),
    }
    dataset_type = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    if dataset_type:
        checks["dataset_type"] = dataset_type
    for key, value in checks.items():
        if isinstance(value, bool):
            if bool(payload.get(key)) != value:
                return False
        elif isinstance(value, int):
            try:
                if int(payload.get(key)) != value:
                    return False
            except (TypeError, ValueError):
                return False
        elif str(payload.get(key) or "").strip() != value:
            return False
    return True


def arcrho_headers(pairs: list, timeout_sec: float) -> Dict[str, Any]:
    data_path = set_data_path_like_vba(pairs)
    request_file = None

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


def run_arcrho_tri(pairs: list, data_path: str, timeout_sec: float, force_refresh: bool = False) -> Dict[str, Any]:
    request_file = None
    cache_cleared = False

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

    ds_id = "arcrhotri_" + hashlib.sha1(data_path.encode("utf-8")).hexdigest()[:16]
    config.DATASETS[ds_id] = data_path

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
