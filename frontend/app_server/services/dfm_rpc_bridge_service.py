"""DFM RPC bridge request and comparison operations."""
from __future__ import annotations

import getpass
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import HTTPException

from app_server import config
from app_server.helpers import sanitize_dataset_file_name, wait_for_file
from app_server.schemas.dfm_rpc_bridge import DfmRpcBridgeRequest

RPC_BRIDGE_DIR_NAME = "RPC bridge"
RPC_BRIDGE_TMP_DIR_NAME = "tmp_rpc"
DFM_FUNCTION_NAME = "DFM"
SYNC_DFM_FUNCTION_NAME = "SyncDFM"
RPC_APPLY_COMPONENTS = [
    ("sync", ("json format",)),
    ("sync", ("details tab", "name")),
    ("sync", ("details tab", "output type")),
    ("sync", ("details tab", "input triangle")),
    ("sync", ("details tab", "origin length")),
    ("sync", ("details tab", "development length")),
    ("sync", ("details tab", "decimal places")),
    ("preserve-local", ("data tab", "origin labels")),
    ("preserve-local", ("data tab", "development labels")),
    ("preserve-local", ("data tab", "input data triangle csv path")),
    ("preserve-local", ("ratios tab", "ratio triangle", "origin labels")),
    ("preserve-local", ("ratios tab", "ratio triangle", "development labels")),
    ("preserve-local", ("ratios tab", "ratio triangle", "ratio values")),
    ("sync", ("ratios tab", "ratio triangle", "excluded")),
    ("sync", ("ratios tab", "average formulas", "label")),
    ("sync", ("ratios tab", "average formulas", "custom average formula settings", "averageType")),
    ("sync", ("ratios tab", "average formulas", "custom average formula settings", "base")),
    ("sync", ("ratios tab", "average formulas", "custom average formula settings", "periods")),
    ("sync", ("ratios tab", "average formulas", "custom average formula settings", "exclude")),
    ("sync", ("ratios tab", "average formulas", "selected")),
    ("merge-row-values", ("ratios tab", "average formulas", "values")),
    ("sync", ("ratios tab", "cell notes")),
    ("sync", ("results tab", "ratio basis dataset")),
    ("sync", ("results tab", "ultimate ratio decimal places")),
    ("preserve-local", ("results tab", "ultimate vector csv path")),
    ("sync", ("notes tab", "notes")),
    ("sync", ("method metadata", "last modified")),
]
RPC_OPTIONAL_MISSING_COMPONENTS = {
    ("results tab", "ultimate vector csv path"),
    ("ratios tab", "cell notes"),
}


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


