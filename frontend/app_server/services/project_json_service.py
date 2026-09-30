"""Read-only Project Instance JSON views, loaded on the server."""

import json
from pathlib import Path

from fastapi import HTTPException

from app_server import config


def read_project_json(project_name: str, reserving_class: str, folder: str, filename: str) -> dict:
    builders = {
        "methods": config.get_project_method_data_dir,
        "sidecars": config.get_project_dataset_sidecar_dir,
    }
    if folder not in builders or Path(filename).name != filename or not filename.endswith(".json"):
        raise HTTPException(400, "Choose a method JSON file or dataset sidecar.")
    root = Path(builders[folder](project_name, reserving_class)).resolve()
    path = (root / filename).resolve()
    if path.parent != root:
        raise HTTPException(400, "The JSON file must be inside its reserving class.")
    try:
        return {"name": filename, "data": json.loads(path.read_text(encoding="utf-8-sig"))}
    except FileNotFoundError as exc:
        raise HTTPException(404, f"JSON file not found: {filename}") from exc
