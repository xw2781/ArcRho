"""Rotating client-local JSONL diagnostics for Server-hosted transports.

The hosted-save protocol intentionally crosses the ArcRho Server network
drive several times before and after ArcRho Engine does its work, and a
workspace read either does the same or travels through the Gateway.
Each operation collects its timings in memory, then appends one compact
record here after the measured critical path has ended.  The logs never
contain a method payload or project data, and a logging failure must never
change the operation's outcome.
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
CLIENT_READ_LATENCY_LOG_SCHEMA_VERSION = 1
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


def _append_record(path: Path, schema_version: int, record: Mapping[str, Any]) -> bool:
    payload = {
        "schema_version": schema_version,
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
    try:
        with _LOG_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            _rotate_if_needed(path, encoded_length)
            with path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line)
    except Exception:
        return False
    return True


def append_client_save_latency(record: Mapping[str, Any]) -> bool:
    """Append one hosted-save diagnostic record locally; return whether written."""

    return _append_record(
        Path(config.get_client_save_latency_log_path()),
        CLIENT_SAVE_LATENCY_LOG_SCHEMA_VERSION,
        record,
    )


def append_client_read_latency(record: Mapping[str, Any]) -> bool:
    """Append one workspace-read diagnostic record locally; return whether written."""

    return _append_record(
        Path(config.get_client_read_latency_log_path()),
        CLIENT_READ_LATENCY_LOG_SCHEMA_VERSION,
        record,
    )
