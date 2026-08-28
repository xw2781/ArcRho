"""Client of the ResQ reserving-class synchronization queue served by ArcRho Bridge.

ResQ automation exists only where ResQ is installed, which is usually not the
machine ArcRho runs on. The Sync and Export macros therefore own no ResQ
session: each publishes a logical request to this shared Bridge queue and a
ResQ-connected Bridge worker runs the canonical session
(``resq_migration.sync_session``) on its behalf. This module is the one client
of that queue -- building, publishing, and waiting on a request -- so the two
macros cannot drift apart in how they talk to the Bridge.

The queue serves three phases:

``preview``
    Compares both sides and returns the review rows, each carrying the
    signature of the observation it was drawn from.
``apply``
    Receives the accepted rows *with those signatures* and writes only when
    every one of them still matches a freshly observed plan.
``export``
    Pushes the whole reserving class from ArcRho into ResQ in ArcRho's
    dependency order, with no review and no signature.

The constants below are pinned to
``server-components/src/arcrho_bridge/resq_reserving_class_sync_contract.json``
and, for the shared worker/status facts that contract deliberately does not
restate, to ``resq_reserving_class_import_contract.json``. A macro cannot
import the Bridge, so a test asserts this adapter still matches both files.
The worker facts and the liveness rule come from ``arcrho_api.bridge_liveness``,
which the import macros and the app server's hosted read share.

Inside the ArcRho app neither half of the exchange touches the share: the
request is published through the ``resq_sync_request_publish`` hosted
mutation, which runs ``publish_sync_request`` on the server host, and every
poll is the hosted Bridge-liveness look, which carries the status file. Both
run on the mapped drive only where the app server cannot be imported at all,
which is a script outside the app, never a Client PC inside it.
"""

from __future__ import annotations

import getpass
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping

from .bridge_liveness import (  # noqa: F401 -- the worker facts are re-exported for the contract test
    BRIDGE_SILENCE_LIMIT_SEC,
    BRIDGE_WORKER_DIR,
    BRIDGE_WORKER_MAX_AGE_SEC,
    BRIDGE_WORKER_ROLE,
    LIVENESS_READ_KIND,
    QUEUE_STATUS_DIRS,
    BridgeSilenceTracker,
    await_bridge_signal,
    live_worker_names,
    observe_bridge_liveness,
)


REQUEST_FUNCTION = "SyncResQReservingClass"
# Version 2: the preview carries the reserving class's one direction and every
# row's action follows it. Version 3: the export phase pushes the whole class
# from ArcRho without a review. A Bridge still on an older version refuses the
# request rather than answering with a shape the macro would misread.
CONTRACT_VERSION = 3
QUEUE_NAME = "sync"
STATUS_RELATIVE_DIR = QUEUE_STATUS_DIRS[QUEUE_NAME]
REQUEST_RELATIVE_DIR = STATUS_RELATIVE_DIR.with_name("requests")
REQUIRED_REQUEST_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Path",
    "UserName",
    "Phase",
)
PHASE_PREVIEW = "preview"
PHASE_APPLY = "apply"
PHASE_EXPORT = "export"
ALLOWED_PHASES = frozenset({PHASE_PREVIEW, PHASE_APPLY, PHASE_EXPORT})
SELECTION_FIELD = "SelectedRows"
SELECTION_ROW_FIELDS = ("Id", "Signature")
FORBIDDEN_PATH_FIELDS = ("StatusPath", "DataPath", "TargetPath", "ServerRoot")
STATUS_VALUES = frozenset({"processing", "success", "error"})

# A preview only reads; an apply or an export can rewrite a whole reserving
# class, so those are given the same hour a queued ResQ import gets.
PREVIEW_TIMEOUT_SEC = 30.0 * 60.0
WRITE_TIMEOUT_SEC = 60.0 * 60.0
POLL_INTERVAL_SEC = 1.0
REQUEST_CLAIM_TIMEOUT_SEC = 30.0

_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


class BridgeUnavailableError(RuntimeError):
    """Raised before publication when no ResQ-connected Bridge worker is live."""


