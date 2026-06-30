from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from .catalog import _apply_sidecar_graph_meta
from .core import (
    DATASET_CACHE_DIR,
    DATASET_SIDECAR_DIR,
    DEFAULT_CALENDAR,
    DEFAULT_CUMULATIVE,
    METHOD_TYPE_NONE_CODE,
    _call_member,
    _clean_name,
    _dataset_cache_csv_file_name,
    _encode_name_part,
    _is_result_selection_method_type,
    _iso_or_text,
    _json_sidecar_name,
    _method_type_code,
    _method_type_name,
    _normalize_import_name,
    _safe_attr,
    _safe_int_attr,
    _triangle_source_kind,
    _try_call_member,
    _write_csv_matrix,
    _write_json,
)
from .number_formats import dataset_instance_decimal_places, dataset_instance_number_format


PROJECT_NAME = "NJ_Annual_Prod_202605_Fake"
RS_JSON_FORMAT = "arcrho-result-selection-method-by-tab-v1"
METHOD_DATA_DIR = "methods"


def _apply_graph_meta_best_effort(meta: dict, dataset_type: str, rc_dir: Path, **kwargs) -> None:
    try:
        _apply_sidecar_graph_meta(meta, dataset_type, rc_dir, **kwargs)
    except Exception as exc:
        meta.setdefault("Precedents", [])
        meta.setdefault("Dependents", [])
        meta["graph_metadata_error"] = str(exc)


def configure_extractors(*, project_name: str, rs_json_format: str, method_data_dir: str) -> None:
    global PROJECT_NAME, RS_JSON_FORMAT, METHOD_DATA_DIR

    PROJECT_NAME = str(project_name)
    RS_JSON_FORMAT = str(rs_json_format)
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

def export_triangle(triangle) -> dict:
    """Extract a ResQ Triangle COM object into ArcRho CSV values and metadata."""
    name = _normalize_import_name(triangle.Name)
    dataset_type_obj = _safe_attr(triangle, "DatasetType", None)
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", ""))
    category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 0)
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
    source_kind = _triangle_source_kind(name, dataset_type)
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "dataset_category": _normalize_import_name(payload.get("category")),
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "calculated": False,
        "source": "resq_triangle",
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
        "number_format": dataset_instance_number_format(rc_path, name),
        "decimal_places": dataset_instance_decimal_places(rc_path, name),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    _apply_graph_meta_best_effort(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path

def export_vector(vector) -> dict:
    """Extract a ResQ Vector COM object into ArcRho CSV values and metadata."""
    name = _normalize_import_name(vector.Name)
    dataset_type_obj = _safe_attr(vector, "DatasetType", None)
    dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    data_format = _safe_int_attr(dataset_type_obj, "DataFormat", 1)
    method_type_code = _safe_int_attr(vector, "MethodType", -1)
    method_type = _method_type_name(method_type_code)
    origin_length = _safe_int_attr(vector, "OriginLength", 12)
    dev_length = _safe_int_attr(vector, "DevelopmentLength", 12)
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
    }

def write_vector_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
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

    formula = _clean_name(payload.get("formula"))
    method_type = _method_type_name(payload.get("method_type"))
    is_result_selection = _is_result_selection_method_type(method_type)
    updated_at = payload.get("modified") or datetime.now(timezone.utc).astimezone().isoformat()
    source_kind = "result_selection" if is_result_selection else ("calculated" if formula else "input")
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "dataset_category": _normalize_import_name(payload.get("category")),
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": source_kind,
        "calculated": bool(formula or is_result_selection),
        "formula": formula,
        "source": "resq_result_selection_vector" if is_result_selection else "resq_vector",
        "method_type": method_type,
        "method_type_code": payload.get("method_type_code", _method_type_code(method_type, 0)),
        "data_format": "Vector",
        "data_format_code": payload.get("data_format", 1),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 1),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "number_format": dataset_instance_number_format(rc_path, name),
        "decimal_places": dataset_instance_decimal_places(rc_path, name),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    if is_result_selection:
        meta["status"] = 0
        source_names = [
            _normalize_import_name(item)
            for item in payload.get("precedents", [])
            if _normalize_import_name(item)
        ]
        meta["Precedents"] = source_names
        meta["Dependents"] = []
    else:
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

def _result_selection_source_payload(result_selection, dataset_index: int, origin_count: int, origin_length: int) -> dict:
    dataset = _result_selection_dataset(result_selection, dataset_index)
    dataset_type_obj = _safe_attr(dataset, "DatasetType", None)
    data_format_code = _safe_int_attr(dataset_type_obj, "DataFormat", -1)
    data_format = "Triangle" if data_format_code == 0 else "Vector"
    method_type_code = _safe_int_attr(dataset, "MethodType", METHOD_TYPE_NONE_CODE)
    values: list = []
    weights: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            values.append(_result_selection_dataset_value(result_selection, dataset_index, origin_index, origin_length))
        except Exception:
            values.append(None)
        try:
            weights.append(_result_selection_weight(result_selection, dataset_index, origin_index))
        except Exception:
            weights.append(0)
    return {
        "name": _normalize_import_name(_safe_attr(dataset, "Name", "")) or f"Source {dataset_index}",
        "dataset_type": _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")),
        "data_format": data_format,
        "method_type": _method_type_name(method_type_code),
        "category": _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", "")),
        "values": values,
        "weights": weights,
    }

