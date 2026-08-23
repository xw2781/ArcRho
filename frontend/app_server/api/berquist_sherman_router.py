from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.berquist_sherman import (
    BerquistShermanLoadRequest,
    BerquistShermanSaveRequest,
)
from app_server.services import (
    berquist_sherman_service,
    engine_hosted_save_service,
    workspace_read_client,
)


router = APIRouter()


def _berquist_sherman_save_call(req: BerquistShermanSaveRequest) -> Dict[str, Any]:
    """The one argument projection the hosted save runs against.

    B&S has no two-step save, so nothing here reviews a dependent-update plan
    first; the registered ``save_propagation_roots`` still reads the same
    projection, which is why the roots and the save cannot drift apart.
    """

    sidecar = None
    if req.sidecar is not None:
        # One request, one identity: a sidecar body naming a different project
        # or reserving class than the save would write outside the class the
        # Engine leased for it.
        if (
            req.sidecar.project_name.strip() != req.project_name.strip()
            or req.sidecar.reserving_class.strip() != req.reserving_class.strip()
        ):
            raise HTTPException(
                400,
                "The B&S output sidecar must name the project and reserving class being saved.",
            )
        sidecar = req.sidecar.model_dump()
    return {
        "args": [req.project_name, req.reserving_class, req.method],
        "kwargs": {
            "method_type": req.method_type,
            "method_name": req.method_name,
            "csv_file": req.csv_file,
            "output_csv": req.output_csv,
            "sidecar": sidecar,
        },
    }


@router.post("/berquist-sherman/save")
def save_berquist_sherman(req: BerquistShermanSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data, and writes the method
    # JSON, the output CSV, and the output sidecar in that one visit.
    return engine_hosted_save_service.run_hosted_save(
        "berquist_sherman_method",
        req.project_name,
        req.reserving_class,
        **_berquist_sherman_save_call(req),
    )


@router.post("/berquist-sherman/load")
def load_berquist_sherman(req: BerquistShermanLoadRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "berquist_sherman_load",
        {
            "project_name": req.project_name,
            "reserving_class": req.reserving_class,
            "method_type": req.method_type,
            "method_name": req.method_name,
        },
        local=lambda: berquist_sherman_service.load_berquist_sherman_method(
            req.project_name,
            req.reserving_class,
            req.method_type,
            req.method_name,
        ),
    )
