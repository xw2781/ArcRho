"""Canonical persisted sidecar contract for ArcRho Engine datasets."""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping, Sequence

from .dataset_display_contract import DEFAULT_SHOW_SUBTOTAL, normalize_show_subtotal
from .sidecar_audit_contract import AUDIT_ACTION_INSERT, append_audit_entry
from .sidecar_core_contract import (
    DATASET_SIDECAR_JSON_FORMAT,
    dependency_entries,
    stored_length_fields,
    validate_sidecar_core,
)


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
    stored_origin_length: int | None = None,
    stored_development_length: int | None = None,
    stored_period_length: int | None = None,
    cumulative: bool = True,
    calendar: bool = False,
    show_subtotal: bool = DEFAULT_SHOW_SUBTOTAL,
    processing: Mapping[str, Any] | None = None,
    precedents: Sequence[Any] = (),
    dependents: Sequence[Any] = (),
    audit_action: str = AUDIT_ACTION_INSERT,
    source_modified: str = "",
    audit_log: Sequence[Any] = (),
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

    ``audit_log`` is the history the sidecar already held when one is being
    rewritten; this write is appended to it under the one audit policy rather
    than replacing it.

    The stored lengths are the granularity of the source data this dataset was
    generated from, which is finer than the requested shape whenever a coarser
    view was asked for. Until the project's field mapping records that
    granularity, callers leave them out and the requested shape stands in.
    """

    vector = str(data_format or "").strip().casefold() == "vector"
    payload: dict[str, Any] = {
        "json_format": DATASET_SIDECAR_JSON_FORMAT,
        "dataset_name": str(dataset_name or "").strip(),
        "dataset_type": str(dataset_type or dataset_name or "").strip(),
        "reserving_class": str(reserving_class or "").strip(),
        "project_name": str(project_name or "").strip(),
        "source_kind": ENGINE_SOURCE_KIND,
        "calculated": False,
        "data_format": "Vector" if vector else "Triangle",
        "method_type": ENGINE_METHOD_TYPE,
        "status": ENGINE_STATUS_CURRENT,
        "number_format": str(number_format or "").strip(),
        "decimal_places": int(decimal_places),
        "show_subtotal": normalize_show_subtotal(show_subtotal),
        "csv_file": str(csv_file or "").strip(),
        "created": str(created or "").strip(),
        "modified_by": str(user or "").strip(),
        "updated_at": str(updated_at or "").strip(),
    }
    if str(source_modified or "").strip():
        payload["source_modified"] = str(source_modified).strip()
    if vector:
        display_period = int(period_length or origin_length or 0)
        payload["period_length"] = display_period
        payload.update(
            stored_length_fields(
                payload["data_format"],
                stored_period_length or stored_origin_length or display_period,
            )
        )
    else:
        display_origin = int(origin_length or 0)
        display_development = int(development_length or 0)
        payload.update({
            "origin_length": display_origin,
            "development_length": display_development,
            **stored_length_fields(
                payload["data_format"],
                stored_origin_length or display_origin,
                stored_development_length or display_development,
            ),
            "cumulative": bool(cumulative),
            "calendar": bool(calendar),
        })

    if processing:
        payload["processing"] = deepcopy(dict(processing))

    payload["precedents"] = dependency_entries(precedents)
    payload["dependents"] = dependency_entries(dependents)
    payload["audit_log"] = append_audit_entry(
        audit_log,
        event_date=payload["updated_at"],
        action=str(audit_action or AUDIT_ACTION_INSERT),
        user=str(user or "").strip(),
        change_info="",
    )
    return validate_sidecar_core(payload)
