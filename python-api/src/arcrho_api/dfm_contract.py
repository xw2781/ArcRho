"""Canonical, location-independent contract and calculations for DFM methods.

The functions in this module are intentionally free of filesystem and web
framework dependencies.  Persisted-data producers supply source snapshots and
delegate normalization and calculation here so an equivalent logical DFM emits
an equivalent JSON payload regardless of the producer or machine path.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import re
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Iterable, Mapping


DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v2"
LEGACY_DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"
DFM_VALUE_DECIMAL_PLACES = 6
_QUANTUM = Decimal("0.000001")
_EXCEL_REFERENCE_RE = re.compile(
    r"(?:\[[^\]]+\]|(?:^|[=+\-*/,(])\s*'(?:[^']|'')+'!\s*\$?[A-Za-z]{1,3}\$?\d+|"
    r"(?:^|[=+\-*/,(])\s*[^\s+\-*/(),]+!\s*\$?[A-Za-z]{1,3}\$?\d+)",
    re.IGNORECASE,
)
_INTERNAL_LABEL_RE = re.compile(r'"([^"]+)"')


class DfmContractError(ValueError):
    """Raised when a DFM payload cannot satisfy the canonical v2 contract."""


def _clean(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split()).strip()


def _timestamp(value: Any = None) -> str:
    cleaned = str(value if value is not None else "").strip()
    if cleaned:
        return cleaned
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _integer(value: Any, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        result = default
    result = max(minimum, result)
    return min(result, maximum) if maximum is not None else result


def canonical_number(value: Any) -> float | int | None:
    """Return one JSON number rounded half-away-from-zero to six decimals."""

    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        number = float(value)
        if not math.isfinite(number):
            return None
        rounded = Decimal(str(abs(number))).quantize(_QUANTUM, rounding=ROUND_HALF_UP)
    except (TypeError, ValueError, InvalidOperation):
        return None
    result = float(rounded)
    if number < 0:
        result = -result
    if result == 0:
        result = 0.0
    if isinstance(value, int) and not isinstance(value, bool):
        return int(result)
    return result


_MONTH_BY_NAME = {
    "jan": 1, "january": 1, "feb": 2, "february": 2,
    "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def _origin_start_month(label: Any, period_length: int) -> tuple[int, int] | None:
    text = str(label if label is not None else "").strip()
    if period_length == 12 and re.fullmatch(r"\d{4}", text):
        return int(text), 1
    if period_length in {3, 6}:
        token = "Q" if period_length == 3 else "H"
        count = 4 if period_length == 3 else 2
        for pattern, reversed_parts in (
            (rf"(\d{{4}})\s*{token}([1-{count}])", False),
            (rf"{token}([1-{count}])\s*(\d{{4}})", True),
        ):
            match = re.fullmatch(pattern, text, re.IGNORECASE)
            if match:
                period, year = (int(match.group(1)), int(match.group(2))) if reversed_parts else (
                    int(match.group(2)), int(match.group(1))
                )
                return year, (period - 1) * period_length + 1
    if period_length == 1:
        match = re.fullmatch(r"(\d{4})(\d{2})", text)
        if match and 1 <= int(match.group(2)) <= 12:
            return int(match.group(1)), int(match.group(2))
        match = re.fullmatch(r"([A-Za-z]{3,9})\s+(\d{4})", text)
        if match and match.group(1).casefold() in _MONTH_BY_NAME:
            return int(match.group(2)), _MONTH_BY_NAME[match.group(1).casefold()]
    return None


def aggregate_vector_values(
    values: Iterable[Any],
    origin_labels: Iterable[Any],
    base_length: int,
    target_length: int,
) -> list[float | int | None]:
    """Aggregate a vector with the shared exact chronological-bucket rule."""

    vector = [canonical_number(item[0] if isinstance(item, list) and item else item) for item in values]
    labels = [str(item if item is not None else "") for item in origin_labels]
    factor = target_length // base_length if base_length and target_length % base_length == 0 else 0
    if factor <= 1 or not vector:
        return []
    buckets: dict[tuple[int, int], list[Any]] = {}
    order: list[tuple[int, int]] = []
    if len(labels) == len(vector) and base_length in {1, 3, 6, 12}:
        for label, value in zip(labels, vector):
            parsed = _origin_start_month(label, base_length)
            if parsed is None:
                buckets = {}
                break
            year, month = parsed
            key = (year, ((month - 1) // target_length) * target_length + 1)
            if key not in buckets:
                buckets[key] = []
                order.append(key)
            buckets[key].append(value)
    groups = [buckets[key] for key in order] if buckets else [
        vector[index:index + factor] for index in range(0, len(vector), factor)
    ]
    return [
        canonical_number(sum(float(value) for value in group if value is not None))
        if any(value is not None for value in group)
        else None
        for group in groups
    ]


def dfm_output_variants(payload: Mapping[str, Any]) -> dict[int, list[float | int | None]]:
    """Return primary and supported 3/6/12-period ultimate vector variants."""

    details = _tab(payload, "details tab")
    data = _tab(payload, "data tab")
    results = _tab(payload, "results tab")
    base_length = _integer(details.get("origin length"), 12, minimum=1)
    values = _numbers(results.get("ultimate vector"))
    variants = {base_length: values}
    for target_length in (3, 6, 12):
        if target_length <= base_length or target_length % base_length:
            continue
        aggregate = aggregate_vector_values(
            values,
            data.get("origin labels") if isinstance(data.get("origin labels"), list) else [],
            base_length,
            target_length,
        )
        if aggregate:
            variants[target_length] = aggregate
    return variants


def _labels(value: Any) -> list[str]:
    return [str(item if item is not None else "") for item in value] if isinstance(value, list) else []


def _duplicate_labels(labels: Iterable[Any]) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for raw in labels:
        label = str(raw if raw is not None else "")
        key = label
        if key in seen and label not in duplicates:
            duplicates.append(label)
        seen.add(key)
    return duplicates


def _numbers(value: Any) -> list[float | int | None]:
    return [canonical_number(item) for item in value] if isinstance(value, list) else []


def _number_matrix(value: Any) -> list[list[float | int | None]]:
    if not isinstance(value, list):
        return []
    return [_numbers(row) if isinstance(row, list) else [] for row in value]


def _bool_matrix(value: Any) -> list[list[bool]]:
    if not isinstance(value, list):
        return []
    return [[bool(item) for item in row] if isinstance(row, list) else [] for row in value]


def _int_matrix(value: Any) -> list[list[int]]:
    if not isinstance(value, list):
        return []
    return [
        [_integer(item, 0, minimum=0, maximum=2) for item in row]
        if isinstance(row, list)
        else []
        for row in value
    ]


def _text_matrix(value: Any) -> list[list[str]]:
    if not isinstance(value, list):
        return []
    return [
        [str(item if item is not None else "").strip() for item in row]
        if isinstance(row, list)
        else []
        for row in value
    ]


def _fit_matrix(matrix: list[list[Any]], rows: int, cols: int, fill: Any) -> list[list[Any]]:
    out: list[list[Any]] = []
    for row_index in range(rows):
        row = list(matrix[row_index]) if row_index < len(matrix) else []
        row = row[:cols]
        row.extend(deepcopy(fill) for _ in range(max(0, cols - len(row))))
        out.append(row)
    return out


def _trim_trailing_nulls(row: list[Any]) -> list[Any]:
    out = list(row)
    while out and out[-1] is None:
        out.pop()
    return out


def _settings(raw: Any, row_count: int) -> dict[str, list[Any]]:
    source = raw if isinstance(raw, dict) else {}
    average_types = _labels(source.get("averageType"))
    bases = _labels(source.get("base"))
    periods = list(source.get("periods")) if isinstance(source.get("periods"), list) else []
    excludes = list(source.get("exclude")) if isinstance(source.get("exclude"), list) else []
    out: dict[str, list[Any]] = {
        "averageType": [],
        "base": [],
        "periods": [],
        "exclude": [],
    }
    for index in range(row_count):
        average_type = average_types[index].lower() if index < len(average_types) else "custom"
        out["averageType"].append("user_entry" if average_type == "user_entry" else "custom")
        base = bases[index].lower() if index < len(bases) else "simple"
        out["base"].append(base if base in {"simple", "volume", "benchmark"} else "simple")
        period = periods[index] if index < len(periods) else "all"
        if not (isinstance(period, str) and period.strip().lower() == "all"):
            period = _integer(period, 0, minimum=0) or "all"
        out["periods"].append(period)
        out["exclude"].append(_integer(excludes[index] if index < len(excludes) else 0, 0, minimum=0))
    return out


def _default_average_formulas() -> dict[str, Any]:
    labels = ["Volume - all", "Simple - all", "User Entry"]
    return {
        "label": labels,
        "custom average formula settings": {
            "averageType": ["custom", "custom", "user_entry"],
            "base": ["volume", "simple", "simple"],
            "periods": ["all", "all", "all"],
            "exclude": [0, 0, 0],
        },
        "selected": [[], [], []],
        "values": [[], [], []],
        "inputs": [[], [], []],
    }


def _notes(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "ratio main table": deepcopy(source.get("ratio main table"))
        if isinstance(source.get("ratio main table"), dict)
        else {},
        "ratio summary table": deepcopy(source.get("ratio summary table"))
        if isinstance(source.get("ratio summary table"), dict)
        else {},
    }


def _tab(payload: Mapping[str, Any], name: str) -> dict[str, Any]:
    value = payload.get(name)
    return value if isinstance(value, dict) else {}


def source_snapshot_revision(snapshot: Mapping[str, Any]) -> str:
    """Hash canonical source content, ignoring producer-local timestamps/revisions."""

    origins = _labels(_snapshot_field(snapshot, "origin labels", "origin_labels"))
    developments = _labels(_snapshot_field(snapshot, "development labels", "development_labels"))
    raw_values = snapshot.get("values")
    is_matrix = isinstance(raw_values, list) and any(isinstance(row, list) for row in raw_values)
    values: Any = _number_matrix(raw_values) if is_matrix else _numbers(raw_values)
    raw_mask = snapshot.get("mask")
    mask: Any = _bool_matrix(raw_mask) if isinstance(raw_mask, list) else []
    projection = {
        "name": _clean(snapshot.get("name")),
        "origin labels": origins,
        "development labels": developments,
        "values": values,
        "mask": mask,
        "data format": _clean(_snapshot_field(snapshot, "data format", "data_format")),
        "number format": _clean(_snapshot_field(snapshot, "number format", "number_format")),
        "decimal places": _integer(
            _snapshot_field(snapshot, "decimal places", "decimal_places"),
            0,
            minimum=0,
            maximum=8,
        ),
    }
    return _hash_projection(projection)


def _is_direct_literal(value: Any) -> bool:
    text = str(value if value is not None else "").strip()
    if not text:
        return True
    if text.startswith("="):
        text = text[1:].strip()
    try:
        number = float(text)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number)


def normalize_dfm_method(
    payload: Mapping[str, Any],
    *,
    require_complete: bool = True,
    timestamp: Any = None,
) -> dict[str, Any]:
    """Return the exact canonical v2 payload for a grouped DFM method."""

    if not isinstance(payload, Mapping):
        raise DfmContractError("DFM method payload must be a JSON object.")
    json_format = str(payload.get("json format") or "").strip()
    if json_format not in {"", DFM_JSON_FORMAT}:
        raise DfmContractError(f"Unsupported DFM JSON format: {json_format!r}.")

    details_source = _tab(payload, "details tab")
    data_source = _tab(payload, "data tab")
    ratios_source = _tab(payload, "ratios tab")
    ratio_source = _tab(ratios_source, "ratio triangle")
    formulas_source = _tab(ratios_source, "average formulas")
    results_source = _tab(payload, "results tab")
    metadata_source = _tab(payload, "method metadata")
    provided_revisions = {
        key: str(metadata_source.get(key) or "").strip()
        for key in ("owned revision", "derived revision", "publication revision")
    }

    name = _clean(details_source.get("name"))
    output_type = _clean(details_source.get("output type"))
    output_dataset = _clean(details_source.get("output dataset")) or name
    input_name = _clean(details_source.get("input triangle"))
    origin_labels = _labels(data_source.get("origin labels"))
    development_labels = _labels(data_source.get("development labels"))
    row_count = len(origin_labels)
    dev_count = len(development_labels)
    input_values = _fit_matrix(_number_matrix(data_source.get("input data triangle values")), row_count, dev_count, None)
    raw_mask = _bool_matrix(data_source.get("input data triangle mask"))
    if not raw_mask:
        raw_mask = [[value is not None for value in row] for row in input_values]
    input_mask = _fit_matrix(raw_mask, row_count, dev_count, False)
    for row in range(row_count):
        for col in range(dev_count):
            if not input_mask[row][col]:
                input_values[row][col] = None
            elif input_values[row][col] is None:
                input_mask[row][col] = False

    ratio_origin_labels = _labels(ratio_source.get("origin labels")) or list(origin_labels)
    ratio_dev_labels = _labels(ratio_source.get("development labels"))
    ratio_values = [_trim_trailing_nulls(row) for row in _number_matrix(ratio_source.get("ratio values"))]
    excluded = _int_matrix(ratio_source.get("excluded"))

    formula_labels = _labels(formulas_source.get("label"))
    if not formula_labels:
        defaults = _default_average_formulas()
        formula_labels = defaults["label"]
        formulas_source = defaults
    formula_count = len(formula_labels)
    formula_cols = len(ratio_dev_labels) or dev_count or max(
        (
            len(row)
            for key in ("selected", "values", "inputs")
            for row in (formulas_source.get(key) if isinstance(formulas_source.get(key), list) else [])
            if isinstance(row, list)
        ),
        default=0,
    )
    selected = _fit_matrix(_int_matrix(formulas_source.get("selected")), formula_count, formula_cols, 0)
    formula_values = _fit_matrix(_number_matrix(formulas_source.get("values")), formula_count, formula_cols, None)
    formula_inputs = _fit_matrix(_text_matrix(formulas_source.get("inputs")), formula_count, formula_cols, "")

    basis_name = _clean(results_source.get("ratio basis dataset"))
    basis_origin_labels = _labels(results_source.get("ratio basis origin labels"))
    basis_values = _numbers(results_source.get("ratio basis values"))
    if not basis_name:
        basis_origin_labels = []
        basis_values = []

    input_data_format = _clean(data_source.get("data format")) or "Triangle"
    input_number_format = _clean(data_source.get("number format")) or "#,##0"
    input_decimal_places = _integer(data_source.get("decimal places"), 0, minimum=0, maximum=8)
    input_source_revision = source_snapshot_revision({
        "name": input_name,
        "origin labels": origin_labels,
        "development labels": development_labels,
        "values": input_values,
        "mask": input_mask,
        "data format": input_data_format,
        "number format": input_number_format,
        "decimal places": input_decimal_places,
    }) if origin_labels and development_labels else ""
    basis_data_format = _clean(results_source.get("ratio basis data format")) or "Vector"
    basis_number_format = _clean(results_source.get("ratio basis number format")) or "#,##0"
    basis_decimal_places = _integer(
        results_source.get("ratio basis decimal places"), 0, minimum=0, maximum=8
    )
    basis_source_revision = source_snapshot_revision({
        "name": basis_name,
        "origin labels": basis_origin_labels,
        "values": basis_values,
        "data format": basis_data_format,
        "number format": basis_number_format,
        "decimal places": basis_decimal_places,
    }) if basis_name and basis_origin_labels else ""

    default_time = _timestamp(timestamp)
    normalized = {
        "json format": DFM_JSON_FORMAT,
        "details tab": {
            "name": name,
            "output type": output_type,
            "output dataset": output_dataset,
            "output category": _clean(
                details_source.get("output category") or details_source.get("output dataset_category")
            ),
            "input triangle": input_name,
            "origin length": _integer(details_source.get("origin length"), 12, minimum=1),
            "development length": _integer(details_source.get("development length"), 12, minimum=1),
            "decimal places": _integer(details_source.get("decimal places"), 4, minimum=0, maximum=8),
        },
        "data tab": {
            "origin labels": origin_labels,
            "development labels": development_labels,
            "input data triangle values": input_values,
            "input data triangle mask": input_mask,
            "data format": input_data_format,
            "number format": input_number_format,
            "decimal places": input_decimal_places,
            "source revision": input_source_revision,
        },
        "ratios tab": {
            "ratio triangle": {
                "origin labels": ratio_origin_labels,
                "development labels": ratio_dev_labels,
                "ratio values": ratio_values,
                "excluded": excluded,
            },
            "average formulas": {
                "label": formula_labels,
                "custom average formula settings": _settings(
                    formulas_source.get("custom average formula settings"), formula_count
                ),
                "selected": selected,
                "values": formula_values,
                "inputs": formula_inputs,
            },
            "cell notes": _notes(ratios_source.get("cell notes")),
        },
        "results tab": {
            "ratio basis dataset": basis_name,
            "ratio basis origin labels": basis_origin_labels,
            "ratio basis values": basis_values,
            "ratio basis data format": basis_data_format,
            "ratio basis number format": basis_number_format,
            "ratio basis decimal places": basis_decimal_places,
            "ratio basis source revision": basis_source_revision,
            "ultimate ratio decimal places": _integer(
                results_source.get("ultimate ratio decimal places"), 2, minimum=0, maximum=8
            ),
            "ultimate vector": _numbers(results_source.get("ultimate vector")),
        },
        "method metadata": {
            "last modified": str(metadata_source.get("last modified") or "").strip() or default_time,
            "data refreshed": str(metadata_source.get("data refreshed") or "").strip() or default_time,
            "owned revision": "",
            "derived revision": "",
            "publication revision": "",
        },
    }
    _set_revisions(normalized)
    if require_complete:
        _validate_complete(normalized)
        for key, expected in method_revisions(normalized).items():
            if not provided_revisions[key]:
                raise DfmContractError(f"DFM method metadata.{key} is required.")
            if provided_revisions[key] != expected:
                raise DfmContractError(f"DFM method metadata.{key} does not match the canonical payload.")
    return normalized


def _validate_complete(payload: Mapping[str, Any]) -> None:
    details = _tab(payload, "details tab")
    data = _tab(payload, "data tab")
    results = _tab(payload, "results tab")
    for key in ("name", "output type", "output dataset", "input triangle"):
        if not _clean(details.get(key)):
            raise DfmContractError(f"DFM details tab.{key} is required.")
    origins = data.get("origin labels") if isinstance(data.get("origin labels"), list) else []
    devs = data.get("development labels") if isinstance(data.get("development labels"), list) else []
    if not origins or not devs:
        raise DfmContractError("DFM input snapshot must contain origin and development labels.")
    duplicates = _duplicate_labels(origins)
    if duplicates:
        raise DfmContractError("DFM input origin labels must be unique: " + ", ".join(duplicates))
    values = data.get("input data triangle values")
    mask = data.get("input data triangle mask")
    if not isinstance(values, list) or len(values) != len(origins):
        raise DfmContractError("DFM input values must contain one row per origin label.")
    if not isinstance(mask, list) or len(mask) != len(origins):
        raise DfmContractError("DFM input mask must contain one row per origin label.")
    if any(len(row) != len(devs) for row in values) or any(len(row) != len(devs) for row in mask):
        raise DfmContractError("DFM input values and mask must match the development-label geometry.")
    if not str(data.get("source revision") or "").strip():
        raise DfmContractError("DFM input snapshot must contain a source revision.")
    ratios = _tab(payload, "ratios tab")
    ratio = _tab(ratios, "ratio triangle")
    expected_ratio_labels = _ratio_development_labels(list(devs))
    if ratio.get("origin labels") != origins:
        raise DfmContractError("DFM ratio origin labels must equal the input origin labels.")
    if ratio.get("development labels") != expected_ratio_labels:
        raise DfmContractError("DFM ratio development labels do not match the input geometry.")
    ratio_values = ratio.get("ratio values")
    excluded = ratio.get("excluded")
    if not isinstance(ratio_values, list) or len(ratio_values) != len(origins):
        raise DfmContractError("DFM ratio values must contain one row per origin label.")
    if not isinstance(excluded, list) or len(excluded) != len(origins):
        raise DfmContractError("DFM exclusions must contain one row per origin label.")
    if any(not isinstance(row, list) or len(row) > max(0, len(devs) - 1) for row in ratio_values):
        raise DfmContractError("DFM ratio rows exceed the input development geometry.")
    if any(len(excluded[index]) != len(ratio_values[index]) for index in range(len(origins))):
        raise DfmContractError("DFM exclusion rows must match the corresponding ratio-value rows.")
    formulas = _tab(ratios, "average formulas")
    formula_labels = formulas.get("label") if isinstance(formulas.get("label"), list) else []
    formula_cols = len(expected_ratio_labels)
    for key in ("selected", "values", "inputs"):
        matrix = formulas.get(key)
        if not isinstance(matrix, list) or len(matrix) != len(formula_labels):
            raise DfmContractError(f"DFM average formulas.{key} must align to formula labels.")
        if any(not isinstance(row, list) or len(row) != formula_cols for row in matrix):
            raise DfmContractError(f"DFM average formulas.{key} must align to ratio columns.")
    ultimate = results.get("ultimate vector")
    if not isinstance(ultimate, list) or len(ultimate) != len(origins):
        raise DfmContractError("DFM ultimate vector must contain one value per origin label.")
    if _clean(results.get("ratio basis dataset")):
        if results.get("ratio basis origin labels") != origins:
            raise DfmContractError("DFM Ratio Basis labels must align exactly to the DFM origins.")
        if len(results.get("ratio basis values") or []) != len(origins):
            raise DfmContractError("DFM Ratio Basis values must align exactly to the DFM origins.")
        if not str(results.get("ratio basis source revision") or "").strip():
            raise DfmContractError("DFM Ratio Basis snapshot must contain a source revision.")


def _hash_projection(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _owned_formula_values(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    formulas = _tab(_tab(payload, "ratios tab"), "average formulas")
    labels = formulas.get("label") if isinstance(formulas.get("label"), list) else []
    settings = _tab(formulas, "custom average formula settings")
    types = settings.get("averageType") if isinstance(settings.get("averageType"), list) else []
    bases = settings.get("base") if isinstance(settings.get("base"), list) else []
    values = formulas.get("values") if isinstance(formulas.get("values"), list) else []
    inputs = formulas.get("inputs") if isinstance(formulas.get("inputs"), list) else []
    out: list[dict[str, Any]] = []
    for index, label in enumerate(labels):
        average_type = str(types[index] if index < len(types) else "").strip().lower()
        base = str(bases[index] if index < len(bases) else "").strip().lower()
        row_inputs = inputs[index] if index < len(inputs) and isinstance(inputs[index], list) else []
        row_values = values[index] if index < len(values) and isinstance(values[index], list) else []
        owned_values = [
            deepcopy(row_values[col]) if col < len(row_values) else None
            for col, formula in enumerate(row_inputs)
            if base == "benchmark" or (
                average_type == "user_entry" and (_is_direct_literal(formula) or _contains_excel_reference(formula))
            )
        ]
        owned_columns = [
            col
            for col, formula in enumerate(row_inputs)
            if base == "benchmark" or (
                average_type == "user_entry" and (_is_direct_literal(formula) or _contains_excel_reference(formula))
            )
        ]
        if not owned_columns:
            continue
        out.append({
            "label": label,
            "columns": owned_columns,
            "values": owned_values,
        })
    return out


def owned_projection(payload: Mapping[str, Any]) -> dict[str, Any]:
    details = _tab(payload, "details tab")
    ratios = _tab(payload, "ratios tab")
    ratio = _tab(ratios, "ratio triangle")
    formulas = _tab(ratios, "average formulas")
    results = _tab(payload, "results tab")
    ratio_origins = ratio.get("origin labels") if isinstance(ratio.get("origin labels"), list) else []
    ratio_devs = ratio.get("development labels") if isinstance(ratio.get("development labels"), list) else []
    excluded = ratio.get("excluded") if isinstance(ratio.get("excluded"), list) else []
    excluded_cells = [
        {
            "origin label": ratio_origins[row] if row < len(ratio_origins) else str(row),
            "development label": ratio_devs[col] if col < len(ratio_devs) else str(col),
        }
        for row, values in enumerate(excluded)
        if isinstance(values, list)
        for col, value in enumerate(values)
        if value == 1
    ]
    return {
        "details tab": deepcopy(details),
        "ratios tab": {
            "ratio triangle": {"excluded cells": excluded_cells},
            "average formulas": {
                "label": deepcopy(formulas.get("label") or []),
                "custom average formula settings": deepcopy(
                    formulas.get("custom average formula settings") or {}
                ),
                "selected": deepcopy(formulas.get("selected") or []),
                "inputs": deepcopy(formulas.get("inputs") or []),
                "owned values": _owned_formula_values(payload),
            },
            "cell notes": deepcopy(ratios.get("cell notes") or {}),
        },
        "results tab": {
            "ratio basis dataset": results.get("ratio basis dataset", ""),
            "ultimate ratio decimal places": results.get("ultimate ratio decimal places", 2),
        },
    }


def derived_projection(payload: Mapping[str, Any]) -> dict[str, Any]:
    data = _tab(payload, "data tab")
    ratios = _tab(payload, "ratios tab")
    ratio = _tab(ratios, "ratio triangle")
    formulas = _tab(ratios, "average formulas")
    results = _tab(payload, "results tab")
    return {
        "data tab": deepcopy(data),
        "ratios tab": {
            "ratio triangle": {
                "origin labels": deepcopy(ratio.get("origin labels") or []),
                "development labels": deepcopy(ratio.get("development labels") or []),
                "ratio values": deepcopy(ratio.get("ratio values") or []),
            },
            "average formula values": deepcopy(formulas.get("values") or []),
        },
        "results tab": {
            key: deepcopy(results.get(key))
            for key in (
                "ratio basis origin labels",
                "ratio basis values",
                "ratio basis data format",
                "ratio basis number format",
                "ratio basis decimal places",
                "ratio basis source revision",
                "ultimate vector",
            )
        },
    }


def publication_projection(payload: Mapping[str, Any]) -> dict[str, Any]:
    details = _tab(payload, "details tab")
    data = _tab(payload, "data tab")
    results = _tab(payload, "results tab")
    return {
        "output dataset": details.get("output dataset", ""),
        "output type": details.get("output type", ""),
        "output category": details.get("output category", ""),
        "origin length": details.get("origin length", 12),
        "decimal places": details.get("decimal places", 0),
        "origin labels": deepcopy(data.get("origin labels") or []),
        "ultimate vector": deepcopy(results.get("ultimate vector") or []),
    }


def persisted_projection(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return the on-disk form of a canonical DFM method.

    The input triangle is stored in a reduced form because every part of it that
    is dropped is exactly recoverable when the file is read back:

    * ``input data triangle mask`` is omitted. A cell is inside the triangle if
      and only if it holds a value -- an invariant ``normalize_dfm_method``
      enforces -- so the mask can only ever restate the values beside it.
    * Trailing nulls are trimmed from each input row, matching how
      ``ratio values`` and ``excluded`` are already stored. A null *inside* a row
      still marks a missing value inside the triangle.

    ``normalize_dfm_method`` derives the mask and refits every row, so this
    projection loses nothing; it exists to keep the persisted file readable.
    Applying it to an already-persisted payload is a no-op.

    This is a serialization projection only. The canonical in-memory payload
    keeps its rectangular geometry and its mask, so revisions, validation, and
    every calculation are unaffected.
    """

    persisted = deepcopy(dict(payload))
    data = persisted.get("data tab")
    if not isinstance(data, dict):
        return persisted
    data.pop("input data triangle mask", None)
    values = data.get("input data triangle values")
    if isinstance(values, list):
        data["input data triangle values"] = [
            _trim_trailing_nulls(row) if isinstance(row, list) else row
            for row in values
        ]
    return persisted


