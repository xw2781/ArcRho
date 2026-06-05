from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.dfm_method_index import DfmMethodIndexRefreshRequest
from app_server.services import dataset_instance_index_service

router = APIRouter()


@router.get("/dfm/method-index")
def get_dfm_method_index(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    return dataset_instance_index_service.get_index(project_name, reserving_class, refresh=refresh)


@router.get("/dfm/percent-developed-curve")
def get_dfm_percent_developed_curve(
    project_name: str,
    reserving_class: str,
    method_name: str,
) -> Dict[str, Any]:
    return dataset_instance_index_service.get_percent_developed_curve(
        project_name,
        reserving_class,
        method_name,
    )


@router.post("/dfm/method-index/refresh")
def refresh_dfm_method_index(req: DfmMethodIndexRefreshRequest) -> Dict[str, Any]:
    return dataset_instance_index_service.rebuild_index(req.project_name, req.reserving_class)
