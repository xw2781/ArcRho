from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.bootstrap import (
    BootstrapIdentityRequest,
    BootstrapSaveRequest,
)
from app_server.services import bootstrap_service, engine_hosted_save_service


router = APIRouter()


@router.post("/bootstrap/load")
def load_bootstrap(req: BootstrapIdentityRequest) -> Dict[str, Any]:
    return bootstrap_service.load_bootstrap_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )


@router.post("/bootstrap/save")
def save_bootstrap(req: BootstrapSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "bootstrap_method",
        req.project_name,
        req.reserving_class,
        args=[req.project_name, req.reserving_class, req.method],
        kwargs={
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    )


@router.post("/bootstrap/refresh")
def refresh_bootstrap(req: BootstrapIdentityRequest) -> Dict[str, Any]:
    return bootstrap_service.refresh_bootstrap_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
