from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.bornhuetter_ferguson import (
    BornhuetterFergusonIdentityRequest,
    BornhuetterFergusonSaveRequest,
)
from app_server.services import bornhuetter_ferguson_service


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
    return bornhuetter_ferguson_service.save_bornhuetter_ferguson_method(
        req.project_name,
        req.reserving_class,
        req.method,
        notes=req.notes,
        expected_owned_revision=req.expected_owned_revision,
        expected_derived_revision=req.expected_derived_revision,
    )


@router.post("/bornhuetter-ferguson/refresh")
def refresh_bornhuetter_ferguson(req: BornhuetterFergusonIdentityRequest) -> Dict[str, Any]:
    return bornhuetter_ferguson_service.refresh_bornhuetter_ferguson_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
