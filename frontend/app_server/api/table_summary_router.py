from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.table_summary import TableSummaryRefreshRequest
from app_server.services import table_summary_service, workspace_read_client

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
    project_name = str(req.project_name or "").strip()
    refresh_reserving = bool(req.refresh_reserving)

    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        return table_summary_service.refresh_table_summary(
            project_name,
            refresh_reserving=refresh_reserving,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except PermissionError:
        raise HTTPException(423, "File is locked. Another user may have it open.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error refreshing table summary: {str(e)}")
