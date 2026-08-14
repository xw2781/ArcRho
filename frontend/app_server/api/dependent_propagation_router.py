from __future__ import annotations

from fastapi import APIRouter, status

from app_server.schemas.dependent_propagation import (
    DependentPropagationJobStatusResponse,
    RefreshDependentsJobRequest,
    RefreshDependentsJobResponse,
    ReservingClassBusyResponse,
)
from app_server.services import dependent_propagation_service

router = APIRouter()


@router.post(
    "/dependent_propagation/refresh_dependents",
    response_model=RefreshDependentsJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def submit_refresh_dependents_job(
    req: RefreshDependentsJobRequest,
) -> RefreshDependentsJobResponse:
    return dependent_propagation_service.submit_dependent_propagation_job(
        req.project_name,
        req.reserving_class,
        [
            {"dataset_name": root.dataset_name, "dataset_type": root.dataset_type}
            for root in req.changed_roots
        ],
        request_id=req.request_id,
    )


@router.get(
    "/dependent_propagation/refresh_dependents/status/{request_id}",
    response_model=DependentPropagationJobStatusResponse,
    response_model_exclude_none=True,
)
def get_refresh_dependents_job_status(
    request_id: str,
) -> DependentPropagationJobStatusResponse:
    return dependent_propagation_service.get_dependent_propagation_status(request_id)


@router.get(
    "/dependent_propagation/reserving_class_busy",
    response_model=ReservingClassBusyResponse,
)
def get_reserving_class_busy(
    project_name: str, reserving_class: str
) -> ReservingClassBusyResponse:
    return dependent_propagation_service.get_reserving_class_busy(
        project_name, reserving_class
    )
