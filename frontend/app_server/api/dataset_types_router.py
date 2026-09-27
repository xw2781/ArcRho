from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.dataset_types import (
    DatasetTypesSaveRequest,
    DatasetTypesImportLocalFileRequest,
)
from app_server.services import (
    dataset_types_change_service,
    dataset_types_service,
    workspace_mutation_client,
    workspace_read_client,
)

router = APIRouter()


@router.get("/dataset_types")
def get_dataset_types(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")
    # Read on the server host through the Gateway; a Client PC never opens
    # the table over the share.
    return workspace_read_client.run_workspace_read(
        "dataset_types_table",
        {"project_name": project_name},
        local=lambda: dataset_types_service.get_dataset_types_table(project_name),
    )


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

    The decision and the write run on the server host
    (``dataset_types_change_service.save_dataset_types``); a Client PC sends
    them through the Gateway and never opens the table or a job file over the
    share. A job's status is polled at ``/dataset_types/change_job/status``.
    """

    project_name = (req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    # The client names the change with one request id and reuses it on a
    # retry; it keys the job and travels as the mutation's own id.
    request_id = (req.request_id or "").strip() or uuid.uuid4().hex
    kwargs = {
        "project_name": project_name,
        "request_id": request_id,
        "rows": list(req.rows),
        "renames": list(req.renames),
        "plan": req.plan,
    }
    return workspace_mutation_client.run_workspace_mutation(
        "dataset_types_save",
        kwargs,
        local=lambda: dataset_types_change_service.save_dataset_types(**kwargs),
        request_id=request_id,
    )


@router.get("/dataset_types/change_job/status")
def get_dataset_types_change_job_status(
    project_name: str,
    job_id: str = "",
) -> Dict[str, Any]:
    # Polled every few hundred milliseconds while the job runs; a poll the
    # Gateway cannot answer is "unknown", never a failed job.
    kwargs = {"project_name": project_name, "job_id": job_id}
    return workspace_read_client.run_polled_workspace_read(
        "dataset_types_change_status",
        kwargs,
        local=lambda: dataset_types_change_service.get_dataset_types_change_status(**kwargs),
        unknown={
            "ok": True,
            "project_name": str(project_name or "").strip(),
            "job_id": str(job_id or "").strip(),
            "found": False,
            "busy": False,
            "busy_reason": "",
        },
    )
