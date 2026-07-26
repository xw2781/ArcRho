"""Load the versioned shared-server contract for ResQ RC import requests."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping


CONTRACT_FILE_NAME = "resq_reserving_class_import_contract.json"


class ResQImportContractError(RuntimeError):
    """The deployed Bridge request contract is missing or malformed."""


def load_resq_reserving_class_import_contract() -> Mapping[str, Any]:
    """Read and validate the bundle-friendly ResQ reserving-class contract."""

    path = _contract_path()
    try:
        with path.open("r", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ResQImportContractError(
            f"Could not read ResQ reserving-class import contract [{path}]: {exc}"
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
        raise ResQImportContractError("ResQ reserving-class import contract must be a JSON object.")

    required_scalars = {
        "contract_version": int,
        "function": str,
        "worker_role": str,
        "worker_heartbeat_max_age_seconds": int,
    }
    for key, value_type in required_scalars.items():
        value = payload.get(key)
        if isinstance(value, bool) or not isinstance(value, value_type) or not value:
            raise ResQImportContractError(f"Contract field [{key}] is missing or invalid.")

    required_string_lists = (
        "request_relative_dir",
        "status_relative_dir",
        "worker_heartbeat_relative_dir",
        "required_request_fields",
        "forbidden_path_fields",
        "allowed_export_modes",
        "status_values",
    )
    normalized: dict[str, Any] = dict(payload)
    for key in required_string_lists:
        value = payload.get(key)
        if not isinstance(value, list) or not value or any(
            not isinstance(item, str) or not item.strip() for item in value
        ):
            raise ResQImportContractError(f"Contract field [{key}] must be a non-empty string list.")
        normalized[key] = tuple(item.strip() for item in value)

    request_dir = normalized["request_relative_dir"]
    status_dir = normalized["status_relative_dir"]
    if len(request_dir) < 3 or len(status_dir) < 3:
        raise ResQImportContractError(
            "Request and status directories must include a shared queue and leaf folder."
        )
    if request_dir[:-1] != status_dir[:-1] or request_dir[-1] == status_dir[-1]:
        raise ResQImportContractError(
            "Request and status directories must be distinct siblings in the same queue."
        )
    if "Function" not in normalized["required_request_fields"]:
        raise ResQImportContractError("The function field must be required by the request contract.")
    if "ContractVersion" not in normalized["required_request_fields"]:
        raise ResQImportContractError("ContractVersion must be required by the request contract.")
    if set(normalized["status_values"]) != {"processing", "success", "error"}:
        raise ResQImportContractError(
            "Status values must be exactly processing, success, and error."
        )
    return MappingProxyType(normalized)
