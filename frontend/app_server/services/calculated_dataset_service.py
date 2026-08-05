from __future__ import annotations

import ast
import getpass
import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Set, Tuple

import numpy as np
import pandas as pd

from app_server import config
from app_server.helpers import (
    _canon_dataset_name,
    build_dataset_cache_file_name,
    sanitize_dataset_file_name,
)
from app_server.services import (
    dataset_instance_index_service,
    dataset_number_format_service,
    dataset_sidecar_status_service,
    dataset_types_service,
    runtime_cache_provenance_service,
)

_METHOD_DEPENDENT_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=6,
    thread_name_prefix="arcrho-method-dependent-read",
)


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().lower() in {"true", "1", "yes", "y"}


def _now_utc_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _current_user_name() -> str:
    for value in (os.environ.get("USERNAME"), os.environ.get("USER")):
        text = _clean_text(value)
        if text:
            return text
    try:
        return _clean_text(getpass.getuser()) or "calculated"
    except Exception:
        return "calculated"


def _dataset_type_rows(project_name: str) -> List[Dict[str, Any]]:
    data = dataset_types_service.load_dataset_types_data(
        project_name,
        strict=True,
    )
    rows = []
    for row in data.get("rows") or []:
        if not isinstance(row, list):
            continue
        name = _clean_text(row[0] if len(row) > 0 else "")
        if not name:
            continue
        rows.append({
            "name": name,
            "data_format": _clean_text(row[1] if len(row) > 1 else "Triangle") or "Triangle",
            "category": _clean_text(row[2] if len(row) > 2 else ""),
            "calculated": _bool_value(row[3] if len(row) > 3 else False),
            "formula": _clean_text(row[4] if len(row) > 4 else ""),
            "source": _clean_text(row[5] if len(row) > 5 else ""),
            "generated": _bool_value(row[6] if len(row) > 6 else False),
        })
    return rows


def _dataset_type_name_by_key(project_name: str) -> Dict[str, str]:
    return {
        _canon_dataset_name(row["name"]): row["name"]
        for row in _dataset_type_rows(project_name)
        if _canon_dataset_name(row.get("name"))
    }


def _formula_components(formula: str, known_names: List[str]) -> List[str]:
    text = _clean_text(formula)
    if not text:
        return []

    out: List[str] = []
    seen: Set[str] = set()
    masked_parts = []
    last = 0
    for match in re.finditer(r'"([^"]+)"', text):
        token = _clean_text(match.group(1))
        key = _canon_dataset_name(token)
        if token and key and key not in seen:
            seen.add(key)
            out.append(token)
        masked_parts.append(text[last:match.start()])
        masked_parts.append(" ")
        last = match.end()
    masked_parts.append(text[last:])
    unquoted_text = "".join(masked_parts)

    for name in sorted(
        {str(item or "").strip() for item in known_names if str(item or "").strip()},
        key=len,
        reverse=True,
    ):
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", flags=re.IGNORECASE)
        if pattern.search(unquoted_text):
            seen.add(key)
            out.append(name)
    return out


def _calculated_dataset_contract_from_rows(
    rows: List[Dict[str, Any]],
    dataset_type_name: str,
) -> Dict[str, Any] | None:
    known_names = [row["name"] for row in rows]
    target_key = _canon_dataset_name(dataset_type_name)
    for row in rows:
        if _canon_dataset_name(row["name"]) != target_key:
            continue
        if not row.get("calculated") or row.get("generated") or not _clean_text(row.get("formula")):
            return None
        precedents = _formula_components(row["formula"], known_names)
        rows_by_key = {
            _canon_dataset_name(item.get("name")): dict(item)
            for item in rows
            if _canon_dataset_name(item.get("name"))
        }
        return {
            **row,
            "precedents": precedents,
            "precedent_contracts": {
                _canon_dataset_name(name): rows_by_key.get(
                    _canon_dataset_name(name),
                    {},
                )
                for name in precedents
            },
        }
    return None


def calculated_dataset_contract(
    project_name: str,
    dataset_type_name: str,
) -> Dict[str, Any] | None:
    contract = _calculated_dataset_contract_from_rows(
        _dataset_type_rows(project_name),
        dataset_type_name,
    )
    return dict(contract) if contract else None


def _direct_precedent_names(project_name: str, dataset_type_name: str) -> List[str]:
    contract = calculated_dataset_contract(project_name, dataset_type_name)
    return list(contract.get("precedents") or []) if contract else []


def calculated_dataset_dependency_names(
    project_name: str,
    dataset_type_name: str,
) -> List[str] | None:
    """Return direct inputs for an app-calculated type, or ``None`` otherwise."""
    contract = calculated_dataset_contract(project_name, dataset_type_name)
    return list(contract.get("precedents") or []) if contract else None


def _direct_dependent_names(project_name: str, dataset_type_name: str) -> List[str]:
    rows = _dataset_type_rows(project_name)
    known_names = [row["name"] for row in rows]
    target_key = _canon_dataset_name(dataset_type_name)
    out: List[str] = []
    seen: Set[str] = set()
    if not target_key:
        return out
    for row in rows:
        if not row.get("calculated") or row.get("generated") or not _clean_text(row.get("formula")):
            continue
        components = _formula_components(row["formula"], known_names)
        component_keys = {_canon_dataset_name(component) for component in components}
        if target_key not in component_keys:
            continue
        dep_key = _canon_dataset_name(row["name"])
        if dep_key and dep_key not in seen:
            seen.add(dep_key)
            out.append(row["name"])
    return out


def _name_entries(names: List[str]) -> List[Dict[str, str]]:
    return [{"dataset_type_name": name} for name in names if _clean_text(name)]


def _precedent_entries(
    project_name: str,
    dataset_type_name: str,
    dependency_info: List[Dict[str, Any]] | None = None,
) -> List[Dict[str, Any]]:
    info_by_key = {
        _canon_dataset_name(item.get("dataset_type_name")): item
        for item in (dependency_info or [])
        if _canon_dataset_name(item.get("dataset_type_name"))
    }
    entries: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for name in _direct_precedent_names(project_name, dataset_type_name):
        key = _canon_dataset_name(name)
        if not key or key in seen:
            continue
        seen.add(key)
        item = dict(info_by_key.get(key) or {})
        item["dataset_type_name"] = item.get("dataset_type_name") or name
        entries.append(item)
    return entries


def sidecar_graph_fields(
    project_name: str,
    dataset_type_name: str,
    dependency_info: List[Dict[str, Any]] | None = None,
    reserving_class: str = "",
) -> Dict[str, Any]:
    dependent_names = _direct_dependent_names(project_name, dataset_type_name)
    rc = _clean_text(reserving_class)
    if rc:
        existing_keys = _existing_dataset_keys(project_name, rc)
        dependent_names = [
            name
            for name in dependent_names
            if _canon_dataset_name(name) in existing_keys
        ]
    return {
        "Precedents": _precedent_entries(project_name, dataset_type_name, dependency_info),
        "Dependents": _name_entries(dependent_names),
    }


