"""Table summary generation and caching."""
from __future__ import annotations

import os
import json
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd
from fastapi import HTTPException

from arcrho_api.io import persisted_json_text
from app_server import config
from app_server.services import field_mapping_service, source_table_service

# Bump whenever the cached summary payload gains or changes fields so stale
# caches are regenerated instead of served without the newer keys.
SUMMARY_VERSION = 6

# A date-role column holds a YYYYMM period, so it is binned by calendar year -
# one bar per year - rather than over its raw numeric span. Linear binning of
# YYYYMM combs badly: the 900 numeric units between 201701 and 202612 contain
# only 120 real values, because months 13-99 do not exist.
DATE_YEAR_BIN = 100
DATE_MIN_YEAR = 1000
DATE_MAX_YEAR = 9999
# Past this span one bar per year is unreadable, so such a column falls back to
# the ordinary numeric pipeline.
DATE_MAX_YEARS = 60

DISTRIBUTION_BIN_COUNT = 40
DISTRIBUTION_MIN_BIN_COUNT = 8
# Counts are accumulated this many times finer than they are published, Gaussian
# smoothed, then averaged back down. That is a binned kernel density estimate:
# the published shape reads as a continuous curve without paying the
# O(rows x grid) cost of evaluating a kernel against every row.
DISTRIBUTION_OVERSAMPLE = 8
DISTRIBUTION_SMOOTH_SIGMA_BINS = 1.0
# A highly concentrated column with long tails puts its whole body in one bin
# when the domain is the raw min/max. The histogram spans this central quantile
# window instead and clips the tails into the end bins; `stats` still carries
# the true min/max, and the preview prints it below the chart. Below the row
# threshold the window cannot hold a whole observation, so a short column is
# always drawn across its full range.
DISTRIBUTION_TAIL_QUANTILE = 0.005
DISTRIBUTION_CLIP_MIN_ROWS = int(1 / DISTRIBUTION_TAIL_QUANTILE)
TOP_VALUE_COUNT = 6


def is_cache_valid(csv_path: str, cache_path: str) -> bool:
    if not os.path.exists(cache_path):
        return False
    csv_mtime = os.stat(csv_path).st_mtime
    cache_mtime = os.stat(cache_path).st_mtime
    return cache_mtime > csv_mtime


