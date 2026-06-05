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
from app_server.services import book_service, dataset_instance_index_service


def _pair_value(pairs: list, key: str) -> str:
    key_l = key.strip().lower()
    for pair_key, pair_value in pairs:
        if str(pair_key or "").strip().lower() == key_l:
            return str(pair_value or "").strip()
    return ""


def _dataset_sidecar_path(data_path: str, pairs: list) -> str:
    dataset_name = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    dataset_file = sanitize_dataset_file_name(dataset_name)
    return os.path.join(os.path.dirname(data_path), f"{dataset_file}.json")


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
    dataset_name = _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName")
    if not dataset_name:
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
        "dataset_name": dataset_name,
        "dataset_type": dataset_name,
        "instance_name": dataset_name,
        "reserving_class": _pair_value(pairs, "Path"),
        "project_name": _pair_value(pairs, "ProjectName"),
        "storage": "generated",
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
        "dataset_name": _pair_value(pairs, "DatasetName") or _pair_value(pairs, "TriangleName"),
        "reserving_class": _pair_value(pairs, "Path"),
        "project_name": _pair_value(pairs, "ProjectName"),
    }
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
        data_dir = config.get_project_generated_data_dir(project_name_clean)
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
    if not os.path.exists(config.PROJECT_BOOK):
        raise HTTPException(404, f"Project map file not found: {config.PROJECT_BOOK}")

    data = book_service._load_project_map_data(config.PROJECT_BOOK)
    sheet_names = book_service._project_map_sheet_names(data)
    if not sheet_names:
        raise HTTPException(400, "No sheet data found in project map JSON.")
    first_sheet = sheet_names[0]

    values = book_service._read_project_map_sheet_matrix(config.PROJECT_BOOK, first_sheet, max_rows=5000, max_cols=50)

    vals = []
    for row in values:
        if not row:
            continue
        v = row[0]
        if v is None:
            continue
        s = str(v).strip()
        if s:
            vals.append(s)

    if vals and vals[0].strip().lower() in ("project name", "projectname"):
        vals = vals[1:]

    seen = set()
    out = []
    for x in vals:
        if x not in seen:
            out.append(x)
            seen.add(x)

    return {"sheet": first_sheet, "projects": out}


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

    try:
        _write_dataset_sidecar(data_path, pairs)
        _refresh_dataset_instance_index_after_cache_write(pairs)
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
    }
    if force_refresh:
        out["cache_cleared"] = cache_cleared
    return out
