"""DFM RPC bridge request and comparison operations."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException

from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    DfmContractError,
    apply_owned_patch,
)
from arcrho_workspace_mutation_contract import clamp_rpc_bridge_wait

from app_server import config
from app_server.helpers import (
    parse_method_last_modified_timestamp,
    sanitize_dataset_file_name,
    wait_for_file,
)
from app_server.schemas.dfm_rpc_bridge import (
    DfmRpcBridgeRequest,
    DfmRpcBridgeUpdateRemoteRequest,
)
from app_server.services import user_identity_service

RPC_BRIDGE_DIR_NAME = "RPC bridge"
RPC_BRIDGE_TMP_DIR_NAME = "tmp_rpc"
DFM_FUNCTION_NAME = "DFM"
SYNC_DFM_FUNCTION_NAME = "SyncDFM"
DFM_OWNED_PATCH_FORMAT = "arcrho-dfm-owned-patch-v1"
# The SyncDFM status field carrying the ``Modified`` value ResQ stamped on the
# method it just saved, in the same spelling the exported method payload uses.
SYNC_LAST_MODIFIED_FIELD = "last modified"


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
        # The exchange runs on the Client PC or inside the Gateway on the
        # server host; either way the request names the person who asked,
        # not whichever account happens to own the process.
        "UserName": user_identity_service.get_windows_login_name(),
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


# One parse of one method JSON: whether the file was there, what it held, and
# why it could not be read. The metadata and the snapshot are both derived from
# this rather than from a path, because on a mapped drive every extra open is a
# full round trip -- measured at 0.4-0.6 s per file whatever its size, which is
# what made the review dialog read each side two and three times over.
ParsedJson = Tuple[bool, Optional[Dict[str, Any]], str]


def _parse_json_once(path: str) -> ParsedJson:
    if not os.path.exists(path):
        return False, None, ""
    try:
        return True, _read_json(path), ""
    except HTTPException as err:
        return True, None, _clean_text(err.detail)


def _json_last_modified_meta(parsed: ParsedJson) -> Dict[str, Any]:
    _exists, payload, error = parsed
    if payload is None:
        return {
            "last_modified": "",
            "last_modified_timestamp": None,
            "last_modified_error": error,
        }
    raw = _json_tab(payload, "method metadata").get("last modified")
    return {
        "last_modified": _clean_text(raw),
        "last_modified_timestamp": parse_method_last_modified_timestamp(raw),
        "last_modified_error": "",
    }


def _file_meta(path: str, parsed: Optional[ParsedJson] = None) -> Dict[str, Any]:
    if parsed is None:
        parsed = _parse_json_once(path)
    exists = bool(parsed[0])
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
    out.update(_json_last_modified_meta(parsed))
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


def _unavailable_json_snapshot(error: str) -> Dict[str, Any]:
    return {
        "available": False,
        "error": error,
        "ratio_pattern": _extract_pattern_snapshot({}),
        "average_formula_pattern": _extract_average_formula_snapshot({}),
        "cell_notes": _extract_cell_notes_snapshot({}),
        "method_notes": _extract_method_notes_snapshot({}),
        "average_formulas": [],
        "last_modified": "",
    }


def _build_json_snapshot(parsed: ParsedJson, *, method_notes_resolver=None) -> Dict[str, Any]:
    _exists, payload, error = parsed
    if payload is None:
        return _unavailable_json_snapshot(error)
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
    local_parsed = _parse_json_once(paths["local_path"])
    remote_parsed = _parse_json_once(paths["remote_path"])
    local_meta = _file_meta(paths["local_path"], local_parsed)
    remote_meta = _file_meta(paths["remote_path"], remote_parsed)
    return {
        "ok": True,
        "status": "compared",
        "comparison": _compare_state(local_meta, remote_meta),
        "local": local_meta,
        "remote": remote_meta,
        "snapshots": {
            "local": _build_json_snapshot(
                local_parsed,
                method_notes_resolver=lambda payload: _sidecar_method_notes_snapshot(req, payload),
            ),
            "remote": _build_json_snapshot(remote_parsed),
        },
        "paths": paths,
    }


def send_sync_request(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    paths = build_paths(req)
    os.makedirs(paths["rpc_methods_dir"], exist_ok=True)
    stale_remote_deleted = _try_remove(paths["remote_path"])
    stale_sync_status_deleted = _try_remove(paths["sync_status_path"])
    request_file = _write_request_file(req, DFM_FUNCTION_NAME, paths["remote_path"], paths["request_dir"])
    ok = wait_for_file(paths["remote_path"], timeout_sec=clamp_rpc_bridge_wait(req.timeout_sec))
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


def _record_remote_sync_time(req: DfmRpcBridgeRequest, status_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Copy the time ResQ recorded for this upload onto the local method.

    ResQ stamps its own ``Modified`` when it saves, so straight after a
    successful upload the two copies hold identical settings under different
    times and the next review window calls the remote newer -- inviting the user
    to pull back what they just pushed. Taking ResQ's value rather than this
    machine's clock is what makes them compare equal: the comparison matches on
    the instant, and a local "now" would still differ by the round trip and by
    whatever the two clocks disagree about.

    The upload has already happened by the time this runs, so a failure here is
    reported alongside a successful sync rather than turning it into one.
    """

    stamped = _clean_text(status_payload.get(SYNC_LAST_MODIFIED_FIELD))
    if not stamped:
        # An older Bridge does not report it. Leaving the local value alone
        # keeps today's behaviour rather than inventing a time.
        return {"ok": False, "status": "not_reported", "last_modified": ""}
    from app_server.services import dfm_service

    try:
        return dfm_service.record_rpc_sync_last_modified(
            req.project_name,
            req.reserving_class,
            req.method_name,
            stamped,
        )
    except HTTPException as exc:
        return {
            "ok": False,
            "status": "failed",
            "last_modified": stamped,
            "error": _clean_text(exc.detail),
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
    status_found = wait_for_file(paths["sync_status_path"], timeout_sec=clamp_rpc_bridge_wait(req.timeout_sec))
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
    last_modified = (
        _record_remote_sync_time(req, status_payload)
        if status_ok
        else {"ok": False, "status": "not_attempted", "last_modified": ""}
    )
    return {
        "ok": status_ok,
        "status": status_text,
        "message": message,
        "payload": status_payload,
        "request_file": request_file,
        "status_path": paths["sync_status_path"],
        "remote_deleted": remote_deleted,
        "last_modified_record": last_modified,
        "paths": paths,
    }


# ---------------------------------------------------------------------------
# Gateway-hosted entry points
#
# A Client PC reaches the workspace over SMB, where publishing one request file
# costs several round trips and every wait tick writes and deletes a probe file
# so the redirector cannot serve a cached "not found". The ArcRho Bridge that
# answers these requests runs on the server host, where the same folders are
# local disk. These wrappers let the Gateway run the exchange there instead:
# the registries in arcrho_workspace_read_contract and
# arcrho_workspace_mutation_contract name them, the flat keyword arguments are
# the route schema's own fields, and rebuilding the request model here keeps
# pydantic the single validator for both transports.
# ---------------------------------------------------------------------------


def _hosted_request(model, fields: Dict[str, Any]):
    """Rebuild a route request model from one hosted call's arguments.

    An optional argument the caller omitted arrives as None and is dropped, so
    the schema stays the only place these defaults are written down.
    """

    return model(**{name: value for name, value in fields.items() if value is not None})


def hosted_compare(
    *,
    project_name: str,
    reserving_class: str,
    method_name: str,
    output_vector: str,
    input_triangle: str,
    origin_length: int,
    development_length: int,
    decimal_places: Optional[int] = None,
    timeout_sec: Optional[float] = None,
) -> Dict[str, Any]:
    return compare(_hosted_request(DfmRpcBridgeRequest, locals()))


def hosted_send_sync_request(
    *,
    project_name: str,
    reserving_class: str,
    method_name: str,
    output_vector: str,
    input_triangle: str,
    origin_length: int,
    development_length: int,
    decimal_places: Optional[int] = None,
    timeout_sec: Optional[float] = None,
) -> Dict[str, Any]:
    return send_sync_request(_hosted_request(DfmRpcBridgeRequest, locals()))


def hosted_keep_local(
    *,
    project_name: str,
    reserving_class: str,
    method_name: str,
    output_vector: str,
    input_triangle: str,
    origin_length: int,
    development_length: int,
    decimal_places: Optional[int] = None,
    timeout_sec: Optional[float] = None,
) -> Dict[str, Any]:
    return keep_local(_hosted_request(DfmRpcBridgeRequest, locals()))


def hosted_cleanup_tmp(
    *,
    project_name: str,
    reserving_class: str,
    method_name: str,
    output_vector: str,
    input_triangle: str,
    origin_length: int,
    development_length: int,
    decimal_places: Optional[int] = None,
    timeout_sec: Optional[float] = None,
) -> Dict[str, Any]:
    return cleanup_tmp(_hosted_request(DfmRpcBridgeRequest, locals()))


def hosted_update_remote(
    *,
    project_name: str,
    reserving_class: str,
    method_name: str,
    output_vector: str,
    input_triangle: str,
    origin_length: int,
    development_length: int,
    decimal_places: Optional[int] = None,
    timeout_sec: Optional[float] = None,
    rpc_server_write_confirmed: Optional[bool] = None,
) -> Dict[str, Any]:
    return update_remote(_hosted_request(DfmRpcBridgeUpdateRemoteRequest, locals()))
