"""Content-based human review decisions for automatic method publications."""
from __future__ import annotations

import csv
import io
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping

from app_server.services import dataset_sidecar_status_service as statuses


_AUDIT_FIELDS = {
    "created_at", "created_by", "updated_at", "modified_by", "last_modified",
    "data_refreshed", "audit_log",
}


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
    """Compare the proposed method JSON and every published CSV before commit."""
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
