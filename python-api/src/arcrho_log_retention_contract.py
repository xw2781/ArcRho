"""One retention rule for every ArcRho log file: thirty days, then gone.

Every ArcRho component keeps a diagnostic log somewhere, and each one used to
decide for itself how long that log lived. Files named after the moment they
were opened -- one per app launch, one per request -- were never removed at
all, and the two logs that append under a fixed name grew without any bound.
Nothing reads a log from last quarter, so this module owns the single answer:
a log line, and the file holding it, is kept for
:data:`LOG_RETENTION_DAYS` days.

Retention must never change what a component does. Every failure is swallowed,
so a locked file, a full disk, or a network drive that blinks can only leave an
old log in place -- it can never fail the work the log was describing.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

# Thirty days covers every diagnosis anyone has ever run here -- a save that
# went wrong yesterday, a launch that failed last week -- while keeping a
# machine's whole log folder small enough to read through.
LOG_RETENTION_DAYS = 30

# The suffixes a log directory holds. A rotated backup (``gateway.log.1``)
# counts as its base suffix.
LOG_FILE_SUFFIXES: tuple[str, ...] = (".log", ".jsonl")

# Every log line in this repository carries an ISO calendar date near its
# start: first thing on a plain text line, or just inside the opening key of a
# JSON record. Searching a short window covers both without reading a line that
# only mentions a date further along.
_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")
_DATE_SEARCH_WINDOW = 64


def _cutoff_timestamp(now: float | None, days: int) -> float:
    return (time.time() if now is None else now) - days * 86400


def _is_log_name(name: str, suffixes: Sequence[str]) -> bool:
    base, _, tail = name.rpartition(".")
    if base and tail.isdigit():
        name = base
    lowered = name.lower()
    return any(lowered.endswith(suffix) for suffix in suffixes)


def prune_aged_log_files(
    directory: str | os.PathLike[str],
    *,
    suffixes: Iterable[str] = LOG_FILE_SUFFIXES,
    days: int = LOG_RETENTION_DAYS,
    now: float | None = None,
) -> int:
    """Delete every log file in ``directory`` last written before the cutoff.

    ``now`` is a Unix timestamp and exists for tests. Returns how many files
    were deleted; a directory that does not exist yet prunes nothing.
    """

    suffixes = tuple(str(suffix).lower() for suffix in suffixes)
    cutoff = _cutoff_timestamp(now, days)
    removed = 0
    try:
        entries = list(os.scandir(os.fspath(directory)))
    except OSError:
        return 0
    for entry in entries:
        try:
            if not entry.is_file() or not _is_log_name(entry.name, suffixes):
                continue
            if entry.stat().st_mtime >= cutoff:
                continue
            os.unlink(entry.path)
            removed += 1
        except OSError:
            continue
    return removed


def trim_aged_log_lines(
    path: str | os.PathLike[str],
    *,
    days: int = LOG_RETENTION_DAYS,
    now: float | None = None,
) -> int:
    """Drop the leading lines of one appended log file that predate the cutoff.

    A log written under a fixed name is always recent, so file age cannot bound
    it; its own timestamps can. A line without a date near its start -- a
    traceback body -- belongs to the dated line above it and shares its fate,
    and a log with no dated line at all is left untouched. Returns how many
    lines were dropped.
    """

    cutoff = datetime.fromtimestamp(_cutoff_timestamp(now, days)).date()
    target = Path(os.fspath(path))
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0
    if not text:
        return 0

    lines = text.splitlines(keepends=True)
    keep_from: int | None = None
    dated_line_seen = False
    for index, line in enumerate(lines):
        match = _DATE_PATTERN.search(line[:_DATE_SEARCH_WINDOW])
        if match is None:
            continue
        try:
            dated = datetime.strptime(match.group(), "%Y-%m-%d").date()
        except ValueError:
            continue
        dated_line_seen = True
        if dated >= cutoff:
            keep_from = index
            break
    if not dated_line_seen:
        # A log this module cannot date is left exactly as it is.
        return 0
    if keep_from is None:
        # Every dated line predates the cutoff, so nothing survives.
        keep_from = len(lines)
    if keep_from == 0:
        return 0

    temporary = target.with_name(f"{target.name}.trim")
    try:
        temporary.write_text("".join(lines[keep_from:]), encoding="utf-8", newline="")
        os.replace(temporary, target)
    except OSError:
        try:
            temporary.unlink()
        except OSError:
            pass
        return 0
    return keep_from


def apply_log_retention(
    directory: str | os.PathLike[str],
    *,
    appended_files: Iterable[str | os.PathLike[str]] = (),
    suffixes: Iterable[str] = LOG_FILE_SUFFIXES,
    now: float | None = None,
) -> None:
    """Apply the whole rule to one component's logs at start-up.

    ``appended_files`` names the logs that component writes under a fixed name,
    which are trimmed by line instead of deleted whole.
    """

    prune_aged_log_files(directory, suffixes=suffixes, now=now)
    for path in appended_files:
        trim_aged_log_lines(path, now=now)
