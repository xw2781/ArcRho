from __future__ import annotations

import os
import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.reserving_class import (
    ReservingClassTypesSaveRequest,
    ReservingClassTypesImportLocalFileRequest,
    RefreshReservingClassValuesRequest,
    ReservingClassHiddenPathsSaveRequest,
    ReservingClassFilterSpecSaveRequest,
)
from app_server.services import reserving_class_service
from app_server.services.audit_service import safe_append_project_audit_log

router = APIRouter()


@router.get("/reserving_class_combinations")
def get_reserving_class_combinations(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")

    try:
        filepath = config.get_reserving_class_combinations_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    if not os.path.exists(filepath):
        return {
            "ok": True,
            "exists": False,
            "path": filepath,
            "data": {
                "fields": [],
                "levels": [],
                "combinations": [],
                "paths": [],
                "tree": {"name": "All", "path": "", "level_index": 0, "level_label": "All", "children": []},
            },
        }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {
                "fields": [],
                "levels": [],
                "combinations": [],
                "paths": [],
                "tree": {"name": "All", "path": "", "level_index": 0, "level_label": "All", "children": []},
            }
        if not isinstance(data.get("fields"), list):
            data["fields"] = []
        if not isinstance(data.get("levels"), list):
            data["levels"] = []
        if not isinstance(data.get("combinations"), list):
            data["combinations"] = []
        if not isinstance(data.get("paths"), list):
            data["paths"] = []
        if not isinstance(data.get("tree"), dict):
            data["tree"] = {"name": "All", "path": "", "level_index": 0, "level_label": "All", "children": []}
        return {"ok": True, "exists": True, "path": filepath, "data": data}
    except Exception as e:
        raise HTTPException(500, f"Failed to read reserving class combinations: {str(e)}")


@router.get("/reserving_class_path_tree")
def get_reserving_class_path_tree(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")

    try:
        filepath = config.get_reserving_class_path_tree_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    if not os.path.exists(filepath):
        return {
            "ok": True,
            "exists": False,
            "path": filepath,
            "data": {
                "levels": [],
                "paths": [],
                "tree": {"name": "All", "path": "", "level_index": 0, "level_label": "All", "children": []},
            },
        }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
        if not isinstance(data.get("levels"), list):
            data["levels"] = []
        if not isinstance(data.get("paths"), list):
            data["paths"] = []
        tree = data.get("tree")
        if not isinstance(tree, dict):
            data["tree"] = {"name": "All", "path": "", "level_index": 0, "level_label": "All", "children": []}
        return {"ok": True, "exists": True, "path": filepath, "data": data}
    except Exception as e:
        raise HTTPException(500, f"Failed to read reserving class path tree: {str(e)}")


@router.get("/reserving_class_path_tree/children")
def get_reserving_class_path_tree_children(
    project_name: str,
    prefix: str = "",
    table_path: str = "",
    force: bool = False,
) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "Missing project_name parameter")
    try:
        out = reserving_class_service.get_reserving_class_path_tree_children(
            project_name=project_name_clean,
            prefix=prefix,
            table_path_override=(table_path or "").strip(),
            force=bool(force),
        )
        return {"ok": True, **out}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "Project folder not found under projects:" in msg:
            raise HTTPException(404, msg)
        raise HTTPException(400, msg)
    except PermissionError:
        raise HTTPException(423, "Reserving class path tree cache is locked. Another user may have it open.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to get reserving class path children: {str(e)}")


@router.get("/reserving_class_hidden_paths")
def get_reserving_class_hidden_paths(project_name: str) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "Missing project_name parameter")
    try:
        out = reserving_class_service.get_hidden_paths_for_project(project_name_clean)
        return {
            "ok": True,
            "project_name": project_name_clean,
            "path": out.get("path", ""),
            "hidden_paths": out.get("hidden_paths", []),
            "count": len(out.get("hidden_paths", [])),
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(423, "Project user preference file is locked. Please retry.")
    except Exception as e:
        raise HTTPException(500, f"Failed to read reserving class hidden paths: {str(e)}")


@router.post("/reserving_class_hidden_paths")
def save_reserving_class_hidden_paths(req: ReservingClassHiddenPathsSaveRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        out = reserving_class_service.save_hidden_paths_for_project(project_name, req.hidden_paths)
        return {
            "ok": True,
            "project_name": project_name,
            "path": out.get("path", ""),
            "hidden_paths": out.get("hidden_paths", []),
            "count": len(out.get("hidden_paths", [])),
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(423, "Project user preference file is locked. Please retry.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save reserving class hidden paths: {str(e)}")


@router.get("/reserving_class_filter_spec")
def get_reserving_class_filter_spec(project_name: str) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "Missing project_name parameter")
    try:
        out = reserving_class_service.get_filter_spec_for_project(project_name_clean)
        filter_spec = out.get("filter_spec", {})
        preferences = out.get("preferences", {})
        return {
            "ok": True,
            "project_name": project_name_clean,
            "path": out.get("path", ""),
            "filter_spec": filter_spec,
            "preferences": preferences,
            "count": len(filter_spec) if isinstance(filter_spec, dict) else 0,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(423, "Filter preference file is locked. Please retry.")
    except Exception as e:
        raise HTTPException(500, f"Failed to read reserving class filter spec: {str(e)}")


@router.post("/reserving_class_filter_spec")
def save_reserving_class_filter_spec(req: ReservingClassFilterSpecSaveRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        out = reserving_class_service.save_filter_spec_for_project(project_name, req.filter_spec, req.preferences)
        filter_spec = out.get("filter_spec", {})
        preferences = out.get("preferences", {})
        return {
            "ok": True,
            "project_name": project_name,
            "path": out.get("path", ""),
            "filter_spec": filter_spec,
            "preferences": preferences,
            "count": len(filter_spec) if isinstance(filter_spec, dict) else 0,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(423, "Filter preference file is locked. Please retry.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save reserving class filter spec: {str(e)}")


@router.post("/reserving_class_values/refresh")
def refresh_reserving_class_values(req: RefreshReservingClassValuesRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        out = reserving_class_service.refresh_reserving_class_values(
            project_name=project_name,
            table_path_override=(req.table_path or "").strip(),
            mapping_rows_override=None,
            force=bool(req.force),
        )
        return {"ok": True, **out}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(423, "Reserving class values file is locked. Another user may have it open.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to refresh reserving class values: {str(e)}")


@router.get("/reserving_class_types")
def get_reserving_class_types(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")

    try:
        filepath = config.get_reserving_class_types_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    try:
        out = reserving_class_service.refresh_reserving_class_types_json(
            project_name,
            source_fields_override=None,
            rows_override=None,
        )
        data = out.get("ui_data", {"columns": list(config.RESERVING_CLASS_TYPES_COLUMNS), "rows": []})
        return {
            "ok": True,
            "exists": os.path.exists(filepath),
            "path": filepath,
            "xlsx_path": out.get("xlsx_path", ""),
            "data": data,
            "source_derived_names": out.get("source_derived_names", []),
        }
    except PermissionError:
        raise HTTPException(423, "Reserving class types file is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to read reserving class types: {str(e)}")


@router.post("/reserving_class_types/import_local_file")
def import_local_reserving_class_types_file(req: ReservingClassTypesImportLocalFileRequest) -> Dict[str, Any]:
    parsed = reserving_class_service.parse_local_reserving_class_types_file(req.file_path)
    return {
        "ok": True,
        "path": str(req.file_path or "").strip(),
        "format": str(parsed.get("format") or "").strip(),
        "sheet_name": str(parsed.get("sheet_name") or "").strip(),
        "data": {
            "columns": list(parsed.get("columns") or []),
            "rows": list(parsed.get("rows") or []),
        },
    }


@router.post("/reserving_class_types")
def save_reserving_class_types(req: ReservingClassTypesSaveRequest) -> Dict[str, Any]:
    project_name = (req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    normalized_request = reserving_class_service.normalize_reserving_class_types_data({
        "columns": req.columns,
        "rows": req.rows,
    })

    try:
        filepath = config.get_reserving_class_types_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    try:
        out = reserving_class_service.refresh_reserving_class_types_json(
            project_name,
            source_fields_override=None,
            rows_override=normalized_request.get("rows", []),
        )
        safe_append_project_audit_log(
            project_name=project_name,
            action=f"Saved Reserving Class Types ({out.get('row_count', 0)} rows)",
        )
        return {
            "ok": True,
            "path": filepath,
            "xlsx_path": out.get("xlsx_path", ""),
            "row_count": out.get("row_count", 0),
            "source_derived_count": out.get("source_derived_count", 0),
            "source_derived_names": out.get("source_derived_names", []),
            "data": out.get("ui_data", {"columns": list(config.RESERVING_CLASS_TYPES_COLUMNS), "rows": []}),
        }
    except PermissionError:
        raise HTTPException(423, "Reserving class types file is locked. Another user may have it open.")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to save reserving class types: {str(e)}")
