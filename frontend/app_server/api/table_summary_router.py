from __future__ import annotations

import os
import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.table_summary import TableSummaryRefreshRequest
from app_server.services import table_summary_service, reserving_class_service

router = APIRouter()


@router.get("/table_summary")
def get_table_summary(path: str, project_name: Optional[str] = None) -> Dict[str, Any]:
    if not path:
        raise HTTPException(400, "Missing path parameter")

    if not os.path.exists(path):
        raise HTTPException(404, f"File not found: {path}")

    try:
        cache_path = config.get_cache_path(path, project_name=project_name)

        cached_data = table_summary_service.load_valid_cache(path, cache_path)
        if cached_data is not None:
            cached_data["from_cache"] = True
            return cached_data

        summary = table_summary_service.generate_table_summary(path)
        summary["from_cache"] = False

        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)

        return summary
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Error reading file: {str(e)}")


@router.post("/table_summary/refresh")
def refresh_table_summary(req: TableSummaryRefreshRequest) -> Dict[str, Any]:
    path = str(req.path or "").strip()
    project_name = str(req.project_name or "").strip()
    refresh_reserving = bool(req.refresh_reserving)

    if not path:
        raise HTTPException(400, "path is required")

    if not os.path.exists(path):
        raise HTTPException(404, f"File not found: {path}")

    try:
        cache_path = config.get_cache_path(path, project_name=project_name)
        cache_cleared = False
        if os.path.exists(cache_path):
            os.remove(cache_path)
            cache_cleared = True

        summary = table_summary_service.generate_table_summary(path)
        summary["from_cache"] = False
        summary["cache_cleared"] = cache_cleared

        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)

        if refresh_reserving and project_name:
            refresh_out = reserving_class_service.refresh_reserving_class_values(
                project_name=project_name,
                table_path_override=path,
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
