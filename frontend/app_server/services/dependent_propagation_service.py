"""Submit and poll Engine-hosted dependent-propagation jobs.

The client never runs the dependent cascade itself: every save flow calls
:func:`require_reserving_class_writable` before writing anything (live-Engine
heartbeat plus the reserving-class hold probe), writes the saved object, then
enqueues one propagation job through :func:`enqueue_save_propagation`. ArcRho
Engine executes the canonical walk on the server host and publishes
progress/terminal status that :func:`get_dependent_propagation_status`
validates for the UI poller; :func:`get_reserving_class_busy` exposes the hold
to UI pages that freeze their editing surface while a class is rewritten.
"""

from __future__ import annotations

import contextvars
import getpass
import json
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Sequence

from fastapi import HTTPException

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    ENGINE_UNAVAILABLE_MESSAGE,
    EngineUnavailableError,
    build_dependent_propagation_request,
    dependent_propagation_request_path,
    dependent_propagation_status_path,
    find_reserving_class_propagation_hold,
    require_live_engine,
    validate_dependent_propagation_status,
    validate_request_id,
    write_dependent_propagation_status,
    write_json_atomic,
)
from arcrho_project_duplication_contract import path_is_link_or_reparse

from app_server import config


def _workspace_server_root() -> Path:
    workspace = config.load_workspace_paths()
    server_root_value = str(workspace.get("workspace_root") or "").strip()
    if not server_root_value:
        raise HTTPException(500, "The ArcRho Server workspace is not configured.")
    server_root = Path(server_root_value).expanduser()
    if not server_root.is_absolute():
        raise HTTPException(500, "The ArcRho Server workspace root must be absolute.")
    try:
        root_available = server_root.is_dir()
    except OSError as error:
        raise HTTPException(
            500, "The ArcRho Server workspace root is inaccessible."
        ) from error
    if not root_available:
        raise HTTPException(500, "The ArcRho Server workspace root is unavailable.")
    _validate_protocol_paths(server_root)
    return server_root


def _validate_protocol_paths(server_root: Path) -> None:
    current = server_root
    for part in ("requests", "dependent_propagation"):
        current /= part
        _reject_linked_path(current)
    for leaf in ("requests", "statuses", "locks"):
        _reject_linked_path(current / leaf)


def _reject_linked_path(path: Path) -> None:
    try:
        unsafe = path_is_link_or_reparse(path)
    except OSError as error:
        raise HTTPException(
            500, "The dependent propagation protocol path is inaccessible."
        ) from error
    if unsafe:
        raise HTTPException(
            500, "The dependent propagation protocol path is unsafe."
        )


RESERVING_CLASS_BUSY_MESSAGE = (
    "Dependent updates are currently running for this reserving class. "
    "Please wait for them to finish, then save again."
)


def require_engine_available() -> None:
    """Refuse a save before anything is written when no live Engine exists."""

    try:
        require_live_engine(_workspace_server_root())
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error


# One orchestrated operation (the Excel workbook retarget) runs several
# canonical saves for one reserving class inside a single request; its first
# save's enqueued job would make the class read as busy and refuse the rest.
# Such an operation preflights the hold once at its entry and suspends the
# refusal for its nested saves; their jobs coalesce into one walk through the
# Engine's queued-request merge.
_hold_check_suspended: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "arcrho_reserving_class_hold_check_suspended", default=False
)


@contextmanager
def suspended_reserving_class_hold_check() -> Iterator[None]:
    """Skip the class-hold refusal for one operation's nested canonical saves.

    The caller must have preflighted :func:`require_reserving_class_writable`
    itself before entering; nested saves still preflight the live-Engine
    heartbeat.
    """

    token = _hold_check_suspended.set(True)
    try:
        yield
    finally:
        _hold_check_suspended.reset(token)


