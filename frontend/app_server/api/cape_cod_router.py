from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.cape_cod import (
    CapeCodIdentityRequest,
    CapeCodSaveRequest,
)
from app_server.services import cape_cod_service


router = APIRouter()


@router.post("/cape-cod/load")
def load_cape_cod(req: CapeCodIdentityRequest) -> Dict[str, Any]:
    return cape_cod_service.load_cape_cod_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )


@router.post("/cape-cod/save")
def save_cape_cod(req: CapeCodSaveRequest) -> Dict[str, Any]:
    return cape_cod_service.save_cape_cod_method(
        req.project_name,
        req.reserving_class,
        req.method,
        notes=req.notes,
        expected_owned_revision=req.expected_owned_revision,
        expected_derived_revision=req.expected_derived_revision,
    )


@router.post("/cape-cod/refresh")
def refresh_cape_cod(req: CapeCodIdentityRequest) -> Dict[str, Any]:
    return cape_cod_service.refresh_cape_cod_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
