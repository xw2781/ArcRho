"""Result Selection RPC bridge request and comparison operations."""
from __future__ import annotations

import getpass
import json
import os
from datetime import datetime
from typing import Any, Dict

from fastapi import HTTPException

from app_server import config
from app_server.helpers import (
    parse_method_last_modified_timestamp,
    sanitize_dataset_file_name,
    wait_for_file,
)
from app_server.schemas.result_selection_rpc_bridge import ResultSelectionRpcBridgeRequest

RPC_BRIDGE_DIR_NAME = "RPC bridge"
RPC_BRIDGE_TMP_DIR_NAME = "tmp_rpc"
RESULT_SELECTION_FUNCTION_NAME = "ResultSelection"
SYNC_RESULT_SELECTION_FUNCTION_NAME = "SyncResultSelection"


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _json_tab(payload: Dict[str, Any], tab_name: str) -> Dict[str, Any]:
    tab = payload.get(tab_name) if isinstance(payload, dict) else None
    return tab if isinstance(tab, dict) else {}


def _sanitize_project_dir_name(value: str) -> str:
    return config._sanitize_project_dir_name(_clean_text(value))


def _require_project_dir(project_name: str) -> str:
    project = _clean_text(project_name)
    if not project:
        raise HTTPException(400, "project_name is required.")
    project_dir = config._find_existing_project_dir(project)
    if project_dir:
        return project_dir
    sanitized = _sanitize_project_dir_name(project)
    if not sanitized:
        raise HTTPException(400, "project_name is required.")
    return os.path.join(config.PROJECT_SETTINGS_DIR, sanitized)


def _build_method_filename(req: ResultSelectionRpcBridgeRequest) -> str:
    method_name = sanitize_dataset_file_name(req.method_name, "Name")
    return f"RS@{method_name}.json"


def build_paths(req: ResultSelectionRpcBridgeRequest) -> Dict[str, str]:
    project_dir = _require_project_dir(req.project_name)
    method_dir = config.get_project_method_data_dir(req.project_name, req.reserving_class)
    rpc_methods_dir = os.path.join(method_dir, RPC_BRIDGE_TMP_DIR_NAME)
    request_dir = os.path.join(config.REQUEST_DIR, RPC_BRIDGE_DIR_NAME)
    filename = _build_method_filename(req)
    sync_filename = f"{SYNC_RESULT_SELECTION_FUNCTION_NAME}@{sanitize_dataset_file_name(req.method_name, 'Name')}.json"
    return {
        "project_dir": project_dir,
        "data_dir": os.path.join(project_dir, config.PROJECT_DATA_DIR),
        "method_dir": method_dir,
        "rpc_methods_dir": rpc_methods_dir,
        "request_dir": request_dir,
        "local_path": os.path.join(method_dir, filename),
        "remote_path": os.path.join(rpc_methods_dir, filename),
        "sync_status_path": os.path.join(rpc_methods_dir, sync_filename),
    }


def _request_payload(
    req: ResultSelectionRpcBridgeRequest,
    function_name: str,
    data_path: str,
    extra_fields: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "Function": function_name,
        "ProjectName": req.project_name,
        "Path": req.reserving_class,
        "MethodName": req.method_name,
        "OutputVector": req.method_name,
        "OutputType": req.output_type,
        "OriginLength": req.origin_length,
        "DataPath": data_path,
        "UserName": getpass.getuser(),
    }
    payload.update(extra_fields or {})
    return payload


def _write_request_file(
    req: ResultSelectionRpcBridgeRequest,
    function_name: str,
    data_path: str,
    request_dir: str,
    extra_fields: Dict[str, Any] | None = None,
) -> str:
    os.makedirs(request_dir, exist_ok=True)
    now = datetime.now()
    timestamp = now.strftime("%Y-%m-%d_%H-%M-%S") + f".{int(now.microsecond / 1000):03d}"
    stem = f"request-{function_name}-{timestamp}"
    temp_path = os.path.join(request_dir, f"{stem}.tmp")
    final_path = os.path.join(request_dir, f"{stem}.json")
    payload = _request_payload(req, function_name, data_path, extra_fields)
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        if os.path.exists(final_path):
            raise HTTPException(409, "Request file name collision and cannot overwrite.")
        os.replace(temp_path, final_path)
    except HTTPException:
        _try_remove(temp_path)
        raise
    except PermissionError:
        _try_remove(temp_path)
        raise HTTPException(423, "Request folder is locked or inaccessible.")
    except OSError as err:
        _try_remove(temp_path)
        raise HTTPException(500, f"Failed to write request file: {str(err)}")
    return final_path


