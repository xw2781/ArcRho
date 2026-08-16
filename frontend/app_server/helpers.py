"""Utility functions: sanitizers, VBA-compat helpers, file utilities.

Imports only from ``app_server.config`` (and stdlib).
"""
from __future__ import annotations

import os
import re
import json
import time
import uuid
import getpass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
from fastapi import HTTPException

from app_server import config

try:
    from watchdog.observers import Observer  # type: ignore
    from watchdog.events import FileSystemEventHandler  # type: ignore
except Exception:  # optional dependency
    Observer = None
    FileSystemEventHandler = None


_WINDOWS_DRIVE_REMOTE = 4


def _windows_drive_type(root_path: str) -> int:
    """Return the Windows drive type for an absolute drive root."""
    import ctypes

    return int(ctypes.windll.kernel32.GetDriveTypeW(root_path))


def is_network_path(path: str) -> bool:
    """Whether *path* is a UNC path or resides on a mapped Windows network drive.

    Windows file-system notifications are not reliable enough on SMB shares for a
    synchronous request-result wait.  Detect a mapped drive through the Windows
    drive type instead of relying on its drive letter, which is user-specific.
    """
    text = os.fspath(path)
    if text.startswith(("\\\\", "//")):
        return True
    if os.name != "nt":
        return False

    drive, _ = os.path.splitdrive(text)
    if not drive:
        return False
    try:
        return _windows_drive_type(f"{drive}\\") == _WINDOWS_DRIVE_REMOTE
    except (AttributeError, OSError):
        return False


# ---------------------------------------------------------------------------
# String / filename sanitizers
# ---------------------------------------------------------------------------

def _sanitize_folder_name(name: str) -> str:
    return config._sanitize_folder_name(name)


def _sanitize_project_dir_name(name: str) -> str:
    return config._sanitize_project_dir_name(name)


def _sanitize_filename(name: str) -> str:
    out = config.encode_filename_segment((name or "").strip())
    return out.strip() or "workflow"


def sanitize_reserving_class_folder(value: Any, fallback: str = "ReservingClass") -> str:
    return config.sanitize_reserving_class_folder(value, fallback)


