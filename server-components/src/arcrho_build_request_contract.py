"""Canonical request, payload, status, and heartbeat contract for remote
ArcRho component builds.

A component deploy copies a freshly frozen PyInstaller folder into
``<workspace>\\apps``. Run from a client machine that reaches the workspace as a
network share, that copy is the whole cost of a deploy: measured on 2026-08-17,
reads from the share ran at 50 MB/s while the deploy's writes ran at 0.18 MB/s,
turning a sub-minute build into a six-minute deploy. Building on the machine
that owns the disk removes the transfer entirely, so a client asks for a build
instead of performing one.

The queue is a folder under ``requests`` — the same shape as dependent
propagation and project duplication — because the workspace share is the one
channel every client already has, and it keeps working when the Gateway is
down.

This module owns the folder layout, the request shape, the source-mode rules,
the status shape, and the listener heartbeat preflight. It deliberately holds
no knowledge of *which* components exist: ``utils.DEPLOYED_COMPONENT_ROLES``
owns that list, and callers pass it in as ``known_roles`` so the two cannot
drift.

Request, payload, status, log, and lock files are transient runtime files, so
they are outside the persisted ArcRho JSON text-format rule.

Security note: anyone who can write a request into this queue can have the
listener build and deploy repository code on the server. The queue is therefore
only as trustworthy as the workspace share's ACLs, and the listener enforces
its own allowlist on top (see ``validate_build_request``'s ``allowed_users``).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

# ``write_json_atomic`` and the request-id token rule are already owned by the
# project-duplication contract. This module only ever runs from a repository
# clone (it is build tooling, never frozen into a component), so it can import
# the canonical implementations rather than restate them.
_PYTHON_API_SRC = Path(__file__).resolve().parents[2] / "python-api" / "src"
if str(_PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(_PYTHON_API_SRC))

from arcrho_project_duplication_contract import (  # noqa: E402
    ProjectDuplicationContractError as _CanonicalContractError,
    validate_request_id as _canonical_validate_request_id,
    write_json_atomic,
)


BUILD_REQUEST_FUNCTION = "ArcRhoBuildAndDeploy"
BUILD_REQUEST_CONTRACT_VERSION = 1

BUILD_REQUEST_REQUIRED_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "Components",
    "SourceMode",
    "UserName",
)

# "working-tree" reproduces the client's current source, committed or not, by
# applying a patch onto a base commit the server can already resolve. It is the
# default because AGENTS.md requires a rebuild *before* a change is committed,
# so a ref-only protocol would be unusable at the one moment agents need it.
# "ref" builds a pushed ref with no patch, which is the reproducible form.
SOURCE_MODE_WORKING_TREE = "working-tree"
SOURCE_MODE_REF = "ref"
BUILD_SOURCE_MODES = (SOURCE_MODE_WORKING_TREE, SOURCE_MODE_REF)

BUILD_STATUS_VALUES = ("queued", "claimed", "building", "success", "error")
BUILD_TERMINAL_STATUS_VALUES = ("success", "error")
BUILD_COMPONENT_STATE_VALUES = ("pending", "building", "success", "error", "skipped")

# A build runs for minutes and holds its lease the whole time, so the stale
# window has to clear the slowest realistic build (venv creation plus
# PyInstaller) rather than the seconds-scale windows the data jobs use.
BUILD_LEASE_STALE_SECONDS = 1800.0
BUILD_LEASE_HEARTBEAT_SECONDS = 10.0

LISTENER_HEARTBEAT_SECONDS = 5.0
LISTENER_HEARTBEAT_MAX_AGE_SECONDS = 60.0
LISTENER_INSTANCE_DIR_NAME = "arcrho_build_listener"

LISTENER_UNAVAILABLE_MESSAGE = (
    "No ArcRho Build Listener is running on the ArcRho Server machine. "
    "Ask an administrator to run server-components\\build_manager.bat there and "
    "turn on \"Listen for build requests\"."
)

_COMMIT_RE = re.compile(r"(?i)\A[0-9a-f]{7,40}\Z")
_REF_RE = re.compile(r"\A[A-Za-z0-9._/@+-]{1,200}\Z")
_ROLE_RE = re.compile(r"\A[a-z][a-z0-9_]{0,31}\Z")
_USER_RE = re.compile(r"\A[^\x00-\x1f\\/:*?\"<>|]{1,64}\Z")


class BuildRequestContractError(ValueError):
    """Raised when a build request, payload, or status violates the contract."""


class BuildListenerUnavailable(RuntimeError):
    """Raised when no recently active build listener is reachable."""


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BuildRequestContractError(f"{field_name} is required.")
    return value.strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_request_id(user_name: str = "") -> str:
    """A queue-safe, sortable id that names its requester for operators."""

    stamp = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
    token = re.sub(r"[^A-Za-z0-9_-]", "-", str(user_name or "anon").strip()) or "anon"
    return f"build-{stamp}-{token[:32]}"


def validate_request_id(value: Any) -> str:
    try:
        return _canonical_validate_request_id(value)
    except _CanonicalContractError as exc:
        raise BuildRequestContractError(str(exc)) from exc


def validate_components(
    value: Any,
    *,
    known_roles: Iterable[str] | None = None,
) -> list[str]:
    """Normalize the requested component roles, preserving request order.

    ``known_roles`` comes from ``utils.DEPLOYED_COMPONENT_ROLES``; passing it is
    what turns an unknown role into a rejected request rather than a build that
    silently does nothing.
    """

    if isinstance(value, str) or not isinstance(value, Iterable):
        raise BuildRequestContractError("Components must be a list of role names.")
    roles: list[str] = []
    for item in value:
        role = _required_text(item, "Components entry").lower()
        if not _ROLE_RE.fullmatch(role):
            raise BuildRequestContractError(f"Component role {role!r} is not a safe token.")
        if role not in roles:
            roles.append(role)
    if not roles:
        raise BuildRequestContractError("Components must name at least one component.")
    if known_roles is not None:
        known = {str(role).lower() for role in known_roles}
        unknown = [role for role in roles if role not in known]
        if unknown:
            raise BuildRequestContractError(
                f"Unknown component role(s): {', '.join(sorted(unknown))}. "
                f"Known roles: {', '.join(sorted(known))}."
            )
    return roles


def validate_source_mode(value: Any) -> str:
    mode = _required_text(value, "SourceMode").lower()
    if mode not in BUILD_SOURCE_MODES:
        raise BuildRequestContractError(
            f"SourceMode must be one of: {', '.join(BUILD_SOURCE_MODES)}."
        )
    return mode


def validate_commit(value: Any, field_name: str = "BaseCommit") -> str:
    commit = _required_text(value, field_name)
    if not _COMMIT_RE.fullmatch(commit):
        raise BuildRequestContractError(f"{field_name} must be a hexadecimal git commit id.")
    return commit


def validate_ref(value: Any, field_name: str = "Ref") -> str:
    ref = _required_text(value, field_name)
    if not _REF_RE.fullmatch(ref) or ".." in ref:
        raise BuildRequestContractError(f"{field_name} is not a safe git ref name.")
    return ref


def validate_user_name(value: Any, field_name: str = "UserName") -> str:
    user = _required_text(value, field_name)
    if not _USER_RE.fullmatch(user):
        raise BuildRequestContractError(f"{field_name} is not a safe user name.")
    return user


def build_build_request(
    *,
    request_id: Any,
    components: Any,
    source_mode: str = SOURCE_MODE_WORKING_TREE,
    base_commit: Any = "",
    ref: Any = "",
    payload_name: str = "",
    user_name: Any = "",
    machine: str = "",
    known_roles: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Assemble a request payload, validating it on the way out."""

    payload: dict[str, Any] = {
        "Function": BUILD_REQUEST_FUNCTION,
        "ContractVersion": BUILD_REQUEST_CONTRACT_VERSION,
        "RequestId": validate_request_id(request_id),
        "Components": validate_components(components, known_roles=known_roles),
        "SourceMode": validate_source_mode(source_mode),
        "BaseCommit": validate_commit(base_commit) if base_commit else "",
        "Ref": validate_ref(ref) if ref else "",
        "PayloadName": str(payload_name or ""),
        "UserName": validate_user_name(user_name),
        "Machine": str(machine or ""),
        "RequestedAt": _now_iso(),
    }
    return validate_build_request(payload, known_roles=known_roles)


