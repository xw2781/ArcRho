"""One look at the ResQ-connected Bridge worker, taken where the workspace is local disk.

The ResQ import macros poll this while a request runs. Over the mapped drive
the heartbeat's timestamp comes from a client cache that can lag the server by
ten seconds, so the look is registered as a hosted workspace read and runs on
the Server PC through the Gateway; the rule itself lives in
``arcrho_api.bridge_liveness``.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException

from arcrho_api.bridge_liveness import QUEUE_STATUS_DIRS, observe_bridge_liveness_on_disk
from arcrho_project_duplication_contract import (
    ProjectDuplicationContractError,
    validate_request_id,
)

from app_server import config


def get_bridge_worker_liveness(queue: str = "import", request_id: str = "") -> Dict[str, Any]:
    queue_name = str(queue or "import").strip().casefold()
    if queue_name not in QUEUE_STATUS_DIRS:
        raise HTTPException(400, "Unknown ArcRho Bridge request queue.")
    identifier = str(request_id or "").strip()
    if identifier:
        try:
            identifier = validate_request_id(identifier)
        except ProjectDuplicationContractError as error:
            raise HTTPException(400, str(error)) from error
    observation = observe_bridge_liveness_on_disk(
        config.get_root_path(), queue=queue_name, request_id=identifier
    )
    return {"ok": True, **observation}
