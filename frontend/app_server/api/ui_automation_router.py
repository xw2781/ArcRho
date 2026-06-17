from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from app_server.schemas.ui_automation import (
    UiAutomationCommandRequest,
    UiAutomationCommandResult,
    UiAutomationPollRequest,
)
from app_server.services import ui_automation_service

router = APIRouter()


def _require_local_client(request: Request) -> None:
    host = (request.client.host if request.client else "") or ""
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(403, "UI automation is only available from the local machine.")


@router.post("/ui_automation/commands")
def submit_ui_automation_command(req: UiAutomationCommandRequest, request: Request) -> Dict[str, Any]:
    _require_local_client(request)
    return ui_automation_service.submit_command(req.command, req.target, req.args, req.timeout_sec)


@router.post("/ui_automation/commands/poll")
def poll_ui_automation_command(req: UiAutomationPollRequest, request: Request) -> Dict[str, Any]:
    _require_local_client(request)
    return ui_automation_service.poll_command(req.timeout_sec)


@router.post("/ui_automation/commands/{command_id}/complete")
def complete_ui_automation_command(
    command_id: str,
    req: UiAutomationCommandResult,
    request: Request,
) -> Dict[str, Any]:
    _require_local_client(request)
    return ui_automation_service.complete_command(command_id, req.ok, req.result, req.error)