class BridgeRequestError(RuntimeError):
    """Raised when a published Bridge request cannot complete successfully."""

    def __init__(self, message: str, *, status: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status or {}


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _logical_project_name(value: object) -> str:
    name = str(value or "").strip()
    if (
        not name
        or name in {".", ".."}
        or any(character in name for character in _INVALID_PROJECT_NAME_CHARS)
    ):
        raise ValueError("Project name must be a single logical project identifier.")
    return name


def _logical_rc_path(value: object) -> str:
    normalized = str(value or "").strip().replace("/", "\\")
    segments = [part.strip() for part in normalized.split("\\")]
    if (
        not normalized
        or normalized.startswith("\\")
        or ":" in normalized
        or "\x00" in normalized
        or any(part in {"", ".", ".."} for part in segments)
    ):
        raise ValueError("Reserving-class path must be a relative logical ArcRho path.")
    return normalized


def _user_name() -> str:
    try:
        return str(getpass.getuser() or "unknown").strip() or "unknown"
    except Exception:
        return "unknown"


def _observe(server_root: object, request_id: str = "") -> dict[str, Any] | None:
    """One liveness look; a look that fails is a silent look, not a verdict."""

    try:
        return observe_bridge_liveness(server_root, queue=QUEUE_NAME, request_id=request_id)
    except Exception:
        return None


def _request_status(observation: object) -> dict[str, Any] | None:
    request = observation.get("request") if isinstance(observation, dict) else None
    status = request.get("status") if isinstance(request, dict) else None
    return status if isinstance(status, dict) else None


def require_live_bridge_workers(server_root: object, *, sleep=time.sleep) -> tuple[str, ...]:
    """Names of the live workers, after waiting out a silence shorter than the limit."""

    observation, tracker = await_bridge_signal(
        lambda: _observe(server_root),
        limit_sec=BRIDGE_SILENCE_LIMIT_SEC,
        poll_interval_sec=POLL_INTERVAL_SEC,
        sleep=sleep,
    )
    workers = live_worker_names(observation)
    if workers:
        return workers
    raise BridgeUnavailableError(
        "No active ArcRho Bridge worker was found, so ResQ cannot be reached from "
        "this computer. Start ArcRho on a machine where ResQ is running, then "
        f"try again.\n{tracker.describe()}. "
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{Path(server_root) / BRIDGE_WORKER_DIR}]."
    )


def request_paths(server_root: object, request_id: str) -> tuple[Path, Path]:
    """The request file and the status file of one request under a server root."""

    root = Path(server_root)
    return (
        root / REQUEST_RELATIVE_DIR / f"{request_id}.json",
        root / STATUS_RELATIVE_DIR / f"{request_id}.json",
    )


def create_sync_request(
    *,
    project_name: object,
    rc_path: object,
    phase: str,
    selected_rows: list[Mapping[str, Any]] | None = None,
    request_id: str | None = None,
    user_name: str = "",
) -> tuple[str, dict[str, Any]]:
    """Build the location-independent payload consumed by ArcRho Bridge.

    ``user_name`` is the person the request is for; the hosted publish passes
    the identity it acts under, and a direct caller leaves it to the process.
    """

    identifier = str(request_id or uuid.uuid4().hex).strip()
    if not identifier:
        raise ValueError("Request ID is required.")
    normalized_phase = str(phase or "").strip().casefold()
    if normalized_phase not in ALLOWED_PHASES:
        raise ValueError("Phase must be one of: " + ", ".join(sorted(ALLOWED_PHASES)) + ".")
    payload: dict[str, Any] = {
        "Function": REQUEST_FUNCTION,
        "ContractVersion": CONTRACT_VERSION,
        "RequestId": identifier,
        "ProjectName": _logical_project_name(project_name),
        "Path": _logical_rc_path(rc_path),
        "UserName": str(user_name or "").strip() or _user_name(),
        "Phase": normalized_phase,
    }
    if normalized_phase == PHASE_APPLY:
        payload[SELECTION_FIELD] = _selection_payload(selected_rows)
    elif selected_rows:
        raise ValueError(f"A {normalized_phase} request must not carry a selection.")
    return identifier, payload


