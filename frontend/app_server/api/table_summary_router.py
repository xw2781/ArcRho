from __future__ import annotations

import os
import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.table_summary import TableSummaryRefreshRequest
from app_server.services import (
    field_mapping_service,
    reserving_class_service,
    source_table_service,
    table_summary_service,
)

router = APIRouter()


def _resolve_master_table(project_name: str, *, force: bool) -> str:
    """Project-owned imported table, refreshed from its configured source."""
    try:
        status = source_table_service.ensure_master_table(project_name, force=force)
    except source_table_service.SourceTableNotConfiguredError as error:
        raise HTTPException(400, str(error))
    except source_table_service.SourceTableMissingError as error:
        raise HTTPException(409, str(error))
    except FileNotFoundError as error:
        raise HTTPException(404, str(error))
    master_path = str(status.get("master_table_path") or "")
    if not master_path or not os.path.isfile(master_path):
        raise HTTPException(409, f"No imported source table for project: {project_name}")
    return master_path


def _write_cache(cache_path: str, summary: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)


@router.get("/table_summary")
def get_table_summary(project_name: str) -> Dict[str, Any]:
    name = str(project_name or "").strip()
    if not name:
        raise HTTPException(400, "Missing project_name parameter")

    try:
        master_path = _resolve_master_table(name, force=False)
        cache_path = config.get_cache_path(name, table_summary_service.SUMMARY_VERSION)
        # Date-role columns are summarized by year, so the mapping is part of
        # what makes a cached payload current.
        date_roles = field_mapping_service.load_date_role_fields(name)

        cached_data = table_summary_service.read_valid_cache(
            master_path, cache_path, config.get_legacy_cache_path(name), date_roles)
        if cached_data is not None:
            cached_data["from_cache"] = True
            return cached_data

        summary = table_summary_service.generate_table_summary(master_path, date_roles)
        summary["from_cache"] = False
        _write_cache(cache_path, summary)
        return summary
    except ValueError as e:
        raise HTTPException(404, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error reading file: {str(e)}")


@router.post("/table_summary/refresh")
def refresh_table_summary(req: TableSummaryRefreshRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    refresh_reserving = bool(req.refresh_reserving)

    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        # A refresh re-imports a CSV-sourced project so the master copy matches
        # the external file before the summary is regenerated.
        master_path = _resolve_master_table(project_name, force=True)
        cache_path = config.get_cache_path(project_name, table_summary_service.SUMMARY_VERSION)
        # The re-import advanced the imported table's modification time, so
        # every version's cache - and the pre-versioned file - is stale now.
        cache_cleared = table_summary_service.discard_cached_summaries(
            config.list_table_summary_cache_paths(project_name)) > 0

        summary = table_summary_service.generate_table_summary(
            master_path, field_mapping_service.load_date_role_fields(project_name))
        summary["from_cache"] = False
        summary["cache_cleared"] = cache_cleared
        _write_cache(cache_path, summary)

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