def method_revisions(payload: Mapping[str, Any]) -> dict[str, str]:
    return {
        "owned revision": _hash_projection(owned_projection(payload)),
        "derived revision": _hash_projection(derived_projection(payload)),
        "publication revision": _hash_projection(publication_projection(payload)),
    }


def _dependency_names(entries: Any) -> list[str]:
    if not isinstance(entries, list):
        return []
    names: list[str] = []
    seen: set[str] = set()
    for item in entries:
        if isinstance(item, Mapping):
            name = _clean(
                item.get("dataset_type_name") or item.get("dataset_name") or item.get("name")
            )
        else:
            name = _clean(item)
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


def dependency_entries(entries: Any) -> list[dict[str, str]]:
    """Normalize sidecar dependency identities to the canonical parsed shape."""

    return [{"dataset_type_name": name} for name in _dependency_names(entries)]


def dfm_precedent_names(payload: Mapping[str, Any]) -> list[str]:
    details = _tab(payload, "details tab")
    results = _tab(payload, "results tab")
    return _dependency_names([
        details.get("input triangle"),
        results.get("ratio basis dataset"),
    ])


def build_dfm_output_sidecar(
    payload: Mapping[str, Any],
    *,
    project_name: Any,
    reserving_class: Any,
    csv_file: Any,
    existing: Mapping[str, Any] | None = None,
    existing_record: bool | None = None,
    dependents: Any = None,
    notes: Any = None,
    timestamp: Any = None,
    user: Any = "",
    output_changed: bool = True,
    append_audit: bool = True,
    audit_action: Any = None,
    status: Any = 0,
) -> dict[str, Any]:
    """Build the sole canonical parsed payload for a DFM output sidecar."""

    method = normalize_dfm_method(payload, require_complete=True, timestamp=timestamp)
    prior = existing if isinstance(existing, Mapping) else {}
    record_exists = bool(prior) if existing_record is None else bool(existing_record)
    details = _tab(method, "details tab")
    data = _tab(method, "data tab")
    metadata = _tab(method, "method metadata")
    method_name = _clean(details.get("name"))
    output_dataset = _clean(details.get("output dataset")) or method_name
    published_at = _timestamp(timestamp)
    actor = _clean(user)
    if not output_changed and record_exists:
        published_at = str(prior.get("updated_at") or "").strip() or published_at
        actor = _clean(prior.get("modified_by") or prior.get("user")) or actor
    created = str(prior.get("created") or "").strip() or published_at
    sidecar_notes = str(prior.get("notes") or "") if notes is None else str(notes)
    audits = deepcopy(prior.get("audit_log")) if isinstance(prior.get("audit_log"), list) else []
    if append_audit:
        action = _clean(audit_action) or ("Update" if record_exists else "Insert")
        audits.append({
            "event_date": published_at,
            "action": action,
            "change_info": "" if action == "Insert" else "Values",
            "user": actor,
        })
    return {
        "dataset_name": output_dataset,
        "dataset_type": _clean(details.get("output type")) or output_dataset,
        "dataset_category": _clean(details.get("output category")),
        "reserving_class": _clean(reserving_class),
        "project_name": _clean(project_name),
        "source_kind": "dfm",
        "calculated": True,
        "formula": "",
        "method_name": method_name,
        "method_type": "DFM",
        "method_type_code": 1,
        "data_format": "Vector",
        "data_format_code": 1,
        "period_length": _integer(details.get("origin length"), 12, minimum=1),
        "transposed": False,
        "number_format": _clean(prior.get("number_format")) or "#,##0",
        "decimal_places": _integer(details.get("decimal places"), 0, minimum=0, maximum=8),
        "csv_file": _clean(csv_file),
        "notes": sidecar_notes,
        "origin_count": len(data.get("origin labels") or []),
        "origin_labels": deepcopy(data.get("origin labels") or []),
        "development_labels": ["Ultimate"],
        "Precedents": dependency_entries(dfm_precedent_names(method)),
        "Dependents": dependency_entries(prior.get("Dependents") if dependents is None else dependents),
        "created": created,
        "updated_at": published_at,
        "modified_by": actor,
        "user": actor,
        "status": _integer(status, 0, minimum=0),
        "publication_revision": str(metadata.get("publication revision") or "").strip(),
        "audit_log": audits,
    }


