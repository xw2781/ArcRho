"""Technical provenance for generated and app-calculated dataset CSV caches.

One record per cached CSV lives in the reserving class's dotted
``.arcrho-cache-provenance`` folder. It is the one place machine-local facts
about a cache are kept -- file paths, sizes, modification times, content
digests -- so the dataset sidecar beside it can stay location-independent.
An engine cache records the processing configuration it was built under; an
app-calculated cache records the formula and each dependency file it was
read from, with that file's fingerprint.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List

from arcrho_api.io import write_json_atomic
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
    if payload.get("json_format") != config.RUNTIME_CACHE_PROVENANCE_FORMAT:
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


def _write_record(data_path: str, body: Dict[str, Any]) -> bool:
    payload: Dict[str, Any] = {
        "json_format": config.RUNTIME_CACHE_PROVENANCE_FORMAT,
        **body,
    }
    # A provenance file is not a dataset sidecar, so it does not go through the
    # sidecar write funnel (which would stamp it as one).
    target = provenance_path(data_path)
    with dataset_sidecar_status_service.sidecar_write_lock(target):
        write_json_atomic(Path(target), payload)
    return True


def record(
    data_path: str,
    *,
    identity: Dict[str, str],
    processing: Dict[str, Any],
) -> bool:
    if not os.path.isfile(data_path):
        return False
    return _write_record(data_path, {
        **identity,
        "csv_fingerprint": file_fingerprint(data_path),
        "processing": processing,
    })


def calculated_cache_identity(
    data_path: str,
    *,
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    dataset_type: str,
) -> Dict[str, str]:
    """The identity an app-calculated cache's record is bound to.

    The writer (``calculated_dataset_service``) and the validating reader
    (``arcrho_runtime_service``) both build it here, so the two can never
    disagree about which dataset a record describes.
    """
    return {
        "csv_file": os.path.basename(data_path),
        "dataset_name": str(dataset_name or "").strip(),
        "dataset_type": str(dataset_type or dataset_name or "").strip(),
        "reserving_class": str(reserving_class or "").strip(),
        "project_name": str(project_name or "").strip(),
    }


def record_calculated(
    data_path: str,
    *,
    identity: Dict[str, str],
    formula: str,
    dependencies: Iterable[Dict[str, Any]],
) -> bool:
    """Record what an app-calculated CSV was built from.

    The dataset sidecar names its precedents and nothing else. This record,
    beside the CSV it describes, carries the formula that produced it and, for
    each dependency, the exact file it was read from with that file's size,
    modification time and digest -- plus the input a DFM method output was
    rebuilt from -- so the exact-cache check can reject a changed input and a
    recalculation can reuse the same method and input rather than rescan.
    """
    if not os.path.isfile(data_path):
        return False
    return _write_record(data_path, {
        **identity,
        "csv_fingerprint": file_fingerprint(data_path),
        "formula": str(formula or "").strip(),
        "dependencies": [dict(item) for item in dependencies if isinstance(item, dict)],
    })


def calculated_record(
    data_path: str,
    *,
    expected_identity: Dict[str, str],
    bind_to_csv: bool = True,
) -> Dict[str, Any] | None:
    """The app-calculated record for *data_path*, or None when none describes it.

    A record describes the CSV only while the file's size and modification
    time still match what was fingerprinted beside it. Pass ``bind_to_csv=False``
    to read the record of a cache already known to be stale, when only which
    sources built it matters.
    """
    payload = _read_payload(provenance_path(data_path))
    if payload.get("json_format") != config.RUNTIME_CACHE_PROVENANCE_FORMAT:
        return None
    for key, expected_value in expected_identity.items():
        if str(payload.get(key) or "").strip() != str(expected_value or "").strip():
            return None
    dependencies = payload.get("dependencies")
    if not isinstance(dependencies, list):
        return None
    if bind_to_csv:
        stored_fingerprint = payload.get("csv_fingerprint")
        if not isinstance(stored_fingerprint, dict):
            return None
        try:
            current_stat = os.stat(data_path)
        except FileNotFoundError:
            return None
        try:
            if (
                int(stored_fingerprint.get("size")) != int(current_stat.st_size)
                or int(stored_fingerprint.get("mtime_ns")) != int(current_stat.st_mtime_ns)
            ):
                return None
        except (TypeError, ValueError):
            return None
    return {
        "formula": str(payload.get("formula") or "").strip(),
        "dependencies": [dict(item) for item in dependencies if isinstance(item, dict)],
    }


def remove(data_path: str) -> None:
    try:
        os.remove(provenance_path(data_path))
    except FileNotFoundError:
        return
