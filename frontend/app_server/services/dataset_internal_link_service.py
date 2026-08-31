"""Resolve ArcRho-internal dataset cell links.

A manual-input dataset cell can link its value to a cell or range of another
dataset in the same reserving class with a standalone reference written in the
DFM dataset-reference style, extended with an inclusive ``start:end`` range::

    =[C 82 - Prior Qtr Selected][1:6]
    =[Paid Claims][2024, 12]
    =[Paid Claims][1:6, 2]

The reference syntax and canonical stored text are owned by
``arcrho_api.dataset_link_contract``; this module translates its refusals into
``422`` responses and owns only the value resolution. Each axis coordinate
uses the DFM index semantics (quoted label, 1-based position, negative from
the valid boundary, bare label fallback), owned by
``dfm_service._dataset_reference_axis_index``; values come from the same
``dataset_service.load_cached_dataset_values`` read the DFM resolver uses, one
read per unique dataset.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping

from fastapi import HTTPException

from arcrho_api.dataset_link_contract import (
    INTERNAL_REFERENCE_SYNTAX_HINT,
    DatasetLinkError,
)
from arcrho_api import dataset_link_contract

from app_server.services.dfm_service import (
    _READ_EXECUTOR,
    _axis_labels,
    _clean,
    _dataset_reference_axis_index,
    _dataset_reference_valid_boundary,
    _key,
)


def parse_internal_reference(raw_text: Any) -> Dict[str, Any]:
    """Parse one standalone internal reference; 422 when the text is not one."""

    try:
        return dataset_link_contract.parse_internal_reference(raw_text)
    except DatasetLinkError as err:
        raise HTTPException(422, str(err))


def canonical_internal_reference(raw_text: Any) -> str:
    """Return the normalized stored text for a valid internal reference."""

    try:
        return dataset_link_contract.canonical_internal_reference(raw_text)
    except DatasetLinkError as err:
        raise HTTPException(422, str(err))


def _axis_span(
    spec: Mapping[str, Any],
    labels: Iterable[Any],
    *,
    axis_name: str,
    dataset_name: str,
    negative_index_length: int | None,
) -> Dict[str, Any]:
    start_index, start_label = _dataset_reference_axis_index(
        spec["start"],
        labels,
        axis_name=axis_name,
        dataset_name=dataset_name,
        negative_index_length=negative_index_length,
    )
    if spec.get("end") is None:
        return {"start": start_index, "end": start_index, "labels": [start_label]}
    end_index, _end_label = _dataset_reference_axis_index(
        spec["end"],
        labels,
        axis_name=axis_name,
        dataset_name=dataset_name,
        negative_index_length=negative_index_length,
    )
    if end_index < start_index:
        raise HTTPException(
            422,
            f"{axis_name.capitalize()} range start must not be after its end in '{dataset_name}'.",
        )
    axis_labels = _axis_labels(labels)
    return {
        "start": start_index,
        "end": end_index,
        "labels": axis_labels[start_index : end_index + 1],
    }


def _resolved_internal_reference(
    reference_text: str,
    parsed: Mapping[str, Any],
    dataset: Mapping[str, Any],
) -> Dict[str, Any]:
    requested_name = _clean(parsed.get("dataset_name"))
    dataset_name = _clean(dataset.get("dataset_name")) or requested_name
    values = dataset.get("values") if isinstance(dataset.get("values"), list) else []
    origin_labels = dataset.get("origin_labels") if isinstance(dataset.get("origin_labels"), list) else []
    data_format = _clean(dataset.get("data_format")) or "Triangle"
    is_vector = data_format.casefold() == "vector"
    valid_boundary = _dataset_reference_valid_boundary(values, vector=is_vector)
    rows = _axis_span(
        parsed["row"],
        origin_labels,
        axis_name="row",
        dataset_name=dataset_name,
        negative_index_length=valid_boundary + 1,
    )
    col_spec = parsed.get("col")
    if not is_vector and col_spec is None:
        raise HTTPException(422, f"Column index is required for Triangle dataset '{dataset_name}'.")
    development_labels = (
        dataset.get("dev_labels") if isinstance(dataset.get("dev_labels"), list) else []
    )
    if is_vector and not development_labels:
        development_labels = ["Ultimate"]
    columns = _axis_span(
        col_spec if col_spec is not None else {"start": "1", "end": None},
        development_labels,
        axis_name="column",
        dataset_name=dataset_name,
        negative_index_length=(
            len(development_labels)
            if is_vector
            else max(0, valid_boundary - rows["start"] + 1)
        ),
    )
    cells: List[Dict[str, Any]] = []
    for row_index in range(rows["start"], rows["end"] + 1):
        row = values[row_index] if row_index < len(values) and isinstance(values[row_index], list) else []
        row_label = rows["labels"][row_index - rows["start"]]
        for col_index in range(columns["start"], columns["end"] + 1):
            value = row[col_index] if col_index < len(row) else None
            if value is None or (isinstance(value, str) and not value.strip()):
                numeric_value = None
            else:
                try:
                    numeric_value = float(value)
                except (TypeError, ValueError) as exc:
                    raise HTTPException(
                        422,
                        f"Referenced cell [{dataset_name}][{row_label}, "
                        f"{columns['labels'][col_index - columns['start']]}] is non-numeric.",
                    ) from exc
                if not math.isfinite(numeric_value):
                    raise HTTPException(
                        422,
                        f"Referenced cell [{dataset_name}][{row_label}, "
                        f"{columns['labels'][col_index - columns['start']]}] is non-numeric.",
                    )
            cells.append(
                {
                    "row": row_index,
                    "column": col_index,
                    "row_label": row_label,
                    "col_label": columns["labels"][col_index - columns["start"]],
                    "value": numeric_value,
                }
            )
    return {
        "reference": reference_text,
        "dataset_name": dataset_name,
        "data_format": data_format,
        "row_start": rows["start"],
        "column_start": columns["start"],
        "row_count": rows["end"] - rows["start"] + 1,
        "column_count": columns["end"] - columns["start"] + 1,
        "cells": cells,
    }


def resolve_dataset_internal_links(
    project_name: str,
    reserving_class: str,
    references: Iterable[Any],
) -> Dict[str, Any]:
    """Resolve internal link references with one dataset read per unique name."""

    from app_server.services import dataset_service

    project = _clean(project_name)
    rc = _clean(reserving_class)
    requested = [str(reference if reference is not None else "") for reference in references or []]
    if not project or not rc:
        raise HTTPException(422, "Project and reserving class are required.")
    if not requested:
        raise HTTPException(422, "At least one dataset reference is required.")
    parsed = [parse_internal_reference(reference) for reference in requested]
    names_by_key: Dict[str, str] = {}
    for item in parsed:
        names_by_key.setdefault(_key(item["dataset_name"]), item["dataset_name"])
    futures = {
        key: _READ_EXECUTOR.submit(
            dataset_service.load_cached_dataset_values,
            project,
            rc,
            name,
        )
        for key, name in names_by_key.items()
    }
    datasets = {key: future.result() for key, future in futures.items()}
    return {
        "ok": True,
        "results": [
            _resolved_internal_reference(
                requested[index],
                item,
                datasets[_key(item["dataset_name"])],
            )
            for index, item in enumerate(parsed)
        ],
    }