def _set_revisions(payload: dict[str, Any]) -> None:
    metadata = payload.setdefault("method metadata", {})
    metadata.update(method_revisions(payload))


def _snapshot_field(snapshot: Mapping[str, Any], spaced: str, snake: str) -> Any:
    return snapshot.get(spaced) if spaced in snapshot else snapshot.get(snake)


def _apply_input_snapshot(payload: dict[str, Any], snapshot: Mapping[str, Any]) -> None:
    details = payload["details tab"]
    old_ratio = payload["ratios tab"]["ratio triangle"]
    old_data_devs = _labels(payload["data tab"].get("development labels"))
    old_origins = _labels(old_ratio.get("origin labels"))
    old_devs = _labels(old_ratio.get("development labels"))
    old_excluded = _int_matrix(old_ratio.get("excluded"))

    name = _clean(snapshot.get("name"))
    if name:
        details["input triangle"] = name
    origins = _labels(_snapshot_field(snapshot, "origin labels", "origin_labels"))
    devs = _labels(_snapshot_field(snapshot, "development labels", "development_labels"))
    duplicates = _duplicate_labels(origins)
    if duplicates:
        raise DfmContractError("DFM input snapshot has duplicate origin labels: " + ", ".join(duplicates))
    if old_data_devs and old_data_devs != devs:
        raise DfmContractError(
            "DFM input development-label geometry changed; preserve the last valid method and require review."
        )
    values = _number_matrix(snapshot.get("values"))
    mask = _bool_matrix(snapshot.get("mask"))
    if not mask:
        mask = [[item is not None for item in row] for row in values]
    values = _fit_matrix(values, len(origins), len(devs), None)
    mask = _fit_matrix(mask, len(origins), len(devs), False)
    for row in range(len(origins)):
        for col in range(len(devs)):
            if not mask[row][col] or values[row][col] is None:
                values[row][col] = None
                mask[row][col] = False
    data = payload["data tab"]
    data_format = _clean(_snapshot_field(snapshot, "data format", "data_format")) or "Triangle"
    number_format = _clean(_snapshot_field(snapshot, "number format", "number_format")) or "#,##0"
    decimal_places = _integer(
        _snapshot_field(snapshot, "decimal places", "decimal_places"), 0, minimum=0, maximum=8
    )
    canonical_snapshot = {
        "name": details.get("input triangle"),
        "origin labels": origins,
        "development labels": devs,
        "values": values,
        "mask": mask,
        "data format": data_format,
        "number format": number_format,
        "decimal places": decimal_places,
    }
    data.update({
        "origin labels": origins,
        "development labels": devs,
        "input data triangle values": values,
        "input data triangle mask": mask,
        "data format": data_format,
        "number format": number_format,
        "decimal places": decimal_places,
        "source revision": source_snapshot_revision(canonical_snapshot),
    })
    ratio_labels = _ratio_development_labels(devs)
    origin_lookup = {label: index for index, label in enumerate(old_origins)}
    dev_lookup = {label: index for index, label in enumerate(old_devs)}
    remapped: list[list[int]] = []
    for origin in origins:
        old_row = origin_lookup.get(origin)
        row: list[int] = []
        for dev_label in ratio_labels:
            old_col = dev_lookup.get(dev_label)
            value = 0
            if old_row is not None and old_col is not None and old_row < len(old_excluded):
                source_row = old_excluded[old_row]
                if old_col < len(source_row):
                    value = source_row[old_col]
            row.append(value)
        remapped.append(row)
    old_ratio["origin labels"] = origins
    old_ratio["development labels"] = ratio_labels
    old_ratio["excluded"] = remapped


