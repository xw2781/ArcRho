"""Persist, load, preview, and eagerly refresh self-contained DFM methods."""
from __future__ import annotations

import getpass
import json
import math
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Tuple

import pandas as pd
from fastapi import HTTPException

from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    LEGACY_DFM_JSON_FORMAT,
    DfmContractError,
    apply_owned_patch,
    build_dfm_output_sidecar,
    dfm_output_variants,
    method_revisions,
    normalize_dfm_method,
    persisted_projection,
    preview_dfm_method as canonical_preview_dfm_method,
    recalculate_dfm_method,
)
from arcrho_api.io import persisted_json_text
from app_server import config
from app_server.helpers import sanitize_dataset_file_name
from app_server.services import dataset_sidecar_status_service


READ_MAX_WORKERS = 4
_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=READ_MAX_WORKERS,
    thread_name_prefix="arcrho-dfm-read",
)
SnapshotCacheKey = Tuple[str, bool, Tuple[str, ...], Tuple[str, ...], int, int]


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _key(value: Any) -> str:
    return " ".join(_clean(value).lower().split())


def _axis_labels(values: Any) -> List[str]:
    if values is None or isinstance(values, (str, bytes, Mapping)):
        return []
    try:
        return [str(item if item is not None else "") for item in values]
    except TypeError:
        return []


def _positive_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="microseconds") + "Z"


def _lock(project_name: str, reserving_class: str) -> threading.RLock:
    return dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class)


def _method_path(project_name: str, reserving_class: str, method_name: str) -> str:
    filename = f"DFM@{sanitize_dataset_file_name(method_name, 'Name')}.json"
    return os.path.join(config.get_project_method_data_dir(project_name, reserving_class), filename)