def validate_build_request(
    payload: Any,
    *,
    known_roles: Iterable[str] | None = None,
    allowed_users: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Validate an incoming request and return its normalized form.

    ``allowed_users`` is the listener's allowlist. It is enforced here rather
    than in the listener so that the rule, its error text, and the request shape
    stay in one file.
    """

    if not isinstance(payload, Mapping):
        raise BuildRequestContractError("A build request must be a JSON object.")
    missing = [field for field in BUILD_REQUEST_REQUIRED_FIELDS if field not in payload]
    if missing:
        raise BuildRequestContractError(
            f"Build request is missing required field(s): {', '.join(missing)}."
        )
    if str(payload.get("Function")) != BUILD_REQUEST_FUNCTION:
        raise BuildRequestContractError(
            f"Function must be {BUILD_REQUEST_FUNCTION!r}."
        )
    try:
        contract_version = int(payload.get("ContractVersion"))
    except (TypeError, ValueError) as exc:
        raise BuildRequestContractError("ContractVersion must be an integer.") from exc
    if contract_version != BUILD_REQUEST_CONTRACT_VERSION:
        raise BuildRequestContractError(
            f"ContractVersion {contract_version} is not supported; this listener "
            f"speaks version {BUILD_REQUEST_CONTRACT_VERSION}."
        )

    source_mode = validate_source_mode(payload.get("SourceMode"))
    base_commit = payload.get("BaseCommit") or ""
    ref = payload.get("Ref") or ""
    if source_mode == SOURCE_MODE_WORKING_TREE:
        base_commit = validate_commit(base_commit)
        ref = validate_ref(ref) if ref else ""
    else:
        ref = validate_ref(ref)
        base_commit = validate_commit(base_commit) if base_commit else ""

    payload_name = str(payload.get("PayloadName") or "")
    if payload_name and Path(payload_name).name != payload_name:
        raise BuildRequestContractError("PayloadName must be a bare file name.")

    user_name = validate_user_name(payload.get("UserName"))
    if allowed_users is not None:
        allowed = {str(name).strip().casefold() for name in allowed_users if str(name).strip()}
        if allowed and user_name.casefold() not in allowed:
            raise BuildRequestContractError(
                f"User {user_name!r} is not allowed to request builds on this server."
            )

    return {
        "Function": BUILD_REQUEST_FUNCTION,
        "ContractVersion": BUILD_REQUEST_CONTRACT_VERSION,
        "RequestId": validate_request_id(payload.get("RequestId")),
        "Components": validate_components(payload.get("Components"), known_roles=known_roles),
        "SourceMode": source_mode,
        "BaseCommit": base_commit,
        "Ref": ref,
        "PayloadName": payload_name,
        "UserName": user_name,
        "Machine": str(payload.get("Machine") or ""),
        "RequestedAt": str(payload.get("RequestedAt") or ""),
    }


def _root_path(server_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(server_root)
    if not str(raw).strip():
        raise BuildRequestContractError("ArcRho Server root is required.")
    return Path(raw).expanduser()


def build_protocol_directory(server_root: str | os.PathLike[str]) -> Path:
    """The protocol root, a subfolder of ``requests`` so the orchestrator's
    loose-file cleanup never touches a queued build."""

    return _root_path(server_root) / "requests" / "builds"


def build_requests_directory(server_root: str | os.PathLike[str]) -> Path:
    return build_protocol_directory(server_root) / "requests"


def build_statuses_directory(server_root: str | os.PathLike[str]) -> Path:
    return build_protocol_directory(server_root) / "statuses"


def build_locks_directory(server_root: str | os.PathLike[str]) -> Path:
    return build_protocol_directory(server_root) / "locks"


def build_payloads_directory(server_root: str | os.PathLike[str]) -> Path:
    return build_protocol_directory(server_root) / "payloads"


def build_logs_directory(server_root: str | os.PathLike[str]) -> Path:
    return build_protocol_directory(server_root) / "logs"


def build_request_path(server_root: str | os.PathLike[str], request_id: Any) -> Path:
    return build_requests_directory(server_root) / f"{validate_request_id(request_id)}.json"


def build_status_path(server_root: str | os.PathLike[str], request_id: Any) -> Path:
    return build_statuses_directory(server_root) / f"{validate_request_id(request_id)}.json"


def build_lock_path(server_root: str | os.PathLike[str], request_id: Any) -> Path:
    return build_locks_directory(server_root) / f"{validate_request_id(request_id)}.lock"


def build_payload_path(server_root: str | os.PathLike[str], request_id: Any) -> Path:
    return build_payloads_directory(server_root) / f"{validate_request_id(request_id)}.zip"


def build_log_path(server_root: str | os.PathLike[str], request_id: Any) -> Path:
    return build_logs_directory(server_root) / f"{validate_request_id(request_id)}.log"


def ensure_build_protocol_directories(server_root: str | os.PathLike[str]) -> Path:
    """Create the queue folders; returns the protocol root."""

    protocol = build_protocol_directory(server_root)
    for directory in (
        build_requests_directory(server_root),
        build_statuses_directory(server_root),
        build_locks_directory(server_root),
        build_payloads_directory(server_root),
        build_logs_directory(server_root),
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return protocol


def build_component_state(
    role: str,
    state: str = "pending",
    *,
    message: str = "",
    exit_code: int | None = None,
) -> dict[str, Any]:
    normalized = str(state or "").strip().lower()
    if normalized not in BUILD_COMPONENT_STATE_VALUES:
        raise BuildRequestContractError(
            f"Component state must be one of: {', '.join(BUILD_COMPONENT_STATE_VALUES)}."
        )
    return {
        "role": str(role),
        "state": normalized,
        "message": str(message or ""),
        "exit_code": exit_code,
    }


def build_build_status(
    *,
    request_id: Any,
    status: str,
    message: str = "",
    components: Iterable[Mapping[str, Any]] | None = None,
    log_bytes: int = 0,
    listener: str = "",
    listener_commit: str = "",
    created_at: str = "",
) -> dict[str, Any]:
    normalized = str(status or "").strip().lower()
    if normalized not in BUILD_STATUS_VALUES:
        raise BuildRequestContractError(
            f"status must be one of: {', '.join(BUILD_STATUS_VALUES)}."
        )
    now = _now_iso()
    return {
        "Function": BUILD_REQUEST_FUNCTION,
        "ContractVersion": BUILD_REQUEST_CONTRACT_VERSION,
        "RequestId": validate_request_id(request_id),
        "status": normalized,
        "message": str(message or ""),
        "components": [dict(item) for item in (components or ())],
        "log_bytes": max(0, int(log_bytes or 0)),
        "listener": str(listener or ""),
        "listener_commit": str(listener_commit or ""),
        "created_at": str(created_at or now),
        "updated_at": now,
    }


def build_status_is_terminal(status: Any) -> bool:
    if isinstance(status, Mapping):
        status = status.get("status")
    return str(status or "").strip().lower() in BUILD_TERMINAL_STATUS_VALUES


def write_build_status(
    server_root: str | os.PathLike[str], status: Mapping[str, Any]
) -> Path:
    if not isinstance(status, Mapping):
        raise BuildRequestContractError("A build status must be a JSON object.")
    request_id = validate_request_id(status.get("RequestId"))
    return write_json_atomic(build_status_path(server_root, request_id), dict(status))


def read_build_status(
    server_root: str | os.PathLike[str], request_id: Any
) -> dict[str, Any] | None:
    """Read one status by exact path.

    Reading the known path rather than listing the folder matters over SMB: a
    client polling a terminal state through a directory listing can be served
    Windows' cached directory entries for up to ten seconds after the listener
    has already written the result.
    """

    path = build_status_path(server_root, request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def listener_instances_directory(server_root: str | os.PathLike[str]) -> Path:
    return _root_path(server_root) / "runtime" / "instances" / LISTENER_INSTANCE_DIR_NAME


def listener_heartbeat_path(
    server_root: str | os.PathLike[str], machine: str, user: str
) -> Path:
    token = datetime.now().strftime("%y%m%d-%H%M%S-%f")[:-3]
    safe_machine = re.sub(r"[^A-Za-z0-9_.-]", "-", str(machine or "unknown"))
    safe_user = re.sub(r"[^A-Za-z0-9_.-]", "-", str(user or "unknown"))
    return listener_instances_directory(server_root) / f"{safe_machine}@{safe_user}@{token}.json"


def discover_fresh_listener_heartbeats(
    server_root: str | os.PathLike[str],
    *,
    max_age_seconds: float = LISTENER_HEARTBEAT_MAX_AGE_SECONDS,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """Every listener heartbeat still inside the freshness window."""

    folder = listener_instances_directory(server_root)
    reference = time.time() if now is None else now
    fresh: list[dict[str, Any]] = []
    try:
        entries = sorted(folder.glob("*.json"))
    except OSError:
        return []
    for path in entries:
        try:
            age = max(0.0, reference - path.stat().st_mtime)
        except OSError:
            continue
        if age > max_age_seconds:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = {}
        if not isinstance(payload, Mapping):
            payload = {}
        fresh.append({"path": str(path), "age_seconds": age, **dict(payload)})
    return fresh


def require_live_listener(
    server_root: str | os.PathLike[str],
    *,
    max_age_seconds: float = LISTENER_HEARTBEAT_MAX_AGE_SECONDS,
) -> list[dict[str, Any]]:
    """Return the fresh listeners, or explain how to start one.

    This is the only preflight that asks a human for anything, so its message
    is the exact instruction an agent should relay.
    """

    fresh = discover_fresh_listener_heartbeats(
        server_root, max_age_seconds=max_age_seconds
    )
    if not fresh:
        raise BuildListenerUnavailable(LISTENER_UNAVAILABLE_MESSAGE)
    return fresh
