"""Load the versioned shared-server contract for ResQ RC synchronization.

A reserving-class synchronization is served by the same ResQ-connected Bridge
worker as an import, from a sibling queue folder.  Everything about that worker
-- its heartbeat folder, role, freshness window -- and the queue's status
vocabulary and path-field ban are therefore not restated here: they are read
from the import contract, which owns them.  This file adds only what is
specific to synchronization: its own function, queue folders, request fields,
and the two phases a synchronization is split into.
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
except ModuleNotFoundError:  # Source-run and frozen Bridge entry points.
    from arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )


CONTRACT_FILE_NAME = "resq_reserving_class_sync_contract.json"

# Facts owned by the import contract because one worker serves both queues.
_SHARED_WORKER_FIELDS = (
    "worker_role",
    "worker_heartbeat_relative_dir",
    "worker_heartbeat_max_age_seconds",
    "status_values",
    "forbidden_path_fields",
)


class ResQSyncContractError(RuntimeError):
    """The deployed Bridge synchronization contract is missing or malformed."""


def load_resq_reserving_class_sync_contract() -> Mapping[str, Any]:
    """Read and validate the bundle-friendly ResQ synchronization contract."""

    path = _contract_path()
    try:
        with path.open("r", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ResQSyncContractError(
            f"Could not read ResQ reserving-class sync contract [{path}]: {exc}"
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
        raise ResQSyncContractError("ResQ reserving-class sync contract must be a JSON object.")

    required_scalars = {
        "contract_version": int,
        "function": str,
        "selection_field": str,
    }
    for key, value_type in required_scalars.items():
        value = payload.get(key)
        if isinstance(value, bool) or not isinstance(value, value_type) or not value:
            raise ResQSyncContractError(f"Contract field [{key}] is missing or invalid.")

    required_string_lists = (
        "request_relative_dir",
        "status_relative_dir",
        "required_request_fields",
        "allowed_phases",
        "selection_row_fields",
    )
    normalized: dict[str, Any] = dict(payload)
    for key in required_string_lists:
        value = payload.get(key)
        if not isinstance(value, list) or not value or any(
            not isinstance(item, str) or not item.strip() for item in value
        ):
            raise ResQSyncContractError(f"Contract field [{key}] must be a non-empty string list.")
        normalized[key] = tuple(item.strip() for item in value)

    for key in _SHARED_WORKER_FIELDS:
        if key in payload:
            raise ResQSyncContractError(
                f"Contract field [{key}] belongs to the ResQ import contract and must not be "
                "restated by the synchronization contract."
            )

    request_dir = normalized["request_relative_dir"]
    status_dir = normalized["status_relative_dir"]
    if len(request_dir) < 3 or len(status_dir) < 3:
        raise ResQSyncContractError(
            "Request and status directories must include a shared queue and leaf folder."
        )
    if request_dir[:-1] != status_dir[:-1] or request_dir[-1] == status_dir[-1]:
        raise ResQSyncContractError(
            "Request and status directories must be distinct siblings in the same queue."
        )

    import_contract = load_resq_reserving_class_import_contract()
    if request_dir[:2] != tuple(import_contract["request_relative_dir"])[:2]:
        raise ResQSyncContractError(
            "The synchronization queue must be a sibling of the ResQ import queue so the same "
            "Bridge worker serves both."
        )
    if request_dir[2] == tuple(import_contract["request_relative_dir"])[2]:
        raise ResQSyncContractError(
            "The synchronization queue must not share the ResQ import queue folder."
        )

    for key in ("Function", "ContractVersion", "RequestId", "Phase"):
        if key not in normalized["required_request_fields"]:
            raise ResQSyncContractError(f"{key} must be required by the request contract.")
    if set(normalized["allowed_phases"]) != {"preview", "apply"}:
        raise ResQSyncContractError("Phases must be exactly preview and apply.")
    if set(normalized["selection_row_fields"]) != {"Id", "Signature"}:
        raise ResQSyncContractError(
            "A selected review row must carry exactly its row ID and reviewed signature."
        )

    for key in _SHARED_WORKER_FIELDS:
        normalized[key] = import_contract[key]
    return MappingProxyType(normalized)
