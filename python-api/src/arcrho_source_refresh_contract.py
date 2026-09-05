"""Canonical request and status contract for ArcRho source-table refresh jobs.

Importing a project's source table and refreshing everything derived from it is
executed by ArcRho Engine on the machine hosting the ArcRho Server workspace.
A Client PC that ran the import itself copied the external CSV *through* itself
-- read from one share, written to another -- and then read the whole master
copy back to count its rows. On the server every one of those hops is local
disk.

Callers identify the work by logical project name only; the Engine derives
every absolute filesystem path from its own configured server root, exactly as
``arcrho_dependent_propagation_contract`` does for a dependent walk.

This module intentionally uses only the Python standard library so the frontend
app server, the Gateway and the frozen data engine can load the same source
file. It owns the request shape, the status shape (including the result
summary), the protocol path layout, and the per-project lease.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from arcrho_engine_job_lease import (
    EngineJobLease,
    acquire_engine_job_lease,
    release_engine_job_lease,
    start_engine_job_lease_heartbeat,
    stop_engine_job_lease_heartbeat,
)
from arcrho_project_duplication_contract import (
    validate_project_name as _canonical_validate_project_name,
    validate_request_id as _canonical_validate_request_id,
    write_json_atomic,
)


SOURCE_REFRESH_FUNCTION = "ArcRhoRefreshSourceTable"
SOURCE_REFRESH_CONTRACT_VERSION = 1
SOURCE_REFRESH_REQUIRED_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Import",
    "Force",
    "RefreshDependents",
    "UserName",
)
# The scope of the dependent refresh. Both are carried only when the person
# importing narrowed the job, so a request that refreshes everything is the
# same payload it always was. ``DatasetTypes`` names the engine-built dataset
# types to regenerate; ``ReservingClassTypes`` lists ``{"Name", "Level"}``
# pairs, and a reserving class is refreshed when its path segment at every
# listed level is one of the names listed for that level.
SOURCE_REFRESH_OPTIONAL_FIELDS = ("DatasetTypes", "ReservingClassTypes")
SOURCE_REFRESH_STATUS_VALUES = ("queued", "processing", "success", "error")

# The canonical ``app_server.services`` modules the job runs, named here for the
# same reason the workspace read and mutation contracts name theirs: the frozen
# Engine's build probe imports this list, so a service the job gained stops the
# build instead of failing the first refresh on the server.
SOURCE_REFRESH_SERVICE_MODULES: tuple[str, ...] = (
    "arcrho_runtime_service",
    "calculated_dataset_service",
    "dataset_instance_index_service",
    "dataset_service",
    "source_table_service",
    "table_summary_service",
    "user_identity_service",
)

# The project lease is held for the whole job, which regenerates every engine
# dataset in the project and then walks its dependents. That is minutes of work
# on a large project, so the lease may only be recovered after a much longer
# silence than a single reserving-class walk needs.
SOURCE_REFRESH_LEASE_HEARTBEAT_SECONDS = 5.0
SOURCE_REFRESH_LEASE_STALE_SECONDS = 900.0

# The worker republishes the current "processing" status on this cadence even
# while one slow step runs, so a remote poller can tell a live job from a dead
# worker. Queued statuses have no heartbeat owner -- the job is waiting for an
# Engine slot -- so they get a separate, longer allowance.
SOURCE_REFRESH_STATUS_HEARTBEAT_SECONDS = 5.0
SOURCE_REFRESH_STATUS_STALE_SECONDS = 45.0
SOURCE_REFRESH_QUEUED_STALE_SECONDS = 180.0

_PROGRESS_FIELDS = frozenset({"stage", "completed", "total", "label"})
_RESULT_COUNT_FIELDS = (
    "row_count",
    "column_count",
    "classes_total",
    "classes_refreshed",
    "datasets_regenerated",
    "datasets_failed",
    "methods_updated",
)
_RESULT_FLAG_FIELDS = ("imported", "dependents_refreshed")
_RESULT_TEXT_FIELDS = ("source_type",)
_RESULT_FIELDS = frozenset(
    _RESULT_COUNT_FIELDS + _RESULT_FLAG_FIELDS + _RESULT_TEXT_FIELDS + ("failures",)
)
_MAX_RESULT_FAILURES = 25


class SourceRefreshContractError(ValueError):
    """Raised when a source-refresh payload violates this contract."""


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SourceRefreshContractError(f"{field_name} is required.")
    return value.strip()


def _required_flag(value: Any, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise SourceRefreshContractError(f"{field_name} must be true or false.")
    return value


def _normalize_dataset_types(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise SourceRefreshContractError("DatasetTypes must be a list of names.")
    names: list[str] = []
    seen: set[str] = set()
    for item in value:
        name = _required_text(item, "DatasetTypes entry")
        if name.casefold() not in seen:
            seen.add(name.casefold())
            names.append(name)
    return names


def _normalize_reserving_class_types(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise SourceRefreshContractError(
            "ReservingClassTypes must be a list of {Name, Level} objects."
        )
    entries: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for item in value:
        if not isinstance(item, Mapping) or set(item) != {"Name", "Level"}:
            raise SourceRefreshContractError(
                "Each ReservingClassTypes entry must hold exactly Name and Level."
            )
        name = _required_text(item.get("Name"), "ReservingClassTypes Name")
        level = item.get("Level")
        if isinstance(level, bool) or not isinstance(level, int) or level < 1:
            raise SourceRefreshContractError(
                "ReservingClassTypes Level must be a positive integer."
            )
        if (level, name.casefold()) not in seen:
            seen.add((level, name.casefold()))
            entries.append({"Name": name, "Level": level})
    return entries


def validate_request_id(value: Any) -> str:
    try:
        return _canonical_validate_request_id(value)
    except ValueError as exc:
        raise SourceRefreshContractError(str(exc)) from exc


def validate_project_name(value: Any, field_name: str = "ProjectName") -> str:
    try:
        return _canonical_validate_project_name(value, field_name)
    except ValueError as exc:
        raise SourceRefreshContractError(str(exc)) from exc


def build_source_refresh_request(
    *,
    request_id: Any,
    project_name: Any,
    user_name: Any,
    import_source: bool = True,
    force: bool = True,
    refresh_dependents: bool = True,
    dataset_types: Any = None,
    reserving_class_types: Any = None,
) -> dict[str, Any]:
    """Build the complete canonical request payload.

    A scope is written only when one was chosen, so a job that refreshes the
    whole project produces the payload every consumer already accepts.
    """

    payload: dict[str, Any] = {
        "Function": SOURCE_REFRESH_FUNCTION,
        "ContractVersion": SOURCE_REFRESH_CONTRACT_VERSION,
        "RequestId": request_id,
        "ProjectName": project_name,
        "Import": bool(import_source),
        "Force": bool(force),
        "RefreshDependents": bool(refresh_dependents),
        "UserName": user_name,
    }
    if dataset_types:
        payload["DatasetTypes"] = list(dataset_types)
    if reserving_class_types:
        payload["ReservingClassTypes"] = list(reserving_class_types)
    return validate_source_refresh_request(payload)


def validate_source_refresh_request(payload: Any) -> dict[str, Any]:
    """Return the normalized exact request, rejecting paths and extensions.

    The required fields plus the two optional scope fields are the complete
    allow-list, so machine-local filesystem paths are impossible by
    construction: every consumer derives absolute paths from its own configured
    ArcRho Server root, and the external source itself is read from the
    project's own saved configuration.
    """

    if not isinstance(payload, Mapping):
        raise SourceRefreshContractError(
            "Source refresh request must be a JSON object."
        )

    supplied = set(payload)
    allowed = set(SOURCE_REFRESH_REQUIRED_FIELDS) | set(SOURCE_REFRESH_OPTIONAL_FIELDS)
    missing = [
        field for field in SOURCE_REFRESH_REQUIRED_FIELDS if field not in supplied
    ]
    if missing:
        raise SourceRefreshContractError(
            "Missing request field(s): " + ", ".join(missing) + "."
        )
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if extra:
        raise SourceRefreshContractError(
            "Unexpected request field(s): " + ", ".join(extra) + ". "
            "Filesystem paths must not be supplied by request producers; only "
            "canonical logical workspace fields are allowed."
        )

    function = _required_text(payload.get("Function"), "Function")
    if function != SOURCE_REFRESH_FUNCTION:
        raise SourceRefreshContractError(
            f"Function must be {SOURCE_REFRESH_FUNCTION}."
        )

    version = payload.get("ContractVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise SourceRefreshContractError(
            "ContractVersion must be the integer "
            f"{SOURCE_REFRESH_CONTRACT_VERSION}."
        )
    if version != SOURCE_REFRESH_CONTRACT_VERSION:
        raise SourceRefreshContractError(
            f"Unsupported ContractVersion {version!r}; expected "
            f"{SOURCE_REFRESH_CONTRACT_VERSION}."
        )

    import_source = _required_flag(payload.get("Import"), "Import")
    refresh_dependents = _required_flag(
        payload.get("RefreshDependents"), "RefreshDependents"
    )
    if not import_source and not refresh_dependents:
        raise SourceRefreshContractError(
            "A source refresh request must import the table, refresh dependents, "
            "or both."
        )

    normalized: dict[str, Any] = {
        "Function": SOURCE_REFRESH_FUNCTION,
        "ContractVersion": SOURCE_REFRESH_CONTRACT_VERSION,
        "RequestId": validate_request_id(payload.get("RequestId")),
        "ProjectName": validate_project_name(payload.get("ProjectName")),
        "Import": import_source,
        "Force": _required_flag(payload.get("Force"), "Force"),
        "RefreshDependents": refresh_dependents,
        "UserName": _required_text(payload.get("UserName"), "UserName"),
    }
    dataset_types = _normalize_dataset_types(payload.get("DatasetTypes"))
    if dataset_types:
        normalized["DatasetTypes"] = dataset_types
    reserving_class_types = _normalize_reserving_class_types(
        payload.get("ReservingClassTypes")
    )
    if reserving_class_types:
        normalized["ReservingClassTypes"] = reserving_class_types
    return normalized


def reserving_class_matches_scope(
    reserving_class: str, reserving_class_types: list[dict[str, Any]] | None
) -> bool:
    """Say whether one class path falls inside a request's reserving-class scope.

    The path segments are the class's values at levels 1, 2, 3...; a level that
    the scope does not mention accepts every value, and an empty scope accepts
    every class.
    """

    if not reserving_class_types:
        return True
    names_by_level: dict[int, set[str]] = {}
    for entry in reserving_class_types:
        names_by_level.setdefault(int(entry["Level"]), set()).add(
            str(entry["Name"]).casefold()
        )
    segments = [part.strip().casefold() for part in str(reserving_class).split("\\")]
    for level, names in names_by_level.items():
        segment = segments[level - 1] if level - 1 < len(segments) else ""
        if segment not in names:
            return False
    return True


# ---------------------------------------------------------------------------
# Protocol paths
# ---------------------------------------------------------------------------


def _root_path(server_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(server_root)
    if not str(raw).strip():
        raise SourceRefreshContractError("ArcRho Server root is required.")
    return Path(raw).expanduser()


def source_refresh_protocol_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    """Return the protocol root; a subfolder of ``requests`` so the
    orchestrator's loose-file garbage collection never touches queued jobs."""

    return _root_path(server_root) / "requests" / "source_table_refresh"


