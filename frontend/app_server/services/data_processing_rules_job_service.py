"""Client-side submission and status for Engine-hosted rules saves.

Saving a project's data-processing rules used to run in whatever process the
user clicked in. On a Client PC that meant opening every engine-generated
sidecar in the project over the mapped drive to count the caches the new rules
make stale -- one round trip per sidecar, inside the save request -- so the
request came back minutes later with the editor showing nothing in between.

This module replaces that with a durable job. The request is published for
ArcRho Engine, which claims the project-scope lease and runs the canonical
save on local disk while the client only polls the status; the terminal status
carries the save route's whole response. Submission travels as a hosted
workspace mutation and the status as a hosted read, so from a Client PC both
halves are one HTTP exchange with the Gateway rather than SMB file I/O.

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

from arcrho_data_processing_rules_job_contract import (
    DataProcessingRulesJobContractError,
    build_data_processing_rules_job_request,
    data_processing_rules_job_request_path,
    data_processing_rules_job_status_path,
    find_queued_data_processing_rules_job,
    validate_data_processing_rules_job_status,
    validate_project_name,
    validate_request_id,
    write_data_processing_rules_job_status,
)
from arcrho_dependent_propagation_contract import find_project_scope_propagation_hold
from arcrho_project_duplication_contract import path_is_link_or_reparse, write_json_atomic
from arcrho_source_refresh_contract import find_source_refresh_hold

from app_server.services import dependent_propagation_service, user_identity_service


RULES_JOB_BUSY_MESSAGE = (
    "A data processing rules save is already running for this project. "
    "Please wait for it to finish before saving again."
)
SOURCE_REFRESH_RUNNING_MESSAGE = (
    "A source table refresh is running for this project. "
    "Please wait for it to finish, then save the rules again."
)


def _validate_protocol_paths(server_root: Path) -> None:
    current = server_root
    checks = []
    for part in ("requests", "data_processing_rules"):
        current /= part
        checks.append(current)
    for leaf in ("requests", "statuses"):
        checks.append(current / leaf)
    for path in checks:
        try:
            unsafe = path_is_link_or_reparse(path)
        except OSError as error:
            raise HTTPException(
                500, "The data processing rules job protocol path is inaccessible."
            ) from error
        if unsafe:
            raise HTTPException(500, "The data processing rules job protocol path is unsafe.")


def _validated_project(project_name: str) -> str:
    try:
        return validate_project_name(project_name)
    except DataProcessingRulesJobContractError as error:
        raise HTTPException(400, str(error)) from error


def _read_status(server_root: Path, request_id: str) -> Dict[str, Any] | None:
    status_path = data_processing_rules_job_status_path(server_root, request_id)
    try:
        with status_path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except FileNotFoundError:
        return None
    except PermissionError as error:
        raise HTTPException(
            423, "Data processing rules job status is locked or inaccessible."
        ) from error
    except json.JSONDecodeError as error:
        raise HTTPException(
            502, "ArcRho Engine published an invalid data processing rules job status."
        ) from error
    except OSError as error:
        raise HTTPException(
            500, "Failed to read the data processing rules job status."
        ) from error
    try:
        return validate_data_processing_rules_job_status(
            payload, expected_request_id=request_id
        )
    except DataProcessingRulesJobContractError as error:
        raise HTTPException(
            502, "ArcRho Engine published an invalid data processing rules job status."
        ) from error


def submit_data_processing_rules_job(
    project_name: str,
    request_id: str = "",
    *,
    expected_revision: int = 0,
    rules: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Publish one queued rules save and return its job identity.

    Preflights the whole project before anything is published: a live Engine,
    no project-wide job already running, and no reserving class still being
    walked. Re-submitting an id that already has a published status returns
    that job untouched, so a retry after a lost response never saves twice.
    """

    name = _validated_project(project_name)
    # The project-scope preflight owns the live-Engine check and both hold
    # probes, and hands back the validated workspace root.
    server_root = dependent_propagation_service.require_project_scope_writable(name)
    _validate_protocol_paths(server_root)

    try:
        request = build_data_processing_rules_job_request(
            request_id=request_id if request_id else uuid.uuid4().hex,
            project_name=name,
            expected_revision=expected_revision,
            rules=list(rules or []),
            # The Engine stamps the rules file and the audit log as this user.
            user_name=user_identity_service.get_windows_login_name(),
        )
    except DataProcessingRulesJobContractError as error:
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
    if find_queued_data_processing_rules_job(server_root, name) is not None:
        raise HTTPException(423, RULES_JOB_BUSY_MESSAGE)

    request_path = data_processing_rules_job_request_path(server_root, normalized_request_id)
    published_status_path: Path | None = None
    try:
        published_status_path = write_data_processing_rules_job_status(
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
            423, "The data processing rules job queue is locked or inaccessible."
        ) from error
    except OSError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            500, "Failed to submit the data processing rules save job."
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


def get_data_processing_rules_job_status(
    project_name: str,
    job_id: str = "",
) -> Dict[str, Any]:
    """One job's status plus whether the project is still held.

    Both answers come from the same visit because a poller needs them
    together: a job whose status has not appeared yet is indistinguishable
    from a lost one unless the caller can also see that the project is busy.
    """

    name = _validated_project(project_name)
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
    except DataProcessingRulesJobContractError as error:
        raise HTTPException(400, str(error)) from error
    response["job_id"] = normalized_job_id

    status = _read_status(server_root, normalized_job_id)
    if status is None:
        raise HTTPException(404, "Data processing rules job was not found.")
    response["found"] = True
    response.update(status)
    return response
