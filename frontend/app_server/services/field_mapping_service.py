"""Field mapping save logic with reserving class refresh orchestration."""
from __future__ import annotations

import os
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from app_server import config
from app_server.helpers import _canon_dataset_name
from app_server.services.audit_service import safe_append_project_audit_log
from app_server.services.dataset_types_service import get_dataset_type_names
from app_server.services import reserving_class_service


def save_field_mapping(
    project_name: str,
    table_path: str,
    rows: list,
) -> Dict[str, Any]:
    project_name = (project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        filepath = config.get_field_mapping_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    allowed_dataset_types = set(get_dataset_type_names(project_name))
    used_dataset_types: Dict[str, str] = {}
    normalized_rows: List[Dict[str, Any]] = []
    for row in rows:
        field_name = (row.field_name or "").strip()
        if not field_name:
            continue

        significance = (row.significance or "").strip()
        if not significance or significance == "Not Used":
            continue
        if significance not in config.FIELD_MAPPING_SIGNIFICANCES:
            raise HTTPException(400, f"Invalid significance for field '{field_name}': {significance}")

        level = None
        dataset_type = None
        if significance == "Reserving Class":
            if row.level is None or int(row.level) < 1:
                raise HTTPException(400, f"Level must be integer >= 1 for field '{field_name}'")
            level = int(row.level)
        if significance == "Dataset":
            dataset_type = str(row.dataset_type or "").strip()
            if not dataset_type:
                raise HTTPException(400, f"Dataset Type is required for field '{field_name}'")
            if allowed_dataset_types and dataset_type not in allowed_dataset_types:
                raise HTTPException(400, f"Invalid Dataset Type for field '{field_name}': {dataset_type}")
            dataset_key = _canon_dataset_name(dataset_type)
            if dataset_key:
                prev_field = used_dataset_types.get(dataset_key)
                if prev_field and prev_field != field_name:
                    raise HTTPException(
                        400,
                        f"Dataset Type '{dataset_type}' is already used by field '{prev_field}'. "
                        f"Each Dataset Type can only be mapped once.",
                    )
                used_dataset_types[dataset_key] = field_name

        normalized_rows.append({
            "field_name": field_name,
            "significance": significance,
            "dataset_type": dataset_type,
            "level": level,
        })

    payload = {
        "project_name": project_name,
        "table_path": (table_path or "").strip(),
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "rows": normalized_rows,
    }

    previous_mapping_bytes: Optional[bytes] = None
    previous_mapping_exists = os.path.exists(filepath)
    if previous_mapping_exists:
        try:
            with open(filepath, "rb") as f_prev:
                previous_mapping_bytes = f_prev.read()
        except Exception:
            previous_mapping_bytes = None

    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        tmp_path = filepath + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, filepath)

        try:
            refresh_out = reserving_class_service.refresh_reserving_class_values(
                project_name=project_name,
                mapping_rows_override=normalized_rows,
            )
        except Exception as refresh_err:
            try:
                if previous_mapping_exists:
                    if previous_mapping_bytes is None:
                        raise RuntimeError("Previous field mapping content is unavailable for rollback.")
                    rb_tmp = filepath + ".rollback.tmp"
                    with open(rb_tmp, "wb") as f_rb:
                        f_rb.write(previous_mapping_bytes)
                    os.replace(rb_tmp, filepath)
                elif os.path.exists(filepath):
                    os.remove(filepath)
            except Exception as rollback_err:
                raise HTTPException(
                    500,
                    f"Failed to refresh reserving class values: {str(refresh_err)}; "
                    f"failed to roll back field mapping: {str(rollback_err)}"
                )
            raise HTTPException(500, f"Failed to refresh reserving class values: {str(refresh_err)}")

        safe_append_project_audit_log(
            project_name=project_name,
            action=f"Saved Field Mapping ({len(normalized_rows)} mapped rows)",
        )

        return {
            "ok": True,
            "path": filepath,
            "count": len(normalized_rows),
            "reserving_class_values_path": refresh_out.get("path", ""),
            "reserving_class_field_count": refresh_out.get("field_count", 0),
            "reserving_class_value_count": refresh_out.get("value_count", 0),
            "reserving_class_combinations_path": refresh_out.get("combination_path", ""),
            "reserving_class_combination_count": refresh_out.get("combination_count", 0),
            "reserving_class_types_path": refresh_out.get("reserving_class_types_path", ""),
            "reserving_class_types_count": refresh_out.get("reserving_class_types_count", 0),
            "missing_columns": refresh_out.get("missing_columns", []),
        }
    except PermissionError:
        raise HTTPException(423, "Field mapping file is locked. Another user may have it open.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to save field mapping: {str(e)}")
