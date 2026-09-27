"""Reserving-class routes.

The reads and the per-user tree preferences run on the server host through
the Gateway (see ``reserving_class_service``'s route answers); a Client PC
answers 503 rather than touching the project over the share, and no GET here
writes. The types save and the values refresh are not hosted yet; the
local-file import reads a file picked on this PC, so it stays here.
"""

from __future__ import annotations

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
from app_server.services import reserving_class_service, workspace_mutation_client, workspace_read_client
from app_server.services.audit_service import safe_append_project_audit_log

router = APIRouter()


def _required_project(project_name: str, message: str = "Missing project_name parameter") -> str:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, message)
    return project_name_clean


def _read(kind: str, kwargs: Dict[str, Any], local: Any) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(kind, kwargs, local=local, gateway_required=True)


@router.get("/reserving_class_combinations")
def get_reserving_class_combinations(project_name: str) -> Dict[str, Any]:
    name = _required_project(project_name)
    return _read(
        "reserving_class_combinations",
        {"project_name": name},
        lambda: reserving_class_service.read_reserving_class_combinations(name),
    )


@router.get("/reserving_class_path_tree")
def get_reserving_class_path_tree(project_name: str) -> Dict[str, Any]:
    name = _required_project(project_name)
    return _read(
        "reserving_class_path_tree",
        {"project_name": name},
        lambda: reserving_class_service.read_reserving_class_path_tree(name),
    )


@router.get("/reserving_class_path_tree/children")
def get_reserving_class_path_tree_children(
    project_name: str,
    prefix: str = "",
    force: bool = False,
) -> Dict[str, Any]:
    name = _required_project(project_name)
    kwargs: Dict[str, Any] = {"project_name": name, "prefix": prefix, "force": bool(force)}
    return _read(
        "reserving_class_path_tree_children",
        kwargs,
        lambda: reserving_class_service.read_reserving_class_path_tree_children(**kwargs),
    )


@router.get("/reserving_class_paths_with_data")
def get_reserving_class_paths_with_data(project_name: str) -> Dict[str, Any]:
    name = _required_project(project_name)
    try:
        out = _read(
            "reserving_classes_with_data",
            {"project_name": name},
            lambda: reserving_class_service.list_reserving_classes_with_data(name),
        )
        return {"ok": True, **out}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/reserving_class_hidden_paths")
def get_reserving_class_hidden_paths(project_name: str) -> Dict[str, Any]:
    name = _required_project(project_name)
    return _read(
        "reserving_class_hidden_paths",
        {"project_name": name},
        lambda: reserving_class_service.read_hidden_paths(name),
    )


@router.post("/reserving_class_hidden_paths")
def save_reserving_class_hidden_paths(req: ReservingClassHiddenPathsSaveRequest) -> Dict[str, Any]:
    kwargs = {
        "project_name": _required_project(req.project_name, "project_name is required"),
        "hidden_paths": list(req.hidden_paths),
    }
    return workspace_mutation_client.run_workspace_mutation(
        "reserving_class_hidden_paths_save",
        kwargs,
        local=lambda: reserving_class_service.save_hidden_paths(**kwargs),
        gateway_required=True,
    )


@router.get("/reserving_class_filter_spec")
def get_reserving_class_filter_spec(project_name: str) -> Dict[str, Any]:
    name = _required_project(project_name)
    return _read(
        "reserving_class_filter_spec",
        {"project_name": name},
        lambda: reserving_class_service.read_filter_spec(name),
    )


@router.post("/reserving_class_filter_spec")
def save_reserving_class_filter_spec(req: ReservingClassFilterSpecSaveRequest) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {
        "project_name": _required_project(req.project_name, "project_name is required"),
        "filter_spec": dict(req.filter_spec),
    }
    if req.preferences is not None:
        kwargs["preferences"] = dict(req.preferences)
    return workspace_mutation_client.run_workspace_mutation(
        "reserving_class_filter_spec_save",
        kwargs,
        local=lambda: reserving_class_service.save_filter_spec(**kwargs),
        gateway_required=True,
    )


@router.post("/reserving_class_values/refresh")
def refresh_reserving_class_values(req: RefreshReservingClassValuesRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        out = reserving_class_service.refresh_reserving_class_values(
            project_name=project_name,
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
    name = _required_project(project_name)
    return _read(
        "reserving_class_types",
        {"project_name": name},
        lambda: reserving_class_service.read_reserving_class_types(name),
    )


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
