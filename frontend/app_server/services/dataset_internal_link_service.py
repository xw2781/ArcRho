"""Resolve ArcRho-internal dataset cell links.

A manual-input dataset cell can link its value to a cell or range of another
dataset in the same reserving class with a standalone reference written in the
DFM dataset-reference style, extended with an inclusive ``start:end`` range::

    =[C 82 - Prior Qtr Selected][1:6]
    =[Paid Claims][2024, 12]
    =[Paid Claims][1:6, 2]

Each axis coordinate uses the DFM index semantics (quoted label, 1-based
position, negative from the valid boundary, bare label fallback), owned by
``dfm_service._dataset_reference_axis_index``. This module owns only the
standalone-reference syntax and the rectangle expansion; values come from the
same ``dataset_service.load_cached_dataset_values`` read the DFM resolver uses,
one read per unique dataset.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping

from fastapi import HTTPException

from app_server.services.dfm_service import (
    _READ_EXECUTOR,
    _axis_labels,
    _clean,
    _dataset_reference_axis_index,
    _dataset_reference_valid_boundary,
    _key,
)

INTERNAL_REFERENCE_SYNTAX_HINT = (
    "Use =[Dataset][row] or =[Dataset][start:end] for a vector, and "
    "=[Dataset][row, col] or =[Dataset][rows, cols] for a triangle."
)


def _split_quote_aware(raw: str, separator: str) -> List[str]:
    parts: List[str] = []
    current = ""
    quote = ""
    for character in str(raw or ""):
        if quote:
            current += character
            if character == quote:
                quote = ""
            continue
        if character in {'"', "'"}:
            quote = character
            current += character
            continue
        if character == separator:
            parts.append(current.strip())
            current = ""
            continue
        current += character
    if quote:
        raise HTTPException(422, "Dataset reference contains an unclosed quote.")
    parts.append(current.strip())
    return parts


def _parse_axis_spec(raw: str, *, axis_name: str) -> Dict[str, Any]:
    endpoints = _split_quote_aware(raw, ":")
    if len(endpoints) > 2 or not endpoints[0] or (len(endpoints) == 2 and not endpoints[1]):
        raise HTTPException(
            422,
            f"{axis_name.capitalize()} range must be one index or start:end. "
            + INTERNAL_REFERENCE_SYNTAX_HINT,
        )
    return {
        "start": endpoints[0],
        "end": endpoints[1] if len(endpoints) == 2 else None,
    }


def parse_internal_reference(raw_text: Any) -> Dict[str, Any]:
    """Parse one standalone internal reference; 422 when the text is not one."""

    text = _clean(raw_text)
    if text.startswith("="):
        text = text[1:].lstrip()
    if not text.startswith("["):
        raise HTTPException(422, INTERNAL_REFERENCE_SYNTAX_HINT)
    name_end = text.find("]", 1)
    if name_end < 0:
        raise HTTPException(422, "Dataset reference is missing its closing bracket.")
    dataset_name = text[1:name_end].strip()
    if not dataset_name:
        raise HTTPException(422, "Dataset reference name cannot be blank.")
    remainder = text[name_end + 1 :].lstrip()
    if not remainder.startswith("["):
        raise HTTPException(422, INTERNAL_REFERENCE_SYNTAX_HINT)
    quote = ""
    coordinate_end = -1
    for index in range(1, len(remainder)):
        character = remainder[index]
        if quote:
            if character == quote:
                quote = ""
            continue
        if character in {'"', "'"}:
            quote = character
            continue
        if character == "]":
            coordinate_end = index
            break
    if coordinate_end < 0:
        raise HTTPException(422, "Dataset reference is missing its closing bracket.")
    if remainder[coordinate_end + 1 :].strip():
        raise HTTPException(
            422,
            "An internal dataset link must be a single standalone reference. "
            + INTERNAL_REFERENCE_SYNTAX_HINT,
        )
    coordinates = _split_quote_aware(remainder[1:coordinate_end], ",")
    if not coordinates[0]:
        raise HTTPException(422, "Dataset reference row index is required.")
    if len(coordinates) > 2 or (len(coordinates) == 2 and not coordinates[1]):
        raise HTTPException(422, INTERNAL_REFERENCE_SYNTAX_HINT)
    return {
        "dataset_name": dataset_name,
        "row": _parse_axis_spec(coordinates[0], axis_name="row"),
        "col": _parse_axis_spec(coordinates[1], axis_name="column") if len(coordinates) == 2 else None,
    }


def canonical_internal_reference(raw_text: Any) -> str:
    """Return the normalized stored text for a valid internal reference."""

    parsed = parse_internal_reference(raw_text)

    def axis_text(spec: Mapping[str, Any] | None) -> str:
        if not spec:
            return ""
        start = str(spec["start"])
        end = spec.get("end")
        return f"{start}:{end}" if end is not None else start

    coordinates = axis_text(parsed["row"])
    if parsed["col"] is not None:
        coordinates = f"{coordinates}, {axis_text(parsed['col'])}"
    return f"=[{parsed['dataset_name']}][{coordinates}]"


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