def require_reserving_class_writable(
    project_name: str, reserving_class: str
) -> None:
    """Refuse a save while a propagation walk or queued job owns the class.

    Runs the live-Engine preflight first (503), then the canonical hold probe
    (423). Every propagation-triggering save calls this before writing
    anything, so one user's dependent walk cannot race another user's edits
    inside the same reserving class; other reserving classes are unaffected.
    The probe's freshness windows guarantee a dead worker releases the hold by
    itself, and the Engine's queued-request merge stays the backstop for the
    saves a non-atomic filesystem check lets through together.
    """

    server_root = _workspace_server_root()
    try:
        require_live_engine(server_root)
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error
    if _hold_check_suspended.get():
        return
    try:
        hold = find_reserving_class_propagation_hold(
            server_root, project_name, reserving_class
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error
    if hold is not None:
        raise HTTPException(423, RESERVING_CLASS_BUSY_MESSAGE)


def get_reserving_class_busy(
    project_name: str, reserving_class: str
) -> Dict[str, Any]:
    """Report whether a propagation hold currently covers one reserving class.

    Read-only view of the same probe :func:`require_reserving_class_writable`
    enforces, for UI pages that freeze their editing surface while the class
    is being rewritten.
    """

    try:
        hold = find_reserving_class_propagation_hold(
            _workspace_server_root(), project_name, reserving_class
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error
    return {
        "ok": True,
        "busy": hold is not None,
        "reason": hold["reason"] if hold is not None else None,
    }


def submit_dependent_propagation_job(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
    *,
    request_id: str | None = None,
) -> Dict[str, Any]:
    """Publish one queued propagation request and return its job identity."""

    server_root = _workspace_server_root()
    try:
        require_live_engine(server_root)
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error

    try:
        request = build_dependent_propagation_request(
            request_id=request_id if request_id is not None else uuid.uuid4().hex,
            project_name=project_name,
            path=reserving_class,
            changed_roots=list(changed_roots),
            user_name=getpass.getuser(),
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error

    normalized_request_id = request["RequestId"]
    request_path = dependent_propagation_request_path(
        server_root, normalized_request_id
    )
    published_status_path: Path | None = None
    try:
        published_status_path = write_dependent_propagation_status(
            server_root,
            normalized_request_id,
            "queued",
            progress={
                "stage": "queued",
                "completed": 0,
                "total": 0,
                "label": "Queued for ArcRho Engine",
            },
        )
        write_json_atomic(request_path, request)
    except PermissionError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            423,
            "The dependent propagation request queue is locked or inaccessible.",
        ) from error
    except OSError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            500, "Failed to submit the dependent propagation job."
        ) from error

    return {"ok": True, "job_id": normalized_request_id, "status": "queued"}


def _remove_unpublished_files(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def enqueue_save_propagation(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Submit a save's propagation job and shape the response payload.

    A save that already committed must never turn into an HTTP error because
    the queue write failed afterwards, so submission problems are reported in
    the returned payload instead of raised.
    """

    try:
        submitted = submit_dependent_propagation_job(
            project_name, reserving_class, changed_roots
        )
    except HTTPException as error:
        return {
            "ok": False,
            "status": "error",
            "message": str(error.detail),
        }
    return {
        "ok": True,
        "job_id": submitted["job_id"],
        "status": submitted["status"],
    }


def changed_root(dataset_name: str, dataset_type: str = "") -> Dict[str, str]:
    return {
        "dataset_name": str(dataset_name or "").strip(),
        "dataset_type": str(dataset_type or "").strip(),
    }


_inline_engine_propagation: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "arcrho_inline_engine_propagation", default=False
)


@contextmanager
def inline_engine_propagation() -> Iterator[None]:
    """Run save-triggered propagation inline instead of enqueueing a job.

    The Engine's hosted-save executor sets this around the canonical service
    save: the process already runs on the server host under the
    reserving-class lease, so the walk runs synchronously on local disk and
    the save response carries the finished outcome (with the refreshed
    dataset names) instead of a job id to poll.
    """

    token = _inline_engine_propagation.set(True)
    try:
        yield
    finally:
        _inline_engine_propagation.reset(token)


def _collect_refreshed_dataset_names(walk_result: Mapping[str, Any]) -> List[str]:
    names: List[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        text = str(value or "").strip()
        key = text.casefold()
        if text and key not in seen:
            seen.add(key)
            names.append(text)

    for item in walk_result.get("updated") or []:
        if isinstance(item, Mapping):
            add(item.get("dataset_type_name") or item.get("dataset_name"))
    for bucket in (
        "dfm_updates",
        "result_selection_updates",
        "bornhuetter_ferguson_updates",
        "cape_cod_updates",
        "bootstrap_updates",
    ):
        updates = walk_result.get(bucket)
        if not isinstance(updates, Mapping):
            continue
        for item in updates.get("updated") or []:
            if isinstance(item, Mapping):
                add(item.get("dataset_name") or item.get("method_name"))
    return names


def _run_inline_save_propagation(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Run the canonical walk synchronously and shape a completed payload.

    Mirrors ``enqueue_save_propagation``'s promise: a save that already
    committed must never turn into an HTTP error because the follow-up walk
    failed, so walk trouble is reported in the payload (`ok: False`) and the
    dataset table's review-needed flags stay the failure surface.
    """

    roots = [root for root in changed_roots if str(root.get("dataset_name") or "").strip()]
    if not roots:
        return unchanged_propagation()
    first, *rest = roots
    try:
        from app_server.services import calculated_dataset_service

        result = calculated_dataset_service.recalculate_dependents(
            project_name,
            reserving_class,
            first.get("dataset_name"),
            first.get("dataset_type"),
            additional_roots=[
                (root.get("dataset_name"), root.get("dataset_type")) for root in rest
            ],
            rebuild_index=True,
        )
    except Exception as exc:
        return {
            "ok": False,
            "status": "completed",
            "message": str(exc),
            "refreshed_datasets": [],
        }
    return {
        "ok": bool(result.get("ok")),
        "status": "completed",
        "refreshed_datasets": _collect_refreshed_dataset_names(result),
    }


def enqueue_marked_save_propagation(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    dataset_type: str = "",
) -> Dict[str, Any]:
    """Mark the first dependent method tier, then enqueue the Engine walk.

    Only the nearest reachable methods are marked here (a handful of SMB
    round trips from a Client PC); the Engine job marks the full reachable
    closure as its first claimed step, where the walk runs on local disk. If
    the job is never claimed, the first method tier stays visibly flagged
    and the next save or refresh re-enqueues the walk that restores the
    deeper tiers.

    Inside an Engine-hosted save (`inline_engine_propagation`) the walk runs
    synchronously instead — the walk itself finalizes every status, so the
    upfront marking is skipped entirely.
    """

    if _inline_engine_propagation.get():
        return _run_inline_save_propagation(
            project_name,
            reserving_class,
            [changed_root(dataset_name, dataset_type)],
        )

    try:
        from app_server.services import dataset_sidecar_status_service

        dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
            project_name,
            reserving_class,
            [dataset_name, dataset_type],
            direct_only=True,
        )
    except Exception as exc:
        return {"ok": False, "status": "error", "message": str(exc)}
    return enqueue_save_propagation(
        project_name,
        reserving_class,
        [changed_root(dataset_name, dataset_type)],
    )


def unchanged_propagation() -> Dict[str, Any]:
    """The canonical no-op-save payload: nothing changed, no job enqueued."""

    return {"ok": True, "status": "unchanged"}


def get_dependent_propagation_status(request_id: str) -> Dict[str, Any]:
    try:
        normalized_request_id = validate_request_id(request_id)
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error

    status_path = dependent_propagation_status_path(
        _workspace_server_root(), normalized_request_id
    )
    try:
        with status_path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except FileNotFoundError as error:
        raise HTTPException(
            404, "Dependent propagation job was not found."
        ) from error
    except PermissionError as error:
        raise HTTPException(
            423, "Dependent propagation status is locked or inaccessible."
        ) from error
    except json.JSONDecodeError as error:
        raise HTTPException(
            502,
            "ArcRho Engine published an invalid dependent propagation status.",
        ) from error
    except OSError as error:
        raise HTTPException(
            500, "Failed to read the dependent propagation status."
        ) from error

    try:
        status = validate_dependent_propagation_status(
            payload, expected_request_id=normalized_request_id
        )
    except DependentPropagationContractError as error:
        raise HTTPException(
            502,
            "ArcRho Engine published an invalid dependent propagation status.",
        ) from error

    return {"ok": True, "job_id": normalized_request_id, **status}
