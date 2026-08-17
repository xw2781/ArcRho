from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.berquist_sherman import BerquistShermanLoadRequest
from app_server.services import berquist_sherman_service, workspace_read_client


router = APIRouter()


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
