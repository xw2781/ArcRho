"""Canonical request and status contract for ArcRho dataset-type change jobs.

A project's dataset-type table is the definition every dataset instance, every
formula and every dependency edge in that project is derived from. Changing it
is therefore not a settings edit that happens to touch one file: adding,
removing, renaming or re-formulating a type re-derives the ``Precedents`` and
``Dependents`` of every sidecar in the project and can invalidate calculated
datasets in any reserving class.

Doing that from a Client PC meant walking every reserving class's sidecars over
the mapped drive inside the save request, so the request answered minutes later
or not at all. This contract moves the whole change to ArcRho Engine on the
machine hosting the workspace, as a durable job: the client validates the rows,
submits the request, and polls the status while the Engine writes the table and
rebuilds everything derived from it on local disk.

The job runs under the *project-scope* lease owned by
``arcrho_dependent_propagation_contract``, not a per-class one, because the
table it rewrites belongs to no single reserving class. While that lease is
held every class of the project reports the propagation hold clients already
understand, so no save and no other long job can interleave with the change.

Callers identify the work by logical project name only; the Engine derives
every absolute filesystem path from its own configured server root, exactly as
``arcrho_source_refresh_contract`` does for a source-table refresh.

This module intentionally uses only the Python standard library so the frontend
app server, the Gateway and the frozen data engine can load the same source
file. It owns the request shape, the status shape (including the result
summary) and the protocol path layout. It deliberately does *not* own what a
dataset-type row means: ``app_server.services.dataset_types_service`` remains
the single source for the column set, normalization, validation and the
persisted file text, and this module validates only the transport shape a row
must have to survive the trip.
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


DATASET_TYPES_CHANGE_FUNCTION = "ArcRhoApplyDatasetTypes"
DATASET_TYPES_CHANGE_CONTRACT_VERSION = 1
DATASET_TYPES_CHANGE_REQUIRED_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Rows",
    "ChangedTypes",
    "UserName",
)
DATASET_TYPES_CHANGE_STATUS_VALUES = ("queued", "processing", "success", "error")

# The canonical ``app_server.services`` modules the job runs, named here for the
# same reason the source-refresh contract names its own: the frozen Engine's
# build probe imports this list, so a service the job gained stops the build
# instead of failing the first change on the server.
DATASET_TYPES_CHANGE_SERVICE_MODULES: tuple[str, ...] = (
    "audit_service",
    "calculated_dataset_service",
    "dataset_instance_index_service",
    "dataset_types_service",
    "user_identity_service",
)

# The job publishes its "processing" status on this cadence even while a single
# stage is still running, so a poller and the project-scope hold can both tell
# a live slow job from a dead worker. A queued job has no heartbeat owner -- it
# is waiting for an Engine slot -- so it gets a separate, longer allowance.
DATASET_TYPES_CHANGE_STATUS_HEARTBEAT_SECONDS = 5.0
DATASET_TYPES_CHANGE_STATUS_STALE_SECONDS = 45.0
DATASET_TYPES_CHANGE_QUEUED_STALE_SECONDS = 180.0

# One row is [Name, Data Format, Category, Calculated, Formula]. The column
# meaning belongs to dataset_types_service; only the arity and the scalar kinds
# are transport concerns, because a row that arrived as a nested object or a
# number would corrupt the table the Engine writes.
DATASET_TYPES_CHANGE_ROW_LENGTH = 5
_ROW_FLAG_INDEX = 3
_MAX_ROWS = 5000
_MAX_CHANGED_TYPES = 5000

_PROGRESS_FIELDS = frozenset({"stage", "completed", "total", "label"})
_RESULT_COUNT_FIELDS = (
    "rows_written",
    "types_changed",
    "datasets_total",
    "datasets_updated",
    "classes_total",
    "classes_walked",
    "datasets_recalculated",
)
_RESULT_FIELDS = frozenset(_RESULT_COUNT_FIELDS + ("failures",))
_MAX_RESULT_FAILURES = 25


class DatasetTypesChangeContractError(ValueError):
    """Raised when a dataset-type change payload violates this contract."""


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DatasetTypesChangeContractError(f"{field_name} is required.")
    return value.strip()


def validate_request_id(value: Any) -> str:
    try:
        return _canonical_validate_request_id(value)
    except ValueError as exc:
        raise DatasetTypesChangeContractError(str(exc)) from exc


def validate_project_name(value: Any, field_name: str = "ProjectName") -> str:
    try:
        return _canonical_validate_project_name(value, field_name)
    except ValueError as exc:
        raise DatasetTypesChangeContractError(str(exc)) from exc


def normalize_rows(value: Any) -> list[list[Any]]:
    """Validate the transport shape of the submitted dataset-type table.

    Every row must be exactly ``DATASET_TYPES_CHANGE_ROW_LENGTH`` cells: four
    strings around one boolean ``Calculated`` flag. What those cells mean, how
    they are trimmed, which of them may be blank and what the persisted file
    looks like all stay with ``dataset_types_service``.
    """

    if not isinstance(value, (list, tuple)):
        raise DatasetTypesChangeContractError("Rows must be a list of row lists.")
    if len(value) > _MAX_ROWS:
        raise DatasetTypesChangeContractError(
            f"Rows must contain at most {_MAX_ROWS} rows."
        )
    normalized: list[list[Any]] = []
    for index, row in enumerate(value):
        if not isinstance(row, (list, tuple)):
            raise DatasetTypesChangeContractError(
                f"Rows[{index}] must be a list of {DATASET_TYPES_CHANGE_ROW_LENGTH} cells."
            )
        if len(row) != DATASET_TYPES_CHANGE_ROW_LENGTH:
            raise DatasetTypesChangeContractError(
                f"Rows[{index}] must have exactly "
                f"{DATASET_TYPES_CHANGE_ROW_LENGTH} cells."
            )
        cells: list[Any] = []
        for position, cell in enumerate(row):
            if position == _ROW_FLAG_INDEX:
                if not isinstance(cell, bool):
                    raise DatasetTypesChangeContractError(
                        f"Rows[{index}][{position}] must be true or false."
                    )
                cells.append(cell)
                continue
            if cell is None:
                cells.append("")
                continue
            if not isinstance(cell, str):
                raise DatasetTypesChangeContractError(
                    f"Rows[{index}][{position}] must be a string."
                )
            cells.append(cell)
        normalized.append(cells)
    return normalized


def normalize_changed_types(value: Any) -> list[str]:
    """Validate the ordered, de-duplicated list of changed dataset-type names.

    These are the roots the job recalculates from. The list may be empty: a
    change that only adds or removes a plain type still re-derives every
    sidecar's dependency graph, but seeds no recalculation.
    """

    if not isinstance(value, (list, tuple)):
        raise DatasetTypesChangeContractError(
            "ChangedTypes must be a list of dataset type names."
        )
    if len(value) > _MAX_CHANGED_TYPES:
        raise DatasetTypesChangeContractError(
            f"ChangedTypes must contain at most {_MAX_CHANGED_TYPES} names."
        )
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        name = _required_text(item, "ChangedTypes entry")
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(name)
    return normalized


def build_dataset_types_change_request(
    *,
    request_id: Any,
    project_name: Any,
    rows: Any,
    changed_types: Any,
    user_name: Any,
) -> dict[str, Any]:
    """Build the complete canonical request payload."""

    return validate_dataset_types_change_request(
        {
            "Function": DATASET_TYPES_CHANGE_FUNCTION,
            "ContractVersion": DATASET_TYPES_CHANGE_CONTRACT_VERSION,
            "RequestId": request_id,
            "ProjectName": project_name,
            "Rows": rows,
            "ChangedTypes": changed_types,
            "UserName": user_name,
        }
    )


def validate_dataset_types_change_request(payload: Any) -> dict[str, Any]:
    """Return the normalized exact request, rejecting paths and extensions.

    The required fields are also the complete allow-list, so a machine-local
    filesystem path is impossible by construction: the Engine derives every
    absolute path from its own configured ArcRho Server root.
    """

    if not isinstance(payload, Mapping):
        raise DatasetTypesChangeContractError(
            "Dataset types change request must be a JSON object."
        )

    supplied = set(payload)
    allowed = set(DATASET_TYPES_CHANGE_REQUIRED_FIELDS)
    missing = [
        field
        for field in DATASET_TYPES_CHANGE_REQUIRED_FIELDS
        if field not in supplied
    ]
    if missing:
        raise DatasetTypesChangeContractError(
            "Missing request field(s): " + ", ".join(missing) + "."
        )
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if extra:
        raise DatasetTypesChangeContractError(
            "Unexpected request field(s): " + ", ".join(extra) + "."
        )

    function_name = _required_text(payload.get("Function"), "Function")
    if function_name != DATASET_TYPES_CHANGE_FUNCTION:
        raise DatasetTypesChangeContractError(
            f"Function must be {DATASET_TYPES_CHANGE_FUNCTION!r}."
        )
    version = payload.get("ContractVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DatasetTypesChangeContractError(
            "ContractVersion must be the integer "
            f"{DATASET_TYPES_CHANGE_CONTRACT_VERSION}."
        )
    if version != DATASET_TYPES_CHANGE_CONTRACT_VERSION:
        raise DatasetTypesChangeContractError(
            f"Unsupported ContractVersion {version!r}; expected "
            f"{DATASET_TYPES_CHANGE_CONTRACT_VERSION}."
        )

    return {
        "Function": DATASET_TYPES_CHANGE_FUNCTION,
        "ContractVersion": DATASET_TYPES_CHANGE_CONTRACT_VERSION,
        "RequestId": validate_request_id(payload.get("RequestId")),
        "ProjectName": validate_project_name(payload.get("ProjectName")),
        "Rows": normalize_rows(payload.get("Rows")),
        "ChangedTypes": normalize_changed_types(payload.get("ChangedTypes")),
        "UserName": _required_text(payload.get("UserName"), "UserName"),
    }


# ---------------------------------------------------------------------------
# Protocol paths
# ---------------------------------------------------------------------------


def _root_path(server_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(server_root)
    if not str(raw).strip():
        raise DatasetTypesChangeContractError("ArcRho Server root is required.")
    return Path(raw).expanduser()


def dataset_types_change_protocol_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    """Return the protocol root; a subfolder of ``requests`` so the
    orchestrator's loose-file garbage collection never touches queued jobs."""

    return _root_path(server_root) / "requests" / "dataset_types_change"


