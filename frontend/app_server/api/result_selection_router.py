from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.result_selection import (
    ResultSelectionLoadRequest,
    ResultSelectionSaveRequest,
)
from app_server.services import engine_hosted_save_service, result_selection_service


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
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "result_selection_method",
        req.project_name,
        req.reserving_class,
        args=[
            req.project_name,
            req.reserving_class,
            req.method,
            req.notes,
            req.expected_revision,
        ],
    )
