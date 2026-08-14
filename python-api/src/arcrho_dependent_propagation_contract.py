"""Canonical request, status, lease, and heartbeat contract for ArcRho
dependent propagation.

Dependent propagation — the "update all dependents" cascade that follows a
dataset or method save — is executed by ArcRho Engine on the machine hosting
the ArcRho Server workspace as a durable long-running job. Callers identify
the changed objects by logical project name, logical reserving-class path, and
logical changed-root names; the Engine derives every absolute filesystem path
from its own configured server root.

This module intentionally uses only the Python standard library so the
frontend app server, the frozen data engine, the frozen Bridge, and the public
Python API can load the same source file. It owns the request shape, folder
layout, status shape, reserving-class lease parameters, and the live-Engine
heartbeat preflight for this workflow. Request, status, and lock files are
transient runtime files outside the persisted ArcRho JSON text-format rule.

Status files follow the project-duplication retention policy: they are
retained after terminal states for pollers and operators, with no automatic
pruning beyond operator cleanup.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping

from arcrho_engine_job_lease import (
    EngineJobLease,
    acquire_engine_job_lease,
    release_engine_job_lease,
    start_engine_job_lease_heartbeat,
    stop_engine_job_lease_heartbeat,
)
from arcrho_project_duplication_contract import (
    ProjectDuplicationContractError as _CanonicalContractError,
    validate_project_name as _canonical_validate_project_name,
    validate_request_id as _canonical_validate_request_id,
    write_json_atomic,
)


DEPENDENT_PROPAGATION_FUNCTION = "ArcRhoRefreshDependents"
DEPENDENT_PROPAGATION_CONTRACT_VERSION = 1
DEPENDENT_PROPAGATION_REQUIRED_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Path",
    "ChangedRoots",
    "UserName",
)
DEPENDENT_PROPAGATION_STATUS_VALUES = (
    "queued",
    "processing",
    "success",
    "error",
)
DEPENDENT_PROPAGATION_LEASE_HEARTBEAT_SECONDS = 5.0
DEPENDENT_PROPAGATION_LEASE_STALE_SECONDS = 300.0

# The Engine worker republishes the current "processing" status on this cadence
# even when progress has not advanced, so a remote poller can tell a live walk
# from a dead worker. A status whose updated_at/mtime stops moving for the
# stale window is treated as abandoned by pollers and by the reserving-class
# writability preflight; the values are shared so every consumer draws the
# line in the same place. Queued statuses have no heartbeat owner (the job is
# waiting to be claimed), so they get a separate, longer allowance.
DEPENDENT_PROPAGATION_STATUS_HEARTBEAT_SECONDS = 5.0
DEPENDENT_PROPAGATION_STATUS_STALE_SECONDS = 45.0
DEPENDENT_PROPAGATION_QUEUED_STALE_SECONDS = 180.0

ENGINE_HEARTBEAT_MAX_AGE_SECONDS = 60.0
ENGINE_UNAVAILABLE_MESSAGE = (
    "The ArcRho Engine service is not available. "
    "Please try again later or contact the administrator."
)

_ENGINE_INSTANCES_RELATIVE_DIR = Path("runtime") / "instances" / "arcrho_engine"
_CHANGED_ROOT_FIELDS = frozenset({"dataset_name", "dataset_type"})
_PROGRESS_FIELDS = frozenset({"stage", "completed", "total", "label"})
_DRIVE_OR_UNC_RE = re.compile(r"(?i)^(?:[a-z]:|\\\\|//)")


class DependentPropagationContractError(ValueError):
    """Raised when a dependent-propagation payload violates the contract."""


class EngineUnavailableError(RuntimeError):
    """Raised when no recently active ArcRho Engine instance is available."""


class DependentPropagationLeaseUnavailable(RuntimeError):
    """Raised when the reserving-class lease could not be acquired in time."""


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DependentPropagationContractError(f"{field_name} is required.")
    return value.strip()


def validate_request_id(value: Any) -> str:
    try:
        return _canonical_validate_request_id(value)
    except _CanonicalContractError as exc:
        raise DependentPropagationContractError(str(exc)) from exc


def validate_project_name(value: Any, field_name: str = "ProjectName") -> str:
    try:
        return _canonical_validate_project_name(value, field_name)
    except _CanonicalContractError as exc:
        raise DependentPropagationContractError(str(exc)) from exc


def validate_reserving_class_path(value: Any) -> str:
    """Return one normalized logical reserving-class path such as ``A\\B\\C``.

    The path is logical — each segment is a reserving-class tree label that the
    consumer encodes into a folder name — so characters that are unsafe in raw
    folder names are allowed inside segments. Machine-local forms (drive
    letters, UNC prefixes, parent traversal) are rejected.
    """

    raw = _required_text(value, "Path")
    if _DRIVE_OR_UNC_RE.match(raw):
        raise DependentPropagationContractError(
            "Path must be a logical reserving-class path, not a filesystem path."
        )
    segments = [part.strip() for part in raw.replace("/", "\\").split("\\")]
    segments = [part for part in segments if part]
    if not segments:
        raise DependentPropagationContractError("Path is required.")
    for segment in segments:
        try:
            _canonical_validate_project_name(segment, "Path segment")
        except _CanonicalContractError as exc:
            raise DependentPropagationContractError(str(exc)) from exc
    return "\\".join(segments)


def reserving_class_identity(project_name: Any, path: Any) -> str:
    """Return the case-insensitive coalescing identity of one reserving class."""

    project = validate_project_name(project_name)
    normalized_path = validate_reserving_class_path(path)
    return f"{project.casefold()}\0{normalized_path.casefold()}"


def normalize_changed_roots(value: Any) -> list[dict[str, str]]:
    """Validate and canonicalize the ordered, de-duplicated changed-root list."""

    if not isinstance(value, (list, tuple)) or not value:
        raise DependentPropagationContractError(
            "ChangedRoots must be a non-empty list of changed-root objects."
        )
    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        if not isinstance(item, Mapping):
            raise DependentPropagationContractError(
                "Each ChangedRoots entry must be a JSON object."
            )
        supplied = set(item)
        extra = sorted(
            (str(field) for field in supplied - _CHANGED_ROOT_FIELDS),
            key=str.casefold,
        )
        if extra:
            raise DependentPropagationContractError(
                "Unexpected ChangedRoots field(s): " + ", ".join(extra) + "."
            )
        dataset_name = _required_text(
            item.get("dataset_name"), "ChangedRoots.dataset_name"
        )
        dataset_type_value = item.get("dataset_type", "")
        if dataset_type_value is None:
            dataset_type_value = ""
        if not isinstance(dataset_type_value, str):
            raise DependentPropagationContractError(
                "ChangedRoots.dataset_type must be a string."
            )
        dataset_type = dataset_type_value.strip()
        key = (dataset_name.casefold(), dataset_type.casefold())
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {"dataset_name": dataset_name, "dataset_type": dataset_type}
        )
    return normalized


def merge_changed_roots(*root_lists: Any) -> list[dict[str, str]]:
    """Merge several validated root lists into one ordered de-duplicated walk."""

    combined: list[Any] = []
    for roots in root_lists:
        if roots:
            combined.extend(roots)
    return normalize_changed_roots(combined)


def build_dependent_propagation_request(
    *,
    request_id: Any,
    project_name: Any,
    path: Any,
    changed_roots: Any,
    user_name: Any,
) -> dict[str, Any]:
    """Build the complete canonical request payload."""

    return validate_dependent_propagation_request(
        {
            "Function": DEPENDENT_PROPAGATION_FUNCTION,
            "ContractVersion": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
            "RequestId": request_id,
            "ProjectName": project_name,
            "Path": path,
            "ChangedRoots": changed_roots,
            "UserName": user_name,
        }
    )


def validate_dependent_propagation_request(payload: Any) -> dict[str, Any]:
    """Return the normalized exact request, rejecting paths and extensions.

    The required fields are also the complete allow-list, so machine-local
    filesystem paths are impossible by construction: every consumer derives
    absolute paths from its own configured ArcRho Server root.
    """

    if not isinstance(payload, Mapping):
        raise DependentPropagationContractError(
            "Dependent propagation request must be a JSON object."
        )

    supplied = set(payload)
    allowed = set(DEPENDENT_PROPAGATION_REQUIRED_FIELDS)
    missing = [
        field
        for field in DEPENDENT_PROPAGATION_REQUIRED_FIELDS
        if field not in supplied
    ]
    if missing:
        raise DependentPropagationContractError(
            "Missing request field(s): " + ", ".join(missing) + "."
        )
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if extra:
        raise DependentPropagationContractError(
            "Unexpected request field(s): " + ", ".join(extra) + ". "
            "Filesystem paths must not be supplied by request producers; only "
            "canonical logical workspace fields are allowed."
        )

    function = _required_text(payload.get("Function"), "Function")
    if function != DEPENDENT_PROPAGATION_FUNCTION:
        raise DependentPropagationContractError(
            f"Function must be {DEPENDENT_PROPAGATION_FUNCTION}."
        )

    version = payload.get("ContractVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DependentPropagationContractError(
            "ContractVersion must be the integer "
            f"{DEPENDENT_PROPAGATION_CONTRACT_VERSION}."
        )
    if version != DEPENDENT_PROPAGATION_CONTRACT_VERSION:
        raise DependentPropagationContractError(
            f"Unsupported ContractVersion {version!r}; expected "
            f"{DEPENDENT_PROPAGATION_CONTRACT_VERSION}."
        )

    return {
        "Function": DEPENDENT_PROPAGATION_FUNCTION,
        "ContractVersion": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
        "RequestId": validate_request_id(payload.get("RequestId")),
        "ProjectName": validate_project_name(payload.get("ProjectName")),
        "Path": validate_reserving_class_path(payload.get("Path")),
        "ChangedRoots": normalize_changed_roots(payload.get("ChangedRoots")),
        "UserName": _required_text(payload.get("UserName"), "UserName"),
    }


def _root_path(server_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(server_root)
    if not str(raw).strip():
        raise DependentPropagationContractError("ArcRho Server root is required.")
    return Path(raw).expanduser()


def dependent_propagation_protocol_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    """Return the protocol root; a subfolder of ``requests`` so the
    orchestrator's loose-file garbage collection never touches queued jobs."""

    return _root_path(server_root) / "requests" / "dependent_propagation"


