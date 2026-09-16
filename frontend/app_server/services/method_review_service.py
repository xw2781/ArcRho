"""Content-based human review decisions for automatic method publications."""
from __future__ import annotations

import contextvars
import csv
import io
import json
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator, List, Mapping

from app_server.services import dataset_sidecar_status_service as statuses


_AUDIT_FIELDS = {
    "created_at", "created_by", "updated_at", "modified_by", "last_modified",
    "data_refreshed", "audit_log",
}

# The method outputs one dependent walk turned from OK to Needs Review, in
# publication order. The outermost ``recalculate_dependents`` opens the
# collector and every publisher reports through ``refreshed_status``, so a
# flip inside a nested cascade (a Result Selection republished by a BF wave,
# say) lands in the same list the save response shows the user.
_review_flagged: contextvars.ContextVar[List[str] | None] = contextvars.ContextVar(
    "arcrho_review_flagged", default=None
)


@contextmanager
def review_flag_collector() -> Iterator[List[str]]:
    """Collect the outputs a walk flags for review; nested walks share the list."""
    active = _review_flagged.get()
    if active is not None:
        yield active
        return
    names: List[str] = []
    token = _review_flagged.set(names)
    try:
        yield names
    finally:
        _review_flagged.reset(token)


def review_content(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: review_content(item)
            for key, item in value.items()
            if key not in _AUDIT_FIELDS
        }
    if isinstance(value, list):
        return [review_content(item) for item in value]
    return value


def _csv_content(text: str) -> list:
    def cell(value: str) -> Any:
        try:
            number = Decimal(value)
        except InvalidOperation:
            return value
        return number if number.is_finite() else value

    return [[cell(value) for value in row] for row in csv.reader(io.StringIO(text))]


def refreshed_status(previous_sidecar: Mapping[str, Any], files: Mapping[str, str]) -> int:
    """Compare the proposed method JSON and every published CSV before commit.

    A publication that turns a current output into Needs Review is recorded
    in the active :func:`review_flag_collector`, so the walk can name exactly
    the dependents whose values changed.
    """
    status = _refreshed_status(previous_sidecar, files)
    flagged = _review_flagged.get()
    if (
        flagged is not None
        and status == statuses.STATUS_REVIEW_NEEDED
        and statuses.normalize_status(previous_sidecar.get("status")) != statuses.STATUS_REVIEW_NEEDED
    ):
        name = str(previous_sidecar.get("dataset_name") or "").strip()
        if name and name.casefold() not in {item.casefold() for item in flagged}:
            flagged.append(name)
    return status


def _refreshed_status(previous_sidecar: Mapping[str, Any], files: Mapping[str, str]) -> int:
    if statuses.normalize_status(previous_sidecar.get("status")) == statuses.STATUS_REVIEW_NEEDED:
        return statuses.STATUS_REVIEW_NEEDED
    for filename, proposed in files.items():
        path = Path(filename)
        try:
            previous = path.read_text(encoding="utf-8-sig")
        except FileNotFoundError:
            return statuses.STATUS_REVIEW_NEEDED
        if path.suffix.lower() == ".json":
            unchanged = review_content(json.loads(previous)) == review_content(json.loads(proposed))
        else:
            unchanged = _csv_content(previous) == _csv_content(proposed)
        if not unchanged:
            return statuses.STATUS_REVIEW_NEEDED
    return statuses.STATUS_CURRENT
