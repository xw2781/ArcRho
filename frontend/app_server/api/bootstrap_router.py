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


def _bootstrap_save_call(req: BootstrapSaveRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the save both run against."""

    return {
        "args": [req.project_name, req.reserving_class, req.method],
        "kwargs": {
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    }


@router.post("/bootstrap/save/plan")
def plan_bootstrap_save(req: BootstrapSaveRequest) -> Dict[str, Any]:
    # Step one of the two-step save: name the dependent objects this save
    # would refresh. Nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "bootstrap_method",
        req.project_name,
        req.reserving_class,
        **_bootstrap_save_call(req),
    )


@router.post("/bootstrap/save")
def save_bootstrap(req: BootstrapSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "bootstrap_method",
        req.project_name,
        req.reserving_class,
        plan_fingerprint=req.plan_fingerprint,
        **_bootstrap_save_call(req),
    )


@router.post("/bootstrap/refresh")
def refresh_bootstrap(req: BootstrapIdentityRequest) -> Dict[str, Any]:
    return bootstrap_service.refresh_bootstrap_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
