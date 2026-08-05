from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Request

from app_server.api.local_client import require_local_client
from app_server.schemas.ui_automation import (
    UiAutomationCommandRequest,
    UiAutomationCommandResult,
    UiAutomationPollRequest,
)
from app_server.services import ui_automation_service

router = APIRouter()


@router.post("/ui_automation/commands")
def submit_ui_automation_command(req: UiAutomationCommandRequest, request: Request) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.submit_command(req.command, req.target, req.args, req.timeout_sec)


@router.post("/ui_automation/commands/poll")
def poll_ui_automation_command(req: UiAutomationPollRequest, request: Request) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.poll_command(req.timeout_sec)


@router.post("/ui_automation/commands/{command_id}/complete")
def complete_ui_automation_command(
    command_id: str,
    req: UiAutomationCommandResult,
    request: Request,
) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.complete_command(command_id, req.ok, req.result, req.error)


@router.post("/ui_automation/commands/{command_id}/cancel")
def cancel_ui_automation_command(command_id: str, request: Request) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.cancel_command(command_id)


@router.post("/ui_automation/commands/drain")
def drain_ui_automation_commands(request: Request) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.drain_pending()


@router.get("/ui_automation/queue")
def get_ui_automation_queue(request: Request) -> Dict[str, Any]:
    require_local_client(request, "UI automation")
    return ui_automation_service.queue_status()
