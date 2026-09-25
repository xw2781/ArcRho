from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from arcrho_api.bootstrap_contract import BST_JSON_FORMAT, owned_projection
from app_server.schemas.bootstrap import (
    BootstrapIdentityRequest,
    BootstrapLadderRequest,
    BootstrapRunRequest,
    BootstrapSaveRequest,
)
from app_server.services import (
    bootstrap_service,
    engine_hosted_save_service,
    workspace_read_client,
)


router = APIRouter()


@router.post("/bootstrap/load")
def load_bootstrap(req: BootstrapIdentityRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "bootstrap_load",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method_name": req.method_name,
        },
        local=lambda: bootstrap_service.load_bootstrap_method(
            req.project_name,
            req.reserving_class,
            req.method_name,
        ),
    )


def _run_inputs(method: Dict[str, Any]) -> Dict[str, Any]:
    # A run merges only the settings a user owns onto the stored method, so
    # the stored residuals and results the page holds never travel with the
    # request.
    return {"json_format": BST_JSON_FORMAT, **owned_projection(method)}


@router.post("/bootstrap/simulate")
def simulate_bootstrap(req: BootstrapRunRequest) -> Dict[str, Any]:
    # Runs where the DFM and the target live and writes nothing; Save
    # publishes the same run.
    method = _run_inputs(req.method)
    return workspace_read_client.run_workspace_read(
        "bootstrap_simulate",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method": method,
        },
        local=lambda: bootstrap_service.simulate_bootstrap_method(
            req.project_name,
            req.reserving_class,
            method,
        ),
    )


@router.post("/bootstrap/ladder")
def bootstrap_ladder(req: BootstrapLadderRequest) -> Dict[str, Any]:
    # Re-runs the method the page sends, which carries everything the run
    # needs, so nothing is read from the project and it runs locally.
    return bootstrap_service.percentile_ladder(req.method, req.interval)


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
    # The save runs on Arco Engine next to the data; this endpoint keeps
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
