"""Path and filename helpers shared by the ArcRho API package."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

RESERVING_CLASS_INDEX_FILE_NAME = "index.json"
DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"


def clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def sanitize_project_dir_name(value: Any, fallback: str = "UnknownProject") -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", clean_text(value))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or fallback


def sanitize_file_name_part(value: Any, fallback: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", clean_text(value))
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or fallback


def sanitize_reserving_class_folder(value: Any, fallback: str = "ReservingClass") -> str:
    cleaned = clean_text(value)
    cleaned = cleaned.replace("\\", "_%5C_").replace("/", "_%2F_")
    cleaned = re.sub(r'[<>:"|?*\x00-\x1f]+', "_", cleaned)
    cleaned = re.sub(r"[. ]+$", "", cleaned).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or fallback


def dataset_filename(dataset_name: Any) -> str:
    return f"{sanitize_file_name_part(dataset_name, 'Dataset')}.csv"


def dfm_filename(method_name: Any) -> str:
    name_part = sanitize_file_name_part(method_name, "Name")
    return f"DFM@{name_part}.json"


def parse_dfm_filename(filename: str) -> str | None:
    if not filename.startswith("DFM@") or not filename.endswith(".json"):
        return None
    stem = filename[:-5]
    parts = stem.split("@")
    if len(parts) < 2:
        return None
    method_name = "@".join(parts[1:]).strip()
    if not method_name:
        return None
    return method_name


def project_dir_case_insensitive(projects_dir: Path, project_name: str) -> Path | None:
    wanted = clean_text(project_name)
    if not wanted or not projects_dir.exists():
        return None
    direct = projects_dir / wanted
    if direct.is_dir():
        return direct
    wanted_lower = wanted.lower()
    for item in projects_dir.iterdir():
        if item.is_dir() and item.name.lower() == wanted_lower:
            return item
    sanitized = sanitize_project_dir_name(wanted)
    direct = projects_dir / sanitized
    if direct.is_dir():
        return direct
    sanitized_lower = sanitized.lower()
    for item in projects_dir.iterdir():
        if item.is_dir() and item.name.lower() == sanitized_lower:
            return item
    return None
