from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.bornhuetter_ferguson import (
    BornhuetterFergusonIdentityRequest,
    BornhuetterFergusonSaveRequest,
)
from app_server.services import bornhuetter_ferguson_service, engine_hosted_save_service


router = APIRouter()


@router.post("/bornhuetter-ferguson/load")
def load_bornhuetter_ferguson(req: BornhuetterFergusonIdentityRequest) -> Dict[str, Any]:
    return bornhuetter_ferguson_service.load_bornhuetter_ferguson_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )


@router.post("/bornhuetter-ferguson/save")
def save_bornhuetter_ferguson(req: BornhuetterFergusonSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "bornhuetter_ferguson_method",
        req.project_name,
        req.reserving_class,
        args=[req.project_name, req.reserving_class, req.method],
        kwargs={
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    )


@router.post("/bornhuetter-ferguson/refresh")
def refresh_bornhuetter_ferguson(req: BornhuetterFergusonIdentityRequest) -> Dict[str, Any]:
    return bornhuetter_ferguson_service.refresh_bornhuetter_ferguson_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