def _sidecar_path(project_name: str, reserving_class: str, output_dataset: str) -> str:
    return dataset_sidecar_status_service.sidecar_path(project_name, reserving_class, output_dataset)


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except PermissionError as exc:
        raise HTTPException(423, f"DFM file is locked or inaccessible: {os.path.basename(path)}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, f"Invalid DFM JSON: {os.path.basename(path)}: {exc}") from exc
    return payload if isinstance(payload, dict) else {}


def _json_text(payload: Mapping[str, Any]) -> str:
    return persisted_json_text(payload)


def _method_json_text(payload: Mapping[str, Any]) -> str:
    """Serialize a DFM method through the canonical on-disk projection.

    Every method-file write and every unchanged-file comparison must go through
    here, so a file is only rewritten when its persisted content really differs.
    """
    return _json_text(persisted_projection(payload))


def _read_bytes_if_file(path: str) -> bytes | None:
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()


def _commit_text_files(files: Mapping[str, str], *, last_paths: Iterable[str] = ()) -> List[str]:
    """Atomically replace changed files, rolling back all replacements on failure."""

    last_keys = {os.path.normcase(os.path.abspath(path)) for path in last_paths}
    changed = {
        path: value
        for path, value in files.items()
        if _read_bytes_if_file(path) != value.encode("utf-8")
    }
    ordered_paths = sorted(
        changed,
        key=lambda path: (
            os.path.normcase(os.path.abspath(path)) in last_keys,
            os.path.normcase(path),
        ),
    )
    staged: Dict[str, str] = {}
    backups: Dict[str, bytes | None] = {}
    replaced: List[str] = []
    try:
        for path in ordered_paths:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            backups[path] = _read_bytes_if_file(path)
            temporary = f"{path}.{uuid.uuid4()}.tmp"
            with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(changed[path])
            staged[path] = temporary
        for path in ordered_paths:
            os.replace(staged.pop(path), path)
            replaced.append(path)
    except Exception as exc:
        rollback_errors: List[str] = []
        for path in reversed(replaced):
            original = backups.get(path)
            try:
                if original is None:
                    if os.path.exists(path):
                        os.remove(path)
                    continue
                temporary = f"{path}.{uuid.uuid4()}.rollback"
                with open(temporary, "wb") as handle:
                    handle.write(original)
                os.replace(temporary, path)
            except OSError as rollback_exc:
                rollback_errors.append(f"{os.path.basename(path)}: {rollback_exc}")
        if rollback_errors:
            raise RuntimeError(f"{exc}; DFM rollback failed: {'; '.join(rollback_errors)}") from exc
        raise
    finally:
        for temporary in staged.values():
            try:
                os.remove(temporary)
            except OSError:
                pass
    return replaced


def _contract_call(func, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    try:
        result = func(*args, **kwargs)
    except DfmContractError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not isinstance(result, dict):
        raise HTTPException(500, "Canonical DFM calculation returned an invalid payload.")
    return result


def _details(payload: Mapping[str, Any]) -> Dict[str, Any]:
    value = payload.get("details tab") if isinstance(payload, Mapping) else None
    return value if isinstance(value, dict) else {}


def _data_tab(payload: Mapping[str, Any]) -> Dict[str, Any]:
    value = payload.get("data tab") if isinstance(payload, Mapping) else None
    return value if isinstance(value, dict) else {}


def _results_tab(payload: Mapping[str, Any]) -> Dict[str, Any]:
    value = payload.get("results tab") if isinstance(payload, Mapping) else None
    return value if isinstance(value, dict) else {}


def _identity(payload: Mapping[str, Any]) -> Tuple[str, str]:
    details = _details(payload)
    method_name = _clean(details.get("name"))
    output_dataset = _clean(details.get("output dataset")) or method_name
    if not method_name or not output_dataset:
        raise HTTPException(422, "DFM name and output dataset are required.")
    return method_name, output_dataset


def _precedent_names(payload: Mapping[str, Any]) -> List[str]:
    details = _details(payload)
    results = _results_tab(payload)
    names = [
        _clean(details.get("input triangle")),
        _clean(results.get("ratio basis dataset")),
    ]
    out: List[str] = []
    seen = set()
    for name in names:
        normalized = _key(name)
        if normalized and normalized not in seen:
            seen.add(normalized)
            out.append(name)
    return out


def _revision_response(payload: Mapping[str, Any]) -> Dict[str, str]:
    revisions = method_revisions(payload)
    owned = _clean(revisions.get("owned revision"))
    derived = _clean(revisions.get("derived revision"))
    publication = _clean(revisions.get("publication revision"))
    return {
        "owned_revision": owned,
        "derived_revision": derived,
        "publication_revision": publication,
        "method_revision": publication,
    }


def _sidecar_response(payload: Mapping[str, Any], *, exists: bool) -> Dict[str, Any]:
    if not exists:
        return {"exists": False, "notes": "", "audit_log": []}
    return {**dict(payload), "exists": True}


def _load_source_snapshot(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    *,
    vector: bool,
    allow_review_needed: bool = False,
    canonical_origin_labels: Iterable[Any] = (),
    canonical_development_labels: Iterable[Any] = (),
    expected_origin_length: int = 0,
    expected_development_length: int = 0,
) -> Dict[str, Any]:
    sidecar_path = _sidecar_path(project_name, reserving_class, dataset_name)
    sidecar = _read_json(sidecar_path)
    if not sidecar:
        raise HTTPException(404, f"DFM precedent sidecar is missing: {dataset_name}")
    source_method_type = dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"), sidecar.get("source_kind")
    )
    source_status = dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
    if not allow_review_needed \
            and source_method_type != dataset_sidecar_status_service.METHOD_TYPE_NONE \
            and source_status == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED:
        raise HTTPException(409, f"DFM precedent requires review: {dataset_name}")
    data_format = _clean(sidecar.get("data_format")) or "Triangle"
    is_vector = data_format.lower() == "vector"
    if not vector and is_vector:
        raise HTTPException(422, f"DFM input '{dataset_name}' must be a Triangle dataset.")
    source_origin_length = _positive_int(
        sidecar.get("period_length") if is_vector else sidecar.get("origin_length")
    )
    required_origin_length = _positive_int(expected_origin_length)
    if source_origin_length and required_origin_length \
            and source_origin_length != required_origin_length:
        raise HTTPException(
            422,
            f"DFM precedent '{dataset_name}' has incompatible origin period length "
            f"({source_origin_length}; expected {required_origin_length}).",
        )
    source_development_length = _positive_int(sidecar.get("development_length"))
    required_development_length = _positive_int(expected_development_length)
    if not vector and source_development_length and required_development_length \
            and source_development_length != required_development_length:
        raise HTTPException(
            422,
            f"DFM input '{dataset_name}' has incompatible development period length "
            f"({source_development_length}; expected {required_development_length}).",
        )
    csv_file = os.path.basename(_clean(sidecar.get("csv_file")))
    if not csv_file:
        raise HTTPException(422, f"DFM precedent '{dataset_name}' does not identify its cache CSV.")
    data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    csv_path = os.path.join(data_dir, csv_file)
    try:
        frame = pd.read_csv(csv_path, header=None).astype(object)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"DFM precedent CSV is missing: {dataset_name}") from exc
    except PermissionError as exc:
        raise HTTPException(423, f"DFM precedent CSV is locked: {dataset_name}") from exc
    except Exception as exc:
        raise HTTPException(422, f"DFM precedent CSV is invalid: {dataset_name}: {exc}") from exc
    frame = frame.where(pd.notnull(frame), None)
    raw_values = frame.values.tolist()
    method_origin_labels = _axis_labels(canonical_origin_labels)
    origin_labels = method_origin_labels or _axis_labels(sidecar.get("origin_labels"))
    if len(origin_labels) != len(raw_values):
        raise HTTPException(
            422,
            f"DFM precedent '{dataset_name}' has {len(raw_values)} rows; "
            f"expected {len(origin_labels)}.",
        )
    try:
        decimal_places = int(sidecar.get("decimal_places") or 0)
    except (TypeError, ValueError):
        decimal_places = 0
    if vector:
        if is_vector:
            values = [row[0] if isinstance(row, list) and row else None for row in raw_values]
        else:
            # Triangle Ratio Basis follows the UI rule: latest available diagonal
            # value for each exact origin label.
            values = []
            for row in raw_values:
                latest = None
                for value in reversed(row if isinstance(row, list) else []):
                    if value is not None:
                        latest = value
                        break
                values.append(latest)
        snapshot: Dict[str, Any] = {
            "name": _clean(sidecar.get("dataset_name")) or dataset_name,
            "data_format": data_format,
            "origin_labels": origin_labels,
            "values": values,
            "number_format": _clean(sidecar.get("number_format")) or "#,##0",
            "decimal_places": decimal_places,
        }
    else:
        column_count = max((len(row) for row in raw_values), default=0)
        method_development_labels = _axis_labels(canonical_development_labels)
        if method_development_labels:
            if len(method_development_labels) != column_count:
                raise HTTPException(
                    422,
                    f"DFM input '{dataset_name}' has incompatible development geometry.",
                )
            development_labels = method_development_labels
        else:
            development_labels = _axis_labels(sidecar.get("development_labels"))
        if not method_development_labels and len(development_labels) != column_count:
            try:
                first_development = max(1, int(sidecar.get("origin_length") or 12))
                development_step = max(1, int(sidecar.get("development_length") or 12))
            except (TypeError, ValueError):
                first_development = 12
                development_step = 12
            development_labels = [
                str(first_development + development_step * index)
                for index in range(column_count)
            ]
        snapshot = {
            "name": _clean(sidecar.get("dataset_name")) or dataset_name,
            "data_format": data_format,
            "origin_labels": origin_labels,
            "development_labels": development_labels,
            "values": raw_values,
            "mask": [[value is not None for value in row] for row in raw_values],
            "number_format": _clean(sidecar.get("number_format")) or "#,##0",
            "decimal_places": decimal_places,
        }
    snapshot["_method_type"] = source_method_type
    snapshot["_status"] = source_status
    return snapshot


