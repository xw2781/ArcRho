"""Path and filename helpers shared by the ArcRho API package."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .dataset_index_contract import (
    INDEX_FILE_NAME,
    canonical_existing_directory,
)
from .dfm_contract import DFM_JSON_FORMAT, LEGACY_DFM_JSON_FORMAT


RESERVING_CLASS_INDEX_FILE_NAME = INDEX_FILE_NAME
_FILENAME_REPLACEMENTS = {
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


def clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def sanitize_project_dir_name(value: Any, fallback: str = "UnknownProject") -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", clean_text(value))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or fallback


def sanitize_file_name_part(value: Any, fallback: str) -> str:
    out = []
    for ch in clean_text(value):
        if ch in _FILENAME_REPLACEMENTS:
            out.append(_FILENAME_REPLACEMENTS[ch])
        elif ord(ch) < 32:
            out.append(f"_%{ord(ch):02X}_")
        else:
            out.append(ch)
    cleaned = re.sub(r"\s+", " ", "".join(out)).strip()
    return cleaned or fallback


def decode_file_name_part(value: Any) -> str:
    def repl(match: re.Match[str]) -> str:
        try:
            return chr(int(match.group(1), 16))
        except ValueError:
            return match.group(0)

    return re.sub(r"_%([0-9A-Fa-f]{2})_", repl, clean_text(value))


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
    method_name = decode_file_name_part("@".join(parts[1:]).strip())
    if not method_name:
        return None
    return method_name


def project_dir_case_insensitive(projects_dir: Path, project_name: str) -> Path | None:
    wanted = clean_text(project_name)
    if not wanted or not projects_dir.exists():
        return None
    direct = projects_dir / wanted
    if direct.is_dir():
        return canonical_existing_directory(direct) or direct
    wanted_lower = wanted.lower()
    for item in projects_dir.iterdir():
        if item.is_dir() and item.name.lower() == wanted_lower:
            return item
    sanitized = sanitize_project_dir_name(wanted)
    direct = projects_dir / sanitized
    if direct.is_dir():
        return canonical_existing_directory(direct) or direct
    sanitized_lower = sanitized.lower()
    for item in projects_dir.iterdir():
        if item.is_dir() and item.name.lower() == sanitized_lower:
            return item
    return None
