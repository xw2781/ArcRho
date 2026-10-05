"""Project lock: a project-wide switch that freezes the project's shared data.

A locked project refuses every save of a method or dataset and every edit to
its imports and project configuration, for every user, until someone unlocks
it in Project Settings. Each user's own preferences (column widths, hidden
paths, filters) are not project data and keep saving.

This module is the one owner of the lock file and of the refusal. Saves reach
:func:`require_project_unlocked` through the reserving-class and project-scope
preflights in ``dependent_propagation_service``; workspace mutations reach it
through :func:`require_mutation_allowed`, which reads which kinds the lock
covers from ``arcrho_workspace_mutation_contract``. Both run where the
workspace is local disk, so the check is authoritative for every client.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Mapping

from fastapi import HTTPException

from arcrho_api.io import persisted_json_text
from arcrho_api.timestamps import utc_now_text
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS
from app_server import config
from app_server.services import audit_service, file_read_cache, user_identity_service


PROJECT_LOCKED_MESSAGE = (
    "This project is locked, so its data cannot be changed. "
    "Unlock it in Project Settings first."
)


def _lock_path(project_name: str) -> str:
    try:
        return config.get_project_lock_path(project_name)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


def _read_lock(path: str) -> Dict[str, Any]:
    try:
        raw = file_read_cache.read_json_file_cached(path)
    except FileNotFoundError:
        return {"locked": False, "locked_by": "", "locked_at": ""}
    data = raw if isinstance(raw, dict) else {}
    locked = data.get("locked") is True
    return {
        "locked": locked,
        "locked_by": str(data.get("locked_by") or "") if locked else "",
        "locked_at": str(data.get("locked_at") or "") if locked else "",
    }


def get_project_lock(project_name: str) -> Dict[str, Any]:
    project = str(project_name or "").strip()
    if not project:
        raise HTTPException(400, "project_name is required")
    return {"ok": True, "message": PROJECT_LOCKED_MESSAGE, **_read_lock(_lock_path(project))}


def set_project_lock(project_name: str, locked: bool = False) -> Dict[str, Any]:
    project = str(project_name or "").strip()
    if not project:
        raise HTTPException(400, "project_name is required")
    path = _lock_path(project)
    payload: Dict[str, Any] = {"locked": bool(locked)}
    if locked:
        payload["locked_by"] = user_identity_service.get_current_display_name()
        payload["locked_at"] = utc_now_text()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(persisted_json_text(payload))
    os.replace(tmp_path, path)
    audit_service.safe_append_project_audit_log(
        project_name=project,
        action="Locked project" if locked else "Unlocked project",
    )
    return {"ok": True, "message": PROJECT_LOCKED_MESSAGE, **_read_lock(path)}


def require_project_unlocked(project_name: str) -> None:
    """Refuse a change to a locked project's data with 423."""

    project = str(project_name or "").strip()
    if not project:
        return
    try:
        path = config.get_project_lock_path(project)
    except ValueError:
        # No such project folder: the caller reports that in its own words.
        return
    if _read_lock(path)["locked"]:
        raise HTTPException(423, PROJECT_LOCKED_MESSAGE)


def require_mutation_allowed(mutation_kind: str, kwargs: Mapping[str, Any]) -> None:
    """Refuse a workspace mutation the contract marks as changing project data."""

    spec = WORKSPACE_MUTATION_KINDS.get(mutation_kind)
    if spec is None or not spec.locked_project_arg:
        return
    require_project_unlocked(str(kwargs.get(spec.locked_project_arg) or ""))
