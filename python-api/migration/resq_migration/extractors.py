from __future__ import annotations

import csv
import getpass
import io
import math
import os
import re
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from arcrho_api.bornhuetter_ferguson_contract import (
    BF_JSON_FORMAT,
    BF_METHOD_TYPE,
    BF_SOURCE_KIND,
    bornhuetter_ferguson_precedent_names,
    build_bornhuetter_ferguson_output_sidecar,
    recalculate_bornhuetter_ferguson_method,
)
from arcrho_api.dfm_contract import build_dfm_output_sidecar, dfm_output_variants
from arcrho_api.engine_dataset_sidecar_contract import build_engine_dataset_sidecar

from .catalog import _apply_sidecar_graph_meta, _is_generated_dataset_type
from .core import (
    BS_CRA_FILE_PREFIX,
    BS_CRA_JSON_FORMAT,
    BS_CRA_METHOD_TYPE,
    BS_CRA_SOURCE_KIND,
    BS_SR_FILE_PREFIX,
    BS_SR_JSON_FORMAT,
    BS_SR_METHOD_TYPE,
    BS_SR_SOURCE_KIND,
    DATASET_CACHE_DIR,
    DATASET_SIDECAR_DIR,
    DEFAULT_CALENDAR,
    DEFAULT_CUMULATIVE,
    METHOD_TYPE_BF_CODE,
    METHOD_TYPE_BS_CRA_CODE,
    METHOD_TYPE_BS_SR_CODE,
    METHOD_TYPE_NONE_CODE,
    METHOD_TYPE_DFM_CODE,
    METHOD_TYPE_RESULT_SELECTION_CODE,
    _bool_value,
    _call_member,
    _clean_name,
    _dataset_cache_csv_file_name,
    _encode_name_part,
    _format_json,
    _is_result_selection_method_type,
    _iso_or_text,
    _json_sidecar_name,
    _method_type_code,
    _method_type_name,
    _normalize_import_name,
    normalize_method_status,
    _safe_attr,
    _safe_int_attr,
    _safe_read_json,
    _triangle_source_kind,
    _try_call_member,
    _vector_cache_csv_file_name,
    _write_csv_matrix,
    _write_json,
)
from .number_formats import dataset_type_decimal_places, dataset_type_number_format


PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v2"
METHOD_DATA_DIR = "methods"
RS_JSON_VALUE_DECIMAL_PLACES = 6

BS_SR_ADJUSTMENT_TYPES = {
    0: "unadjusted",
    1: "pairs",
    2: "all",
    3: "loess",
}
BS_CRA_INFLATION_TYPES = {
    0: "case_column",
    1: "case_all",
    2: "paid_column",
    3: "paid_all",
    4: "user",
}
BS_CRA_AVERAGE_CASE_RESERVE_TYPES = {
    0: "latest",
    1: "monotone",
    2: "loess",
    3: "user",
}

_DEFER_GRAPH_ENRICHMENT_DEPTH: ContextVar[int] = ContextVar(
    "resq_migration_defer_graph_enrichment_depth",
    default=0,
)


@contextmanager
def defer_sidecar_graph_enrichment():
    """Defer per-write graph work until the caller performs a bulk graph refresh."""
    token = _DEFER_GRAPH_ENRICHMENT_DEPTH.set(_DEFER_GRAPH_ENRICHMENT_DEPTH.get() + 1)
    try:
        yield
    finally:
        _DEFER_GRAPH_ENRICHMENT_DEPTH.reset(token)


def _apply_graph_meta_best_effort(meta: dict, dataset_type: str, rc_dir: Path, **kwargs) -> None:
    if _DEFER_GRAPH_ENRICHMENT_DEPTH.get() > 0:
        return
    try:
        _apply_sidecar_graph_meta(meta, dataset_type, rc_dir, **kwargs)
    except Exception as exc:
        meta.setdefault("Precedents", [])
        meta.setdefault("Dependents", [])
        meta["graph_metadata_error"] = str(exc)


def configure_extractors(*, project_name: str, rs_json_format: str, method_data_dir: str, bf_json_format: str | None = None) -> None:
    global PROJECT_NAME, RS_JSON_FORMAT, METHOD_DATA_DIR

    PROJECT_NAME = str(project_name)
    RS_JSON_FORMAT = str(rs_json_format)
    if bf_json_format and str(bf_json_format) != BF_JSON_FORMAT:
        raise ValueError(
            f"The ResQ producer only supports canonical BF format {BF_JSON_FORMAT!r}."
        )
    METHOD_DATA_DIR = str(method_data_dir)


def _origin_date_from_label(label: str) -> datetime | None:
    text = _normalize_import_name(label)
    try:
        year = int(text)
    except ValueError:
        match = re.search(r"\d{4}", text)
        if not match:
            return None
        year = int(match.group(0))
    return datetime(year, 12, 31)

def _triangle_development_count(triangle, origin_index: int) -> int:
    origin_date = _origin_date_from_label(_triangle_origin_label(triangle, origin_index))
    call_shapes = [
        ((), {"OriginDate": origin_date}) if origin_date is not None else None,
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"arg0": origin_index}),
        ((), {}),
    ]
    call_shapes = [shape for shape in call_shapes if shape is not None]
    for name in ("DevelopmentCount", "DevCount"):
        try:
            return int(_try_call_member(triangle, name, call_shapes))
        except Exception:
            continue
    return _safe_int_attr(triangle, "DevelopmentCount", 0)

def _triangle_origin_label(triangle, origin_index: int) -> str:
    for name in ("OriginLabel", "OriginLabels"):
        try:
            return _normalize_import_name(_try_call_member(triangle, name, [((origin_index,), {}), ((), {"OriginIndex": origin_index})]))
        except Exception:
            continue
    return str(origin_index)

def _triangle_development_label(triangle, dev_index: int) -> str:
    for name in ("DevelopmentLabel", "DevelopmentLabels", "DevLabel"):
        try:
            return _normalize_import_name(_try_call_member(triangle, name, [((dev_index,), {}), ((), {"DevIndex": dev_index})]))
        except Exception:
            continue
    return str(dev_index)

def _triangle_value(triangle, origin_index: int, dev_index: int):
    call_shapes = [
        ((origin_index, dev_index), {}),
        ((), {"OriginIndex": origin_index, "DevIndex": dev_index}),
        ((), {"OriginIndex": origin_index, "DevelopmentIndex": dev_index}),
    ]
    for name in ("ValuesByIndex", "Values", "Value", "Data", "TriangleValues"):
        try:
            return _try_call_member(triangle, name, call_shapes)
        except Exception:
            continue
    raise AttributeError(
        "Could not read triangle values. Tried ValuesByIndex, Values, Value, Data, and TriangleValues "
        f"for cell ({origin_index}, {dev_index})."
    )

def _vector_origin_count(vector) -> int:
    for name in ("OriginCount", "Count", "Length"):
        value = _safe_int_attr(vector, name, 0)
        if value > 0:
            return value
        try:
            value = int(_call_member(vector, name))
            if value > 0:
                return value
        except Exception:
            continue
    return 0

def _vector_origin_label(vector, origin_index: int) -> str:
    for name in ("OriginLabel", "OriginLabels", "Label", "Labels"):
        try:
            return _normalize_import_name(_try_call_member(vector, name, [((origin_index,), {}), ((), {"OriginIndex": origin_index})]))
        except Exception:
            continue
    return str(origin_index)

def _vector_value(vector, origin_index: int):
    origin_date = _origin_date_from_label(_vector_origin_label(vector, origin_index))
    call_shapes = [
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"Index": origin_index}),
        ((), {"arg0": origin_index}),
        ((), {"OriginDate": origin_date}) if origin_date is not None else None,
    ]
    call_shapes = [shape for shape in call_shapes if shape is not None]
    for name in ("ValuesByIndex", "Values", "Value", "Data", "VectorValues"):
        try:
            return _try_call_member(vector, name, call_shapes)
        except Exception:
            continue
    raise AttributeError(
        "Could not read vector values. Tried ValuesByIndex, Values, Value, Data, and VectorValues "
        f"for origin index {origin_index}."
    )