def _try_remove(path: str) -> bool:
    if not path:
        return False
    try:
        if os.path.exists(path):
            os.remove(path)
            return True
    except OSError:
        return False
    return False


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        raise HTTPException(404, f"JSON file not found: {path}")
    except PermissionError:
        raise HTTPException(423, f"JSON file is locked or inaccessible: {path}")
    except json.JSONDecodeError as err:
        raise HTTPException(500, f"Invalid JSON format in {path}: {str(err)}")
    except OSError as err:
        raise HTTPException(500, f"Failed to read JSON file: {str(err)}")
    if not isinstance(data, dict):
        raise HTTPException(500, f"Expected JSON object in {path}.")
    return data


def _json_last_modified_meta(path: str) -> Dict[str, Any]:
    try:
        payload = _read_json(path)
    except HTTPException as err:
        return {
            "last_modified": "",
            "last_modified_timestamp": None,
            "last_modified_error": _clean_text(err.detail),
        }
    raw = _json_tab(payload, "method_metadata").get("last_modified")
    return {
        "last_modified": _clean_text(raw),
        "last_modified_timestamp": parse_method_last_modified_timestamp(raw),
        "last_modified_error": "",
    }


def _file_meta(path: str) -> Dict[str, Any]:
    exists = os.path.exists(path)
    out: Dict[str, Any] = {
        "path": path,
        "exists": exists,
        "mtime": None,
        "mtime_iso": "",
        "size": None,
        "last_modified": "",
        "last_modified_timestamp": None,
        "last_modified_error": "",
    }
    if not exists:
        return out
    try:
        st = os.stat(path)
    except PermissionError:
        raise HTTPException(423, f"File is locked or inaccessible: {path}")
    except OSError as err:
        raise HTTPException(500, f"Failed to stat file: {str(err)}")
    out["mtime"] = st.st_mtime
    out["mtime_iso"] = datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
    out["size"] = st.st_size
    out.update(_json_last_modified_meta(path))
    return out


