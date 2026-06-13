from __future__ import annotations

import os
import json
from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.dataset_types import DatasetTypesSaveRequest, DatasetTypesImportLocalFileRequest
from app_server.services import calculated_dataset_service, dataset_types_service
from app_server.services.audit_service import safe_append_project_audit_log
from app_server.helpers import _canon_dataset_name, _parse_calculated_flag

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
    project_name = (req.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")

    try:
        filepath = config.get_dataset_types_path(project_name)
    except ValueError as e:
        raise HTTPException(404, str(e))

    previous_rows: List[List[Any]] = []
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f_prev:
                previous_raw = json.load(f_prev)
            previous_rows = list(dataset_types_service.normalize_dataset_types_data(previous_raw).get("rows") or [])
        except Exception:
            previous_rows = []

    source_map = dataset_types_service._load_dataset_source_map(project_name)
    field_names = dataset_types_service._load_field_mapping_field_names(project_name)
    normalized_rows_base: List[List[Any]] = []
    for row in req.rows or []:
        if not isinstance(row, list):
            continue
        norm = [
            str(row[0] if len(row) > 0 and row[0] is not None else "").strip(),
            str(row[1] if len(row) > 1 and row[1] is not None else "").strip(),
            str(row[2] if len(row) > 2 and row[2] is not None else "").strip(),
            _parse_calculated_flag(row[3] if len(row) > 3 else False),
            str(row[4] if len(row) > 4 and row[4] is not None else "").strip(),
        ]
        if not norm[3]:
            norm[4] = ""
        if norm[0] != "" or norm[1] != "" or norm[2] != "" or norm[4] != "" or norm[3] is True:
            normalized_rows_base.append(norm)

    resolve_dataset_source = dataset_types_service._build_dataset_source_resolver(normalized_rows_base, source_map)
    known_dataset_names = [
        str(r[0]).strip()
        for r in normalized_rows_base
        if isinstance(r, list) and len(r) > 0 and str(r[0] if r[0] is not None else "").strip()
    ]

    known_dataset_name_keys = set()
    for name in known_dataset_names:
        name_key = _canon_dataset_name(name)
        if name_key:
            known_dataset_name_keys.add(name_key)

    validation_errors: List[str] = []
    for norm in normalized_rows_base:
        dataset_name = str(norm[0] if len(norm) > 0 and norm[0] is not None else "").strip()
        is_calculated = _parse_calculated_flag(norm[3] if len(norm) > 3 else False)
        formula = str(norm[4] if len(norm) > 4 and norm[4] is not None else "").strip()
        if not dataset_name or not is_calculated or not formula:
            continue

        components = dataset_types_service._extract_formula_components(formula, known_dataset_names)
        unresolved_components: List[str] = []
        for comp in components:
            comp_key = _canon_dataset_name(comp)
            if not comp_key or comp_key not in known_dataset_name_keys:
                unresolved_components.append(comp)
        if unresolved_components:
            detail = f"{dataset_name}: unresolved in formula"
            if unresolved_components:
                detail += f" [{', '.join(unresolved_components[:6])}]"
            validation_errors.append(detail)

    if validation_errors:
        sample = "; ".join(validation_errors[:6])
        more = f" (+{len(validation_errors) - 6} more)" if len(validation_errors) > 6 else ""
        raise HTTPException(
            400,
            f"Invalid formula: unresolved dataset component found. {sample}{more}. "
            "Please fix formula components, then save again.",
        )

    normalized_rows: List[List[Any]] = []
    for norm in normalized_rows_base:
        source_value = str(resolve_dataset_source(norm[0]) or "").strip()
        if source_value == "":
            source_value = str(source_map.get(_canon_dataset_name(norm[0]), "") or "").strip()
        generated = dataset_types_service._is_source_generated_from_field_names(source_value, field_names)
        normalized_rows.append([norm[0], norm[1], norm[2], norm[3], norm[4], source_value, generated])

    payload = {
        "columns": list(config.DATASET_TYPES_FILE_COLUMNS),
        "rows": normalized_rows,
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }

    try:
        dataset_types_service.save_dataset_types_payload(filepath, payload)
        changed_formula_types = calculated_dataset_service.changed_formula_dataset_type_names(
            previous_rows,
            normalized_rows,
        )
        calculation_updates = calculated_dataset_service.refresh_sidecar_graphs_and_recalculate(
            project_name,
            changed_formula_types,
        )
        safe_append_project_audit_log(
            project_name=project_name,
            action=f"Saved Dataset Types ({len(normalized_rows)} rows)",
        )
        return {
            "ok": True,
            "path": filepath,
            "count": len(normalized_rows),
            "changed_formula_types": changed_formula_types,
            "calculated_updates": calculation_updates,
        }
    except PermissionError:
        raise HTTPException(423, "Dataset types file is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save dataset types: {str(e)}")