def export_triangle(triangle, *, method_type_code: int | None = None) -> dict:
    """Extract a ResQ Triangle COM object into ArcRho CSV values and metadata."""
    name = _normalize_import_name(triangle.Name)
    dataset_type_obj = _safe_attr(triangle, "DatasetType", None)
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", ""))
    category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 0)
    if method_type_code is None:
        method_type_code = _safe_int_attr(triangle, "MethodType", METHOD_TYPE_NONE_CODE)
    method_type = _method_type_name(method_type_code)
    origin_length = _safe_int_attr(triangle, "OriginLength", 12)
    dev_length = _safe_int_attr(triangle, "DevelopmentLength", 12)
    origin_count = _safe_int_attr(triangle, "OriginCount", 0)
    if origin_count <= 0:
        try:
            origin_count = int(_call_member(triangle, "OriginCount"))
        except Exception:
            origin_count = 0
    if origin_count <= 0:
        raise ValueError(f"Triangle {name!r} does not expose a positive OriginCount.")

    max_dev_count = _triangle_development_count(triangle, 1)
    if max_dev_count <= 0:
        max_dev_count = _safe_int_attr(triangle, "DevelopmentCount", 0)
    if max_dev_count <= 0:
        raise ValueError(f"Triangle {name!r} does not expose a positive DevelopmentCount.")
    row_dev_counts = [_triangle_development_count(triangle, i) for i in range(1, origin_count + 1)]
    max_dev_count = max(row_dev_counts) if row_dev_counts else max_dev_count

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i, row_dev_count in enumerate(row_dev_counts, start=1):
        row: list = []
        for j in range(1, max_dev_count + 1):
            if row_dev_count and j > row_dev_count:
                row.append(None)
                continue
            attempted_cells += 1
            try:
                row.append(_triangle_value(triangle, i, j))
            except Exception as exc:
                value_errors.append(exc)
                row.append(None)
        values.append(row)
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any values for triangle {name!r}: {value_errors[0]}")

    user = _normalize_import_name(_safe_attr(triangle, "User", ""))
    created = _iso_or_text(_safe_attr(triangle, "Created", ""))
    modified = _iso_or_text(_safe_attr(triangle, "Modified", ""))
    origin_labels = [_triangle_origin_label(triangle, i) for i in range(1, origin_count + 1)]
    dev_labels = [_triangle_development_label(triangle, j) for j in range(1, max_dev_count + 1)]

    return {
        "name": name,
        "dataset_type": dataset_type,
        "category": category,
        "data_format": data_format,
        "method_type": method_type,
        "method_type_code": method_type_code,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": max_dev_count,
        "origin_labels": origin_labels,
        "development_labels": dev_labels,
        "values": values,
        "user": user,
        "created": created,
        "modified": modified,
        "status": normalize_method_status(_safe_attr(triangle, "Status", 0)),
    }

