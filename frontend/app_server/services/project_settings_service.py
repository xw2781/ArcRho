"""Project settings and project index CRUD."""
from __future__ import annotations

import os
import re
import json
import shutil
import subprocess
import sys
from datetime import datetime
from typing import Any, Dict, List

from fastapi import HTTPException

from app_server import config
from app_server.helpers import (
    _sanitize_project_dir_name,
    _norm_tree_path,
    _split_project_tree_path,
    _add_folder_with_parents,
    _normalize_folder_structure_entry,
)
from app_server.services.audit_service import safe_append_project_audit_log


def _project_index_path() -> str:
    return os.path.join(config.PROJECT_SETTINGS_DIR, config.PROJECT_INDEX_FILE)


def _read_project_index() -> Dict[str, Any]:
    path = _project_index_path()
    if not os.path.exists(path):
        raise HTTPException(404, f"Project index file not found: {path}")
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except json.JSONDecodeError as err:
        raise HTTPException(400, f"Invalid project index JSON: {str(err)}")
    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid project index format.")
    return _normalize_project_index(data)


def _write_project_index(data: Dict[str, Any]) -> str:
    path = _project_index_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(_normalize_project_index(data), f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, path)
    return path


def _folder_entry_from_path(path: str) -> Dict[str, str]:
    cleaned = _norm_tree_path(path)
    if not cleaned:
        return {"name": "", "path": "", "parent": ""}
    idx = cleaned.rfind("\\")
    if idx >= 0:
        return {"name": cleaned[idx + 1 :], "path": cleaned, "parent": cleaned[:idx]}
    return {"name": cleaned, "path": cleaned, "parent": ""}


