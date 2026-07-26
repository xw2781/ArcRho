from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.result_selection import (
    ResultSelectionLoadRequest,
    ResultSelectionSaveRequest,
)
from app_server.services import result_selection_service


router = APIRouter()


@router.post("/result-selection/load")
def load_result_selection(req: ResultSelectionLoadRequest) -> Dict[str, Any]:
    return result_selection_service.load_result_selection(
        req.project_name,
        req.reserving_class,
        req.method_name,
        include_method=req.include_method,
    )


@router.post("/result-selection/save")
def save_result_selection(req: ResultSelectionSaveRequest) -> Dict[str, Any]:
    return result_selection_service.save_result_selection(
        req.project_name,
        req.reserving_class,
        req.method,
        req.notes,
        req.expected_revision,
    )
