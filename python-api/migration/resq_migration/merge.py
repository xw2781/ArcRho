"""Preserve ArcRho-owned or newer artifacts during a staged ResQ import."""

from __future__ import annotations

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from arcrho_api.dataset_index_contract import (
    METHOD_DIR_NAME,
    _method_entry_from_payload as _canonical_method_entry_from_payload,
)

from .catalog import _dataset_type_keys
from .core import (
    DATASET_CACHE_DIR,
    DATASET_SIDECAR_DIR,
    _cached_dataset_names_from_file,
    _normalize_cached_dataset_name,
    _normalize_import_name,
)


_MAX_IO_WORKERS = 8
_ARTIFACT_FOLDERS = (
    (DATASET_CACHE_DIR, ".csv"),
    (METHOD_DIR_NAME, ".json"),
    (DATASET_SIDECAR_DIR, ".json"),
)


def _read_artifact_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _artifact_datetime(value: object) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.timestamp()


def _artifact_modified_timestamp(payload: dict, fallback_timestamp: float) -> tuple[float, bool]:
    source_kind = str(payload.get("source_kind") or "").strip().casefold()
    if source_kind == "engine":
        source_modified = _artifact_datetime(payload.get("source_modified"))
        if source_modified:
            return source_modified, True

    containers = []
    for key in ("method_metadata", "method_metadata"):
        value = payload.get(key)
        if isinstance(value, dict):
            containers.append(value)
    containers.append(payload)
    for container in containers:
        for key in (
            "last_modified",
            "last_modified",
            "modified_at",
            "modified",
            "updated_at",
            "updated",
        ):
            timestamp = _artifact_datetime(container.get(key))
            if timestamp:
                return timestamp, True
    return fallback_timestamp, False


def _artifact_group(groups: dict[str, dict], name: object) -> dict | None:
    display_name = _normalize_import_name(name)
    if not display_name:
        return None
    return groups.setdefault(
        display_name.casefold(),
        {
            "name": display_name,
            "dataset_type": "",
            "metadata_timestamp": 0.0,
            "fallback_timestamp": 0.0,
            "paths": set(),
        },
    )


def _record_artifact(
    groups: dict[str, dict],
    *,
    name: object,
    path: Path,
    fallback_timestamp: float,
    dataset_type: object = "",
    payload: dict | None = None,
) -> None:
    group = _artifact_group(groups, name)
    if group is None:
        return
    group["paths"].add(path)
    normalized_type = _normalize_import_name(dataset_type)
    if normalized_type:
        group["dataset_type"] = normalized_type
    timestamp, from_metadata = _artifact_modified_timestamp(payload or {}, fallback_timestamp)
    timestamp_key = "metadata_timestamp" if from_metadata else "fallback_timestamp"
    group[timestamp_key] = max(float(group[timestamp_key]), timestamp)


def _artifact_file_entries(directory: Path, suffix: str) -> list[tuple[Path, float]]:
    entries: list[tuple[Path, float]] = []
    try:
        with os.scandir(directory) as iterator:
            for item in iterator:
                if not item.name.casefold().endswith(suffix) or not item.is_file(follow_symlinks=False):
                    continue
                info = item.stat(follow_symlinks=False)
                entries.append((Path(item.path), float(info.st_mtime)))
    except (FileNotFoundError, NotADirectoryError):
        return []
    entries.sort(key=lambda item: item[0].name.casefold())
    return entries


def _read_artifact_entries(
    entries: list[tuple[Path, float]],
) -> list[tuple[Path, float, dict]]:
    if not entries:
        return []
    with ThreadPoolExecutor(max_workers=min(_MAX_IO_WORKERS, len(entries))) as executor:
        payloads = list(executor.map(lambda item: _read_artifact_json(item[0]), entries))
    return [
        (path, modified, payload)
        for (path, modified), payload in zip(entries, payloads)
    ]


def _reserving_class_artifact_groups(rc_dir: Path) -> dict[str, dict]:
    """Inventory logical dataset/output groups with one listing per artifact folder."""

    groups: dict[str, dict] = {}
    sidecar_entries = _artifact_file_entries(rc_dir / DATASET_SIDECAR_DIR, ".json")
    for path, modified, payload in _read_artifact_entries(sidecar_entries):
        name = payload.get("dataset_name") or _normalize_cached_dataset_name(path.stem)
        _record_artifact(
            groups,
            name=name,
            path=path,
            fallback_timestamp=modified,
            dataset_type=payload.get("dataset_type") or payload.get("dataset type"),
            payload=payload,
        )

    method_entries = _artifact_file_entries(rc_dir / METHOD_DIR_NAME, ".json")
    for path, modified, payload in _read_artifact_entries(method_entries):
        entry = _canonical_method_entry_from_payload(payload, path.name)
        if not isinstance(entry, dict):
            continue
        _record_artifact(
            groups,
            name=entry.get("dataset_name"),
            path=path,
            fallback_timestamp=modified,
            dataset_type=entry.get("dataset_type"),
            payload=payload,
        )

    for path, modified in _artifact_file_entries(rc_dir / DATASET_CACHE_DIR, ".csv"):
        for name in _cached_dataset_names_from_file(path.name):
            _record_artifact(
                groups,
                name=name,
                path=path,
                fallback_timestamp=modified,
            )
    return groups