def apply_sidecar_graph_fields(
    payload: Dict[str, Any],
    project_name: str = "",
    dataset_type_name: str = "",
    dependency_info: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    project = _clean_text(project_name or payload.get("project_name"))
    dataset_type = _clean_text(
        dataset_type_name
        or payload.get("dataset_type")
        or payload.get("dataset_name")
    )
    if not project or not dataset_type:
        payload["Precedents"] = []
        payload["Dependents"] = []
        payload.pop("dependencies", None)
        return payload

    rows_by_key = {
        _canon_dataset_name(row["name"]): row
        for row in _dataset_type_rows(project)
        if _canon_dataset_name(row.get("name"))
    }
    row = rows_by_key.get(_canon_dataset_name(dataset_type))
    if row:
        formula = _clean_text(row.get("formula"))
        is_calculated = bool(row.get("calculated") and not row.get("generated") and formula)
        payload["formula"] = formula if is_calculated else ""
        payload["calculated"] = is_calculated

    existing_dependent_names = dataset_sidecar_status_service.entry_names(payload.get("Dependents"))
    existing_precedents = payload.get("Precedents")
    owning_method_type = dataset_sidecar_status_service.normalize_method_type(
        payload.get("method_type"),
        payload.get("source_kind"),
    )
    graph_fields = sidecar_graph_fields(
        project,
        dataset_type,
        dependency_info,
        _clean_text(payload.get("reserving_class")),
    )
    reserving_class = _clean_text(payload.get("reserving_class"))
    preserved_method_dependents: List[str] = []
    if reserving_class and existing_dependent_names:
        futures = {
            name: _METHOD_DEPENDENT_READ_EXECUTOR.submit(
                dataset_sidecar_status_service.read_sidecar,
                dataset_sidecar_status_service.sidecar_path(project, reserving_class, name),
            )
            for name in existing_dependent_names
        }
        for name in existing_dependent_names:
            dependent = futures[name].result()
            if not dependent or dataset_sidecar_status_service.normalize_method_type(
                dependent.get("method_type"),
                dependent.get("source_kind"),
            ) != dataset_sidecar_status_service.METHOD_TYPE_NONE:
                preserved_method_dependents.append(name)
    graph_fields["Dependents"] = dataset_sidecar_status_service.merge_name_entries(
        graph_fields.get("Dependents"),
        dataset_sidecar_status_service.name_entries(preserved_method_dependents),
    )
    if owning_method_type != dataset_sidecar_status_service.METHOD_TYPE_NONE:
        graph_fields["Precedents"] = existing_precedents if isinstance(existing_precedents, list) else []
    payload.update(graph_fields)
    payload.pop("dependencies", None)
    return payload


def _replace_formula_refs(formula: str, known_names: List[str]) -> Tuple[str, Dict[str, str]]:
    text = _clean_text(formula)
    refs: Dict[str, str] = {}
    by_key = {
        _canon_dataset_name(name): str(name or "").strip()
        for name in known_names
        if _canon_dataset_name(name)
    }

    def new_var(name: str) -> str:
        key = _canon_dataset_name(name)
        if not key:
            return ""
        for var, ref_name in refs.items():
            if _canon_dataset_name(ref_name) == key:
                return var
        var = f"_d{len(refs)}"
        refs[var] = by_key.get(key) or name
        return var

    def quoted_repl(match: re.Match[str]) -> str:
        var = new_var(_clean_text(match.group(1)))
        return var or "0"

    expr = re.sub(r'"([^"]+)"', quoted_repl, text)
    for name in sorted(
        {str(item or "").strip() for item in known_names if str(item or "").strip()},
        key=len,
        reverse=True,
    ):
        key = _canon_dataset_name(name)
        if not key:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", flags=re.IGNORECASE)
        if pattern.search(expr):
            var = new_var(name)
            expr = pattern.sub(var, expr)
    return expr, refs


def _eval_ast(node: ast.AST, values: Dict[str, np.ndarray]) -> np.ndarray | float:
    if isinstance(node, ast.Expression):
        return _eval_ast(node.body, values)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in values:
            raise ValueError(f"Unknown formula variable: {node.id}")
        return values[node.id]
    if isinstance(node, ast.UnaryOp):
        operand = _eval_ast(node.operand, values)
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.UAdd):
            return operand
    if isinstance(node, ast.BinOp):
        left = _eval_ast(node.left, values)
        right = _eval_ast(node.right, values)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
    raise ValueError("Formula contains unsupported syntax.")


