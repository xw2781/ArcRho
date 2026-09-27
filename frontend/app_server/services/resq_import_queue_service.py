"""Publish one ResQ import request where the workspace is local disk.

The Import ResQ Reserving Class macros hand their request to a ResQ-connected
Arco Bridge worker through a request file in the shared import queue. Written
from a Client PC that file crosses the share; registered as a hosted workspace
mutation it lands on the server's own disk through the Gateway.

The macro owns the request it builds (a macro must stand on its own), so this
module restates none of its fields: it checks that the request names the
project, reserving class and id the mutation was validated for, stamps the
person who asked, and writes it. The Bridge validates the rest when it claims
the request.

Idempotent by request id: an id that already has a request or a status file
is returned untouched, so a response the client never saw cannot queue a
second import.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Mapping

from fastapi import HTTPException

from arcrho_api.bridge_liveness import QUEUE_STATUS_DIRS
from arcrho_project_duplication_contract import (
    ProjectDuplicationContractError,
    validate_request_id,
)

from app_server import config
from app_server.services import user_identity_service


STATUS_RELATIVE_DIR = QUEUE_STATUS_DIRS["import"]
REQUEST_RELATIVE_DIR = STATUS_RELATIVE_DIR.with_name("requests")


def publish_resq_import_request(
    project_name: str,
    reserving_class: str,
    request_id: str,
    request: Mapping[str, Any],
) -> Dict[str, Any]:
    try:
        identifier = validate_request_id(request_id)
    except ProjectDuplicationContractError as error:
        raise HTTPException(400, str(error)) from error
    if not isinstance(request, Mapping):
        raise HTTPException(400, "The import request must be a JSON object.")
    expected = {"RequestId": identifier, "ProjectName": project_name, "Path": reserving_class}
    mismatched = [name for name, value in expected.items() if str(request.get(name) or "") != value]
    if mismatched:
        raise HTTPException(400, f"The import request does not match its {', '.join(mismatched)}.")
    # The request names the person who asked, not the Gateway's profile.
    payload = {**dict(request), "UserName": user_identity_service.get_windows_login_name()}

    root = Path(config.get_root_path())
    request_path = root / REQUEST_RELATIVE_DIR / f"{identifier}.json"
    status_path = root / STATUS_RELATIVE_DIR / f"{identifier}.json"
    if request_path.exists() or status_path.exists():
        return {"ok": True, "request_id": identifier, "resumed": True}
    temp_path = request_path.with_name(f".{identifier}.tmp")
    try:
        request_path.parent.mkdir(parents=True, exist_ok=True)
        with temp_path.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
        os.replace(temp_path, request_path)
    except OSError as error:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise HTTPException(500, f"Could not publish Arco Bridge request [{identifier}]: {error}") from error
    return {"ok": True, "request_id": identifier, "resumed": False}
