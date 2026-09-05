"""Canonical request and status contract for ArcRho data-processing-rules save jobs.

Saving a project's data-processing rules writes one small JSON file, but the
save also has to say what the change did to the project: it clears the
temporary-view caches and opens every engine-generated dataset sidecar in the
project to count the ones the new rules make stale. From a Client PC that count
is one SMB round trip per sidecar inside the save request -- on a project with
two thousand sidecars the request answered minutes later with nothing on
screen in the meantime.

This contract moves the whole save to ArcRho Engine on the machine hosting the
workspace, as a durable job: the client validates the rules, submits the
request, and polls the status while the Engine runs the canonical save on local
disk and reports its progress. The terminal status embeds the save route's
full response, so the client needs no second read to show the saved document.

The job runs under the *project-scope* lease owned by
``arcrho_dependent_propagation_contract`` for the same reason a dataset-type
change does: the rules belong to no single reserving class, and the lease is
what lets several Engine instances claim one request exactly once.

Callers identify the work by logical project name only; the Engine derives
every absolute filesystem path from its own configured server root.

This module intentionally uses only the Python standard library so the frontend
app server, the Gateway and the frozen data engine can load the same source
file. It owns the request shape, the status shape and the protocol path layout.
It deliberately does *not* own what a rule means:
``app_server.services.data_processing_rules_service`` remains the single source
for rule normalization, validation and the persisted file text, and this module
validates only the transport shape a rule must have to survive the trip.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from arcrho_project_duplication_contract import (
    validate_project_name as _canonical_validate_project_name,
    validate_request_id as _canonical_validate_request_id,
    write_json_atomic,
)


DATA_PROCESSING_RULES_JOB_FUNCTION = "ArcRhoSaveDataProcessingRules"
DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION = 1
DATA_PROCESSING_RULES_JOB_REQUIRED_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "ExpectedRevision",
    "Rules",
    "UserName",
)
DATA_PROCESSING_RULES_JOB_STATUS_VALUES = ("queued", "processing", "success", "error")

# The canonical ``app_server.services`` modules the job runs, named here for the
# same reason the dataset-type change contract names its own: the frozen
# Engine's build probe imports this list, so a service the save gained stops
# the build instead of failing the first save on the server.
DATA_PROCESSING_RULES_JOB_SERVICE_MODULES: tuple[str, ...] = (
    "audit_service",
    "data_processing_rules_service",
    "data_processing_values_service",
    "source_table_service",
    "user_identity_service",
)

# The job republishes its "processing" status on this cadence even while one
# stage is still running, so a poller can tell a live slow job from a dead
# worker. A queued job has no heartbeat owner -- it is waiting for an Engine
# slot -- so it gets a separate, longer allowance.
DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS = 5.0
DATA_PROCESSING_RULES_JOB_STATUS_STALE_SECONDS = 45.0
DATA_PROCESSING_RULES_JOB_QUEUED_STALE_SECONDS = 180.0

_MAX_RULES = 5000
_PROGRESS_FIELDS = frozenset({"stage", "completed", "total", "label"})


class DataProcessingRulesJobContractError(ValueError):
    """Raised when a rules-save job payload violates this contract."""


def _required_text(value: Any, field_name: str) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        raise DataProcessingRulesJobContractError(f"{field_name} is required.")
    return text


def validate_request_id(value: Any) -> str:
    try:
        return _canonical_validate_request_id(value)
    except ValueError as exc:
        raise DataProcessingRulesJobContractError(str(exc)) from exc


def validate_project_name(value: Any, field_name: str = "ProjectName") -> str:
    try:
        return _canonical_validate_project_name(value, field_name)
    except ValueError as exc:
        raise DataProcessingRulesJobContractError(str(exc)) from exc


def normalize_expected_revision(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DataProcessingRulesJobContractError(
            "ExpectedRevision must be a non-negative integer."
        )
    return value


def normalize_rules(value: Any) -> list[dict[str, Any]]:
    """Return the rules as a list of JSON objects, rejecting any other shape.

    Only the transport shape is checked here; every field inside a rule is
    the rules service's business, and it validates them when the Engine runs
    the save exactly as it would have on the client.
    """

    if not isinstance(value, list):
        raise DataProcessingRulesJobContractError("Rules must be a list.")
    if len(value) > _MAX_RULES:
        raise DataProcessingRulesJobContractError(
            f"Rules may hold at most {_MAX_RULES} entries."
        )
    rules: list[dict[str, Any]] = []
    for index, rule in enumerate(value):
        if not isinstance(rule, Mapping):
            raise DataProcessingRulesJobContractError(
                f"Rules[{index}] must be a JSON object."
            )
        rules.append(dict(rule))
    return rules


def build_data_processing_rules_job_request(
    *,
    request_id: Any,
    project_name: Any,
    expected_revision: Any,
    rules: Any,
    user_name: Any,
) -> dict[str, Any]:
    """Build the complete canonical request payload."""

    return validate_data_processing_rules_job_request(
        {
            "Function": DATA_PROCESSING_RULES_JOB_FUNCTION,
            "ContractVersion": DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION,
            "RequestId": request_id,
            "ProjectName": project_name,
            "ExpectedRevision": expected_revision,
            "Rules": rules,
            "UserName": user_name,
        }
    )


def validate_data_processing_rules_job_request(payload: Any) -> dict[str, Any]:
    """Return the normalized exact request, rejecting paths and extensions.

    The required fields are also the complete allow-list, so a machine-local
    filesystem path is impossible by construction: the Engine derives every
    absolute path from its own configured ArcRho Server root.
    """

    if not isinstance(payload, Mapping):
        raise DataProcessingRulesJobContractError(
            "Data processing rules job request must be a JSON object."
        )

    supplied = set(payload)
    allowed = set(DATA_PROCESSING_RULES_JOB_REQUIRED_FIELDS)
    missing = [
        field
        for field in DATA_PROCESSING_RULES_JOB_REQUIRED_FIELDS
        if field not in supplied
    ]
    if missing:
        raise DataProcessingRulesJobContractError(
            "Missing request field(s): " + ", ".join(missing) + "."
        )
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if extra:
        raise DataProcessingRulesJobContractError(
            "Unexpected request field(s): " + ", ".join(extra) + "."
        )

    function_name = _required_text(payload.get("Function"), "Function")
    if function_name != DATA_PROCESSING_RULES_JOB_FUNCTION:
        raise DataProcessingRulesJobContractError(
            f"Function must be {DATA_PROCESSING_RULES_JOB_FUNCTION!r}."
        )
    version = payload.get("ContractVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DataProcessingRulesJobContractError(
            "ContractVersion must be the integer "
            f"{DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION}."
        )
    if version != DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION:
        raise DataProcessingRulesJobContractError(
            f"Unsupported ContractVersion {version!r}; expected "
            f"{DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION}."
        )

    return {
        "Function": DATA_PROCESSING_RULES_JOB_FUNCTION,
        "ContractVersion": DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION,
        "RequestId": validate_request_id(payload.get("RequestId")),
        "ProjectName": validate_project_name(payload.get("ProjectName")),
        "ExpectedRevision": normalize_expected_revision(payload.get("ExpectedRevision")),
        "Rules": normalize_rules(payload.get("Rules")),
        "UserName": _required_text(payload.get("UserName"), "UserName"),
    }


# ---------------------------------------------------------------------------
# Protocol paths
# ---------------------------------------------------------------------------


def _root_path(server_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(server_root)
    if not str(raw).strip():
        raise DataProcessingRulesJobContractError("ArcRho Server root is required.")
    return Path(raw).expanduser()


def data_processing_rules_job_protocol_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    """Return the protocol root; a subfolder of ``requests`` so the
    orchestrator's loose-file garbage collection never touches queued jobs."""

    return _root_path(server_root) / "requests" / "data_processing_rules"