def sanitize_dataset_file_name(value: Any, fallback: str = "Dataset") -> str:
    text = str(value if value is not None else "").strip()
    text = config.encode_filename_segment(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or fallback


def _request_bool_suffix(value: Any, true_suffix: str, false_suffix: str) -> str:
    text = str(value if value is not None else "").strip().lower()
    return true_suffix if text in {"true", "yes", "1"} else false_suffix


def build_length_scoped_dataset_file_name(
    dataset_name: Any,
    origin_length: Any,
    development_length: Any,
    cumulative: Any = True,
    calendar: Any = False,
) -> str:
    dataset_file = sanitize_dataset_file_name(dataset_name)
    origin = str(origin_length if origin_length is not None else "").strip()
    development = str(development_length if development_length is not None else "").strip()
    if origin and development:
        cum_suffix = _request_bool_suffix(cumulative, "cum", "inc")
        cal_suffix = _request_bool_suffix(calendar, "cal", "dev")
        return f"{dataset_file}@{origin}@{development}@{cum_suffix}@{cal_suffix}"
    return dataset_file


def build_dataset_cache_file_name(
    dataset_name: Any,
    data_format: Any,
    origin_length: Any,
    development_length: Any,
    cumulative: Any = True,
    calendar: Any = False,
) -> str:
    dataset_file = sanitize_dataset_file_name(dataset_name)
    if str(data_format or "").strip().lower() == "vector":
        period = str(origin_length if origin_length is not None else "").strip()
        return f"{dataset_file}@{period}" if period else dataset_file
    return build_length_scoped_dataset_file_name(
        dataset_name,
        origin_length,
        development_length,
        cumulative,
        calendar,
    )


# ---------------------------------------------------------------------------
# VBA-compat helpers
# ---------------------------------------------------------------------------

def set_data_path_like_vba(pairs: list[tuple[str, str]]) -> str:
    proj = ""
    function_name = ""
    reserving_class = ""
    dataset_name = ""
    instance_name = ""
    origin_length = ""
    development_length = ""
    cumulative = True
    calendar = False
    values = []
    for k, v in pairs:
        key = (k or "").strip().lower()
        value = (v or "").strip()
        if key == "projectname":
            proj = value
        elif key == "function":
            function_name = value
            values.append(value)
        elif key == "path":
            reserving_class = value
            values.append(value)
        elif key in {"datasetname", "trianglename"}:
            dataset_name = value
            values.append(value)
        elif key == "instancename":
            instance_name = value
            values.append(value)
        elif key == "originlength":
            origin_length = value
            values.append(value)
        elif key == "developmentlength":
            development_length = value
            values.append(value)
        elif key == "cumulative":
            cumulative = value
            values.append(value)
        elif key == "calendar":
            calendar = value
            values.append(value)
        else:
            values.append(value)

    normalized_function_name = function_name.strip().lower()
    if normalized_function_name in {"arcrhotri", "arcrhovec"} and reserving_class and dataset_name:
        dataset_file = build_dataset_cache_file_name(
            instance_name or dataset_name,
            "Vector" if normalized_function_name == "arcrhovec" else "Triangle",
            origin_length,
            development_length,
            cumulative,
            calendar,
        )
        if proj:
            project_data_dir = config.get_project_dataset_cache_dir(proj, reserving_class)
        else:
            project_data_dir = os.path.join(
                config.PROJECT_SETTINGS_DIR.rstrip("\\/"),
                config.PROJECT_DATA_DIR,
                sanitize_reserving_class_folder(reserving_class),
                config.DATASET_CACHE_DIR,
            )
        return os.path.join(project_data_dir, f"{dataset_file}.csv")

    full_name = config.encode_filename_segment("@".join(values))

    if proj:
        return os.path.join(config.get_project_data_dir(proj), f"{full_name}.csv")
    return os.path.join(config.PROJECT_SETTINGS_DIR.rstrip("\\/"), config.PROJECT_DATA_DIR, f"{full_name}.csv")


def build_engine_request_info(pairs: list, data_path: str) -> str:
    """Return the legacy ``key = value#...`` request line for one Engine request.

    The Engine reads the request file the app server publishes; ``DataPath``
    is the output CSV the caller waits for and always comes last so a
    hosted publisher can supply the pairs and derive the path itself.
    """

    return "#".join([f"{k} = {v}" for k, v in pairs] + [f"DataPath = {data_path}"])


def send_request_like_vba(request_info: str) -> str:
    # ``config.REQUEST_DIR`` is the requests root the Engine watches. When the
    # publisher is the Gateway acting for a Client PC user, that root is the
    # server's own local folder and the stamped user is the acting identity.
    from app_server.services import user_identity_service

    os.makedirs(config.REQUEST_DIR, exist_ok=True)
    now = datetime.now()
    ms = int(now.microsecond / 1000)
    current_time = now.strftime("%Y-%m-%d_%H-%M-%S") + f".{ms:03d}"

    temp_path = os.path.join(config.REQUEST_DIR, f"request-{current_time}.tmp")
    final_path = os.path.join(config.REQUEST_DIR, f"request-{current_time}.json")

    payload = _request_info_to_json_payload(request_info)
    payload["UserName"] = user_identity_service.get_windows_login_name() or getpass.getuser()

    with open(temp_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")

    if os.path.exists(final_path):
        try:
            os.remove(final_path)
        except OSError:
            try:
                os.remove(temp_path)
            except OSError:
                pass
            raise HTTPException(409, "Request file name collision and cannot overwrite.")

    os.replace(temp_path, final_path)
    return final_path


def _request_info_to_json_payload(request_info: str) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    for raw_line in request_info.split("#"):
        line = raw_line.strip()
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            payload[key] = _native_request_value(key, value.strip())
    return payload


def _native_request_value(key: str, value: str) -> Any:
    normalized_key = key.strip().lower()
    lowered = value.lower()
    if normalized_key in {"cumulative", "transposed", "calendar", "rpcserverwriteconfirmed"}:
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    if normalized_key in {"originlength", "developmentlength", "periodlength", "storedperiodlength", "decimalplaces"}:
        if re.fullmatch(r"-?\d+", value):
            return int(value)
    return value


_WAIT_POLL_INITIAL_SEC = 0.1
_WAIT_POLL_MAX_SEC = 0.5
_WAIT_POLL_BACKOFF = 1.5


def _bust_network_lookup_cache(directory: str) -> bool:
    """Invalidate the SMB redirector's cached lookups for *directory*.

    The Windows SMB client caches negative lookups for several seconds
    (``FileNotFoundCacheLifetime``, default 5s), so polling ``os.path.exists``
    for an engine response file keeps seeing a stale miss long after the file
    was written on the server. A client-side write in the same directory drops
    that cached state, so the next existence check reaches the server. Returns
    False when the probe cannot be written so callers can stop paying for it.
    """
    probe = os.path.join(directory, f".arcrho-visibility-probe-{uuid.uuid4().hex}.tmp")
    try:
        with open(probe, "w", encoding="ascii"):
            pass
    except OSError:
        return False
    try:
        os.remove(probe)
    except OSError:
        pass
    return True


def wait_for_file(path: str, timeout_sec: float, settle_ms: float = 50.0) -> bool:
    timeout = max(0.0, float(timeout_sec))
    deadline = time.monotonic() + timeout
    found = False

    if os.path.exists(path):
        found = True
    elif not is_network_path(path):
        try:
            if Observer is None or FileSystemEventHandler is None:
                raise RuntimeError("watchdog not available")
            target = Path(path)
            watch_dir = str(target.parent)
            target_name = target.name

            from threading import Event
            hit = Event()

            class _Handler(FileSystemEventHandler):
                def on_created(self, event) -> None:
                    if os.path.basename(event.src_path) == target_name:
                        hit.set()

                def on_moved(self, event) -> None:
                    if os.path.basename(event.dest_path) == target_name:
                        hit.set()

            handler = _Handler()
            observer = Observer()
            observer.schedule(handler, watch_dir, recursive=False)
            observer.start()
            try:
                hit.wait(timeout=max(0.0, deadline - time.monotonic()))
                found = os.path.exists(path)
            finally:
                observer.stop()
                observer.join(timeout=1.0)
        except Exception:
            pass

    if not found:
        poke_dir = os.path.dirname(path) or "."
        poke_enabled = is_network_path(path)
        interval = _WAIT_POLL_INITIAL_SEC
        while time.monotonic() <= deadline:
            if poke_enabled:
                poke_enabled = _bust_network_lookup_cache(poke_dir)
            if os.path.exists(path):
                found = True
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(interval, remaining))
            interval = min(interval * _WAIT_POLL_BACKOFF, _WAIT_POLL_MAX_SEC)

    if found and settle_ms > 0:
        time.sleep(settle_ms / 1000.0)

    return found


def parse_method_last_modified_timestamp(value: Any) -> Optional[float]:
    """Canonical epoch parse for a method JSON ``last modified`` value.

    ResQ writes its ``Modified`` value as a timezone-less wall-clock string in
    the machine's own timezone, while an ArcRho save writes an absolute ISO
    value carrying ``Z`` or an offset. A timezone-less value is therefore read
    as local time, so both sides land on the same instant the sync review
    window renders for them.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        raw_number = float(value)
        return raw_number if raw_number > 0 else None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        raw_number = float(raw)
    except ValueError:
        raw_number = None
    if raw_number is not None:
        return raw_number if raw_number > 0 else None

    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed.timestamp()


# ---------------------------------------------------------------------------
# File utilities
# ---------------------------------------------------------------------------

def atomic_write_csv(df: pd.DataFrame, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    df.to_csv(tmp, index=False, header=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Tree / preference normalizers
# ---------------------------------------------------------------------------

def _norm_tree_path(value: Any) -> str:
    s = str(value or "").strip().replace("/", "\\")
    if not s:
        return ""
    parts = [p.strip() for p in s.split("\\") if p and p.strip()]
    return "\\".join(parts)


def _split_project_tree_path(path_value: Any) -> Tuple[str, str]:
    full = _norm_tree_path(path_value)
    if not full:
        return ("", "")
    parts = full.split("\\")
    if not parts:
        return ("", "")
    if len(parts) == 1:
        return ("", parts[0])
    return ("\\".join(parts[:-1]), parts[-1])


def _add_folder_with_parents(path_set: set, folder_path: str) -> None:
    f = _norm_tree_path(folder_path)
    if not f:
        return
    parts = f.split("\\")
    for i in range(1, len(parts) + 1):
        path_set.add("\\".join(parts[:i]))


def _normalize_folder_structure_entry(entry: Any) -> Tuple[List[str], List[str]]:
    folders_raw: Any = []
    project_paths_raw: Any = []
    if isinstance(entry, dict):
        folders_raw = entry.get("folders", [])
        project_paths_raw = entry.get("project_paths", [])

    folders: List[str] = []
    seen_folders: set[str] = set()
    if isinstance(folders_raw, list):
        for item in folders_raw:
            p = _norm_tree_path(item)
            if not p:
                continue
            key = p.lower()
            if key in seen_folders:
                continue
            seen_folders.add(key)
            folders.append(p)

    project_paths: List[str] = []
    seen_projects: set[str] = set()
    if isinstance(project_paths_raw, list):
        for item in project_paths_raw:
            full = _norm_tree_path(item)
            folder, project = _split_project_tree_path(full)
            if not project:
                continue
            final_full = f"{folder}\\{project}" if folder else project
            key = final_full.lower()
            if key in seen_projects:
                continue
            seen_projects.add(key)
            project_paths.append(final_full)

    return (folders, project_paths)


def _canon_project_pref_key(project_name: Any) -> str:
    return config._sanitize_project_dir_name(str(project_name or "").strip()).strip().lower()


def _canon_dataset_name(name: Any) -> str:
    s = str(name or "").strip().strip('"').strip("'")
    s = re.sub(r"\s+", " ", s)
    return s.lower()


def _canon_reserving_class_type_name(name: Any) -> str:
    return _canon_dataset_name(name)


def _canon_reserving_filter_key(value: Any) -> str:
    key = str(value or "").strip().lower()
    if not key:
        return ""
    key = re.sub(r"\s+", " ", key)
    return key


# ---------------------------------------------------------------------------
# Reserving hidden-path / filter-spec normalizers
# ---------------------------------------------------------------------------

def _normalize_reserving_hidden_path_list(raw_paths: Any) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    if not isinstance(raw_paths, list):
        return out
    for raw in raw_paths:
        path = _norm_tree_path(raw)
        if not path:
            continue
        key = path.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    out.sort(key=lambda x: x.lower())
    return out


def _normalize_reserving_filter_spec(raw_spec: Any) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    if not isinstance(raw_spec, dict):
        return out

    for raw_level, raw_values in raw_spec.items():
        try:
            level_num = int(str(raw_level).strip())
        except Exception:
            continue
        if level_num < 1:
            continue

        values = raw_values if isinstance(raw_values, list) else [raw_values]
        seen: set[str] = set()
        keys: List[str] = []
        for raw in values:
            key = _canon_reserving_filter_key(raw)
            if not key or key in seen:
                continue
            seen.add(key)
            keys.append(key)

        if not keys:
            continue
        keys.sort()
        out[str(level_num)] = keys

    out_sorted: Dict[str, List[str]] = {}
    for level in sorted(out.keys(), key=lambda x: int(x)):
        out_sorted[level] = out[level]
    return out_sorted


def _normalize_reserving_filter_preferences(raw_prefs: Any) -> Dict[str, Any]:
    prefs = raw_prefs if isinstance(raw_prefs, dict) else {}
    raw_auto_expand = prefs.get("auto_expand_single_child", prefs.get("autoExpandSingleChild", None))
    raw_hide_segment_labels = prefs.get("hide_segment_labels", prefs.get("hideSegmentLabels", None))
    raw_select_double = prefs.get("select_on_double_click", prefs.get("selectOnDoubleClick", None))
    raw_tree_window_width = prefs.get(
        "tree_window_width",
        prefs.get("treeWindowWidth", prefs.get("window_width", prefs.get("windowWidth", None))),
    )
    raw_tree_window_height = prefs.get(
        "tree_window_height",
        prefs.get("treeWindowHeight", prefs.get("window_height", prefs.get("windowHeight", None))),
    )
    raw_filter_window_width = prefs.get(
        "filter_window_width",
        prefs.get(
            "filterWindowWidth",
            prefs.get("filters_window_width", prefs.get("filtersWindowWidth", None)),
        ),
    )
    raw_filter_window_height = prefs.get(
        "filter_window_height",
        prefs.get(
            "filterWindowHeight",
            prefs.get("filters_window_height", prefs.get("filtersWindowHeight", None)),
        ),
    )
    raw_favorite_paths = prefs.get(
        "favorite_paths",
        prefs.get(
            "favoritePaths",
            prefs.get("favorites", prefs.get("favorite_nodes", prefs.get("favoriteNodes", []))),
        ),
    )
    raw_favorite_nicknames = prefs.get(
        "favorite_nicknames",
        prefs.get("favoriteNicknames", prefs.get("favorite_labels", prefs.get("favoriteLabels", {}))),
    )
    raw_favorite_folders = prefs.get(
        "favorite_folders",
        prefs.get("favoriteFolders", prefs.get("favorite_groups", prefs.get("favoriteGroups", []))),
    )

    def _to_bool(raw: Any, default: bool = True) -> bool:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        raw_text = str(raw or "").strip().lower()
        if raw_text in {"1", "true", "yes", "on"}:
            return True
        if raw_text in {"0", "false", "no", "off"}:
            return False
        return default

    def _to_optional_size(raw: Any, min_value: int, max_value: int) -> Optional[int]:
        try:
            val = int(float(raw))
        except Exception:
            return None
        if val < min_value:
            return None
        if val > max_value:
            return max_value
        return val

    out: Dict[str, Any] = {
        "auto_expand_single_child": _to_bool(raw_auto_expand),
        "hide_segment_labels": _to_bool(raw_hide_segment_labels, False),
        "select_on_double_click": _to_bool(raw_select_double),
    }
    window_width = _to_optional_size(raw_tree_window_width, 320, 2400)
    window_height = _to_optional_size(raw_tree_window_height, 240, 1800)
    if window_width is not None:
        out["tree_window_width"] = window_width
    if window_height is not None:
        out["tree_window_height"] = window_height
    filter_window_width = _to_optional_size(raw_filter_window_width, 360, 2400)
    filter_window_height = _to_optional_size(raw_filter_window_height, 260, 1800)
    if filter_window_width is not None:
        out["filter_window_width"] = filter_window_width
    if filter_window_height is not None:
        out["filter_window_height"] = filter_window_height
    favorite_paths = _normalize_reserving_hidden_path_list(raw_favorite_paths)
    if favorite_paths:
        out["favorite_paths"] = favorite_paths
    if isinstance(raw_favorite_nicknames, dict) and favorite_paths:
        favorite_keys = {_norm_tree_path(path).casefold(): path for path in favorite_paths}
        favorite_nicknames: Dict[str, str] = {}
        for raw_key, raw_value in raw_favorite_nicknames.items():
            path_key = _norm_tree_path(raw_key).casefold()
            path = favorite_keys.get(path_key)
            if not path:
                continue
            nickname = str(raw_value or "").strip()
            if nickname:
                favorite_nicknames[path] = nickname[:120]
        if favorite_nicknames:
            out["favorite_nicknames"] = favorite_nicknames
    if isinstance(raw_favorite_folders, list):
        favorite_keys = {_norm_tree_path(path).casefold(): path for path in favorite_paths}
        seen_folder_ids = set()
        assigned_path_keys = set()
        favorite_folders: List[Dict[str, Any]] = []
        for raw_folder in raw_favorite_folders:
            if not isinstance(raw_folder, dict):
                continue
            name = str(raw_folder.get("name", raw_folder.get("label", "")) or "").strip()[:120]
            if not name:
                continue
            folder_id = str(raw_folder.get("id", raw_folder.get("key", "")) or "").strip()[:80]
            if not folder_id or folder_id in seen_folder_ids:
                folder_id = f"folder-{len(favorite_folders) + 1}"
            seen_folder_ids.add(folder_id)
            paths: List[str] = []
            raw_paths = raw_folder.get("paths", [])
            if isinstance(raw_paths, list):
                for raw_path in raw_paths:
                    path_key = _norm_tree_path(raw_path).casefold()
                    path = favorite_keys.get(path_key)
                    if not path or path_key in assigned_path_keys:
                        continue
                    assigned_path_keys.add(path_key)
                    paths.append(path)
            favorite_folders.append({
                "id": folder_id,
                "name": name,
                "paths": paths,
            })
        if favorite_folders:
            out["favorite_folders"] = favorite_folders
    return out


def _is_default_reserving_filter_preferences(raw_prefs: Any) -> bool:
    prefs = _normalize_reserving_filter_preferences(raw_prefs)
    return (
        bool(prefs.get("auto_expand_single_child", True))
        and not bool(prefs.get("hide_segment_labels", False))
        and bool(prefs.get("select_on_double_click", True))
        and prefs.get("tree_window_width", None) is None
        and prefs.get("tree_window_height", None) is None
        and prefs.get("filter_window_width", None) is None
        and prefs.get("filter_window_height", None) is None
        and not bool(prefs.get("favorite_paths", []))
        and not bool(prefs.get("favorite_nicknames", {}))
        and not bool(prefs.get("favorite_folders", []))
    )


# ---------------------------------------------------------------------------
# Excel cell / sheet formatting helpers
# ---------------------------------------------------------------------------

def _format_excel_cell_as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
    return str(value)


def _normalize_sheet_columns(raw_columns: Any, fallback: List[str]) -> List[str]:
    cols: List[str] = []
    for idx, raw in enumerate(raw_columns if isinstance(raw_columns, list) else []):
        name = str(raw if raw is not None else "").strip()
        if not name:
            name = f"Column {idx + 1}"
        cols.append(name)
    if not cols:
        return list(fallback)
    return cols


def _normalize_sheet_rows(raw_rows: Any, width: int) -> List[List[str]]:
    out: List[List[str]] = []
    for raw in raw_rows if isinstance(raw_rows, list) else []:
        if not isinstance(raw, list):
            continue
        row: List[str] = []
        for idx in range(width):
            value = raw[idx] if idx < len(raw) else ""
            row.append(str(value if value is not None else "").strip())
        if any(cell != "" for cell in row):
            out.append(row)
    return out


def _normalize_formula_operator_spacing(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    segments = re.findall(r'"[^"]*"|[^"]+', text)
    normalized_segments: List[str] = []
    for segment in segments:
        if len(segment) >= 2 and segment.startswith('"') and segment.endswith('"'):
            normalized_segments.append(segment)
            continue
        normalized = re.sub(r"\s*([+\-*/])\s*", r" \1 ", segment)
        normalized = re.sub(r"\s+", " ", normalized)
        if not normalized_segments:
            normalized = normalized.lstrip()
        normalized_segments.append(normalized)
    return "".join(normalized_segments).strip()


def _parse_positive_int(value: Any) -> Optional[int]:
    try:
        n = int(str(value if value is not None else "").strip())
        return n if n >= 1 else None
    except Exception:
        return None


def _parse_calculated_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    s = str(value if value is not None else "").strip().lower()
    return s in ("true", "1", "yes", "y")