def write_triangle_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    name = _normalize_import_name(payload["name"])
    dataset_type = _normalize_import_name(payload.get("dataset_type")) or name
    origin_length = int(payload["origin_length"])
    dev_length = int(payload["development_length"])
    csv_name = _dataset_cache_csv_file_name(
        name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
    _write_csv_matrix(csv_path, payload["values"])

    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    method_source_kind = _clean_name(payload.get("source_kind"))
    is_berquist_sherman = method_source_kind in {BS_SR_SOURCE_KIND, BS_CRA_SOURCE_KIND}
    source_kind = method_source_kind if is_berquist_sherman else _triangle_source_kind(name, dataset_type)
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "dataset_category": _normalize_import_name(payload.get("category")),
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "calculated": is_berquist_sherman,
        "source": (
            "resq_berquist_sherman_sr_triangle"
            if method_source_kind == BS_SR_SOURCE_KIND
            else "resq_berquist_sherman_cra_triangle"
            if method_source_kind == BS_CRA_SOURCE_KIND
            else "resq_triangle"
        ),
        "data_format": "Triangle",
        "data_format_code": payload.get("data_format", 0),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 0),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "number_format": dataset_type_number_format(rc_path, dataset_type),
        "decimal_places": dataset_type_decimal_places(rc_path, dataset_type),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "notes": str(payload.get("notes") or ""),
        "updated_at": updated_at,
    }
    if is_berquist_sherman:
        meta["method_name"] = _normalize_import_name(payload.get("method_name")) or name
        meta["method_type"] = _method_type_name(payload.get("method_type"))
        meta["method_type_code"] = payload.get(
            "method_type_code",
            _method_type_code(payload.get("method_type"), METHOD_TYPE_NONE_CODE),
        )
        meta["Precedents"] = [
            _normalize_import_name(item)
            for item in payload.get("precedents", [])
            if _normalize_import_name(item)
        ]
        meta["Dependents"] = []
        meta["status"] = normalize_method_status(payload.get("status"))
        _apply_graph_meta_best_effort(meta, dataset_type, rc_dir, preserve_precedents=True)
    else:
        _apply_graph_meta_best_effort(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path


def _bs_indexed_value(method, member_name: str, *indices: int):
    keyword_names = (
        ("DevIndex",)
        if len(indices) == 1
        else ("OriginIndex", "DevIndex")
    )
    keyword_args = {
        name: value
        for name, value in zip(keyword_names, indices)
    }
    return _try_call_member(
        method,
        member_name,
        [
            (tuple(indices), {}),
            ((), keyword_args),
        ],
    )


def _bs_source_name(method, attr_name: str) -> str:
    source = _safe_attr(method, attr_name, None)
    return _normalize_import_name(_safe_attr(source, "Name", ""))


def _bs_selection_label(value: object, labels: dict[int, str], field_name: str) -> str:
    try:
        code = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid ResQ {field_name} value: {value!r}.") from exc
    if code not in labels:
        raise ValueError(f"Unsupported ResQ {field_name} code: {code}.")
    return labels[code]


def _bs_precedents(method_tab: dict, variant: str) -> list[str]:
    keys = (
        ("paid_claims", "closed_claim_numbers", "ultimate_claim_numbers")
        if variant == "sr"
        else ("reported_claim_numbers", "closed_claim_numbers", "incurred_claims", "paid_claims")
    )
    names: list[str] = []
    seen: set[str] = set()
    for key in keys:
        name = _normalize_import_name(method_tab.get(key))
        name_key = name.casefold()
        if name and name_key not in seen:
            seen.add(name_key)
            names.append(name)
    return names


def _bs_variant_from_payload(payload: dict) -> str:
    json_format = _clean_name(payload.get("json_format")).casefold()
    if json_format == BS_SR_JSON_FORMAT:
        return "sr"
    if json_format == BS_CRA_JSON_FORMAT:
        return "cra"
    raise ValueError(f"Unsupported Berquist Sherman JSON format: {json_format!r}.")


def export_berquist_sherman(method, variant: str, output_payload: dict) -> dict:
    """Extract the annual B&S configuration needed to reproduce a ResQ output."""
    clean_variant = _clean_name(variant).casefold()
    if clean_variant not in {"sr", "cra"}:
        raise ValueError(f"Unsupported Berquist Sherman variant: {variant!r}.")

    origin_length = int(output_payload.get("origin_length") or _safe_int_attr(method, "OriginLength", 0))
    development_length = int(
        output_payload.get("development_length")
        or _safe_int_attr(method, "DevelopmentLength", 0)
    )
    if origin_length != 12 or development_length != 12:
        raise ValueError(
            "ArcRho's Berquist Sherman MVP supports annual triangles only "
            f"(got origin_length={origin_length}, development_length={development_length})."
        )

    name = _normalize_import_name(output_payload.get("name")) or _normalize_import_name(
        _safe_attr(method, "Name", "")
    )
    if not name:
        raise ValueError("The ResQ Berquist Sherman method does not expose an output name.")
    output_type = _normalize_import_name(output_payload.get("dataset_type")) or name
    origin_labels = [
        _normalize_import_name(label)
        for label in output_payload.get("origin_labels", [])
    ]
    development_labels = [
        _normalize_import_name(label)
        for label in output_payload.get("development_labels", [])
    ]
    origin_count = len(origin_labels)
    development_count = len(development_labels)
    if origin_count <= 0 or development_count <= 0:
        raise ValueError(f"Berquist Sherman method {name!r} does not expose annual triangle labels.")

    if clean_variant == "sr":
        method_type = BS_SR_METHOD_TYPE
        source_kind = BS_SR_SOURCE_KIND
        method_tab = {
            "paid_claims": _bs_source_name(method, "PaidClaims"),
            "closed_claim_numbers": _bs_source_name(method, "ClosedClaimNos"),
            "ultimate_claim_numbers": _bs_source_name(method, "UltimateClaimNos"),
            "origin_labels": origin_labels,
            "development_labels": development_labels,
            "selected_proportion_settled": [
                float(_bs_indexed_value(method, "SelectedProportionSettled", dev_index))
                for dev_index in range(1, development_count + 1)
            ],
            "selected_proportion_is_default": [
                _bool_value(_bs_indexed_value(method, "IsDefaultProportionSettled", dev_index))
                for dev_index in range(1, development_count + 1)
            ],
            "selected_adjustment": [],
        }
        selected_adjustment: list[list[str | None]] = []
        for origin_index in range(1, origin_count + 1):
            row_count = min(development_count, origin_count - origin_index + 1)
            row: list[str | None] = []
            for dev_index in range(1, development_count + 1):
                if dev_index > row_count:
                    row.append(None)
                    continue
                raw = _bs_indexed_value(method, "SelectedAdjustment", origin_index, dev_index)
                row.append(_bs_selection_label(raw, BS_SR_ADJUSTMENT_TYPES, "SelectedAdjustment"))
            selected_adjustment.append(row)
        method_tab["selected_adjustment"] = selected_adjustment
        json_format = BS_SR_JSON_FORMAT
    else:
        method_type = BS_CRA_METHOD_TYPE
        source_kind = BS_CRA_SOURCE_KIND
        method_tab = {
            "reported_claim_numbers": _bs_source_name(method, "ReportedClaimNos"),
            "closed_claim_numbers": _bs_source_name(method, "ClosedClaimNos"),
            "incurred_claims": _bs_source_name(method, "IncurredClaims"),
            "paid_claims": _bs_source_name(method, "PaidClaims"),
            "origin_labels": origin_labels,
            "development_labels": development_labels,
            "inflation_selection": [
                _bs_selection_label(
                    _bs_indexed_value(method, "SelectedAvgInflation", dev_index),
                    BS_CRA_INFLATION_TYPES,
                    "SelectedAvgInflation",
                )
                for dev_index in range(1, development_count + 1)
            ],
            "user_inflation": [
                float(_bs_indexed_value(method, "UserAvgInflation", dev_index))
                for dev_index in range(1, development_count + 1)
            ],
            "average_case_reserve_selection": [
                _bs_selection_label(
                    _bs_indexed_value(method, "SelectedAvgCaseReserves", dev_index),
                    BS_CRA_AVERAGE_CASE_RESERVE_TYPES,
                    "SelectedAvgCaseReserves",
                )
                for dev_index in range(1, development_count + 1)
            ],
            "user_average_case_reserves": [
                float(_bs_indexed_value(method, "UserAvgCaseReserves", dev_index))
                for dev_index in range(1, development_count + 1)
            ],
        }
        json_format = BS_CRA_JSON_FORMAT

    notes = _clean_name(_safe_attr(method, "Notes", ""))
    modified = output_payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    return {
        "json_format": json_format,
        "details_tab": {
            "name": name,
            "method_type": method_type,
            "output_type": output_type,
            "origin_length": origin_length,
            "development_length": development_length,
        },
        "method_tab": method_tab,
        "_sidecar_notes": notes,
        "_sidecar_status": normalize_method_status(
            _safe_attr(_safe_attr(method, "OutputTriangle", None), "Status", 0)
        ),
        "audit_log_tab": {},
        "method_metadata": {
            "method_type": method_type,
            "source_kind": source_kind,
            "last_modified": modified,
        },
    }


def _apply_berquist_sherman_triangle_metadata(payload: dict, method_payload: dict) -> None:
    payload["notes"] = str(method_payload.pop("_sidecar_notes", "") or "")
    payload["status"] = normalize_method_status(
        method_payload.pop("_sidecar_status", payload.get("status"))
    )
    variant = _bs_variant_from_payload(method_payload)
    if variant == "sr":
        payload["source_kind"] = BS_SR_SOURCE_KIND
        payload["method_type"] = BS_SR_METHOD_TYPE
        payload["method_type_code"] = METHOD_TYPE_BS_SR_CODE
    elif variant == "cra":
        payload["source_kind"] = BS_CRA_SOURCE_KIND
        payload["method_type"] = BS_CRA_METHOD_TYPE
        payload["method_type_code"] = METHOD_TYPE_BS_CRA_CODE
    else:
        raise ValueError(f"Unsupported Berquist Sherman variant: {variant!r}.")
    details_tab = method_payload.get("details_tab") if isinstance(method_payload.get("details_tab"), dict) else {}
    method_tab = method_payload.get("method_tab") if isinstance(method_payload.get("method_tab"), dict) else {}
    payload["method_name"] = _normalize_import_name(details_tab.get("name")) or _normalize_import_name(
        payload.get("name")
    )
    payload["precedents"] = _bs_precedents(method_tab, variant)


def _backfill_berquist_sherman_precedent_origin_labels(
    payload: dict,
    variant: str,
    rc_dir: Path,
) -> None:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    origin_labels = method_tab.get("origin_labels")
    if not isinstance(origin_labels, list) or not origin_labels:
        return

    canonical_labels = [str(label) for label in origin_labels]
    for precedent in _bs_precedents(method_tab, variant):
        sidecar_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(precedent)
        if not sidecar_path.is_file():
            continue
        sidecar = _safe_read_json(sidecar_path)
        if not sidecar:
            continue
        existing_labels = sidecar.get("origin_labels")
        if existing_labels not in (None, []):
            continue
        sidecar["origin_labels"] = canonical_labels
        _write_json(sidecar_path, sidecar)


def write_berquist_sherman_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    del rc_path
    variant = _bs_variant_from_payload(payload)
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    name = _normalize_import_name(details_tab.get("name"))
    if variant == "sr":
        prefix = BS_SR_FILE_PREFIX
    elif variant == "cra":
        prefix = BS_CRA_FILE_PREFIX
    else:
        raise ValueError(f"Unsupported Berquist Sherman variant: {variant!r}.")
    if not name:
        raise ValueError("Berquist Sherman method JSON is missing details_tab.name.")
    out_path = rc_dir / METHOD_DATA_DIR / f"{prefix}{_encode_name_part(name)}.json"
    method_payload = dict(payload)
    method_payload.pop("_sidecar_notes", None)
    method_payload.pop("_sidecar_status", None)
    _write_json(out_path, method_payload)
    _backfill_berquist_sherman_precedent_origin_labels(method_payload, variant, rc_dir)
    return out_path


def _find_berquist_sherman_for_triangle(
    reserving_class,
    triangle_name: str,
    method_type_code: int,
) -> tuple[str, object] | None:
    if method_type_code == METHOD_TYPE_BS_SR_CODE:
        variants = (("sr", "GetBerquistShermanSR", "BerquistShermanSRs"),)
    elif method_type_code == METHOD_TYPE_BS_CRA_CODE:
        variants = (("cra", "GetBerquistShermanCRA", "BerquistShermanCRAs"),)
    else:
        return None

    target = _normalize_import_name(triangle_name).casefold()
    for variant, getter_name, collection_name in variants:
        try:
            method = _call_member(reserving_class, getter_name, triangle_name)
            if method is not None:
                return variant, method
        except Exception:
            pass
        try:
            collection = _call_member(reserving_class, collection_name)
        except Exception:
            continue
        try:
            method = collection.Item(triangle_name)
            if method is not None:
                return variant, method
        except Exception:
            pass
        try:
            for method in collection:
                output = _safe_attr(method, "OutputTriangle", None)
                output_name = _normalize_import_name(_safe_attr(output, "Name", "")).casefold()
                method_name = _normalize_import_name(_safe_attr(method, "Name", "")).casefold()
                if target and target in {output_name, method_name}:
                    return variant, method
        except Exception:
            continue
    return None


def export_vector(vector) -> dict:
    """Extract a ResQ Vector COM object into ArcRho CSV values and metadata."""
    name = _normalize_import_name(vector.Name)
    dataset_type_obj = _safe_attr(vector, "DatasetType", None)
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 1)
    method_type_code = _safe_int_attr(vector, "MethodType", -1)
    method_type = _method_type_name(method_type_code)
    # ResQ vectors expose their period granularity (in months) as PeriodLength. They do
    # not have the triangle/method-style OriginLength member, so reading "OriginLength"
    # here always missed and fell back to the default 12. Use PeriodLength, falling back
    # to OriginLength then 12 only if PeriodLength is unavailable. A vector is 1-D, so the
    # same period length applies to both the origin and (nominal) development axis.
    period_length = _safe_int_attr(vector, "PeriodLength", 0)
    if period_length <= 0:
        period_length = _safe_int_attr(vector, "OriginLength", 12)
    origin_length = period_length
    dev_length = period_length
    origin_count = _vector_origin_count(vector)
    if origin_count <= 0:
        raise ValueError(f"Vector {name!r} does not expose a positive OriginCount/Count.")

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i in range(1, origin_count + 1):
        attempted_cells += 1
        try:
            values.append([_vector_value(vector, i)])
        except Exception as exc:
            value_errors.append(exc)
            values.append([None])
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any values for vector {name!r}: {value_errors[0]}")

    user = _normalize_import_name(_safe_attr(vector, "User", ""))
    created = _iso_or_text(_safe_attr(vector, "Created", ""))
    modified = _iso_or_text(_safe_attr(vector, "Modified", ""))
    formula = _clean_name(_safe_attr(vector, "Formula", ""))
    origin_labels = [_vector_origin_label(vector, i) for i in range(1, origin_count + 1)]

    return {
        "name": name,
        "dataset_type": dataset_type,
        "category": category,
        "data_format": data_format,
        "method_type": method_type,
        "method_type_code": method_type_code,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": 1,
        "origin_labels": origin_labels,
        "development_labels": ["Value"],
        "values": values,
        "formula": formula,
        "user": user,
        "created": created,
        "modified": modified,
        "status": normalize_method_status(_safe_attr(vector, "Status", 0)),
    }

