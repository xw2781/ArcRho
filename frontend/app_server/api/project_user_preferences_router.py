"""Project user preference routes.

Both run on the server host through the Gateway for the login the request is
signed with; a Client PC answers 503 rather than touching the file over the
share.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.project_user_preferences import ProjectUserPreferencesUpdateRequest
from app_server.services import project_user_preferences_service, workspace_mutation_client, workspace_read_client

router = APIRouter()


@router.get("/project-user-preferences")
def get_project_user_preferences(project_name: str) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "project_user_preferences",
        {"project_name": project_name},
        local=lambda: project_user_preferences_service.get_preferences(project_name),
        gateway_required=True,
    )


@router.post("/project-user-preferences")
def update_project_user_preferences(req: ProjectUserPreferencesUpdateRequest) -> Dict[str, Any]:
    kwargs = {"project_name": req.project_name, "patch": dict(req.data)}
    return workspace_mutation_client.run_workspace_mutation(
        "project_user_preferences_update",
        kwargs,
        local=lambda: project_user_preferences_service.update_preferences(**kwargs),
        gateway_required=True,
    )
