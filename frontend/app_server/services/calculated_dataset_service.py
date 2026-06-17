from __future__ import annotations

import ast
import getpass
import hashlib
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Set, Tuple

import numpy as np
import pandas as pd

from app_server import config
from app_server.helpers import (
    _canon_dataset_name,
    atomic_write_csv,
    build_length_scoped_dataset_file_name,
    sanitize_dataset_file_name,
)
from app_server.services import dataset_instance_index_service, dataset_types_service


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
    try:
        path = config.get_dataset_types_path(project_name)
    except ValueError:
        return []
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return []
    data = dataset_types_service.normalize_dataset_types_data(raw)
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


def _direct_precedent_names(project_name: str, dataset_type_name: str) -> List[str]:
    rows = _dataset_type_rows(project_name)
    known_names = [row["name"] for row in rows]
    target_key = _canon_dataset_name(dataset_type_name)
    for row in rows:
        if _canon_dataset_name(row["name"]) != target_key:
            continue
        if not row.get("calculated") or row.get("generated") or not _clean_text(row.get("formula")):
            return []
        return _formula_components(row["formula"], known_names)
    return []


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
) -> Dict[str, Any]:
    return {
        "Precedents": _precedent_entries(project_name, dataset_type_name, dependency_info),
        "Dependents": _name_entries(_direct_dependent_names(project_name, dataset_type_name)),
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
        payload["editable"] = False if is_calculated else payload.get("editable")
        payload["generated"] = False if is_calculated else payload.get("generated")

    payload.update(sidecar_graph_fields(project, dataset_type, dependency_info))
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
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(folder)]) == os.path.abspath(folder)
    except Exception:
        return False


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
) -> Tuple[np.ndarray | None, str, str]:
    data_tab = _json_tab(payload, "data tab")
    details = _json_tab(payload, "details tab")
    dataset_folder = config.get_project_dataset_cache_dir(project_name, reserving_class)
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
) -> Tuple[np.ndarray | None, str, str]:
    data_tab = _json_tab(payload, "data tab")
    input_values, input_path, error = _read_dfm_input_triangle(project_name, reserving_class, payload, target_settings)
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
            "score": score,
            "mtime": os.stat(path).st_mtime,
        })
    out.sort(key=lambda item: (int(item.get("score") or 0), float(item.get("mtime") or 0)), reverse=True)
    best_score = int(out[0].get("score") or 0) if out else 0
    return [item for item in out if int(item.get("score") or 0) == best_score]


def _target_paths(project_name: str, reserving_class: str, dataset_name: str, settings: Dict[str, Any]) -> Tuple[str, str]:
    folder = config.get_project_dataset_cache_dir(project_name, reserving_class)
    csv_name = build_length_scoped_dataset_file_name(
        dataset_name,
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
) -> Tuple[Dict[str, np.ndarray], List[Dict[str, Any]], List[str]]:
    values: Dict[str, np.ndarray] = {}
    dependency_info: List[Dict[str, Any]] = []
    errors: List[str] = []
    for index, component in enumerate(components):
        candidates = _candidate_csvs(project_name, reserving_class, component, target_settings)
        if not candidates:
            method_candidates = _candidate_dfm_methods(project_name, reserving_class, component)
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
            )
            if error or arr is None:
                errors.append(f"Failed to rebuild DFM dependency {component}: {error or 'unknown error'}")
                continue
            var = f"_d{index}"
            values[var] = arr
            stat = os.stat(method_path)
            dependency_info.append({
                "dataset_type_name": component,
                "path": method_path,
                "source_kind": "dfm_method",
                "input_path": input_path,
                "mtime": stat.st_mtime,
                "mtime_ns": stat.st_mtime_ns,
            })
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
        stat = os.stat(path)
        dependency_info.append({
            "dataset_type_name": component,
            "path": path,
            "mtime": stat.st_mtime,
            "mtime_ns": stat.st_mtime_ns,
        })
    return values, dependency_info, errors


def _calculated_rows_by_key(project_name: str) -> Dict[str, Dict[str, Any]]:
    return {
        _canon_dataset_name(row["name"]): row
        for row in _dataset_type_rows(project_name)
        if row.get("calculated") and not row.get("generated") and _clean_text(row.get("formula"))
    }


def _dependency_map(project_name: str) -> Dict[str, Set[str]]:
    rows = _dataset_type_rows(project_name)
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


def _target_dependency_map(project_name: str) -> Dict[str, Set[str]]:
    rows = _dataset_type_rows(project_name)
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


def _downstream_keys(project_name: str, changed_names: List[str]) -> List[str]:
    dep_map = _dependency_map(project_name)
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
    deps_by_target = _target_dependency_map(project_name)
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


