"""The batch import's existing-class inventory, read on the server."""

import json
from pathlib import Path
from typing import Any

from app_server import config
from arcrho_api.paths import RESERVING_CLASS_INDEX_FILE_NAME


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (FileNotFoundError, PermissionError, OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def existing_class_counts(project_name: str) -> dict[str, int | None]:
    """Casefolded class path -> indexed item count for every class folder held.

    The folder name is an encoded form of the class path, so the canonical
    spelling comes from each class's own ``index.json`` when it has one and is
    only decoded from the folder name when it does not — the same rule the
    Engine's source-refresh job applies when it enumerates a project. The
    lookup only tells a listed class that already exists from one that is new;
    classes outside the fixed list are never offered.
    """

    from arcrho_api.dataset_index_contract import decode_filename_segment

    data_dir = Path(config.get_project_data_dir(project_name))
    try:
        entries = [entry for entry in data_dir.iterdir() if entry.is_dir()]
    except FileNotFoundError:
        return {}

    counts: dict[str, int | None] = {}
    for entry in entries:
        if entry.name.startswith("."):
            continue
        index_payload = _read_json(entry / RESERVING_CLASS_INDEX_FILE_NAME)
        name = ""
        dataset_count = None
        if index_payload is not None:
            name = str(index_payload.get("reserving_class") or "").strip()
            files = index_payload.get("files")
            if isinstance(files, list):
                dataset_count = len(files)
        if not name:
            name = decode_filename_segment(entry.name).strip()
        key = name.casefold()
        if not name or key in counts:
            continue
        counts[key] = dataset_count
    return counts

