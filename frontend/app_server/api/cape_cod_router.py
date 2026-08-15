from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.cape_cod import (
    CapeCodIdentityRequest,
    CapeCodSaveRequest,
)
from app_server.services import (
    cape_cod_service,
    engine_hosted_save_service,
    workspace_read_client,
)


router = APIRouter()


@router.post("/cape-cod/load")
def load_cape_cod(req: CapeCodIdentityRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "cape_cod_load",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method_name": req.method_name,
        },
        local=lambda: cape_cod_service.load_cape_cod_method(
            req.project_name,
            req.reserving_class,
            req.method_name,
        ),
    )


def _cape_cod_save_call(req: CapeCodSaveRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the save both run against."""

    return {
        "args": [req.project_name, req.reserving_class, req.method],
        "kwargs": {
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    }


@router.post("/cape-cod/save/plan")
def plan_cape_cod_save(req: CapeCodSaveRequest) -> Dict[str, Any]:
    # Step one of the two-step save: name the dependent objects this save
    # would refresh. Nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "cape_cod_method",
        req.project_name,
        req.reserving_class,
        **_cape_cod_save_call(req),
    )


@router.post("/cape-cod/save")
def save_cape_cod(req: CapeCodSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "cape_cod_method",
        req.project_name,
        req.reserving_class,
        plan_fingerprint=req.plan_fingerprint,
        **_cape_cod_save_call(req),
    )


@router.post("/cape-cod/refresh")
def refresh_cape_cod(req: CapeCodIdentityRequest) -> Dict[str, Any]:
    return cape_cod_service.refresh_cape_cod_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
