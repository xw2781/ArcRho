"""Client half of Engine-hosted saves.

The save endpoints keep their exact HTTP shapes, but the file work runs on
ArcRho Engine where ``E:\\ArcRho Server`` is local disk: this module
publishes a ``queued`` status, drops the request file in the requests root
(instant watchdog pickup), polls the status until terminal, and returns the
Engine-written result payload as if the save had run in-process. Service
``HTTPException`` outcomes (409 conflicts, 400 validation, 423 holds) come
back with their original status codes and details.
"""

from __future__ import annotations

import getpass
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from arcrho_engine_save_contract import (
    SAVE_JOB_PROCESSING_TIMEOUT_SECONDS,
    SAVE_JOB_QUEUED_TIMEOUT_SECONDS,
    build_save_job_request,
    discard_save_job_artifacts,
    read_save_job_result,
    read_save_job_status,
    save_job_request_path,
    save_job_status_is_terminal,
    write_save_job_status,
)

from app_server.services import dependent_propagation_service

# SMB status reads take ~0.4 s and hold the file open without
# FILE_SHARE_DELETE, blocking the Engine's atomic status replace for their
# duration; the sleep keeps real gaps between reads for the Engine's
# replace retries to land in.
_POLL_SLEEP_SECONDS = 0.35

HOSTED_SAVE_UNAVAILABLE_MESSAGE = (
    "ArcRho Engine did not pick up the save. Please try again; if this "
    "persists, ask an administrator to check the Engine service."
)
HOSTED_SAVE_TIMEOUT_MESSAGE = (
    "The save is taking longer than expected on ArcRho Engine. It may still "
    "complete; reload the object before retrying."
)


def _server_root() -> Path:
    return dependent_propagation_service._workspace_server_root()


def _publish_request(server_root: Path, request: Mapping[str, Any]) -> Path:
    path = save_job_request_path(server_root, request["RequestId"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temp_path.write_text(
            json.dumps(request, ensure_ascii=False), encoding="utf-8"
        )
        # The atomic move fires the Engine watchdog's on_moved with a
        # complete file; a direct write could be observed half-written.
        os.replace(temp_path, path)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return path


def run_hosted_save(
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Execute one allowlisted service save on ArcRho Engine and return its response."""

    # Fast local fail with today's exact UX: 503 without a live Engine, 423
    # while a walk still holds this reserving class.
    dependent_propagation_service.require_reserving_class_writable(
        project_name, reserving_class
    )

    server_root = _server_root()
    request_id = uuid.uuid4().hex
    request = build_save_job_request(
        request_id=request_id,
        save_kind=save_kind,
        project_name=project_name,
        path=reserving_class,
        # Router payloads can carry pydantic models; the request file is
        # plain JSON, so encode exactly the way FastAPI would respond.
        args=jsonable_encoder(list(args)),
        kwargs=jsonable_encoder(dict(kwargs or {})),
        user_name=getpass.getuser(),
    )

    write_save_job_status(server_root, request_id, "queued")
    _publish_request(server_root, request)

    started = time.monotonic()
    claim_deadline = started + SAVE_JOB_QUEUED_TIMEOUT_SECONDS
    total_deadline = started + SAVE_JOB_PROCESSING_TIMEOUT_SECONDS
    while True:
        status = read_save_job_status(server_root, request_id)
        if save_job_status_is_terminal(status):
            if str(status.get("status")) == "success":
                result = read_save_job_result(server_root, request_id)
                discard_save_job_artifacts(server_root, request_id)
                if result is None:
                    raise HTTPException(
                        500,
                        "ArcRho Engine reported a successful save but its "
                        "result payload could not be read.",
                    )
                return result
            code = int(status.get("status_code") or 500)
            message = str(status.get("message") or "The hosted save failed.")
            discard_save_job_artifacts(server_root, request_id)
            raise HTTPException(code, message)

        now = time.monotonic()
        current = str((status or {}).get("status") or "queued")
        if current == "queued" and now >= claim_deadline:
            # Nobody claimed it: the request file is still ours to retract,
            # so the save definitively did not run.
            discard_save_job_artifacts(server_root, request_id)
            raise HTTPException(503, HOSTED_SAVE_UNAVAILABLE_MESSAGE)
        if now >= total_deadline:
            # Claimed but never finished: leave the artifacts for the Engine
            # pruner — the save may still land after this response.
            raise HTTPException(504, HOSTED_SAVE_TIMEOUT_MESSAGE)
        time.sleep(_POLL_SLEEP_SECONDS)