def _apply_ratio_basis_snapshot(payload: dict[str, Any], snapshot: Mapping[str, Any]) -> None:
    results = payload["results tab"]
    name = _clean(snapshot.get("name"))
    if name:
        results["ratio basis dataset"] = name
    if not _clean(results.get("ratio basis dataset")):
        results.update({
            "ratio basis origin labels": [],
            "ratio basis values": [],
            "ratio basis source revision": "",
        })
        return
    method_origins = payload["data tab"]["origin labels"]
    source_origins = _labels(_snapshot_field(snapshot, "origin labels", "origin_labels"))
    duplicates = _duplicate_labels(source_origins)
    if duplicates:
        raise DfmContractError("DFM Ratio Basis has duplicate origin labels: " + ", ".join(duplicates))
    raw_values = snapshot.get("values")
    if isinstance(raw_values, list) and raw_values and any(isinstance(row, list) for row in raw_values):
        raw_values = [row[0] if isinstance(row, list) and row else None for row in raw_values]
    source_values = _numbers(raw_values)
    lookup = {
        label: source_values[index] if index < len(source_values) else None
        for index, label in enumerate(source_origins)
    }
    missing = [label for label in method_origins if label not in lookup]
    if missing:
        raise DfmContractError(
            "DFM Ratio Basis is missing exact origin labels: " + ", ".join(str(label) for label in missing)
        )
    aligned_values = [lookup.get(label) for label in method_origins]
    data_format = _clean(_snapshot_field(snapshot, "data format", "data_format")) or "Vector"
    number_format = _clean(_snapshot_field(snapshot, "number format", "number_format")) or "#,##0"
    decimal_places = _integer(
        _snapshot_field(snapshot, "decimal places", "decimal_places"), 0, minimum=0, maximum=8
    )
    canonical_snapshot = {
        "name": results.get("ratio basis dataset"),
        "origin labels": list(method_origins),
        "values": aligned_values,
        "data format": data_format,
        "number format": number_format,
        "decimal places": decimal_places,
    }
    results.update({
        "ratio basis origin labels": list(method_origins),
        "ratio basis values": aligned_values,
        "ratio basis data format": data_format,
        "ratio basis number format": number_format,
        "ratio basis decimal places": decimal_places,
        "ratio basis source revision": source_snapshot_revision(canonical_snapshot),
    })


