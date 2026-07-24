"""Project-scoped, dataset-aware source vocabulary caching."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from datetime import datetime
from typing import Any, Dict, List, Tuple

import pandas as pd

from app_server import config


_CACHE_LOCKS_GUARD = threading.Lock()
_CACHE_LOCKS: Dict[str, threading.Lock] = {}
_CACHE_LOCK_TIMEOUT_SECONDS = 5.0
_CSV_CHUNK_SIZE = 50_000


class DataProcessingValuesLockedError(RuntimeError):
    """Raised when the vocabulary cache cannot be read or replaced safely."""


class SourceTableChangedError(RuntimeError):
    """Raised when the source table changes repeatedly during a cache refresh."""


def _utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _lock_for_path(path: str) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(path))
    with _CACHE_LOCKS_GUARD:
        lock = _CACHE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _CACHE_LOCKS[key] = lock
        return lock


def _read_json_object(path: str) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return {}
    except PermissionError as error:
        raise DataProcessingValuesLockedError(
            f"Data-processing vocabulary input is locked: {path}"
        ) from error
    except json.JSONDecodeError:
        return {}
    return raw if isinstance(raw, dict) else {}


def _hash_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _mapping_contract(mapping: Dict[str, Any]) -> Dict[str, Any]:
    rows = mapping.get("rows") if isinstance(mapping.get("rows"), list) else []
    key_fields: List[Dict[str, Any]] = []
    dataset_fields: List[Dict[str, str]] = []
    seen_keys: set[str] = set()
    seen_datasets: set[str] = set()

    for row in rows:
        if not isinstance(row, dict):
            continue
        field = str(row.get("field_name") or "").strip()
        significance = str(row.get("significance") or "").strip().casefold()
        if not field:
            continue
        field_key = field.casefold()
        if significance == "reserving class" and field_key not in seen_keys:
            try:
                level: Any = int(row.get("level"))
            except (TypeError, ValueError):
                level = None
            seen_keys.add(field_key)
            key_fields.append({"field": field, "level": level})
        elif significance == "dataset" and field_key not in seen_datasets:
            seen_datasets.add(field_key)
            dataset_fields.append({
                "source_measure": field,
                "dataset_type": str(row.get("dataset_type") or field).strip() or field,
            })

    signature_payload = {
        "key_fields": key_fields,
        "dataset_fields": dataset_fields,
    }
    return {
        **signature_payload,
        "mapping_signature": _hash_json(signature_payload),
    }


def _source_table_fingerprint(table_path: str) -> Dict[str, Any]:
    clean_path = str(table_path or "").strip()
    normalized_path = (
        os.path.normcase(os.path.normpath(os.path.abspath(clean_path)))
        if clean_path
        else ""
    )
    fingerprint: Dict[str, Any] = {
        "path": normalized_path,
        "exists": False,
        "mtime_ns": None,
        "size": None,
    }
    if not clean_path:
        return fingerprint
    try:
        stat = os.stat(clean_path)
    except FileNotFoundError:
        return fingerprint
    except PermissionError as error:
        raise DataProcessingValuesLockedError(
            f"Source table is locked and could not be fingerprinted: {clean_path}"
        ) from error
    fingerprint.update({
        "exists": os.path.isfile(clean_path),
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    })
    return fingerprint


def _current_inputs(project_name: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    mapping = _read_json_object(config.get_field_mapping_path(project_name))
    contract = _mapping_contract(mapping)
    contract["table_path"] = str(mapping.get("table_path") or "").strip()
    fingerprint = _source_table_fingerprint(contract["table_path"])
    return contract, fingerprint


def _cache_is_current(
    payload: Dict[str, Any],
    contract: Dict[str, Any],
    fingerprint: Dict[str, Any],
) -> bool:
    if not (
        payload
        and payload.get("json_format") == config.DATA_PROCESSING_VALUES_CACHE_FORMAT
        and payload.get("source_table_fingerprint") == fingerprint
        and payload.get("mapping_signature") == contract.get("mapping_signature")
        and payload.get("key_fields") == contract.get("key_fields")
        and payload.get("dataset_fields") == contract.get("dataset_fields")
        and isinstance(payload.get("datasets"), dict)
        and isinstance(payload.get("combination_sets"), dict)
        and isinstance(payload.get("missing_columns"), list)
    ):
        return False

    datasets = payload["datasets"]
    combination_sets = payload["combination_sets"]
    dataset_fields = list(contract.get("dataset_fields") or [])
    expected_measures = {
        str(item.get("source_measure") or "")
        for item in dataset_fields
        if str(item.get("source_measure") or "")
    }
    if set(datasets) != expected_measures:
        return False

    key_field_count = len(contract.get("key_fields") or [])
    for item in dataset_fields:
        measure = str(item.get("source_measure") or "")
        if not measure:
            continue
        dataset = datasets.get(measure)
        if not isinstance(dataset, dict):
            return False
        if dataset.get("dataset_type") != item.get("dataset_type"):
            return False
        row_count = dataset.get("row_count")
        if isinstance(row_count, bool) or not isinstance(row_count, int) or row_count < 0:
            return False
        combination_set_id = dataset.get("combination_set_id")
        if (
            not isinstance(combination_set_id, str)
            or not combination_set_id
        ):
            return False
        combinations = combination_sets.get(combination_set_id)
        if (
            not isinstance(combinations, list)
            or any(
                not isinstance(combination, list)
                or len(combination) != key_field_count
                or any(not isinstance(value, str) for value in combination)
                for combination in combinations
            )
        ):
            return False
    return True


def _sorted_combinations(values: set[Tuple[str, ...]]) -> List[List[str]]:
    return [
        list(value)
        for value in sorted(
            values,
            key=lambda item: tuple(part.casefold() for part in item),
        )
    ]


def _empty_dataset_payloads(dataset_fields: List[Dict[str, str]]) -> Dict[str, Any]:
    return {
        str(item.get("source_measure") or ""): {
            "dataset_type": str(item.get("dataset_type") or ""),
            "row_count": 0,
            "combination_set_id": "",
        }
        for item in dataset_fields
        if str(item.get("source_measure") or "")
    }


def _build_cache_payload(
    contract: Dict[str, Any],
    fingerprint: Dict[str, Any],
) -> Dict[str, Any]:
    key_fields = list(contract.get("key_fields") or [])
    dataset_fields = list(contract.get("dataset_fields") or [])
    datasets = _empty_dataset_payloads(dataset_fields)
    key_names = [str(item.get("field") or "") for item in key_fields]
    measure_names = [
        str(item.get("source_measure") or "")
        for item in dataset_fields
        if str(item.get("source_measure") or "")
    ]
    required_columns = list(dict.fromkeys(key_names + measure_names))
    missing_columns = list(required_columns)
    table_path = str(contract.get("table_path") or "")

    combinations_by_measure: Dict[str, set[Tuple[str, ...]]] = {
        measure: set() for measure in measure_names
    }
    combination_sets: Dict[str, List[List[str]]] = {}
    if fingerprint.get("exists"):
        try:
            header = pd.read_csv(
                table_path,
                nrows=0,
                dtype=str,
                keep_default_na=False,
            )
            available_columns = {str(column) for column in header.columns}
        except pd.errors.EmptyDataError:
            available_columns = set()
        except PermissionError as error:
            raise DataProcessingValuesLockedError(
                f"Source table is locked and could not be read: {table_path}"
            ) from error

        missing_columns = [
            column for column in required_columns if column not in available_columns
        ]
        selected_columns = [
            column for column in required_columns if column in available_columns
        ]
        if selected_columns:
            try:
                chunks = pd.read_csv(
                    table_path,
                    usecols=selected_columns,
                    dtype=str,
                    keep_default_na=False,
                    chunksize=_CSV_CHUNK_SIZE,
                )
                for chunk in chunks:
                    for measure in measure_names:
                        if measure not in chunk.columns:
                            continue
                        active = chunk[measure].astype(str).str.strip().ne("")
                        datasets[measure]["row_count"] += int(active.sum())
                        if not key_names or any(name not in chunk.columns for name in key_names):
                            continue
                        key_rows = chunk.loc[active, key_names]
                        for row in key_rows.itertuples(index=False, name=None):
                            combination = tuple(str(value).strip() for value in row)
                            if len(combination) == len(key_names) and all(combination):
                                combinations_by_measure[measure].add(combination)
            except pd.errors.EmptyDataError:
                pass
            except PermissionError as error:
                raise DataProcessingValuesLockedError(
                    f"Source table is locked and could not be read: {table_path}"
                ) from error

    for measure, combinations in combinations_by_measure.items():
        values = _sorted_combinations(combinations)
        combination_set_id = _hash_json(values)
        datasets[measure]["combination_set_id"] = combination_set_id
        combination_sets.setdefault(combination_set_id, values)

    return {
        "json_format": config.DATA_PROCESSING_VALUES_CACHE_FORMAT,
        "updated_at": _utc_now(),
        "source_table_fingerprint": fingerprint,
        "mapping_signature": str(contract.get("mapping_signature") or ""),
        "key_fields": key_fields,
        "dataset_fields": dataset_fields,
        "missing_columns": missing_columns,
        "combination_sets": combination_sets,
        "datasets": datasets,
    }


def _build_stable_cache(project_name: str) -> Dict[str, Any]:
    for attempt in range(2):
        contract, before = _current_inputs(project_name)
        payload = _build_cache_payload(contract, before)
        after_contract, after = _current_inputs(project_name)
        if (
            before == after
            and contract.get("mapping_signature") == after_contract.get("mapping_signature")
        ):
            return payload
        if attempt == 0:
            continue
    raise SourceTableChangedError(
        "Source table or Field Mapping changed repeatedly while building the "
        "data-processing vocabulary cache. Please retry."
    )


def _atomic_write_cache(path: str, payload: Dict[str, Any]) -> None:
    temporary_path = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(temporary_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary_path, path)
    except PermissionError as error:
        raise DataProcessingValuesLockedError(
            "Data-processing vocabulary cache is locked and could not be replaced. "
            "Please retry."
        ) from error
    finally:
        try:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        except OSError:
            pass


def get_data_processing_values(project_name: str) -> Dict[str, Any]:
    """Return a current vocabulary cache, refreshing it atomically when stale."""
    cache_path = config.get_data_processing_values_path(project_name)
    contract, fingerprint = _current_inputs(project_name)
    existing = _read_json_object(cache_path)
    if _cache_is_current(existing, contract, fingerprint):
        return existing

    lock = _lock_for_path(cache_path)
    if not lock.acquire(timeout=_CACHE_LOCK_TIMEOUT_SECONDS):
        raise DataProcessingValuesLockedError(
            "Data-processing vocabulary cache is being refreshed by another request. "
            "Please retry."
        )
    try:
        # A request waiting on the in-process lock should reuse the cache written by
        # its predecessor instead of scanning the source table a second time.
        contract, fingerprint = _current_inputs(project_name)
        existing = _read_json_object(cache_path)
        if _cache_is_current(existing, contract, fingerprint):
            return existing
        payload = _build_stable_cache(project_name)
        _atomic_write_cache(cache_path, payload)
        return payload
    finally:
        lock.release()


def source_vocabulary_options(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return the path-free v1 editor response from the compact v2 cache."""
    combination_sets = (
        payload.get("combination_sets")
        if isinstance(payload.get("combination_sets"), dict)
        else {}
    )
    datasets: Dict[str, Any] = {}
    raw_datasets = payload.get("datasets")
    if isinstance(raw_datasets, dict):
        for source_measure, raw_dataset in raw_datasets.items():
            if not isinstance(raw_dataset, dict):
                continue
            combination_set_id = str(raw_dataset.get("combination_set_id") or "")
            raw_combinations = combination_sets.get(combination_set_id)
            combinations = (
                [list(combination) for combination in raw_combinations]
                if isinstance(raw_combinations, list)
                else []
            )
            datasets[str(source_measure)] = {
                "dataset_type": str(raw_dataset.get("dataset_type") or ""),
                "row_count": raw_dataset.get("row_count", 0),
                "combination_count": len(combinations),
                "combinations": combinations,
            }
    return {
        "json_format": config.DATA_PROCESSING_VALUES_FORMAT,
        "key_fields": list(payload.get("key_fields") or []),
        "datasets": datasets,
        "missing_columns": list(payload.get("missing_columns") or []),
    }
