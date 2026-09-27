from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.data_processing_rules import (
    DataProcessingRulesSaveJobRequest,
    DataProcessingRulesValidateRequest,
)
from app_server.services import (
    data_processing_rules_job_service,
    data_processing_rules_service,
    workspace_mutation_client,
    workspace_read_client,
)


router = APIRouter()


def _request_data_dict(data: Any) -> Dict[str, Any]:
    if hasattr(data, "model_dump"):
        return data.model_dump(exclude_none=True)
    return data.dict(exclude_none=True) if hasattr(data, "dict") else dict(data or {})


# The GET and validate read on the server host through the Gateway and write
# nothing: they take the imported master table and the vocabulary cache as
# they stand. The source refresh job (and a rules save) keep those current.


@router.get("/data_processing_rules")
def get_data_processing_rules(project_name: str) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "project_name is required")
    return workspace_read_client.run_workspace_read(
        "data_processing_rules",
        {"project_name": project_name_clean},
        local=lambda: data_processing_rules_service.read_data_processing_rules(project_name_clean),
    )


@router.post("/data_processing_rules/validate")
def validate_data_processing_rules(
    request: DataProcessingRulesValidateRequest,
) -> Dict[str, Any]:
    project_name = str(request.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    data = _request_data_dict(request.data)
    return workspace_read_client.run_workspace_read(
        "data_processing_rules_validate",
        {"project_name": project_name, "data": data},
        local=lambda: data_processing_rules_service.check_data_processing_rules(project_name, data),
    )


@router.post("/data_processing_rules/save_job")
def submit_data_processing_rules_save_job(
    request: DataProcessingRulesSaveJobRequest,
) -> Dict[str, Any]:
    """Queue the save for Arco Engine and answer with the job identity.

    The save is the same one ``POST /data_processing_rules`` performs, run on
    the server host where the sidecar walk after the write is local disk;
    the caller polls ``/data_processing_rules/save_job/status`` and reads the
    save response from the terminal status. This is the only way the rules
    are saved: a 503 (no Engine, or no server) is shown to the user.
    """

    project_name = str(request.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    kwargs = {
        "project_name": project_name,
        "request_id": str(request.request_id or "").strip(),
        "expected_revision": int(request.expected_revision),
        "rules": list(_request_data_dict(request.data).get("rules") or []),
    }
    return workspace_mutation_client.run_workspace_mutation(
        "data_processing_rules_save_submit",
        kwargs,
        local=lambda: data_processing_rules_job_service.submit_data_processing_rules_job(
            **kwargs
        ),
    )


@router.get("/data_processing_rules/save_job/status")
def get_data_processing_rules_save_job_status(
    project_name: str, job_id: str = ""
) -> Dict[str, Any]:
    kwargs = {"project_name": project_name, "job_id": job_id}
    return workspace_read_client.run_workspace_read(
        "data_processing_rules_job_status",
        kwargs,
        local=lambda: data_processing_rules_job_service.get_data_processing_rules_job_status(
            **kwargs
        ),
    )
