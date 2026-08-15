from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.dfm_method import (
    DfmDatasetReferencesResolveRequest,
    DfmMethodIdentityRequest,
    DfmMethodPreviewRequest,
    DfmMethodSaveRequest,
)
from app_server.services import dfm_service, engine_hosted_save_service, workspace_read_client


router = APIRouter()


@router.post("/dfm/method/dataset-references/resolve")
def resolve_dfm_dataset_references(req: DfmDatasetReferencesResolveRequest) -> Dict[str, Any]:
    return dfm_service.resolve_dfm_dataset_references(
        req.project_name,
        req.reserving_class,
        [reference.model_dump() for reference in req.references],
    )


@router.post("/dfm/method/load")
def load_dfm_method(req: DfmMethodIdentityRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "dfm_method_load",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method_name": req.method_name,
            "output_dataset": req.output_dataset,
        },
        local=lambda: dfm_service.load_dfm_method(
            req.project_name,
            req.reserving_class,
            req.method_name,
            output_dataset=req.output_dataset,
        ),
    )


@router.post("/dfm/method/preview")
def preview_dfm_method(req: DfmMethodPreviewRequest) -> Dict[str, Any]:
    return dfm_service.preview_dfm_method(req.method)


def _dfm_method_save_call(req: DfmMethodSaveRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the save both run against."""

    return {
        "args": [req.project_name, req.reserving_class, req.method],
        "kwargs": {
            "notes": req.notes,
            "expected_owned_revision": req.expected_owned_revision,
            "expected_derived_revision": req.expected_derived_revision,
        },
    }


@router.post("/dfm/method/save/plan")
def plan_dfm_method_save(req: DfmMethodSaveRequest) -> Dict[str, Any]:
    # Step one of the two-step save: name the dependent objects this save
    # would refresh. Nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "dfm_method",
        req.project_name,
        req.reserving_class,
        **_dfm_method_save_call(req),
    )


@router.post("/dfm/method/save")
def save_dfm_method(req: DfmMethodSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "dfm_method",
        req.project_name,
        req.reserving_class,
        plan_fingerprint=req.plan_fingerprint,
        **_dfm_method_save_call(req),
    )


@router.post("/dfm/method/refresh")
def refresh_dfm_method(req: DfmMethodIdentityRequest) -> Dict[str, Any]:
    return dfm_service.refresh_dfm_method(
        req.project_name,
        req.reserving_class,
        req.method_name,
        output_dataset=req.output_dataset,
    )
