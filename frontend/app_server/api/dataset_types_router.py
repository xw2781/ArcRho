from __future__ import annotations

import os
import json
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.dataset_types import (
    DatasetTypesSaveRequest,
    DatasetTypesImportLocalFileRequest,
)
from app_server.services import (
    dataset_types_change_service,
    dataset_types_service,
)
from app_server.services.audit_service import safe_append_project_audit_log

router = APIRouter()


@router.get("/dataset_types")
def get_dataset_types(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")

    try:
        filepath = config.get_dataset_types_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    if not os.path.exists(filepath):
        return {
            "ok": True,
            "exists": False,
            "path": filepath,
            "data": {
                "columns": list(config.DATASET_TYPES_FILE_COLUMNS),
                "rows": [],
                "source_by_name": {},
                "generated_by_name": {},
            },
        }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        data = dataset_types_service.normalize_dataset_types_data(raw)
        return {"ok": True, "exists": True, "path": filepath, "data": data}
    except Exception as e:
        raise HTTPException(500, f"Failed to read dataset types: {str(e)}")


@router.post("/dataset_types/import_local_file")
def import_local_dataset_types_file(req: DatasetTypesImportLocalFileRequest) -> Dict[str, Any]:
    parsed = dataset_types_service.parse_local_dataset_types_file(req.file_path)
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


@router.post("/dataset_types")
def save_dataset_types(req: DatasetTypesSaveRequest) -> Dict[str, Any]:
    """Apply one dataset-type table change: directly, as a plan, or as a job.

    Two changes wear the same clothes in the grid and cost wildly different
    things. Renaming a Category rewrites one file. Adding, removing, renaming
    or re-formulating a type rewrites the sidecars of every instance the change
    reaches and can invalidate calculated datasets, so it is first *planned*:
    the route answers ``applied: "plan"`` naming the reserving classes the
    change touches, and only a second POST carrying that plan submits the
    durable Engine job, which holds those classes while it runs and whose
    status the caller polls at ``/dataset_types/change_job/status``. A plan
    that names no class and renames nothing is submitted at once: there is
    nothing for the user to confirm.

    Either way this route answers quickly: the long work never runs inside
    the request, because an auto-saving grid cannot tell a slow save from a
    lost one.
    """

    project_name = (req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        config.get_dataset_types_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    normalized_rows = dataset_types_service.normalize_submitted_rows(req.rows)
    # Validate before deciding anything: a formula naming a type this table
    # does not define is refused the same way on both paths, and the caller
    # gets that answer without a job ever being queued.
    dataset_types_service.require_resolvable_formulas(normalized_rows)

    previous_rows = dataset_types_service.read_persisted_rows(project_name)
    next_rows = dataset_types_service.resolve_persisted_rows(
        project_name, normalized_rows
    )

    if not req.renames and not dataset_types_service.change_needs_project_job(
        previous_rows, next_rows
    ):
        return _apply_presentation_only_change(project_name, normalized_rows)

    if req.plan is None:
        planned = dataset_types_change_service.plan_dataset_types_change(
            project_name, normalized_rows, req.renames
        )
        # A rename is always shown, even when no class holds the old type:
        # the planner may have rewritten formulas, and the grid has to adopt
        # those rows before they are submitted.
        if planned["plan"]["affected"] or req.renames:
            return {"ok": True, "applied": "plan", "count": len(next_rows), **planned}
        plan = planned["plan"]
        rows = planned["rows"]
        changed_types = planned["changed_types"]
    else:
        plan = req.plan
        rows = normalized_rows
        changed_types = dataset_types_change_service.changed_types_for_submission(
            project_name, normalized_rows, req.renames
        )

    submitted = dataset_types_change_service.submit_dataset_types_change_job(
        project_name,
        rows,
        req.renames,
        changed_types,
        plan,
        request_id=(req.request_id or "").strip() or None,
    )
    return {
        "ok": True,
        "applied": "job",
        "count": len(next_rows),
        "changed_formula_types": changed_types,
        "job": submitted,
    }


def _apply_presentation_only_change(
    project_name: str,
    normalized_rows: List[List[Any]],
) -> Dict[str, Any]:
    """Write a change that re-derives nothing outside the table itself."""

    try:
        written = dataset_types_service.apply_dataset_types_rows(
            project_name, normalized_rows
        )
    except PermissionError:
        raise HTTPException(423, "Dataset types file is locked. Another user may have it open.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to save dataset types: {str(e)}")

    safe_append_project_audit_log(
        project_name=project_name,
        action=f"Saved Dataset Types ({written['count']} rows)",
    )
    return {
        "ok": True,
        "applied": "direct",
        "path": written["path"],
        "count": written["count"],
        "changed_formula_types": [],
        "job": None,
    }


@router.get("/dataset_types/change_job/status")
def get_dataset_types_change_job_status(
    project_name: str,
    job_id: str = "",
) -> Dict[str, Any]:
    return dataset_types_change_service.get_dataset_types_change_status(
        project_name, job_id
    )
