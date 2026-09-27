from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.object_change_watch import (
    ObjectChangeAttributionResponse,
    ObjectChangeFingerprintRequest,
    ObjectChangeFingerprintResponse,
)
from app_server.services import object_change_watch_service, workspace_read_client

router = APIRouter()


def _identity(req: ObjectChangeFingerprintRequest) -> Dict[str, Any]:
    return {
        "project_name": req.project_name,
        "reserving_class": req.reserving_class,
        "kind": req.kind,
        "name": req.name,
        "method_type": req.method_type,
        "output_dataset": req.output_dataset,
    }


# Both reads run where the files are local disk: a stat over the mapped drive
# can report metadata from before a server write, which raised the alert for
# the user's own save. When the server cannot be asked, the answer is
# "unknown" and the window simply asks again on its next poll.
@router.post(
    "/object_change/fingerprint",
    response_model=ObjectChangeFingerprintResponse,
)
def get_object_change_fingerprint(
    req: ObjectChangeFingerprintRequest,
) -> ObjectChangeFingerprintResponse:
    kwargs = _identity(req)
    return workspace_read_client.run_polled_workspace_read(
        "object_change_fingerprint",
        kwargs,
        local=lambda: object_change_watch_service.object_change_fingerprint(**kwargs),
        unknown={"ok": True, "files": [], "token": ""},
    )


@router.post(
    "/object_change/attribution",
    response_model=ObjectChangeAttributionResponse,
)
def get_object_change_attribution(
    req: ObjectChangeFingerprintRequest,
) -> ObjectChangeAttributionResponse:
    kwargs = _identity(req)
    return workspace_read_client.run_polled_workspace_read(
        "object_change_attribution",
        kwargs,
        local=lambda: object_change_watch_service.object_change_attribution(**kwargs),
        unknown={
            "ok": True,
            "attribution": {"user": "", "action": "", "at": "", "automatic": False, "subject": req.kind},
        },
    )
