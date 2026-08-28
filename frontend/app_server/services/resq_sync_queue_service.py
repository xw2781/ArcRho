"""Publish one ResQ sync-queue request where the workspace is local disk.

The Sync and Export Reserving Class with ResQ macros hand their request to a
ResQ-connected ArcRho Bridge worker through a request file in the shared
queue. Written from a Client PC that file crosses the share; registered as a
hosted workspace mutation it lands on the server's own disk through the
Gateway. The payload, the queue folders, and the on-disk write are all
``arcrho_api.resq_sync_queue``'s, so this module adds no second definition of
the request -- only the place it is written from.

Idempotent by request id: an id that already has a request or a status file
is returned untouched, so a response the client never saw cannot queue a
second run.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping

from fastapi import HTTPException

from arcrho_api.resq_sync_queue import (
    BridgeRequestError,
    create_sync_request,
    publish_sync_request,
    request_paths,
)
from arcrho_project_duplication_contract import (
    ProjectDuplicationContractError,
    validate_request_id,
)

from app_server import config
from app_server.services import user_identity_service


def publish_resq_sync_request(
    project_name: str,
    reserving_class: str,
    request_id: str,
    phase: str,
    selected_rows: List[Mapping[str, Any]] | None = None,
) -> Dict[str, Any]:
    try:
        identifier = validate_request_id(request_id)
    except ProjectDuplicationContractError as error:
        raise HTTPException(400, str(error)) from error
    try:
        # The request names the person who asked, not the Gateway's profile.
        identifier, payload = create_sync_request(
            project_name=project_name,
            rc_path=reserving_class,
            phase=phase,
            selected_rows=selected_rows,
            request_id=identifier,
            user_name=user_identity_service.get_windows_login_name(),
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    server_root = config.get_root_path()
    request_path, status_path = request_paths(server_root, identifier)
    if request_path.exists() or status_path.exists():
        return {"ok": True, "request_id": identifier, "phase": payload["Phase"], "resumed": True}
    try:
        publish_sync_request(server_root=server_root, request_id=identifier, payload=payload)
    except BridgeRequestError as error:
        raise HTTPException(500, str(error)) from error
    return {"ok": True, "request_id": identifier, "phase": payload["Phase"], "resumed": False}