def _vector_payload_period_length(payload: dict) -> int:
    return int(payload.get("period_length") or payload.get("origin_length") or 0)


def write_vector_export(
    payload: dict,
    rc_path: str,
    rc_dir: Path,
    *,
    bf_method_payload: dict | None = None,
) -> Path:
    name = _normalize_import_name(payload["name"])
    dataset_type = _normalize_import_name(payload.get("dataset_type")) or name
    period_length = _vector_payload_period_length(payload)
    csv_name = _vector_cache_csv_file_name(name, period_length)
    csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
    _write_csv_matrix(csv_path, payload["values"])
    _write_aggregated_vector_cache_exports(payload, rc_dir)

    raw_formula = _clean_name(payload.get("formula"))
    method_type = _method_type_name(payload.get("method_type"))
    is_result_selection = _is_result_selection_method_type(method_type)
    raw_method_type_code = _method_type_code(method_type, -1)
    is_bornhuetter_ferguson = _clean_name(payload.get("source_kind")) == BF_SOURCE_KIND
    meta_method_type = BF_METHOD_TYPE if is_bornhuetter_ferguson else ("None" if raw_method_type_code == METHOD_TYPE_BF_CODE else method_type)
    meta_method_type_code = METHOD_TYPE_BF_CODE if is_bornhuetter_ferguson else (METHOD_TYPE_NONE_CODE if raw_method_type_code == METHOD_TYPE_BF_CODE else payload.get("method_type_code", _method_type_code(method_type, 0)))
    is_engine_generated = (not is_result_selection) and (not is_bornhuetter_ferguson) and _is_generated_dataset_type(dataset_type)
    formula = "" if is_engine_generated or is_bornhuetter_ferguson else raw_formula
    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    if is_result_selection:
        source_kind = "result_selection"
    elif is_bornhuetter_ferguson:
        source_kind = BF_SOURCE_KIND
    elif is_engine_generated:
        source_kind = "engine"
    elif formula:
        source_kind = "calculated"
    else:
        source_kind = "input"
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "dataset_category": _normalize_import_name(payload.get("category")),
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "calculated": bool((formula and not is_engine_generated) or is_result_selection or is_bornhuetter_ferguson),
        "formula": formula,
        "source": (
            "resq_result_selection_vector"
            if is_result_selection
            else "resq_bornhuetter_ferguson_vector"
            if is_bornhuetter_ferguson
            else "resq_vector"
        ),
        "method_type": meta_method_type,
        "method_type_code": meta_method_type_code,
        "data_format": "Vector",
        "data_format_code": payload.get("data_format", 1),
        "period_length": period_length,
        "origin_count": payload.get("origin_count", 0),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "number_format": dataset_type_number_format(rc_path, dataset_type),
        "decimal_places": dataset_type_decimal_places(rc_path, dataset_type),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "notes": str(payload.get("notes") or ""),
        "updated_at": updated_at,
    }
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    if is_bornhuetter_ferguson and isinstance(bf_method_payload, dict):
        existing = _safe_read_json(meta_path)
        publication_revision = _clean_name(
            bf_method_payload.get("method_metadata", {}).get("publication_revision")
            if isinstance(bf_method_payload.get("method_metadata"), dict)
            else ""
        )
        output_changed = _clean_name(existing.get("publication_revision")) != publication_revision
        meta = build_bornhuetter_ferguson_output_sidecar(
            bf_method_payload,
            project_name=PROJECT_NAME,
            reserving_class=rc_path,
            csv_file=csv_name,
            existing=existing,
            notes=str(payload.get("notes") or ""),
            timestamp=updated_at,
            user=payload.get("user", ""),
            output_changed=output_changed,
            append_audit=not existing or output_changed,
            status=normalize_method_status(payload.get("status")),
        )
    elif is_bornhuetter_ferguson:
        # A BF-coded vector without a matching exported method is an ordinary
        # imported dataset, not a BF publication. Preserve the legacy fallback
        # rather than manufacturing an incomplete canonical BF sidecar.
        meta.pop("formula", None)
        meta["status"] = normalize_method_status(payload.get("status"))
        source_names = [
            _normalize_import_name(item)
            for item in payload.get("precedents", [])
            if _normalize_import_name(item)
        ]
        meta["Precedents"] = source_names
        meta["Dependents"] = []
    elif is_result_selection:
        meta["status"] = normalize_method_status(payload.get("status"))
        source_names = [
            _normalize_import_name(item)
            for item in payload.get("precedents", [])
            if _normalize_import_name(item)
        ]
        meta["Precedents"] = source_names
        meta["Dependents"] = []
    else:
        _apply_graph_meta_best_effort(meta, dataset_type, rc_dir)
    _write_json(meta_path, meta)
    return csv_path


def _engine_cache_created_at(csv_path: Path, fallback: str) -> str:
    """Match the app's engine sidecar `created` timestamp (CSV file ctime, UTC)."""
    try:
        ctime = csv_path.stat().st_ctime
    except OSError:
        return fallback
    return datetime.utcfromtimestamp(ctime).isoformat(timespec="seconds") + "Z"