def _selection_payload(selected_rows: list[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Echo the reviewed rows back exactly as the preview reported them.

    The signature is the Bridge's own observation, not something the client
    recomputes; sending it back unchanged is what lets the apply phase prove
    nothing moved while the review table was open.
    """

    rows: list[dict[str, Any]] = []
    for row in selected_rows or []:
        if not isinstance(row, Mapping):
            continue
        row_id = str(row.get("id") or "").strip()
        signature = row.get("signature")
        if not row_id or not isinstance(signature, Mapping):
            raise ValueError(
                "The ArcRho Bridge preview did not report a signature for every selected "
                "row. Compare the reserving class again."
            )
        rows.append({"Id": row_id, "Signature": dict(signature), "Name": str(row.get("name") or "")})
    if not rows:
        raise ValueError("At least one reviewed row is required to apply a synchronization.")
    return rows


def publish_sync_request(
    *,
    server_root: object,
    request_id: str,
    payload: dict[str, Any],
) -> Path:
    """Atomically write one request file under ``server_root``.

    This is the on-disk write itself. Inside the app it runs on the server
    host through the ``resq_sync_request_publish`` hosted mutation; see
    ``submit_sync_request`` for the transport choice.
    """

    request_path, _ = request_paths(server_root, request_id)
    temp_path = request_path.with_name(f".{request_id}.tmp")
    try:
        request_path.parent.mkdir(parents=True, exist_ok=True)
        with temp_path.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
        os.replace(temp_path, request_path)
    except Exception as exc:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise BridgeRequestError(
            f"Could not publish ArcRho Bridge request [{request_id}]: {exc}"
        ) from exc
    return request_path


def _progress_tone(status: object) -> str:
    normalized = str(status or "").strip().casefold()
    if normalized in {"error", "failed", "fail"}:
        return "error"
    if normalized in {"warning", "warn", "skipped"}:
        return "warning"
    if normalized in {"success", "complete", "completed"}:
        return "success"
    return ""


def _update_progress_from_status(progress, status: Mapping[str, Any], fallback_label: str) -> None:
    if progress is None:
        return
    progress_payload = status.get("progress")
    detail = progress_payload if isinstance(progress_payload, Mapping) else {}
    state = str(status.get("status") or "").strip().casefold()
    label = str(detail.get("message") or detail.get("label") or status.get("message") or "").strip()
    if not label:
        label = fallback_label
    try:
        progress.update(
            label=label,
            detail=label,
            total=_safe_int(detail.get("total"), getattr(progress, "total", 0)),
            completed=_safe_int(detail.get("completed"), getattr(progress, "completed", 0)),
            tone=_progress_tone(detail.get("status") or state),
        )
    except Exception:
        pass


def wait_for_sync_result(
    *,
    server_root: object,
    request_id: str,
    timeout_sec: float,
    poll_interval_sec: float = POLL_INTERVAL_SEC,
    claim_timeout_sec: float = REQUEST_CLAIM_TIMEOUT_SEC,
    progress=None,
    progress_label: str = "ArcRho Bridge is working with ResQ",
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Poll the request's status until a terminal result arrives.

    Every poll is one Bridge-liveness look that also carries the status file,
    taken on the server host inside the app, so the worker is judged from the
    same observation the result comes from. ``on_poll`` runs before every
    look, which is where a macro reports its activity and checks whether the
    person cancelled it. Silence past the limit abandons the wait; it does not
    prove the run stopped.
    """

    if timeout_sec <= 0 or poll_interval_sec <= 0 or claim_timeout_sec <= 0:
        raise ValueError("Timeout, polling interval, and claim timeout must be positive.")
    _, status_path = request_paths(server_root, request_id)
    deadline = time.monotonic() + float(timeout_sec)
    claim_deadline = time.monotonic() + min(float(claim_timeout_sec), float(timeout_sec))
    tracker = BridgeSilenceTracker(limit_sec=BRIDGE_SILENCE_LIMIT_SEC)

    while True:
        if on_poll is not None:
            on_poll()
        observation = _observe(server_root, request_id)
        status = _request_status(observation)
        if status is not None:
            reported_id = str(status.get("request_id") or status.get("RequestId") or "").strip()
            if reported_id != request_id:
                raise BridgeRequestError(
                    "ArcRho Bridge returned a status for a different or missing request ID at "
                    f"[{status_path}]."
                )
            version = status.get("contract_version")
            if isinstance(version, bool) or version != CONTRACT_VERSION:
                raise BridgeRequestError(
                    f"ArcRho Bridge returned unsupported status contract version [{version!r}]."
                )
            _update_progress_from_status(progress, status, progress_label)
            state = str(status.get("status") or "").strip().casefold()
            if state == "success":
                return status
            if state == "error":
                detail = str(status.get("message") or "unknown ArcRho Bridge error").strip()
                raise BridgeRequestError(
                    f"ArcRho Bridge request [{request_id}] failed: {detail}",
                    status=status,
                )
            if state and state not in STATUS_VALUES:
                raise BridgeRequestError(
                    f"ArcRho Bridge request [{request_id}] returned unsupported status [{state}]."
                )
        elif time.monotonic() > claim_deadline:
            raise BridgeRequestError(
                f"No ArcRho Bridge worker claimed request [{request_id}] within "
                f"{claim_timeout_sec:g} seconds. Confirm ResQ is running on a machine with "
                "ArcRho open."
            )
        if not tracker.record(observation) and tracker.exceeded:
            raise BridgeUnavailableError(
                f"ArcRho Bridge request [{request_id}] was abandoned: {tracker.describe()}. "
                "Whether the run finished is unknown; if the Bridge was only slow it may "
                f"still complete. Check [{status_path}] before running this macro again."
            )
        if time.monotonic() > deadline:
            raise BridgeRequestError(
                f"ArcRho Bridge request [{request_id}] did not finish within "
                f"{timeout_sec:g} seconds."
            )
        time.sleep(poll_interval_sec)


PUBLISH_MUTATION_KIND = "resq_sync_request_publish"


def submit_sync_request(
    *,
    server_root: object,
    project_name: str,
    rc_path: str,
    phase: str,
    selected_rows: list[Mapping[str, Any]] | None = None,
) -> str:
    """Publish one request and return its id, writing on the server host when the app can.

    The payload is built here first so a bad project name, path, phase, or
    selection is refused before anything is sent. Inside the app the write
    then goes through the hosted mutation, whose local fallback is the same
    on-disk publish; outside the app there is no Gateway client at all, so the
    file is written directly.
    """

    request_id, payload = create_sync_request(
        project_name=project_name,
        rc_path=rc_path,
        phase=phase,
        selected_rows=selected_rows,
    )
    kwargs: dict[str, Any] = {
        "project_name": payload["ProjectName"],
        "reserving_class": payload["Path"],
        "request_id": request_id,
        "phase": payload["Phase"],
    }
    if selected_rows:
        kwargs["selected_rows"] = [dict(row) for row in selected_rows]
    try:
        from app_server.services import resq_sync_queue_service, workspace_mutation_client
    except ImportError:
        publish_sync_request(server_root=server_root, request_id=request_id, payload=payload)
        return request_id
    try:
        workspace_mutation_client.run_workspace_mutation(
            PUBLISH_MUTATION_KIND,
            kwargs,
            local=lambda: resq_sync_queue_service.publish_resq_sync_request(**kwargs),
        )
    except BridgeRequestError:
        raise
    except Exception as exc:
        detail = getattr(exc, "detail", None) or exc
        raise BridgeRequestError(
            f"Could not publish ArcRho Bridge request [{request_id}]: {detail}"
        ) from exc
    return request_id


def run_bridge_phase(
    *,
    server_root: object,
    project_name: str,
    rc_path: str,
    phase: str,
    selected_rows: list[Mapping[str, Any]] | None = None,
    timeout_sec: float,
    progress=None,
    progress_label: str,
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Publish one queue phase and return the Bridge's result payload."""

    require_live_bridge_workers(server_root)
    request_id = submit_sync_request(
        server_root=server_root,
        project_name=project_name,
        rc_path=rc_path,
        phase=phase,
        selected_rows=selected_rows,
    )
    status = wait_for_sync_result(
        server_root=server_root,
        request_id=request_id,
        timeout_sec=timeout_sec,
        progress=progress,
        progress_label=progress_label,
        on_poll=on_poll,
    )
    result = status.get("result")
    if not isinstance(result, Mapping):
        raise BridgeRequestError(
            f"ArcRho Bridge reported success for [{request_id}] without a result payload.",
            status=dict(status),
        )
    return dict(result)
