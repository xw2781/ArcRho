"""Shared configuration, paths, constants, locks, and mutable globals.

This module is the foundation of the app server. It has zero imports from other
app-server modules to prevent circular dependencies. Every other app-server
module may freely ``from app_server import config`` and reference ``config.DATA_DIR``,
``config._AUDIT_LOG_LOCK``, etc.
"""
from __future__ import annotations

import os
import re
import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Project root resolution
# ---------------------------------------------------------------------------

def _resolve_project_root() -> Path:
    candidates = [
        Path(__file__).resolve().parent.parent,
        Path.cwd(),
    ]
    for candidate in candidates:
        if (
            (candidate / "workspace_paths.json").exists()
            or (candidate / "index.html").exists()
        ):
            return candidate
    return candidates[0]


PROJECT_ROOT = _resolve_project_root()

# ---------------------------------------------------------------------------
# Config - load workspace path settings
# ---------------------------------------------------------------------------

DEFAULT_WORKSPACE_ROOT = r"E:\ArcRho Server"
DEFAULT_WORKSPACE_PATHS = {
    "projects_dir": "projects",
    "requests_dir": "requests",
}
PROJECT_USER_PREFERENCES_FILE = "preferences.json"
PROJECT_INSTANCE_DEFAULT_PREFS_ENV = "ARCRHO_PROJECT_INSTANCE_DEFAULT_PREFS_PATH"
DEFAULT_PROJECT_INSTANCE_PREFS_PROJECT_NAME = "NJ_Annual_Prod_2026 Q1-Feb Test"
DEFAULT_PROJECT_INSTANCE_PREFS_USER_NAME = "xwei"


def _get_user_appdata_dir() -> str:
    appdata = str(os.environ.get("APPDATA") or "").strip()
    if not appdata:
        appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(appdata, "ArcRho")


WORKSPACE_PATHS_PATH = os.path.join(_get_user_appdata_dir(), "workspace_paths.json")


def workspace_paths_file_exists() -> bool:
    return os.path.exists(WORKSPACE_PATHS_PATH)


