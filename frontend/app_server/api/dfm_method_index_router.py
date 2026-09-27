from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.services import dataset_instance_index_service, workspace_read_client

router = APIRouter()


@router.get("/dfm/method-index")
def get_dfm_method_index(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "dataset_index",
        {"project_name": project_name, "reserving_class": reserving_class, "refresh": bool(refresh)},
        local=lambda: dataset_instance_index_service.get_index(
            project_name, reserving_class, refresh=refresh
        ),
    )


@router.get("/dfm/percent-developed-curve")
def get_dfm_percent_developed_curve(
    project_name: str,
    reserving_class: str,
    method_name: str,
) -> Dict[str, Any]:
    kwargs = {"project_name": project_name, "reserving_class": reserving_class, "method_name": method_name}
    return workspace_read_client.run_workspace_read(
        "dfm_percent_developed_curve",
        kwargs,
        local=lambda: dataset_instance_index_service.get_percent_developed_curve(**kwargs),
    )


@router.get("/dfm/development-pattern")
def get_dfm_development_pattern(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
) -> Dict[str, Any]:
    kwargs = {"project_name": project_name, "reserving_class": reserving_class, "dataset_name": dataset_name}
    return workspace_read_client.run_workspace_read(
        "dfm_development_pattern",
        kwargs,
        local=lambda: dataset_instance_index_service.get_development_pattern(**kwargs),
    )
