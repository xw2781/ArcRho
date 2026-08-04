"""DFM RPC bridge request and comparison operations."""
from __future__ import annotations

import getpass
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import HTTPException

from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    DfmContractError,
    apply_owned_patch,
)

from app_server import config
from app_server.helpers import sanitize_dataset_file_name, wait_for_file
from app_server.schemas.dfm_rpc_bridge import DfmRpcBridgeRequest

RPC_BRIDGE_DIR_NAME = "RPC bridge"
RPC_BRIDGE_TMP_DIR_NAME = "tmp_rpc"
DFM_FUNCTION_NAME = "DFM"
SYNC_DFM_FUNCTION_NAME = "SyncDFM"
DFM_OWNED_PATCH_FORMAT = "arcrho-dfm-owned-patch-v1"


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


def _build_method_filename(
    req: DfmRpcBridgeRequest,
    prefix: str = DFM_FUNCTION_NAME,
    *,
    include_lengths: bool = True,
) -> str:
    _ = include_lengths
    method_name = sanitize_dataset_file_name(req.method_name, "Name")
    return f"{prefix}@{method_name}.json"


def build_paths(req: DfmRpcBridgeRequest) -> Dict[str, str]:
    project_dir = _require_project_dir(req.project_name)
    data_dir = os.path.join(project_dir, config.PROJECT_DATA_DIR)
    method_dir = config.get_project_method_data_dir(req.project_name, req.reserving_class)
    rpc_methods_dir = os.path.join(method_dir, RPC_BRIDGE_TMP_DIR_NAME)
    request_dir = os.path.join(config.REQUEST_DIR, RPC_BRIDGE_DIR_NAME)
    local_path = os.path.join(method_dir, _build_method_filename(req, DFM_FUNCTION_NAME, include_lengths=False))
    remote_path = os.path.join(rpc_methods_dir, _build_method_filename(req, DFM_FUNCTION_NAME))
    sync_status_path = os.path.join(rpc_methods_dir, _build_method_filename(req, SYNC_DFM_FUNCTION_NAME))
    return {
        "project_dir": project_dir,
        "data_dir": data_dir,
        "method_dir": method_dir,
        "rpc_methods_dir": rpc_methods_dir,
        "request_dir": request_dir,
        "local_path": local_path,
        "remote_path": remote_path,
        "sync_status_path": sync_status_path,
    }


def _request_payload(
    req: DfmRpcBridgeRequest,
    function_name: str,
    data_path: str,
    extra_fields: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "Function": function_name,
        "ProjectName": req.project_name,
        "Path": req.reserving_class,
        "MethodName": req.method_name,
        "OutputVector": req.output_vector,
        "InputTriangle": req.input_triangle,
        "OriginLength": req.origin_length,
        "DevelopmentLength": req.development_length,
        "DecimalPlaces": req.decimal_places,
        "DataPath": data_path,
        "UserName": getpass.getuser(),
    }
    payload.update(extra_fields or {})
    return payload


