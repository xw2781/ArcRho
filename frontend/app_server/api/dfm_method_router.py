from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.dfm_method import (
    DfmMethodIdentityRequest,
    DfmMethodPreviewRequest,
    DfmMethodSaveRequest,
)
from app_server.services import dfm_service


router = APIRouter()


@router.post("/dfm/method/load")
def load_dfm_method(req: DfmMethodIdentityRequest) -> Dict[str, Any]:
    return dfm_service.load_dfm_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
        output_dataset=req.output_dataset,
    )


@router.post("/dfm/method/preview")
def preview_dfm_method(req: DfmMethodPreviewRequest) -> Dict[str, Any]:
    return dfm_service.preview_dfm_method(req.method)


@router.post("/dfm/method/save")
def save_dfm_method(req: DfmMethodSaveRequest) -> Dict[str, Any]:
    return dfm_service.save_dfm_method(
        req.project_name,
        req.reserving_class,
        req.method,
        notes=req.notes,
        expected_owned_revision=req.expected_owned_revision,
        expected_derived_revision=req.expected_derived_revision,
    )


@router.post("/dfm/method/refresh")
def refresh_dfm_method(req: DfmMethodIdentityRequest) -> Dict[str, Any]:
    return dfm_service.refresh_dfm_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
        output_dataset=req.output_dataset,
    )