def dependent_propagation_requests_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return dependent_propagation_protocol_directory(server_root) / "requests"


def dependent_propagation_statuses_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return dependent_propagation_protocol_directory(server_root) / "statuses"


def dependent_propagation_locks_directory(
    server_root: str | os.PathLike[str],
) -> Path:
    return dependent_propagation_protocol_directory(server_root) / "locks"


def dependent_propagation_request_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        dependent_propagation_requests_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def dependent_propagation_status_path(
    server_root: str | os.PathLike[str], request_id: Any
) -> Path:
    return (
        dependent_propagation_statuses_directory(server_root)
        / f"{validate_request_id(request_id)}.json"
    )


def dependent_propagation_lock_path(
    server_root: str | os.PathLike[str],
    project_name: Any,
    path: Any,
) -> Path:
    digest = hashlib.sha256(
        reserving_class_identity(project_name, path).encode("utf-8")
    ).hexdigest()
    return dependent_propagation_locks_directory(server_root) / f"{digest}.lock"


def _normalize_progress(progress: Any) -> dict[str, Any]:
    if not isinstance(progress, Mapping):
        raise DependentPropagationContractError("progress must be a JSON object.")
    supplied = set(progress)
    missing = sorted(_PROGRESS_FIELDS - supplied)
    extra = sorted(
        (str(field) for field in supplied - _PROGRESS_FIELDS), key=str.casefold
    )
    if missing:
        raise DependentPropagationContractError(
            "Missing progress field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DependentPropagationContractError(
            "Unexpected progress field(s): " + ", ".join(extra) + "."
        )

    completed = progress.get("completed")
    total = progress.get("total")
    for field_name, value in (("completed", completed), ("total", total)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise DependentPropagationContractError(
                f"progress.{field_name} must be a non-negative integer."
            )
    if completed > total:
        raise DependentPropagationContractError(
            "progress.completed must not be greater than progress.total."
        )

    return {
        "stage": _required_text(progress.get("stage"), "progress.stage"),
        "completed": completed,
        "total": total,
        "label": _required_text(progress.get("label"), "progress.label"),
    }


def build_dependent_propagation_status(
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    merged_into: Any = None,
    updated_at: Any = None,
) -> dict[str, Any]:
    """Build one complete location-independent job status payload."""

    normalized_request_id = validate_request_id(request_id)
    normalized_status = str(status if status is not None else "").strip()
    if normalized_status not in DEPENDENT_PROPAGATION_STATUS_VALUES:
        raise DependentPropagationContractError(
            f"Invalid dependent propagation status: {status!r}."
        )
    if updated_at is None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    else:
        timestamp = _required_text(updated_at, "updated_at")

    payload: dict[str, Any] = {
        "contract_version": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
        "status": normalized_status,
        "updated_at": timestamp,
        "request_id": normalized_request_id,
        "progress": _normalize_progress(progress),
    }
    normalized_message = str(message if message is not None else "").strip()
    if normalized_message:
        payload["message"] = normalized_message
    if merged_into is not None:
        payload["merged_into"] = validate_request_id(merged_into)
    return payload


def validate_dependent_propagation_status(
    payload: Any,
    *,
    expected_request_id: Any = None,
) -> dict[str, Any]:
    """Validate a persisted status and return only its canonical fields."""

    if not isinstance(payload, Mapping):
        raise DependentPropagationContractError(
            "Dependent propagation status must be a JSON object."
        )
    required = {
        "contract_version",
        "status",
        "updated_at",
        "request_id",
        "progress",
    }
    allowed = required | {"message", "merged_into"}
    supplied = set(payload)
    missing = sorted(required - supplied)
    extra = sorted((str(field) for field in supplied - allowed), key=str.casefold)
    if missing:
        raise DependentPropagationContractError(
            "Missing status field(s): " + ", ".join(missing) + "."
        )
    if extra:
        raise DependentPropagationContractError(
            "Unexpected status field(s): " + ", ".join(extra) + "."
        )

    version = payload.get("contract_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise DependentPropagationContractError(
            "contract_version must be the integer "
            f"{DEPENDENT_PROPAGATION_CONTRACT_VERSION}."
        )
    if version != DEPENDENT_PROPAGATION_CONTRACT_VERSION:
        raise DependentPropagationContractError(
            f"Unsupported contract_version {version!r}; expected "
            f"{DEPENDENT_PROPAGATION_CONTRACT_VERSION}."
        )

    status = _required_text(payload.get("status"), "status")
    if status not in DEPENDENT_PROPAGATION_STATUS_VALUES:
        raise DependentPropagationContractError(
            f"Invalid dependent propagation status: {payload.get('status')!r}."
        )
    request_id = validate_request_id(payload.get("request_id"))
    if expected_request_id is not None:
        expected = validate_request_id(expected_request_id)
        if request_id != expected:
            raise DependentPropagationContractError(
                "Dependent propagation status RequestId does not match the "
                "requested job."
            )

    normalized: dict[str, Any] = {
        "contract_version": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
        "status": status,
        "updated_at": _required_text(payload.get("updated_at"), "updated_at"),
        "request_id": request_id,
        "progress": _normalize_progress(payload.get("progress")),
    }
    if "message" in payload:
        normalized["message"] = _required_text(payload.get("message"), "message")
    if "merged_into" in payload:
        normalized["merged_into"] = validate_request_id(payload.get("merged_into"))
    return normalized


def write_dependent_propagation_status(
    server_root: str | os.PathLike[str],
    request_id: Any,
    status: str,
    *,
    progress: Mapping[str, Any],
    message: Any = "",
    merged_into: Any = None,
    updated_at: Any = None,
) -> Path:
    """Build and atomically publish one dependent-propagation status."""

    normalized_request_id = validate_request_id(request_id)
    payload = build_dependent_propagation_status(
        normalized_request_id,
        status,
        progress=progress,
        message=message,
        merged_into=merged_into,
        updated_at=updated_at,
    )
    path = dependent_propagation_status_path(server_root, normalized_request_id)
    return write_json_atomic(path, payload)


# ---------------------------------------------------------------------------
# Reserving-class lease
# ---------------------------------------------------------------------------


def acquire_reserving_class_lease(
    server_root: str | os.PathLike[str],
    project_name: Any,
    path: Any,
) -> EngineJobLease | None:
    """Exclusively claim one reserving class for propagation, or ``None``."""

    lock_path = dependent_propagation_lock_path(server_root, project_name, path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    return acquire_engine_job_lease(
        lock_path,
        stale_seconds=DEPENDENT_PROPAGATION_LEASE_STALE_SECONDS,
        payload_fields={
            "project_name": validate_project_name(project_name),
            "path": validate_reserving_class_path(path),
        },
    )


def release_reserving_class_lease(lease: EngineJobLease | None) -> None:
    release_engine_job_lease(lease)


def start_reserving_class_lease_heartbeat(lease: EngineJobLease):
    return start_engine_job_lease_heartbeat(
        lease,
        interval_seconds=DEPENDENT_PROPAGATION_LEASE_HEARTBEAT_SECONDS,
        thread_name=f"arcrho-dependent-propagation-lease-{lease.owner_token[:8]}",
    )


def stop_reserving_class_lease_heartbeat(stop_event, thread) -> None:
    stop_engine_job_lease_heartbeat(
        stop_event,
        thread,
        interval_seconds=DEPENDENT_PROPAGATION_LEASE_HEARTBEAT_SECONDS,
    )


@contextmanager
def held_reserving_class_lease(
    server_root: str | os.PathLike[str],
    project_name: Any,
    path: Any,
    *,
    timeout_seconds: float = DEPENDENT_PROPAGATION_LEASE_STALE_SECONDS,
    poll_seconds: float = 1.0,
) -> Iterator[EngineJobLease]:
    """Hold the reserving-class lease with a running heartbeat.

    This is the helper server-host in-process producers (the Bridge ResQ
    import, ``resq_data_migration.py``, and the public Python API) must use
    around any canonical dependent walk they run themselves. Client processes
    must enqueue an Engine job instead of taking this cross-machine lease.
    """

    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    lease = acquire_reserving_class_lease(server_root, project_name, path)
    while lease is None:
        if time.monotonic() >= deadline:
            raise DependentPropagationLeaseUnavailable(
                "Another ArcRho dependent propagation is already running for "
                "this reserving class."
            )
        time.sleep(max(0.05, float(poll_seconds)))
        lease = acquire_reserving_class_lease(server_root, project_name, path)
    stop_event, thread = start_reserving_class_lease_heartbeat(lease)
    try:
        yield lease
    finally:
        stop_reserving_class_lease_heartbeat(stop_event, thread)
        release_reserving_class_lease(lease)


# ---------------------------------------------------------------------------
# Reserving-class write-hold probe
# ---------------------------------------------------------------------------


def find_reserving_class_propagation_hold(
    server_root: str | os.PathLike[str],
    project_name: Any,
    path: Any,
    *,
    now: float | None = None,
    processing_fresh_seconds: float = DEPENDENT_PROPAGATION_STATUS_STALE_SECONDS,
    queued_fresh_seconds: float = DEPENDENT_PROPAGATION_QUEUED_STALE_SECONDS,
) -> dict[str, str] | None:
    """Return the active propagation hold on one reserving class, or ``None``.

    A save into a reserving class must not race the dependent walk that is
    rewriting that class, so writers preflight this probe and refuse with a
    lock-contention error while it reports a hold. The probe is deliberately
    cheap for a remote caller on a mapped drive: one lock-file stat, plus a
    scan of the (normally empty) queued-requests folder.

    A hold exists while either:

    - the reserving-class lease file is fresh — its heartbeat-renewed mtime is
      within ``processing_fresh_seconds`` (reason ``"processing"``); or
    - a queued request for the class, no older than ``queued_fresh_seconds``,
      has no terminal status yet (reason ``"queued"``).

    Both freshness windows exist so a dead worker or an abandoned queue entry
    can never freeze the class forever; a stale hold simply stops being
    reported. This check-then-write gate cannot be atomic on a plain
    filesystem — two saves may still slip past it together — and that residual
    race stays safe because the Engine merges concurrent queued requests for
    one class into a single walk.
    """

    identity = reserving_class_identity(project_name, path)
    observed_at = time.time() if now is None else float(now)

    lock_path = dependent_propagation_lock_path(server_root, project_name, path)
    try:
        lease_age = observed_at - lock_path.stat().st_mtime
    except OSError:
        lease_age = None
    if lease_age is not None and lease_age <= processing_fresh_seconds:
        return {"reason": "processing"}

    requests_dir = dependent_propagation_requests_directory(server_root)
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
            request = validate_dependent_propagation_request(
                json.loads(candidate.read_text(encoding="utf-8"))
            )
        except (OSError, ValueError, TypeError, DependentPropagationContractError):
            continue
        if (
            reserving_class_identity(request["ProjectName"], request["Path"])
            != identity
        ):
            continue
        status_path = dependent_propagation_status_path(
            server_root, request["RequestId"]
        )
        try:
            status = validate_dependent_propagation_status(
                json.loads(status_path.read_text(encoding="utf-8")),
                expected_request_id=request["RequestId"],
            )
        except OSError:
            status = None
        except (ValueError, TypeError, DependentPropagationContractError):
            status = None
        if status is not None and status["status"] in {"success", "error"}:
            continue
        return {"reason": "queued"}
    return None


# ---------------------------------------------------------------------------
# Live-Engine heartbeat preflight
# ---------------------------------------------------------------------------


def engine_instances_directory(server_root: str | os.PathLike[str]) -> Path:
    return _root_path(server_root) / _ENGINE_INSTANCES_RELATIVE_DIR


def discover_fresh_engine_heartbeats(
    server_root: str | os.PathLike[str],
    *,
    max_age_sec: float = ENGINE_HEARTBEAT_MAX_AGE_SECONDS,
    now: float | None = None,
) -> tuple[Path, ...]:
    """Return engine heartbeat files modified within ``max_age_sec``."""

    if max_age_sec < 0:
        raise ValueError("max_age_sec must be non-negative.")
    instance_dir = engine_instances_directory(server_root)
    try:
        candidates = tuple(instance_dir.glob("*.json"))
    except OSError:
        return ()

    observed_at = time.time() if now is None else float(now)
    fresh: list[Path] = []
    for path in candidates:
        try:
            if not path.is_file():
                continue
            age = observed_at - path.stat().st_mtime
        except OSError:
            continue
        if age <= max_age_sec:
            fresh.append(path)
    return tuple(sorted(fresh, key=lambda item: item.name.casefold()))


def require_live_engine(
    server_root: str | os.PathLike[str],
    *,
    max_age_sec: float = ENGINE_HEARTBEAT_MAX_AGE_SECONDS,
) -> tuple[Path, ...]:
    """Return fresh Engine heartbeats or raise :class:`EngineUnavailableError`."""

    heartbeats = discover_fresh_engine_heartbeats(
        server_root, max_age_sec=max_age_sec
    )
    if heartbeats:
        return heartbeats
    raise EngineUnavailableError(ENGINE_UNAVAILABLE_MESSAGE)
