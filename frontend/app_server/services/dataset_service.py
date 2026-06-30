"""Dataset / triangle data operations."""
from __future__ import annotations

import json
import os
import getpass
import hashlib
import uuid
from datetime import datetime
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app_server import config
from app_server.helpers import atomic_write_csv, build_length_scoped_dataset_file_name, sanitize_dataset_file_name
from app_server.services import dataset_instance_index_service, dataset_sidecar_status_service


def make_annual_labels(start_year: int, n_origin: int, n_dev: int) -> Tuple[List[str], List[str]]:
    origin_labels = [str(start_year + i) for i in range(n_origin)]
    dev_labels = [str(12 * (j + 1)) for j in range(n_dev)]
    return origin_labels, dev_labels


def infer_shape(path: str) -> Tuple[int, int]:
    df = pd.read_csv(path, header=None)
    return int(df.shape[0]), int(df.shape[1])


def load_triangle_values(path: str) -> pd.DataFrame:
    return pd.read_csv(path, header=None, dtype="float64")


def triangle_mask(n_origin: int, n_dev: int) -> np.ndarray:
    r = np.arange(n_origin)[:, None]
    c = np.arange(n_dev)[None, :]
    return (r + c < n_dev)


def diagonal_indices(n_origin: int, n_dev: int, k: int = 0) -> List[Tuple[int, int]]:
    mask = triangle_mask(n_origin, n_dev)
    out = []
    for r in range(n_origin):
        c = n_dev - 1 - r - k
        if 0 <= c < n_dev and mask[r, c]:
            out.append((r, c))
    return out


def list_datasets() -> List[Dict[str, Any]]:
    out = []
    for ds_id, path in config.DATASETS.items():
        if not os.path.exists(path):
            continue
        n_origin, n_dev = infer_shape(path)
        st = os.stat(path)
        out.append({
            "id": ds_id,
            "path": path,
            "shape": {"n_origin": n_origin, "n_dev": n_dev},
            "mtime": st.st_mtime,
        })
    return out