def _read_json_file(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return {}

    if not isinstance(raw, dict):
        return {}
    return raw


def _clean_path_segment(value: Any, default: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def load_workspace_paths() -> Dict[str, Any]:
    """Load runtime workspace path configuration."""
    raw = _read_json_file(WORKSPACE_PATHS_PATH)

    workspace_root = raw.get("workspace_root")
    if not isinstance(workspace_root, str) or not workspace_root.strip():
        workspace_root = DEFAULT_WORKSPACE_ROOT

    paths = raw.get("paths")
    if not isinstance(paths, dict):
        paths = {}

    projects_dir = _clean_path_segment(
        paths.get("projects_dir"),
        DEFAULT_WORKSPACE_PATHS["projects_dir"],
    )
    requests_dir = _clean_path_segment(
        paths.get("requests_dir"),
        DEFAULT_WORKSPACE_PATHS["requests_dir"],
    )

    return {
        "workspace_root": str(workspace_root).strip(),
        "paths": {
            "projects_dir": projects_dir,
            "requests_dir": requests_dir,
        },
    }


def save_workspace_paths(cfg: Dict[str, Any]) -> None:
    """Persist normalized workspace path configuration."""
    os.makedirs(os.path.dirname(WORKSPACE_PATHS_PATH), exist_ok=True)
    with open(WORKSPACE_PATHS_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def get_root_path() -> str:
    """Get the workspace root path from config."""
    return load_workspace_paths()["workspace_root"]


def get_path(subpath: str) -> str:
    """Get a full path by joining the workspace root with subpath."""
    return os.path.join(get_root_path(), subpath)


def _get_project_map_dir() -> str:
    cfg = load_workspace_paths()
    return get_path(cfg.get("paths", {}).get("projects_dir", DEFAULT_WORKSPACE_PATHS["projects_dir"]))


def _get_requests_dir() -> str:
    cfg = load_workspace_paths()
    return get_path(cfg.get("paths", {}).get("requests_dir", DEFAULT_WORKSPACE_PATHS["requests_dir"]))


def _get_workflow_dir() -> str:
    return os.path.join(os.path.expanduser("~"), "Documents", "ArcRho", "workflows")


def _get_scripting_dir() -> str:
    return os.path.join(os.path.expanduser("~"), "Documents", "ArcRho", "scripts")


PROJECT_INDEX_FILE = "index.json"

# Project settings JSON files (on shared network drive)
PROJECT_SETTINGS_SOURCES = {
    "project_map": PROJECT_INDEX_FILE,
    # Add more sources here as needed
}

WORKFLOW_EXT = ".arcwf"

# ---------------------------------------------------------------------------
# Mutable runtime paths — refreshed from config
# ---------------------------------------------------------------------------

DATA_DIR: str = ""
PROJECT_SETTINGS_DIR: str = ""
PROJECT_BOOK: str = ""
WORKFLOW_DIR: str = ""
SCRIPTING_DIR: str = ""
ALLOWED_BOOK_DIRS: List[Path] = []
REQUEST_DIR: str = ""


def refresh_runtime_paths() -> None:
    """Refresh runtime directories from workspace path config."""
    global DATA_DIR, PROJECT_SETTINGS_DIR, PROJECT_BOOK, WORKFLOW_DIR, SCRIPTING_DIR
    global ALLOWED_BOOK_DIRS, REQUEST_DIR
    PROJECT_SETTINGS_DIR = _get_project_map_dir()
    PROJECT_BOOK = os.path.join(
        PROJECT_SETTINGS_DIR,
        PROJECT_SETTINGS_SOURCES.get("project_map", PROJECT_INDEX_FILE),
    )
    WORKFLOW_DIR = _get_workflow_dir()
    SCRIPTING_DIR = _get_scripting_dir()
    DATA_DIR = SCRIPTING_DIR
    ALLOWED_BOOK_DIRS = [
        Path(PROJECT_SETTINGS_DIR).resolve(),
    ]
    REQUEST_DIR = _get_requests_dir()


# In-memory dataset cache
DATASETS: Dict[str, str] = {}


def clear_runtime_path_caches() -> None:
    """Clear in-memory caches that contain absolute workspace paths."""
    DATASETS.clear()


# Initialise paths on first import
refresh_runtime_paths()

# ---------------------------------------------------------------------------
# File-name constants
# ---------------------------------------------------------------------------

FIELD_MAPPING_FILE = "field_mapping.json"
FIELD_MAPPING_SIGNIFICANCES = {
    "Reserving Class",
    "Origin Date",
    "Development Date",
    "Dataset",
}
RESERVING_CLASS_VALUES_FILE = "reserving_class_values.json"
RESERVING_CLASS_COMBINATIONS_FILE = "reserving_class_combinations_cache.json"
RESERVING_CLASS_TYPES_FILE = "reserving_class_types.json"
RESERVING_CLASS_PATH_TREE_FILE = "reserving_class_path_tree_cache.json"
RESERVING_CLASS_PATH_TREE_MAX_GENERATED = 250000
SCRIPTING_PREFS_FILE = "scripting_prefs.json"
LOCAL_PROJECT_PREFS_FILE = "local_project_prefs.json"
DATASET_TYPES_FILE = "dataset_types.json"
PROJECT_SETTINGS_XLSX_FILE = "settings.xlsx"
RESERVING_CLASS_TYPES_SHEET_NAME = "Reserving Class Types"
RESERVING_CLASS_TYPES_COLUMNS = ["Name", "Level", "Formula", "EEX Formula"]
RESERVING_CLASS_TYPES_FILE_COLUMNS = ["Name", "Level", "Formula", "EEX Formula", "Source"]
DATASET_TYPES_COLUMNS = ["Name", "Data Format", "Category", "Calculated", "Formula"]
DATASET_TYPES_FILE_COLUMNS = ["Name", "Data Format", "Category", "Calculated", "Formula", "Source", "Generated"]
AUDIT_LOG_FILE = "audit_log.json"
AUDIT_LOG_MAX_ENTRIES = 5000
GENERAL_SETTINGS_FILE = "general_settings.json"
PROJECT_DATA_DIR = "data"
DATASET_CACHE_DIR = "datasets"
METHOD_DATA_DIR = "methods"
DATASET_SIDECAR_DIR = "sidecars"

# ---------------------------------------------------------------------------
# Thread locks
# ---------------------------------------------------------------------------

_AUDIT_LOG_LOCK = threading.Lock()
_RESERVING_CLASS_PATH_TREE_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# App-control flag paths
# ---------------------------------------------------------------------------

BASE_DIR = PROJECT_ROOT
RESTART_FLAG = BASE_DIR / ".restart_app"
SHUTDOWN_FLAG = BASE_DIR / ".shutdown_app"
ELECTRON_RESTART_FLAG = BASE_DIR / ".restart_electron"
ELECTRON_SHUTDOWN_FLAG = BASE_DIR / ".shutdown_electron"

# ---------------------------------------------------------------------------
# Path-resolver helpers
# ---------------------------------------------------------------------------

def encode_filename_segment(name: str) -> str:
    replacements = {
        "\\": "_%5C_",
        "/": "_%2F_",
        ":": "_%3A_",
        "*": "_%2A_",
        "?": "_%3F_",
        '"': "_%22_",
        "<": "_%3C_",
        ">": "_%3E_",
        "|": "_%7C_",
    }
    out = []
    for ch in name or "":
        if ch in replacements:
            out.append(replacements[ch])
        elif ord(ch) < 32:
            out.append(f"_%{ord(ch):02X}_")
        else:
            out.append(ch)
    return "".join(out)


def _sanitize_folder_name(name: str) -> str:
    return encode_filename_segment(name or "")


def _sanitize_project_dir_name(name: str) -> str:
    out = (name or "").strip()
    return encode_filename_segment(out)


def sanitize_reserving_class_folder(value: Any, fallback: str = "ReservingClass") -> str:
    text = str(value if value is not None else "").strip()
    text = encode_filename_segment(text)
    text = re.sub(r"[. ]+$", lambda match: "^" * len(match.group(0)), text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or fallback


def _infer_project_name_from_table_path(table_path: str) -> str:
    """Infer project name from table file name like <project_name>_YYYYMM.csv."""
    stem = Path(table_path).stem
    m = re.match(r"^(?P<name>.+)_\d{6}$", stem)
    project_name = (m.group("name") if m else stem).strip()
    return _sanitize_folder_name(project_name) or _sanitize_folder_name(stem) or "project"


def _find_existing_project_dir(project_name: str) -> Optional[str]:
    """Find an existing project folder under E:\\ArcRho Server\\projects by name (case-insensitive)."""
    target = _sanitize_folder_name(project_name or "").strip()
    if not target:
        return None

    direct = os.path.join(PROJECT_SETTINGS_DIR, target)
    if os.path.isdir(direct):
        return direct

    try:
        target_l = target.lower()
        with os.scandir(PROJECT_SETTINGS_DIR) as it:
            for entry in it:
                if entry.is_dir() and entry.name.strip().lower() == target_l:
                    return entry.path
    except Exception:
        return None
    return None


def get_cache_path(csv_path: str, project_name: Optional[str] = None) -> str:
    """Get table-summary cache path under an existing project folder."""
    chosen_name = (project_name or "").strip() or _infer_project_name_from_table_path(csv_path)
    project_dir = _find_existing_project_dir(chosen_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {chosen_name}")
    return os.path.join(project_dir, "table_summary.json")


def get_field_mapping_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, FIELD_MAPPING_FILE)


def get_dataset_types_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, DATASET_TYPES_FILE)


def get_reserving_class_values_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, RESERVING_CLASS_VALUES_FILE)


def get_reserving_class_combinations_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, RESERVING_CLASS_COMBINATIONS_FILE)


def get_reserving_class_types_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, RESERVING_CLASS_TYPES_FILE)


