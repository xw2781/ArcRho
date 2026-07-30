"""Table summary generation and caching."""
from __future__ import annotations

import os
import json
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd

from app_server import config

# Bump whenever the cached summary payload gains or changes fields so stale
# caches are regenerated instead of served without the newer keys.
SUMMARY_VERSION = 2

DISTRIBUTION_BIN_COUNT = 16
TOP_VALUE_COUNT = 6


def is_cache_valid(csv_path: str, cache_path: str) -> bool:
    if not os.path.exists(cache_path):
        return False
    csv_mtime = os.stat(csv_path).st_mtime
    cache_mtime = os.stat(cache_path).st_mtime
    return cache_mtime > csv_mtime


def load_valid_cache(csv_path: str, cache_path: str) -> Optional[Dict[str, Any]]:
    """Return the cached summary only when it is fresh and current-version."""
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
    return cached


def _numeric_distribution(values: pd.Series) -> Dict[str, Any]:
    """Normalized histogram heights in [0, 1] for a numeric or datetime column."""
    numeric = pd.to_numeric(values, errors="coerce").dropna()
    if numeric.empty:
        return {"kind": "numeric", "bins": []}
    counts, _edges = np.histogram(numeric.to_numpy(dtype="float64"), bins=DISTRIBUTION_BIN_COUNT)
    peak = int(counts.max()) if counts.size else 0
    if peak <= 0:
        return {"kind": "numeric", "bins": []}
    return {"kind": "numeric", "bins": [round(float(c) / peak, 4) for c in counts]}


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


def generate_table_summary(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    file_size = st.st_size

    df = pd.read_csv(path)
    row_count = len(df)

    columns = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        col_data = df[col].dropna()
        distinct_count: Optional[int] = None
        distribution: Dict[str, Any] = {"kind": "none"}

        if "int" in dtype:
            friendly_type = "Integer"
            distribution = _numeric_distribution(col_data)
            if len(col_data) > 0:
                min_val = int(col_data.min())
                max_val = int(col_data.max())
                values_str = f"Range: ({min_val:,}, {max_val:,})"
            else:
                values_str = "(empty)"
        elif "float" in dtype:
            friendly_type = "Float"
            distribution = _numeric_distribution(col_data)
            if len(col_data) > 0:
                min_val = col_data.min()
                max_val = col_data.max()
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
            distribution = _numeric_distribution(col_data)
            if len(col_data) > 0:
                min_val = col_data.min()
                max_val = col_data.max()
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
            "values": values_str,
            "distinct_count": distinct_count,
            "null_count": null_count,
            "null_ratio": round(null_count / row_count, 6) if row_count else 0.0,
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
        "csv_mtime": st.st_mtime,
    }