def _read_sidecar(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _csv_base_name(path: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    return dataset_instance_index_service._normalize_cached_dataset_name(stem)


def _cached_csv_data_format(path: str, sidecar: Dict[str, Any]) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    parts = stem.split("@")
    if (
        len(parts) >= 5
        and parts[-4].strip().isdigit()
        and parts[-3].strip().isdigit()
        and parts[-2].strip().lower() in {"cum", "inc"}
        and parts[-1].strip().lower() in {"dev", "cal"}
    ):
        return "Triangle"
    if len(parts) >= 2 and parts[-1].strip().isdigit():
        return "Vector"
    return _clean_text(sidecar.get("data_format"))


def _sidecar_for_csv(path: str) -> Dict[str, Any]:
    sidecar_path = dataset_instance_index_service._dataset_sidecar_path_for_cached_csv(path)
    payload = _read_sidecar(sidecar_path)
    payload["_sidecar_path"] = sidecar_path
    return payload


def _json_tab(source: Dict[str, Any], key: str) -> Dict[str, Any]:
    value = source.get(key) if isinstance(source, dict) else None
    return value if isinstance(value, dict) else {}


def _method_output_names(payload: Dict[str, Any], path: str = "") -> Set[str]:
    names: Set[str] = set()
    details = _json_tab(payload, "details tab")
    for key in ("output type", "name"):
        text = _clean_text(details.get(key))
        if text:
            names.add(text)
    stem = os.path.splitext(os.path.basename(path))[0]
    if stem.startswith("DFM@"):
        text = _clean_text(config.decode_filename_segment(stem[len("DFM@"):]))
        if text:
            names.add(text)
    return names


def _candidate_dfm_methods(
    project_name: str,
    reserving_class: str,
    dataset_type_name: str,
) -> List[Dict[str, Any]]:
    folder = config.get_project_method_data_dir(project_name, reserving_class)
    dep_key = _canon_dataset_name(dataset_type_name)
    if not dep_key or not os.path.isdir(folder):
        return []

    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    def add_candidate(path: str) -> None:
        norm = os.path.abspath(path)
        if norm in seen or not os.path.isfile(path):
            return
        seen.add(norm)
        payload = _read_sidecar(path)
        names = _method_output_names(payload, path)
        if dep_key not in {_canon_dataset_name(name) for name in names}:
            return
        details = _json_tab(payload, "details tab")
        output_type = _clean_text(details.get("output type"))
        method_name = _clean_text(details.get("name"))
        score = 0
        if _canon_dataset_name(output_type) == dep_key:
            score += 8
        if _canon_dataset_name(method_name) == dep_key:
            score += 4
        out.append({
            "path": path,
            "payload": payload,
            "score": score,
            "mtime": os.stat(path).st_mtime,
        })

    direct_path = os.path.join(folder, f"DFM@{sanitize_dataset_file_name(dataset_type_name)}.json")
    add_candidate(direct_path)
    for name in os.listdir(folder):
        if not name.startswith("DFM@") or not name.lower().endswith(".json"):
            continue
        add_candidate(os.path.join(folder, name))

    out.sort(key=lambda item: (int(item.get("score") or 0), float(item.get("mtime") or 0)), reverse=True)
    best_score = int(out[0].get("score") or 0) if out else 0
    return [item for item in out if int(item.get("score") or 0) == best_score]


def _path_in_dir(path: str, folder: str) -> bool:
    try:
        child = os.path.normcase(os.path.realpath(os.path.abspath(path)))
        parent = os.path.normcase(os.path.realpath(os.path.abspath(folder)))
        return os.path.commonpath([child, parent]) == parent
    except Exception:
        return False


def _existing_path_in_dir(path: str, folder: str) -> str:
    recorded_path = _clean_text(path)
    if not recorded_path:
        return ""
    candidates = [recorded_path]
    relocated_path = os.path.join(
        folder,
        os.path.basename(recorded_path),
    )
    if os.path.normcase(relocated_path) != os.path.normcase(recorded_path):
        candidates.append(relocated_path)
    for candidate in candidates:
        if _path_in_dir(candidate, folder) and os.path.isfile(candidate):
            return candidate
    return ""


def _finite_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _read_numeric_csv(path: str) -> np.ndarray:
    df = pd.read_csv(path, header=None, dtype="float64", keep_default_na=True)
    return df.to_numpy(dtype="float64")


def _read_dfm_input_triangle(
    project_name: str,
    reserving_class: str,
    payload: Dict[str, Any],
    target_settings: Dict[str, Any],
    exact_input_path: str = "",
) -> Tuple[np.ndarray | None, str, str]:
    data_tab = _json_tab(payload, "data tab")
    details = _json_tab(payload, "details tab")
    dataset_folder = config.get_project_dataset_cache_dir(project_name, reserving_class)
    if exact_input_path:
        if (
            not _path_in_dir(exact_input_path, dataset_folder)
            or not os.path.isfile(exact_input_path)
        ):
            return None, exact_input_path, "Recorded DFM input triangle path is invalid."
        try:
            return _read_numeric_csv(exact_input_path), exact_input_path, ""
        except Exception as exc:
            return None, exact_input_path, str(exc)

    path = _clean_text(data_tab.get("input data triangle csv path"))
    if path and os.path.isfile(path) and _path_in_dir(path, dataset_folder):
        try:
            return _read_numeric_csv(path), path, ""
        except Exception as exc:
            return None, path, str(exc)

    input_name = _clean_text(details.get("input triangle"))
    if not input_name:
        return None, "", "DFM method is missing an input triangle name."
    candidates = _candidate_csvs(project_name, reserving_class, input_name, target_settings)
    if not candidates:
        return None, "", f"Missing DFM input triangle: {input_name}"
    if len(candidates) > 1:
        return None, "", f"Ambiguous DFM input triangle: {input_name}"
    path = str(candidates[0]["path"])
    try:
        return _read_numeric_csv(path), path, ""
    except Exception as exc:
        return None, path, str(exc)


def _selected_dfm_ratio_values(payload: Dict[str, Any], dev_count: int) -> List[float]:
    ratios_tab = _json_tab(payload, "ratios tab")
    formulas = _json_tab(ratios_tab, "average formulas")
    selected = formulas.get("selected") if isinstance(formulas.get("selected"), list) else []
    values = formulas.get("values") if isinstance(formulas.get("values"), list) else []
    ratio_count = max(0, int(dev_count or 0))
    out: List[float] = []
    for col in range(ratio_count):
        if dev_count and col >= dev_count - 1:
            out.append(1.0)
            continue
        selected_row = None
        for row_index, row in enumerate(selected):
            row_values = row if isinstance(row, list) else []
            if col < len(row_values) and _finite_float(row_values[col]) == 1.0:
                selected_row = row_index
                break
        if selected_row is None:
            selected_row = 0
        source_row = values[selected_row] if selected_row < len(values) and isinstance(values[selected_row], list) else []
        ratio = _finite_float(source_row[col] if col < len(source_row) else None)
        out.append(ratio if ratio is not None else 1.0)
    return out


def _cumulative_factors(ratio_values: List[float]) -> List[float | None]:
    cumulative: List[float | None] = [None] * len(ratio_values)
    running: float | None = None
    for index in range(len(ratio_values) - 1, -1, -1):
        value = ratio_values[index]
        if not np.isfinite(value):
            cumulative[index] = None
            running = None
            continue
        if index == len(ratio_values) - 1:
            running = value
        elif running is not None and np.isfinite(running):
            running = value * running
        else:
            cumulative[index] = None
            running = None
            continue
        cumulative[index] = running
    return cumulative


def _build_dfm_method_vector(
    project_name: str,
    reserving_class: str,
    payload: Dict[str, Any],
    target_settings: Dict[str, Any],
    exact_input_path: str = "",
) -> Tuple[np.ndarray | None, str, str]:
    data_tab = _json_tab(payload, "data tab")
    input_values, input_path, error = _read_dfm_input_triangle(
        project_name,
        reserving_class,
        payload,
        target_settings,
        exact_input_path=exact_input_path,
    )
    if error:
        return None, input_path, error
    if input_values is None or input_values.ndim != 2:
        return None, input_path, "DFM input triangle could not be loaded."

    dev_labels = data_tab.get("development labels") if isinstance(data_tab.get("development labels"), list) else []
    origin_labels = data_tab.get("origin labels") if isinstance(data_tab.get("origin labels"), list) else []
    dev_count = len(dev_labels) or input_values.shape[1]
    if dev_count <= 0:
        return None, input_path, "DFM method is missing development periods."

    cumulative = _cumulative_factors(_selected_dfm_ratio_values(payload, dev_count))
    row_count = len(origin_labels) or input_values.shape[0]
    out: List[float] = []
    for row_index in range(row_count):
        latest_value = None
        latest_col = None
        if row_index < input_values.shape[0]:
            max_col = min(dev_count - 1, input_values.shape[1] - 1)
            for col in range(max_col, -1, -1):
                value = _finite_float(input_values[row_index, col])
                if value is not None:
                    latest_value = value
                    latest_col = col
                    break
        factor = cumulative[latest_col] if latest_col is not None and latest_col < len(cumulative) else None
        out.append(latest_value * factor if latest_value is not None and factor is not None else np.nan)
    return np.asarray(out, dtype="float64").reshape((-1, 1)), input_path, ""


def _candidate_csvs(
    project_name: str,
    reserving_class: str,
    dataset_type_name: str,
    target_settings: Dict[str, Any],
    expected_data_format: str = "",
) -> List[Dict[str, Any]]:
    folder = config.get_project_dataset_cache_dir(project_name, reserving_class)
    dep_key = _canon_dataset_name(dataset_type_name)
    out: List[Dict[str, Any]] = []
    if not os.path.isdir(folder):
        return []
    for name in os.listdir(folder):
        if not name.lower().endswith(".csv"):
            continue
        path = os.path.join(folder, name)
        sidecar = _sidecar_for_csv(path)
        candidate_data_format = _cached_csv_data_format(path, sidecar)
        if (
            _clean_text(expected_data_format)
            and candidate_data_format
            and candidate_data_format.lower() != _clean_text(expected_data_format).lower()
        ):
            continue
        dataset_name = _clean_text(sidecar.get("dataset_name") or _csv_base_name(path))
        type_name = _clean_text(sidecar.get("dataset_type") or _csv_base_name(path))
        if dep_key not in {_canon_dataset_name(dataset_name), _canon_dataset_name(type_name), _canon_dataset_name(_csv_base_name(path))}:
            continue
        score = 0
        if _canon_dataset_name(type_name) == dep_key:
            score += 8
        if _canon_dataset_name(dataset_name) == dep_key:
            score += 4
        for key in ("origin_length", "development_length"):
            if str(sidecar.get(key) or "").strip() and str(sidecar.get(key)) == str(target_settings.get(key)):
                score += 1
        for key in ("cumulative", "calendar"):
            if key in sidecar and bool(sidecar.get(key)) == bool(target_settings.get(key)):
                score += 1
        out.append({
            "path": path,
            "sidecar": sidecar,
            "data_format": candidate_data_format,
            "score": score,
            "mtime": os.stat(path).st_mtime,
        })
    out.sort(key=lambda item: (int(item.get("score") or 0), float(item.get("mtime") or 0)), reverse=True)
    best_score = int(out[0].get("score") or 0) if out else 0
    return [item for item in out if int(item.get("score") or 0) == best_score]


def _target_paths(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    settings: Dict[str, Any],
    data_format: Any = "",
) -> Tuple[str, str]:
    folder = config.get_project_dataset_cache_dir(project_name, reserving_class)
    csv_name = build_dataset_cache_file_name(
        dataset_name,
        data_format or "Triangle",
        settings.get("origin_length") or 12,
        settings.get("development_length") or 12,
        settings.get("cumulative", True),
        settings.get("calendar", False),
    )
    csv_path = os.path.join(folder, f"{csv_name}.csv")
    sidecar_path = os.path.join(
        config.get_project_dataset_sidecar_dir(project_name, reserving_class),
        f"{sanitize_dataset_file_name(dataset_name)}.json",
    )
    return csv_path, sidecar_path


def _existing_target_settings(project_name: str, reserving_class: str, dataset_name: str) -> Dict[str, Any]:
    sidecar_path = os.path.join(
        config.get_project_dataset_sidecar_dir(project_name, reserving_class),
        f"{sanitize_dataset_file_name(dataset_name)}.json",
    )
    payload = _read_sidecar(sidecar_path)
    return {
        "origin_length": int(payload.get("origin_length") or 12),
        "development_length": int(payload.get("development_length") or 12),
        "cumulative": bool(payload.get("cumulative", True)),
        "calendar": bool(payload.get("calendar", False)),
        "created": _clean_text(payload.get("created")),
    }


def _load_components(
    project_name: str,
    reserving_class: str,
    components: List[str],
    target_settings: Dict[str, Any],
    component_overrides: Dict[str, np.ndarray] | None = None,
    component_paths: Dict[str, str] | None = None,
    component_formats: Dict[str, str] | None = None,
    component_method_sources: Dict[str, Dict[str, str]] | None = None,
) -> Tuple[Dict[str, np.ndarray], List[Dict[str, Any]], List[str]]:
    values: Dict[str, np.ndarray] = {}
    dependency_info: List[Dict[str, Any]] = []
    errors: List[str] = []
    overrides = component_overrides or {}
    exact_paths = component_paths or {}
    expected_formats = component_formats or {}
    exact_method_sources = component_method_sources or {}
    for index, component in enumerate(components):
        component_key = _canon_dataset_name(component)
        expected_format = _clean_text(expected_formats.get(component_key))
        override = overrides.get(_canon_dataset_name(component))
        if override is not None:
            arr = np.asarray(override, dtype="float64")
            if arr.ndim == 1:
                arr = arr.reshape((-1, 1))
            if arr.ndim != 2:
                errors.append(f"Unsupported live preview shape for dependency: {component}")
                continue
            values[f"_d{index}"] = arr
            dependency_info.append({
                "dataset_type_name": component,
                "path": "",
                "source_kind": "live_preview",
            })
            continue
        exact_method_source = exact_method_sources.get(component_key)
        exact_method = (
            exact_method_source
            if isinstance(exact_method_source, dict)
            else {}
        )
        exact_method_path = _clean_text(exact_method.get("path"))
        exact_method_input_path = _clean_text(exact_method.get("input_path"))
        validated_method_input_path = ""
        exact_path = _clean_text(exact_paths.get(component_key))
        candidates: List[Dict[str, Any]]
        method_candidates: List[Dict[str, Any]] | None = None
        if exact_method_path:
            method_folder = config.get_project_method_data_dir(
                project_name,
                reserving_class,
            )
            dataset_folder = config.get_project_dataset_cache_dir(
                project_name,
                reserving_class,
            )
            resolved_method_path = _existing_path_in_dir(
                exact_method_path,
                method_folder,
            )
            method_payload = (
                _read_sidecar(resolved_method_path)
                if resolved_method_path
                else {}
            )
            method_output_matches = component_key in {
                _canon_dataset_name(name)
                for name in _method_output_names(
                    method_payload,
                    resolved_method_path,
                )
            }
            if resolved_method_path and method_output_matches:
                if exact_method_input_path:
                    data_tab = _json_tab(method_payload, "data tab")
                    details = _json_tab(method_payload, "details tab")
                    current_input_path = _clean_text(
                        data_tab.get("input data triangle csv path")
                    )
                    resolved_recorded_input = _existing_path_in_dir(
                        exact_method_input_path,
                        dataset_folder,
                    )
                    resolved_current_input = _existing_path_in_dir(
                        current_input_path,
                        dataset_folder,
                    )
                    if (
                        resolved_recorded_input
                        and resolved_current_input
                        and os.path.normcase(os.path.realpath(resolved_recorded_input))
                        == os.path.normcase(os.path.realpath(resolved_current_input))
                    ):
                        validated_method_input_path = resolved_current_input
                    elif resolved_recorded_input and not current_input_path:
                        input_name = _clean_text(details.get("input triangle"))
                        input_sidecar = _sidecar_for_csv(resolved_recorded_input)
                        exact_input_names = {
                            _canon_dataset_name(input_sidecar.get("dataset_name")),
                            _canon_dataset_name(input_sidecar.get("dataset_type")),
                            _canon_dataset_name(
                                _csv_base_name(resolved_recorded_input)
                            ),
                        }
                        if _canon_dataset_name(input_name) in exact_input_names:
                            validated_method_input_path = resolved_recorded_input
                method_candidates = [{
                    "path": resolved_method_path,
                    "payload": method_payload,
                    "score": 1,
                    "mtime": os.stat(resolved_method_path).st_mtime,
                }]
                candidates = []
            else:
                candidates = _candidate_csvs(
                    project_name,
                    reserving_class,
                    component,
                    target_settings,
                    expected_data_format=expected_format,
                )
        elif exact_path:
            sidecar = _sidecar_for_csv(exact_path)
            exact_data_format = _cached_csv_data_format(exact_path, sidecar)
            exact_names = {
                _canon_dataset_name(sidecar.get("dataset_name")),
                _canon_dataset_name(sidecar.get("dataset_type")),
                _canon_dataset_name(_csv_base_name(exact_path)),
            }
            if (
                not os.path.isfile(exact_path)
                or component_key not in exact_names
                or (
                    expected_format
                    and exact_data_format
                    and exact_data_format.lower() != expected_format.lower()
                )
            ):
                errors.append(f"Invalid exact dependency path: {component}")
                continue
            candidates = [{
                "path": exact_path,
                "sidecar": sidecar,
                "data_format": exact_data_format,
                "score": 1,
                "mtime": os.stat(exact_path).st_mtime,
            }]
        else:
            candidates = _candidate_csvs(
                project_name,
                reserving_class,
                component,
                target_settings,
                expected_data_format=expected_format,
            )
        if not candidates:
            if method_candidates is None:
                method_candidates = _candidate_dfm_methods(
                    project_name,
                    reserving_class,
                    component,
                )
            if not method_candidates:
                errors.append(f"Missing dependency: {component}")
                continue
            if len(method_candidates) > 1:
                errors.append(f"Ambiguous DFM dependency: {component}")
                continue
            method_item = method_candidates[0]
            method_path = str(method_item["path"])
            arr, input_path, error = _build_dfm_method_vector(
                project_name,
                reserving_class,
                method_item.get("payload") if isinstance(method_item.get("payload"), dict) else {},
                target_settings,
                exact_input_path=validated_method_input_path,
            )
            if error or arr is None:
                errors.append(f"Failed to rebuild DFM dependency {component}: {error or 'unknown error'}")
                continue
            var = f"_d{index}"
            values[var] = arr
            fingerprint = runtime_cache_provenance_service.file_fingerprint(method_path)
            dependency_entry = {
                "dataset_type_name": component,
                "path": method_path,
                "source_kind": "dfm_method",
                "input_path": input_path,
                "mtime": fingerprint["mtime_ns"] / 1_000_000_000,
                **fingerprint,
            }
            if input_path:
                input_fingerprint = runtime_cache_provenance_service.file_fingerprint(
                    input_path
                )
                dependency_entry["input_mtime_ns"] = input_fingerprint["mtime_ns"]
                dependency_entry["input_size"] = input_fingerprint["size"]
                dependency_entry["input_sha256"] = input_fingerprint["sha256"]
            dependency_info.append(dependency_entry)
            continue
        if len(candidates) > 1:
            errors.append(f"Ambiguous dependency: {component}")
            continue
        item = candidates[0]
        path = str(item["path"])
        try:
            df = pd.read_csv(path, header=None, dtype="float64", keep_default_na=True)
        except Exception as exc:
            errors.append(f"Failed to read dependency {component}: {exc}")
            continue
        var = f"_d{index}"
        values[var] = df.to_numpy(dtype="float64")
        fingerprint = runtime_cache_provenance_service.file_fingerprint(path)
        sidecar = item.get("sidecar") if isinstance(item.get("sidecar"), dict) else {}
        dependency_info.append({
            "dataset_type_name": component,
            "dataset_name": _clean_text(sidecar.get("dataset_name") or component),
            "path": path,
            "source_kind": _clean_text(sidecar.get("source_kind")),
            "data_format": _clean_text(sidecar.get("data_format")),
            "origin_length": sidecar.get("origin_length"),
            "development_length": sidecar.get("development_length"),
            "period_length": sidecar.get("period_length"),
            "cumulative": sidecar.get("cumulative"),
            "calendar": sidecar.get("calendar"),
            "mtime": fingerprint["mtime_ns"] / 1_000_000_000,
            **fingerprint,
        })
    return values, dependency_info, errors


def _array_from_preview_values(
    values: List[List[Any]] | None,
    mask: List[List[bool]] | None = None,
) -> np.ndarray:
    rows = values if isinstance(values, list) else []
    out: List[List[float]] = []
    for r, row in enumerate(rows):
        source_row = row if isinstance(row, list) else []
        mask_row = mask[r] if isinstance(mask, list) and r < len(mask) and isinstance(mask[r], list) else None
        converted: List[float] = []
        for c, value in enumerate(source_row):
            if mask_row is not None and c < len(mask_row) and not bool(mask_row[c]):
                converted.append(np.nan)
                continue
            number = _finite_float(value)
            converted.append(number if number is not None else np.nan)
        out.append(converted)
    return np.asarray(out, dtype="float64")


def _jsonable_matrix(arr: np.ndarray) -> List[List[float | None]]:
    matrix = np.asarray(arr, dtype="float64")
    if matrix.ndim == 1:
        matrix = matrix.reshape((-1, 1))
    return [
        [float(value) if np.isfinite(value) else None for value in row]
        for row in matrix.tolist()
    ]


def _matrix_mask(arr: np.ndarray) -> List[List[bool]]:
    matrix = np.asarray(arr, dtype="float64")
    if matrix.ndim == 1:
        matrix = matrix.reshape((-1, 1))
    return [
        [bool(np.isfinite(value)) for value in row]
        for row in matrix.tolist()
    ]


def _latest_diagonal_or_vector_values(arr: np.ndarray, data_format: str) -> List[float | None]:
    matrix = np.asarray(arr, dtype="float64")
    if matrix.ndim == 1:
        matrix = matrix.reshape((-1, 1))
    if _clean_text(data_format).lower() == "vector":
        return [
            float(row[0]) if len(row) and np.isfinite(row[0]) else None
            for row in matrix
        ]
    out: List[float | None] = []
    for row in matrix:
        picked: float | None = None
        for value in reversed(row):
            if np.isfinite(value):
                picked = float(value)
                break
        out.append(picked)
    return out


def _calculated_rows_by_key(project_name: str) -> Dict[str, Dict[str, Any]]:
    return {
        _canon_dataset_name(row["name"]): row
        for row in _dataset_type_rows(project_name)
        if row.get("calculated") and not row.get("generated") and _clean_text(row.get("formula"))
    }


def _dependency_map(project_name: str, rows: List[Dict[str, Any]] | None = None) -> Dict[str, Set[str]]:
    rows = rows if rows is not None else _dataset_type_rows(project_name)
    known_names = [row["name"] for row in rows]
    out: Dict[str, Set[str]] = {}
    for row in rows:
        if not row.get("calculated") or row.get("generated") or not _clean_text(row.get("formula")):
            continue
        target_key = _canon_dataset_name(row["name"])
        for component in _formula_components(row["formula"], known_names):
            comp_key = _canon_dataset_name(component)
            if comp_key:
                out.setdefault(comp_key, set()).add(target_key)
    return out


def _target_dependency_map(project_name: str, rows: List[Dict[str, Any]] | None = None) -> Dict[str, Set[str]]:
    rows = rows if rows is not None else _dataset_type_rows(project_name)
    known_names = [row["name"] for row in rows]
    out: Dict[str, Set[str]] = {}
    for row in rows:
        if not row.get("calculated") or row.get("generated") or not _clean_text(row.get("formula")):
            continue
        target_key = _canon_dataset_name(row["name"])
        deps = {
            _canon_dataset_name(component)
            for component in _formula_components(row["formula"], known_names)
            if _canon_dataset_name(component)
        }
        out[target_key] = deps
    return out


def _existing_dataset_keys(project_name: str, reserving_class: str) -> Set[str]:
    index = dataset_instance_index_service.get_index(project_name, reserving_class, refresh=False)
    keys: Set[str] = set()
    for item in index.get("files", []) if isinstance(index.get("files"), list) else []:
        for value in [item.get("name"), item.get("dataset_type")]:
            key = _canon_dataset_name(value)
            if key:
                keys.add(key)
    return keys


def _downstream_keys(
    project_name: str,
    changed_names: List[str],
    rows: List[Dict[str, Any]] | None = None,
) -> List[str]:
    dep_map = _dependency_map(project_name, rows)
    seen: Set[str] = set()
    out: List[str] = []
    queue = [_canon_dataset_name(name) for name in changed_names if _canon_dataset_name(name)]
    while queue:
        key = queue.pop(0)
        for target in sorted(dep_map.get(key, set())):
            if target in seen:
                continue
            seen.add(target)
            out.append(target)
            queue.append(target)

    target_set = set(out)
    deps_by_target = _target_dependency_map(project_name, rows)
    ordered: List[str] = []
    visiting: Set[str] = set()
    visited: Set[str] = set()

    def visit(key: str) -> None:
        if key in visited:
            return
        if key in visiting:
            return
        visiting.add(key)
        for dep in sorted(deps_by_target.get(key, set())):
            if dep in target_set:
                visit(dep)
        visiting.remove(key)
        visited.add(key)
        ordered.append(key)

    for key in out:
        visit(key)
    return ordered


def _existing_downstream_keys(
    project_name: str,
    reserving_class: str,
    changed_names: List[str],
    rows: List[Dict[str, Any]] | None = None,
) -> List[str]:
    existing_keys = _existing_dataset_keys(project_name, reserving_class)
    if not existing_keys:
        return []
    return [
        key
        for key in _downstream_keys(project_name, changed_names, rows)
        if key in existing_keys
    ]


def _recalculate_dataset_impl(
    project_name: str,
    reserving_class: str,
    dataset_type_name: str,
    *,
    component_paths: Dict[str, str] | None = None,
    component_method_sources: Dict[str, Dict[str, str]] | None = None,
    dataset_type_rows: List[Dict[str, Any]] | None = None,
    mark_dependents_review: bool = True,
) -> Dict[str, Any]:
    if dataset_type_rows is None:
        rows_by_key = _calculated_rows_by_key(project_name)
        all_rows = _dataset_type_rows(project_name)
    else:
        all_rows = dataset_type_rows
        rows_by_key = {
            _canon_dataset_name(item.get("name")): item
            for item in all_rows
            if item.get("calculated") and not item.get("generated") and _clean_text(item.get("formula"))
        }
    row = rows_by_key.get(_canon_dataset_name(dataset_type_name))
    if not row:
        return {"ok": False, "dataset_type_name": dataset_type_name, "skipped": True, "reason": "not_calculated"}

    known_names = [item["name"] for item in all_rows]
    expr, refs = _replace_formula_refs(row["formula"], known_names)
    ordered_components = [refs[key] for key in sorted(refs.keys(), key=lambda item: int(item[2:]))]

    settings = _existing_target_settings(project_name, reserving_class, row["name"])
    values, precedents, errors = _load_components(
        project_name,
        reserving_class,
        ordered_components,
        settings,
        component_paths=component_paths,
        component_method_sources=component_method_sources,
        component_formats={
            _canon_dataset_name(item.get("name")): _clean_text(item.get("data_format"))
            for item in all_rows
            if _canon_dataset_name(item.get("name"))
        },
    )
    if errors:
        missing_prefix = "Missing dependency: "
        return {
            "ok": False,
            "dataset_type_name": row["name"],
            "skipped": True,
            "reason": "dependency_error",
            "errors": errors,
            "missing_dependencies": [
                error[len(missing_prefix):]
                for error in errors
                if error.startswith(missing_prefix)
            ],
        }

    eval_values: Dict[str, np.ndarray] = {}
    for var, ref_name in refs.items():
        try:
            idx = ordered_components.index(ref_name)
        except ValueError:
            return {"ok": False, "dataset_type_name": row["name"], "skipped": True, "reason": f"missing_reference:{ref_name}"}
        eval_values[var] = values[f"_d{idx}"]

    try:
        parsed = ast.parse(expr, mode="eval")
        with np.errstate(divide="ignore", invalid="ignore"):
            result = _eval_ast(parsed, eval_values)
    except Exception as exc:
        return {
            "ok": False,
            "dataset_type_name": row["name"],
            "skipped": True,
            "reason": "formula_error",
            "errors": [str(exc)],
        }

    arr = np.asarray(result, dtype="float64")
    if arr.ndim == 0:
        first = next(iter(eval_values.values()), np.zeros((1, 1), dtype="float64"))
        arr = np.full(first.shape, float(arr), dtype="float64")
    if arr.ndim == 1:
        arr = arr.reshape((-1, 1))
    if arr.ndim != 2:
        return {"ok": False, "dataset_type_name": row["name"], "skipped": True, "reason": "unsupported_result_shape"}

    csv_path, sidecar_path = _target_paths(
        project_name,
        reserving_class,
        row["name"],
        settings,
        row.get("data_format") or "Triangle",
    )
    now = _now_utc_iso()
    existing_sidecar = _read_sidecar(sidecar_path)
    created = existing_sidecar.get("created") or settings.get("created") or now
    user_name = _current_user_name()
    action_value = "Update" if existing_sidecar else "Insert"
    default_format_settings = dataset_number_format_service.dataset_type_number_format_settings(
        row["name"],
    )
    number_format = dataset_number_format_service.normalize_number_format(
        existing_sidecar.get("number_format") or default_format_settings["number_format"]
    )
    decimal_places = existing_sidecar.get("decimal_places")
    if decimal_places is None:
        decimal_places = dataset_number_format_service.number_format_decimal_places(number_format)
    payload = {
        **({"audit_log": existing_sidecar.get("audit_log")} if existing_sidecar else {}),
        "dataset_name": row["name"],
        "dataset_type": row["name"],
        "reserving_class": reserving_class,
        "project_name": project_name,
        "source_kind": "calculated",
        "data_format": row.get("data_format") or "Triangle",
        "data_format_code": 1 if str(row.get("data_format") or "").strip().lower() == "vector" else 0,
        "origin_length": settings.get("origin_length") or 12,
        "development_length": settings.get("development_length") or 12,
        "cumulative": bool(settings.get("cumulative", True)),
        "calendar": bool(settings.get("calendar", False)),
        "csv_file": os.path.basename(csv_path),
        "created": created,
        "updated_at": now,
        "modified_by": user_name,
        "user": user_name,
        "calculated": True,
        "formula": row.get("formula") or "",
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_NONE,
        "status": dataset_sidecar_status_service.STATUS_CURRENT,
        "Dependents": existing_sidecar.get("Dependents", []),
        "number_format": number_format,
        "decimal_places": dataset_number_format_service.normalize_decimal_places(
            decimal_places,
            default_format_settings["decimal_places"],
        ),
    }
    apply_sidecar_graph_fields(payload, project_name, row["name"], precedents)
    from app_server.services.dataset_service import (
        _append_dataset_audit_entry,
        _write_dataset_csv_and_sidecar,
    )

    _append_dataset_audit_entry(payload, action_value, event_date=now, user_name=user_name)

    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    os.makedirs(os.path.dirname(sidecar_path), exist_ok=True)
    _write_dataset_csv_and_sidecar(pd.DataFrame(arr), csv_path, sidecar_path, payload)
    status_updates = (
        dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
            project_name,
            reserving_class,
            [row["name"]],
        )
        if mark_dependents_review
        else []
    )
    config.DATASETS["arcrhotri_" + hashlib.sha1(csv_path.encode("utf-8")).hexdigest()[:16]] = csv_path

    return {
        "ok": True,
        "dataset_type_name": row["name"],
        "path": csv_path,
        "sidecar_path": sidecar_path,
        "Precedents": payload.get("Precedents", []),
        "Dependents": payload.get("Dependents", []),
        "status_updates": status_updates,
    }


def recalculate_dataset(
    project_name: str,
    reserving_class: str,
    dataset_type_name: str,
    *,
    component_paths: Dict[str, str] | None = None,
    component_method_sources: Dict[str, Dict[str, str]] | None = None,
    dataset_type_rows: List[Dict[str, Any]] | None = None,
    mark_dependents_review: bool = True,
) -> Dict[str, Any]:
    with dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class):
        return _recalculate_dataset_impl(
            project_name,
            reserving_class,
            dataset_type_name,
            component_paths=component_paths,
            component_method_sources=component_method_sources,
            dataset_type_rows=dataset_type_rows,
            mark_dependents_review=mark_dependents_review,
        )