def dataset_types_change_requests_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return dataset_types_change_protocol_directory(server_root) / "requests"


def dataset_types_change_statuses_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return dataset_types_change_protocol_directory(server_root) / "statuses"


def dataset_types_change_request_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        dataset_types_change_requests_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def dataset_types_change_status_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        dataset_types_change_statuses_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def project_identity(project_name: Any) -> str:
    return validate_project_name(project_name).casefold()


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def _normalize_progress(progress: Any) -> dict[str, Any]:
    if not isinstance(progress, Mapping):
        raise DatasetTypesChangeContractError("progress must be a JSON object.")
    supplied = set(progress)
    missing = sorted(_PROGRESS_FIELDS - supplied)
    extra = sorted(
        (str(field) for field in supplied - _PROGRESS_FIELDS), key=str.casefold
    )
    if missing:
        raise DatasetTypesChangeContractError(
            "Missing progress field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DatasetTypesChangeContractError(
            "Unexpected progress field(s): " + ", ".join(extra) + "."
        )

    completed = progress.get("completed")
    total = progress.get("total")
    for field_name, value in (("completed", completed), ("total", total)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise DatasetTypesChangeContractError(
                f"progress.{field_name} must be a non-negative integer."
            )
    if completed > total:
        raise DatasetTypesChangeContractError(
            "progress.completed must not be greater than progress.total."
        )

    return {
        "stage": _required_text(progress.get("stage"), "progress.stage"),
        "completed": completed,
        "total": total,
        "label": _required_text(progress.get("label"), "progress.label"),
    }


def _normalize_result(result: Any) -> dict[str, Any]:
    """Normalize the job's outcome summary.

    Only counts and redacted failure texts travel: the client already knows
    which project it changed, and where the table lives is the server's
    business.
    """

    if not isinstance(result, Mapping):
        raise DatasetTypesChangeContractError("result must be a JSON object.")
    extra = sorted(
        (str(field) for field in set(result) - _RESULT_FIELDS), key=str.casefold
    )
    if extra:
        raise DatasetTypesChangeContractError(
            "Unexpected result field(s): " + ", ".join(extra) + "."
        )

    normalized: dict[str, Any] = {}
    for field_name in _RESULT_COUNT_FIELDS:
        value = result.get(field_name, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise DatasetTypesChangeContractError(
                f"result.{field_name} must be a non-negative integer."
            )
        normalized[field_name] = value

    failures = result.get("failures", [])
    if not isinstance(failures, (list, tuple)):
        raise DatasetTypesChangeContractError(
            "result.failures must be a list of texts."
        )
    normalized["failures"] = [
        str(item or "").strip()
        for item in list(failures)[:_MAX_RESULT_FAILURES]
        if str(item or "").strip()
    ]
    return normalized


def build_dataset_types_change_status(
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    result: Mapping[str, Any] | None = None,
    updated_at: Any = None,
) -> dict[str, Any]:
    """Build one complete location-independent job status payload."""

    normalized_request_id = validate_request_id(request_id)
    normalized_status = str(status if status is not None else "").strip()
    if normalized_status not in DATASET_TYPES_CHANGE_STATUS_VALUES:
        raise DatasetTypesChangeContractError(
            f"Invalid dataset types change status: {status!r}."
        )
    if updated_at is None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        timestamp = _required_text(updated_at, "updated_at")

    payload: dict[str, Any] = {
        "contract_version": DATASET_TYPES_CHANGE_CONTRACT_VERSION,
        "status": normalized_status,
        "updated_at": timestamp,
        "request_id": normalized_request_id,
        "progress": _normalize_progress(progress),
    }
    normalized_message = str(message if message is not None else "").strip()
    if normalized_message:
        payload["message"] = normalized_message
    if result is not None:
        payload["result"] = _normalize_result(result)
    return payload


def validate_dataset_types_change_status(
    payload: Any,
    *,
    expected_request_id: Any = None,
) -> dict[str, Any]:
    """Validate a persisted status and return only its canonical fields."""

    if not isinstance(payload, Mapping):
        raise DatasetTypesChangeContractError(
            "Dataset types change status must be a JSON object."
        )
    required = {"contract_version", "status", "updated_at", "request_id", "progress"}
    allowed = required | {"message", "result"}
    supplied = set(payload)
    missing = sorted(required - supplied)
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if missing:
        raise DatasetTypesChangeContractError(
            "Missing status field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DatasetTypesChangeContractError(
            "Unexpected status field(s): " + ", ".join(extra) + "."
        )

    version = payload.get("contract_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DatasetTypesChangeContractError(
            "contract_version must be the integer "
            f"{DATASET_TYPES_CHANGE_CONTRACT_VERSION}."
        )
    if version != DATASET_TYPES_CHANGE_CONTRACT_VERSION:
        raise DatasetTypesChangeContractError(
            f"Unsupported contract_version {version!r}; expected "
            f"{DATASET_TYPES_CHANGE_CONTRACT_VERSION}."
        )

    status = _required_text(payload.get("status"), "status")
    if status not in DATASET_TYPES_CHANGE_STATUS_VALUES:
        raise DatasetTypesChangeContractError(
            f"Invalid dataset types change status: {payload.get('status')!r}."
        )
    request_id = validate_request_id(payload.get("request_id"))
    if expected_request_id is not None:
        expected = validate_request_id(expected_request_id)
        if request_id != expected:
            raise DatasetTypesChangeContractError(
                "Dataset types change status RequestId does not match the "
                "requested job."
            )

    normalized: dict[str, Any] = {
        "contract_version": DATASET_TYPES_CHANGE_CONTRACT_VERSION,
        "status": status,
        "updated_at": _required_text(payload.get("updated_at"), "updated_at"),
        "request_id": request_id,
        "progress": _normalize_progress(payload.get("progress")),
    }
    if "message" in payload:
        normalized["message"] = _required_text(payload.get("message"), "message")
    if "result" in payload:
        normalized["result"] = _normalize_result(payload.get("result"))
    return normalized


def write_dataset_types_change_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    result: Mapping[str, Any] | None = None,
    updated_at: Any = None,
) -> Path:
    """Build and atomically publish one dataset-type change status."""

    normalized_request_id = validate_request_id(request_id)
    payload = build_dataset_types_change_status(
        normalized_request_id,
        status,
        progress=progress,
        message=message,
        result=result,
        updated_at=updated_at,
    )
    path = dataset_types_change_status_path(server_root, normalized_request_id)
    return write_json_atomic(path, payload)


def read_dataset_types_change_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
) -> dict[str, Any] | None:
    """Read and validate one published status, or ``None`` when absent."""

    normalized_request_id = validate_request_id(request_id)
    path = dataset_types_change_status_path(server_root, normalized_request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    return validate_dataset_types_change_status(
        payload, expected_request_id=normalized_request_id
    )


# ---------------------------------------------------------------------------
# Queued-job probe
# ---------------------------------------------------------------------------


def find_queued_dataset_types_change(
    server_root: str | os.PathLike[str],
    project_name: Any,
    *,
    now: float | None = None,
    queued_fresh_seconds: float = DATASET_TYPES_CHANGE_QUEUED_STALE_SECONDS,
) -> dict[str, str] | None:
    """Return a submitted-but-unclaimed change for one project, or ``None``.

    A running job is already reported by the project-scope propagation hold in
    ``arcrho_dependent_propagation_contract``, which every writer preflights.
    This probe covers only the window between publishing the request and the
    Engine claiming its lease, so two changes cannot be queued for one project.
    """

    identity = project_identity(project_name)
    observed_at = time.time() if now is None else float(now)

    requests_dir = dataset_types_change_requests_directory(server_root)
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
            request = validate_dataset_types_change_request(
                json.loads(candidate.read_text(encoding="utf-8-sig"))
            )
        except (OSError, ValueError, TypeError, DatasetTypesChangeContractError):
            continue
        if project_identity(request["ProjectName"]) != identity:
            continue
        try:
            status = read_dataset_types_change_status(
                server_root, request["RequestId"]
            )
        except (OSError, ValueError, TypeError, DatasetTypesChangeContractError):
            status = None
        if status is not None and status["status"] in {"success", "error"}:
            continue
        return {"reason": "queued", "job_id": request["RequestId"]}
    return None
