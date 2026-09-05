from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.data_processing_rules import (
    DataProcessingRulesSaveJobRequest,
    DataProcessingRulesSaveRequest,
    DataProcessingRulesValidateRequest,
)
from app_server.services import (
    data_processing_rules_job_service,
    data_processing_rules_service,
    data_processing_values_service,
    workspace_mutation_client,
    workspace_read_client,
)


router = APIRouter()


def _request_data_dict(data: Any) -> Dict[str, Any]:
    if hasattr(data, "model_dump"):
        return data.model_dump(exclude_none=True)
    return data.dict(exclude_none=True) if hasattr(data, "dict") else dict(data or {})


@router.get("/data_processing_rules")
def get_data_processing_rules(project_name: str) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "project_name is required")
    try:
        return data_processing_rules_service.get_data_processing_rules(project_name_clean)
    except data_processing_rules_service.StoredRulesContractError as error:
        raise HTTPException(422, str(error))
    except data_processing_values_service.DataProcessingValuesLockedError as error:
        raise HTTPException(423, str(error))
    except ValueError as error:
        message = str(error)
        if "Project folder not found under projects:" in message:
            raise HTTPException(404, message)
        raise HTTPException(400, message)
    except PermissionError:
        raise HTTPException(423, "Data processing rules file is locked. Please retry.")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to read data processing rules: {str(error)}")


@router.post("/data_processing_rules/validate")
def validate_data_processing_rules(
    request: DataProcessingRulesValidateRequest,
) -> Dict[str, Any]:
    project_name = str(request.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        return data_processing_rules_service.validate_data_processing_rules(
            project_name,
            _request_data_dict(request.data),
        )
    except data_processing_values_service.DataProcessingValuesLockedError as error:
        raise HTTPException(423, str(error))
    except ValueError as error:
        message = str(error)
        if "Project folder not found under projects:" in message:
            raise HTTPException(404, message)
        raise HTTPException(400, message)
    except Exception as error:
        raise HTTPException(500, f"Failed to validate data processing rules: {str(error)}")


@router.post("/data_processing_rules")
def save_data_processing_rules(
    request: DataProcessingRulesSaveRequest,
) -> Dict[str, Any]:
    project_name = str(request.project_name or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    try:
        return data_processing_rules_service.save_data_processing_rules(
            project_name,
            expected_revision=int(request.expected_revision),
            data=_request_data_dict(request.data),
        )
    except data_processing_rules_service.RulesRevisionConflictError as error:
        raise HTTPException(409, str(error))
    except data_processing_rules_service.RulesWriteLockedError as error:
        raise HTTPException(423, str(error))
    except data_processing_rules_service.RulesValidationError as error:
        raise HTTPException(400, "; ".join(error.errors) or str(error))
    except data_processing_values_service.DataProcessingValuesLockedError as error:
        raise HTTPException(423, str(error))
    except ValueError as error:
        message = str(error)
        if "Project folder not found under projects:" in message:
            raise HTTPException(404, message)
        raise HTTPException(400, message)
    except PermissionError:
        raise HTTPException(423, "Data processing rules file is locked. Please retry.")
    except Exception as error:
        raise HTTPException(500, f"Failed to save data processing rules: {str(error)}")


@router.post("/data_processing_rules/save_job")
def submit_data_processing_rules_save_job(
    request: DataProcessingRulesSaveJobRequest,
) -> Dict[str, Any]:
    """Queue the save for ArcRho Engine and answer with the job identity.

    The save is the same one ``POST /data_processing_rules`` performs, run on
    the server host where the sidecar walk after the write is local disk;
    the caller polls ``/data_processing_rules/save_job/status`` and reads the
    save response from the terminal status. A 503 means no Engine is running,
    which is the one outcome the caller handles by saving directly instead.
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
