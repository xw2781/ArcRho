from __future__ import annotations

import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from .catalog import _is_known_dataset_type, _unknown_dataset_type_skip_detail
from .core import (
    DATASET_CACHE_DIR,
    DEFAULT_CALENDAR,
    DEFAULT_CUMULATIVE,
    _clean_name,
    _dataset_cache_csv_file_name,
    _dataset_sidecar_path_for_cached_csv,
    _encode_rc_folder,
    _encode_name_part,
    _iso_or_text,
    _normalize_import_name,
    _safe_attr,
    _safe_read_json,
    _write_json,
)
from .extractors import export_dfm_ultimate_vector, write_dfm_ultimate_vector_export


DFM_JSON_FORMAT = "arcrho-dfm-method-by-tab-v1"
MAX_AVERAGE_FORMULA_PROBE = 30


def configure_dfm(*, dfm_json_format: str) -> None:
    global DFM_JSON_FORMAT

    DFM_JSON_FORMAT = str(dfm_json_format)


def _dict_child(parent: dict, key: str) -> dict:
    value = parent.get(key)
    if isinstance(value, dict):
        return value
    value = {}
    parent[key] = value
    return value


def _dict_path(payload: dict, keys: tuple[str, ...]) -> dict:
    current = payload
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _merge_cell_note_dicts(remote_notes: dict, local_notes: dict) -> dict:
    merged = deepcopy(remote_notes) if isinstance(remote_notes, dict) else {}
    if not isinstance(local_notes, dict):
        return merged

    for table_name, local_rows in local_notes.items():
        if not isinstance(local_rows, dict):
            merged[table_name] = deepcopy(local_rows)
            continue
        merged_rows = merged.setdefault(table_name, {})
        if not isinstance(merged_rows, dict):
            merged_rows = {}
            merged[table_name] = merged_rows
        for row_label, local_cols in local_rows.items():
            if not isinstance(local_cols, dict):
                merged_rows[row_label] = deepcopy(local_cols)
                continue
            merged_cols = merged_rows.setdefault(row_label, {})
            if not isinstance(merged_cols, dict):
                merged_cols = {}
                merged_rows[row_label] = merged_cols
            for col_label, note_text in local_cols.items():
                merged_cols[col_label] = deepcopy(note_text)
    return merged


def _average_formula_user_entry_index(average_formulas: dict) -> int | None:
    settings = average_formulas.get("custom average formula settings")
    average_types = settings.get("averageType") if isinstance(settings, dict) else None
    if isinstance(average_types, list):
        for index, average_type in enumerate(average_types):
            if _clean_name(average_type).lower() == "user_entry":
                return index

    labels = average_formulas.get("label")
    if isinstance(labels, list):
        for index, label in enumerate(labels):
            normalized = _clean_name(label).lower()
            if normalized == "user entry" or normalized.startswith("user entry "):
                return index
    return None


def _dfm_ratio_development_labels(payload: dict) -> list[str]:
    ratio_triangle = _dict_path(payload, ("ratios tab", "ratio triangle"))
    labels = ratio_triangle.get("development labels")
    return [_clean_name(label) for label in labels] if isinstance(labels, list) else []


def _ensure_matrix_row(matrix: list, row_index: int) -> list:
    while len(matrix) <= row_index:
        matrix.append([])
    if not isinstance(matrix[row_index], list):
        matrix[row_index] = []
    return matrix[row_index]