def _source_snapshots(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    *,
    load_input: bool,
    load_basis: bool,
    allow_review_needed: bool = False,
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] | None = None,
) -> Tuple[Dict[str, Any] | None, Dict[str, Any] | None]:
    details = _details(payload)
    data = _data_tab(payload)
    results = _results_tab(payload)
    input_name = _clean(details.get("input triangle"))
    basis_name = _clean(results.get("ratio basis dataset"))
    method_origin_labels = tuple(_axis_labels(data.get("origin labels")))
    method_development_labels = tuple(_axis_labels(data.get("development labels")))
    origin_length = _positive_int(details.get("origin length"))
    development_length = _positive_int(details.get("development length"))
    cache = snapshot_cache if snapshot_cache is not None else {}
    futures = {}
    input_cache_key: SnapshotCacheKey = (
        _key(input_name),
        False,
        method_origin_labels,
        method_development_labels,
        origin_length,
        development_length,
    )
    basis_cache_key: SnapshotCacheKey = (
        _key(basis_name),
        True,
        method_origin_labels,
        (),
        origin_length,
        0,
    )
    if load_input:
        if not input_name:
            raise HTTPException(422, "DFM input triangle is required.")
        if input_cache_key not in cache:
            futures["input"] = _READ_EXECUTOR.submit(
                _load_source_snapshot,
                project_name,
                reserving_class,
                input_name,
                vector=False,
                allow_review_needed=allow_review_needed,
                canonical_origin_labels=method_origin_labels,
                canonical_development_labels=method_development_labels,
                expected_origin_length=origin_length,
                expected_development_length=development_length,
            )
    if load_basis and basis_name:
        if basis_cache_key not in cache:
            futures["basis"] = _READ_EXECUTOR.submit(
                _load_source_snapshot,
                project_name,
                reserving_class,
                basis_name,
                vector=True,
                allow_review_needed=allow_review_needed,
                canonical_origin_labels=method_origin_labels,
                expected_origin_length=origin_length,
            )
    if "input" in futures:
        cache[input_cache_key] = futures["input"].result()
    if "basis" in futures:
        cache[basis_cache_key] = futures["basis"].result()
    input_snapshot = cache.get(input_cache_key) if load_input else None
    basis_snapshot = cache.get(basis_cache_key) if load_basis and basis_name else None
    return input_snapshot, basis_snapshot


