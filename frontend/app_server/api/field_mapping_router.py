from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from arcrho_api.source_table_contract import normalize_import_source_path
from app_server.schemas.field_mapping import FieldMappingSaveRequest
from app_server.services import field_mapping_service, workspace_mutation_client, workspace_read_client

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
    # Saved on the server host, which also rebuilds the reserving-class values
    # from the imported table there.
    kwargs: Dict[str, Any] = {
        "project_name": req.project_name,
        "rows": [row.model_dump() for row in req.rows],
    }
    if req.table_path is not None:
        # Only this PC knows what its drive letters stand for.
        kwargs["table_path"] = normalize_import_source_path(req.table_path)
    return workspace_mutation_client.run_workspace_mutation(
        "field_mapping_save",
        kwargs,
        local=lambda: field_mapping_service.save_field_mapping(**kwargs),
        gateway_required=True,
    )
