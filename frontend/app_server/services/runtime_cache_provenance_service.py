"""Technical provenance for generated dataset CSV caches."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from typing import Any, Callable, Dict

from app_server import config
from app_server.services import dataset_sidecar_status_service


def provenance_path(data_path: str) -> str:
    dataset_dir = os.path.dirname(data_path)
    cache_root = (
        os.path.dirname(dataset_dir)
        if os.path.basename(dataset_dir).lower() == config.DATASET_CACHE_DIR.lower()
        else dataset_dir
    )
    filename = os.path.normcase(os.path.basename(data_path))
    cache_key = hashlib.sha1(filename.encode("utf-8")).hexdigest()
    return os.path.join(
        cache_root,
        config.RUNTIME_CACHE_PROVENANCE_DIR,
        f"{cache_key}.json",
    )


def file_fingerprint(path: str) -> Dict[str, Any]:
    """Return the canonical content identity used by persisted cache contracts."""
    stat_before = os.stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    stat_after = os.stat(path)
    if (
        int(stat_before.st_size) != int(stat_after.st_size)
        or int(stat_before.st_mtime_ns) != int(stat_after.st_mtime_ns)
    ):
        raise OSError(f"File changed while its fingerprint was being read: {path}")
    return {
        "size": int(stat_after.st_size),
        "mtime_ns": int(stat_after.st_mtime_ns),
        "sha256": digest.hexdigest(),
    }


def _read_payload(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except (ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def provenance_exists(data_path: str) -> bool:
    try:
        result = os.stat(provenance_path(data_path))
    except FileNotFoundError:
        return False
    return stat.S_ISREG(result.st_mode)


def matches(
    data_path: str,
    *,
    expected_identity: Dict[str, str],
    processing_config_hash: str,
    current_fingerprint: Dict[str, Any] | None = None,
    fingerprint_getter: Callable[[str], Dict[str, Any]] | None = None,
    verify_content: bool = True,
) -> bool:
    """Validate provenance, optionally deferring the full content read.

    Advisory callers may skip the SHA-256 comparison after all persisted
    identity and file-stat checks pass. Execute callers keep the default and
    remain authoritative.
    """
    if not os.path.isfile(data_path):
        return False
    payload = _read_payload(provenance_path(data_path))
    if payload.get("format") != config.RUNTIME_CACHE_PROVENANCE_FORMAT:
        return False
    for key, expected_value in expected_identity.items():
        if str(payload.get(key) or "").strip() != str(expected_value or "").strip():
            return False
    processing = payload.get("processing")
    if (
        not isinstance(processing, dict)
        or str(processing.get("config_hash") or "").strip() != processing_config_hash
    ):
        return False
    stored_fingerprint = payload.get("csv_fingerprint")
    if not isinstance(stored_fingerprint, dict):
        return False
    current_stat = os.stat(data_path)
    try:
        if (
            int(stored_fingerprint.get("size")) != int(current_stat.st_size)
            or int(stored_fingerprint.get("mtime_ns")) != int(current_stat.st_mtime_ns)
        ):
            return False
    except (TypeError, ValueError):
        return False
    if not verify_content:
        return True
    resolved_fingerprint = current_fingerprint
    if resolved_fingerprint is None:
        get_fingerprint = fingerprint_getter or file_fingerprint
        resolved_fingerprint = get_fingerprint(data_path)
    return stored_fingerprint == resolved_fingerprint


def record(
    data_path: str,
    *,
    identity: Dict[str, str],
    processing: Dict[str, Any],
) -> bool:
    if not os.path.isfile(data_path):
        return False
    payload: Dict[str, Any] = {
        "format": config.RUNTIME_CACHE_PROVENANCE_FORMAT,
        **identity,
        "csv_fingerprint": file_fingerprint(data_path),
        "processing": processing,
    }
    dataset_sidecar_status_service.write_sidecar(provenance_path(data_path), payload)
    return True


def remove(data_path: str) -> None:
    try:
        os.remove(provenance_path(data_path))
    except FileNotFoundError:
        return