def get_reserving_class_path_tree_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, RESERVING_CLASS_PATH_TREE_FILE)


def _get_user_appdata_cache_dir() -> str:
    return os.path.join(_get_user_appdata_dir(), "cache")


def get_scripting_prefs_path() -> str:
    return os.path.join(_get_user_appdata_cache_dir(), SCRIPTING_PREFS_FILE)


def get_local_project_prefs_path() -> str:
    return os.path.join(_get_user_appdata_dir(), LOCAL_PROJECT_PREFS_FILE)


def get_project_instance_default_preferences_path() -> str:
    configured = str(os.environ.get(PROJECT_INSTANCE_DEFAULT_PREFS_ENV) or "").strip()
    if configured:
        return configured
    return os.path.join(
        PROJECT_SETTINGS_DIR,
        DEFAULT_PROJECT_INSTANCE_PREFS_PROJECT_NAME,
        "users",
        DEFAULT_PROJECT_INSTANCE_PREFS_USER_NAME,
        PROJECT_USER_PREFERENCES_FILE,
    )


def get_project_settings_workbook_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, PROJECT_SETTINGS_XLSX_FILE)


def get_audit_log_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, AUDIT_LOG_FILE)


def get_general_settings_path(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, GENERAL_SETTINGS_FILE)


def get_project_data_dir(project_name: str) -> str:
    project_dir = _find_existing_project_dir(project_name)
    if not project_dir:
        raise ValueError(f"Project folder not found under projects: {project_name}")
    return os.path.join(project_dir, PROJECT_DATA_DIR)


def get_project_reserving_class_data_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(
        get_project_data_dir(project_name),
        sanitize_reserving_class_folder(reserving_class),
    )


def get_project_dataset_sidecar_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(
        get_project_reserving_class_data_dir(project_name, reserving_class),
        DATASET_SIDECAR_DIR,
    )


def get_project_dataset_cache_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(
        get_project_reserving_class_data_dir(project_name, reserving_class),
        DATASET_CACHE_DIR,
    )


def get_project_method_data_dir(project_name: str, reserving_class: str) -> str:
    return os.path.join(
        get_project_reserving_class_data_dir(project_name, reserving_class),
        METHOD_DATA_DIR,
    )