def _recalculate_with_sources(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    *,
    load_input: bool,
    load_basis: bool,
    allow_review_needed: bool = False,
    changed_precedents: Iterable[str] = (),
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    input_snapshot, basis_snapshot = _source_snapshots(
        project_name,
        reserving_class,
        payload,
        load_input=load_input,
        load_basis=load_basis,
        allow_review_needed=allow_review_needed,
        snapshot_cache=snapshot_cache,
    )
    return _contract_call(
        recalculate_dfm_method,
        dict(payload),
        input_snapshot=input_snapshot,
        ratio_basis_snapshot=basis_snapshot,
        changed_precedents=tuple(changed_precedents),
        timestamp=_now(),
    )


def _assert_refreshable_precedents(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    snapshot_cache: Mapping[SnapshotCacheKey, Mapping[str, Any]],
    precedent_names: Iterable[str] | None = None,
) -> None:
    missing = []
    futures = {}
    names = list(precedent_names) if precedent_names is not None else _precedent_names(payload)
    for name in names:
        normalized = _key(name)
        cached = next(
            (
                snapshot
                for cache_key, snapshot in snapshot_cache.items()
                if cache_key[0] == normalized
            ),
            None,
        )
        if cached is not None:
            continue
        futures[name] = _READ_EXECUTOR.submit(
            _read_json,
            _sidecar_path(project_name, reserving_class, name),
        )
    for name, future in futures.items():
        sidecar = future.result()
        if not sidecar:
            missing.append(name)
    if missing:
        raise RuntimeError("DFM precedent sidecar is missing: " + ", ".join(missing))


def _csv_text(values: Iterable[Any]) -> str:
    rows = []
    for value in values:
        if value is None:
            rows.append("")
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            rows.append("")
            continue
        rows.append(str(value) if math.isfinite(number) else "")
    return "\n".join(rows) + "\n"


def _output_files(project_name: str, reserving_class: str, payload: Mapping[str, Any]) -> Dict[str, str]:
    details = _details(payload)
    output_dataset = _clean(details.get("output dataset")) or _clean(details.get("name"))
    data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    safe_name = sanitize_dataset_file_name(output_dataset)
    return {
        os.path.join(data_dir, f"{safe_name}@{period_length}.csv"): _csv_text(values)
        for period_length, values in dfm_output_variants(payload).items()
    }


def _build_sidecar(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    existing: Mapping[str, Any],
    *,
    notes: str | None,
    output_changed: bool,
    automatic: bool,
) -> Dict[str, Any]:
    from app_server.services import calculated_dataset_service

    details = _details(payload)
    _method_name, output_dataset = _identity(payload)
    origin_length = int(details.get("origin length") or 12)
    now = _now()
    user_name = getpass.getuser()
    output_files = _output_files(project_name, reserving_class, payload)
    primary = min(
        output_files,
        key=lambda path: 0 if path.endswith(f"@{origin_length}.csv") else 1,
    )
    canonical_existing: Dict[str, Any] = dict(existing)
    if not existing:
        graph_seed = {
            "dataset_name": output_dataset,
            "dataset_type": _clean(details.get("output type")) or output_dataset,
            "project_name": project_name,
            "reserving_class": reserving_class,
            "source_kind": "dfm",
            "method_type": dataset_sidecar_status_service.METHOD_TYPE_DFM,
            "Precedents": dataset_sidecar_status_service.name_entries(_precedent_names(payload)),
            "Dependents": [],
        }
        calculated_dataset_service.apply_sidecar_graph_fields(
            graph_seed,
            project_name,
            graph_seed["dataset_type"],
        )
        canonical_existing = graph_seed
    return _contract_call(
        build_dfm_output_sidecar,
        payload,
        project_name=project_name,
        reserving_class=reserving_class,
        csv_file=os.path.basename(primary),
        existing=canonical_existing,
        existing_record=bool(existing),
        dependents=canonical_existing.get("Dependents"),
        notes=notes,
        timestamp=now,
        user=user_name,
        output_changed=bool(output_changed or not automatic),
        append_audit=bool(not automatic or output_changed),
        audit_action=(
            "Auto Refresh" if automatic and output_changed
            else ("Update" if existing else "Insert")
        ),
        status=dataset_sidecar_status_service.STATUS_CURRENT,
    )


def _publish(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    existing_sidecar: Mapping[str, Any],
    *,
    notes: str | None,
    output_changed: bool,
    automatic: bool,
    write_outputs: bool,
) -> Tuple[Dict[str, Any], List[str]]:
    method_name, output_dataset = _identity(payload)
    method_path = _method_path(project_name, reserving_class, method_name)
    sidecar_path = _sidecar_path(project_name, reserving_class, output_dataset)
    sidecar = _build_sidecar(
        project_name,
        reserving_class,
        payload,
        existing_sidecar,
        notes=notes,
        output_changed=output_changed,
        automatic=automatic,
    )
    old_precedents = dataset_sidecar_status_service.entry_names(existing_sidecar.get("Precedents"))
    new_precedents = _precedent_names(payload)
    graph_updated = False
    graph_changed = {_key(item) for item in old_precedents} != {_key(item) for item in new_precedents}
    try:
        if graph_changed:
            from app_server.services import result_selection_service

            try:
                result_selection_service._assert_new_precedents_do_not_cycle(
                    project_name,
                    reserving_class,
                    output_dataset,
                    new_precedents,
                )
            except HTTPException as exc:
                raise HTTPException(
                    exc.status_code,
                    str(exc.detail).replace("Result Selection", "DFM"),
                ) from exc
            dataset_sidecar_status_service.update_precedent_dependents(
                project_name,
                reserving_class,
                output_dataset,
                old_precedents,
                new_precedents,
                require_new_precedents=True,
            )
            graph_updated = True
        files = {method_path: _method_json_text(payload)}
        if write_outputs:
            files.update(_output_files(project_name, reserving_class, payload))
        files[sidecar_path] = _json_text(sidecar)
        changed_paths = _commit_text_files(files, last_paths=[sidecar_path])
    except Exception:
        if graph_updated:
            dataset_sidecar_status_service.update_precedent_dependents(
                project_name,
                reserving_class,
                output_dataset,
                new_precedents,
                old_precedents,
                require_new_precedents=False,
            )
        raise
    return sidecar, changed_paths


def _validate_pair(
    requested_method_name: str,
    requested_output_dataset: str,
    method: Mapping[str, Any],
    sidecar: Mapping[str, Any],
) -> None:
    method_name, output_dataset = _identity(method)
    if _key(method_name) != _key(requested_method_name):
        raise HTTPException(409, "DFM method identity does not match the requested method.")
    if _key(output_dataset) != _key(requested_output_dataset):
        raise HTTPException(409, "DFM output identity does not match the requested sidecar.")
    if _key(sidecar.get("dataset_name")) != _key(output_dataset):
        raise HTTPException(409, "DFM sidecar identity does not match the method JSON.")
    sidecar_method = _clean(sidecar.get("method_name")) or output_dataset
    if _key(sidecar_method) != _key(method_name):
        raise HTTPException(409, "DFM sidecar is owned by a different method.")
    if dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"), sidecar.get("source_kind")
    ) != dataset_sidecar_status_service.METHOD_TYPE_DFM:
        raise HTTPException(409, "DFM output sidecar does not identify a DFM output.")
    method_precedents = {_key(item) for item in _precedent_names(method)}
    sidecar_precedents = {
        _key(item) for item in dataset_sidecar_status_service.entry_names(sidecar.get("Precedents"))
    }
    if method_precedents != sidecar_precedents:
        raise HTTPException(409, "DFM method and output sidecar precedents do not match.")
    publication_revision = _revision_response(method)["publication_revision"]
    if _clean(sidecar.get("publication_revision")) != publication_revision:
        raise HTTPException(409, "DFM method and output sidecar publication revisions do not match.")


