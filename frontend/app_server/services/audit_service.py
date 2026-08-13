"""Audit logging operations with thread-safe writes."""
from __future__ import annotations

import os
import json
import getpass
from datetime import datetime
from typing import Any, Dict, List, Optional

from arcrho_api.io import persisted_json_text
from app_server import config
from app_server.services import user_identity_service


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


def _normalize_audit_entries(raw_entries: Any) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    if not isinstance(raw_entries, list):
        return out
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        ts = str(raw.get("timestamp") or "").strip()
        user = str(raw.get("user") or "").strip()
        action = str(raw.get("action") or "").strip()
        if not ts or not action:
            continue
        out.append({"timestamp": ts, "user": user, "action": action})
    return out


def _read_audit_log_entries(filepath: str) -> List[Dict[str, str]]:
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return []
        return _normalize_audit_entries(raw.get("entries"))
    except Exception:
        return []


def append_project_audit_log(
    project_name: str,
    action: str,
    user_name: Optional[str] = None,
) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    action_clean = str(action or "").strip()
    if not project_name_clean:
        raise ValueError("project_name is required")
    if not action_clean:
        raise ValueError("action is required")

    filepath = config.get_audit_log_path(project_name_clean)
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    entry = {
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "user": _resolve_audit_user_name(user_name),
        "action": action_clean,
    }

    with config._AUDIT_LOG_LOCK:
        entries = _read_audit_log_entries(filepath)
        entries.append(entry)
        if len(entries) > config.AUDIT_LOG_MAX_ENTRIES:
            entries = entries[-config.AUDIT_LOG_MAX_ENTRIES:]
        payload = {
            "project_name": project_name_clean,
            "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "entries": entries,
        }
        tmp_path = filepath + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(persisted_json_text(payload))
        os.replace(tmp_path, filepath)

    return {"path": filepath, "entry": entry, "count": len(entries)}


def safe_append_project_audit_log(project_name: str, action: str, user_name: Optional[str] = None) -> None:
    try:
        append_project_audit_log(project_name=project_name, action=action, user_name=user_name)
    except Exception:
        pass


def read_audit_log(project_name: str, limit: int = 500) -> Dict[str, Any]:
    filepath = config.get_audit_log_path(project_name)
    safe_limit = max(1, min(int(limit or 500), 5000))
    entries = _read_audit_log_entries(filepath)
    if safe_limit > 0:
        entries = entries[-safe_limit:]
    entries.reverse()
    return {
        "exists": os.path.exists(filepath),
        "path": filepath,
        "data": {
            "columns": ["Timestamp", "User", "Action"],
            "rows": [[e.get("timestamp", ""), e.get("user", ""), e.get("action", "")] for e in entries],
        },
    }
