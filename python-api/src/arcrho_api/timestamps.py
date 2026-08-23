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


def normalize_persisted_timestamp(value: Any, *, default: str = "") -> str:
    """Return *value* in the persisted form, or *default* when it is not a time.

    Accepts the forms older files carry: a ``Z`` suffix, a ``+00:00`` or other
    offset, a naive value (a wall-clock time in this machine's zone), and any
    sub-second precision.
    """

    text = str(value if value is not None else "").strip()
    if not text:
        return default
    candidate = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return default
    return format_persisted_timestamp(parsed)


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
    "format_persisted_timestamp",
    "is_persisted_timestamp",
    "normalize_persisted_timestamp",
    "persisted_timestamp",
    "utc_now_text",
]
