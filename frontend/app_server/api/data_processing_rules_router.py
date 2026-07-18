from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.data_processing_rules import (
    DataProcessingRulesSaveRequest,
    DataProcessingRulesValidateRequest,
)
from app_server.services import data_processing_rules_service, data_processing_values_service


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
