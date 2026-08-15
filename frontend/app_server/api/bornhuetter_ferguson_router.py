from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.bornhuetter_ferguson import (
    BornhuetterFergusonIdentityRequest,
    BornhuetterFergusonSaveRequest,
)
from app_server.services import (
    bornhuetter_ferguson_service,
    engine_hosted_save_service,
    workspace_read_client,
)


router = APIRouter()


@router.post("/bornhuetter-ferguson/load")
def load_bornhuetter_ferguson(req: BornhuetterFergusonIdentityRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "bornhuetter_ferguson_load",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method_name": req.method_name,
        },
        local=lambda: bornhuetter_ferguson_service.load_bornhuetter_ferguson_method(
            req.project_name,
            req.reserving_class,
            req.method_name,
        ),
    )


def _bornhuetter_ferguson_save_call(req: BornhuetterFergusonSaveRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the save both run against."""

    return {
        "args": [req.project_name, req.reserving_class, req.method],
        "kwargs": {
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    }


@router.post("/bornhuetter-ferguson/save/plan")
def plan_bornhuetter_ferguson_save(req: BornhuetterFergusonSaveRequest) -> Dict[str, Any]:
    # Step one of the two-step save: name the dependent objects this save
    # would refresh. Nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "bornhuetter_ferguson_method",
        req.project_name,
        req.reserving_class,
        **_bornhuetter_ferguson_save_call(req),
    )


@router.post("/bornhuetter-ferguson/save")
def save_bornhuetter_ferguson(req: BornhuetterFergusonSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "bornhuetter_ferguson_method",
        req.project_name,
        req.reserving_class,
        plan_fingerprint=req.plan_fingerprint,
        **_bornhuetter_ferguson_save_call(req),
    )


@router.post("/bornhuetter-ferguson/refresh")
def refresh_bornhuetter_ferguson(req: BornhuetterFergusonIdentityRequest) -> Dict[str, Any]:
    return bornhuetter_ferguson_service.refresh_bornhuetter_ferguson_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
    )