def write_engine_generated_export(
    payload: dict,
    rc_path: str,
    rc_dir: Path,
    *,
    is_vector: bool,
    provenance: dict,
    csv_name: str,
    csv_path: Path,
) -> Path:
    """Write the canonical sidecar for a data-engine-generated dataset.

    The CSV at ``csv_path`` must already have been produced by the data-engine
    (see ``resq_migration.engine.generate_engine_csv``); this function only writes
    the JSON sidecar. Unlike the ResQ-copied writers, the sidecar is marked as a
    live engine cache (``source_kind='engine'`` with no ``resq_*`` source marker)
    and carries the authoritative processing provenance so the app treats the
    migrated cache as fresh rather than stale.
    """
    name = _normalize_import_name(payload["name"])
    dataset_type = _normalize_import_name(payload.get("dataset_type")) or name
    user = getpass.getuser()
    updated_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    created = _engine_cache_created_at(csv_path, "")
    meta = build_engine_dataset_sidecar(
        project_name=PROJECT_NAME,
        reserving_class=rc_path,
        dataset_name=name,
        dataset_type=dataset_type,
        data_format="Vector" if is_vector else "Triangle",
        csv_file=csv_name,
        user=user,
        created=created,
        updated_at=updated_at,
        number_format=dataset_type_number_format(rc_path, dataset_type),
        decimal_places=dataset_type_decimal_places(rc_path, dataset_type),
        origin_length=int(payload.get("origin_length") or 0),
        development_length=int(payload.get("development_length") or 0),
        period_length=_vector_payload_period_length(payload) if is_vector else None,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
        processing=provenance,
    )

    _apply_graph_meta_best_effort(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path

def _result_selection_dataset_count(result_selection) -> int:
    value = _safe_int_attr(result_selection, "DatasetCount", 0)
    if value > 0:
        return value
    try:
        return int(_call_member(result_selection, "DatasetCount"))
    except Exception:
        return 0

def _result_selection_origin_count(result_selection) -> int:
    value = _safe_int_attr(result_selection, "OriginCount", 0)
    if value > 0:
        return value
    try:
        return int(_call_member(result_selection, "OriginCount"))
    except Exception:
        return 0

def _result_selection_origin_label(result_selection, origin_index: int) -> str:
    try:
        return _normalize_import_name(result_selection.OriginLabel(origin_index))
    except Exception:
        return str(origin_index)

def _result_selection_dataset(result_selection, dataset_index: int):
    return _call_member(result_selection, "Dataset", dataset_index)

def _result_selection_dataset_value(result_selection, dataset_index: int, origin_index: int, origin_length: int):
    call_shapes = [
        ((dataset_index, origin_index, origin_length), {}),
        ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index, "OriginLength": origin_length}),
    ]
    return _try_call_member(result_selection, "DatasetValues", call_shapes)

def _result_selection_weight(result_selection, dataset_index: int, origin_index: int):
    call_shapes = [
        ((dataset_index, origin_index), {}),
        ((), {"DatasetIndex": dataset_index, "OriginIndex": origin_index}),
    ]
    return _try_call_member(result_selection, "Weights", call_shapes)

def _result_selection_ultimate(result_selection, origin_index: int, origin_length: int):
    call_shapes = [
        ((origin_index, origin_length), {}),
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index, "OriginLength": origin_length}),
    ]
    return _try_call_member(result_selection, "Ultimates", call_shapes)

def _result_selection_ultimate_overridden(result_selection, origin_index: int) -> bool:
    call_shapes = [
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
    ]
    return _bool_value(_try_call_member(result_selection, "UltimateOverridden", call_shapes))

def _result_selection_ratio_basis_dataset_name(result_selection) -> str:
    call_shapes = [
        ((1,), {}),
        ((), {"DatasetIndex": 1}),
        ((), {"arg0": 1}),
    ]
    try:
        dataset = _try_call_member(result_selection, "RatioBasisDataset", call_shapes)
    except Exception:
        return ""
    return _normalize_import_name(_safe_attr(dataset, "Name", ""))

def _result_selection_ratio_basis_value(result_selection, origin_index: int, origin_length: int):
    call_shapes = [
        ((origin_index, origin_length), {}),
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index, "OriginLength": origin_length}),
    ]
    return _try_call_member(result_selection, "RatioBasisValues", call_shapes)

def _rs_json_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    try:
        rounded = Decimal(str(abs(number))).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return None
    if isinstance(value, int):
        return value
    result = float(rounded)
    return -result if number < 0 else result

def _result_selection_source_kind(name: str, dataset_type: str, data_format: str, method_type_code: int) -> str:
    if method_type_code == METHOD_TYPE_DFM_CODE:
        return "dfm"
    if method_type_code == METHOD_TYPE_RESULT_SELECTION_CODE:
        return "result_selection"
    if _clean_name(data_format).lower() == "triangle":
        return _triangle_source_kind(name, dataset_type)
    return "input"

def _result_selection_source_payload(result_selection, dataset_index: int, origin_count: int, origin_length: int) -> dict:
    dataset = _result_selection_dataset(result_selection, dataset_index)
    dataset_type_obj = _safe_attr(dataset, "DatasetType", None)
    name = _normalize_import_name(_safe_attr(dataset, "Name", "")) or f"Source {dataset_index}"
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", ""))
    data_format_code = _safe_int_attr(dataset_type_obj, "DataFormat", -1)
    data_format = "Triangle" if data_format_code == 0 else "Vector"
    method_type_code = _safe_int_attr(dataset, "MethodType", METHOD_TYPE_NONE_CODE)
    method_type = _method_type_name(method_type_code)
    values: list = []
    weights: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            values.append(_rs_json_number(_result_selection_dataset_value(result_selection, dataset_index, origin_index, origin_length)))
        except Exception:
            values.append(None)
        try:
            weights.append(max(0.0, _rs_json_number(
                _result_selection_weight(result_selection, dataset_index, origin_index)
            ) or 0.0))
        except Exception:
            weights.append(0)
    return {
        "name": name,
        "dataset_type": dataset_type,
        "data_format": data_format,
        "method_type": method_type,
        "category": _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", "")),
        "source_kind": _result_selection_source_kind(name, dataset_type, data_format, method_type_code),
        "origin_length": max(1, _safe_int_attr(dataset, "OriginLength", origin_length)),
        "values": values,
        "weights": weights,
    }


def _result_selection_calculated_ultimate(loaded_datasets: list[dict], origin_count: int) -> list:
    ultimate: list = []
    for row_index in range(origin_count):
        numerator = 0.0
        denominator = 0.0
        for dataset in loaded_datasets:
            values = dataset.get("values") if isinstance(dataset.get("values"), list) else []
            weights = dataset.get("weights") if isinstance(dataset.get("weights"), list) else []
            try:
                value = float(values[row_index])
                weight = max(0.0, float(weights[row_index]))
            except (IndexError, TypeError, ValueError):
                continue
            if not math.isfinite(value) or not math.isfinite(weight) or weight <= 0:
                continue
            numerator += value * weight
            denominator += weight
        ultimate.append(_rs_json_number(numerator / denominator) if denominator > 0 else None)
    return ultimate


def _result_selection_selected_ultimate(calculated_ultimate: list, ultimate_overrides: list, origin_count: int) -> list:
    selected: list = []
    for row_index in range(origin_count):
        override = ultimate_overrides[row_index] if row_index < len(ultimate_overrides) else None
        selected.append(override if override is not None else calculated_ultimate[row_index])
    return selected


