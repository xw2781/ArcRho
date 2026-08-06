"""Submit and poll Engine-hosted dependent-propagation jobs.

The client never runs the dependent cascade itself: every save flow calls
:func:`require_engine_available` before writing anything, writes the saved
object, then enqueues one propagation job through
:func:`enqueue_save_propagation`. ArcRho Engine executes the canonical walk on
the server host and publishes progress/terminal status that
:func:`get_dependent_propagation_status` validates for the UI poller.
"""

from __future__ import annotations

import getpass
import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from fastapi import HTTPException

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    ENGINE_UNAVAILABLE_MESSAGE,
    EngineUnavailableError,
    build_dependent_propagation_request,
    dependent_propagation_request_path,
    dependent_propagation_status_path,
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


def require_engine_available() -> None:
    """Refuse a save before anything is written when no live Engine exists."""

    try:
        require_live_engine(_workspace_server_root())
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error


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


def enqueue_marked_save_propagation(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    dataset_type: str = "",
) -> Dict[str, Any]:
    """Mark reachable downstream review-needed, then enqueue the Engine walk.

    The marking keeps statuses honest while the job runs; the Engine walk
    refreshes each tier and finalizes the statuses when it completes.
    """

    try:
        from app_server.services import dataset_sidecar_status_service

        dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
            project_name,
            reserving_class,
            [dataset_name, dataset_type],
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
