"""Rotating client-local JSONL diagnostics for Engine-hosted saves.

The hosted-save protocol intentionally crosses the ArcRho Server network
drive several times before and after ArcRho Engine does its work.  Each save
collects its timings in memory, then appends one compact record here after the
measured critical path has ended.  The log never contains a method payload or
project data, and a logging failure must never change the save outcome.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from app_server import config


CLIENT_SAVE_LATENCY_LOG_SCHEMA_VERSION = 1
CLIENT_SAVE_LATENCY_LOG_MAX_BYTES = 5 * 1024 * 1024
CLIENT_SAVE_LATENCY_LOG_BACKUP_COUNT = 3

_LOG_LOCK = threading.Lock()


def _rotated_path(path: Path, index: int) -> Path:
    return path.with_name(f"{path.name}.{index}")


def _rotate_if_needed(path: Path, incoming_bytes: int) -> None:
    try:
        current_bytes = path.stat().st_size
    except FileNotFoundError:
        return
    if current_bytes + incoming_bytes <= CLIENT_SAVE_LATENCY_LOG_MAX_BYTES:
        return

    oldest = _rotated_path(path, CLIENT_SAVE_LATENCY_LOG_BACKUP_COUNT)
    oldest.unlink(missing_ok=True)
    for index in range(CLIENT_SAVE_LATENCY_LOG_BACKUP_COUNT - 1, 0, -1):
        source = _rotated_path(path, index)
        if source.exists():
            os.replace(source, _rotated_path(path, index + 1))
    os.replace(path, _rotated_path(path, 1))


def append_client_save_latency(record: Mapping[str, Any]) -> bool:
    """Append one diagnostic record locally; return whether it was written."""

    payload = {
        "schema_version": CLIENT_SAVE_LATENCY_LOG_SCHEMA_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        **dict(record),
    }
    line = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ) + "\n"
    encoded_length = len(line.encode("utf-8"))
    path = Path(config.get_client_save_latency_log_path())
    try:
        with _LOG_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            _rotate_if_needed(path, encoded_length)
            with path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line)
    except Exception:
        return False
    return True