def _method_response(
    project_name: str,
    reserving_class: str,
    method: Mapping[str, Any],
    sidecar: Mapping[str, Any],
    *,
    upgraded: bool = False,
    changed_paths: Iterable[str] = (),
) -> Dict[str, Any]:
    method_name, output_dataset = _identity(method)
    return {
        "ok": True,
        "project_name": project_name,
        "reserving_class": reserving_class,
        "method_name": method_name,
        "output_dataset": output_dataset,
        "method": dict(method),
        **_revision_response(method),
        "sidecar": _sidecar_response(sidecar, exists=bool(sidecar)),
        "upgraded": upgraded,
        "changed_paths": sorted(changed_paths, key=os.path.normcase),
    }


def load_dfm_method(
    project_name: str,
    reserving_class: str,
    method_name: str,
    *,
    output_dataset: str | None = None,
) -> Dict[str, Any]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(400, "project_name, reserving_class, and method_name are required.")
    method_path = _method_path(project, reserving, name)
    requested_output = _clean(output_dataset)
    if requested_output:
        sidecar_path = _sidecar_path(project, reserving, requested_output)
        with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
            method_future = _READ_EXECUTOR.submit(_read_json, method_path)
            sidecar_future = _READ_EXECUTOR.submit(_read_json, sidecar_path)
            method = method_future.result()
            sidecar = sidecar_future.result()
    else:
        with _lock(project, reserving):
            method = _read_json(method_path)
            if not method:
                raise HTTPException(404, f"DFM method not found: {name}")
            if _clean(method.get("json format")) == LEGACY_DFM_JSON_FORMAT \
                    and not _clean(_details(method).get("output dataset")):
                raise HTTPException(
                    409,
                    "Legacy DFM does not declare its output dataset; output_dataset is required for the one-time upgrade.",
                )
            _loaded_name, requested_output = _identity(method)
            sidecar_path = _sidecar_path(project, reserving, requested_output)
            with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
                sidecar = _read_json(sidecar_path)
    if not method or not sidecar:
        raise HTTPException(409, "DFM requires both its method JSON and output sidecar.")
    json_format = _clean(method.get("json format"))
    if json_format == DFM_JSON_FORMAT:
        normalized = _contract_call(normalize_dfm_method, method, require_complete=True)
        _validate_pair(name, requested_output, normalized, sidecar)
        return _method_response(project, reserving, normalized, sidecar)
    if json_format != LEGACY_DFM_JSON_FORMAT:
        raise HTTPException(422, f"Unsupported DFM JSON format: {json_format or '(missing)'}.")
    # Exact v1 files take a one-time dependency-reading upgrade path.
    with _lock(project, reserving), dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        method = _read_json(method_path)
        sidecar = _read_json(sidecar_path)
        if _clean(method.get("json format")) == LEGACY_DFM_JSON_FORMAT:
            legacy = json.loads(json.dumps(method))
            legacy["json format"] = DFM_JSON_FORMAT
            legacy_details = legacy.setdefault("details tab", {})
            if isinstance(legacy_details, dict) and not _clean(legacy_details.get("output dataset")):
                legacy_details["output dataset"] = requested_output
            normalized = _recalculate_with_sources(
                project,
                reserving,
                legacy,
                load_input=True,
                load_basis=True,
                changed_precedents=_precedent_names(legacy),
            )
            previous = list(_results_tab(method).get("ultimate vector") or [])
            current = list(_results_tab(normalized).get("ultimate vector") or [])
            sidecar, changed_paths = _publish(
                project,
                reserving,
                normalized,
                sidecar,
                notes=None,
                output_changed=previous != current,
                automatic=True,
                write_outputs=previous != current or not previous,
            )
            _validate_pair(name, requested_output, normalized, sidecar)
            return _method_response(
                project,
                reserving,
                normalized,
                sidecar,
                upgraded=True,
                changed_paths=changed_paths,
            )
        normalized = _contract_call(normalize_dfm_method, method, require_complete=True)
        _validate_pair(name, requested_output, normalized, sidecar)
        return _method_response(project, reserving, normalized, sidecar)


def preview_dfm_method(method: Dict[str, Any]) -> Dict[str, Any]:
    payload = _contract_call(canonical_preview_dfm_method, method, timestamp=_now())
    return {"ok": True, "method": payload, **_revision_response(payload)}


