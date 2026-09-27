from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.field_mapping import FieldMappingSaveRequest
from app_server.services import field_mapping_service, workspace_read_client

router = APIRouter()


@router.get("/field_mapping")
def get_field_mapping(project_name: str) -> Dict[str, Any]:
    if not project_name or not project_name.strip():
        raise HTTPException(400, "Missing project_name parameter")
    # Read on the server host through the Gateway; a Client PC never opens
    # the mapping over the share.
    return workspace_read_client.run_workspace_read(
        "field_mapping",
        {"project_name": project_name},
        local=lambda: field_mapping_service.get_field_mapping(project_name),
        gateway_required=True,
    )


@router.post("/field_mapping")
def save_field_mapping(req: FieldMappingSaveRequest) -> Dict[str, Any]:
    return field_mapping_service.save_field_mapping(
        project_name=req.project_name,
        table_path=req.table_path,
        rows=req.rows,
    )