def _normalize_weight(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _source_snapshot(source: Any) -> Dict[str, Any] | None:
    if not isinstance(source, dict):
        return None
    weights_raw = source.get("weights") if isinstance(source.get("weights"), list) else []
    values_raw = source.get("values") if isinstance(source.get("values"), list) else []
    weights = [_normalize_weight(item) for item in weights_raw]
    return {
        "name": _clean_text(source.get("name")),
        "dataset_type": _clean_text(source.get("dataset_type")),
        "data_format": _clean_text(source.get("data_format")),
        "method_type": _clean_text(source.get("method_type")),
        "origin_length": source.get("origin_length"),
        "rows": max(len(weights_raw), len(values_raw)),
        "selected_count": sum(1 for item in weights if item > 0),
        "weight_sum": sum(item for item in weights if item > 0),
        "weights": weights[:160],
        "values_preview": values_raw[:12],
    }


def _build_json_snapshot(path: str) -> Dict[str, Any]:
    empty = {
        "available": False,
        "error": "",
        "status": "",
        "message": "",
        "json_format": "",
        "name": "",
        "output_type": "",
        "origin_length": None,
        "source_count": 0,
        "selected_count": 0,
        "loaded_datasets": [],
        "origin_labels": [],
        "calculated_ultimate_preview": [],
        "selected_ultimate_preview": [],
        "ultimate_overrides_preview": [],
        "last_modified": "",
    }
    if not os.path.exists(path):
        return empty
    try:
        payload = _read_json(path)
    except HTTPException as err:
        return {**empty, "error": _clean_text(err.detail)}
    json_format = _clean_text(payload.get("json_format"))
    status = _clean_text(payload.get("status"))
    message = _clean_text(payload.get("message"))
    if json_format != "arcrho-result-selection-method-by-tab-v2":
        if status or message or payload.get("ok") is False:
            detail = message or status or "Bridge returned a status JSON instead of Result Selection method JSON."
            return {
                **empty,
                "available": True,
                "error": detail,
                "status": status,
                "message": message,
                "json_format": json_format,
            }
        return {
            **empty,
            "available": True,
            "error": "This JSON is not a Result Selection method payload.",
            "json_format": json_format,
        }
    details = _json_tab(payload, "details_tab")
    method = _json_tab(payload, "method_tab")
    loaded_datasets = [
        item for item in (_source_snapshot(source) for source in method.get("loaded_datasets", []))
        if item is not None
    ] if isinstance(method.get("loaded_datasets"), list) else []
    return {
        "available": True,
        "error": "",
        "status": status,
        "message": message,
        "json_format": json_format,
        "name": _clean_text(details.get("name")),
        "output_type": _clean_text(details.get("output_type")),
        "origin_length": details.get("origin_length"),
        "source_count": len(loaded_datasets),
        "selected_count": sum(int(source.get("selected_count") or 0) for source in loaded_datasets),
        "loaded_datasets": loaded_datasets,
        "origin_labels": method.get("origin_labels", []) if isinstance(method.get("origin_labels"), list) else [],
        "calculated_ultimate_preview": method.get("calculated_ultimate", [])[:12] if isinstance(method.get("calculated_ultimate"), list) else [],
        "selected_ultimate_preview": method.get("selected_ultimate", [])[:12] if isinstance(method.get("selected_ultimate"), list) else [],
        "ultimate_overrides_preview": method.get("ultimate_overrides", [])[:12] if isinstance(method.get("ultimate_overrides"), list) else [],
        "last_modified": _clean_text(_json_tab(payload, "method_metadata").get("last_modified")),
    }


def _compare_state(local_meta: Dict[str, Any], remote_meta: Dict[str, Any]) -> str:
    local_exists = bool(local_meta.get("exists"))
    remote_exists = bool(remote_meta.get("exists"))
    if local_exists and remote_exists:
        local_modified = float(local_meta.get("last_modified_timestamp") or 0)
        remote_modified = float(remote_meta.get("last_modified_timestamp") or 0)
        if abs(local_modified - remote_modified) <= 1e-6:
            return "same_time"
        return "remote_latest" if remote_modified > local_modified else "local_latest"
    if local_exists:
        return "remote_missing"
    if remote_exists:
        return "local_missing"
    return "both_missing"


def compare(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    local_meta = _file_meta(paths["local_path"])
    remote_meta = _file_meta(paths["remote_path"])
    return {
        "ok": True,
        "status": "compared",
        "comparison": _compare_state(local_meta, remote_meta),
        "local": local_meta,
        "remote": remote_meta,
        "snapshots": {
            "local": _build_json_snapshot(paths["local_path"]),
            "remote": _build_json_snapshot(paths["remote_path"]),
        },
        "labels": {
            "local": "ArcRho - Local",
            "remote": "ResQ - Remote",
        },
        "actions": {
            "local": "update-remote" if bool(local_meta.get("exists")) else "",
            "remote": "update-local" if bool(remote_meta.get("exists")) else "",
        },
        "paths": paths,
    }


def send_sync_request(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    os.makedirs(paths["rpc_methods_dir"], exist_ok=True)
    stale_remote_deleted = _try_remove(paths["remote_path"])
    stale_sync_status_deleted = _try_remove(paths["sync_status_path"])
    request_file = _write_request_file(req, RESULT_SELECTION_FUNCTION_NAME, paths["remote_path"], paths["request_dir"])
    ok = wait_for_file(paths["remote_path"], timeout_sec=max(0.1, float(req.timeout_sec)))
    result = compare(req)
    result.update({
        "request_file": request_file,
        "data_path": paths["remote_path"],
        "timeout_sec": req.timeout_sec,
        "stale_remote_deleted": stale_remote_deleted,
        "stale_sync_status_deleted": stale_sync_status_deleted,
    })
    if not ok:
        result["ok"] = False
        result["status"] = "timeout"
    return result


def _atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(temp_path, path)
    except PermissionError:
        _try_remove(temp_path)
        raise HTTPException(423, f"JSON file is locked or inaccessible: {path}")
    except OSError as err:
        _try_remove(temp_path)
        raise HTTPException(500, f"Failed to write JSON file: {str(err)}")


def apply_remote_to_local(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    if not os.path.exists(paths["remote_path"]):
        raise HTTPException(404, "Remote Result Selection JSON is missing.")
    remote_payload = _read_json(paths["remote_path"])
    from app_server.services import result_selection_service

    remote_payload = result_selection_service.normalize_method_payload(
        remote_payload,
        require_complete_basis=True,
    )
    if _clean_text(remote_payload.get("details_tab", {}).get("name")).casefold() != _clean_text(req.method_name).casefold():
        raise HTTPException(422, "Remote Result Selection name does not match the requested local method.")
    current = result_selection_service.load_result_selection(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
    saved = result_selection_service.save_result_selection(
        req.project_name,
        req.reserving_class,
        remote_payload,
        str(current.get("sidecar", {}).get("notes") or ""),
        str(current.get("method_revision") or ""),
    )
    deleted = _try_remove(paths["remote_path"])
    return {
        "ok": True,
        "status": "applied",
        "payload": saved["method"],
        "method_revision": saved["method_revision"],
        "sidecar": saved["sidecar"],
        "csv_path": saved["csv_path"],
        "aggregated_csv_paths": saved["aggregated_csv_paths"],
        "propagation_ok": saved.get("propagation_ok", True),
        "propagation": saved.get("propagation"),
        "index_ok": saved.get("index_ok", True),
        "index_error": saved.get("index_error", ""),
        "local": _file_meta(paths["local_path"]),
        "remote_deleted": deleted,
        "paths": paths,
    }


def keep_local(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    remote_deleted = _try_remove(paths["remote_path"])
    return {
        "ok": True,
        "status": "kept_local",
        "message": "Kept local Result Selection JSON. Remote RPC JSON was removed." if remote_deleted else "Kept local Result Selection JSON. No remote RPC JSON was found to remove.",
        "remote_deleted": remote_deleted,
        "paths": paths,
    }


def cleanup_tmp(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    remote_deleted = _try_remove(paths["remote_path"])
    sync_status_deleted = _try_remove(paths["sync_status_path"])
    return {
        "ok": True,
        "status": "cleaned",
        "remote_deleted": remote_deleted,
        "sync_status_deleted": sync_status_deleted,
        "paths": paths,
    }


def update_remote(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    if not getattr(req, "rpc_server_write_confirmed", False):
        raise HTTPException(400, "RPC server write confirmation is required before updating the remote Result Selection.")
    paths = build_paths(req)
    os.makedirs(paths["rpc_methods_dir"], exist_ok=True)
    _try_remove(paths["sync_status_path"])
    request_file = _write_request_file(
        req,
        SYNC_RESULT_SELECTION_FUNCTION_NAME,
        paths["sync_status_path"],
        paths["request_dir"],
        {
            "MethodJsonPath": paths["local_path"],
            "RPCServerWriteConfirmed": True,
        },
    )
    status_found = wait_for_file(paths["sync_status_path"], timeout_sec=max(0.1, float(req.timeout_sec)))
    remote_deleted = _try_remove(paths["remote_path"])
    if not status_found:
        return {
            "ok": False,
            "status": "timeout",
            "message": "Timed out waiting for SyncResultSelection status JSON.",
            "request_file": request_file,
            "status_path": paths["sync_status_path"],
            "remote_deleted": remote_deleted,
            "paths": paths,
        }
    status_payload = _read_json(paths["sync_status_path"])
    raw_ok = status_payload.get("ok")
    raw_status = _clean_text(status_payload.get("status"))
    status_ok = raw_ok if isinstance(raw_ok, bool) else raw_status.strip().lower() in {"passed", "success", "ok", "true"}
    status_text = raw_status or ("passed" if status_ok else "failed")
    message = _clean_text(status_payload.get("message")) or status_text
    _try_remove(paths["sync_status_path"])
    return {
        "ok": status_ok,
        "status": status_text,
        "message": message,
        "payload": status_payload,
        "request_file": request_file,
        "status_path": paths["sync_status_path"],
        "remote_deleted": remote_deleted,
        "paths": paths,
    }