def data_processing_rules_job_requests_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return data_processing_rules_job_protocol_directory(server_root) / "requests"


def data_processing_rules_job_statuses_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return data_processing_rules_job_protocol_directory(server_root) / "statuses"


def data_processing_rules_job_request_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        data_processing_rules_job_requests_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def data_processing_rules_job_status_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        data_processing_rules_job_statuses_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def project_identity(project_name: Any) -> str:
    return validate_project_name(project_name).casefold()


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def _normalize_progress(progress: Any) -> dict[str, Any]:
    if not isinstance(progress, Mapping):
        raise DataProcessingRulesJobContractError("progress must be a JSON object.")
    supplied = set(progress)
    missing = sorted(_PROGRESS_FIELDS - supplied)
    extra = sorted(
        (str(field) for field in supplied - _PROGRESS_FIELDS), key=str.casefold
    )
    if missing:
        raise DataProcessingRulesJobContractError(
            "Missing progress field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DataProcessingRulesJobContractError(
            "Unexpected progress field(s): " + ", ".join(extra) + "."
        )

    completed = progress.get("completed")
    total = progress.get("total")
    for field_name, value in (("completed", completed), ("total", total)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise DataProcessingRulesJobContractError(
                f"progress.{field_name} must be a non-negative integer."
            )
    if completed > total:
        raise DataProcessingRulesJobContractError(
            "progress.completed must not be greater than progress.total."
        )

    return {
        "stage": _required_text(progress.get("stage"), "progress.stage"),
        "completed": completed,
        "total": total,
        "label": _required_text(progress.get("label"), "progress.label"),
    }


def _normalize_result(result: Any) -> dict[str, Any]:
    """The terminal result is the save route's own response, carried whole.

    Its shape belongs to the rules service; the transport only insists that
    it is a JSON object, so the client can hand it to the same code that
    consumes a direct save.
    """

    if not isinstance(result, Mapping):
        raise DataProcessingRulesJobContractError("result must be a JSON object.")
    return dict(result)


def _normalize_status_code(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 100 <= value <= 599:
        raise DataProcessingRulesJobContractError(
            "status_code must be an HTTP status code."
        )
    return value


def build_data_processing_rules_job_status(
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    status_code: int | None = None,
    result: Mapping[str, Any] | None = None,
    updated_at: Any = None,
) -> dict[str, Any]:
    """Build one complete location-independent job status payload.

    ``status_code`` carries the HTTP status the direct save route would have
    answered with, so a client can tell a stale-revision refusal (409) from a
    validation refusal (400) and react the way it always has.
    """

    normalized_request_id = validate_request_id(request_id)
    normalized_status = str(status if status is not None else "").strip()
    if normalized_status not in DATA_PROCESSING_RULES_JOB_STATUS_VALUES:
        raise DataProcessingRulesJobContractError(
            f"Invalid data processing rules job status: {status!r}."
        )
    if updated_at is None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        timestamp = _required_text(updated_at, "updated_at")

    payload: dict[str, Any] = {
        "contract_version": DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION,
        "status": normalized_status,
        "updated_at": timestamp,
        "request_id": normalized_request_id,
        "progress": _normalize_progress(progress),
    }
    normalized_message = str(message if message is not None else "").strip()
    if normalized_message:
        payload["message"] = normalized_message
    if status_code is not None:
        payload["status_code"] = _normalize_status_code(status_code)
    if result is not None:
        payload["result"] = _normalize_result(result)
    return payload


def validate_data_processing_rules_job_status(
    payload: Any,
    *,
    expected_request_id: Any = None,
) -> dict[str, Any]:
    """Validate a persisted status and return only its canonical fields."""

    if not isinstance(payload, Mapping):
        raise DataProcessingRulesJobContractError(
            "Data processing rules job status must be a JSON object."
        )
    required = {"contract_version", "status", "updated_at", "request_id", "progress"}
    allowed = required | {"message", "status_code", "result"}
    supplied = set(payload)
    missing = sorted(required - supplied)
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if missing:
        raise DataProcessingRulesJobContractError(
            "Missing status field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DataProcessingRulesJobContractError(
            "Unexpected status field(s): " + ", ".join(extra) + "."
        )

    version = payload.get("contract_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DataProcessingRulesJobContractError(
            "contract_version must be the integer "
            f"{DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION}."
        )
    if version != DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION:
        raise DataProcessingRulesJobContractError(
            f"Unsupported contract_version {version!r}; expected "
            f"{DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION}."
        )

    status = _required_text(payload.get("status"), "status")
    if status not in DATA_PROCESSING_RULES_JOB_STATUS_VALUES:
        raise DataProcessingRulesJobContractError(
            f"Invalid data processing rules job status: {payload.get('status')!r}."
        )
    request_id = validate_request_id(payload.get("request_id"))
    if expected_request_id is not None:
        expected = validate_request_id(expected_request_id)
        if request_id != expected:
            raise DataProcessingRulesJobContractError(
                "Data processing rules job status RequestId does not match the "
                "requested job."
            )

    normalized: dict[str, Any] = {
        "contract_version": DATA_PROCESSING_RULES_JOB_CONTRACT_VERSION,
        "status": status,
        "updated_at": _required_text(payload.get("updated_at"), "updated_at"),
        "request_id": request_id,
        "progress": _normalize_progress(payload.get("progress")),
    }
    if "message" in payload:
        normalized["message"] = _required_text(payload.get("message"), "message")
    if "status_code" in payload:
        normalized["status_code"] = _normalize_status_code(payload.get("status_code"))
    if "result" in payload:
        normalized["result"] = _normalize_result(payload.get("result"))
    return normalized


def write_data_processing_rules_job_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    status_code: int | None = None,
    result: Mapping[str, Any] | None = None,
    updated_at: Any = None,
) -> Path:
    """Build and atomically publish one rules-save job status."""

    normalized_request_id = validate_request_id(request_id)
    payload = build_data_processing_rules_job_status(
        normalized_request_id,
        status,
        progress=progress,
        message=message,
        status_code=status_code,
        result=result,
        updated_at=updated_at,
    )
    path = data_processing_rules_job_status_path(server_root, normalized_request_id)
    return write_json_atomic(path, payload)


def read_data_processing_rules_job_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
) -> dict[str, Any] | None:
    """Read and validate one published status, or ``None`` when absent."""

    normalized_request_id = validate_request_id(request_id)
    path = data_processing_rules_job_status_path(server_root, normalized_request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    return validate_data_processing_rules_job_status(
        payload, expected_request_id=normalized_request_id
    )


# ---------------------------------------------------------------------------
# Queued-job probe
# ---------------------------------------------------------------------------


def find_queued_data_processing_rules_job(
    server_root: str | os.PathLike[str],
    project_name: Any,
    *,
    now: float | None = None,
    queued_fresh_seconds: float = DATA_PROCESSING_RULES_JOB_QUEUED_STALE_SECONDS,
) -> dict[str, str] | None:
    """Return a submitted-but-unclaimed rules save for one project, or ``None``.

    A running job is already reported by the project-scope propagation hold in
    ``arcrho_dependent_propagation_contract``, which every writer preflights.
    This probe covers only the window between publishing the request and the
    Engine claiming its lease, so two saves cannot be queued for one project.
    """

    identity = project_identity(project_name)
    observed_at = time.time() if now is None else float(now)

    requests_dir = data_processing_rules_job_requests_directory(server_root)
    try:
        candidates = tuple(requests_dir.glob("*.json"))
    except OSError:
        return None
    for candidate in candidates:
        try:
            request_age = observed_at - candidate.stat().st_mtime
        except OSError:
            continue
        if request_age > queued_fresh_seconds:
            continue
        try:
            request = validate_data_processing_rules_job_request(
                json.loads(candidate.read_text(encoding="utf-8-sig"))
            )
        except (OSError, ValueError, TypeError, DataProcessingRulesJobContractError):
            continue
        if project_identity(request["ProjectName"]) != identity:
            continue
        try:
            status = read_data_processing_rules_job_status(
                server_root, request["RequestId"]
            )
        except (OSError, ValueError, TypeError, DataProcessingRulesJobContractError):
            status = None
        if status is not None and status["status"] in {"success", "error"}:
            continue
        return {"reason": "queued", "job_id": request["RequestId"]}
    return None
