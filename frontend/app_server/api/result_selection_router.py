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


def _result_selection_save_call(req: ResultSelectionSaveRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the save both run against."""

    return {
        "args": [
            req.project_name,
            req.reserving_class,
            req.method,
            req.notes,
            req.expected_revision,
        ],
    }


@router.post("/result-selection/save/plan")
def plan_result_selection_save(req: ResultSelectionSaveRequest) -> Dict[str, Any]:
    # Step one of the two-step save: name the dependent objects this save
    # would refresh. Nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "result_selection_method",
        req.project_name,
        req.reserving_class,
        **_result_selection_save_call(req),
    )


@router.post("/result-selection/save")
def save_result_selection(req: ResultSelectionSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "result_selection_method",
        req.project_name,
        req.reserving_class,
        plan_fingerprint=req.plan_fingerprint,
        **_result_selection_save_call(req),
    )
