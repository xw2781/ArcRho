"""Mtime-validated in-memory cache for small shared metadata files.

Project data can live on a mapped or UNC network drive, where every
filesystem operation costs a full round trip. The small JSON/text payloads
hydrated on every cached dataset open (general settings, dataset types,
ArcRhoHeaders label caches) change rarely, so repeat reads are served from
memory once a single stat call proves the file is unchanged.

Validation keys on ``(st_mtime_ns, st_size)``. Entries whose modification
time is within the last few seconds are always re-read because two rapid
same-size rewrites can land inside one filesystem timestamp tick; older
entries are safe because every writer in this repository replaces these
files atomically, which advances the timestamp. A tool that restores an old
file while preserving its original timestamp is outside this guarantee.
Failed reads are never cached, and payloads are deep-copied on the way in
and out so callers may mutate results freely.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import time
from typing import Any, Callable, Dict, Tuple

_MAX_ENTRIES = 256
_RECENT_WRITE_GUARD_SEC = 3.0

_LOCK = threading.Lock()
_ENTRIES: Dict[str, Tuple[int, int, Any]] = {}


def _load_json_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_text_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _read_with_cache(path: str, loader: Callable[[str], Any]) -> Any:
    key = os.path.normcase(os.path.abspath(path))
    stat = os.stat(path)
    fresh_write = (time.time() - stat.st_mtime) < _RECENT_WRITE_GUARD_SEC
    if not fresh_write:
        with _LOCK:
            entry = _ENTRIES.get(key)
            if entry is not None and entry[0] == stat.st_mtime_ns and entry[1] == stat.st_size:
                return copy.deepcopy(entry[2])
    payload = loader(path)
    with _LOCK:
        if len(_ENTRIES) >= _MAX_ENTRIES:
            _ENTRIES.clear()
        _ENTRIES[key] = (stat.st_mtime_ns, stat.st_size, copy.deepcopy(payload))
    return payload


def read_json_file_cached(path: str) -> Any:
    """Read a UTF-8 JSON file, serving repeat reads from the validated cache.

    Raises the same exceptions as ``open``/``json.load`` (``FileNotFoundError``,
    ``OSError``, ``json.JSONDecodeError``) so callers keep their error mapping.
    """
    return _read_with_cache(path, _load_json_file)


def read_text_file_cached(path: str) -> str:
    """Read a UTF-8 text file through the same validated cache."""
    return _read_with_cache(path, _load_text_file)


def clear_file_read_cache() -> None:
    """Drop every cached entry (test isolation and explicit refresh paths)."""
    with _LOCK:
        _ENTRIES.clear()
