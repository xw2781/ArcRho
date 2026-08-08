"""Scripting console and local project preference persistence."""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Set

from app_server import config

# ---------------------------------------------------------------------------
# User preferences
# ---------------------------------------------------------------------------

_SCRIPTING_PREFS_LOCK = threading.Lock()
_LOCAL_PROJECT_PREFS_LOCK = threading.Lock()
_LEGACY_DATASET_VIEWER_PREFS_KEY = "dataset_viewer_local_prefs_v1"


def get_preferences() -> Dict[str, Any]:
    """Load scripting user preferences from APPDATA JSON file."""
    filepath = config.get_scripting_prefs_path()
    with _SCRIPTING_PREFS_LOCK:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
    return {}


def save_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    """Merge and save scripting user preferences to APPDATA JSON file."""
    filepath = config.get_scripting_prefs_path()
    with _SCRIPTING_PREFS_LOCK:
        # Load existing, merge with incoming
        existing: Dict[str, Any] = {}
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                existing = loaded
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

        existing.update(prefs)

        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)

    return {"success": True, "preferences": existing}


def _normalize_local_project_preferences(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    project = str(
        source.get("projectName")
        or source.get("project_name")
        or source.get("project")
        or ""
    ).strip()
    updated_at = str(source.get("updated_at") or source.get("updatedAt") or "").strip()
    out: Dict[str, Any] = {}
    if project:
        out["projectName"] = project
    recent_raw = (
        source.get("recentProjectNames")
        or source.get("recent_project_names")
        or source.get("recentProjects")
        or source.get("recent_projects")
        or []
    )
    if isinstance(recent_raw, (list, tuple)):
        recent_projects: List[str] = []
        seen_projects: Set[str] = set()
        for item in recent_raw:
            recent_project = str(item or "").strip()
            recent_key = recent_project.lower()
            if not recent_project or recent_key in seen_projects:
                continue
            seen_projects.add(recent_key)
            recent_projects.append(recent_project)
            if len(recent_projects) >= 3:
                break
        if recent_projects:
            out["recentProjectNames"] = recent_projects
    if updated_at:
        out["updated_at"] = updated_at

    explorer_source = None
    for explorer_key in (
        "projectExplorer",
        "project_explorer",
        "projectSettingsExplorer",
        "project_settings_explorer",
    ):
        if explorer_key in source:
            explorer_source = source.get(explorer_key)
            break
    if isinstance(explorer_source, dict):
        expanded_raw = (
            explorer_source.get("expandedFolders")
            or explorer_source.get("expanded_folders")
            or []
        )
        if isinstance(expanded_raw, (list, tuple)):
            expanded_folders: List[str] = []
            seen_folders: Set[str] = set()
            for item in expanded_raw:
                folder = str(item or "").strip().replace("/", "\\")
                folder = "\\".join(part.strip() for part in folder.split("\\") if part.strip())
                folder_key = folder.lower()
                if not folder or folder_key in seen_folders:
                    continue
                seen_folders.add(folder_key)
                expanded_folders.append(folder)
            out["projectExplorer"] = {"expandedFolders": expanded_folders}

    shell_history_source = None
    for history_key in ("shellActivityHistory", "shell_activity_history"):
        if history_key in source:
            shell_history_source = source.get(history_key)
            break
    if isinstance(shell_history_source, dict):
        entries_raw = shell_history_source.get("entries")
        entries: List[Dict[str, Any]] = []
        if isinstance(entries_raw, (list, tuple)):
            for item in entries_raw:
                if not isinstance(item, dict):
                    continue
                entry = dict(item)
                tab_type = str(entry.get("tabType") or entry.get("tab_type") or "").strip().lower()
                title = str(entry.get("title") or tab_type or "Untitled").strip()
                if not tab_type:
                    continue
                entry["tabType"] = tab_type
                entry["title"] = title
                entry.pop("tab_type", None)
                entries.append(entry)
                if len(entries) >= 10:
                    break
        out["shellActivityHistory"] = {"entries": entries}

    home_shortcuts_source = None
    for shortcuts_key in ("homeShortcuts", "home_shortcuts"):
        if shortcuts_key in source:
            home_shortcuts_source = source.get(shortcuts_key)
            break
    if isinstance(home_shortcuts_source, dict):
        out["homeShortcuts"] = _normalize_home_shortcuts(home_shortcuts_source)
    return out


# Home custom shortcut groups. The card `target` is the same descriptor the shell writes for
# browsing history, so this layer validates structure and caps only and leaves target semantics to
# `ui/shell/home_shortcuts.js`, which owns the document schema.
HOME_SHORTCUTS_VERSION = 1
MAX_HOME_SHORTCUT_GROUPS = 24
MAX_HOME_SHORTCUT_CARDS_PER_GROUP = 48
MAX_HOME_SHORTCUT_TITLE_LENGTH = 60


def _clip_home_shortcut_title(value: Any, fallback: str) -> str:
    text = str(value or "").strip()[:MAX_HOME_SHORTCUT_TITLE_LENGTH].strip()
    return text or fallback


def _normalize_home_shortcut_card(raw: Any, used_ids: Set[str]) -> Dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    target = raw.get("target")
    if not isinstance(target, dict):
        return None
    tab_type = str(target.get("tabType") or target.get("tab_type") or "").strip().lower()
    if not tab_type:
        return None
    card_id = str(raw.get("id") or "").strip()
    if not card_id or card_id in used_ids:
        return None
    used_ids.add(card_id)
    normalized_target = dict(target)
    normalized_target["tabType"] = tab_type
    normalized_target.pop("tab_type", None)
    normalized_target.pop("ts", None)
    title = str(normalized_target.get("title") or tab_type).strip()
    normalized_target["title"] = title
    return {
        "id": card_id,
        "label": _clip_home_shortcut_title(raw.get("label"), title or "Shortcut"),
        "target": normalized_target,
    }


def _normalize_home_shortcut_group(raw: Any, used_ids: Set[str]) -> Dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    group_id = str(raw.get("id") or "").strip()
    if not group_id or group_id in used_ids:
        return None
    used_ids.add(group_id)
    cards: List[Dict[str, Any]] = []
    cards_raw = raw.get("cards")
    if isinstance(cards_raw, (list, tuple)):
        for item in cards_raw:
            card = _normalize_home_shortcut_card(item, used_ids)
            if card is None:
                continue
            cards.append(card)
            if len(cards) >= MAX_HOME_SHORTCUT_CARDS_PER_GROUP:
                break
    return {
        "id": group_id,
        "title": _clip_home_shortcut_title(raw.get("title"), "Untitled group"),
        "cards": cards,
    }


def _normalize_home_shortcuts(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    used_ids: Set[str] = set()
    groups: List[Dict[str, Any]] = []
    groups_raw = source.get("groups")
    if isinstance(groups_raw, (list, tuple)):
        for item in groups_raw:
            group = _normalize_home_shortcut_group(item, used_ids)
            if group is None:
                continue
            groups.append(group)
            if len(groups) >= MAX_HOME_SHORTCUT_GROUPS:
                break
    return {"version": HOME_SHORTCUTS_VERSION, "groups": groups}


def get_local_project_preferences() -> Dict[str, Any]:
    """Load shared last-project preferences from a dedicated APPDATA JSON file."""
    filepath = config.get_local_project_prefs_path()
    with _LOCAL_PROJECT_PREFS_LOCK:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            normalized = _normalize_local_project_preferences(data)
            if normalized:
                return normalized
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    legacy = _normalize_local_project_preferences(
        get_preferences().get(_LEGACY_DATASET_VIEWER_PREFS_KEY)
    )
    return legacy


def save_local_project_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    """Merge shared last-project preferences into %APPDATA%\\ArcRho\\local_project_prefs.json."""
    filepath = config.get_local_project_prefs_path()
    with _LOCAL_PROJECT_PREFS_LOCK:
        existing: Dict[str, Any] = {}
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            existing = _normalize_local_project_preferences(loaded)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            existing = {}

        incoming = _normalize_local_project_preferences(prefs)
        incoming_source = prefs if isinstance(prefs, dict) else {}
        incoming_has_recent_projects = any(
            key in incoming_source
            for key in ("recentProjectNames", "recent_project_names", "recentProjects", "recent_projects")
        )
        incoming_project = str(incoming.get("projectName") or "").strip()
        existing_recent = existing.get("recentProjectNames")
        incoming_recent = incoming.get("recentProjectNames")
        merged_recent: List[str] = []
        if incoming_has_recent_projects:
            seen_recent: Set[str] = set()
            for candidate in [
                incoming_project,
                *(incoming_recent if isinstance(incoming_recent, list) else []),
                *(existing_recent if isinstance(existing_recent, list) else []),
            ]:
                recent_project = str(candidate or "").strip()
                recent_key = recent_project.lower()
                if not recent_project or recent_key in seen_recent:
                    continue
                seen_recent.add(recent_key)
                merged_recent.append(recent_project)
                if len(merged_recent) >= 3:
                    break

        existing.update(incoming)
        if incoming_has_recent_projects and merged_recent:
            existing["recentProjectNames"] = merged_recent

        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
            f.write("\n")

    return {"success": True, "preferences": existing}