def _copy_local_user_entry_inputs(remote_payload: dict, local_payload: dict) -> bool:
    remote_avg = _dict_path(remote_payload, ("ratios tab", "average formulas"))
    local_avg = _dict_path(local_payload, ("ratios tab", "average formulas"))
    remote_user_row = _average_formula_user_entry_index(remote_avg)
    local_user_row = _average_formula_user_entry_index(local_avg)
    if remote_user_row is None or local_user_row is None:
        return False

    local_inputs = local_avg.get("inputs")
    if not isinstance(local_inputs, list):
        local_inputs = local_avg.get("formulas")
    if (
        not isinstance(local_inputs, list)
        or local_user_row >= len(local_inputs)
        or not isinstance(local_inputs[local_user_row], list)
    ):
        return False

    remote_inputs = remote_avg.get("inputs")
    if not isinstance(remote_inputs, list):
        remote_inputs = []
        remote_avg["inputs"] = remote_inputs
    remote_row = _ensure_matrix_row(remote_inputs, remote_user_row)

    remote_dev_labels = _dfm_ratio_development_labels(remote_payload)
    local_dev_labels = _dfm_ratio_development_labels(local_payload)
    remote_label_to_col = {
        label.lower(): index
        for index, label in enumerate(remote_dev_labels)
        if label
    }

    copied = False
    for local_col, formula in enumerate(local_inputs[local_user_row]):
        formula_text = _clean_name(formula)
        if not formula_text:
            continue
        remote_col = local_col
        if local_col < len(local_dev_labels):
            remote_col = remote_label_to_col.get(local_dev_labels[local_col].lower(), local_col)
        while len(remote_row) <= remote_col:
            remote_row.append("")
        remote_row[remote_col] = formula_text
        copied = True
    return copied


def _preserve_local_dfm_data(remote_payload: dict, local_payload: dict) -> tuple[dict, set[str]]:
    """Keep local-only DFM annotations when refreshing from ResQ."""
    preserved: set[str] = set()
    if not isinstance(local_payload, dict):
        return remote_payload, preserved

    remote_ratios = _dict_child(remote_payload, "ratios tab")
    remote_notes = remote_ratios.get("cell notes")
    local_notes = _dict_path(local_payload, ("ratios tab", "cell notes"))
    if isinstance(local_notes, dict) and local_notes:
        remote_ratios["cell notes"] = _merge_cell_note_dicts(
            remote_notes if isinstance(remote_notes, dict) else {},
            local_notes,
        )
        preserved.add("cell notes")

    if _copy_local_user_entry_inputs(remote_payload, local_payload):
        preserved.add("user entry formulas")
    return remote_payload, preserved


def _csv_abs_path(
    project_data_dir: Path,
    rc_folder: str,
    name: str,
    origin_length: int,
    dev_length: int,
    *,
    cumulative: bool = DEFAULT_CUMULATIVE,
    calendar: bool = DEFAULT_CALENDAR,
) -> str:
    filename = _dataset_cache_csv_file_name(name, origin_length, dev_length, cumulative=cumulative, calendar=calendar)
    return str(project_data_dir / rc_folder / DATASET_CACHE_DIR / filename)

def _strip_formula_index_prefix(raw: str) -> str:
    """Remove leading '0: ' or '13: ' index that ResQ prepends to formula names."""
    raw = raw.strip()
    m = re.match(r"^\d+:\s*", raw)
    return raw[m.end():].strip() if m else raw

def _infer_avg_settings(label: str) -> dict:
    norm = " ".join(label.split()).strip()
    lower = norm.lower()
    if lower.startswith("user"):
        return {"averageType": "user_entry", "base": "simple", "periods": "all", "exclude": 0}
    if "benchmark" in lower:
        return {"averageType": "custom", "base": "benchmark", "periods": "all", "exclude": 0}
    m = re.match(
        r"^(volume|simple)\s*-\s*(all|[1-9]\d*)(\s+ex\s+hi/lo(?:\s*x\s*([1-9]\d*))?)?$",
        norm, re.I,
    )
    if m:
        base = m.group(1).lower()
        p = m.group(2).lower()
        periods: str | int = p if p == "all" else int(p)
        ex = int(m.group(4) or 0)
        if m.group(3) and ex == 0:
            ex = 1
        return {"averageType": "custom", "base": base, "periods": periods, "exclude": ex}
    return {"averageType": "custom", "base": "simple", "periods": "all", "exclude": 0}