def save_dfm_method(
    project_name: str,
    reserving_class: str,
    method: Dict[str, Any],
    *,
    notes: str | None = None,
    expected_owned_revision: str | None = None,
    expected_derived_revision: str | None = None,
) -> Dict[str, Any]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    if not project or not reserving:
        raise HTTPException(400, "project_name and reserving_class are required.")
    incoming = _contract_call(normalize_dfm_method, method, require_complete=False)
    method_name, output_dataset = _identity(incoming)
    method_path = _method_path(project, reserving, method_name)
    sidecar_path = _sidecar_path(project, reserving, output_dataset)
    with _lock(project, reserving), dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        current = _read_json(method_path)
        existing_sidecar = _read_json(sidecar_path)
        if current:
            if _clean(current.get("json format")) != DFM_JSON_FORMAT:
                raise HTTPException(409, "DFM changed on disk; reload it before saving.")
            current = _contract_call(normalize_dfm_method, current, require_complete=True)
            current_method_name, current_output = _identity(current)
            if _key(current_method_name) != _key(method_name) or _key(current_output) != _key(output_dataset):
                raise HTTPException(409, "An existing DFM cannot change its method or output identity during Save.")
            current_revisions = _revision_response(current)
            if expected_owned_revision is not None and _clean(expected_owned_revision) != current_revisions["owned_revision"]:
                raise HTTPException(409, "DFM owned settings changed on disk; reload before saving.")
            merged = _contract_call(apply_owned_patch, current, method, timestamp=_now())
        else:
            if expected_owned_revision is not None and _clean(expected_owned_revision):
                raise HTTPException(409, "DFM was removed on disk; reload before saving.")
            merged = incoming
        if existing_sidecar:
            owner = _clean(existing_sidecar.get("method_name")) or _clean(existing_sidecar.get("dataset_name"))
            if _key(owner) != _key(method_name):
                raise HTTPException(
                    409,
                    f"Output dataset '{output_dataset}' is already owned by DFM '{owner}'. Choose a unique output dataset.",
                )
        current_input = _clean(_details(current).get("input triangle")) if current else ""
        current_basis = _clean(_results_tab(current).get("ratio basis dataset")) if current else ""
        next_input = _clean(_details(merged).get("input triangle"))
        next_basis = _clean(_results_tab(merged).get("ratio basis dataset"))
        load_input = not current or _key(current_input) != _key(next_input)
        load_basis = bool(next_basis) and (not current or _key(current_basis) != _key(next_basis))
        if load_input and next_basis:
            load_basis = True
        if load_input or load_basis:
            refreshed = _recalculate_with_sources(
                project,
                reserving,
                merged,
                load_input=load_input,
                load_basis=load_basis,
                allow_review_needed=True,
                changed_precedents=[
                    name for name, changed_identity in (
                        (next_input, load_input),
                        (next_basis, load_basis),
                    ) if name and changed_identity
                ],
            )
        else:
            # The owned patch was already recalculated by the canonical merger
            # against the latest embedded snapshots. Do not leak out-of-band CSV
            # edits into an ordinary save.
            refreshed = merged
        previous_publication = (
            _revision_response(current)["publication_revision"] if current else ""
        )
        next_publication = _revision_response(refreshed)["publication_revision"]
        publication_changed = not current or previous_publication != next_publication
        sidecar, changed_paths = _publish(
            project,
            reserving,
            refreshed,
            existing_sidecar,
            notes=notes,
            output_changed=publication_changed,
            automatic=False,
            write_outputs=True,
        )
    response = _method_response(
        project,
        reserving,
        refreshed,
        sidecar,
        changed_paths=changed_paths,
    )
    response["derived_rebased"] = bool(
        current
        and expected_derived_revision is not None
        and _clean(expected_derived_revision) != _revision_response(current)["derived_revision"]
    )
    response["unreviewed_precedents"] = dataset_sidecar_status_service.review_needed_precedent_names(
        project,
        reserving,
        _precedent_names(refreshed),
    )
    response["unreviewed_precedent_count"] = len(response["unreviewed_precedents"])
    try:
        from app_server.services import calculated_dataset_service

        response["propagation"] = calculated_dataset_service.recalculate_dependents(
            project,
            reserving,
            output_dataset,
            _clean(_details(refreshed).get("output type")) or output_dataset,
            include_dfm=True,
            rebuild_index=True,
        )
    except Exception as exc:
        response["propagation"] = {"ok": False, "errors": [{"reason": str(exc)}]}
    response["propagation_ok"] = bool(response["propagation"].get("ok"))
    response["calculated_updates"] = response["propagation"]
    return response


def _mark_review_needed(project_name: str, reserving_class: str, output_dataset: str) -> None:
    sidecar_path = _sidecar_path(project_name, reserving_class, output_dataset)
    with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        sidecar = _read_json(sidecar_path)
        if not sidecar:
            return
        if dataset_sidecar_status_service.normalize_status(sidecar.get("status")) \
                == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED:
            return
        sidecar["status"] = dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
        _commit_text_files({sidecar_path: _json_text(sidecar)})


