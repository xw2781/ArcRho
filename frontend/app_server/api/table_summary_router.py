from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.table_summary import TableSummaryRefreshRequest
from app_server.services import (
    field_mapping_service,
    reserving_class_service,
    table_summary_service,
    workspace_read_client,
)

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
        # A refresh re-imports a CSV-sourced project so the master copy matches
        # the external file before the summary is regenerated.
        master_path = table_summary_service.resolve_master_table(project_name, force=True)
        cache_path = config.get_table_summary_cache_path(project_name)
        # The re-import advanced the imported table's modification time, so
        # the cached payload is stale now.
        cache_cleared = table_summary_service.discard_cached_summary(cache_path)

        summary = table_summary_service.generate_table_summary(
            master_path, field_mapping_service.load_date_role_fields(project_name))
        summary["from_cache"] = False
        summary["cache_cleared"] = cache_cleared
        table_summary_service.write_summary_cache(cache_path, summary)

        if refresh_reserving:
            refresh_out = reserving_class_service.refresh_reserving_class_values(
                project_name=project_name,
                mapping_rows_override=None,
                force=True,
            )
            summary["reserving_refreshed"] = True
            summary["reserving_class_values_path"] = refresh_out.get("path", "")
            summary["reserving_class_types_path"] = refresh_out.get("reserving_class_types_path", "")
            summary["reserving_class_types_count"] = refresh_out.get("reserving_class_types_count", 0)
            summary["missing_columns"] = refresh_out.get("missing_columns", [])
        else:
            summary["reserving_refreshed"] = False

        return summary
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
