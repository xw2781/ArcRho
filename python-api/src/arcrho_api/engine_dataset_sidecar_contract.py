"""Canonical persisted sidecar contract for ArcRho Engine datasets."""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping, Sequence

from .dataset_display_contract import DEFAULT_SHOW_SUBTOTAL, normalize_show_subtotal


ENGINE_SOURCE_KIND = "engine"
ENGINE_METHOD_TYPE = "None"
ENGINE_STATUS_CURRENT = 0


def build_engine_dataset_sidecar(
    *,
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    dataset_type: str,
    data_format: str,
    csv_file: str,
    user: str,
    created: str,
    updated_at: str,
    number_format: str,
    decimal_places: int,
    origin_length: int | None = None,
    development_length: int | None = None,
    period_length: int | None = None,
    cumulative: bool = True,
    calendar: bool = False,
    show_subtotal: bool = DEFAULT_SHOW_SUBTOTAL,
    processing: Mapping[str, Any] | None = None,
    precedents: Sequence[Any] = (),
    dependents: Sequence[Any] = (),
    audit_action: str = "Insert",
    source_modified: str = "",
) -> dict[str, Any]:
    """Return the complete location-independent engine sidecar payload.

    Axis labels and counts are deliberately absent. They are presentation data
    derived from the canonical project-header contract when the CSV is loaded.
    Dataset Type formulas are likewise hydrated from ``dataset_types.json`` and
    are not copied into an engine-owned sidecar.

    ``updated_at`` records when this cache file was produced, so freshness
    checks treat the cache as current. ``source_modified`` records when the
    dataset's content last changed at its source system (e.g. ResQ); review
    status comparisons must use it instead of ``updated_at``, because a newly
    written cache of unchanged data is not a data change.
    """

    vector = str(data_format or "").strip().casefold() == "vector"
    payload: dict[str, Any] = {
        "dataset_name": str(dataset_name or "").strip(),
        "dataset_type": str(dataset_type or dataset_name or "").strip(),
        "reserving_class": str(reserving_class or "").strip(),
        "project_name": str(project_name or "").strip(),
        "source_kind": ENGINE_SOURCE_KIND,
        "calculated": False,
        "formula": "",
        "data_format": "Vector" if vector else "Triangle",
        "data_format_code": 1 if vector else 0,
        "method_type": ENGINE_METHOD_TYPE,
        "status": ENGINE_STATUS_CURRENT,
        "number_format": str(number_format or "").strip(),
        "decimal_places": int(decimal_places),
        "show_subtotal": normalize_show_subtotal(show_subtotal),
        "csv_file": str(csv_file or "").strip(),
        "user": str(user or "").strip(),
        "created": str(created or "").strip(),
        "modified_by": str(user or "").strip(),
        "updated_at": str(updated_at or "").strip(),
    }
    if str(source_modified or "").strip():
        payload["source_modified"] = str(source_modified).strip()
    if vector:
        payload["period_length"] = int(period_length or origin_length or 0)
    else:
        payload.update({
            "origin_length": int(origin_length or 0),
            "development_length": int(development_length or 0),
            "cumulative": bool(cumulative),
            "calendar": bool(calendar),
        })

    if processing:
        canonical_processing = deepcopy(dict(processing))
        payload["processing"] = canonical_processing
        payload["processing_by_csv"] = {
            payload["csv_file"]: deepcopy(canonical_processing),
        }

    payload["audit_log"] = [{
        "event_date": payload["updated_at"],
        "action": str(audit_action or "Insert"),
        "change_info": "",
        "user": payload["user"],
    }]
    payload["Precedents"] = deepcopy(list(precedents))
    payload["Dependents"] = deepcopy(list(dependents))
    return payload