def source_refresh_requests_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return source_refresh_protocol_directory(server_root) / "requests"


def source_refresh_statuses_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return source_refresh_protocol_directory(server_root) / "statuses"


def source_refresh_locks_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return source_refresh_protocol_directory(server_root) / "locks"


def source_refresh_request_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        source_refresh_requests_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def source_refresh_status_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        source_refresh_statuses_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def project_identity(project_name: Any) -> str:
    return validate_project_name(project_name).casefold()


def source_refresh_lock_path(
    server_root: str | os.PathLike[str],
    project_name: Any,
) -> Path:
    digest = hashlib.sha256(
        project_identity(project_name).encode("utf-8")
    ).hexdigest()
    return source_refresh_locks_directory(server_root) / f"{digest}.lock"


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def _normalize_progress(progress: Any) -> dict[str, Any]:
    if not isinstance(progress, Mapping):
        raise SourceRefreshContractError("progress must be a JSON object.")
    supplied = set(progress)
    missing = sorted(_PROGRESS_FIELDS - supplied)
    extra = sorted(
        (str(field) for field in supplied - _PROGRESS_FIELDS), key=str.casefold
    )
    if missing:
        raise SourceRefreshContractError(
            "Missing progress field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise SourceRefreshContractError(
            "Unexpected progress field(s): " + ", ".join(extra) + "."
        )

    completed = progress.get("completed")
    total = progress.get("total")
    for field_name, value in (("completed", completed), ("total", total)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise SourceRefreshContractError(
                f"progress.{field_name} must be a non-negative integer."
            )
    if completed > total:
        raise SourceRefreshContractError(
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

    Only counts, flags and the logical source kind travel. No path is carried:
    the client already knows the source it configured, and the master copy's
    location is the server's business.
    """

    if not isinstance(result, Mapping):
        raise SourceRefreshContractError("result must be a JSON object.")
    extra = sorted(
        (str(field) for field in set(result) - _RESULT_FIELDS), key=str.casefold
    )
    if extra:
        raise SourceRefreshContractError(
            "Unexpected result field(s): " + ", ".join(extra) + "."
        )

    normalized: dict[str, Any] = {}
    for field_name in _RESULT_TEXT_FIELDS:
        normalized[field_name] = str(result.get(field_name) or "").strip()
    for field_name in _RESULT_FLAG_FIELDS:
        normalized[field_name] = bool(result.get(field_name))
    for field_name in _RESULT_COUNT_FIELDS:
        value = result.get(field_name, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise SourceRefreshContractError(
                f"result.{field_name} must be a non-negative integer."
            )
        normalized[field_name] = value

    failures = result.get("failures", [])
    if not isinstance(failures, (list, tuple)):
        raise SourceRefreshContractError("result.failures must be a list of texts.")
    normalized["failures"] = [
        str(item or "").strip()
        for item in list(failures)[:_MAX_RESULT_FAILURES]
        if str(item or "").strip()
    ]
    return normalized


def build_source_refresh_status(
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
    if normalized_status not in SOURCE_REFRESH_STATUS_VALUES:
        raise SourceRefreshContractError(
            f"Invalid source refresh status: {status!r}."
        )
    if updated_at is None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        timestamp = _required_text(updated_at, "updated_at")

    payload: dict[str, Any] = {
        "contract_version": SOURCE_REFRESH_CONTRACT_VERSION,
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


def validate_source_refresh_status(
    payload: Any,
    *,
    expected_request_id: Any = None,
) -> dict[str, Any]:
    """Validate a persisted status and return only its canonical fields."""

    if not isinstance(payload, Mapping):
        raise SourceRefreshContractError("Source refresh status must be a JSON object.")
    required = {"contract_version", "status", "updated_at", "request_id", "progress"}
    allowed = required | {"message", "result"}
    supplied = set(payload)
    missing = sorted(required - supplied)
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if missing:
        raise SourceRefreshContractError(
            "Missing status field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise SourceRefreshContractError(
            "Unexpected status field(s): " + ", ".join(extra) + "."
        )

    version = payload.get("contract_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise SourceRefreshContractError(
            "contract_version must be the integer "
            f"{SOURCE_REFRESH_CONTRACT_VERSION}."
        )
    if version != SOURCE_REFRESH_CONTRACT_VERSION:
        raise SourceRefreshContractError(
            f"Unsupported contract_version {version!r}; expected "
            f"{SOURCE_REFRESH_CONTRACT_VERSION}."
        )

    status = _required_text(payload.get("status"), "status")
    if status not in SOURCE_REFRESH_STATUS_VALUES:
        raise SourceRefreshContractError(
            f"Invalid source refresh status: {payload.get('status')!r}."
        )
    request_id = validate_request_id(payload.get("request_id"))
    if expected_request_id is not None:
        expected = validate_request_id(expected_request_id)
        if request_id != expected:
            raise SourceRefreshContractError(
                "Source refresh status RequestId does not match the requested job."
            )

    normalized: dict[str, Any] = {
        "contract_version": SOURCE_REFRESH_CONTRACT_VERSION,
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


def write_source_refresh_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    result: Mapping[str, Any] | None = None,
    updated_at: Any = None,
) -> Path:
    """Build and atomically publish one source-refresh status."""

    normalized_request_id = validate_request_id(request_id)
    payload = build_source_refresh_status(
        normalized_request_id,
        status,
        progress=progress,
        message=message,
        result=result,
        updated_at=updated_at,
    )
    path = source_refresh_status_path(server_root, normalized_request_id)
    return write_json_atomic(path, payload)


def read_source_refresh_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
) -> dict[str, Any] | None:
    """Read and validate one published status, or ``None`` when absent."""

    normalized_request_id = validate_request_id(request_id)
    path = source_refresh_status_path(server_root, normalized_request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    return validate_source_refresh_status(
        payload, expected_request_id=normalized_request_id
    )


# ---------------------------------------------------------------------------
# Per-project lease
# ---------------------------------------------------------------------------


def acquire_source_refresh_lease(
    server_root: str | os.PathLike[str],
    project_name: Any,
) -> EngineJobLease | None:
    """Exclusively claim one project for a source refresh, or ``None``."""

    lock_path = source_refresh_lock_path(server_root, project_name)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    return acquire_engine_job_lease(
        lock_path,
        stale_seconds=SOURCE_REFRESH_LEASE_STALE_SECONDS,
        payload_fields={"project_name": validate_project_name(project_name)},
    )


def release_source_refresh_lease(lease: EngineJobLease | None) -> None:
    release_engine_job_lease(lease)


def start_source_refresh_lease_heartbeat(lease: EngineJobLease):
    return start_engine_job_lease_heartbeat(
        lease,
        interval_seconds=SOURCE_REFRESH_LEASE_HEARTBEAT_SECONDS,
        thread_name=f"arcrho-source-refresh-lease-{lease.owner_token[:8]}",
    )


def stop_source_refresh_lease_heartbeat(stop_event, thread) -> None:
    stop_engine_job_lease_heartbeat(
        stop_event,
        thread,
        interval_seconds=SOURCE_REFRESH_LEASE_HEARTBEAT_SECONDS,
    )


def find_source_refresh_hold(
    server_root: str | os.PathLike[str],
    project_name: Any,
    *,
    now: float | None = None,
    processing_fresh_seconds: float = SOURCE_REFRESH_STATUS_STALE_SECONDS,
    queued_fresh_seconds: float = SOURCE_REFRESH_QUEUED_STALE_SECONDS,
) -> dict[str, str] | None:
    """Return the active source-refresh hold on one project, or ``None``.

    A second import must not be submitted while one is rewriting the project,
    so the submit path preflights this probe. It is deliberately cheap for a
    remote caller on a mapped drive: one lock-file stat, plus a scan of the
    (normally empty) queued-requests folder.
    """

    identity = project_identity(project_name)
    observed_at = time.time() if now is None else float(now)

    lock_path = source_refresh_lock_path(server_root, project_name)
    try:
        lease_age = observed_at - lock_path.stat().st_mtime
    except OSError:
        lease_age = None
    if lease_age is not None and lease_age <= processing_fresh_seconds:
        return {"reason": "processing"}

    requests_dir = source_refresh_requests_directory(server_root)
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
            request = validate_source_refresh_request(
                json.loads(candidate.read_text(encoding="utf-8-sig"))
            )
        except (OSError, ValueError, TypeError, SourceRefreshContractError):
            continue
        if project_identity(request["ProjectName"]) != identity:
            continue
        try:
            status = read_source_refresh_status(server_root, request["RequestId"])
        except (OSError, ValueError, TypeError, SourceRefreshContractError):
            status = None
        if status is not None and status["status"] in {"success", "error"}:
            continue
        return {"reason": "queued"}
    return None