def export_result_selection(result_selection) -> dict:
    """Extract a ResQ Result Selection method into ArcRho's method JSON shape."""
    output_vector = _safe_attr(result_selection, "OutputVector", None)
    name = _normalize_import_name(_safe_attr(output_vector, "Name", "")) or _normalize_import_name(_safe_attr(result_selection, "Name", ""))
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    output_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or name
    output_category = _normalize_import_name(_safe_attr(_safe_attr(dataset_type_obj, "Category", None), "Name", ""))
    origin_length = _safe_int_attr(result_selection, "OriginLength", 12)
    origin_count = _result_selection_origin_count(result_selection)
    if origin_count <= 0:
        raise ValueError(f"Result Selection {name!r} does not expose a positive OriginCount.")
    dataset_count = _result_selection_dataset_count(result_selection)
    origin_labels = [_result_selection_origin_label(result_selection, i) for i in range(1, origin_count + 1)]
    sources = [
        _result_selection_source_payload(result_selection, dataset_index, origin_count, origin_length)
        for dataset_index in range(1, dataset_count + 1)
    ]
    ratio_basis_dataset = _result_selection_ratio_basis_dataset_name(result_selection)
    selected_ultimate: list = []
    for origin_index in range(1, origin_count + 1):
        try:
            selected_ultimate.append(_result_selection_ultimate(result_selection, origin_index, origin_length))
        except Exception:
            selected_ultimate.append(None)

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
            "dataset_category": output_category,
            "output_category": output_category,
            "origin_length": origin_length,
            "ratio_basis": ratio_basis_dataset,
            "ratio_basis_dataset": ratio_basis_dataset,
            "show_ratios_as_percentages": True,
            "statistic_decimal_places": 1,
        },
        "method_tab": {
            "origin_labels": origin_labels,
            "show_weights": True,
            "sources": sources,
            "selected_ultimate": selected_ultimate,
            "ratio_basis_values": [],
        },
        "results_tab": {},
        "validation_tab": {},
        "notes_tab": {
            "notes": notes,
        },
        "method_metadata": {
            "last_modified": modified,
        },
    }

def _result_selection_source_names(payload: dict) -> list[str]:
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), dict) else {}
    sources = method_tab.get("sources") if isinstance(method_tab.get("sources"), list) else []
    names: list[str] = []
    seen: set[str] = set()
    for source in sources:
        name = _normalize_import_name(source.get("name") if isinstance(source, dict) else "")
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
    payload["precedents"] = _result_selection_source_names(result_selection_payload)
    origin_labels = _result_selection_origin_labels_from_payload(result_selection_payload)
    if origin_labels:
        payload["origin_labels"] = origin_labels
        payload["origin_count"] = len(origin_labels)

def write_result_selection_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
    details_tab = payload.get("details_tab") if isinstance(payload.get("details_tab"), dict) else {}
    name = _normalize_import_name(details_tab.get("name")) or "Result Selection"
    file_name = f"RS@{_encode_name_part(name)}.json"
    out_path = rc_dir / METHOD_DATA_DIR / file_name
    _write_json(out_path, payload)
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
        "user": user,
        "created": created,
        "modified": modified,
    }

def write_dfm_ultimate_vector_export(payload: dict, rc_path: str, rc_dir: Path) -> Path:
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
    meta = {
        "dataset_name": name,
        "dataset_type": dataset_type,
        "dataset_category": _normalize_import_name(payload.get("category")),
        "reserving_class": rc_path,
        "project_name": PROJECT_NAME,
        "source_kind": "dfm",
        "calculated": True,
        "source": "resq_dfm_ultimates",
        "method_name": payload.get("method_name", ""),
        "method_type": _method_type_name(payload.get("method_type")),
        "method_type_code": payload.get("method_type_code", _method_type_code(payload.get("method_type"), -1)),
        "data_format": "Vector",
        "data_format_code": payload.get("data_format", 1),
        "origin_length": origin_length,
        "development_length": dev_length,
        "origin_count": payload.get("origin_count", 0),
        "development_count": payload.get("development_count", 1),
        "origin_labels": payload.get("origin_labels", []),
        "development_labels": payload.get("development_labels", []),
        "cumulative": DEFAULT_CUMULATIVE,
        "calendar": DEFAULT_CALENDAR,
        "number_format": dataset_instance_number_format(rc_path, name),
        "decimal_places": dataset_instance_decimal_places(rc_path, name),
        "csv_file": csv_name,
        "user": payload.get("user", ""),
        "created": payload.get("created", ""),
        "modified_by": payload.get("user", ""),
        "updated_at": updated_at,
    }
    _apply_graph_meta_best_effort(meta, dataset_type, rc_dir)
    meta_path = rc_dir / DATASET_SIDECAR_DIR / _json_sidecar_name(name)
    _write_json(meta_path, meta)
    return csv_path
