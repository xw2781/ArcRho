"""Project audit log: the dataset-sidecar record shape at project scope.

``audit_log.json`` in a project folder keeps the history of project-level
actions (settings saves, dataset-type changes). It uses the same record shape
and the same policy as a dataset sidecar's ``audit_log`` -- ``event_date``,
a known ``action``, ``change_info``, ``user`` -- owned by
``arcrho_api.sidecar_audit_contract``, so one reader serves both files. The
free text a caller supplies is the record's ``change_info``; the action is
``Update`` unless the caller names another known action.
"""

from __future__ import annotations

import getpass
import json
import os
from typing import Any, Dict, List, Optional

from arcrho_api.io import persisted_json_text
from arcrho_api.sidecar_audit_contract import (
    AUDIT_ACTION_UPDATE,
    PROJECT_AUDIT_LOG_MAX_ENTRIES,
    append_audit_entry,
    normalize_audit_action,
    normalize_audit_log,
)
from arcrho_api.timestamps import utc_now_text
from app_server import config
from app_server.services import user_identity_service


PROJECT_AUDIT_LOG_JSON_FORMAT = "arcrho-project-audit-log-v4"


def _resolve_audit_user_name(explicit_user_name: Optional[str] = None) -> str:
    explicit = str(explicit_user_name or "").strip()
    if explicit:
        # Callers pass either a login or an already-resolved display name; the
        # mapping leaves an unmapped value unchanged, so this is idempotent.
        return user_identity_service.resolve_display_name(explicit)
    display_name = user_identity_service.get_current_display_name()
    if display_name:
        return display_name
    env_user = str(os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()
    if env_user:
        return env_user
    try:
        return str(getpass.getuser() or "").strip() or "unknown"
    except Exception:
        return "unknown"


def _read_audit_log_entries(filepath: str) -> List[Dict[str, str]]:
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return []
        return normalize_audit_log(raw.get("audit_log"), max_entries=PROJECT_AUDIT_LOG_MAX_ENTRIES)
    except Exception:
        return []


def project_audit_log_payload(project_name: str, entries: List[Dict[str, str]]) -> Dict[str, Any]:
    """The complete persisted ``audit_log.json`` document."""

    return {
        "json_format": PROJECT_AUDIT_LOG_JSON_FORMAT,
        "project_name": project_name,
        "updated_at": utc_now_text(),
        "audit_log": normalize_audit_log(entries, max_entries=PROJECT_AUDIT_LOG_MAX_ENTRIES),
    }


def append_project_audit_log(
    project_name: str,
    action: str,
    user_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Record one project-level action.

    *action* is what the caller did in its own words ("Updated dataset types").
    It is stored as the record's ``change_info``; the record's ``action`` is a
    known audit action -- the text itself when it is one, ``Update`` otherwise.
    """

    project_name_clean = str(project_name or "").strip()
    action_clean = str(action or "").strip()
    if not project_name_clean:
        raise ValueError("project_name is required")
    if not action_clean:
        raise ValueError("action is required")

    filepath = config.get_audit_log_path(project_name_clean)
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    known_action = normalize_audit_action(action_clean)
    is_known = known_action != action_clean or known_action in {"Insert", "Update", "Auto Refresh"}
    record_action = known_action if is_known else AUDIT_ACTION_UPDATE
    change_info = "" if is_known else action_clean

    with config._AUDIT_LOG_LOCK:
        entries = append_audit_entry(
            _read_audit_log_entries(filepath),
            event_date=utc_now_text(),
            action=record_action,
            user=_resolve_audit_user_name(user_name),
            change_info=change_info,
            max_entries=PROJECT_AUDIT_LOG_MAX_ENTRIES,
        )
        payload = project_audit_log_payload(project_name_clean, entries)
        tmp_path = filepath + ".tmp"
        with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(persisted_json_text(payload))
        os.replace(tmp_path, filepath)

    return {"path": filepath, "entry": entries[-1], "count": len(entries)}


def safe_append_project_audit_log(project_name: str, action: str, user_name: Optional[str] = None) -> None:
    try:
        append_project_audit_log(project_name=project_name, action=action, user_name=user_name)
    except Exception:
        pass


AUDIT_LOG_COLUMNS = ["Timestamp", "User", "Action", "Details"]


def read_audit_log(project_name: str, limit: int = 500) -> Dict[str, Any]:
    filepath = config.get_audit_log_path(project_name)
    safe_limit = max(1, min(int(limit or 500), config.AUDIT_LOG_MAX_ENTRIES))
    entries = _read_audit_log_entries(filepath)
    if safe_limit > 0:
        entries = entries[-safe_limit:]
    entries.reverse()
    return {
        "exists": os.path.exists(filepath),
        "path": filepath,
        "data": {
            "columns": list(AUDIT_LOG_COLUMNS),
            "rows": [
                [e.get("event_date", ""), e.get("user", ""), e.get("action", ""), e.get("change_info", "")]
                for e in entries
            ],
        },
    }
