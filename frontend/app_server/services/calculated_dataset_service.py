from __future__ import annotations

import ast
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
        instance_name = _clean_text(sidecar.get("instance_name") or sidecar.get("dataset_name") or _csv_base_name(path))
        type_name = _clean_text(sidecar.get("dataset_type_name") or sidecar.get("dataset_type") or _csv_base_name(path))
        if dep_key not in {_canon_dataset_name(instance_name), _canon_dataset_name(type_name), _canon_dataset_name(_csv_base_name(path))}:
            continue
        score = 0
        if _canon_dataset_name(type_name) == dep_key:
            score += 8
        if _canon_dataset_name(instance_name) == dep_key:
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
            errors.append(f"Missing dependency: {component}")
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
    values, dependencies, errors = _load_components(project_name, reserving_class, ordered_components, settings)
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
    created = settings.get("created") or now
    payload = {
        "dataset_name": row["name"],
        "dataset_type": row["name"],
        "dataset_type_name": row["name"],
        "instance_name": row["name"],
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
        "modified_by": "calculated",
        "user": "calculated",
        "editable": False,
        "generated": False,
        "calculated": True,
        "formula": row.get("formula") or "",
        "dependencies": dependencies,
    }

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
        "dependencies": dependencies,
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
        results.append(recalculate_dataset(project_name, reserving_class, row["name"]))

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
    dataset_name = _clean_text(payload.get("instance_name") or payload.get("dataset_name") or _csv_base_name(path))
    dataset_type = _clean_text(payload.get("dataset_type_name") or payload.get("dataset_type") or dataset_name)
    if not project_name or not reserving_class or not dataset_name:
        return {"ok": False, "skipped": True, "reason": "missing_sidecar_context"}
    return recalculate_dependents(project_name, reserving_class, dataset_name, dataset_type)
