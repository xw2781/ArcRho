"""Field mapping save logic with reserving class refresh orchestration."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from arcrho_api.field_mapping_contract import (
    DATE_ROLE_SIGNIFICANCES,
    period_months_from_date_value,
    source_period_months,
    source_period_months_field,
)
from arcrho_api.io import persisted_json_text
from arcrho_api.timestamps import utc_now_text
from app_server import config
from app_server.helpers import _canon_dataset_name
from app_server.services.audit_service import safe_append_project_audit_log
from app_server.services.dataset_types_service import get_dataset_type_names
from app_server.services import reserving_class_service


def _load_mapping_payload(project_name: str) -> Dict[str, Any]:
    """The project's stored mapping, or an empty one when there is none."""
    try:
        filepath = config.get_field_mapping_path(project_name)
    except ValueError:
        return {}
    if not os.path.exists(filepath):
        return {}
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def load_date_role_fields(project_name: str) -> Dict[str, str]:
    """Mapped field name for each date significance, keyed by column name.

    The canonical answer to "which columns hold a reserving period" for this
    project. Consumers must read it here rather than re-deriving the rule from
    `field_mapping.json`, and a missing or unreadable mapping simply means no
    column carries a date role.
    """
    raw = _load_mapping_payload(project_name)

    rows = raw.get("rows", [])
    if not isinstance(rows, list):
        return {}

    roles: Dict[str, str] = {}
    claimed: set = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        significance = str(row.get("significance") or "").strip()
        field_name = str(row.get("field_name") or "").strip()
        # First row wins per significance, matching how the mapping panel
        # resolves a duplicate assignment.
        if not field_name or significance in claimed:
            continue
        if significance in config.FIELD_MAPPING_DATE_SIGNIFICANCES:
            roles[field_name] = significance
            claimed.add(significance)
    return roles


def detect_source_period_months(
    project_name: str,
    date_roles: Optional[Dict[str, str]] = None,
) -> Dict[str, int]:
    """Months per period of each date-role column of the imported table.

    Read straight from the data, because the column itself is the only place
    that says whether the project's periods are years or months. A role whose
    column is absent or holds nothing readable is left out of the answer.
    """
    roles = load_date_role_fields(project_name) if date_roles is None else date_roles
    wanted = {
        significance: column
        for column, significance in roles.items()
        if significance in DATE_ROLE_SIGNIFICANCES
    }
    if not wanted:
        return {}
    try:
        table_path = config.get_project_master_table_path(project_name)
    except ValueError:
        return {}
    if not os.path.isfile(table_path):
        return {}

    import pandas as pd

    months: Dict[str, int] = {}
    for significance, column in wanted.items():
        try:
            values = pd.read_csv(table_path, usecols=[column])[column].dropna()
        except (OSError, ValueError, KeyError):
            continue
        if values.empty:
            continue
        detected = period_months_from_date_value(values.iloc[0])
        if detected:
            months[significance] = detected
    return months


def _persist_source_period_months(project_name: str, months: Dict[str, int]) -> None:
    payload = _load_mapping_payload(project_name)
    if not payload:
        return
    payload.update(source_period_months_field(months))
    filepath = config.get_field_mapping_path(project_name)
    tmp_path = filepath + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(persisted_json_text(payload))
    os.replace(tmp_path, filepath)


def load_source_period_months(project_name: str) -> Dict[str, int]:
    """Months per period of this project's source dates, by date significance.

    The canonical answer to "how fine is this project's source data", which is
    the shape an Engine-generated dataset can be rebuilt at whatever period it
    was last generated at. A mapping saved before the granularity was recorded
    is measured once here and the answer written back, so the first read after
    an upgrade costs a table read and no later one does.
    """
    name = str(project_name or "").strip()
    if not name:
        return {}
    recorded = source_period_months(_load_mapping_payload(name))
    if recorded:
        return recorded
    detected = detect_source_period_months(name)
    if detected:
        try:
            _persist_source_period_months(name, detected)
        except OSError:
            # Another user holding the mapping open only costs the next read
            # the same measurement; it must not fail the dataset being written.
            pass
    return detected


def save_field_mapping(
    project_name: str,
    table_path: Optional[str],
    rows: list,
) -> Dict[str, Any]:
    project_name = (project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        filepath = config.get_field_mapping_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    if table_path is None:
        # The CSV selection is owned by the import-profile save; a rows-only
        # save keeps whatever path is already stored.
        table_path = ""
        if os.path.exists(filepath):
            try:
                with open(filepath, "r", encoding="utf-8-sig") as f_prev:
                    existing = json.load(f_prev)
                if isinstance(existing, dict):
                    table_path = str(existing.get("table_path") or "").strip()
            except Exception:
                table_path = ""

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

    # First mapped row wins per significance, as `load_date_role_fields` reads
    # the file back.
    date_roles: Dict[str, str] = {}
    for row in normalized_rows:
        significance = row["significance"]
        if significance in DATE_ROLE_SIGNIFICANCES and significance not in date_roles.values():
            date_roles[row["field_name"]] = significance
    payload = {
        "project_name": project_name,
        "table_path": (table_path or "").strip(),
        "updated_at": utc_now_text(),
        **source_period_months_field(
            detect_source_period_months(project_name, date_roles)
        ),
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
            f.write(persisted_json_text(payload))
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
