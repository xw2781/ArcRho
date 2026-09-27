from __future__ import annotations

from typing import Dict

from fastapi import APIRouter

from app_server.services import user_identity_service, workspace_read_client

router = APIRouter()


@router.get("/app/user-identity")
def get_user_identity() -> Dict[str, str]:
    # The display name lives in the server's username index; the server
    # answers for the login the request is signed with.
    return workspace_read_client.run_workspace_read(
        "user_identity",
        {},
        local=user_identity_service.get_current_identity,
    )