def _normalize_project_index(data: Dict[str, Any]) -> Dict[str, Any]:
    projects: List[Dict[str, str]] = []
    seen_projects: set[str] = set()
    folder_paths: set[str] = set()

    for item in data.get("projects", []) if isinstance(data.get("projects"), list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen_projects:
            continue
        seen_projects.add(key)
        folder = _norm_tree_path(item.get("folder", ""))
        if folder:
            _add_folder_with_parents(folder_paths, folder)
        projects.append({"name": name, "folder": folder})

    for item in data.get("folders", []) if isinstance(data.get("folders"), list) else []:
        if isinstance(item, dict):
            path = _norm_tree_path(item.get("path", ""))
        else:
            path = _norm_tree_path(item)
        if path:
            _add_folder_with_parents(folder_paths, path)

    folders = [_folder_entry_from_path(path) for path in sorted(folder_paths)]
    return {
        "version": int(data.get("version") or 1),
        "projects": projects,
        "folders": [f for f in folders if f["path"]],
    }


def _project_table_path(project_name: str) -> str:
    name = str(project_name or "").strip()
    if not name:
        return ""
    try:
        path = config.get_field_mapping_path(name)
    except ValueError:
        return ""
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return ""
    return str(payload.get("table_path", "") if isinstance(payload, dict) else "").strip()


def _save_project_table_path(project_name: str, table_path: str) -> None:
    name = str(project_name or "").strip()
    if not name:
        return
    try:
        path = config.get_field_mapping_path(name)
    except ValueError:
        return
    payload: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                payload = raw
        except Exception:
            payload = {}
    payload["project_name"] = name
    payload["table_path"] = str(table_path or "").strip()
    payload.setdefault("rows", [])
    payload["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, path)


def project_index_to_sheet_data(index_data: Dict[str, Any]) -> Dict[str, Any]:
    data = _normalize_project_index(index_data)
    rows = [
        [item["name"], _project_table_path(item["name"])]
        for item in data["projects"]
    ]
    return {
        "Virtual Projects": {
            "headers": ["Project Name", "Table Path"],
            "rows": rows,
        }
    }


def project_index_folder_payload(index_data: Dict[str, Any]) -> Dict[str, List[str]]:
    data = _normalize_project_index(index_data)
    folders = [str(item.get("path", "") or "").strip() for item in data["folders"] if str(item.get("path", "") or "").strip()]
    project_paths = []
    for item in data["projects"]:
        folder = _norm_tree_path(item.get("folder", ""))
        name = str(item.get("name", "") or "").strip()
        if not name:
            continue
        project_paths.append(f"{folder}\\{name}" if folder else name)
    return {"folders": folders, "project_paths": project_paths}


def update_project_index_from_sheet_data(data: Dict[str, Any]) -> Dict[str, Any]:
    existing = _read_project_index()
    folder_by_name = {item["name"].lower(): item.get("folder", "") for item in existing["projects"]}
    projects: List[Dict[str, str]] = []
    seen: set[str] = set()
    if not isinstance(data, dict):
        data = {}
    for sheet in data.values():
        if not isinstance(sheet, dict):
            continue
        headers = list(sheet.get("headers") or [])
        rows = sheet.get("rows") or []
        name_idx = headers.index("Project Name") if "Project Name" in headers else -1
        table_idx = headers.index("Table Path") if "Table Path" in headers else -1
        if name_idx < 0:
            continue
        for row in rows:
            source = list(row) if isinstance(row, list) else []
            name = str(source[name_idx] if name_idx < len(source) and source[name_idx] is not None else "").strip()
            if not name:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            folder = folder_by_name.get(key, "")
            projects.append({"name": name, "folder": folder})
            if table_idx >= 0:
                table_path = str(source[table_idx] if table_idx < len(source) and source[table_idx] is not None else "").strip()
                _save_project_table_path(name, table_path)
    return _normalize_project_index({"version": existing.get("version", 1), "projects": projects, "folders": existing.get("folders", [])})


def _normalize_integer_like_text(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    compact = raw.replace(",", "")
    m = re.match(r"^(-?\d+)(?:\.0+)?$", compact)
    if not m:
        return raw
    int_part = str(m.group(1) or "")
    sign = "-" if int_part.startswith("-") else ""
    digits = int_part[1:] if sign else int_part
    digits = re.sub(r"^0+(?=\d)", "", digits)
    return sign + digits


def _normalize_ci(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_bool_like(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    s = str(value or "").strip().lower()
    if s in {"1", "true", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _normalize_general_settings_payload(
    payload: Any,
    project_name: str = "",
    default_auto_generated: bool = False,
) -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    return {
        "project_name": str(data.get("project_name", project_name) or project_name or "").strip(),
        "origin_start_date": _normalize_integer_like_text(data.get("origin_start_date", "")),
        "origin_end_date": _normalize_integer_like_text(data.get("origin_end_date", "")),
        "development_end_date": _normalize_integer_like_text(data.get("development_end_date", "")),
        "auto_generated": _normalize_bool_like(data.get("auto_generated", default_auto_generated), default_auto_generated),
    }


def _open_folder_in_explorer(folder_path: str) -> None:
    if os.name == "nt":
        os.startfile(folder_path)  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", folder_path], close_fds=True)
        return
    subprocess.Popen(["xdg-open", folder_path], close_fds=True)


def get_project_folders(source: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    payload = project_index_folder_payload(_read_project_index())
    return {
        "ok": True,
        "source": source,
        "folders": payload["folders"],
        "project_paths": payload["project_paths"],
    }


def update_project_folders(source: str, folders_input: List[str], project_paths_input: List[str]) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    folders, _ = _normalize_folder_structure_entry({"folders": list(folders_input) if folders_input else []})
    _, project_paths = _normalize_folder_structure_entry({"project_paths": list(project_paths_input) if project_paths_input else []})
    folder_set: set = set(folders)
    for full in project_paths:
        folder, _proj = _split_project_tree_path(full)
        _add_folder_with_parents(folder_set, folder)
    folders_final = sorted(folder_set)

    folder_by_project = {}
    for full in project_paths:
        folder, project = _split_project_tree_path(full)
        if project:
            folder_by_project[project.lower()] = folder
    index_data = _read_project_index()
    projects = []
    for item in index_data["projects"]:
        name = str(item.get("name", "") or "").strip()
        if not name:
            continue
        projects.append({"name": name, "folder": folder_by_project.get(name.lower(), item.get("folder", ""))})
    folder_entries = [_folder_entry_from_path(path) for path in folders_final]

    try:
        _write_project_index({"version": index_data.get("version", 1), "projects": projects, "folders": folder_entries})
        return {"ok": True, "source": source, "folders_count": len(folders_final), "project_paths_count": len(project_paths)}
    except PermissionError:
        raise HTTPException(423, "File is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save project index folders: {str(e)}")


def rename_project_folder(source: str, old_name: str, new_name: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    old_folder = _sanitize_project_dir_name(old_name)
    new_folder = _sanitize_project_dir_name(new_name)
    if not old_folder or not new_folder:
        raise HTTPException(400, "Old name and new name must not be empty.")
    if old_folder == new_folder:
        return {"ok": True, "message": "Names are the same, no rename needed."}

    old_path = os.path.join(config.PROJECT_SETTINGS_DIR, old_folder)
    new_path = os.path.join(config.PROJECT_SETTINGS_DIR, new_folder)

    if not os.path.isdir(old_path):
        return {"ok": True, "message": f"Source folder does not exist: {old_folder}. Nothing to rename."}

    if os.path.exists(new_path):
        raise HTTPException(409, f"Target folder already exists: {new_folder}")

    try:
        os.rename(old_path, new_path)
        safe_append_project_audit_log(
            project_name=new_folder,
            action=f"Renamed project folder from '{old_folder}' to '{new_folder}'",
        )
        return {"ok": True, "old_folder": old_folder, "new_folder": new_folder}
    except PermissionError:
        raise HTTPException(423, "Folder is locked or in use. Cannot rename.")
    except Exception as e:
        raise HTTPException(500, f"Failed to rename folder: {str(e)}")


def duplicate_project_folder(source: str, old_name: str, new_name: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    old_folder = _sanitize_project_dir_name(old_name)
    new_folder = _sanitize_project_dir_name(new_name)
    if not old_folder or not new_folder:
        raise HTTPException(400, "Old name and new name must not be empty.")
    if old_folder.lower() == new_folder.lower():
        raise HTTPException(400, "Old name and new name must be different.")

    old_path = os.path.join(config.PROJECT_SETTINGS_DIR, old_folder)
    new_path = os.path.join(config.PROJECT_SETTINGS_DIR, new_folder)

    if not os.path.isdir(old_path):
        return {"ok": True, "message": f"Source folder does not exist: {old_folder}. Nothing to copy."}
    if os.path.exists(new_path):
        raise HTTPException(409, f"Target folder already exists: {new_folder}")

    root_norm = os.path.normcase(os.path.normpath(old_path))

    def ignore_data_in_root(current_dir: str, names: List[str]) -> List[str]:
        current_norm = os.path.normcase(os.path.normpath(current_dir))
        if current_norm != root_norm:
            return []
        return [name for name in names if name.strip().lower() == "data"]

    try:
        shutil.copytree(old_path, new_path, ignore=ignore_data_in_root)
        new_data_path = os.path.join(new_path, config.PROJECT_DATA_DIR)
        old_data_path = os.path.join(old_path, config.PROJECT_DATA_DIR)
        if os.path.isdir(old_data_path):
            shutil.copytree(old_data_path, new_data_path, dirs_exist_ok=True)
            data_action = "copied"
        else:
            os.makedirs(new_data_path, exist_ok=True)
            data_action = "created"
        safe_append_project_audit_log(
            project_name=new_folder,
            action=f"Duplicated project folder from '{old_folder}'",
        )
        return {
            "ok": True,
            "old_folder": old_folder,
            "new_folder": new_folder,
            "skipped": [],
            "created": [config.PROJECT_DATA_DIR] if data_action == "created" else [],
            "copied": [config.PROJECT_DATA_DIR] if data_action == "copied" else [],
        }
    except FileExistsError:
        raise HTTPException(409, f"Target folder already exists: {new_folder}")
    except PermissionError:
        if os.path.isdir(new_path):
            try:
                shutil.rmtree(new_path)
            except Exception:
                pass
        raise HTTPException(423, "Folder is locked or in use. Cannot duplicate.")
    except Exception as e:
        if os.path.isdir(new_path):
            try:
                shutil.rmtree(new_path)
            except Exception:
                pass
        raise HTTPException(500, f"Failed to duplicate folder: {str(e)}")


def create_project_folder(source: str, name: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    folder = _sanitize_project_dir_name(name)
    if not folder:
        raise HTTPException(400, "Project name must not be empty.")

    folder_path = os.path.join(config.PROJECT_SETTINGS_DIR, folder)
    data_path = os.path.join(folder_path, config.PROJECT_DATA_DIR)
    base_dir = os.path.normcase(os.path.abspath(config.PROJECT_SETTINGS_DIR))
    target_dir = os.path.normcase(os.path.abspath(folder_path))
    if not (target_dir == base_dir or target_dir.startswith(base_dir + os.sep)):
        raise HTTPException(400, "Invalid project folder path.")

    if os.path.exists(folder_path):
        if os.path.isdir(folder_path):
            raise HTTPException(409, f"Target folder already exists: {folder}")
        raise HTTPException(409, f"Target path is not a folder: {folder}")

    try:
        os.makedirs(data_path, exist_ok=False)
        safe_append_project_audit_log(
            project_name=folder,
            action="Created empty project folder",
        )
        return {
            "ok": True,
            "created_folder": folder,
            "created": [config.PROJECT_DATA_DIR],
        }
    except FileExistsError:
        raise HTTPException(409, f"Target folder already exists: {folder}")
    except PermissionError:
        if os.path.isdir(folder_path):
            try:
                shutil.rmtree(folder_path)
            except Exception:
                pass
        raise HTTPException(423, "Folder is locked or in use. Cannot create project folder.")
    except Exception as e:
        if os.path.isdir(folder_path):
            try:
                shutil.rmtree(folder_path)
            except Exception:
                pass
        raise HTTPException(500, f"Failed to create project folder: {str(e)}")


def delete_project_folder(source: str, name: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    folder = _sanitize_project_dir_name(name)
    if not folder:
        raise HTTPException(400, "Project name must not be empty.")

    folder_path = os.path.join(config.PROJECT_SETTINGS_DIR, folder)
    base_dir = os.path.normcase(os.path.abspath(config.PROJECT_SETTINGS_DIR))
    target_dir = os.path.normcase(os.path.abspath(folder_path))
    if not (target_dir == base_dir or target_dir.startswith(base_dir + os.sep)):
        raise HTTPException(400, "Invalid project folder path.")

    if not os.path.exists(folder_path):
        return {"ok": True, "message": f"Folder does not exist: {folder}. Nothing to delete."}
    if not os.path.isdir(folder_path):
        raise HTTPException(409, f"Target path is not a folder: {folder}")

    try:
        shutil.rmtree(folder_path)
        return {"ok": True, "deleted_folder": folder}
    except FileNotFoundError:
        return {"ok": True, "message": f"Folder does not exist: {folder}. Nothing to delete."}
    except PermissionError:
        raise HTTPException(423, "Folder is locked or in use. Cannot delete.")
    except Exception as e:
        raise HTTPException(500, f"Failed to delete folder: {str(e)}")


def open_project_folder(source: str, project_name: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "project_name is required.")

    try:
        project_dir = os.path.dirname(config.get_general_settings_path(project_name_clean))
    except ValueError as e:
        raise HTTPException(404, str(e))

    if not os.path.isdir(project_dir):
        raise HTTPException(404, f"Project folder not found under projects: {project_name_clean}")

    try:
        _open_folder_in_explorer(project_dir)
        return {
            "ok": True,
            "project_name": project_name_clean,
            "path": project_dir,
        }
    except PermissionError:
        raise HTTPException(423, "Project folder is locked or inaccessible.")
    except FileNotFoundError:
        raise HTTPException(500, "File explorer command is not available on this system.")
    except Exception as e:
        raise HTTPException(500, f"Failed to open project folder: {str(e)}")


def get_project_settings(source: str) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    filepath = _project_index_path()

    if not os.path.exists(filepath):
        raise HTTPException(404, f"Project index file not found: {filepath}")

    st = os.stat(filepath)
    data = project_index_to_sheet_data(_read_project_index())

    return {
        "ok": True,
        "source": source,
        "path": filepath,
        "mtime": st.st_mtime,
        "data": data,
    }


def update_project_settings(source: str, data: Dict[str, Any], file_mtime: float = None) -> Dict[str, Any]:
    if source not in config.PROJECT_SETTINGS_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")

    filepath = _project_index_path()

    if os.path.exists(filepath):
        st = os.stat(filepath)
        if file_mtime is not None and abs(st.st_mtime - file_mtime) > 0.001:
            raise HTTPException(409, "File was modified by another user. Please refresh and try again.")

    try:
        index_data = update_project_index_from_sheet_data(data)
        _write_project_index(index_data)

        st2 = os.stat(filepath)
        return {
            "ok": True,
            "source": source,
            "path": filepath,
            "mtime": st2.st_mtime,
        }
    except PermissionError:
        raise HTTPException(423, "File is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save: {str(e)}")


def get_general_settings(project_name: str) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "project_name is required")

    try:
        filepath = config.get_general_settings_path(project_name_clean)
    except ValueError as e:
        raise HTTPException(404, str(e))
    project_folder_name = os.path.basename(os.path.dirname(filepath))

    if not os.path.exists(filepath):
        data = _normalize_general_settings_payload({}, project_folder_name, default_auto_generated=True)
        data["project_folder_name"] = project_folder_name
        data["project_name_mismatch"] = False
        return {
            "ok": True,
            "exists": False,
            "path": filepath,
            "data": data,
        }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        data = _normalize_general_settings_payload(raw, project_folder_name, default_auto_generated=False)
        data["project_folder_name"] = project_folder_name
        data["project_name_mismatch"] = _normalize_ci(data.get("project_name")) != _normalize_ci(project_folder_name)
        if isinstance(raw, dict):
            updated_at = str(raw.get("updated_at", "") or "").strip()
            if updated_at:
                data["updated_at"] = updated_at
        return {"ok": True, "exists": True, "path": filepath, "data": data}
    except Exception as e:
        raise HTTPException(500, f"Failed to read general settings: {str(e)}")


def update_general_settings(
    project_name: str,
    origin_start_date: str = "",
    origin_end_date: str = "",
    development_end_date: str = "",
    auto_generated: bool = False,
) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "project_name is required")

    try:
        filepath = config.get_general_settings_path(project_name_clean)
    except ValueError as e:
        raise HTTPException(404, str(e))
    project_folder_name = os.path.basename(os.path.dirname(filepath))

    payload = _normalize_general_settings_payload(
        {
            "project_name": project_folder_name,
            "origin_start_date": origin_start_date,
            "origin_end_date": origin_end_date,
            "development_end_date": development_end_date,
            "auto_generated": auto_generated,
        },
        project_folder_name,
        default_auto_generated=_normalize_bool_like(auto_generated, False),
    )
    payload["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        tmp_path = filepath + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, filepath)
        safe_append_project_audit_log(
            project_name=project_name_clean,
            action="Saved General Settings (Origin/Development date boundaries)",
        )
        response_data = dict(payload)
        response_data["project_folder_name"] = project_folder_name
        response_data["project_name_mismatch"] = False
        return {"ok": True, "path": filepath, "data": response_data}
    except PermissionError:
        raise HTTPException(423, "General settings file is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to save general settings: {str(e)}")


def list_project_settings_sources() -> Dict[str, Any]:
    sources = []
    for key, filename in config.PROJECT_SETTINGS_SOURCES.items():
        filepath = _project_index_path() if filename == config.PROJECT_INDEX_FILE else os.path.join(config.PROJECT_SETTINGS_DIR, filename)
        exists = os.path.exists(filepath)
        sources.append({
            "key": key,
            "filename": filename,
            "path": filepath,
            "exists": exists,
        })
    return {"sources": sources}
