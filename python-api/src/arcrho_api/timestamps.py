"""The one representation of a persisted ArcRho timestamp.

Every time a persisted file records -- ``created``, ``updated_at``,
``last_modified``, ``data_refreshed``, ``event_date``, ``source_modified`` --
is ISO-8601 in UTC at millisecond precision with a ``Z`` suffix:
``2026-08-22T14:03:07.412Z``. One function produces it and one normalizes
whatever an older file or an external system supplied, so a reader never has
to guess whether ``+00:00``, a naive value, or microseconds are in play.

A value with no timezone is a wall-clock reading in this machine's own zone.
That is what ResQ reports (COM hands its ``Modified`` back with no usable
zone) and what Python and JavaScript both assume for a bare ISO string, so
the one rule here matches every other reader of such a value.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PERSISTED_TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def format_persisted_timestamp(value: datetime) -> str:
    """Render a datetime in the persisted form; a naive one is local time."""

    value = value.astimezone(timezone.utc)
    milliseconds = value.microsecond // 1000
    return value.strftime("%Y-%m-%dT%H:%M:%S") + f".{milliseconds:03d}Z"


def utc_now_text() -> str:
    """The current time in the persisted form."""

    return format_persisted_timestamp(datetime.now(timezone.utc))


def _parse_timestamp_text(value: Any) -> datetime | None:
    """Read any ISO-8601 form a file or an external system supplies, or None."""

    text = str(value if value is not None else "").strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        return None


def normalize_persisted_timestamp(value: Any, *, default: str = "") -> str:
    """Return *value* in the persisted form, or *default* when it is not a time.

    Accepts the forms older files carry: a ``Z`` suffix, a ``+00:00`` or other
    offset, a naive value (a wall-clock time in this machine's zone), and any
    sub-second precision.
    """

    parsed = _parse_timestamp_text(value)
    if parsed is None:
        return default
    return format_persisted_timestamp(parsed)


def format_display_timestamp(value: Any, *, default: str = "") -> str:
    """Render *value* the way the app's lists and ResQ's own windows show a time.

    That is this machine's local time as ``8/13/2026 2:49:34 PM``. The persisted
    form is UTC, and ``18:49:34Z`` read beside ResQ's ``2:49:34 PM`` looks like a
    four-hour error when both name the same instant, so nothing a person reads
    is shown in the persisted form.
    """

    parsed = _parse_timestamp_text(value)
    if parsed is None:
        return default
    local = parsed.astimezone()
    hour = local.hour % 12 or 12
    meridiem = "PM" if local.hour >= 12 else "AM"
    return f"{local.month}/{local.day}/{local.year} {hour}:{local:%M:%S} {meridiem}"


def is_persisted_timestamp(value: Any) -> bool:
    """Say whether *value* is already in the persisted form."""

    text = str(value if value is not None else "")
    return len(text) == 24 and normalize_persisted_timestamp(text) == text


def persisted_timestamp(value: Any = None) -> str:
    """The timestamp a method contract stamps: *value* in the persisted form, or now.

    A supplied time in any ISO-8601 form is normalized; text that is not a
    time at all (a test token such as ``"later"``) is kept verbatim rather
    than silently replaced, so the caller sees the value it passed. An empty
    value means the current time.
    """

    cleaned = str(value if value is not None else "").strip()
    if cleaned:
        return normalize_persisted_timestamp(cleaned, default=cleaned)
    return utc_now_text()


__all__ = [
    "PERSISTED_TIMESTAMP_FORMAT",
    "format_display_timestamp",
    "format_persisted_timestamp",
    "is_persisted_timestamp",
    "normalize_persisted_timestamp",
    "persisted_timestamp",
    "utc_now_text",
]