def recalculate_dataset_chain(
    project_name: str,
    reserving_class: str,
    dataset_type_name: str,
    *,
    rebuild_index: bool = True,
) -> Dict[str, Any]:
    first = recalculate_dataset(project_name, reserving_class, dataset_type_name)
    first_step = {
        **first,
        "status": "updated" if first.get("ok") else "skipped",
    }
    downstream = recalculate_dependents(
        project_name,
        reserving_class,
        dataset_type_name,
        dataset_type_name,
        rebuild_index=rebuild_index,
    ) \
        if first.get("ok") else {
            "ok": False,
            "steps": [],
            "updated": [],
            "skipped": [],
        }
    steps = [first_step] + list(downstream.get("steps") or [])
    updated = [item for item in steps if item.get("ok")]
    skipped = [item for item in steps if not item.get("ok")]
    return {
        "ok": bool(first.get("ok")) and bool(downstream.get("ok")),
        "project_name": project_name,
        "reserving_class": reserving_class,
        "changed_dataset_name": dataset_type_name,
        "changed_dataset_type_name": dataset_type_name,
        "targets": [item.get("dataset_type_name") for item in steps if _clean_text(item.get("dataset_type_name"))],
        "steps": steps,
        "updated": updated,
        "skipped": skipped,
    }


