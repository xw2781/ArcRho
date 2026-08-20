from __future__ import annotations

from fastapi import APIRouter

from app_server.schemas.object_change_watch import (
    ObjectChangeAttributionResponse,
    ObjectChangeFingerprintRequest,
    ObjectChangeFingerprintResponse,
)
from app_server.services import object_change_watch_service

router = APIRouter()


@router.post(
    "/object_change/fingerprint",
    response_model=ObjectChangeFingerprintResponse,
)
def get_object_change_fingerprint(
    req: ObjectChangeFingerprintRequest,
) -> ObjectChangeFingerprintResponse:
    return object_change_watch_service.object_change_fingerprint(
        req.project_name,
        req.reserving_class,
        req.kind,
        req.name,
        method_type=req.method_type,
        output_dataset=req.output_dataset,
    )


@router.post(
    "/object_change/attribution",
    response_model=ObjectChangeAttributionResponse,
)
def get_object_change_attribution(
    req: ObjectChangeFingerprintRequest,
) -> ObjectChangeAttributionResponse:
    return object_change_watch_service.object_change_attribution(
        req.project_name,
        req.reserving_class,
        req.kind,
        req.name,
        method_type=req.method_type,
        output_dataset=req.output_dataset,
    )