def list_cached_dataset_names(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    project = str(project_name if project_name is not None else "").strip()
    rc = str(reserving_class if reserving_class is not None else "").strip()
    if not project or not rc:
        raise HTTPException(400, "project_name and reserving_class are required.")
    return dataset_instance_index_service.get_index(project, rc, refresh=refresh)


def delete_cached_datasets(project_name: str, reserving_class: str, dataset_names: List[str]) -> Dict[str, Any]:
    project = str(project_name if project_name is not None else "").strip()
    rc = str(reserving_class if reserving_class is not None else "").strip()
    if not project or not rc:
        raise HTTPException(400, "project_name and reserving_class are required.")
    return dataset_instance_index_service.delete_cached_datasets(project, rc, dataset_names)


def _data_format_code(data_format: str) -> int:
    text = str(data_format or "").strip().lower()
    if text == "vector":
        return 1
    return 0


def _normalize_number_format(value: Any) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()
    return (text or "0,000")[:64]


def _normalize_decimal_places(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 1
    return max(0, min(6, n))


def _normalize_origin_labels(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _normalize_name_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    out: List[str] = []
    seen: set[str] = set()
    for item in value:
        name = str(item or "").strip()
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


DATASET_AUDIT_LOG_MAX_ENTRIES = 50


def _current_user_name() -> str:
    for value in (os.environ.get("USERNAME"), os.environ.get("USER")):
        text = str(value or "").strip()
        if text:
            return text
    try:
        return str(getpass.getuser() or "").strip() or "unknown"
    except Exception:
        return "unknown"


def _normalize_dataset_audit_log(value: Any) -> List[Dict[str, str]]:
    entries: List[Dict[str, str]] = []
    if not isinstance(value, list):
        return entries
    for raw in value:
        if not isinstance(raw, dict):
            continue
        event_date = str(raw.get("event_date") or raw.get("Event Date") or "").strip()
        action = str(raw.get("action") or raw.get("Action") or "").strip()
        change_info = str(raw.get("change_info") or raw.get("Change Info") or "").strip()
        user = str(raw.get("user") or raw.get("User") or "").strip()
        if not event_date or action not in {"Insert", "Update"}:
            continue
        entries.append({
            "event_date": event_date,
            "action": action,
            "change_info": "" if action == "Insert" else (change_info or "Values"),
            "user": user,
        })
    return entries[-DATASET_AUDIT_LOG_MAX_ENTRIES:]


def _append_dataset_audit_entry(payload: Dict[str, Any], action: str, *, event_date: str | None = None, user_name: str | None = None) -> None:
    action_value = "Insert" if str(action or "").strip().lower() == "insert" else "Update"
    entries = _normalize_dataset_audit_log(payload.get("audit_log"))
    entries.append({
        "event_date": event_date or _now_utc_iso(),
        "action": action_value,
        "change_info": "" if action_value == "Insert" else "Values",
        "user": str(user_name or "").strip() or _current_user_name(),
    })
    payload["audit_log"] = entries[-DATASET_AUDIT_LOG_MAX_ENTRIES:]


def _write_dataset_sidecar_payload(path: str, payload: Dict[str, Any]) -> None:
    tmp_path = f"{path}.{uuid.uuid4()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp_path, path)
    except PermissionError:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise HTTPException(423, "Dataset sidecar is locked or inaccessible.")
    except OSError as err:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise HTTPException(500, f"Failed to write dataset sidecar: {str(err)}")


def _empty_dataset_values(
    data_format: str,
    origin_length: int,
    development_length: int,
    triangle_shape_mask: np.ndarray | None = None,
) -> pd.DataFrame:
    fmt = str(data_format or "").strip().lower()
    n_origin = max(1, int(origin_length))
    n_dev = 1 if fmt == "vector" else max(1, int(development_length))
    values = np.zeros((n_origin, n_dev), dtype="float64")
    if fmt != "vector":
        mask = triangle_shape_mask
        if not isinstance(mask, np.ndarray) or mask.shape != (n_origin, n_dev):
            mask = triangle_mask(n_origin, n_dev)
        values = np.where(mask, 0.0, np.nan)
    return pd.DataFrame(values)


def _dataset_values_to_frame(
    values: List[List[Any]],
    mask: List[List[bool]] | None = None,
) -> pd.DataFrame:
    if not isinstance(values, list) or not values:
        raise HTTPException(400, "values must include at least one row.")
    width = 0
    for row in values:
        if not isinstance(row, list):
            raise HTTPException(400, "values must be a rectangular array.")
        width = max(width, len(row))
    if width <= 0:
        raise HTTPException(400, "values must include at least one column.")

    out: List[List[float]] = []
    for r, row in enumerate(values):
        if len(row) != width:
            raise HTTPException(400, "values must be a rectangular array.")
        out_row: List[float] = []
        mask_row = mask[r] if isinstance(mask, list) and r < len(mask) and isinstance(mask[r], list) else None
        for c, raw in enumerate(row):
            has_value = True if mask_row is None or c >= len(mask_row) else bool(mask_row[c])
            if not has_value or raw is None:
                out_row.append(np.nan)
                continue
            try:
                out_row.append(float(raw))
            except (TypeError, ValueError):
                raise HTTPException(400, "values must contain only numeric or null cells.")
        out.append(out_row)
    return pd.DataFrame(out, dtype="float64")


def _ym_to_month_index(value: Any) -> int | None:
    text = str(value if value is not None else "").strip()
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) >= 6:
        year = int(digits[:4])
        month = int(digits[4:6])
    elif len(digits) == 4:
        year = int(digits)
        month = 1
    else:
        return None
    if year <= 0 or month < 1 or month > 12:
        return None
    return year * 12 + (month - 1)


def _period_count(start_value: Any, end_value: Any, period_length: int, fallback: int = 12) -> int:
    start = _ym_to_month_index(start_value)
    end = _ym_to_month_index(end_value)
    period = max(1, int(period_length or 1))
    if start is None or end is None or end < start:
        return fallback
    return max(1, ((end - start) // period) + 1)


def _empty_dataset_geometry_from_general_settings(
    project_name: str,
    origin_period_length: int,
    development_period_length: int,
) -> tuple[int, int, np.ndarray | None]:
    try:
        path = config.get_general_settings_path(project_name)
    except ValueError:
        return 12, 12, None
    if not os.path.exists(path):
        return 12, 12, None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        return 12, 12, None
    origin_start = payload.get("origin_start_date", "")
    origin_end = payload.get("origin_end_date", "")
    development_end = payload.get("development_end_date", "")
    origin_count = _period_count(origin_start, origin_end, origin_period_length)
    development_count = _period_count(origin_start, development_end, development_period_length, fallback=origin_count)
    origin_start_month = _ym_to_month_index(origin_start)
    development_end_month = _ym_to_month_index(development_end)
    if origin_start_month is None or development_end_month is None:
        return origin_count, development_count, None
    origin_offsets = np.arange(origin_count)[:, None] * max(1, int(origin_period_length or 1))
    development_offsets = np.arange(development_count)[None, :] * max(1, int(development_period_length or 1))
    mask = origin_start_month + origin_offsets + development_offsets <= development_end_month
    return origin_count, development_count, mask


def _dataset_patch_mask(path: str, n_origin: int, n_dev: int) -> np.ndarray:
    try:
        sidecar_path = dataset_instance_index_service._dataset_sidecar_path_for_cached_csv(path)
        payload = _read_dataset_sidecar(sidecar_path)
        project_name = str(payload.get("project_name") or "").strip()
        origin_period_len = max(1, int(payload.get("origin_length") or 1))
        dev_period_len = max(1, int(payload.get("development_length") or 1))
        if project_name:
            _, _, mask = _empty_dataset_geometry_from_general_settings(
                project_name,
                origin_period_len,
                dev_period_len,
            )
            if isinstance(mask, np.ndarray) and mask.shape == (n_origin, n_dev):
                return mask
    except Exception:
        pass
    return triangle_mask(n_origin, n_dev)


def create_empty_cached_dataset(
    project_name: str,
    reserving_class: str,
    dataset_type: str,
    *,
    instance_name: str = "",
    data_format: str = "Triangle",
    origin_length: int = 12,
    development_length: int = 12,
    cumulative: bool = True,
    calendar: bool = False,
) -> Dict[str, Any]:
    p, rc, ds_type = _require_dataset_fields(project_name, reserving_class, dataset_type)
    instance = str(instance_name or ds_type).strip()
    if not instance:
        raise HTTPException(400, "instance_name or dataset_type is required.")

    try:
        from app_server.services import calculated_dataset_service

        calc_result = calculated_dataset_service.recalculate_dataset(p, rc, ds_type)
    except Exception as err:
        calc_result = {"ok": False, "reason": "calculation_error", "errors": [str(err)]}
    if calc_result.get("ok"):
        csv_path = str(calc_result.get("path") or "")
        if csv_path:
            ds_id = "arcrhotri_" + hashlib.sha1(csv_path.encode("utf-8")).hexdigest()[:16]
            config.DATASETS[ds_id] = csv_path
            try:
                dataset_instance_index_service.rebuild_index(p, rc)
            except Exception:
                pass
            try:
                n_origin, n_dev = infer_shape(csv_path)
            except Exception:
                n_origin, n_dev = 0, 0
            return {
                "ok": True,
                "project_name": p,
                "reserving_class": rc,
                "dataset_name": instance,
                "dataset_type": ds_type,
                "source_kind": "calculated",
                "data_format": "Calculated",
                "origin_length": 12,
                "development_length": 12,
                "shape": {"n_origin": n_origin, "n_development": n_dev},
                "csv_file": os.path.basename(csv_path),
                "ds_id": ds_id,
                "path": csv_path,
                "sidecar_path": str(calc_result.get("sidecar_path") or ""),
                "calculated": True,
            }
    if calc_result.get("reason") not in {"not_calculated"}:
        detail = "; ".join(str(item) for item in calc_result.get("errors") or [])
        if not detail:
            detail = str(calc_result.get("reason") or "Failed to calculate dataset.")
        raise HTTPException(422, detail)

    try:
        data_dir = config.get_project_dataset_cache_dir(p, rc)
        sidecar_dir = config.get_project_dataset_sidecar_dir(p, rc)
    except ValueError as err:
        raise HTTPException(404, str(err))

    origin_period_len = max(1, int(origin_length))
    dev_period_len = max(1, int(development_length))
    origin_count, dev_count, triangle_shape_mask = _empty_dataset_geometry_from_general_settings(
        p,
        origin_period_len,
        dev_period_len,
    )
    fmt = str(data_format or "Triangle").strip() or "Triangle"
    folder = data_dir
    csv_stem = build_length_scoped_dataset_file_name(instance, origin_period_len, dev_period_len, cumulative, calendar)
    csv_path = os.path.join(folder, f"{csv_stem}.csv")
    sidecar_path = os.path.join(sidecar_dir, f"{sanitize_dataset_file_name(instance)}.json")
    now = _now_utc_iso()
    user_name = _current_user_name()

    df = _empty_dataset_values(fmt, origin_count, dev_count, triangle_shape_mask)
    payload = {
        "dataset_name": instance,
        "dataset_type": ds_type,
        "reserving_class": rc,
        "project_name": p,
        "source_kind": "input",
        "data_format": fmt,
        "data_format_code": _data_format_code(fmt),
        "origin_length": origin_period_len,
        "development_length": dev_period_len,
        "cumulative": bool(cumulative),
        "calendar": bool(calendar),
        "csv_file": os.path.basename(csv_path),
        "user": user_name,
        "created": now,
        "modified_by": user_name,
        "updated_at": now,
        "method_type": dataset_sidecar_status_service.METHOD_TYPE_NONE,
        "status": dataset_sidecar_status_service.STATUS_CURRENT,
    }
    _append_dataset_audit_entry(payload, "Insert", event_date=now, user_name=user_name)
    from app_server.services import calculated_dataset_service

    calculated_dataset_service.apply_sidecar_graph_fields(payload, p, ds_type)

    try:
        os.makedirs(folder, exist_ok=True)
        os.makedirs(sidecar_dir, exist_ok=True)
        atomic_write_csv(df, csv_path)
        _write_dataset_sidecar_payload(sidecar_path, payload)
    except PermissionError:
        raise HTTPException(423, "Dataset cache file is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to create empty dataset cache: {str(err)}")

    try:
        dataset_instance_index_service.rebuild_index(p, rc)
    except Exception:
        pass
    try:
        from app_server.services import calculated_dataset_service

        calculated_dataset_service.recalculate_dependents(p, rc, instance, ds_type)
    except Exception:
        pass

    ds_id = "arcrhotri_" + hashlib.sha1(csv_path.encode("utf-8")).hexdigest()[:16]
    config.DATASETS[ds_id] = csv_path
    return {
        "ok": True,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": instance,
        "dataset_type": ds_type,
        "source_kind": "input",
        "data_format": fmt,
        "origin_length": origin_period_len,
        "development_length": dev_period_len,
        "shape": {"n_origin": origin_count, "n_development": 1 if fmt.strip().lower() == "vector" else dev_count},
        "csv_file": os.path.basename(csv_path),
        "ds_id": ds_id,
        "path": csv_path,
        "sidecar_path": sidecar_path,
    }


def get_dataset(ds_id: str, start_year: int = 2016) -> Dict[str, Any]:
    path = config.DATASETS.get(ds_id)
    if not path or not os.path.exists(path):
        return None

    df = pd.read_csv(path, header=None, dtype="float64", keep_default_na=True)
    n_origin, n_dev = df.shape

    origin_labels = [str(start_year + i) for i in range(n_origin)]
    dev_labels = [str(12 * (j + 1)) for j in range(n_dev)]

    values = df.to_numpy()
    mask = ~np.isnan(values)

    st = os.stat(path)
    return {
        "id": ds_id,
        "origin_labels": origin_labels,
        "dev_labels": dev_labels,
        "values": np.where(np.isnan(values), None, values).tolist(),
        "mask": mask.tolist(),
        "mtime": st.st_mtime,
    }


def get_diagonal(ds_id: str, k: int = 0, start_year: int = 2016) -> Dict[str, Any]:
    path = config.DATASETS.get(ds_id)
    if not path or not os.path.exists(path):
        return None

    df = load_triangle_values(path)
    n_origin, n_dev = df.shape
    origin_labels, dev_labels = make_annual_labels(start_year, n_origin, n_dev)

    idx = diagonal_indices(n_origin, n_dev, k=k)
    items = []
    for r, c in idx:
        v = df.iat[r, c]
        items.append({
            "r": r,
            "c": c,
            "origin": origin_labels[r],
            "dev": dev_labels[c],
            "value": None if pd.isna(v) else float(v),
        })

    return {"id": ds_id, "k": k, "items": items}


def _build_notes_dataset_id(project_name: str, reserving_class: str, dataset_name: str) -> str:
    _ = project_name
    ds_component = sanitize_dataset_file_name(dataset_name)
    return f"ArcRhoTriNotes@{ds_component}"


def _require_notes_fields(project_name: str, reserving_class: str, dataset_name: str) -> Tuple[str, str, str]:
    p = str(project_name if project_name is not None else "")
    rc = str(reserving_class if reserving_class is not None else "")
    ds = str(dataset_name if dataset_name is not None else "")
    if not p.strip() or not rc.strip() or not ds.strip():
        raise HTTPException(400, "project_name, reserving_class, and dataset_name are required.")
    return p, rc, ds


def _get_notes_file_path(project_name: str, reserving_class: str, dataset_id: str) -> str:
    try:
        data_dir = config.get_project_dataset_sidecar_dir(project_name, reserving_class)
    except ValueError as err:
        raise HTTPException(404, str(err))
    return os.path.join(data_dir, f"{dataset_id}.json")


def _require_dataset_fields(project_name: str, reserving_class: str, dataset_name: str) -> Tuple[str, str, str]:
    p = str(project_name if project_name is not None else "")
    rc = str(reserving_class if reserving_class is not None else "")
    ds = str(dataset_name if dataset_name is not None else "")
    if not p.strip() or not rc.strip() or not ds.strip():
        raise HTTPException(400, "project_name, reserving_class, and dataset_name are required.")
    return p, rc, ds


def _get_dataset_sidecar_path(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    csv_file: str = "",
) -> str:
    _ = csv_file
    try:
        sidecar_dir = config.get_project_dataset_sidecar_dir(project_name, reserving_class)
    except ValueError as err:
        raise HTTPException(404, str(err))
    ds_file = sanitize_dataset_file_name(dataset_name)
    return os.path.join(sidecar_dir, f"{ds_file}.json")


def _now_utc_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _read_dataset_sidecar(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except PermissionError:
        raise HTTPException(423, "Dataset sidecar is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to read dataset sidecar: {str(err)}")
    except json.JSONDecodeError as err:
        raise HTTPException(500, f"Invalid dataset sidecar JSON format: {str(err)}")
    return payload if isinstance(payload, dict) else {}


def _is_app_calculated_dataset_type(project_name: str, dataset_type_name: str) -> tuple[bool, str]:
    name_key = str(dataset_type_name or "").strip().lower()
    if not name_key:
        return False, ""
    try:
        from app_server.services import calculated_dataset_service

        rows = calculated_dataset_service._dataset_type_rows(project_name)
    except Exception:
        return False, ""
    for row in rows:
        if str(row.get("name") or "").strip().lower() != name_key:
            continue
        return bool(row.get("calculated") and not row.get("generated") and str(row.get("formula") or "").strip()), str(row.get("formula") or "")
    return False, ""


def _method_type_from_dataset_index(project_name: str, reserving_class: str, dataset_name: str) -> str:
    name_key = str(dataset_name or "").strip().lower()
    if not name_key:
        return dataset_sidecar_status_service.METHOD_TYPE_NONE
    try:
        index = dataset_instance_index_service.get_index(project_name, reserving_class, refresh=False)
    except Exception:
        return dataset_sidecar_status_service.METHOD_TYPE_NONE
    for item in index.get("files") or []:
        if not isinstance(item, dict):
            continue
        names = [item.get("name")]
        item_keys = {str(value or "").strip().lower() for value in names if str(value or "").strip()}
        if name_key not in item_keys:
            continue
        return dataset_sidecar_status_service.normalize_method_type(item.get("method_type"))
    return dataset_sidecar_status_service.METHOD_TYPE_NONE


def _sidecar_graph_entries(
    project_name: str,
    reserving_class: str,
    entries: Any,
    *,
    include_formula: bool = False,
    include_method_type: bool = False,
) -> List[Dict[str, str]]:
    out = dataset_sidecar_status_service.name_entries(
        dataset_sidecar_status_service.entry_names(entries)
    )
    if not include_formula and not include_method_type:
        return out
    for item in out:
        name = str(item.get("dataset_type_name") or "").strip()
        if not name:
            continue
        try:
            dep_payload = _read_dataset_sidecar(_get_dataset_sidecar_path(project_name, reserving_class, name))
        except Exception:
            dep_payload = {}
        dataset_name = str(dep_payload.get("dataset_name") or name).strip()
        dataset_type = str(dep_payload.get("dataset_type") or name).strip()
        _, type_formula = _is_app_calculated_dataset_type(project_name, dataset_type)
        formula = str(dep_payload.get("formula") or type_formula or "").strip()
        item["dataset_name"] = dataset_name or name
        item["dataset_type"] = dataset_type or name
        if include_method_type:
            method_type = dataset_sidecar_status_service.normalize_method_type(
                dep_payload.get("method_type"),
                dep_payload.get("source_kind"),
            )
            if method_type == dataset_sidecar_status_service.METHOD_TYPE_NONE:
                method_type = _method_type_from_dataset_index(project_name, reserving_class, dataset_name or name)
            item["method_type"] = method_type
        if formula:
            item["formula"] = formula
    return out


def load_dataset_sidecar(project_name: str, reserving_class: str, dataset_name: str) -> Dict[str, Any]:
    p, rc, ds = _require_dataset_fields(project_name, reserving_class, dataset_name)
    path = _get_dataset_sidecar_path(p, rc, ds)
    payload = _read_dataset_sidecar(path)
    if not payload:
        return {
            "ok": True,
            "exists": False,
            "project_name": p,
            "reserving_class": rc,
            "dataset_name": ds,
            "path": path,
        }
    dataset_type = str(payload.get("dataset_type") or ds)
    app_calculated, formula = _is_app_calculated_dataset_type(p, dataset_type)
    return {
        "ok": True,
        "exists": True,
        "project_name": str(payload.get("project_name") or p),
        "reserving_class": str(payload.get("reserving_class") or rc),
        "dataset_name": str(payload.get("dataset_name") or ds),
        "dataset_type": dataset_type,
        "instance_name": str(payload.get("dataset_name") or ds),
        "origin_length": payload.get("origin_length"),
        "development_length": payload.get("development_length"),
        "origin_labels": _normalize_origin_labels(payload.get("origin_labels")),
        "cumulative": payload.get("cumulative"),
        "transposed": payload.get("transposed"),
        "calendar": payload.get("calendar"),
        "number_format": _normalize_number_format(payload.get("number_format") or "0,000"),
        "decimal_places": _normalize_decimal_places(payload.get("decimal_places")),
        "csv_file": str(payload.get("csv_file") or ""),
        "source_kind": str(payload.get("source_kind") or ""),
        "method_type": dataset_sidecar_status_service.normalize_method_type(
            payload.get("method_type"),
            payload.get("source_kind"),
        ),
        "status": dataset_sidecar_status_service.normalize_status(payload.get("status")),
        "calculated": True if app_calculated else payload.get("calculated"),
        "formula": formula or str(payload.get("formula") or ""),
        "Precedents": _sidecar_graph_entries(p, rc, payload.get("Precedents"), include_method_type=True),
        "Dependents": _sidecar_graph_entries(p, rc, payload.get("Dependents"), include_formula=True),
        "user": str(payload.get("user") or ""),
        "modified_by": str(payload.get("modified_by") or ""),
        "created": str(payload.get("created") or ""),
        "updated_at": str(payload.get("updated_at") or ""),
        "audit_log": _normalize_dataset_audit_log(payload.get("audit_log")),
        "path": path,
    }


def _cached_csv_candidates(project_name: str, reserving_class: str, dataset_name: str, sidecar: Dict[str, Any]) -> List[str]:
    try:
        data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    except ValueError as err:
        raise HTTPException(404, str(err))
    names: List[str] = []
    csv_file = str(sidecar.get("csv_file") or "").strip()
    if csv_file:
        names.append(csv_file)
    base = sanitize_dataset_file_name(dataset_name, "Dataset")
    names.append(f"{base}.csv")
    if os.path.isdir(data_dir):
        prefix = f"{base}@".lower()
        for filename in os.listdir(data_dir):
            name_l = filename.lower()
            if not name_l.endswith(".csv"):
                continue
            if name_l == f"{base}.csv".lower() or name_l.startswith(prefix):
                names.append(filename)
    seen = set()
    out: List[str] = []
    for name in names:
        clean = os.path.basename(str(name or "").strip())
        key = clean.lower()
        if not clean or key in seen:
            continue
        seen.add(key)
        out.append(os.path.join(data_dir, clean))
    return out


def load_cached_dataset_values(project_name: str, reserving_class: str, dataset_name: str) -> Dict[str, Any]:
    p, rc, ds = _require_dataset_fields(project_name, reserving_class, dataset_name)
    sidecar_path = _get_dataset_sidecar_path(p, rc, ds)
    sidecar = _read_dataset_sidecar(sidecar_path)
    csv_path = ""
    for candidate in _cached_csv_candidates(p, rc, ds, sidecar):
        if os.path.exists(candidate) and os.path.isfile(candidate):
            csv_path = candidate
            break
    if not csv_path:
        raise HTTPException(404, f"Cached dataset CSV not found for '{ds}'.")
    try:
        df = pd.read_csv(csv_path, header=None)
    except PermissionError:
        raise HTTPException(423, "Dataset cache CSV is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to read dataset cache CSV: {str(err)}")
    except Exception as err:
        raise HTTPException(500, f"Invalid dataset cache CSV format: {str(err)}")
    df = df.astype(object).where(pd.notnull(df), None)
    values = df.values.tolist()
    return {
        "ok": True,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": str(sidecar.get("dataset_name") or ds),
        "dataset_type": str(sidecar.get("dataset_type") or ds),
        "data_format": str(sidecar.get("data_format") or ""),
        "origin_length": _int_or_default(sidecar.get("origin_length"), max(1, len(values))),
        "development_length": _int_or_default(sidecar.get("development_length"), max(1, len(values[0]) if values else 1)),
        "origin_labels": _normalize_origin_labels(sidecar.get("origin_labels")),
        "csv_file": os.path.basename(csv_path),
        "path": csv_path,
        "sidecar_path": sidecar_path,
        "values": values,
    }


def save_dataset_sidecar(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    *,
    dataset_type: str = "",
    instance_name: str = "",
    source_kind: str = "",
    data_format: str = "",
    origin_length: int,
    development_length: int,
    cumulative: bool = True,
    transposed: bool = False,
    calendar: bool = False,
    number_format: str = "",
    decimal_places: int = 1,
    origin_labels: List[str] | None = None,
    csv_file: str = "",
    method_type: str = "",
    status: int | None = None,
    precedents: List[str] | None = None,
    values: List[List[Any]] | None = None,
    mask: List[List[bool]] | None = None,
) -> Dict[str, Any]:
    p, rc, ds = _require_dataset_fields(project_name, reserving_class, dataset_name)
    if origin_length <= 0 or development_length <= 0:
        raise HTTPException(400, "origin_length and development_length must be positive.")

    path = _get_dataset_sidecar_path(p, rc, ds, csv_file=csv_file)
    existing = _read_dataset_sidecar(path)
    existing_precedents = dataset_sidecar_status_service.entry_names(existing.get("Precedents"))
    existing_dependents = existing.get("Dependents")
    created = str(existing.get("created") or "") if existing else ""
    if not created:
        created = _now_utc_iso()
    user_name = _current_user_name()
    dataset_type_value = str(dataset_type or existing.get("dataset_type") or ds)
    app_calculated, formula = _is_app_calculated_dataset_type(p, dataset_type_value)
    source_kind_value = str(source_kind or existing.get("source_kind") or ("calculated" if app_calculated else "input"))
    data_format_value = str(data_format or existing.get("data_format") or "Triangle")
    method_type_value = dataset_sidecar_status_service.normalize_method_type(method_type or existing.get("method_type"), source_kind_value)
    number_format_value = _normalize_number_format(number_format or existing.get("number_format") or "0,000")
    decimal_places_value = _normalize_decimal_places(decimal_places)
    if values is not None and app_calculated:
        raise HTTPException(400, "Calculated datasets cannot save editable grid values.")

    csv_path = ""
    csv_file_value = str(csv_file or existing.get("csv_file") or "")
    if values is not None:
        try:
            data_dir = config.get_project_dataset_cache_dir(p, rc)
        except ValueError as err:
            raise HTTPException(404, str(err))
        csv_stem = build_length_scoped_dataset_file_name(ds, origin_length, development_length, cumulative, calendar)
        csv_file_value = f"{csv_stem}.csv"
        csv_path = os.path.join(data_dir, csv_file_value)

    action_value = "Update" if existing else "Insert"
    updated_at = _now_utc_iso()
    payload = {
        **existing,
        "dataset_name": ds,
        "dataset_type": dataset_type_value,
        "reserving_class": rc,
        "project_name": p,
        "source_kind": source_kind_value,
        "data_format": data_format_value,
        "data_format_code": _data_format_code(data_format_value),
        "origin_length": int(origin_length),
        "development_length": int(development_length),
        "cumulative": bool(cumulative),
        "transposed": bool(transposed),
        "calendar": bool(calendar),
        "number_format": number_format_value,
        "decimal_places": decimal_places_value,
        "csv_file": csv_file_value,
        "calculated": True if app_calculated else (False if values is not None else existing.get("calculated")),
        "formula": formula or str(existing.get("formula") or ""),
        "method_type": method_type_value,
        "user": user_name,
        "created": created,
        "modified_by": user_name,
        "updated_at": updated_at,
    }
    if origin_labels is not None:
        payload["origin_labels"] = _normalize_origin_labels(origin_labels)
    _append_dataset_audit_entry(payload, action_value, event_date=updated_at, user_name=user_name)
    payload.pop("instance_name", None)
    payload.pop("dataset_type_name", None)
    from app_server.services import calculated_dataset_service

    calculated_dataset_service.apply_sidecar_graph_fields(payload, p, dataset_type_value)
    if existing_dependents:
        payload["Dependents"] = dataset_sidecar_status_service.merge_name_entries(
            existing_dependents,
            payload.get("Dependents"),
        )
    if precedents is not None:
        if method_type_value == dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION:
            payload["Precedents"] = _normalize_name_list(precedents)
        else:
            payload["Precedents"] = dataset_sidecar_status_service.name_entries(precedents)
    elif method_type_value == dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION:
        payload["Precedents"] = []
    elif method_type_value != dataset_sidecar_status_service.METHOD_TYPE_NONE and existing_precedents:
        payload["Precedents"] = dataset_sidecar_status_service.name_entries(existing_precedents)
    force_status = status
    if force_status is None and method_type_value != dataset_sidecar_status_service.METHOD_TYPE_NONE:
        force_status = existing.get("status")
    dataset_sidecar_status_service.apply_status_fields(
        payload,
        p,
        rc,
        ds,
        path=path,
        method_type=method_type_value,
        force_status=force_status,
    )
    if values is not None:
        df = _dataset_values_to_frame(values, mask)
        try:
            atomic_write_csv(df, csv_path)
        except PermissionError:
            raise HTTPException(423, "Dataset cache CSV is locked or inaccessible.")
        except OSError as err:
            raise HTTPException(500, f"Failed to write dataset cache CSV: {str(err)}")
    _write_dataset_sidecar_payload(path, payload)
    ds_id = ""
    file_mtime = None
    if csv_path:
        ds_id = "arcrhotri_" + hashlib.sha1(csv_path.encode("utf-8")).hexdigest()[:16]
        config.DATASETS[ds_id] = csv_path
        try:
            file_mtime = os.stat(csv_path).st_mtime
        except OSError:
            file_mtime = None
    if precedents is not None:
        dataset_sidecar_status_service.update_precedent_dependents(
            p,
            rc,
            ds,
            existing_precedents,
            precedents,
        )
    status_updates = dataset_sidecar_status_service.refresh_method_statuses_for_dependents(p, rc, [ds])

    try:
        dataset_instance_index_service.rebuild_index(p, rc)
    except Exception:
        pass
    calculated_updates = None
    try:
        calculated_updates = calculated_dataset_service.recalculate_dependents(p, rc, ds, dataset_type_value)
    except Exception as err:
        calculated_updates = {"ok": False, "skipped": True, "reason": str(err)}
    return {
        "ok": True,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": ds,
        "dataset_type": payload["dataset_type"],
        "instance_name": ds,
        "origin_length": payload["origin_length"],
        "development_length": payload["development_length"],
        "origin_labels": _normalize_origin_labels(payload.get("origin_labels")),
        "cumulative": payload["cumulative"],
        "transposed": payload["transposed"],
        "calendar": payload["calendar"],
        "number_format": payload["number_format"],
        "decimal_places": payload["decimal_places"],
        "csv_file": payload["csv_file"],
        "source_kind": payload["source_kind"],
        "method_type": payload["method_type"],
        "status": payload["status"],
        "Precedents": _sidecar_graph_entries(p, rc, payload.get("Precedents"), include_method_type=True),
        "Dependents": _sidecar_graph_entries(p, rc, payload.get("Dependents"), include_formula=True),
        "updated_at": payload["updated_at"],
        "audit_log": payload["audit_log"],
        "path": path,
        "csv_path": csv_path,
        "ds_id": ds_id,
        "file_mtime": file_mtime,
        "calculated_updates": calculated_updates,
        "status_updates": status_updates,
    }


def load_dataset_notes(project_name: str, reserving_class: str, dataset_name: str) -> Dict[str, Any]:
    p, rc, ds = _require_notes_fields(project_name, reserving_class, dataset_name)
    dataset_id = _build_notes_dataset_id(p, rc, ds)
    path = _get_notes_file_path(p, rc, dataset_id)

    if not os.path.exists(path):
        return {
            "ok": True,
            "exists": False,
            "dataset_id": dataset_id,
            "project_name": p,
            "reserving_class": rc,
            "dataset_name": ds,
            "notes": "",
            "path": path,
        }

    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except PermissionError:
        raise HTTPException(423, "Notes file is locked or inaccessible.")
    except OSError as err:
        raise HTTPException(500, f"Failed to read notes file: {str(err)}")
    except json.JSONDecodeError as err:
        raise HTTPException(500, f"Invalid notes JSON format: {str(err)}")

    notes = payload.get("notes", "")
    return {
        "ok": True,
        "exists": True,
        "dataset_id": str(payload.get("dataset_id") or dataset_id),
        "project_name": str(payload.get("project_name") or p),
        "reserving_class": str(payload.get("reserving_class") or rc),
        "dataset_name": str(payload.get("dataset_name") or ds),
        "notes": str(notes if notes is not None else ""),
        "updated_at": str(payload.get("updated_at") or ""),
        "path": path,
    }


def save_dataset_notes(project_name: str, reserving_class: str, dataset_name: str, notes: str) -> Dict[str, Any]:
    p, rc, ds = _require_notes_fields(project_name, reserving_class, dataset_name)
    dataset_id = _build_notes_dataset_id(p, rc, ds)
    path = _get_notes_file_path(p, rc, dataset_id)
    data_dir = os.path.dirname(path)
    payload = {
        "dataset_id": dataset_id,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": ds,
        "notes": str(notes if notes is not None else ""),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }

    tmp_path = f"{path}.tmp"
    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
    except PermissionError:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise HTTPException(423, "Notes file is locked or inaccessible.")
    except OSError as err:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise HTTPException(500, f"Failed to write notes file: {str(err)}")

    return {
        "ok": True,
        "dataset_id": dataset_id,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": ds,
        "notes": payload["notes"],
        "updated_at": payload["updated_at"],
        "path": path,
    }


def patch_dataset(ds_id: str, items: list, file_mtime: float = None) -> Dict[str, Any]:
    path = config.DATASETS.get(ds_id)
    if not path or not os.path.exists(path):
        return None

    st = os.stat(path)
    if file_mtime is not None and abs(st.st_mtime - file_mtime) > 1e-6:
        return {"conflict": True}

    df = load_triangle_values(path)
    n_origin, n_dev = df.shape
    mask = _dataset_patch_mask(path, n_origin, n_dev)

    applied = 0
    rejected: List[Dict[str, Any]] = []

    for it in items:
        r, c = it.r, it.c
        if r >= n_origin or c >= n_dev:
            rejected.append({"r": r, "c": c, "reason": "out_of_range"})
            continue
        if not mask[r, c]:
            rejected.append({"r": r, "c": c, "reason": "outside_triangle"})
            continue

        df.iat[r, c] = np.nan if it.value is None else float(it.value)
        applied += 1

    atomic_write_csv(df, path)
    st2 = os.stat(path)
    if applied > 0:
        sidecar_path = dataset_instance_index_service._dataset_sidecar_path_for_cached_csv(path)
        sidecar_payload = _read_dataset_sidecar(sidecar_path)
        if sidecar_payload:
            audit_at = _now_utc_iso()
            user_name = _current_user_name()
            sidecar_payload["updated_at"] = audit_at
            sidecar_payload["modified_by"] = user_name
            sidecar_payload["user"] = user_name
            _append_dataset_audit_entry(sidecar_payload, "Update", event_date=audit_at, user_name=user_name)
            dataset_name = str(sidecar_payload.get("dataset_name") or sidecar_payload.get("dataset_type") or "").strip()
            if dataset_name:
                dataset_sidecar_status_service.apply_status_fields(
                    sidecar_payload,
                    str(sidecar_payload.get("project_name") or ""),
                    str(sidecar_payload.get("reserving_class") or ""),
                    dataset_name,
                    path=sidecar_path,
                )
            _write_dataset_sidecar_payload(sidecar_path, sidecar_payload)
            try:
                dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                    str(sidecar_payload.get("project_name") or ""),
                    str(sidecar_payload.get("reserving_class") or ""),
                    [sidecar_payload.get("dataset_name") or sidecar_payload.get("dataset_type")],
                )
            except Exception:
                pass
    calculated_updates = None
    try:
        from app_server.services import calculated_dataset_service

        calculated_updates = calculated_dataset_service.recalculate_dependents_for_csv(path)
    except Exception as err:
        calculated_updates = {"ok": False, "skipped": True, "reason": str(err)}

    return {"ok": True, "applied": applied, "rejected": rejected, "mtime": st2.st_mtime, "calculated_updates": calculated_updates}