def _refresh_one(
    project_name: str,
    reserving_class: str,
    output_dataset: str,
    sidecar: Mapping[str, Any],
    changed_names: Iterable[str],
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]],
    method_payload: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    previous_status = dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
    method_name = _clean(sidecar.get("method_name")) or output_dataset
    method = dict(method_payload) if isinstance(method_payload, Mapping) else _read_json(
        _method_path(project_name, reserving_class, method_name)
    )
    if not method:
        raise RuntimeError("DFM method JSON is missing.")
    if _clean(method.get("json format")) != DFM_JSON_FORMAT:
        raise RuntimeError("DFM must be upgraded to v2 before automatic refresh.")
    method = _contract_call(normalize_dfm_method, method, require_complete=True)
    input_name = _clean(_details(method).get("input triangle"))
    basis_name = _clean(_results_tab(method).get("ratio basis dataset"))
    changed_keys = {_key(item) for item in changed_names if _key(item)}
    load_input = _key(input_name) in changed_keys
    load_basis = bool(basis_name and _key(basis_name) in changed_keys)
    if not load_input and not load_basis:
        return {"ok": True, "dataset_name": output_dataset, "skipped": True, "reason": "stale_reverse_dependency_edge"}
    refreshed = _recalculate_with_sources(
        project_name,
        reserving_class,
        method,
        load_input=load_input,
        load_basis=load_basis,
        allow_review_needed=True,
        changed_precedents=changed_names,
        snapshot_cache=snapshot_cache,
    )
    _assert_refreshable_precedents(
        project_name,
        reserving_class,
        refreshed,
        snapshot_cache,
        [
            name
            for name, was_loaded in ((input_name, load_input), (basis_name, load_basis))
            if name and was_loaded
        ],
    )
    before_revisions = _revision_response(method)
    after_revisions = _revision_response(refreshed)
    if before_revisions["derived_revision"] == after_revisions["derived_revision"]:
        # No persisted derived value changed. Preserve the prior refresh stamp
        # so the method file remains byte-identical and only a Review Needed
        # sidecar status needs restoration.
        refreshed["method metadata"]["data refreshed"] = method["method metadata"]["data refreshed"]
    output_changed = (
        before_revisions["publication_revision"]
        != after_revisions["publication_revision"]
    )
    before_text = _method_json_text(method)
    after_text = _method_json_text(refreshed)
    sidecar, changed_paths = _publish(
        project_name,
        reserving_class,
        refreshed,
        sidecar,
        notes=None,
        output_changed=output_changed,
        automatic=True,
        write_outputs=output_changed,
    )
    return {
        "ok": True,
        "dataset_name": output_dataset,
        "updated": before_text != after_text,
        "output_changed": output_changed,
        "status_refreshed": (
            previous_status == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
            and dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
            == dataset_sidecar_status_service.STATUS_CURRENT
        ),
        "method": refreshed,
        "sidecar": sidecar,
        "changed_paths": changed_paths,
    }


def refresh_dfm_method(
    project_name: str,
    reserving_class: str,
    method_name: str,
    *,
    output_dataset: str | None = None,
) -> Dict[str, Any]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(400, "project_name, reserving_class, and method_name are required.")
    with _lock(project, reserving):
        method = _read_json(_method_path(project, reserving, name))
        if not method:
            raise HTTPException(404, f"DFM method not found: {name}")
        _stored_name, stored_output = _identity(method)
        requested_output = _clean(output_dataset) or stored_output
        if _key(requested_output) != _key(stored_output):
            raise HTTPException(409, "DFM output identity does not match the method JSON.")
        sidecar_path = _sidecar_path(project, reserving, stored_output)
        with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
            sidecar = _read_json(sidecar_path)
            if not sidecar:
                raise HTTPException(409, "DFM output sidecar is missing.")
            if _clean(method.get("json format")) != DFM_JSON_FORMAT:
                raise HTTPException(409, "Open the legacy DFM once to upgrade it before refreshing.")
            was_review_needed = (
                dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
                == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
            )
            result = _refresh_one(
                project,
                reserving,
                stored_output,
                sidecar,
                _precedent_names(method),
                {},
                method_payload=method,
            )
            if was_review_needed:
                _mark_review_needed(project, reserving, stored_output)
                result["sidecar"] = _read_json(sidecar_path) or result.get("sidecar") or sidecar
                result["status_refreshed"] = False
    response = _method_response(
        project,
        reserving,
        result.get("method") or method,
        result.get("sidecar") or sidecar,
        changed_paths=result.get("changed_paths") or [],
    )
    response.update({
        "updated": bool(result.get("updated")),
        "output_changed": bool(result.get("output_changed")),
        "status_refreshed": bool(result.get("status_refreshed")),
    })
    if result.get("output_changed") or result.get("status_refreshed"):
        try:
            from app_server.services import calculated_dataset_service

            response["propagation"] = calculated_dataset_service.recalculate_dependents(
                project,
                reserving,
                stored_output,
                _clean(_details(result.get("method") or method).get("output type")) or stored_output,
                include_dfm=True,
                rebuild_index=True,
            )
        except Exception as exc:
            response["propagation"] = {"ok": False, "errors": [{"reason": str(exc)}]}
        response["propagation_ok"] = bool(response["propagation"].get("ok"))
        response["calculated_updates"] = response["propagation"]
    else:
        response["propagation"] = {
            "ok": True,
            "skipped": True,
            "reason": "publication_unchanged",
        }
        response["propagation_ok"] = True
        response["calculated_updates"] = response["propagation"]
    return response


