"""Load the versioned shared-server contract for the ResQ reserving-class review.

A review is read-only: it lays the persisted Arco values and the live ResQ
values of one reserving class side by side and writes an Excel workbook for a
person to read.  ResQ is reachable only from a Bridge worker, so the macro on
a Client PC publishes a request and a worker runs the review here.

The review is served from the *synchronization* queue's folders rather than
folders of its own, and this contract states them so the sharing is written
down once.  The reason is the waiting client: inside the Arco app every poll
is the hosted Bridge-liveness read, which knows the import queue and the sync
queue and nothing else.  A third folder would be invisible to it until the
app itself was rebuilt, which a macro must never require.  Nothing collides:
a status file is named by its request id, and the worker dispatches on the
request's ``Function``.

Everything about the worker -- its heartbeat folder, role, freshness window --
and the queue's status vocabulary and path-field ban belong to the import
contract, which owns them; this file restates none of it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

try:
    from src.arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )
    from src.arcrho_bridge.resq_sync_contract import (
        load_resq_reserving_class_sync_contract,
    )
except ModuleNotFoundError:  # Source-run and frozen Bridge entry points.
    from arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )
    from arcrho_bridge.resq_sync_contract import (
        load_resq_reserving_class_sync_contract,
    )


CONTRACT_FILE_NAME = "resq_reserving_class_review_contract.json"

# Facts owned by the import contract because one worker serves every queue.
_SHARED_WORKER_FIELDS = (
    "worker_role",
    "worker_heartbeat_relative_dir",
    "worker_heartbeat_max_age_seconds",
    "status_values",
    "forbidden_path_fields",
)


class ResQReviewContractError(RuntimeError):
    """The deployed Bridge review contract is missing or malformed."""


def load_resq_reserving_class_review_contract() -> Mapping[str, Any]:
    """Read and validate the bundle-friendly ResQ review contract."""

    path = _contract_path()
    try:
        with path.open("r", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ResQReviewContractError(
            f"Could not read ResQ reserving-class review contract [{path}]: {exc}"
        ) from exc
    return _validated_contract(payload)


def _contract_path() -> Path:
    source_path = Path(__file__).resolve().with_name(CONTRACT_FILE_NAME)
    if source_path.is_file():
        return source_path

    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        bundled_path = Path(bundle_root) / "arcrho_bridge" / CONTRACT_FILE_NAME
        if bundled_path.is_file():
            return bundled_path
    return source_path


def _validated_contract(payload: object) -> Mapping[str, Any]:
    if not isinstance(payload, dict):
        raise ResQReviewContractError("ResQ reserving-class review contract must be a JSON object.")

    version = payload.get("contract_version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ResQReviewContractError("Contract field [contract_version] is missing or invalid.")
    function = payload.get("function")
    if not isinstance(function, str) or not function.strip():
        raise ResQReviewContractError("Contract field [function] is missing or invalid.")

    normalized: dict[str, Any] = dict(payload)
    for key in ("request_relative_dir", "status_relative_dir", "required_request_fields"):
        value = payload.get(key)
        if not isinstance(value, list) or not value or any(
            not isinstance(item, str) or not item.strip() for item in value
        ):
            raise ResQReviewContractError(f"Contract field [{key}] must be a non-empty string list.")
        normalized[key] = tuple(item.strip() for item in value)

    for key in _SHARED_WORKER_FIELDS:
        if key in payload:
            raise ResQReviewContractError(
                f"Contract field [{key}] belongs to the ResQ import contract and must not be "
                "restated by the review contract."
            )

    sync_contract = load_resq_reserving_class_sync_contract()
    if function.strip() == sync_contract["function"]:
        raise ResQReviewContractError(
            "The review must be its own function so a worker can tell the two apart."
        )
    for key in ("request_relative_dir", "status_relative_dir"):
        if normalized[key] != tuple(sync_contract[key]):
            raise ResQReviewContractError(
                f"The review's [{key}] must be the synchronization queue's, which is the only "
                "queue besides the import that the app's hosted liveness poll can read."
            )

    for key in ("Function", "ContractVersion", "RequestId", "ProjectName", "Path", "UserName"):
        if key not in normalized["required_request_fields"]:
            raise ResQReviewContractError(f"{key} must be required by the request contract.")

    import_contract = load_resq_reserving_class_import_contract()
    for key in _SHARED_WORKER_FIELDS:
        normalized[key] = import_contract[key]
    normalized["function"] = function.strip()
    return MappingProxyType(normalized)
