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
from app_server.helpers import sanitize_reserving_class_folder
from app_server.services import dataset_instance_index_service


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
    return (c <= r)


def diagonal_indices(n_origin: int, n_dev: int, k: int = 0) -> List[Tuple[int, int]]:
    mask = triangle_mask(n_origin, n_dev)
    out = []
    for r in range(n_origin):
        c = r - k
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


def list_cached_dataset_names(project_name: str, reserving_class: str) -> Dict[str, Any]:
    project = str(project_name if project_name is not None else "").strip()
    rc = str(reserving_class if reserving_class is not None else "").strip()
    if not project or not rc:
        raise HTTPException(400, "project_name and reserving_class are required.")
    return dataset_instance_index_service.get_cached_dataset_index(project, rc)


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


def _empty_dataset_values(data_format: str, origin_length: int, development_length: int) -> pd.DataFrame:
    fmt = str(data_format or "").strip().lower()
    n_origin = max(1, int(origin_length))
    n_dev = 1 if fmt == "vector" else max(1, int(development_length))
    values = np.zeros((n_origin, n_dev), dtype="float64")
    if fmt != "vector":
        values = np.where(triangle_mask(n_origin, n_dev), 0.0, np.nan)
    return pd.DataFrame(values)


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


def _empty_dataset_shape_from_general_settings(
    project_name: str,
    origin_period_length: int,
    development_period_length: int,
) -> tuple[int, int]:
    try:
        path = config.get_general_settings_path(project_name)
    except ValueError:
        return 12, 12
    if not os.path.exists(path):
        return 12, 12
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        return 12, 12
    origin_start = payload.get("origin_start_date", "")
    origin_end = payload.get("origin_end_date", "")
    development_end = payload.get("development_end_date", "")
    origin_count = _period_count(origin_start, origin_end, origin_period_length)
    development_count = _period_count(origin_start, development_end, development_period_length, fallback=origin_count)
    return origin_count, development_count


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
        data_dir = config.get_project_generated_data_dir(p)
    except ValueError as err:
        raise HTTPException(404, str(err))

    origin_period_len = max(1, int(origin_length))
    dev_period_len = max(1, int(development_length))
    origin_count, dev_count = _empty_dataset_shape_from_general_settings(p, origin_period_len, dev_period_len)
    fmt = str(data_format or "Triangle").strip() or "Triangle"
    rc_folder = sanitize_reserving_class_folder(rc)
    folder = os.path.join(data_dir, rc_folder)
    csv_stem = build_length_scoped_dataset_file_name(instance, origin_period_len, dev_period_len, cumulative, calendar)
    csv_path = os.path.join(folder, f"{csv_stem}.csv")
    sidecar_path = os.path.join(folder, f"{sanitize_dataset_file_name(instance)}.json")
    now = _now_utc_iso()
    user_name = getpass.getuser()

    df = _empty_dataset_values(fmt, origin_count, dev_count)
    payload = {
        "dataset_name": instance,
        "dataset_type": ds_type,
        "instance_name": instance,
        "reserving_class": rc,
        "project_name": p,
        "storage": "generated",
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
        "editable": True,
        "generated": False,
    }

    tmp_sidecar = f"{sidecar_path}.{uuid.uuid4()}.tmp"
    try:
        os.makedirs(folder, exist_ok=True)
        atomic_write_csv(df, csv_path)
        with open(tmp_sidecar, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp_sidecar, sidecar_path)
    except PermissionError:
        try:
            if os.path.exists(tmp_sidecar):
                os.remove(tmp_sidecar)
        except OSError:
            pass
        raise HTTPException(423, "Dataset cache file is locked or inaccessible.")
    except OSError as err:
        try:
            if os.path.exists(tmp_sidecar):
                os.remove(tmp_sidecar)
        except OSError:
            pass
        raise HTTPException(500, f"Failed to create empty dataset cache: {str(err)}")

    try:
        dataset_instance_index_service.rebuild_index(p, rc)
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
        data_dir = config.get_project_manual_data_dir(project_name)
    except ValueError as err:
        raise HTTPException(404, str(err))
    rc_folder = sanitize_reserving_class_folder(reserving_class)
    return os.path.join(data_dir, rc_folder, f"{dataset_id}.json")