def _recalculate_dependents_impl(
    project_name: str,
    reserving_class: str,
    changed_dataset_name: str,
    changed_dataset_type_name: str = "",
    *,
    include_dfm: bool = True,
    include_result_selection: bool = True,
    include_bornhuetter_ferguson: bool = True,
    include_cape_cod: bool = True,
    finalize_method_review_status: bool = True,
    rebuild_index: bool = True,
) -> Dict[str, Any]:
    changed = [changed_dataset_name, changed_dataset_type_name]
    dfm_updates = None
    dfm_output_names: List[str] = []
    failed_dfm_names: List[str] = []
    if include_dfm:
        try:
            from app_server.services import dfm_service

            dfm_updates = dfm_service.refresh_dependents(
                project_name,
                reserving_class,
                changed,
                finalize_method_review_status=False,
            )
            dfm_output_names = [
                _clean_text(value)
                for item in dfm_updates.get("updated", [])
                if item.get("output_changed")
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
            failed_dfm_names = [
                _clean_text(value)
                for item in dfm_updates.get("errors", [])
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
        except Exception as err:
            dfm_updates = {
                "ok": False,
                "errors": [{"reason": str(err)}],
                "updated": [],
            }
    changed.extend([*dfm_output_names, *failed_dfm_names])
    dataset_type_rows = _dataset_type_rows(project_name)
    targets = list(_existing_downstream_keys(project_name, reserving_class, changed, dataset_type_rows))
    rows_by_key = {
        _canon_dataset_name(item.get("name")): item
        for item in dataset_type_rows
        if item.get("calculated") and not item.get("generated") and _clean_text(item.get("formula"))
    }
    known_names = [item.get("name") for item in dataset_type_rows if _clean_text(item.get("name"))]
    dependencies_by_key = {
        key: {
            _canon_dataset_name(name)
            for name in _formula_components(row.get("formula") or "", known_names)
            if _canon_dataset_name(name)
        }
        for key, row in rows_by_key.items()
    }
    results: List[Dict[str, Any]] = []
    failed_or_blocked: Set[str] = {
        _canon_dataset_name(name) for name in failed_dfm_names if _canon_dataset_name(name)
    }
    processed_target_keys: Set[str] = set()
    for key in targets:
        if key in processed_target_keys:
            continue
        processed_target_keys.add(key)
        row = rows_by_key.get(key)
        if not row:
            continue
        blocked_by = sorted(dependencies_by_key.get(key, set()) & failed_or_blocked)
        if blocked_by:
            result = {
                "ok": False,
                "dataset_type_name": row["name"],
                "skipped": True,
                "reason": "upstream_calculation_failed",
                "errors": [
                    "Skipped because an upstream calculated dependency did not refresh: "
                    + ", ".join(blocked_by)
                ],
            }
        else:
            try:
                result = recalculate_dataset(
                    project_name,
                    reserving_class,
                    row["name"],
                    dataset_type_rows=dataset_type_rows,
                    mark_dependents_review=False,
                )
            except Exception as exc:
                result = {
                    "ok": False,
                    "dataset_type_name": row["name"],
                    "skipped": True,
                    "reason": "calculation_error",
                    "errors": [str(exc)],
                }
        if not result.get("ok"):
            failed_or_blocked.add(key)
        step = {
            **result,
            "status": "updated" if result.get("ok") else "skipped",
        }
        results.append(step)
        if include_dfm:
            try:
                from app_server.services import dfm_service

                calculated_name = _clean_text(result.get("dataset_type_name") or row["name"])
                next_dfm = dfm_service.refresh_dependents(
                    project_name,
                    reserving_class,
                    [calculated_name],
                    blocked_precedent_names=[calculated_name] if not result.get("ok") else [],
                    finalize_method_review_status=False,
                )
            except Exception as err:
                next_dfm = {
                    "ok": False,
                    "updated": [],
                    "status_refreshed": [],
                    "skipped": [],
                    "errors": [{"reason": str(err)}],
                }
            if dfm_updates is None:
                dfm_updates = next_dfm
            else:
                dfm_updates["ok"] = bool(dfm_updates.get("ok")) and bool(next_dfm.get("ok"))
                for field in ("updated", "status_refreshed", "skipped", "errors"):
                    dfm_updates.setdefault(field, []).extend(next_dfm.get(field, []))
            next_output_roots = [
                _clean_text(value)
                for item in next_dfm.get("updated", [])
                if item.get("output_changed")
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
            next_failed_roots = [
                _clean_text(value)
                for item in next_dfm.get("errors", [])
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
            for name in next_output_roots:
                if _canon_dataset_name(name) not in {_canon_dataset_name(item) for item in dfm_output_names}:
                    dfm_output_names.append(name)
            for name in next_failed_roots:
                if _canon_dataset_name(name) not in {_canon_dataset_name(item) for item in failed_dfm_names}:
                    failed_dfm_names.append(name)
                if _canon_dataset_name(name):
                    failed_or_blocked.add(_canon_dataset_name(name))
            next_roots = [*next_output_roots, *next_failed_roots]
            if next_roots:
                for next_key in _existing_downstream_keys(
                    project_name,
                    reserving_class,
                    next_roots,
                    dataset_type_rows,
                ):
                    if next_key not in processed_target_keys and next_key not in targets:
                        targets.append(next_key)

    failed_dataset_names = [
        _clean_text(result.get("dataset_type_name"))
        for result in results
        if not result.get("ok") and _clean_text(result.get("dataset_type_name"))
    ]
    for failed_name in failed_dataset_names:
        if failed_name:
            dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                project_name,
                reserving_class,
                [failed_name],
            )

    result_selection_updates = None
    if include_result_selection:
        try:
            from app_server.services import result_selection_service

            fresh_names = [
                changed_dataset_name,
                changed_dataset_type_name,
                *dfm_output_names,
                *failed_dfm_names,
            ]
            fresh_names.extend(
                item.get("dataset_type_name")
                for item in results
                if item.get("ok") and _clean_text(item.get("dataset_type_name"))
            )
            result_selection_updates = result_selection_service.refresh_dependents(
                project_name,
                reserving_class,
                fresh_names,
                rebuild_index=False,
                allow_status_current=True,
                blocked_precedent_names=[*failed_dfm_names, *failed_dataset_names],
                finalize_method_review_status=False,
            )
        except Exception as err:
            result_selection_updates = {
                "ok": False,
                "errors": [{"reason": str(err)}],
                "updated": [],
            }

    bornhuetter_ferguson_updates = None
    if include_bornhuetter_ferguson:
        try:
            from app_server.services import bornhuetter_ferguson_service

            dfm_fresh_names = [
                _clean_text(value)
                for item in (dfm_updates or {}).get("updated", [])
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
            dfm_fresh_names.extend(
                _clean_text(item.get("dataset_name"))
                for item in (dfm_updates or {}).get("status_refreshed", [])
                if _clean_text(item.get("dataset_name"))
            )
            calculated_fresh_names = [
                _clean_text(item.get("dataset_type_name"))
                for item in results
                if item.get("ok") and _clean_text(item.get("dataset_type_name"))
            ]
            result_selection_fresh_names = [
                _clean_text(item.get("dataset_name"))
                for field in ("updated", "status_refreshed")
                for item in (result_selection_updates or {}).get(field, [])
                if _clean_text(item.get("dataset_name"))
            ]
            result_selection_fresh_names.extend(
                _clean_text(name)
                for name in (result_selection_updates or {}).get("downstream_fresh_names", [])
                if _clean_text(name)
            )
            failed_result_selection_names = [
                _clean_text(item.get("dataset_name"))
                for item in (result_selection_updates or {}).get("errors", [])
                if _clean_text(item.get("dataset_name"))
            ]
            failed_result_selection_names.extend(
                _clean_text(name)
                for name in (result_selection_updates or {}).get("downstream_blocked_names", [])
                if _clean_text(name)
            )
            bf_roots = [
                changed_dataset_name,
                changed_dataset_type_name,
                *dfm_fresh_names,
                *failed_dfm_names,
                *calculated_fresh_names,
                *failed_dataset_names,
                *result_selection_fresh_names,
                *failed_result_selection_names,
            ]
            bornhuetter_ferguson_updates = bornhuetter_ferguson_service.refresh_dependents(
                project_name,
                reserving_class,
                bf_roots,
                rebuild_index=False,
                blocked_precedent_names=[
                    *failed_dfm_names,
                    *failed_dataset_names,
                    *failed_result_selection_names,
                ],
                finalize_method_review_status=False,
            )
        except Exception as err:
            bornhuetter_ferguson_updates = {
                "ok": False,
                "errors": [{"reason": str(err)}],
                "updated": [],
            }

    cape_cod_updates = None
    if include_cape_cod:
        try:
            from app_server.services import cape_cod_service

            dfm_fresh_names = [
                _clean_text(value)
                for item in (dfm_updates or {}).get("updated", [])
                for value in (item.get("dataset_name"), item.get("dataset_type"))
                if _clean_text(value)
            ]
            dfm_fresh_names.extend(
                _clean_text(item.get("dataset_name"))
                for item in (dfm_updates or {}).get("status_refreshed", [])
                if _clean_text(item.get("dataset_name"))
            )
            calculated_fresh_names = [
                _clean_text(item.get("dataset_type_name"))
                for item in results
                if item.get("ok") and _clean_text(item.get("dataset_type_name"))
            ]
            result_selection_fresh_names = [
                _clean_text(item.get("dataset_name"))
                for field in ("updated", "status_refreshed")
                for item in (result_selection_updates or {}).get(field, [])
                if _clean_text(item.get("dataset_name"))
            ]
            result_selection_fresh_names.extend(
                _clean_text(name)
                for name in (result_selection_updates or {}).get("downstream_fresh_names", [])
                if _clean_text(name)
            )
            failed_result_selection_names = [
                _clean_text(item.get("dataset_name"))
                for item in (result_selection_updates or {}).get("errors", [])
                if _clean_text(item.get("dataset_name"))
            ]
            failed_result_selection_names.extend(
                _clean_text(name)
                for name in (result_selection_updates or {}).get("downstream_blocked_names", [])
                if _clean_text(name)
            )
            bornhuetter_ferguson_fresh_names = [
                _clean_text(item.get("dataset_name"))
                for field in ("updated", "status_refreshed")
                for item in (bornhuetter_ferguson_updates or {}).get(field, [])
                if _clean_text(item.get("dataset_name"))
            ]
            failed_bornhuetter_ferguson_names = [
                _clean_text(item.get("dataset_name"))
                for item in (bornhuetter_ferguson_updates or {}).get("errors", [])
                if _clean_text(item.get("dataset_name"))
            ]
            cape_cod_roots = [
                changed_dataset_name,
                changed_dataset_type_name,
                *dfm_fresh_names,
                *failed_dfm_names,
                *calculated_fresh_names,
                *failed_dataset_names,
                *result_selection_fresh_names,
                *failed_result_selection_names,
                *bornhuetter_ferguson_fresh_names,
                *failed_bornhuetter_ferguson_names,
            ]
            cape_cod_updates = cape_cod_service.refresh_dependents(
                project_name,
                reserving_class,
                cape_cod_roots,
                rebuild_index=False,
                blocked_precedent_names=[
                    *failed_dfm_names,
                    *failed_dataset_names,
                    *failed_result_selection_names,
                    *failed_bornhuetter_ferguson_names,
                ],
                finalize_method_review_status=False,
            )
        except Exception as err:
            cape_cod_updates = {
                "ok": False,
                "errors": [{"reason": str(err)}],
                "updated": [],
            }

    index_error = ""
    if finalize_method_review_status:
        dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
            project_name,
            reserving_class,
            [changed_dataset_name, changed_dataset_type_name],
        )

    if rebuild_index:
        try:
            dataset_instance_index_service.rebuild_index(project_name, reserving_class)
        except Exception as err:
            index_error = str(err)

    overall_ok = all(item.get("ok") for item in results)
    if dfm_updates is not None:
        overall_ok = overall_ok and bool(dfm_updates.get("ok"))
    if result_selection_updates is not None:
        overall_ok = overall_ok and bool(result_selection_updates.get("ok"))
    if bornhuetter_ferguson_updates is not None:
        overall_ok = overall_ok and bool(bornhuetter_ferguson_updates.get("ok"))
    if cape_cod_updates is not None:
        overall_ok = overall_ok and bool(cape_cod_updates.get("ok"))
    return {
        "ok": overall_ok,
        "project_name": project_name,
        "reserving_class": reserving_class,
        "changed_dataset_name": changed_dataset_name,
        "changed_dataset_type_name": changed_dataset_type_name,
        "targets": [
            rows_by_key[key]["name"]
            for key in targets
            if key in rows_by_key
        ],
        "steps": results,
        "updated": [item for item in results if item.get("ok")],
        "skipped": [item for item in results if not item.get("ok")],
        "dfm_updates": dfm_updates,
        "result_selection_updates": result_selection_updates,
        "bornhuetter_ferguson_updates": bornhuetter_ferguson_updates,
        "cape_cod_updates": cape_cod_updates,
        "index_ok": not index_error,
        "index_error": index_error,
    }


def recalculate_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_name: str,
    changed_dataset_type_name: str = "",
    *,
    include_dfm: bool = True,
    include_result_selection: bool = True,
    include_bornhuetter_ferguson: bool = True,
    include_cape_cod: bool = True,
    finalize_method_review_status: bool = True,
    rebuild_index: bool = True,
) -> Dict[str, Any]:
    with dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class):
        return _recalculate_dependents_impl(
            project_name,
            reserving_class,
            changed_dataset_name,
            changed_dataset_type_name,
            include_dfm=include_dfm,
            include_result_selection=include_result_selection,
            include_bornhuetter_ferguson=include_bornhuetter_ferguson,
            include_cape_cod=include_cape_cod,
            finalize_method_review_status=finalize_method_review_status,
            rebuild_index=rebuild_index,
        )


def recalculate_dependents_for_csv(csv_path: str) -> Dict[str, Any]:
    path = str(csv_path or "").strip()
    if not path or not os.path.exists(path):
        return {"ok": False, "skipped": True, "reason": "csv_not_found"}
    payload = _sidecar_for_csv(path)
    project_name = _clean_text(payload.get("project_name"))
    reserving_class = _clean_text(payload.get("reserving_class"))
    dataset_name = _clean_text(payload.get("dataset_name") or _csv_base_name(path))
    dataset_type = _clean_text(payload.get("dataset_type") or dataset_name)
    if not project_name or not reserving_class or not dataset_name:
        return {"ok": False, "skipped": True, "reason": "missing_sidecar_context"}
    return recalculate_dependents(project_name, reserving_class, dataset_name, dataset_type)


def preview_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_name: str,
    changed_dataset_type_name: str = "",
    values: List[List[Any]] | None = None,
    mask: List[List[bool]] | None = None,
    origin_labels: List[str] | None = None,
    development_labels: List[str] | None = None,
) -> Dict[str, Any]:
    source_arr = _array_from_preview_values(values, mask)
    if source_arr.ndim != 2 or source_arr.size == 0:
        return {"ok": False, "skipped": True, "reason": "empty_preview_values", "steps": []}

    changed = [changed_dataset_name, changed_dataset_type_name]
    targets = _downstream_keys(project_name, changed)
    rows_by_key = _calculated_rows_by_key(project_name)
    overrides: Dict[str, np.ndarray] = {
        _canon_dataset_name(name): source_arr
        for name in changed
        if _canon_dataset_name(name)
    }
    steps: List[Dict[str, Any]] = []

    all_rows = _dataset_type_rows(project_name)
    known_names = [item["name"] for item in all_rows]
    for key in targets:
        row = rows_by_key.get(key)
        if not row:
            continue

        expr, refs = _replace_formula_refs(row["formula"], known_names)
        ordered_components = [refs[var] for var in sorted(refs.keys(), key=lambda item: int(item[2:]))]
        settings = _existing_target_settings(project_name, reserving_class, row["name"])
        component_values, _precedents, errors = _load_components(
            project_name,
            reserving_class,
            ordered_components,
            settings,
            component_overrides=overrides,
        )
        if errors:
            steps.append({
                "ok": False,
                "status": "skipped",
                "dataset_type_name": row["name"],
                "reason": "dependency_error",
                "errors": errors,
            })
            continue

        eval_values: Dict[str, np.ndarray] = {}
        for var, ref_name in refs.items():
            try:
                idx = ordered_components.index(ref_name)
            except ValueError:
                continue
            if f"_d{idx}" in component_values:
                eval_values[var] = component_values[f"_d{idx}"]
        try:
            parsed = ast.parse(expr, mode="eval")
            with np.errstate(divide="ignore", invalid="ignore"):
                result = _eval_ast(parsed, eval_values)
        except Exception as exc:
            steps.append({
                "ok": False,
                "status": "skipped",
                "dataset_type_name": row["name"],
                "reason": "formula_error",
                "errors": [str(exc)],
            })
            continue

        arr = np.asarray(result, dtype="float64")
        if arr.ndim == 0:
            first = next(iter(eval_values.values()), source_arr)
            arr = np.full(first.shape, float(arr), dtype="float64")
        if arr.ndim == 1:
            arr = arr.reshape((-1, 1))
        if arr.ndim != 2:
            steps.append({
                "ok": False,
                "status": "skipped",
                "dataset_type_name": row["name"],
                "reason": "unsupported_result_shape",
            })
            continue

        overrides[_canon_dataset_name(row["name"])] = arr
        data_format = row.get("data_format") or "Triangle"
        steps.append({
            "ok": True,
            "status": "preview",
            "dataset_type_name": row["name"],
            "dataset_name": row["name"],
            "source_kind": "calculated_preview",
            "data_format": data_format,
            "values": _latest_diagonal_or_vector_values(arr, data_format),
            "matrix_values": _jsonable_matrix(arr),
            "mask": _matrix_mask(arr),
            "origin_labels": [str(item) for item in (origin_labels or [])],
            "development_labels": [str(item) for item in (development_labels or [])],
        })

    return {
        "ok": True,
        "project_name": project_name,
        "reserving_class": reserving_class,
        "changed_dataset_name": changed_dataset_name,
        "changed_dataset_type_name": changed_dataset_type_name,
        "targets": [
            rows_by_key[key]["name"]
            for key in targets
            if key in rows_by_key
        ],
        "steps": steps,
        "updated": [item for item in steps if item.get("ok")],
        "skipped": [item for item in steps if not item.get("ok")],
    }