def export_result_selection(result_selection) -> dict:
    """Extract a ResQ Result Selection method into ArcRho's method JSON shape."""
    output_vector = _safe_attr(result_selection, "OutputVector", None)
    name = _normalize_import_name(_safe_attr(output_vector, "Name", "")) or _normalize_import_name(_safe_attr(result_selection, "Name", ""))
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    output_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    origin_length = _safe_int_attr(result_selection, "OriginLength", 12)
    origin_count = _result_selection_origin_count(result_selection)
    if origin_count <= 0:
        raise ValueError(f"Result Selection {name!r} does not expose a positive OriginCount.")
    dataset_count = _result_selection_dataset_count(result_selection)
    origin_labels = [_result_selection_origin_label(result_selection, i) for i in range(1, origin_count + 1)]
    loaded_datasets = [
        _result_selection_source_payload(result_selection, dataset_index, origin_count, origin_length)
        for dataset_index in range(1, dataset_count + 1)
    ]
    ratio_basis_dataset = _result_selection_ratio_basis_dataset_name(result_selection)
    ratio_basis_datasets = [ratio_basis_dataset] if ratio_basis_dataset else []
    ratio_basis_values = []
    if ratio_basis_dataset:
        values = []
        for origin_index in range(1, origin_count + 1):
            try:
                values.append(_rs_json_number(
                    _result_selection_ratio_basis_value(result_selection, origin_index, origin_length)
                ))
            except Exception:
                values.append(None)
        ratio_basis_values.append({"name": ratio_basis_dataset, "values": values})
    ultimate_overrides: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            overridden = _result_selection_ultimate_overridden(result_selection, origin_index)
        except Exception:
            overridden = False
        if not overridden:
            ultimate_overrides.append(None)
            continue
        try:
            ultimate_overrides.append(_rs_json_number(_result_selection_ultimate(result_selection, origin_index, origin_length)))
        except Exception:
            ultimate_overrides.append(None)
    calculated_ultimate = _result_selection_calculated_ultimate(loaded_datasets, origin_count)
    selected_ultimate = _result_selection_selected_ultimate(calculated_ultimate, ultimate_overrides, origin_count)

    try:
        notes = _clean_name(result_selection.Notes)
    except Exception:
        notes = ""
    try:
        modified = _iso_or_text(output_vector.Modified)
    except Exception:
        modified = datetime.now(timezone.utc).astimezone().isoformat()

    return {
        "json_format": RS_JSON_FORMAT,
        "details_tab": {
            "name": name,
            "output_type": output_type,
            "origin_length": origin_length,
            "ratio_basis_datasets": ratio_basis_datasets,
            "active_ratio_basis_dataset": ratio_basis_dataset,
            "show_ratios_as_percentages": True,
            "statistic_decimal_places": 1,
        },
        "method_tab": {
            "origin_labels": origin_labels,
            "show_weights": True,
            "loaded_datasets": loaded_datasets,
            "ratio_basis_values": ratio_basis_values,
            "calculated_ultimate": calculated_ultimate,
            "selected_ultimate": selected_ultimate,
            "ultimate_overrides": ultimate_overrides,
        },
        "results_tab": {},
        "validation_tab": {},
        "_sidecar_notes": notes,
        "_sidecar_status": normalize_method_status(_safe_attr(output_vector, "Status", 0)),
        "method_metadata": {
            "last_modified": modified,
        },
    }

def _result_selection_source_names(payload: dict) -> list[str]:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    loaded_datasets = method_tab.get("loaded_datasets") if isinstance(method_tab.get("loaded_datasets"), list) else []
    names: list[str] = []
    seen: set[str] = set()
    for dataset in loaded_datasets:
        name = _normalize_import_name(dataset.get("name") if isinstance(dataset, dict) else "")
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names

def _result_selection_precedent_names(payload: dict) -> list[str]:
    names = _result_selection_source_names(payload)
    seen = {name.lower() for name in names}
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    for raw_name in details_tab.get("ratio_basis_datasets", []) if isinstance(details_tab.get("ratio_basis_datasets"), list) else []:
        name = _normalize_import_name(raw_name)
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names

def _result_selection_origin_labels_from_payload(payload: dict) -> list[str]:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    labels = method_tab.get("origin_labels") if isinstance(method_tab.get("origin_labels"), list) else []
    return [_normalize_import_name(label) for label in labels if _normalize_import_name(label)]

def _apply_result_selection_vector_metadata(payload: dict, result_selection_payload: dict) -> None:
    payload["notes"] = str(result_selection_payload.pop("_sidecar_notes", "") or "")
    payload["status"] = normalize_method_status(
        result_selection_payload.pop("_sidecar_status", payload.get("status"))
    )
    payload["precedents"] = _result_selection_precedent_names(result_selection_payload)
    origin_labels = _result_selection_origin_labels_from_payload(result_selection_payload)
    if origin_labels:
        payload["origin_labels"] = origin_labels
        payload["origin_count"] = len(origin_labels)

def _bf_origin_count(method, output_vector) -> int:
    origin_count = _safe_int_attr(method, "OriginCount", 0)
    if origin_count <= 0:
        try:
            origin_count = int(_call_member(method, "OriginCount"))
        except Exception:
            origin_count = 0
    if origin_count <= 0:
        origin_count = _vector_origin_count(output_vector)
    return max(0, origin_count)


def _bf_origin_label(method, origin_index: int) -> str:
    for name in ("OriginLabel", "OriginLabels"):
        try:
            return _normalize_import_name(_try_call_member(method, name, [((), {"OriginIndex": origin_index}), ((origin_index,), {})]))
        except Exception:
            continue
    return ""


def _bf_origin_labels(method, output_vector, fallback_count: int = 0) -> list[str]:
    origin_count = _bf_origin_count(method, output_vector)
    if origin_count <= 0:
        origin_count = max(0, int(fallback_count or 0))
    labels: list[str] = []
    for i in range(1, origin_count + 1):
        labels.append(_bf_origin_label(method, i) or _vector_origin_label(output_vector, i))
    return labels


def _bf_source_snapshot(source, origin_labels: list[str], *, latest: bool) -> dict:
    """Extract the exact source vector BF consumes, without filesystem I/O."""

    name = _normalize_import_name(_safe_attr(source, "Name", ""))
    if not name:
        raise ValueError("A ResQ BF precedent does not expose a dataset name.")
    values: list = []
    successful_reads = 0
    errors: list[Exception] = []
    for origin_index in range(1, len(origin_labels) + 1):
        try:
            if not latest:
                value = _vector_value(source, origin_index)
                successful_reads += 1
                values.append(value)
                continue
            development_count = _triangle_development_count(source, origin_index)
            if development_count <= 0:
                value = _vector_value(source, origin_index)
                successful_reads += 1
                values.append(value)
                continue
            value = None
            row_read = False
            for development_index in range(development_count, 0, -1):
                try:
                    candidate = _triangle_value(source, origin_index, development_index)
                    row_read = True
                except Exception as exc:
                    errors.append(exc)
                    continue
                if _rs_json_number(candidate) is not None:
                    value = candidate
                    break
            if row_read:
                successful_reads += 1
            values.append(value)
        except Exception as exc:
            errors.append(exc)
            values.append(None)
    if origin_labels and successful_reads <= 0:
        detail = f": {errors[0]}" if errors else ""
        raise ValueError(f"Failed to read BF source {name!r}{detail}")
    return {
        "name": name,
        "origin_labels": list(origin_labels),
        "values": values,
    }