def _group_modified_timestamp(group: dict) -> float:
    return float(group.get("metadata_timestamp") or group.get("fallback_timestamp") or 0.0)


def snapshot_reserving_class_artifacts(live_rc_dir: Path, snapshot_rc_dir: Path) -> int:
    """Copy one RC's mergeable artifacts into an isolated direct-import snapshot."""

    live_rc = Path(live_rc_dir).resolve(strict=False)
    snapshot_rc = Path(snapshot_rc_dir).resolve(strict=False)
    if live_rc == snapshot_rc or snapshot_rc.exists():
        raise ValueError("The direct-import snapshot must be a new, isolated folder.")
    if not live_rc.is_dir():
        return 0
    if live_rc.is_symlink():
        raise ValueError("Refusing to snapshot a symlinked reserving-class folder.")

    sources = [
        path
        for folder_name, suffix in _ARTIFACT_FOLDERS
        for path, _modified in _artifact_file_entries(live_rc / folder_name, suffix)
    ]

    def copy_artifact(source: Path) -> None:
        target = snapshot_rc / source.relative_to(live_rc)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    if sources:
        with ThreadPoolExecutor(max_workers=min(_MAX_IO_WORKERS, len(sources))) as executor:
            list(executor.map(copy_artifact, sources))
    return len(sources)


def merge_preserved_arcrho_artifacts(
    live_rc_dir: Path,
    staged_rc_dir: Path,
    *,
    overwrite: bool = False,
) -> dict[str, object]:
    """Overlay ArcRho-owned or newer live groups onto a completed ResQ stage.

    With ``overwrite`` the newer-live-copy protection is skipped, so the fresh
    ResQ result always wins for anything ResQ provided. Groups whose ArcRho
    dataset type the stage did not produce at all are preserved either way:
    an overwrite must not delete work that exists only in ArcRho.
    """

    live_rc = Path(live_rc_dir).resolve(strict=False)
    staged_rc = Path(staged_rc_dir).resolve(strict=False)
    if live_rc == staged_rc or not live_rc.is_dir():
        return {"groups": 0, "files": 0, "names": []}
    if live_rc.is_symlink() or staged_rc.is_symlink():
        raise ValueError("Refusing to merge a symlinked reserving-class folder.")

    live_groups = _reserving_class_artifact_groups(live_rc)
    staged_groups = _reserving_class_artifact_groups(staged_rc)
    staged_type_keys = {
        _normalize_import_name(group.get("dataset_type")).casefold()
        for group in staged_groups.values()
        if _normalize_import_name(group.get("dataset_type"))
    }
    arcrho_type_keys = _dataset_type_keys()
    preserved: list[dict] = []
    for key, live_group in live_groups.items():
        live_type_key = _normalize_import_name(live_group.get("dataset_type")).casefold()
        staged_group = staged_groups.get(key)
        arcrho_only_type = (
            bool(live_type_key)
            and live_type_key in arcrho_type_keys
            and live_type_key not in staged_type_keys
        )
        live_is_newer = (
            not overwrite
            and staged_group is not None
            and _group_modified_timestamp(live_group)
            > _group_modified_timestamp(staged_group) + 0.000001
        )
        if arcrho_only_type or live_is_newer:
            preserved.append(live_group)

    staged_paths_to_remove: set[Path] = set()
    live_paths_to_copy: list[Path] = []
    for live_group in preserved:
        staged_group = staged_groups.get(str(live_group["name"]).casefold())
        if staged_group:
            staged_paths_to_remove.update(staged_group["paths"])
        live_paths_to_copy.extend(live_group["paths"])

    for path in sorted(staged_paths_to_remove, key=lambda item: str(item).casefold()):
        path.unlink(missing_ok=True)

    def copy_artifact(source: Path) -> None:
        target = staged_rc / source.relative_to(live_rc)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    ordered_sources = sorted(set(live_paths_to_copy), key=lambda item: str(item).casefold())
    if ordered_sources:
        with ThreadPoolExecutor(max_workers=min(_MAX_IO_WORKERS, len(ordered_sources))) as executor:
            list(executor.map(copy_artifact, ordered_sources))
    return {
        "groups": len(preserved),
        "files": len(ordered_sources),
        "names": [str(group["name"]) for group in preserved],
    }
