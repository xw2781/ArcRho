"""Client-side submission and status for Engine-hosted dataset-type changes.

Changing a project's dataset-type table used to run in whatever process the
user clicked in. On a Client PC that meant writing the table over the mapped
drive and then walking every reserving class's sidecars to re-derive their
dependency graphs -- one round trip per sidecar, inside the save request. On a
project with a few dozen classes that request did not come back for minutes,
and the auto-saving grid that issued it had no way to tell a slow save from a
lost one.

This module replaces that with a durable job. The request is published for
ArcRho Engine, which claims the *project-scope* lease, confirms the plan,
writes the table, narrows the lease to the reserving classes the plan named,
and rebuilds those on local disk while the client only polls the status.
Every other class of the project is writable again as soon as the table is
the new one.

The plan itself is built here first, through the hosted read when a Gateway
is up, so the reserving classes it names are on screen before anything is
submitted.

Submission is idempotent by ``request_id``: the client generates the id before
its first POST and reuses it on every retry, so a response lost in flight can
never apply the same change twice.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List

from fastapi import HTTPException

from arcrho_dataset_types_change_contract import (
    DatasetTypesChangeContractError,
    build_dataset_types_change_request,
    dataset_types_change_request_path,
    dataset_types_change_status_path,
    find_queued_dataset_types_change,
    validate_dataset_types_change_status,
    validate_project_name,
    validate_request_id,
    write_dataset_types_change_status,
)
from arcrho_project_duplication_contract import (
    path_is_link_or_reparse,
    write_json_atomic,
)
from arcrho_dependent_propagation_contract import (
    find_project_scope_propagation_hold,
)
from arcrho_source_refresh_contract import find_source_refresh_hold

from app_server.services import (
    dataset_types_plan_service,
    dependent_propagation_service,
    user_identity_service,
    workspace_read_client,
)


DATASET_TYPES_CHANGE_BUSY_MESSAGE = (
    "A dataset type change is already running for this project. "
    "Please wait for it to finish before starting another."
)
SOURCE_REFRESH_RUNNING_MESSAGE = (
    "A source table refresh is running for this project. "
    "Please wait for it to finish, then apply the dataset type change again."
)


def _validate_protocol_paths(server_root: Path) -> None:
    current = server_root
    checks = []
    for part in ("requests", "dataset_types_change"):
        current /= part
        checks.append(current)
    for leaf in ("requests", "statuses"):
        checks.append(current / leaf)
    for path in checks:
        try:
            unsafe = path_is_link_or_reparse(path)
        except OSError as error:
            raise HTTPException(
                500, "The dataset type change protocol path is inaccessible."
            ) from error
        if unsafe:
            raise HTTPException(500, "The dataset type change protocol path is unsafe.")


def _validated_project(project_name: str) -> str:
    try:
        return validate_project_name(project_name)
    except DatasetTypesChangeContractError as error:
        raise HTTPException(400, str(error)) from error


def _read_status(server_root: Path, request_id: str) -> Dict[str, Any] | None:
    status_path = dataset_types_change_status_path(server_root, request_id)
    try:
        with status_path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except FileNotFoundError:
        return None
    except PermissionError as error:
        raise HTTPException(
            423, "Dataset type change status is locked or inaccessible."
        ) from error
    except json.JSONDecodeError as error:
        raise HTTPException(
            502, "ArcRho Engine published an invalid dataset type change status."
        ) from error
    except OSError as error:
        raise HTTPException(
            500, "Failed to read the dataset type change status."
        ) from error
    try:
        return validate_dataset_types_change_status(
            payload, expected_request_id=request_id
        )
    except DatasetTypesChangeContractError as error:
        raise HTTPException(
            502, "ArcRho Engine published an invalid dataset type change status."
        ) from error


def plan_dataset_types_change(
    project_name: str,
    rows: List[List[Any]],
    renames: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Build the plan the confirmation dialog shows, hosted when possible.

    The planner reads one index per reserving class, which from a Client PC
    is one round trip each over the mapped drive; the Gateway answers from
    local disk.
    """

    name = _validated_project(project_name)
    kwargs = {"project_name": name, "rows": rows, "renames": renames}
    return workspace_read_client.run_workspace_read(
        "dataset_types_change_plan",
        kwargs,
        local=lambda: dataset_types_plan_service.plan_dataset_types_change_read(
            name, rows, renames
        ),
    )