def _write_request_file(
    req: DfmRpcBridgeRequest,
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


def _parse_last_modified_timestamp(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        raw_number = float(value)
        return raw_number if raw_number > 0 else None
    raw = _clean_text(value)
    if not raw:
        return None
    try:
        raw_number = float(raw)
    except ValueError:
        raw_number = None
    if raw_number is not None:
        return raw_number if raw_number > 0 else None

    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _json_last_modified_meta(path: str) -> Dict[str, Any]:
    try:
        payload = _read_json(path)
    except HTTPException as err:
        return {
            "last_modified": "",
            "last_modified_timestamp": None,
            "last_modified_error": _clean_text(err.detail),
        }
    raw = _json_tab(payload, "method metadata").get("last modified")
    return {
        "last_modified": _clean_text(raw),
        "last_modified_timestamp": _parse_last_modified_timestamp(raw),
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


def _extract_pattern_snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    ratios_tab = _json_tab(payload, "ratios tab")
    ratio_triangle = _json_tab(ratios_tab, "ratio triangle")
    data_tab = _json_tab(payload, "data tab")
    pattern = ratio_triangle.get("excluded")
    origin_labels = ratio_triangle.get("origin labels")
    if not isinstance(origin_labels, list):
        origin_labels = data_tab.get("origin labels")
    development_labels = ratio_triangle.get("development labels")
    if not isinstance(development_labels, list):
        development_labels = data_tab.get("development labels")
    preview_origin_labels = [
        _clean_text(label)
        for label in origin_labels
    ] if isinstance(origin_labels, list) else []
    preview_development_labels = [
        _clean_text(label)
        for label in development_labels
    ] if isinstance(development_labels, list) else []
    if not isinstance(pattern, list):
        return {
            "exists": False,
            "rows": 0,
            "columns": 0,
            "selected_count": 0,
            "preview": [],
            "origin_labels": [],
            "development_labels": [],
        }
    rows = len(pattern)
    columns = 0
    selected_count = 0
    preview = []
    for row_index, row in enumerate(pattern):
        if isinstance(row, list):
            columns = max(columns, len(row))
            normalized_row = []
            for cell in row:
                if cell in (1, True, "1", "true", "True"):
                    value = 1
                elif cell in (2, "2"):
                    value = 2
                else:
                    value = 0
                if value == 1:
                    selected_count += 1
                normalized_row.append(value)
            preview.append(normalized_row)
        else:
            preview.append([])
    return {
        "exists": True,
        "rows": rows,
        "columns": columns,
        "selected_count": selected_count,
        "preview": preview,
        "origin_labels": preview_origin_labels,
        "development_labels": preview_development_labels,
    }


def _extract_average_formula_snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    ratios_tab = _json_tab(payload, "ratios tab")
    formula_payload = ratios_tab.get("average formulas", {})
    if not isinstance(formula_payload, dict):
        formula_payload = {}
    labels = formula_payload.get("label", [])
    selected = formula_payload.get("selected", [])
    ratio_triangle = _json_tab(ratios_tab, "ratio triangle")
    data_tab = _json_tab(payload, "data tab")
    development_labels = ratio_triangle.get("development labels")
    if not isinstance(development_labels, list):
        development_labels = data_tab.get("development labels")
    preview_labels = [
        _clean_text(label)
        for label in labels
    ] if isinstance(labels, list) else []
    preview_development_labels = [
        _clean_text(label)
        for label in development_labels
    ] if isinstance(development_labels, list) else []
    if not isinstance(selected, list):
        return {
            "exists": False,
            "rows": 0,
            "columns": 0,
            "selected_count": 0,
            "preview": [],
            "formula_labels": preview_labels,
            "development_labels": preview_development_labels,
        }
    columns = 0
    selected_count = 0
    preview = []
    for row in selected:
        if isinstance(row, list):
            columns = max(columns, len(row))
            normalized_row = []
            for cell in row:
                value = 1 if cell in (1, True, "1", "true", "True") else 0
                if value == 1:
                    selected_count += 1
                normalized_row.append(value)
            preview.append(normalized_row)
        else:
            preview.append([])
    rows = max(len(preview), len(preview_labels))
    return {
        "exists": True,
        "rows": rows,
        "columns": columns,
        "selected_count": selected_count,
        "preview": preview,
        "formula_labels": preview_labels,
        "development_labels": preview_development_labels,
    }


def _extract_cell_notes_snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    ratios_tab = _json_tab(payload, "ratios tab")
    cell_notes = ratios_tab.get("cell notes", {})
    if not isinstance(cell_notes, dict):
        cell_notes = {}
    entries = []
    for table_key, table_notes in cell_notes.items():
        if not isinstance(table_notes, dict):
            continue
        for row_label, row_notes in table_notes.items():
            if not isinstance(row_notes, dict):
                continue
            for col_label, note in row_notes.items():
                text = _clean_text(note)
                if not text:
                    continue
                entries.append({
                    "table": _clean_text(table_key),
                    "row": _clean_text(row_label),
                    "column": _clean_text(col_label),
                    "note": text,
                })
    entries.sort(key=lambda item: (item["table"].lower(), item["row"].lower(), item["column"].lower(), item["note"].lower()))
    return {
        "exists": bool(entries),
        "count": len(entries),
        "entries": entries[:50],
        "truncated": len(entries) > 50,
    }


def _extract_method_notes_snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    metadata = _json_tab(payload, "method metadata")
    if "method notes" not in metadata:
        return {"exists": False, "text": ""}
    raw = metadata.get("method notes")
    return {"exists": True, "text": str(raw if raw is not None else "")}


def _sidecar_method_notes_snapshot(req: DfmRpcBridgeRequest, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Read local Method Notes from their persisted owner, the output sidecar."""
    from app_server.services import dataset_sidecar_status_service

    details = _json_tab(payload, "details tab")
    output_dataset = (
        _clean_text(details.get("output dataset"))
        or _clean_text(details.get("name"))
        or _clean_text(req.method_name)
    )
    if not output_dataset:
        return {"exists": False, "text": ""}
    path = dataset_sidecar_status_service.sidecar_path(req.project_name, req.reserving_class, output_dataset)
    if not os.path.exists(path):
        return {"exists": False, "text": ""}
    try:
        sidecar = _read_json(path)
    except HTTPException:
        return {"exists": False, "text": ""}
    return {"exists": True, "text": str(sidecar.get("notes") or "")}


def _local_method_notes(req: DfmRpcBridgeRequest, paths: Dict[str, str]) -> Dict[str, Any]:
    if not os.path.exists(paths["local_path"]):
        return {"exists": False, "text": ""}
    try:
        payload = _read_json(paths["local_path"])
    except HTTPException:
        return {"exists": False, "text": ""}
    return _sidecar_method_notes_snapshot(req, payload)


def _build_json_snapshot(path: str, *, method_notes_resolver=None) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {
            "available": False,
            "error": "",
            "ratio_pattern": _extract_pattern_snapshot({}),
            "average_formula_pattern": _extract_average_formula_snapshot({}),
            "cell_notes": _extract_cell_notes_snapshot({}),
            "method_notes": _extract_method_notes_snapshot({}),
            "average_formulas": [],
            "last_modified": "",
        }
    try:
        payload = _read_json(path)
    except HTTPException as err:
        return {
            "available": False,
            "error": _clean_text(err.detail),
            "ratio_pattern": _extract_pattern_snapshot({}),
            "average_formula_pattern": _extract_average_formula_snapshot({}),
            "cell_notes": _extract_cell_notes_snapshot({}),
            "method_notes": _extract_method_notes_snapshot({}),
            "average_formulas": [],
            "last_modified": "",
        }
    formula_payload = _json_tab(payload, "ratios tab").get("average formulas", {})
    formulas = formula_payload.get("label", []) if isinstance(formula_payload, dict) else []
    if not isinstance(formulas, list):
        formulas = []
    method_notes = _extract_method_notes_snapshot(payload)
    if not method_notes["exists"] and callable(method_notes_resolver):
        method_notes = method_notes_resolver(payload)
    return {
        "available": True,
        "error": "",
        "ratio_pattern": _extract_pattern_snapshot(payload),
        "average_formula_pattern": _extract_average_formula_snapshot(payload),
        "cell_notes": _extract_cell_notes_snapshot(payload),
        "method_notes": method_notes,
        "average_formulas": [str(item) for item in formulas],
        "last_modified": _clean_text(_json_tab(payload, "method metadata").get("last modified")),
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


def compare(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
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
            "local": _build_json_snapshot(
                paths["local_path"],
                method_notes_resolver=lambda payload: _sidecar_method_notes_snapshot(req, payload),
            ),
            "remote": _build_json_snapshot(paths["remote_path"]),
        },
        "paths": paths,
    }


def send_sync_request(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    os.makedirs(paths["rpc_methods_dir"], exist_ok=True)
    stale_remote_deleted = _try_remove(paths["remote_path"])
    stale_sync_status_deleted = _try_remove(paths["sync_status_path"])
    request_file = _write_request_file(req, DFM_FUNCTION_NAME, paths["remote_path"], paths["request_dir"])
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


def _patch_component_count(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 1
    return sum(
        _patch_component_count(value)
        for key, value in payload.items()
        if key != "payload format"
    )


def apply_remote_to_local(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    if not os.path.exists(paths["remote_path"]):
        raise HTTPException(404, "Remote DFM JSON is missing.")
    remote_payload = _read_json(paths["remote_path"])
    if _clean_text(remote_payload.get("payload format")) != DFM_OWNED_PATCH_FORMAT:
        raise HTTPException(422, "Remote DFM payload is not a canonical owned-state patch.")
    from app_server.services import dfm_service

    loaded = dfm_service.load_dfm_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
    local_payload = loaded.get("method") or {}
    if _clean_text(local_payload.get("json format")) != DFM_JSON_FORMAT:
        raise HTTPException(409, "Local DFM must be upgraded to v2 before applying an RPC patch.")
    try:
        preview = apply_owned_patch(local_payload, remote_payload)
    except DfmContractError as exc:
        raise HTTPException(422, str(exc)) from exc
    # Method Notes live only in the output sidecar. A present remote value the
    # user reviewed replaces the sidecar notes — an empty ResQ note clears them.
    # Only an absent field (an older bridge payload that never read ResQ Notes)
    # keeps the local notes.
    remote_method_notes = _extract_method_notes_snapshot(remote_payload)
    if remote_method_notes["exists"]:
        notes = remote_method_notes["text"] if remote_method_notes["text"].strip() else ""
    else:
        notes = None
    saved = dfm_service.save_dfm_method(
        req.project_name,
        req.reserving_class,
        preview,
        notes=notes,
        expected_owned_revision=loaded.get("owned_revision"),
        expected_derived_revision=loaded.get("derived_revision"),
    )
    payload = saved["method"]
    sync_report = {
        "payload_format": DFM_OWNED_PATCH_FORMAT,
        "missing_components": [],
        "component_count": _patch_component_count(remote_payload),
        "method_notes_applied": notes is not None,
        "owned_revision": saved.get("owned_revision"),
        "derived_revision": saved.get("derived_revision"),
        "publication_revision": saved.get("publication_revision"),
    }
    deleted = _try_remove(paths["remote_path"])
    local_meta = _file_meta(paths["local_path"])
    return {
        "ok": True,
        "status": "applied",
        "payload": payload,
        "sync_report": sync_report,
        "local": local_meta,
        "remote_deleted": deleted,
        "paths": paths,
    }


def keep_local(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    remote_deleted = _try_remove(paths["remote_path"])
    return {
        "ok": True,
        "status": "kept_local",
        "message": "Kept local DFM JSON. Remote RPC JSON was removed." if remote_deleted else "Kept local DFM JSON. No remote RPC JSON was found to remove.",
        "remote_deleted": remote_deleted,
        "paths": paths,
    }


def cleanup_tmp(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
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


def update_remote(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    if not getattr(req, "rpc_server_write_confirmed", False):
        raise HTTPException(400, "RPC server write confirmation is required before updating the remote DFM.")
    paths = build_paths(req)
    os.makedirs(paths["rpc_methods_dir"], exist_ok=True)
    _try_remove(paths["sync_status_path"])
    extra_fields: Dict[str, Any] = {
        "MethodJsonPath": paths["local_path"],
        "RPCServerWriteConfirmed": True,
    }
    # Method Notes live in the output sidecar, not the method JSON the bridge
    # reads, so a confirmed remote update ships them in the request. A readable
    # sidecar always contributes the field — an empty value clears ResQ method
    # Notes; the field is omitted only when the notes owner is unavailable.
    method_notes = _local_method_notes(req, paths)
    if method_notes["exists"]:
        extra_fields["MethodNotes"] = method_notes["text"]
    request_file = _write_request_file(
        req,
        SYNC_DFM_FUNCTION_NAME,
        paths["sync_status_path"],
        paths["request_dir"],
        extra_fields,
    )
    status_found = wait_for_file(paths["sync_status_path"], timeout_sec=max(0.1, float(req.timeout_sec)))
    remote_deleted = _try_remove(paths["remote_path"])
    if not status_found:
        return {
            "ok": False,
            "status": "timeout",
            "message": "Timed out waiting for SyncDFM status JSON.",
            "request_file": request_file,
            "status_path": paths["sync_status_path"],
            "remote_deleted": remote_deleted,
            "paths": paths,
        }
    status_payload = _read_json(paths["sync_status_path"])
    raw_ok = status_payload.get("ok")
    raw_status = _clean_text(status_payload.get("status"))
    if isinstance(raw_ok, bool):
        status_ok = raw_ok
    else:
        status_ok = raw_status.strip().lower() in {"passed", "success", "ok", "true"}
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