def _require_dataset_fields(project_name: str, reserving_class: str, dataset_name: str) -> Tuple[str, str, str]:
    p = str(project_name if project_name is not None else "")
    rc = str(reserving_class if reserving_class is not None else "")
    ds = str(dataset_name if dataset_name is not None else "")
    if not p.strip() or not rc.strip() or not ds.strip():
        raise HTTPException(400, "project_name, reserving_class, and dataset_name are required.")
    return p, rc, ds


def _get_dataset_sidecar_path(project_name: str, reserving_class: str, dataset_name: str) -> str:
    try:
        data_dir = config.get_project_generated_data_dir(project_name)
    except ValueError as err:
        raise HTTPException(404, str(err))
    rc_folder = sanitize_reserving_class_folder(reserving_class)
    ds_file = sanitize_dataset_file_name(dataset_name)
    return os.path.join(data_dir, rc_folder, f"{ds_file}.json")


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
    return {
        "ok": True,
        "exists": True,
        "project_name": str(payload.get("project_name") or p),
        "reserving_class": str(payload.get("reserving_class") or rc),
        "dataset_name": str(payload.get("dataset_name") or ds),
        "dataset_type": str(payload.get("dataset_type") or payload.get("dataset_type_name") or ds),
        "instance_name": str(payload.get("instance_name") or payload.get("dataset_name") or ds),
        "origin_length": payload.get("origin_length"),
        "development_length": payload.get("development_length"),
        "cumulative": payload.get("cumulative"),
        "calendar": payload.get("calendar"),
        "csv_file": str(payload.get("csv_file") or ""),
        "user": str(payload.get("user") or ""),
        "modified_by": str(payload.get("modified_by") or ""),
        "created": str(payload.get("created") or ""),
        "updated_at": str(payload.get("updated_at") or ""),
        "path": path,
    }


def save_dataset_sidecar(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    *,
    dataset_type: str = "",
    instance_name: str = "",
    origin_length: int,
    development_length: int,
    cumulative: bool = True,
    calendar: bool = False,
    csv_file: str = "",
) -> Dict[str, Any]:
    p, rc, ds = _require_dataset_fields(project_name, reserving_class, dataset_name)
    if origin_length <= 0 or development_length <= 0:
        raise HTTPException(400, "origin_length and development_length must be positive.")

    path = _get_dataset_sidecar_path(p, rc, ds)
    existing = _read_dataset_sidecar(path)
    created = str(existing.get("created") or "") if existing else ""
    if not created:
        created = _now_utc_iso()
    user_name = getpass.getuser()
    payload = {
        **existing,
        "dataset_name": ds,
        "dataset_type": str(dataset_type or existing.get("dataset_type") or existing.get("dataset_type_name") or ds),
        "instance_name": str(instance_name or existing.get("instance_name") or ds),
        "reserving_class": rc,
        "project_name": p,
        "storage": "generated",
        "data_format": str(existing.get("data_format") or "Triangle"),
        "data_format_code": _int_or_default(existing.get("data_format_code"), 0),
        "origin_length": int(origin_length),
        "development_length": int(development_length),
        "cumulative": bool(cumulative),
        "calendar": bool(calendar),
        "csv_file": str(csv_file or existing.get("csv_file") or ""),
        "user": user_name,
        "created": created,
        "modified_by": user_name,
        "updated_at": _now_utc_iso(),
    }
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

    try:
        dataset_instance_index_service.rebuild_index(p, rc)
    except Exception:
        pass
    return {
        "ok": True,
        "project_name": p,
        "reserving_class": rc,
        "dataset_name": ds,
        "dataset_type": payload["dataset_type"],
        "instance_name": payload["instance_name"],
        "origin_length": payload["origin_length"],
        "development_length": payload["development_length"],
        "cumulative": payload["cumulative"],
        "calendar": payload["calendar"],
        "csv_file": payload["csv_file"],
        "updated_at": payload["updated_at"],
        "path": path,
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
    mask = triangle_mask(n_origin, n_dev)

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

    return {"ok": True, "applied": applied, "rejected": rejected, "mtime": st2.st_mtime}
