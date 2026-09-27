from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.table_summary import TableSummaryRefreshRequest
from app_server.services import table_summary_service, workspace_mutation_client, workspace_read_client

router = APIRouter()


@router.get("/table_summary")
def get_table_summary(project_name: str) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "table_summary",
        {"project_name": project_name},
        local=lambda: table_summary_service.get_table_summary(project_name),
    )


@router.post("/table_summary/refresh")
def refresh_table_summary(req: TableSummaryRefreshRequest) -> Dict[str, Any]:
    """Rebuild the summary (and the reserving-class values) on the server host.

    It does not force a re-import: a server-readable source is imported by
    the source refresh job, and one only this PC can read is imported here
    first. Import Data calls this only when the job cannot run.
    """
    project_name = str(req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    kwargs = {"project_name": project_name, "refresh_reserving": bool(req.refresh_reserving)}
    return workspace_mutation_client.run_workspace_mutation(
        "table_summary_rebuild",
        kwargs,
        local=lambda: table_summary_service.rebuild_table_summary(**kwargs),
    )