def export_bornhuetter_ferguson(method) -> dict:
    """Extract a complete, self-contained canonical BF v3 payload from ResQ."""

    output_vector = _safe_attr(method, "OutputVector", None)
    name = _normalize_import_name(_safe_attr(output_vector, "Name", "")) or _normalize_import_name(_safe_attr(method, "Name", ""))
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    output_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    dataset_category = _normalize_import_name(
        _safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", "")
    )
    origin_length = _safe_int_attr(method, "OriginLength", _safe_int_attr(output_vector, "PeriodLength", 12))
    origin_labels = _bf_origin_labels(method, output_vector)
    if not origin_labels or any(not label for label in origin_labels):
        raise ValueError(f"Bornhuetter Ferguson method {name!r} does not expose complete origin labels.")
    latest_source = _safe_attr(method, "Latest", None)
    dfm_source = _safe_attr(method, "PercentageDeveloped", None)
    prior_source = _safe_attr(method, "Prior", None)
    latest_snapshot = _bf_source_snapshot(latest_source, origin_labels, latest=True)
    dfm_snapshot = _bf_source_snapshot(dfm_source, origin_labels, latest=False)
    prior_snapshot = _bf_source_snapshot(prior_source, origin_labels, latest=False)
    try:
        notes = _clean_name(method.Notes)
    except Exception:
        notes = ""
    try:
        modified = _iso_or_text(output_vector.Modified)
    except Exception:
        modified = datetime.now(timezone.utc).astimezone().isoformat()

    owned = {
        "json_format": BF_JSON_FORMAT,
        "details_tab": {
            "name": name,
            "method_type": BF_METHOD_TYPE,
            "output_type": output_type,
            "dataset_category": dataset_category,
            "origin_length": origin_length,
            "statistic_decimal_places": 1,
        },
        "method_tab": {
            "latest_dataset": latest_snapshot["name"],
            "dfm_dataset": dfm_snapshot["name"],
            "show_weights": True,
            "show_effective_weights": False,
            "prior_datasets": [
                {
                    "name": prior_snapshot["name"],
                    "values": [],
                    "weights": [1.0 for _ in origin_labels],
                }
            ],
            "origin_labels": origin_labels,
            "latest_values": [],
            "dfm_ultimate_values": [],
            "percentage_developed": [],
            "selected_prior_values": [],
            "new_ultimate": [],
        },
        "chart_tab": {},
        "_sidecar_notes": notes,
        "audit_log_tab": {},
        "method_metadata": {
            "method_type": BF_METHOD_TYPE,
            "source_kind": BF_SOURCE_KIND,
            "last_modified": modified,
            "data_refreshed": modified,
        },
    }
    payload = recalculate_bornhuetter_ferguson_method(
        owned,
        source_snapshots={
            "latest": latest_snapshot,
            "dfm": dfm_snapshot,
            "priors": [prior_snapshot],
        },
        timestamp=modified,
    )
    payload["_sidecar_notes"] = notes
    payload["_sidecar_status"] = normalize_method_status(_safe_attr(output_vector, "Status", 0))
    return payload


def _apply_bornhuetter_ferguson_vector_metadata(payload: dict, bf_payload: dict) -> None:
    payload["notes"] = str(bf_payload.pop("_sidecar_notes", "") or "")
    payload["status"] = normalize_method_status(
        bf_payload.pop("_sidecar_status", payload.get("status"))
    )
    payload["source_kind"] = BF_SOURCE_KIND
    payload["method_type"] = BF_METHOD_TYPE
    payload["method_type_code"] = METHOD_TYPE_BF_CODE
    payload["precedents"] = bornhuetter_ferguson_precedent_names(bf_payload)
    details_tab = bf_payload.get("details_tab") if isinstance(bf_payload.get("details_tab"), dict) else {}
    metadata = bf_payload.get("method_metadata") if isinstance(bf_payload.get("method_metadata"), dict) else {}
    payload["method_name"] = _normalize_import_name(details_tab.get("name"))
    payload["publication_revision"] = _clean_name(metadata.get("publication_revision"))
    method_tab = bf_payload.get("method_tab") if isinstance(bf_payload.get("method_tab"), dict) else {}
    origin_labels = method_tab.get("origin_labels") if isinstance(method_tab.get("origin_labels"), list) else []
    if origin_labels:
        payload["origin_labels"] = [_normalize_import_name(label) for label in origin_labels]
        payload["origin_count"] = len(origin_labels)
        payload["values"] = [[value] for value in method_tab.get("new_ultimate", [])]
    payload["origin_length"] = int(
        details_tab.get("origin_length") or payload.get("origin_length") or 12
    )
    payload["period_length"] = payload["origin_length"]


def write_bornhuetter_ferguson_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    del rc_path
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    name = _normalize_import_name(details_tab.get("name")) or BF_METHOD_TYPE
    file_name = f"BF@{_encode_name_part(name)}.json"
    out_path = rc_dir / METHOD_DATA_DIR / file_name
    method_payload = dict(payload)
    method_payload.pop("_sidecar_notes", None)
    method_payload.pop("_sidecar_status", None)
    _write_json(out_path, method_payload)
    return out_path


def _find_bornhuetter_ferguson_for_vector(reserving_class, vector_name: str):
    target = _normalize_import_name(vector_name).lower()
    try:
        collection = _call_member(reserving_class, "BFMethods")
        try:
            item = collection.Item(vector_name)
            if item is not None:
                return item
        except Exception:
            pass
        for item in collection:
            output_vector = _safe_attr(item, "OutputVector", None)
            output_name = _normalize_import_name(_safe_attr(output_vector, "Name", "")).lower()
            method_name = _normalize_import_name(_safe_attr(item, "Name", "")).lower()
            if target and (output_name == target or method_name == target):
                return item
    except Exception:
        return None
    return None

def _parse_origin_start_month(label: object, base_len: int) -> tuple[int, int] | None:
    text = _clean_name(label)
    if not text:
        return None

    if base_len == 1:
        match = re.match(r"^(\d{4})(\d{2})$", text)
        if match:
            month = int(match.group(2))
            if 1 <= month <= 12:
                return int(match.group(1)), month
        return None

    if base_len == 3:
        for pattern in (r"^(\d{4})\s*Q([1-4])$", r"^Q([1-4])\s*(\d{4})$"):
            match = re.match(pattern, text, re.I)
            if not match:
                continue
            if pattern.startswith("^(\\d"):
                year, quarter = int(match.group(1)), int(match.group(2))
            else:
                quarter, year = int(match.group(1)), int(match.group(2))
            return year, (quarter - 1) * 3 + 1
        return None

    if base_len == 6:
        for pattern in (r"^(\d{4})\s*H([1-2])$", r"^H([1-2])\s*(\d{4})$"):
            match = re.match(pattern, text, re.I)
            if not match:
                continue
            if pattern.startswith("^(\\d"):
                year, half = int(match.group(1)), int(match.group(2))
            else:
                half, year = int(match.group(1)), int(match.group(2))
            return year, (half - 1) * 6 + 1
        return None

    if base_len == 12 and re.match(r"^\d{4}$", text):
        return int(text), 1
    return None

def _numeric_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None

def _vector_row_value(row: object) -> object:
    if isinstance(row, list):
        return row[0] if row else None
    return row