def _ratio_development_labels(development_labels: list[str]) -> list[str]:
    if not development_labels:
        return []
    labels: list[str] = []
    for index in range(max(0, len(development_labels) - 1)):
        left = str(development_labels[index])
        right = str(development_labels[index + 1])
        labels.append(f"({index + 1}) {_age_text(left)}-{_age_text(right)}")
    labels.append(f"{_age_text(development_labels[-1])} - Ult")
    return labels


def _age_text(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return match.group(0) if match else text


def _calculate_ratio_triangle(values: list[list[Any]], mask: list[list[bool]], dev_count: int) -> list[list[Any]]:
    out: list[list[Any]] = []
    for row_index, row_values in enumerate(values):
        row: list[Any] = []
        row_mask = mask[row_index] if row_index < len(mask) else []
        for col in range(max(0, dev_count - 1)):
            if col + 1 >= len(row_mask) or not row_mask[col] or not row_mask[col + 1]:
                row.append(None)
                continue
            left = canonical_number(row_values[col] if col < len(row_values) else None)
            right = canonical_number(row_values[col + 1] if col + 1 < len(row_values) else None)
            if left in (None, 0) or right is None:
                row.append(None)
            else:
                row.append(canonical_number(float(right) / float(left)))
        out.append(_trim_trailing_nulls(row))
    return out


def _selected_rows(
    values: list[list[Any]],
    mask: list[list[bool]],
    excluded: list[list[int]],
    col: int,
    periods: Any,
    extra_exclude: int,
) -> list[int]:
    candidates: list[tuple[int, float]] = []
    for row in range(len(values)):
        if row >= len(mask) or col + 1 >= len(mask[row]) or not mask[row][col] or not mask[row][col + 1]:
            continue
        left = canonical_number(values[row][col])
        right = canonical_number(values[row][col + 1])
        if left in (None, 0) or right is None:
            continue
        ratio = float(right) / float(left)
        if not math.isfinite(ratio):
            continue
        if row < len(excluded) and col < len(excluded[row]) and excluded[row][col] == 1:
            continue
        candidates.append((row, ratio))
    lookback = 0 if isinstance(periods, str) and periods.lower() == "all" else _integer(periods, 0, minimum=0)
    if lookback:
        candidates = sorted(candidates, key=lambda item: item[0], reverse=True)[:lookback]
    trim = min(max(0, int(extra_exclude)), len(candidates) // 2)
    if trim:
        sorted_values = sorted(candidates, key=lambda item: item[1])
        removed = {row for pair in (sorted_values[:trim], sorted_values[-trim:]) for row, _ratio in pair}
        candidates = [item for item in candidates if item[0] not in removed]
    return [row for row, _ratio in candidates]


def _calculate_average(
    values: list[list[Any]],
    mask: list[list[bool]],
    excluded: list[list[int]],
    col: int,
    *,
    base: str,
    periods: Any,
    extra_exclude: int,
) -> float:
    rows = _selected_rows(values, mask, excluded, col, periods, extra_exclude)
    if not rows:
        return 1.0
    if base == "volume":
        denominator = sum(float(values[row][col]) for row in rows)
        numerator = sum(float(values[row][col + 1]) for row in rows)
        return numerator / denominator if denominator else 1.0
    ratios = [float(values[row][col + 1]) / float(values[row][col]) for row in rows]
    return sum(ratios) / len(ratios) if ratios else 1.0


def _contains_excel_reference(value: Any) -> bool:
    text = str(value if value is not None else "").strip()
    return bool(text and _EXCEL_REFERENCE_RE.search(text))


def contains_excel_reference(value: Any) -> bool:
    """Public predicate used by background freshness-check consumers."""

    return _contains_excel_reference(value)


def _safe_arithmetic(expression: str) -> float | None:
    try:
        tree = ast.parse(expression, mode="eval")
    except (SyntaxError, ValueError):
        return None
    binary = {
        ast.Add: lambda left, right: left + right,
        ast.Sub: lambda left, right: left - right,
        ast.Mult: lambda left, right: left * right,
        ast.Div: lambda left, right: left / right,
        ast.Pow: lambda left, right: left**right,
        ast.Mod: lambda left, right: left % right,
    }
    unary = {ast.UAdd: lambda value: value, ast.USub: lambda value: -value}

    def evaluate(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return evaluate(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in binary:
            return binary[type(node.op)](evaluate(node.left), evaluate(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in unary:
            return unary[type(node.op)](evaluate(node.operand))
        raise ValueError("unsupported expression")

    try:
        result = evaluate(tree)
    except (ArithmeticError, OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _evaluate_internal_formula(
    formula: str,
    labels: list[str],
    computed: list[list[Any]],
    col: int,
    resolver: Any = None,
) -> float | None:
    text = str(formula or "").strip()
    if not text or _contains_excel_reference(text):
        return None
    if text.startswith("="):
        text = text[1:]
    lookup = {_clean(label).casefold(): index for index, label in enumerate(labels)}

    def replace(match: re.Match[str]) -> str:
        row = lookup.get(_clean(match.group(1)).casefold())
        if row is None or row >= len(computed) or col >= len(computed[row]):
            return "nan"
        value = canonical_number(resolver(row, col) if callable(resolver) else computed[row][col])
        return str(value) if value is not None else "nan"

    text = _INTERNAL_LABEL_RE.sub(replace, text)
    return _safe_arithmetic(text)


def _calculate_formula_values(payload: dict[str, Any]) -> list[list[Any]]:
    data = payload["data tab"]
    ratio = payload["ratios tab"]["ratio triangle"]
    formulas = payload["ratios tab"]["average formulas"]
    labels = formulas["label"]
    settings = formulas["custom average formula settings"]
    values = data["input data triangle values"]
    mask = data["input data triangle mask"]
    excluded = ratio["excluded"]
    old_values = _fit_matrix(_number_matrix(formulas.get("values")), len(labels), len(ratio["development labels"]), None)
    inputs = _fit_matrix(_text_matrix(formulas.get("inputs")), len(labels), len(ratio["development labels"]), "")
    col_count = len(ratio["development labels"])
    computed: list[list[Any]] = [[None] * col_count for _ in labels]
    for row, _label in enumerate(labels):
        average_type = settings["averageType"][row]
        if average_type == "user_entry":
            continue
        if settings["base"][row] == "benchmark":
            computed[row] = [
                canonical_number(value) if canonical_number(value) is not None else 1.0
                for value in old_values[row]
            ]
            continue
        for col in range(col_count):
            computed[row][col] = 1.0 if col >= len(data["development labels"]) - 1 else canonical_number(
                _calculate_average(
                    values,
                    mask,
                    excluded,
                    col,
                    base=settings["base"][row],
                    periods=settings["periods"][row],
                    extra_exclude=settings["exclude"][row],
                )
            )
    resolving: set[tuple[int, int]] = set()

    def resolve(row: int, col: int) -> Any:
        existing = canonical_number(computed[row][col])
        if existing is not None:
            return existing
        stored = canonical_number(old_values[row][col])
        key = (row, col)
        if key in resolving:
            return stored if stored is not None and stored > 0 else 1.0
        if col >= len(data["development labels"]) - 1:
            computed[row][col] = 1.0
            return 1.0
        resolving.add(key)
        try:
            formula = inputs[row][col]
            if _contains_excel_reference(formula):
                chosen = stored
            elif formula:
                chosen = _evaluate_internal_formula(
                    formula,
                    labels,
                    computed,
                    col,
                    resolver=resolve,
                )
                if chosen is None:
                    chosen = stored
            else:
                chosen = stored
            computed[row][col] = canonical_number(chosen) if chosen is not None and chosen > 0 else 1.0
            return computed[row][col]
        finally:
            resolving.remove(key)

    for row, _label in enumerate(labels):
        if settings["averageType"][row] != "user_entry":
            continue
        for col in range(col_count):
            resolve(row, col)
    return computed


def _calculate_ultimate(payload: dict[str, Any]) -> list[Any]:
    data = payload["data tab"]
    formulas = payload["ratios tab"]["average formulas"]
    values = formulas["values"]
    selected = formulas["selected"]
    col_count = len(payload["ratios tab"]["ratio triangle"]["development labels"])
    selected_values: list[float] = []
    for col in range(col_count):
        chosen = 0
        for row, selected_row in enumerate(selected):
            if col < len(selected_row) and selected_row[col] == 1:
                chosen = row
                break
        value = canonical_number(values[chosen][col] if chosen < len(values) and col < len(values[chosen]) else None)
        selected_values.append(float(value) if value is not None else 1.0)
    cumulative: list[float | None] = [None] * col_count
    running: float | None = None
    for col in range(col_count - 1, -1, -1):
        value = selected_values[col]
        running = value if col == col_count - 1 else (value * running if running is not None else None)
        cumulative[col] = running
    out: list[Any] = []
    for row, row_values in enumerate(data["input data triangle values"]):
        row_mask = data["input data triangle mask"][row]
        latest_col = next(
            (
                col
                for col in range(min(len(row_values), len(row_mask), len(data["development labels"])) - 1, -1, -1)
                if row_mask[col] and canonical_number(row_values[col]) is not None
            ),
            None,
        )
        if latest_col is None or latest_col >= len(cumulative) or cumulative[latest_col] is None:
            out.append(None)
            continue
        out.append(canonical_number(float(row_values[latest_col]) * float(cumulative[latest_col])))
    return out


def recalculate_dfm_method(
    payload: Mapping[str, Any],
    *,
    input_snapshot: Mapping[str, Any] | None = None,
    ratio_basis_snapshot: Mapping[str, Any] | None = None,
    changed_precedents: Iterable[str] = (),
    timestamp: Any = None,
    update_refresh_timestamp: bool | None = None,
) -> dict[str, Any]:
    """Refresh DFM-derived state while preserving the DFM-owned projection."""

    changed = tuple(str(item) for item in changed_precedents)
    if update_refresh_timestamp is None:
        update_refresh_timestamp = input_snapshot is not None or ratio_basis_snapshot is not None or bool(changed)
    refreshed_at = _timestamp(timestamp)
    method = normalize_dfm_method(payload, require_complete=False, timestamp=refreshed_at)
    if input_snapshot is not None:
        _apply_input_snapshot(method, input_snapshot)
    if ratio_basis_snapshot is not None:
        _apply_ratio_basis_snapshot(method, ratio_basis_snapshot)
    ratio = method["ratios tab"]["ratio triangle"]
    data = method["data tab"]
    ratio["origin labels"] = list(data["origin labels"])
    ratio["development labels"] = _ratio_development_labels(data["development labels"])
    ratio["ratio values"] = _calculate_ratio_triangle(
        data["input data triangle values"], data["input data triangle mask"], len(data["development labels"])
    )
    prior_excluded = _int_matrix(ratio.get("excluded"))
    ratio["excluded"] = [
        (prior_excluded[row] if row < len(prior_excluded) else [])[: len(ratio_values)]
        + [0] * max(0, len(ratio_values) - len(prior_excluded[row] if row < len(prior_excluded) else []))
        for row, ratio_values in enumerate(ratio["ratio values"])
    ]
    formula_count = len(method["ratios tab"]["average formulas"]["label"])
    ratio_col_count = len(ratio["development labels"])
    formulas = method["ratios tab"]["average formulas"]
    formulas["selected"] = _fit_matrix(_int_matrix(formulas.get("selected")), formula_count, ratio_col_count, 0)
    formulas["inputs"] = _fit_matrix(_text_matrix(formulas.get("inputs")), formula_count, ratio_col_count, "")
    formulas["values"] = _calculate_formula_values(method)
    method["results tab"]["ultimate vector"] = _calculate_ultimate(method)
    if update_refresh_timestamp:
        method["method metadata"]["data refreshed"] = refreshed_at
    _set_revisions(method)
    _validate_complete(method)
    return method


def preview_dfm_method(
    payload: Mapping[str, Any],
    *,
    input_snapshot: Mapping[str, Any] | None = None,
    ratio_basis_snapshot: Mapping[str, Any] | None = None,
    timestamp: Any = None,
) -> dict[str, Any]:
    """Calculate a complete in-memory preview; no I/O or external refresh occurs."""

    return recalculate_dfm_method(
        payload,
        input_snapshot=input_snapshot,
        ratio_basis_snapshot=ratio_basis_snapshot,
        timestamp=timestamp,
        update_refresh_timestamp=False,
    )


_OWNED_PATHS = (
    ("details tab", "name"),
    ("details tab", "output type"),
    ("details tab", "output dataset"),
    ("details tab", "output category"),
    ("details tab", "input triangle"),
    ("details tab", "origin length"),
    ("details tab", "development length"),
    ("details tab", "decimal places"),
    ("ratios tab", "average formulas", "label"),
    ("ratios tab", "average formulas", "custom average formula settings"),
    ("ratios tab", "average formulas", "selected"),
    ("ratios tab", "average formulas", "inputs"),
    ("ratios tab", "average formulas", "values"),
    ("ratios tab", "cell notes"),
    ("results tab", "ratio basis dataset"),
    ("results tab", "ultimate ratio decimal places"),
)


def _apply_owned_exclusion_patch(base: dict[str, Any], patch: Mapping[str, Any]) -> None:
    patch_ratio = _tab(_tab(patch, "ratios tab"), "ratio triangle")
    if "excluded" not in patch_ratio:
        return
    patch_excluded = _int_matrix(patch_ratio.get("excluded"))
    patch_origins = _labels(patch_ratio.get("origin labels"))
    patch_devs = _labels(patch_ratio.get("development labels"))
    if not patch_origins or not patch_devs:
        raise DfmContractError(
            "A DFM exclusion patch must include its exact ratio origin and development labels."
        )
    if _duplicate_labels(patch_origins) or _duplicate_labels(patch_devs):
        raise DfmContractError("A DFM exclusion patch cannot contain duplicate labels.")
    base_ratio = base["ratios tab"]["ratio triangle"]
    base_origins = _labels(base_ratio.get("origin labels"))
    base_devs = _labels(base_ratio.get("development labels"))
    base_excluded = _int_matrix(base_ratio.get("excluded"))
    origin_lookup = {label: index for index, label in enumerate(base_origins)}
    dev_lookup = {label: index for index, label in enumerate(base_devs)}
    for patch_row, origin in enumerate(patch_origins):
        base_row = origin_lookup.get(origin)
        if base_row is None or patch_row >= len(patch_excluded):
            continue
        while len(base_excluded) <= base_row:
            base_excluded.append([])
        for patch_col, value in enumerate(patch_excluded[patch_row]):
            if patch_col >= len(patch_devs):
                break
            base_col = dev_lookup.get(patch_devs[patch_col])
            if base_col is None:
                continue
            while len(base_excluded[base_row]) <= base_col:
                base_excluded[base_row].append(0)
            base_excluded[base_row][base_col] = value
    base_ratio["excluded"] = base_excluded


def _path_value(payload: Mapping[str, Any], path: tuple[str, ...]) -> tuple[bool, Any]:
    current: Any = payload
    for key in path:
        if not isinstance(current, Mapping) or key not in current:
            return False, None
        current = current[key]
    return True, current


def _set_path(payload: dict[str, Any], path: tuple[str, ...], value: Any) -> None:
    current = payload
    for key in path[:-1]:
        child = current.get(key)
        if not isinstance(child, dict):
            child = {}
            current[key] = child
        current = child
    current[path[-1]] = deepcopy(value)


def apply_owned_patch(
    base: Mapping[str, Any],
    patch: Mapping[str, Any],
    *,
    timestamp: Any = None,
) -> dict[str, Any]:
    """Rebase an owned-state patch onto the newest embedded derived snapshot."""

    method = normalize_dfm_method(base, require_complete=False, timestamp=timestamp)
    _apply_owned_exclusion_patch(method, patch)
    for path in _OWNED_PATHS:
        exists, value = _path_value(patch, path)
        if exists:
            _set_path(method, path, value)
    modified_at = _timestamp(timestamp)
    method["method metadata"]["last modified"] = modified_at
    return recalculate_dfm_method(
        method,
        timestamp=modified_at,
        update_refresh_timestamp=False,
    )


build_dfm_method_v2 = normalize_dfm_method


__all__ = [
    "DFM_JSON_FORMAT",
    "DFM_VALUE_DECIMAL_PLACES",
    "LEGACY_DFM_JSON_FORMAT",
    "DfmContractError",
    "aggregate_vector_values",
    "apply_owned_patch",
    "build_dfm_method_v2",
    "build_dfm_output_sidecar",
    "canonical_number",
    "contains_excel_reference",
    "dependency_entries",
    "derived_projection",
    "dfm_precedent_names",
    "dfm_output_variants",
    "method_revisions",
    "normalize_dfm_method",
    "owned_projection",
    "persisted_projection",
    "preview_dfm_method",
    "publication_projection",
    "recalculate_dfm_method",
    "source_snapshot_revision",
]