def refresh_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_names: Iterable[Any],
    *,
    blocked_precedent_names: Iterable[Any] = (),
    finalize_method_review_status: bool = True,
) -> Dict[str, Any]:
    """Refresh affected DFM methods transitively, without cascading other domains."""

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    changed = []
    seen = set()
    for item in changed_dataset_names:
        name = _clean(item)
        normalized = _key(name)
        if normalized and normalized not in seen:
            seen.add(normalized)
            changed.append(name)
    blocked_keys = {_key(item) for item in blocked_precedent_names if _key(item)}
    updated: List[Dict[str, Any]] = []
    status_refreshed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] = {}
    sidecar_cache: Dict[str, Dict[str, Any]] = {}
    processed_source_keys = set()
    queue = list(changed)
    with _lock(project, reserving):
        while queue:
            frontier = []
            for raw_name in queue:
                name = _clean(raw_name)
                normalized = _key(name)
                if not normalized or normalized in processed_source_keys:
                    continue
                processed_source_keys.add(normalized)
                frontier.append(name)
            queue = []
            if not frontier:
                break
            source_futures = {
                name: _READ_EXECUTOR.submit(_read_json, _sidecar_path(project, reserving, name))
                for name in frontier
                if _key(name) not in sidecar_cache
            }
            for name, future in source_futures.items():
                sidecar_cache[_key(name)] = future.result()
            dependent_sources: Dict[str, List[str]] = {}
            for source_name in frontier:
                source_sidecar = sidecar_cache.get(_key(source_name)) or {}
                for dependent in dataset_sidecar_status_service.entry_names(source_sidecar.get("Dependents")):
                    dependent_sources.setdefault(dependent, []).append(source_name)
            dependent_futures = {
                name: _READ_EXECUTOR.submit(_read_json, _sidecar_path(project, reserving, name))
                for name in dependent_sources
                if _key(name) not in sidecar_cache
            }
            for name, future in dependent_futures.items():
                sidecar_cache[_key(name)] = future.result()
            method_futures = {}
            for output_dataset in dependent_sources:
                sidecar = sidecar_cache.get(_key(output_dataset)) or {}
                if dataset_sidecar_status_service.normalize_method_type(
                    sidecar.get("method_type"), sidecar.get("source_kind")
                ) != dataset_sidecar_status_service.METHOD_TYPE_DFM:
                    continue
                method_name = _clean(sidecar.get("method_name")) or output_dataset
                method_futures[output_dataset] = _READ_EXECUTOR.submit(
                    _read_json,
                    _method_path(project, reserving, method_name),
                )
            prefetched_methods = {
                name: future.result() for name, future in method_futures.items()
            }
            for output_dataset in sorted(dependent_sources, key=lambda value: (_key(value), value)):
                sidecar = sidecar_cache.get(_key(output_dataset)) or {}
                if dataset_sidecar_status_service.normalize_method_type(
                    sidecar.get("method_type"), sidecar.get("source_kind")
                ) != dataset_sidecar_status_service.METHOD_TYPE_DFM:
                    continue
                changed_sources = dependent_sources[output_dataset]
                blocked = [name for name in changed_sources if _key(name) in blocked_keys]
                dataset_type = _clean(sidecar.get("dataset_type")) or output_dataset
                if blocked:
                    _mark_review_needed(project, reserving, output_dataset)
                    blocked_keys.update({_key(output_dataset), _key(dataset_type)})
                    sidecar_cache.pop(_key(output_dataset), None)
                    queue.append(output_dataset)
                    errors.append({
                        "dataset_name": output_dataset,
                        "dataset_type": dataset_type,
                        "reason": "Precedent refresh failed: " + ", ".join(blocked),
                    })
                    continue
                try:
                    output_sidecar_path = _sidecar_path(project, reserving, output_dataset)
                    with dataset_sidecar_status_service.sidecar_write_lock(output_sidecar_path):
                        latest_sidecar = _read_json(output_sidecar_path) or sidecar
                        result = _refresh_one(
                            project,
                            reserving,
                            output_dataset,
                            latest_sidecar,
                            changed_sources,
                            snapshot_cache,
                            method_payload=prefetched_methods.get(output_dataset),
                        )
                except Exception as exc:
                    _mark_review_needed(project, reserving, output_dataset)
                    blocked_keys.update({_key(output_dataset), _key(dataset_type)})
                    sidecar_cache.pop(_key(output_dataset), None)
                    queue.append(output_dataset)
                    errors.append({
                        "dataset_name": output_dataset,
                        "dataset_type": dataset_type,
                        "reason": str(exc),
                    })
                    continue
                refreshed_sidecar = result.get("sidecar") or sidecar
                sidecar_cache[_key(output_dataset)] = refreshed_sidecar
                if result.get("updated"):
                    updated.append({
                        "dataset_name": output_dataset,
                        "dataset_type": _clean(refreshed_sidecar.get("dataset_type")) or output_dataset,
                        "output_changed": bool(result.get("output_changed")),
                    })
                    if result.get("output_changed") or result.get("status_refreshed"):
                        queue.append(output_dataset)
                elif result.get("status_refreshed"):
                    status_refreshed.append({"dataset_name": output_dataset})
                    queue.append(output_dataset)
                else:
                    skipped.append({
                        "dataset_name": output_dataset,
                        "reason": result.get("reason") or "not_updated",
                    })
        review_status_updates = (
            dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                project,
                reserving,
                changed,
            )
            if finalize_method_review_status
            else []
        )
    return {
        "ok": not errors,
        "project_name": project,
        "reserving_class": reserving,
        "changed_dataset_names": changed,
        "updated": updated,
        "status_refreshed": status_refreshed,
        "skipped": skipped,
        "errors": errors,
        "review_status_updates": review_status_updates,
    }