def _aggregate_vector_values_by_length(values: list, origin_labels: list, base_len: int, target_len: int) -> list[list]:
    if not values:
        return []
    if base_len <= 0 or target_len <= base_len or target_len % base_len != 0:
        return []
    factor = target_len // base_len
    vector = [_vector_row_value(row) for row in values]
    labels = [str(label) for label in origin_labels] if isinstance(origin_labels, list) else []

    if len(labels) == len(vector) and base_len in {1, 3, 6, 12}:
        ordered_keys: list[tuple[int, int]] = []
        buckets: dict[tuple[int, int], dict[str, object]] = {}
        parse_failed = False
        for label, raw in zip(labels, vector):
            parsed = _parse_origin_start_month(label, base_len)
            if parsed is None:
                parse_failed = True
                break
            year, month = parsed
            bucket_month = ((month - 1) // target_len) * target_len + 1
            key = (year, bucket_month)
            if key not in buckets:
                buckets[key] = {"sum": 0.0, "has_value": False}
                ordered_keys.append(key)
            number = _numeric_or_none(raw)
            if number is not None:
                buckets[key]["sum"] = float(buckets[key]["sum"]) + number
                buckets[key]["has_value"] = True
        if not parse_failed:
            return [[buckets[key]["sum"] if buckets[key]["has_value"] else None] for key in ordered_keys]

    out: list[list] = []
    for start in range(0, len(vector), factor):
        total = 0.0
        has_value = False
        for raw in vector[start:start + factor]:
            number = _numeric_or_none(raw)
            if number is None:
                continue
            total += number
            has_value = True
        out.append([total if has_value else None])
    return out

def _write_aggregated_vector_cache_exports(payload: dict, rc_dir: Path) -> list[Path]:
    try:
        base_len = _vector_payload_period_length(payload)
    except (TypeError, ValueError):
        return []
    if base_len <= 0:
        return []
    paths: list[Path] = []
    for target_len in (3, 6, 12):
        if target_len <= base_len or target_len % base_len != 0:
            continue
        rows = _aggregate_vector_values_by_length(
            payload.get("values") if isinstance(payload.get("values"), list) else [],
            payload.get("origin_labels") if isinstance(payload.get("origin_labels"), list) else [],
            base_len,
            target_len,
        )
        if not rows:
            continue
        csv_name = _vector_cache_csv_file_name(_normalize_import_name(payload["name"]), target_len)
        csv_path = rc_dir / DATASET_CACHE_DIR / csv_name
        _write_csv_matrix(csv_path, rows)
        paths.append(csv_path)
    return paths

def write_result_selection_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    name = _normalize_import_name(details_tab.get("name")) or "Result Selection"
    file_name = f"RS@{_encode_name_part(name)}.json"
    out_path = rc_dir / METHOD_DATA_DIR / file_name
    method_payload = dict(payload)
    method_payload.pop("_sidecar_notes", None)
    method_payload.pop("_sidecar_status", None)
    _write_json(out_path, method_payload)
    return out_path

def _find_result_selection_for_vector(reserving_class, vector_name: str):
    try:
        return _call_member(reserving_class, "GetResultSelection", vector_name)
    except Exception:
        pass
    try:
        collection = _call_member(reserving_class, "ResultSelections")
        try:
            return collection.Item(vector_name)
        except Exception:
            pass
        for item in collection:
            output_vector = _safe_attr(item, "OutputVector", None)
            if _normalize_import_name(_safe_attr(output_vector, "Name", "")).lower() == _normalize_import_name(vector_name).lower():
                return item
    except Exception:
        return None
    return None

def _dfm_ultimate_value(dfm, origin_index: int):
    call_shapes = [
        ((origin_index,), {}),
        ((), {"OriginIndex": origin_index}),
        ((), {"arg0": origin_index}),
    ]
    try:
        return _try_call_member(dfm, "Ultimates", call_shapes)
    except Exception as exc:
        raise AttributeError(f"Could not read DFM ultimate value for origin index {origin_index}.") from exc

def export_dfm_ultimate_vector(
    dfm,
    origin_labels: list[str],
    origin_length: int,
    dev_length: int,
) -> dict:
    """Extract the DFM output vector from ResQ DFM.Ultimates into ArcRho CSV payload shape."""
    output_vector = dfm.OutputVector
    name = _normalize_import_name(output_vector.Name)
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 1)
    method_type_code = _safe_int_attr(output_vector, "MethodType", -1)
    method_type = _method_type_name(method_type_code)
    origin_count = len(origin_labels)
    if origin_count <= 0:
        raise ValueError(f"DFM output vector {name!r} does not have origin labels.")

    values: list[list] = []
    attempted_cells = 0
    value_errors: list[Exception] = []
    for i in range(1, origin_count + 1):
        attempted_cells += 1
        try:
            values.append([_dfm_ultimate_value(dfm, i)])
        except Exception as exc:
            value_errors.append(exc)
            values.append([None])
    if attempted_cells > 0 and len(value_errors) == attempted_cells:
        raise ValueError(f"Failed to read any DFM ultimate values for {name!r}: {value_errors[0]}")

    user = _normalize_import_name(_safe_attr(output_vector, "User", ""))
    created = _iso_or_text(_safe_attr(output_vector, "Created", ""))
    modified = _iso_or_text(_safe_attr(output_vector, "Modified", ""))

    return {
        "name": name,
        "dataset_type": dataset_type,
        "category": category,
        "data_format": data_format,
        "method_type": method_type,
        "method_type_code": method_type_code,
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": origin_count,
        "development_count": 1,
        "origin_labels": origin_labels,
        "development_labels": ["Ultimate"],
        "values": values,
        "method_name": _normalize_import_name(dfm.Name),
        "notes": str(_safe_attr(dfm, "Notes", "") or ""),
        "user": user,
        "created": created,
        "modified": modified,
        "status": normalize_method_status(_safe_attr(output_vector, "Status", 0)),
    }


def _csv_matrix_bytes(rows: list[list]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerows([
        ["" if cell is None or str(cell).strip().lower() in {"none", "nan"} else str(cell).strip() for cell in row]
        for row in rows
    ])
    return stream.getvalue().encode("utf-8")


def build_dfm_ultimate_publication(
    payload: dict,
    method_payload: dict,
    rc_path: str,
    rc_dir: Path,
) -> tuple[Path, dict[Path, bytes], Path]:
    """Build every DFM output artifact without mutating disk."""

    name = _normalize_import_name(payload["name"])
    period_length = _vector_payload_period_length(payload)
    files: dict[Path, bytes] = {}
    primary_path = rc_dir / DATASET_CACHE_DIR / _vector_cache_csv_file_name(name, period_length)
    for target_length, values in dfm_output_variants(method_payload).items():
        path = rc_dir / DATASET_CACHE_DIR / _vector_cache_csv_file_name(name, target_length)
        files[path] = _csv_matrix_bytes([[value] for value in values])

    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    existing = _safe_read_json(meta_path)
    publication_revision = _clean_name(
        method_payload.get("method metadata", {}).get("publication revision")
        if isinstance(method_payload.get("method metadata"), dict)
        else ""
    )
    output_changed = _clean_name(existing.get("publication_revision")) != publication_revision
    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    sidecar = build_dfm_output_sidecar(
        method_payload,
        project_name=PROJECT_NAME,
        reserving_class=rc_path,
        csv_file=primary_path.name,
        existing=existing,
        notes=None if existing else str(payload.get("notes") or ""),
        timestamp=updated_at,
        user=payload.get("user", ""),
        output_changed=output_changed,
        append_audit=not existing or output_changed,
        status=normalize_method_status(payload.get("status")),
    )
    files[meta_path] = f"{_format_json(sidecar)}\n".encode("utf-8")
    return primary_path, files, meta_path

def publish_dfm_artifacts(files: dict[Path, bytes], *, sidecar_path: Path) -> list[Path]:
    """Publish staged DFM artifacts with rollback and sidecar-last replacement."""

    ordered = sorted(files, key=lambda path: (path == sidecar_path, str(path).casefold()))
    staged: dict[Path, Path] = {}
    backups: dict[Path, bytes | None] = {}
    replaced: list[Path] = []
    try:
        for path in ordered:
            path.parent.mkdir(parents=True, exist_ok=True)
            current = path.read_bytes() if path.is_file() else None
            if current == files[path]:
                continue
            backups[path] = current
            temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_bytes(files[path])
            staged[path] = temporary
        for path in ordered:
            temporary = staged.pop(path, None)
            if temporary is None:
                continue
            os.replace(temporary, path)
            replaced.append(path)
    except OSError as exc:
        rollback_errors: list[str] = []
        for path in reversed(replaced):
            try:
                original = backups[path]
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.rollback")
                    temporary.write_bytes(original)
                    os.replace(temporary, path)
            except OSError as rollback_exc:
                rollback_errors.append(f"{path.name}: {rollback_exc}")
        detail = f"; rollback failed: {'; '.join(rollback_errors)}" if rollback_errors else ""
        raise RuntimeError(f"Failed to publish DFM {sidecar_path.stem}: {exc}{detail}") from exc
    finally:
        for temporary in staged.values():
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return replaced


def write_dfm_ultimate_vector_export(
    payload: dict,
    rc_path: str,
    rc_dir: Path,
    *,
    method_payload: dict | None = None,
) -> Path:
    """Compatibility publisher; a canonical v2 method payload is mandatory."""

    if not isinstance(method_payload, dict):
        raise ValueError("A canonical DFM v2 method payload is required to publish its output.")
    csv_path, files, sidecar_path = build_dfm_ultimate_publication(
        payload,
        method_payload,
        rc_path,
        rc_dir,
    )
    publish_dfm_artifacts(files, sidecar_path=sidecar_path)
    return csv_path