def load_valid_cache(
    csv_path: str,
    cache_path: str,
    date_roles: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    """Return the cached summary only when it is fresh, current, and still mapped.

    Date-role columns are binned by year, so the payload depends on the field
    mapping as well as the CSV. Remapping Origin Date to another column leaves
    the CSV untouched, and a cache keyed on mtime alone would keep serving the
    old column's year bars.
    """
    if not is_cache_valid(csv_path, cache_path):
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(cached, dict):
        return None
    if int(cached.get("summary_version") or 0) != SUMMARY_VERSION:
        return None
    if cached.get("date_roles") != dict(date_roles or {}):
        return None
    return cached


def discard_cached_summary(cache_path: str) -> bool:
    """Delete the table-summary cache for a project. Returns whether it existed.

    Used by the refresh route: a re-import advances the imported table's
    modification time, so the cached payload is already stale.
    """
    try:
        os.remove(cache_path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def resolve_master_table(project_name: str, *, force: bool) -> str:
    """Project-owned imported table, refreshed from its configured source."""
    try:
        status = source_table_service.ensure_master_table(project_name, force=force)
    except source_table_service.SourceTableNotConfiguredError as error:
        raise HTTPException(400, str(error))
    except source_table_service.SourceTableMissingError as error:
        raise HTTPException(409, str(error))
    except FileNotFoundError as error:
        raise HTTPException(404, str(error))
    master_path = str(status.get("master_table_path") or "")
    if not master_path or not os.path.isfile(master_path):
        raise HTTPException(409, f"No imported source table for project: {project_name}")
    return master_path


def write_summary_cache(cache_path: str, summary: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(persisted_json_text(summary))


def get_table_summary(project_name: str) -> Dict[str, Any]:
    """Serve the imported table's summary, regenerating it only when stale.

    Reading the whole master table to summarize it is the expensive step, so
    this is registered as a Server-hosted workspace read
    (``arcrho_workspace_read_contract``) and may run on the server host.
    """
    name = str(project_name or "").strip()
    if not name:
        raise HTTPException(400, "Missing project_name parameter")

    try:
        master_path = resolve_master_table(name, force=False)
        cache_path = config.get_table_summary_cache_path(name)
        # Date-role columns are summarized by year, so the mapping is part of
        # what makes a cached payload current.
        date_roles = field_mapping_service.load_date_role_fields(name)

        cached_data = load_valid_cache(master_path, cache_path, date_roles)
        if cached_data is not None:
            cached_data["from_cache"] = True
            return cached_data

        summary = generate_table_summary(master_path, date_roles)
        summary["from_cache"] = False
        write_summary_cache(cache_path, summary)
        return summary
    except ValueError as e:
        raise HTTPException(404, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error reading file: {str(e)}")


def _date_year_distribution(values: pd.Series) -> Optional[Dict[str, Any]]:
    """One linear bar per calendar year for a YYYYMM date-role column.

    Returns `None` when the column cannot be read as YYYYMM periods or spans
    too many years to draw a bar each, so the caller falls back to the ordinary
    numeric pipeline.
    """
    arr = pd.to_numeric(values, errors="coerce").to_numpy(dtype="float64")
    arr = arr[np.isfinite(arr)]
    if not arr.size:
        return None
    periods = arr.astype("int64")
    years, months = np.divmod(periods, DATE_YEAR_BIN)
    # Placeholder zeros and any other non-period value are excluded from the
    # chart. `stats` still reports the column's raw minimum and maximum.
    usable = (
        (years >= DATE_MIN_YEAR) & (years <= DATE_MAX_YEAR)
        & (months >= 1) & (months <= 12)
    )
    years = years[usable]
    if not years.size:
        return None

    first_year = int(years.min())
    last_year = int(years.max())
    span = last_year - first_year + 1
    if span > DATE_MAX_YEARS:
        return None

    # Dense across the span, so a year with no rows stays visible as a gap.
    counts = np.bincount(years - first_year, minlength=span).astype("float64")
    peak = float(counts.max())
    if peak <= 0:
        return None
    labels = [str(first_year + offset) for offset in range(span)]
    return {
        "kind": "numeric",
        # Linear heights: one year of rows against another is a fair comparison,
        # so these do not need the root scaling the free-form numeric path uses.
        "bins": [round(float(c) / peak, 4) for c in counts],
        "edges": [float(first_year + offset) for offset in range(span + 1)],
        "bin_labels": labels,
        "clipped_low": False,
        "clipped_high": False,
    }


def _empty_numeric_distribution() -> Dict[str, Any]:
    return {
        "kind": "numeric",
        "bins": [],
        "edges": [],
        "clipped_low": False,
        "clipped_high": False,
    }


def _gaussian_kernel(sigma: float) -> np.ndarray:
    """Unit-area Gaussian sampled on whole bins, truncated at three sigma."""
    radius = int(max(1, round(sigma * 3)))
    offsets = np.arange(-radius, radius + 1, dtype="float64")
    kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
    return kernel / kernel.sum()


def _distribution_domain(values: np.ndarray) -> tuple:
    """Central quantile window for the drawn histogram, plus which ends it clips."""
    data_min = float(values.min())
    data_max = float(values.max())
    lo = hi = float("nan")
    if values.size >= DISTRIBUTION_CLIP_MIN_ROWS:
        # One call, so the window costs a single partition pass rather than two.
        lo, hi = (float(q) for q in np.quantile(
            values, [DISTRIBUTION_TAIL_QUANTILE, 1.0 - DISTRIBUTION_TAIL_QUANTILE]))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = data_min, data_max
    if hi <= lo:
        # Constant column: draw the single value inside a symmetric unit window.
        return lo - 0.5, hi + 0.5, False, False
    # Reported per end: a zero-floored column clips only its right tail, and the
    # preview must not label a bin open-ended when nothing folded into it.
    return lo, hi, bool(lo > data_min), bool(hi < data_max)


def _numeric_distribution(values: pd.Series) -> Dict[str, Any]:
    """Smoothed, quantile-framed histogram heights in [0, 1] plus bin edges."""
    arr = pd.to_numeric(values, errors="coerce").to_numpy(dtype="float64")
    # One mask drops nulls and infinities together. Infinities survive `dropna`
    # and would otherwise collapse the whole domain onto a single bin.
    arr = arr[np.isfinite(arr)]
    if not arr.size:
        return _empty_numeric_distribution()

    lo, hi, clipped_low, clipped_high = _distribution_domain(arr)
    framed = np.clip(arr, lo, hi)
    counts, _ = np.histogram(
        framed,
        bins=DISTRIBUTION_BIN_COUNT * DISTRIBUTION_OVERSAMPLE,
        range=(lo, hi),
    )
    # Occupied fine bins bound how much structure the column can actually
    # resolve. Drawing more output bins than that combs a low-cardinality column
    # into alternating full and empty bars that read as structure it does not
    # have. Counting them is free here; a distinct-value pass over the rows is
    # not, and this also catches a column whose values all crowd into one place.
    bin_count = int(np.count_nonzero(counts))
    if bin_count < DISTRIBUTION_BIN_COUNT:
        bin_count = max(DISTRIBUTION_MIN_BIN_COUNT, bin_count)
        counts, _ = np.histogram(
            framed, bins=bin_count * DISTRIBUTION_OVERSAMPLE, range=(lo, hi))
    else:
        bin_count = DISTRIBUTION_BIN_COUNT
    smoothed = np.convolve(
        counts.astype("float64"),
        _gaussian_kernel(DISTRIBUTION_SMOOTH_SIGMA_BINS * DISTRIBUTION_OVERSAMPLE),
        mode="same",
    )
    density = smoothed.reshape(bin_count, DISTRIBUTION_OVERSAMPLE).mean(axis=1)
    peak = float(density.max())
    if peak <= 0:
        return _empty_numeric_distribution()
    # Square-root heights. Under linear scaling a column whose mass sits in one
    # bin leaves every other bar at 1-2% of the peak, so the tails render as a
    # flat line beside a bare spike instead of as a distribution.
    heights = np.sqrt(density / peak)
    edges = np.linspace(lo, hi, bin_count + 1)
    return {
        "kind": "numeric",
        "bins": [round(float(h), 4) for h in heights],
        # Significant digits, not decimal places: a column of 1e-9 values rounds
        # every edge to 0.0 and every hover label to "0 ~ 0".
        "edges": [float(f"{e:.12g}") for e in edges],
        "clipped_low": clipped_low,
        "clipped_high": clipped_high,
    }


def _categorical_distribution(values: pd.Series, distinct_count: int) -> Dict[str, Any]:
    """Share of the most frequent values, plus the remaining tail."""
    total = int(values.shape[0])
    if total <= 0:
        return {"kind": "categorical", "items": [], "other_share": 0.0, "other_count": 0}
    counts = values.value_counts()
    top = counts.head(TOP_VALUE_COUNT)
    items = [
        {"label": str(label), "share": round(float(count) / total, 6)}
        for label, count in top.items()
    ]
    shown = sum(item["share"] for item in items)
    return {
        "kind": "categorical",
        "items": items,
        "other_share": round(max(0.0, 1.0 - shown), 6),
        "other_count": max(0, int(distinct_count) - len(items)),
    }


def _distribution_for_column(col_data: pd.Series, role: str) -> Dict[str, Any]:
    """Year bars for a mapped date column, else the free-form numeric shape."""
    if role:
        by_year = _date_year_distribution(col_data)
        if by_year is not None:
            return by_year
    return _numeric_distribution(col_data)


def generate_table_summary(
    path: str,
    date_roles: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Summarize the imported table.

    `date_roles` maps a column name to its `Origin Date`/`Development Date`
    significance, resolved by `field_mapping_service.load_date_role_fields`.
    Those columns are published with their role and binned by calendar year.
    """
    st = os.stat(path)
    file_size = st.st_size

    # Names are matched case-insensitively and untrimmed, the same rule the
    # mapping panel applies when it pairs a mapped field to a table column.
    roles_by_key = {
        str(name or "").strip().lower(): str(significance or "").strip()
        for name, significance in (date_roles or {}).items()
        if str(name or "").strip() and str(significance or "").strip()
    }

    df = pd.read_csv(path)
    row_count = len(df)

    columns = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        col_data = df[col].dropna()
        role = roles_by_key.get(str(col).strip().lower(), "")
        distinct_count: Optional[int] = None
        distribution: Dict[str, Any] = {"kind": "none"}
        # Raw min/max for numeric and datetime columns (JSON-safe plain types)
        # so consumers can format ranges without parsing the display string.
        stats: Optional[Dict[str, Any]] = None

        if "int" in dtype:
            friendly_type = "Integer"
            distribution = _distribution_for_column(col_data, role)
            if len(col_data) > 0:
                min_val = int(col_data.min())
                max_val = int(col_data.max())
                stats = {"min": min_val, "max": max_val}
                values_str = f"Range: ({min_val:,}, {max_val:,})"
            else:
                values_str = "(empty)"
        elif "float" in dtype:
            friendly_type = "Float"
            distribution = _distribution_for_column(col_data, role)
            if len(col_data) > 0:
                min_val = float(col_data.min())
                max_val = float(col_data.max())
                stats = {"min": min_val, "max": max_val}
                if abs(max_val) >= 1000 or abs(min_val) >= 1000:
                    values_str = f"Range: ({min_val:,.2f}, {max_val:,.2f})"
                else:
                    values_str = f"Range: ({min_val:.4f}, {max_val:.4f})"
            else:
                values_str = "(empty)"
        elif "object" in dtype:
                friendly_type = "String"
                distinct = col_data.unique().tolist()
                distinct_count = len(distinct)
                distribution = _categorical_distribution(col_data, distinct_count)
                if distinct_count <= 10:
                    values_str = ", ".join(str(v) for v in sorted(distinct, key=str))
                else:
                    sample = sorted(distinct, key=str)[:10]
                    values_str = f"{distinct_count} distinct: {', '.join(str(v) for v in sample)}..."
        elif "datetime" in dtype:
            friendly_type = "DateTime"
            distribution = _distribution_for_column(col_data, role)
            if len(col_data) > 0:
                min_val = col_data.min()
                max_val = col_data.max()
                stats = {"min": str(min_val), "max": str(max_val)}
                values_str = f"Range: {min_val} - {max_val}"
            else:
                values_str = "(empty)"
        elif "bool" in dtype:
            friendly_type = "Boolean"
            distinct_count = int(col_data.nunique()) if len(col_data) > 0 else 0
            distribution = _categorical_distribution(col_data.astype(str), distinct_count)
            values_str = "True, False"
        else:
            friendly_type = dtype
            values_str = "(unknown)"

        null_count = int(row_count - len(col_data))
        columns.append({
            "name": str(col),
            "dtype": dtype,
            "type": friendly_type,
            # Resolved here so consumers read one answer instead of re-deriving
            # the mapping rule from `field_mapping.json` themselves.
            "role": role,
            "values": values_str,
            "distinct_count": distinct_count,
            "null_count": null_count,
            "null_ratio": round(null_count / row_count, 6) if row_count else 0.0,
            "stats": stats,
            "distribution": distribution,
        })

    if file_size < 1024:
        size_str = f"{file_size} B"
    elif file_size < 1024 * 1024:
        size_str = f"{file_size / 1024:.1f} KB"
    else:
        size_str = f"{file_size / (1024 * 1024):.2f} MB"

    return {
        "ok": True,
        "summary_version": SUMMARY_VERSION,
        "path": path,
        "row_count": row_count,
        "column_count": len(columns),
        "file_size": file_size,
        "file_size_str": size_str,
        "columns": columns,
        # The mapping this payload was built against, so a later read can tell
        # whether the cache still matches the project's current field mapping.
        "date_roles": dict(date_roles or {}),
        "csv_mtime": st.st_mtime,
    }
