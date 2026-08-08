"""Scandir-validated caches for reserving-class folder reads.

Dependency resolution for calculated datasets repeatedly reads the same
reserving-class folders: every dataset sidecar JSON, every DFM method JSON,
and the component CSV values themselves. On a client PC the project share is
a mapped or UNC network drive where every file open is a full round trip, so
an uncached live-preview request costs one read per file in the class
(seconds per keystroke). The folder listing itself already returns each
entry's ``(st_mtime_ns, st_size)``, so repeat requests can be validated with
one listing per folder instead of one read per file.

Validation and copy discipline follow ``file_read_cache``: entries whose
modification time is within the last few seconds are always re-read because
two rapid same-size rewrites can land inside one filesystem timestamp tick;
failed reads are never cached; payloads are copied on the way out so callers
may mutate results freely. Every writer of these files in this repository
replaces them atomically, which advances the timestamp - a tool that
restores an old file while preserving its original timestamp is outside this
guarantee.
"""
from __future__ import annotations

import copy
import json
import os
import stat as stat_module
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Iterable, List, NamedTuple, Tuple

_RECENT_WRITE_GUARD_SEC = 3.0
_MAX_JSON_ENTRIES = 8192
_MAX_MATRIX_ENTRIES = 512

_JSON_LOCK = threading.Lock()
_JSON_ENTRIES: Dict[str, Tuple[int, int, Dict[str, Any]]] = {}

_MATRIX_LOCK = threading.Lock()
_MATRIX_ENTRIES: Dict[str, Tuple[int, int, Any, Dict[str, Any]]] = {}

_READ_MAX_WORKERS = 12
_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=_READ_MAX_WORKERS,
    thread_name_prefix="arcrho-class-scan-read",
)


class FolderFileStat(NamedTuple):
    """One file observed by a directory listing, with its validation identity."""

    path: str
    mtime: float
    mtime_ns: int
    size: int


def scan_files_with_stats(
    folder: str,
    suffix: str,
    name_prefix: str = "",
) -> Tuple[bool, List[FolderFileStat]]:
    """List one folder, keeping the stat identity the listing already returned."""

    files: List[FolderFileStat] = []
    try:
        with os.scandir(folder) as iterator:
            for entry in iterator:
                if not entry.name.lower().endswith(suffix):
                    continue
                if name_prefix and not entry.name.startswith(name_prefix):
                    continue
                try:
                    info = entry.stat()
                except OSError:
                    continue
                if not stat_module.S_ISREG(info.st_mode):
                    continue
                files.append(FolderFileStat(
                    path=entry.path,
                    mtime=float(info.st_mtime),
                    mtime_ns=int(info.st_mtime_ns),
                    size=int(info.st_size),
                ))
    except (FileNotFoundError, NotADirectoryError):
        return False, []
    except OSError:
        return False, []
    return True, files


def stats_by_normcase_path(entries: Iterable[FolderFileStat]) -> Dict[str, Tuple[int, int]]:
    """Index a listing by normalized path for cache validation lookups."""

    return {
        os.path.normcase(entry.path): (entry.mtime_ns, entry.size)
        for entry in entries
    }


def _load_json_payload(path: str) -> Tuple[Dict[str, Any], bool]:
    """Read one JSON dict; ``(payload, cacheable)`` where failures are ({}, False)."""

    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}, False
    if isinstance(data, dict):
        return data, True
    # Non-dict content is a stable (if unexpected) state of the file, so the
    # empty replacement can be validated and cached like any payload.
    return {}, True


def read_json_files_cached(
    paths: Iterable[str],
    stats_by_path: Dict[str, Tuple[int, int]],
) -> Dict[str, Dict[str, Any]]:
    """Read many small JSON payloads, serving unchanged files from memory.

    ``stats_by_path`` maps ``os.path.normcase`` paths to ``(mtime_ns, size)``
    pairs taken from a directory listing; a requested path missing from the
    map is read fresh and never cached because it cannot be validated.
    Results mirror ``_read_sidecar`` semantics: unreadable or non-dict files
    yield ``{}``. Misses are read with bounded parallelism because each one
    is a network round trip.
    """

    unique = list(dict.fromkeys(paths))
    now = time.time()
    results: Dict[str, Dict[str, Any]] = {}
    misses: List[Tuple[str, Tuple[int, int] | None]] = []
    with _JSON_LOCK:
        for path in unique:
            key = os.path.normcase(path)
            stat_pair = stats_by_path.get(key)
            entry = _JSON_ENTRIES.get(key) if stat_pair is not None else None
            if (
                entry is not None
                and entry[0] == stat_pair[0]
                and entry[1] == stat_pair[1]
                and (now - stat_pair[0] / 1_000_000_000) >= _RECENT_WRITE_GUARD_SEC
            ):
                results[path] = copy.deepcopy(entry[2])
            else:
                misses.append((path, stat_pair))
    if misses:
        futures = {path: _READ_EXECUTOR.submit(_load_json_payload, path) for path, _pair in misses}
        with _JSON_LOCK:
            for path, stat_pair in misses:
                payload, cacheable = futures[path].result()
                results[path] = payload
                if cacheable and stat_pair is not None:
                    if len(_JSON_ENTRIES) >= _MAX_JSON_ENTRIES:
                        _JSON_ENTRIES.clear()
                    _JSON_ENTRIES[os.path.normcase(path)] = (
                        stat_pair[0],
                        stat_pair[1],
                        copy.deepcopy(payload),
                    )
    return results


def read_matrix_cached(
    path: str,
    loader: Callable[[str], Tuple[Any, Dict[str, Any]]],
    stat_hint: Tuple[int, int] | None = None,
) -> Tuple[Any, Dict[str, Any]]:
    """Load ``(matrix, metadata)`` for one file, reusing unchanged content.

    ``loader`` returns a numpy array plus a metadata dict (for example the
    content fingerprint that would otherwise re-read the whole file); loader
    exceptions propagate to the caller and are never cached. ``stat_hint`` is
    a ``(mtime_ns, size)`` pair from a directory listing; without it the file
    is stat-ed once, which still avoids the full read on a hit.
    """

    key = os.path.normcase(os.path.abspath(path))
    if stat_hint is None:
        info = os.stat(path)
        stat_pair = (int(info.st_mtime_ns), int(info.st_size))
    else:
        stat_pair = (int(stat_hint[0]), int(stat_hint[1]))
    fresh_write = (time.time() - stat_pair[0] / 1_000_000_000) < _RECENT_WRITE_GUARD_SEC
    if not fresh_write:
        with _MATRIX_LOCK:
            entry = _MATRIX_ENTRIES.get(key)
            if entry is not None and entry[0] == stat_pair[0] and entry[1] == stat_pair[1]:
                return entry[2].copy(), copy.deepcopy(entry[3])
    matrix, metadata = loader(path)
    with _MATRIX_LOCK:
        if len(_MATRIX_ENTRIES) >= _MAX_MATRIX_ENTRIES:
            _MATRIX_ENTRIES.clear()
        _MATRIX_ENTRIES[key] = (stat_pair[0], stat_pair[1], matrix.copy(), copy.deepcopy(metadata))
    return matrix, metadata


def clear_class_folder_scan_cache() -> None:
    """Drop every cached entry (test isolation and explicit refresh paths)."""

    with _JSON_LOCK:
        _JSON_ENTRIES.clear()
    with _MATRIX_LOCK:
        _MATRIX_ENTRIES.clear()
