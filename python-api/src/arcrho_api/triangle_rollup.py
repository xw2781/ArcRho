"""Roll a triangle up from a finer origin/development period to a coarser one.

This module is the single owner of that arithmetic. The bundled app server
derives a coarser cached view of a stored triangle with it, and the Engine
bundle carries the same module for the same reason.

Geometry
--------
Every ArcRho triangle is anchored on the project's Origin Start Date: row ``i``
covers the months starting ``origin_start_month + i * origin_length``, whatever
the period length, and the diagonal mask is built from the same anchor
(``dataset_service._empty_dataset_geometry_from_general_settings``). A coarse
origin period therefore always begins where one of the finer origin periods
begins, and the two grids line up without an offset.

A development-aligned triangle (the ``dev`` cache variant) holds, in row ``i``
and column ``j``, the figure for the origin period starting
``i * origin_length`` months after the anchor, valued ``(j + 1) *
development_length`` months after that origin period starts. Two cells in the
same column therefore carry two different valuation dates, one origin period
apart. A coarse cell has a single valuation date, so its parts are read along
the calendar diagonal of the finer triangle: the finer row that starts ``r``
origin periods into the block is read ``r * origin_length /
development_length`` columns earlier than the first row of the block.

A calendar-aligned triangle (the ``cal`` variant) has already been reshaped so
that a column is a calendar period rather than an age. Its columns share one
valuation date down the whole triangle, so rolling it up is a plain block
aggregation with no diagonal shift.

Blank cells
-----------
For a development-aligned triangle every finer cell a coarse cell needs shares
one valuation date, so a well-formed triangle either holds all of them or none
of them. A coarse cell whose parts are not all present is therefore blank
rather than a partial sum. A calendar-aligned triangle is different: a finer
origin period that starts later than a calendar column has no cell there and
contributed nothing, so blanks are read as zero and the coarse cell is blank
only when the whole block is.
"""
from __future__ import annotations

from typing import Any, List, Sequence

Triangle = Sequence[Sequence[Any]]

__all__ = ["rollup_reason", "rollup_factors", "rollup_triangle"]


def _positive_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def rollup_reason(
    source_origin_length: Any,
    source_development_length: Any,
    target_origin_length: Any,
    target_development_length: Any,
    *,
    calendar: bool = False,
) -> str:
    """Return an empty string when the roll-up is possible, else why it is not."""
    source_origin = _positive_int(source_origin_length)
    source_development = _positive_int(source_development_length)
    target_origin = _positive_int(target_origin_length)
    target_development = _positive_int(target_development_length)
    if not (source_origin and source_development and target_origin and target_development):
        return "invalid period length"
    if target_origin < source_origin or target_development < source_development:
        return "local caches can only derive from finer to coarser periods"
    if target_origin % source_origin or target_development % source_development:
        return "requested periods are not whole multiples of the cached periods"
    if not calendar and target_origin // source_origin > 1 and source_origin % source_development:
        return (
            f"origin periods of {source_origin} months are not a whole number of "
            f"{source_development}-month development periods, so the rows of a block "
            "share no valuation date"
        )
    return ""


def rollup_factors(
    source_origin_length: Any,
    source_development_length: Any,
    target_origin_length: Any,
    target_development_length: Any,
    *,
    calendar: bool = False,
) -> tuple[int, int]:
    """How many finer origin rows and development columns make one coarse cell."""
    reason = rollup_reason(
        source_origin_length,
        source_development_length,
        target_origin_length,
        target_development_length,
        calendar=calendar,
    )
    if reason:
        raise ValueError(reason)
    return (
        _positive_int(target_origin_length) // _positive_int(source_origin_length),
        _positive_int(target_development_length) // _positive_int(source_development_length),
    )


def _cell(rows: List[List[Any]], row_index: int, column_index: int) -> float | None:
    if row_index >= len(rows):
        return None
    row = rows[row_index]
    if column_index >= len(row):
        return None
    value = row[column_index]
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def _rollup_development(
    rows: List[List[Any]],
    target_rows: int,
    target_columns: int,
    origin_factor: int,
    development_factor: int,
    columns_per_origin: int,
    cumulative: bool,
) -> List[List[float | None]]:
    values: List[List[float | None]] = []
    for block in range(target_rows):
        row_values: List[float | None] = []
        for column in range(target_columns):
            total = 0.0
            complete = True
            for offset in range(origin_factor):
                shift = offset * columns_per_origin
                last = (column + 1) * development_factor - 1 - shift
                first = last if cumulative else column * development_factor - shift
                if last < 0:
                    # This finer origin period had not started at the coarse
                    # valuation date, so it contributed nothing.
                    continue
                for column_index in range(max(first, 0), last + 1):
                    cell = _cell(rows, block * origin_factor + offset, column_index)
                    if cell is None:
                        complete = False
                        break
                    total += cell
                if not complete:
                    break
            row_values.append(total if complete else None)
        values.append(row_values)
    return values


def _rollup_calendar(
    rows: List[List[Any]],
    target_rows: int,
    target_columns: int,
    origin_factor: int,
    development_factor: int,
    cumulative: bool,
) -> List[List[float | None]]:
    values: List[List[float | None]] = []
    for block in range(target_rows):
        row_values: List[float | None] = []
        for column in range(target_columns):
            if cumulative:
                columns = [(column + 1) * development_factor - 1]
            else:
                columns = list(range(column * development_factor, (column + 1) * development_factor))
            total = 0.0
            seen = False
            for offset in range(origin_factor):
                for column_index in columns:
                    cell = _cell(rows, block * origin_factor + offset, column_index)
                    if cell is not None:
                        total += cell
                        seen = True
            row_values.append(total if seen else None)
        values.append(row_values)
    return values


def rollup_triangle(
    values: Triangle,
    *,
    source_origin_length: Any,
    source_development_length: Any,
    target_origin_length: Any,
    target_development_length: Any,
    cumulative: bool = True,
    calendar: bool = False,
) -> List[List[float | None]]:
    """Aggregate ``values`` to the coarser target periods.

    ``values`` is a development-aligned triangle unless ``calendar`` is set.
    Rows and columns that do not fill a whole coarse period are dropped, as a
    coarse cell can only be reported once every part of it exists.
    """
    origin_factor, development_factor = rollup_factors(
        source_origin_length,
        source_development_length,
        target_origin_length,
        target_development_length,
        calendar=calendar,
    )
    rows = [list(row) for row in (values or [])]
    target_rows = len(rows) // origin_factor
    target_columns = max((len(row) for row in rows), default=0) // development_factor
    if target_rows <= 0 or target_columns <= 0:
        raise ValueError("cached triangle is smaller than the requested output size")
    if calendar:
        return _rollup_calendar(
            rows, target_rows, target_columns, origin_factor, development_factor, cumulative
        )
    columns_per_origin = _positive_int(source_origin_length) // _positive_int(source_development_length)
    return _rollup_development(
        rows,
        target_rows,
        target_columns,
        origin_factor,
        development_factor,
        columns_per_origin,
        cumulative,
    )