def _build_json_snapshot(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {
            "available": False,
            "error": "",
            "ratio_pattern": _extract_pattern_snapshot({}),
            "average_formula_pattern": _extract_average_formula_snapshot({}),
            "cell_notes": _extract_cell_notes_snapshot({}),
            "notes": "",
            "notes_preview": "",
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
            "notes": "",
            "notes_preview": "",
            "average_formulas": [],
            "last_modified": "",
        }
    notes = _clean_text(_json_tab(payload, "notes tab").get("notes"))
    formula_payload = _json_tab(payload, "ratios tab").get("average formulas", {})
    formulas = formula_payload.get("label", []) if isinstance(formula_payload, dict) else []
    if not isinstance(formulas, list):
        formulas = []
    return {
        "available": True,
        "error": "",
        "ratio_pattern": _extract_pattern_snapshot(payload),
        "average_formula_pattern": _extract_average_formula_snapshot(payload),
        "cell_notes": _extract_cell_notes_snapshot(payload),
        "notes": notes,
        "notes_preview": notes[:600],
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
            "local": _build_json_snapshot(paths["local_path"]),
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


def _format_json_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _format_row_array_lines(rows: list[Any], indent: str) -> str:
    lines = []
    for row in rows:
        if not isinstance(row, list):
            row = []
        vals = ", ".join(_format_json_value(value) for value in row)
        lines.append(f"{indent}[{vals}]")
    return ",\n".join(lines)


def _format_json_with_compact_row_arrays(value: Any, indent: str = "") -> str:
    if _has_row_array(value):
        if not value:
            return "[]"
        return "[\n" + _format_row_array_lines(value, f"{indent}  ") + f"\n{indent}]"
    if isinstance(value, list):
        if not value:
            return "[]"
        child_indent = f"{indent}  "
        lines = []
        for index, item in enumerate(value):
            rendered = f"{child_indent}{_format_json_with_compact_row_arrays(item, child_indent)}"
            lines.append(f"{rendered}," if index < len(value) - 1 else rendered)
        return "[\n" + "\n".join(lines) + f"\n{indent}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        child_indent = f"{indent}  "
        items = list(value.items())
        lines = []
        for index, (key, item) in enumerate(items):
            rendered = (
                f"{child_indent}{json.dumps(str(key), ensure_ascii=False)}: "
                f"{_format_json_with_compact_row_arrays(item, child_indent)}"
            )
            lines.append(f"{rendered}," if index < len(items) - 1 else rendered)
        return "{\n" + "\n".join(lines) + f"\n{indent}}}"
    return json.dumps(value, ensure_ascii=False)


def _has_row_array(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(row, list) for row in value)


def _format_method_json_for_write(data: Dict[str, Any]) -> str:
    text = _format_json_with_compact_row_arrays(data)
    return text if text.endswith("\n") else f"{text}\n"


def _atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(_format_method_json_for_write(data))
        os.replace(temp_path, path)
    except PermissionError:
        _try_remove(temp_path)
        raise HTTPException(423, f"JSON file is locked or inaccessible: {path}")
    except OSError as err:
        _try_remove(temp_path)
        raise HTTPException(500, f"Failed to write JSON file: {str(err)}")


def _component_label(path: tuple[str, ...]) -> str:
    return ".".join(path)


def _has_component(payload: Dict[str, Any], path: tuple[str, ...]) -> bool:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return False
        current = current[key]
    return True


def _get_component(payload: Dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = payload
    for key in path:
        current = current[key]
    return current


def _set_component(payload: Dict[str, Any], path: tuple[str, ...], value: Any) -> None:
    current: Any = payload
    for key in path[:-1]:
        child = current.get(key)
        if not isinstance(child, dict):
            child = {}
            current[key] = child
        current = child
    current[path[-1]] = deepcopy(value)


def _merge_row_values(local_value: Any, remote_value: Any) -> list[Any]:
    if not isinstance(remote_value, list):
        return []
    if not isinstance(local_value, list):
        return deepcopy(remote_value)
    merged = []
    length = max(len(local_value), len(remote_value))
    for index in range(length):
        remote_row = remote_value[index] if index < len(remote_value) else None
        local_row = local_value[index] if index < len(local_value) else None
        if remote_row in (None, [], {}):
            if index < len(local_value):
                merged.append(deepcopy(local_row))
            else:
                merged.append(deepcopy(remote_row))
        else:
            merged.append(deepcopy(remote_row))
    return merged


def _apply_explicit_rpc_components(local_payload: Dict[str, Any], remote_payload: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    payload: Dict[str, Any] = {}
    missing_components = []

    for action, path in RPC_APPLY_COMPONENTS:
        remote_has_value = _has_component(remote_payload, path)
        local_has_value = _has_component(local_payload, path)

        if not remote_has_value:
            if path not in RPC_OPTIONAL_MISSING_COMPONENTS:
                missing_components.append(_component_label(path))
            if local_has_value:
                _set_component(payload, path, _get_component(local_payload, path))
            continue

        remote_value = _get_component(remote_payload, path)
        if action == "preserve-local" and local_has_value:
            _set_component(payload, path, _get_component(local_payload, path))
            continue
        if action == "merge-row-values":
            local_value = _get_component(local_payload, path) if local_has_value else []
            _set_component(payload, path, _merge_row_values(local_value, remote_value))
            continue
        _set_component(payload, path, remote_value)

    report = {
        "missing_components": missing_components,
        "component_count": len(RPC_APPLY_COMPONENTS),
    }
    return payload, report


def apply_remote_to_local(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    if not os.path.exists(paths["remote_path"]):
        raise HTTPException(404, "Remote DFM JSON is missing.")
    remote_payload = _read_json(paths["remote_path"])
    local_payload = _read_json(paths["local_path"]) if os.path.exists(paths["local_path"]) else {}
    payload, sync_report = _apply_explicit_rpc_components(local_payload, remote_payload)
    _atomic_write_json(paths["local_path"], payload)
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
    request_file = _write_request_file(
        req,
        SYNC_DFM_FUNCTION_NAME,
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