def _rows_by_key_from_normalized_rows(rows: List[List[Any]]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows or []:
        if not isinstance(row, list):
            continue
        name = _clean_text(row[0] if len(row) > 0 else "")
        key = _canon_dataset_name(name)
        if not key:
            continue
        out[key] = {
            "name": name,
            "calculated": _bool_value(row[3] if len(row) > 3 else False),
            "formula": _clean_text(row[4] if len(row) > 4 else ""),
            "generated": _bool_value(row[6] if len(row) > 6 else False),
        }
    return out


def changed_formula_dataset_type_names(previous_rows: List[List[Any]], next_rows: List[List[Any]]) -> List[str]:
    previous = _rows_by_key_from_normalized_rows(previous_rows)
    current = _rows_by_key_from_normalized_rows(next_rows)
    names_by_key = _dataset_type_name_by_key_from_rows(next_rows)
    changed: List[str] = []
    for key, row in current.items():
        prev = previous.get(key)
        if (
            prev is None
            or bool(prev.get("calculated")) != bool(row.get("calculated"))
            or bool(prev.get("generated")) != bool(row.get("generated"))
            or _clean_text(prev.get("formula")) != _clean_text(row.get("formula"))
        ):
            name = names_by_key.get(key) or row.get("name")
            if _clean_text(name):
                changed.append(str(name))
    return changed


def _dataset_type_name_by_key_from_rows(rows: List[List[Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for row in rows or []:
        if not isinstance(row, list):
            continue
        name = _clean_text(row[0] if len(row) > 0 else "")
        key = _canon_dataset_name(name)
        if key:
            out[key] = name
    return out


def _iter_project_sidecars(project_name: str):
    try:
        data_dir = config.get_project_data_dir(project_name)
    except ValueError:
        return
    if not os.path.isdir(data_dir):
        return
    for rc_entry in os.scandir(data_dir):
        if not rc_entry.is_dir():
            continue
        sidecar_dir = os.path.join(rc_entry.path, config.DATASET_SIDECAR_DIR)
        if not os.path.isdir(sidecar_dir):
            continue
        for entry in os.scandir(sidecar_dir):
            if entry.is_file() and entry.name.lower().endswith(".json"):
                payload = _read_sidecar(entry.path)
                if payload:
                    yield entry.path, payload


def _write_sidecar_json(path: str, payload: Dict[str, Any]) -> None:
    payload = dict(payload)
    payload.pop("instance_name", None)
    payload.pop("dataset_type_name", None)
    dataset_sidecar_status_service.write_sidecar(path, payload)


def refresh_sidecar_graphs_and_recalculate(
    project_name: str,
    changed_dataset_types: List[str] | None = None,
) -> Dict[str, Any]:
    changed_keys = {
        _canon_dataset_name(name)
        for name in (changed_dataset_types or [])
        if _canon_dataset_name(name)
    }
    rows_by_key = _calculated_rows_by_key(project_name)
    sidecars_updated = 0
    recalc_seeds: Set[Tuple[str, str]] = set()
    errors: List[str] = []

    for path, payload in _iter_project_sidecars(project_name) or []:
        dataset_type = _clean_text(payload.get("dataset_type") or payload.get("dataset_name"))
        dataset_key = _canon_dataset_name(dataset_type)
        reserving_class = _clean_text(payload.get("reserving_class"))
        if not dataset_key:
            continue
        try:
            with (
                dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class),
                dataset_sidecar_status_service.sidecar_write_lock(path),
            ):
                latest = _read_sidecar(path)
                if not latest:
                    raise RuntimeError("Dataset sidecar disappeared during graph refresh.")
                payload = latest
                before = json.dumps(payload, sort_keys=True, ensure_ascii=False)
                payload.pop("instance_name", None)
                payload.pop("dataset_type_name", None)
                apply_sidecar_graph_fields(payload, project_name, dataset_type)
                after = json.dumps(payload, sort_keys=True, ensure_ascii=False)
                if before != after:
                    _write_sidecar_json(path, payload)
                    sidecars_updated += 1
        except Exception as exc:
            errors.append(f"{os.path.basename(path)}: {exc}")
            continue

        if changed_keys and dataset_key in changed_keys and dataset_key in rows_by_key and reserving_class:
            recalc_seeds.add((reserving_class, rows_by_key[dataset_key]["name"]))

    chains: List[Dict[str, Any]] = []
    for reserving_class, dataset_type in sorted(recalc_seeds):
        try:
            chains.append(recalculate_dataset_chain(
                project_name,
                reserving_class,
                dataset_type,
                rebuild_index=False,
            ))
        except Exception as exc:
            chains.append({
                "ok": False,
                "reserving_class": reserving_class,
                "changed_dataset_type_name": dataset_type,
                "steps": [],
                "updated": [],
                "skipped": [{"ok": False, "dataset_type_name": dataset_type, "reason": str(exc)}],
            })

    touched_rcs = {
        _clean_text(chain.get("reserving_class"))
        for chain in chains
        if _clean_text(chain.get("reserving_class"))
    }
    for reserving_class in touched_rcs:
        try:
            dataset_instance_index_service.rebuild_index(project_name, reserving_class)
        except Exception as exc:
            errors.append(f"{reserving_class} index rebuild: {exc}")

    return {
        "ok": not errors and all(chain.get("ok") for chain in chains),
        "project_name": project_name,
        "changed_dataset_types": list(changed_dataset_types or []),
        "sidecars_updated": sidecars_updated,
        "chains": chains,
        "errors": errors,
    }