def _ratio_label_endpoints(label: str) -> tuple[int | None, int | None]:
    text = re.sub(r"^\(?\s*\d+\s*\)?\s*", "", label).strip()
    m = re.match(r"^(\d+)\s*[-–]\s*(\d+)$", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None

def _build_data_dev_labels(ratio_dev_labels: list[str]) -> list[str]:
    """
    Derive cumulative-age labels ('2m', '5m', …) for the data tab from
    the period-to-period ratio labels ('(1) 2-5', '(2) 5-8', …, '119 - Ult').
    """
    ages: list[int] = []
    for label in ratio_dev_labels:
        if "ult" in label.lower():
            break
        start, end = _ratio_label_endpoints(label)
        if start is not None and not ages:
            ages.append(start)
        if end is not None:
            ages.append(end)
    return [f"{a}m" for a in ages]

def _parse_cell_notes(raw: str, origin_labels: list[str], avg_labels: list[str]) -> dict:
    """
    Parse ResQ CellNotes text into the JSON cell-notes dict.

    ResQ format per line:
        "Ratios.Ratios & Average Selection", Cell[<dev>, <row>], "<note>", User: ..., Date: ...

    If <row> matches an origin label → ratio main table.
    If <row> matches an average formula label → ratio summary table.
    """
    result: dict = {"ratio main table": {}, "ratio summary table": {}}
    if not raw:
        return result

    origin_lower = {l.strip().lower() for l in origin_labels}
    avg_lower = {l.strip().lower() for l in avg_labels}

    pattern = re.compile(r'"[^"]+",\s*Cell\[([^\]]+)\],\s*"([^"]*)"')
    for m in pattern.finditer(raw):
        cell_ref = m.group(1)
        note_text = m.group(2)
        parts = [p.strip() for p in cell_ref.split(",", 1)]
        if len(parts) != 2:
            continue
        dev_part, row_part = parts
        row_lower = row_part.lower()
        if row_lower in origin_lower or any(row_lower in ol for ol in origin_lower):
            table = "ratio main table"
        elif row_lower in avg_lower or any(row_lower in al for al in avg_lower):
            table = "ratio summary table"
        else:
            table = "ratio summary table"  # default
        result[table].setdefault(dev_part, {})[row_part] = note_text

    return result

def _get_ratio_value(dfm, i: int, j: int) -> float | None:
    try:
        v = dfm.Ratios(OriginIndex=i, DevIndex=j)
        return float(v) if v is not None else None
    except Exception:
        return None

def export_dfm(
    dfm,
    rc_path: str,
    project_data_dir: Path,
    *,
    max_average_formula_probe: int = MAX_AVERAGE_FORMULA_PROBE,
) -> dict:
    """Extract all DFM data from a ResQ DFM COM object and return a JSON-ready dict."""
    name = _normalize_import_name(dfm.Name)
    input_tri_name = _normalize_import_name(dfm.InputTriangle.Name)
    output_vec_name = _normalize_import_name(dfm.OutputVector.Name)
    output_dataset_type_obj = _safe_attr(dfm.OutputVector, "DatasetType", None)
    output_dataset_type = _normalize_import_name(_safe_attr(output_dataset_type_obj, "Name", "")) or output_vec_name
    output_category = _normalize_import_name(_safe_attr(_safe_attr(output_dataset_type_obj, "Category", None), "Name", ""))
    origin_length: int = dfm.OriginLength
    dev_length: int = dfm.DevelopmentLength
    decimal_places: int = dfm.RatioDecimalPlaces

    try:
        ultimate_dp: int = dfm.SummaryRatioDecimalPlaces
    except Exception:
        ultimate_dp = 2

    try:
        ratio_basis = _normalize_import_name(dfm.SummaryRatioBasis.Name)
    except Exception:
        ratio_basis = ""

    try:
        modified = dfm.OutputVector.Modified
        last_modified = _iso_or_text(modified)
    except Exception:
        last_modified = datetime.now(timezone.utc).astimezone().isoformat()

    origin_count: int = dfm.OriginCount
    dev_count: int = dfm.DevelopmentCount(1) if origin_count > 0 else 0
    org_rng = range(1, origin_count + 1)
    dev_rng = range(1, dev_count + 1)

    origin_labels = [_normalize_import_name(dfm.OriginLabel(i)) for i in org_rng]
    ratio_dev_labels = [_normalize_import_name(dfm.DevelopmentLabel(j)) for j in dev_rng]
    data_dev_labels = _build_data_dev_labels(ratio_dev_labels)

    # Ratio triangle values (staircase shape)
    ratio_values: list[list] = []
    excluded: list[list] = []
    for i in org_rng:
        row_dev = dfm.DevelopmentCount(i)
        rv_row: list = []
        ex_row: list = []
        for j in range(1, row_dev + 1):
            val = _get_ratio_value(dfm, i, j)
            rv_row.append(round(val, decimal_places) if val is not None else 0)
            try:
                ex_row.append(int(dfm.ExcludedRatios(i, j)))
            except Exception:
                ex_row.append(0)
        ratio_values.append(rv_row)
        excluded.append(ex_row)

    # Enumerate average formula names from ResQ (1-based, strip index prefix)
    raw_names: list[str] = []
    for idx in range(1, max_average_formula_probe + 1):
        try:
            f = dfm.AverageFormula(idx)
            if f is None:
                break
            raw_names.append(f)
        except Exception:
            break

    # Deduplicate: keep only the first User Entry; record its ResQ index
    formula_labels: list[str] = []
    resq_idx_map: list[int] = []   # formula_labels[k] came from ResQ formula index resq_idx_map[k]+1
    user_entry_seen = False
    for list_idx, raw in enumerate(raw_names):
        cleaned = _strip_formula_index_prefix(raw)
        is_user = cleaned.lower().startswith("user")
        if is_user:
            if not user_entry_seen:
                user_entry_seen = True
                formula_labels.append("User Entry")
                resq_idx_map.append(list_idx)
        else:
            formula_labels.append(cleaned)
            resq_idx_map.append(list_idx)

    n_formulas = len(formula_labels)

    # selected[formula_row][dev_col] = 1 when that formula is selected
    selected = [[0] * dev_count for _ in range(n_formulas)]
    for j in dev_rng:
        try:
            sel = int(dfm.SelectedRatios(DevIndex=j))  # 1-based ResQ formula index
        except Exception:
            continue
        # sel is 1-based index into raw_names; find in resq_idx_map
        raw_idx_0 = sel - 1  # 0-based into raw_names
        for k, mapped_raw_idx in enumerate(resq_idx_map):
            if mapped_raw_idx == raw_idx_0:
                selected[k][j - 1] = 1
                break

    # values[formula_row][dev_col] = computed average LDF
    values: list[list] = []
    for k, raw_idx_0 in enumerate(resq_idx_map):
        resq_formula_idx = raw_idx_0 + 1  # back to 1-based
        row: list = []
        for j in dev_rng:
            try:
                v = dfm.AverageRatioValues(j, resq_formula_idx)
                row.append(round(float(v), decimal_places) if v is not None else None)
            except Exception:
                row.append(None)
        # trim trailing None
        while row and row[-1] is None:
            row.pop()
        values.append(row)

    # Custom average formula settings
    avg_settings: dict = {"averageType": [], "base": [], "periods": [], "exclude": []}
    for label in formula_labels:
        s = _infer_avg_settings(label)
        avg_settings["averageType"].append(s["averageType"])
        avg_settings["base"].append(s["base"])
        avg_settings["periods"].append(s["periods"])
        avg_settings["exclude"].append(s["exclude"])

    # Notes
    try:
        notes_text: str = dfm.Notes or ""
    except Exception:
        notes_text = ""

    # Cell notes
    try:
        cell_notes_raw: str = dfm.CellNotes or ""
    except Exception:
        cell_notes_raw = ""
    cell_notes = _parse_cell_notes(cell_notes_raw, origin_labels, formula_labels)

    # CSV paths
    rc_folder = _encode_rc_folder(rc_path)
    input_csv = _csv_abs_path(
        project_data_dir,
        rc_folder,
        input_tri_name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )
    output_csv = _csv_abs_path(
        project_data_dir,
        rc_folder,
        output_vec_name,
        origin_length,
        dev_length,
        cumulative=DEFAULT_CUMULATIVE,
        calendar=DEFAULT_CALENDAR,
    )

    return {
        "json format": DFM_JSON_FORMAT,
        "details tab": {
            "name": name,
            "output type": output_dataset_type,
            "output dataset": output_vec_name,
            "output dataset_category": output_category,
            "output category": output_category,
            "input triangle": input_tri_name,
            "origin length": origin_length,
            "development length": dev_length,
            "decimal places": decimal_places,
        },
        "data tab": {
            "origin labels": origin_labels,
            "development labels": data_dev_labels,
            "input data triangle csv path": input_csv,
        },
        "ratios tab": {
            "ratio triangle": {
                "origin labels": origin_labels,
                "development labels": ratio_dev_labels,
                "ratio values": ratio_values,
                "excluded": excluded,
            },
            "average formulas": {
                "label": formula_labels,
                "custom average formula settings": avg_settings,
                "selected": selected,
                "values": values,
            },
            "cell notes": cell_notes,
        },
        "results tab": {
            "ratio basis dataset": ratio_basis,
            "ultimate ratio decimal places": ultimate_dp,
            "ultimate vector csv path": output_csv,
        },
        "notes tab": {
            "notes": notes_text,
        },
        "method metadata": {
            "last modified": last_modified,
        },
    }


def dfm_methods_by_output_name(reserving_class, dfm_names: list[str] | None = None) -> dict[str, tuple[str, object]]:
    try:
        dfm_collection = reserving_class.DFMMethods()
    except Exception:
        return {}
    names = [
        str(name or "").strip()
        for name in dfm_names
        if str(name or "").strip()
    ] if dfm_names is not None else [
        _clean_name(_safe_attr(item, "Name", ""))
        for item in dfm_collection
        if _clean_name(_safe_attr(item, "Name", ""))
    ]
    out: dict[str, tuple[str, object]] = {}
    for dfm_name in names:
        clean_name = _clean_name(dfm_name)
        if not clean_name:
            continue
        try:
            dfm = dfm_collection.Item(clean_name)
        except Exception:
            continue
        output_vector = _safe_attr(dfm, "OutputVector", None)
        output_name = _normalize_import_name(_safe_attr(output_vector, "Name", ""))
        key = output_name.lower()
        if key and key not in out:
            out[key] = (clean_name, dfm)
    return out


def warn_if_dfm_input_sidecar_missing(
    payload: dict,
    *,
    debug_log,
    log,
    verbose: bool = True,
) -> None:
    details = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    data_tab = payload.get("data tab") if isinstance(payload.get("data tab"), dict) else {}
    input_path = _clean_name(data_tab.get("input data triangle csv path"))
    if not input_path:
        debug_log("dfm_input_sidecar_check", method_name=_clean_name(details.get("name")), input_path="", skipped=True)
        return
    path = Path(input_path)
    sidecar_path = _dataset_sidecar_path_for_cached_csv(path)
    debug_log(
        "dfm_input_sidecar_check",
        method_name=_clean_name(details.get("name")),
        input_triangle=_clean_name(details.get("input triangle")),
        origin_length=details.get("origin length"),
        development_length=details.get("development length"),
        input_csv_path=str(path),
        input_csv_exists=path.is_file(),
        sidecar_path=str(sidecar_path),
        sidecar_exists=sidecar_path.is_file(),
    )
    if sidecar_path.is_file():
        return
    log(
        verbose,
        "    WARN missing DFM input sidecar "
        f"{sidecar_path.name} for {_clean_name(details.get('name')) or 'DFM method'}; "
        "export the input triangle before opening the DFM in ArcRho."
    )


def export_dfm_output_dataset(
    dfm,
    rc_path: str,
    rc_dir: Path,
    *,
    project_name: str,
    project_data_dir: Path,
    method_data_dir: str,
    debug_log,
    log,
    known_dataset_type_keys: set[str] | None = None,
    max_average_formula_probe: int = MAX_AVERAGE_FORMULA_PROBE,
    verbose: bool = True,
) -> tuple[str, str, bool]:
    dfm_name = _normalize_import_name(_safe_attr(dfm, "Name", ""))
    output_vector = _safe_attr(dfm, "OutputVector", None)
    output_dataset_name = _normalize_import_name(_safe_attr(output_vector, "Name", "")) or dfm_name
    dataset_type_obj = _safe_attr(output_vector, "DatasetType", None)
    output_dataset_type = _normalize_import_name(_safe_attr(dataset_type_obj, "Name", "")) or output_dataset_name
    if not _is_known_dataset_type(output_dataset_type, known_dataset_type_keys):
        detail = _unknown_dataset_type_skip_detail("DFM", output_dataset_name, output_dataset_type)
        log(verbose, detail)
        return output_dataset_name, detail, True
    file_name = f"DFM@{_encode_name_part(dfm_name)}.json"
    out_path = rc_dir / method_data_dir / file_name
    payload = export_dfm(
        dfm,
        rc_path,
        project_data_dir,
        max_average_formula_probe=max_average_formula_probe,
    )
    details_tab = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
    output_dataset_name = _normalize_import_name(details_tab.get("output dataset")) or output_dataset_name
    debug_log(
        "dfm_export_payload",
        project_name=project_name,
        reserving_class=rc_path,
        method_name=payload.get("details tab", {}).get("name") if isinstance(payload.get("details tab"), dict) else dfm_name,
        input_triangle=payload.get("details tab", {}).get("input triangle") if isinstance(payload.get("details tab"), dict) else "",
        origin_length=payload.get("details tab", {}).get("origin length") if isinstance(payload.get("details tab"), dict) else "",
        development_length=payload.get("details tab", {}).get("development length") if isinstance(payload.get("details tab"), dict) else "",
        input_csv_path=payload.get("data tab", {}).get("input data triangle csv path") if isinstance(payload.get("data tab"), dict) else "",
    )
    warn_if_dfm_input_sidecar_missing(payload, debug_log=debug_log, log=log, verbose=verbose)
    ultimate_payload = export_dfm_ultimate_vector(
        dfm,
        payload["data tab"]["origin labels"],
        payload["details tab"]["origin length"],
        payload["details tab"]["development length"],
    )
    if not _is_known_dataset_type(ultimate_payload.get("dataset_type"), known_dataset_type_keys):
        detail = _unknown_dataset_type_skip_detail("DFM", output_dataset_name, ultimate_payload.get("dataset_type"))
        log(verbose, detail)
        return output_dataset_name, detail, True
    ultimate_csv_path = write_dfm_ultimate_vector_export(ultimate_payload, rc_path, rc_dir)
    existing_payload = _safe_read_json(out_path)
    payload, preserved = _preserve_local_dfm_data(payload, existing_payload)
    _write_json(out_path, payload)

    suffix = f" (preserved {', '.join(sorted(preserved))})" if preserved else ""
    log(verbose, f"    OK  {_clean_name(ultimate_csv_path.name)}")
    detail = f"    OK  {file_name}{suffix}"
    log(verbose, detail)
    return output_dataset_name, detail, False