def recalculate_dataset(project_name: str, reserving_class: str, dataset_type_name: str) -> Dict[str, Any]:
    rows_by_key = _calculated_rows_by_key(project_name)
    row = rows_by_key.get(_canon_dataset_name(dataset_type_name))
    if not row:
        return {"ok": False, "dataset_type_name": dataset_type_name, "skipped": True, "reason": "not_calculated"}

    all_rows = _dataset_type_rows(project_name)
    known_names = [item["name"] for item in all_rows]
    expr, refs = _replace_formula_refs(row["formula"], known_names)
    ordered_components = [refs[key] for key in sorted(refs.keys(), key=lambda item: int(item[2:]))]

    settings = _existing_target_settings(project_name, reserving_class, row["name"])
    values, precedents, errors = _load_components(project_name, reserving_class, ordered_components, settings)
    if errors:
        return {
            "ok": False,
            "dataset_type_name": row["name"],
            "skipped": True,
            "reason": "dependency_error",
            "errors": errors,
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

    csv_path, sidecar_path = _target_paths(project_name, reserving_class, row["name"], settings)
    now = _now_utc_iso()
    existing_sidecar = _read_sidecar(sidecar_path)
    created = existing_sidecar.get("created") or settings.get("created") or now
    user_name = _current_user_name()
    action_value = "Update" if existing_sidecar else "Insert"
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
        "editable": False,
        "generated": False,
        "calculated": True,
        "formula": row.get("formula") or "",
    }
    apply_sidecar_graph_fields(payload, project_name, row["name"], precedents)
    from app_server.services.dataset_service import _append_dataset_audit_entry

    _append_dataset_audit_entry(payload, action_value, event_date=now, user_name=user_name)

    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    os.makedirs(os.path.dirname(sidecar_path), exist_ok=True)
    atomic_write_csv(pd.DataFrame(arr), csv_path)
    tmp_sidecar = f"{sidecar_path}.{uuid.uuid4()}.tmp"
    with open(tmp_sidecar, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp_sidecar, sidecar_path)
    config.DATASETS["arcrhotri_" + hashlib.sha1(csv_path.encode("utf-8")).hexdigest()[:16]] = csv_path

    return {
        "ok": True,
        "dataset_type_name": row["name"],
        "path": csv_path,
        "sidecar_path": sidecar_path,
        "Precedents": payload.get("Precedents", []),
        "Dependents": payload.get("Dependents", []),
    }


def recalculate_dataset_chain(project_name: str, reserving_class: str, dataset_type_name: str) -> Dict[str, Any]:
    first = recalculate_dataset(project_name, reserving_class, dataset_type_name)
    first_step = {
        **first,
        "status": "updated" if first.get("ok") else "skipped",
    }
    downstream = recalculate_dependents(project_name, reserving_class, dataset_type_name, dataset_type_name)
    steps = [first_step] + list(downstream.get("steps") or [])
    updated = [item for item in steps if item.get("ok")]
    skipped = [item for item in steps if not item.get("ok")]
    return {
        "ok": True,
        "project_name": project_name,
        "reserving_class": reserving_class,
        "changed_dataset_name": dataset_type_name,
        "changed_dataset_type_name": dataset_type_name,
        "targets": [item.get("dataset_type_name") for item in steps if _clean_text(item.get("dataset_type_name"))],
        "steps": steps,
        "updated": updated,
        "skipped": skipped,
    }


def recalculate_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_name: str,
    changed_dataset_type_name: str = "",
) -> Dict[str, Any]:
    changed = [changed_dataset_name, changed_dataset_type_name]
    targets = _downstream_keys(project_name, changed)
    rows_by_key = _calculated_rows_by_key(project_name)
    results: List[Dict[str, Any]] = []
    for key in targets:
        row = rows_by_key.get(key)
        if not row:
            continue
        result = recalculate_dataset(project_name, reserving_class, row["name"])
        step = {
            **result,
            "status": "updated" if result.get("ok") else "skipped",
        }
        results.append(step)

    try:
        dataset_instance_index_service.rebuild_index(project_name, reserving_class)
    except Exception:
        pass

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
        "steps": results,
        "updated": [item for item in results if item.get("ok")],
        "skipped": [item for item in results if not item.get("ok")],
    }


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
            if entry.is_file() and entry.name.lower().endswith(".json") and not entry.name.startswith("ArcRhoTriNotes@"):
                payload = _read_sidecar(entry.path)
                if payload:
                    yield entry.path, payload


def _write_sidecar_json(path: str, payload: Dict[str, Any]) -> None:
    payload = dict(payload)
    payload.pop("instance_name", None)
    payload.pop("dataset_type_name", None)
    tmp_path = f"{path}.{uuid.uuid4()}.tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp_path, path)


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
            chains.append(recalculate_dataset_chain(project_name, reserving_class, dataset_type))
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
        except Exception:
            pass

    return {
        "ok": not errors,
        "project_name": project_name,
        "changed_dataset_types": list(changed_dataset_types or []),
        "sidecars_updated": sidecars_updated,
        "chains": chains,
        "errors": errors,
    }