def changed_types_for_submission(
    project_name: str,
    rows: List[List[Any]],
    renames: List[Dict[str, str]],
) -> List[str]:
    """The recalculation roots of a confirmed change, from the table alone.

    The confirming POST carries rows the planner already rewrote, so this
    re-derives only the type-level answer and never scans a class; the Engine
    recomputes the whole plan before it writes anything.
    """

    from app_server.services import calculated_dataset_service, dataset_types_service

    name = _validated_project(project_name)
    previous_rows = dataset_types_service.read_persisted_rows(name)
    normalized = dataset_types_service.normalize_submitted_rows(rows)
    mapping = dataset_types_plan_service.rename_map(previous_rows, normalized, renames)
    return calculated_dataset_service.changed_formula_dataset_type_names(
        dataset_types_plan_service.previous_rows_as_renamed(previous_rows, mapping),
        dataset_types_service.resolve_persisted_rows(name, normalized),
    )


def submit_dataset_types_change_job(
    project_name: str,
    rows: List[List[Any]],
    renames: List[Dict[str, str]],
    changed_types: List[str],
    plan: Dict[str, Any],
    request_id: str | None = None,
) -> Dict[str, Any]:
    """Publish one queued dataset-type change and return its job identity.

    Preflights the whole project before anything is published: a live Engine,
    no project-wide job already running, and no reserving class still being
    walked. Re-submitting an id that already has a published status returns
    that job untouched, so a retry after a lost response never applies the
    change twice.
    """

    name = _validated_project(project_name)
    # The project-scope preflight owns the live-Engine check and both hold
    # probes, and hands back the validated workspace root.
    server_root = dependent_propagation_service.require_project_scope_writable(name)
    _validate_protocol_paths(server_root)

    try:
        request = build_dataset_types_change_request(
            request_id=request_id if request_id else uuid.uuid4().hex,
            project_name=name,
            rows=rows,
            renames=renames,
            changed_types=changed_types,
            plan=plan,
            # The Engine writes the table and re-saves sidecars as this user,
            # so every stamp names the person who changed it.
            user_name=user_identity_service.get_windows_login_name(),
        )
    except DatasetTypesChangeContractError as error:
        raise HTTPException(400, str(error)) from error

    normalized_request_id = request["RequestId"]
    existing = _read_status(server_root, normalized_request_id)
    if existing is not None:
        return {
            "ok": True,
            "job_id": normalized_request_id,
            "status": existing["status"],
            "resumed": True,
        }

    if find_source_refresh_hold(server_root, name) is not None:
        raise HTTPException(423, SOURCE_REFRESH_RUNNING_MESSAGE)
    if find_queued_dataset_types_change(server_root, name) is not None:
        raise HTTPException(423, DATASET_TYPES_CHANGE_BUSY_MESSAGE)

    request_path = dataset_types_change_request_path(server_root, normalized_request_id)
    published_status_path: Path | None = None
    try:
        published_status_path = write_dataset_types_change_status(
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
            423, "The dataset type change request queue is locked or inaccessible."
        ) from error
    except OSError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            500, "Failed to submit the dataset type change job."
        ) from error

    return {
        "ok": True,
        "job_id": normalized_request_id,
        "status": "queued",
        "resumed": False,
    }


def _remove_unpublished_files(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def get_dataset_types_change_status(
    project_name: str,
    job_id: str = "",
) -> Dict[str, Any]:
    """One job's status plus whether the project is still held.

    Both answers come from the same visit because a poller needs them
    together: a job whose status has not appeared yet is indistinguishable
    from a lost one unless the caller can also see that the project is busy.
    """

    name = _validated_project(project_name)
    # One validated root answers both halves. A poller visits this route every
    # few hundred milliseconds for the life of the job, so resolving the
    # workspace twice per visit would double its cost on a mapped drive.
    server_root = dependent_propagation_service.workspace_server_root()
    hold = find_project_scope_propagation_hold(server_root, name)
    response: Dict[str, Any] = {
        "ok": True,
        "project_name": name,
        "job_id": "",
        "found": False,
        "busy": hold is not None,
        "busy_reason": hold["reason"] if hold is not None else "",
    }
    if not str(job_id or "").strip():
        return response

    try:
        normalized_job_id = validate_request_id(job_id)
    except DatasetTypesChangeContractError as error:
        raise HTTPException(400, str(error)) from error
    response["job_id"] = normalized_job_id

    status = _read_status(server_root, normalized_job_id)
    if status is None:
        raise HTTPException(404, "Dataset type change job was not found.")
    response["found"] = True
    response.update(status)
    return response
