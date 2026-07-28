"""Load, save, and eagerly refresh self-contained Bornhuetter Ferguson methods."""
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

from arcrho_api.bornhuetter_ferguson_contract import (
    BF_JSON_FORMAT,
    BornhuetterFergusonContractError,
    apply_owned_patch,
    bornhuetter_ferguson_output_variants,
    bornhuetter_ferguson_precedent_names,
    build_bornhuetter_ferguson_output_sidecar,
    method_revisions,
    normalize_bornhuetter_ferguson_method,
    recalculate_bornhuetter_ferguson_method,
)
from app_server import config
from app_server.helpers import sanitize_dataset_file_name
from app_server.services import dataset_sidecar_status_service


READ_MAX_WORKERS = 4
MAX_REFRESH_VISITS_PER_DATASET = 4
SnapshotCacheKey = Tuple[str, str, int, Tuple[str, ...]]
_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=READ_MAX_WORKERS,
    thread_name_prefix="arcrho-bf-read",
)


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _key(value: Any) -> str:
    return " ".join(_clean(value).lower().split())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _lock(project_name: str, reserving_class: str) -> threading.RLock:
    return dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class)


def _method_path(project_name: str, reserving_class: str, method_name: str) -> str:
    filename = f"BF@{sanitize_dataset_file_name(method_name, 'Name')}.json"
    return os.path.join(config.get_project_method_data_dir(project_name, reserving_class), filename)


def _sidecar_path(project_name: str, reserving_class: str, dataset_name: str) -> str:
    return dataset_sidecar_status_service.sidecar_path(project_name, reserving_class, dataset_name)


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except PermissionError as exc:
        raise HTTPException(423, f"BF file is locked or inaccessible: {os.path.basename(path)}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, f"Invalid BF JSON: {os.path.basename(path)}: {exc}") from exc
    return payload if isinstance(payload, dict) else {}


def _json_text(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def _read_bytes_if_file(path: str) -> bytes | None:
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()


def _commit_text_files(files: Mapping[str, str], *, last_paths: Iterable[str] = ()) -> List[str]:
    """Replace one BF publication atomically and restore all prior bytes on failure."""

    last_keys = {os.path.normcase(os.path.abspath(path)) for path in last_paths}
    paths = list(files)
    read_futures = {path: _READ_EXECUTOR.submit(_read_bytes_if_file, path) for path in paths}
    changed = {
        path: files[path]
        for path in paths
        if read_futures[path].result() != files[path].encode("utf-8")
    }
    ordered_paths = sorted(
        changed,
        key=lambda path: (
            os.path.normcase(os.path.abspath(path)) in last_keys,
            os.path.normcase(path),
        ),
    )
    staged: Dict[str, str] = {}
    backups: Dict[str, bytes | None] = {
        path: read_futures[path].result() for path in ordered_paths
    }
    replaced: List[str] = []
    try:
        for path in ordered_paths:
            os.makedirs(os.path.dirname(path), exist_ok=True)
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
            raise RuntimeError(f"{exc}; BF rollback failed: {'; '.join(rollback_errors)}") from exc
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
    except BornhuetterFergusonContractError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not isinstance(result, dict):
        raise HTTPException(500, "Canonical BF calculation returned an invalid payload.")
    return result


def _details(payload: Mapping[str, Any]) -> Dict[str, Any]:
    value = payload.get("details_tab") if isinstance(payload, Mapping) else None
    return value if isinstance(value, dict) else {}


def _method_tab(payload: Mapping[str, Any]) -> Dict[str, Any]:
    value = payload.get("method_tab") if isinstance(payload, Mapping) else None
    return value if isinstance(value, dict) else {}


def _identity(payload: Mapping[str, Any]) -> Tuple[str, str]:
    details = _details(payload)
    method_name = _clean(details.get("name"))
    output_dataset = method_name
    if not method_name:
        raise HTTPException(422, "BF method name is required.")
    return method_name, output_dataset


def _unique_names(values: Iterable[Any]) -> List[str]:
    output: List[str] = []
    seen = set()
    for value in values:
        name = _clean(value)
        normalized = _key(name)
        if name and normalized not in seen:
            seen.add(normalized)
            output.append(name)
    return output


def _revision_response(payload: Mapping[str, Any]) -> Dict[str, str]:
    revisions = method_revisions(payload)
    owned = _clean(revisions.get("owned_revision"))
    derived = _clean(revisions.get("derived_revision"))
    publication = _clean(revisions.get("publication_revision"))
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


def _source_period(sidecar: Mapping[str, Any]) -> int:
    for key in ("period_length", "origin_length"):
        try:
            value = int(sidecar.get(key))
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 0


def _read_source_snapshot_from_sidecar(
    project_name: str,
    reserving_class: str,
    requested_name: str,
    sidecar: Mapping[str, Any],
    *,
    role: str,
    origin_length: int,
    origin_labels: Iterable[Any],
    allow_review_needed: bool = False,
) -> Dict[str, Any]:
    if not sidecar:
        raise HTTPException(404, f"BF precedent sidecar is missing: {requested_name}")
    status = dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
    method_type = dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"), sidecar.get("source_kind")
    )
    if not allow_review_needed \
            and method_type != dataset_sidecar_status_service.METHOD_TYPE_NONE \
            and status == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED:
        raise HTTPException(409, f"BF precedent requires review: {requested_name}")
    data_format = _clean(sidecar.get("data_format")).lower()
    if role == "latest" and data_format != "triangle":
        raise HTTPException(422, f"BF Latest source '{requested_name}' must be a Triangle dataset.")
    if role != "latest" and data_format != "vector":
        raise HTTPException(422, f"BF {role.title()} source '{requested_name}' must be a Vector dataset.")
    if role == "dfm" and method_type != dataset_sidecar_status_service.METHOD_TYPE_DFM:
        raise HTTPException(422, f"BF Development Pattern source '{requested_name}' must be a DFM output.")
    period = _source_period(sidecar)
    if period and period != origin_length:
        raise HTTPException(
            422,
            f"BF precedent '{requested_name}' uses {period}-month origins; expected {origin_length}.",
        )
    csv_file = os.path.basename(_clean(sidecar.get("csv_file")))
    if not csv_file:
        raise HTTPException(422, f"BF precedent '{requested_name}' does not identify its cache CSV.")
    csv_path = os.path.join(
        config.get_project_dataset_cache_dir(project_name, reserving_class),
        csv_file,
    )
    try:
        frame = pd.read_csv(csv_path, header=None).astype(object)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"BF precedent CSV is missing: {requested_name}") from exc
    except PermissionError as exc:
        raise HTTPException(423, f"BF precedent CSV is locked: {requested_name}") from exc
    except Exception as exc:
        raise HTTPException(422, f"BF precedent CSV is invalid: {requested_name}: {exc}") from exc
    frame = frame.where(pd.notnull(frame), None)
    raw_values = frame.values.tolist()
    method_origin_labels = [str(item if item is not None else "") for item in origin_labels]
    if not method_origin_labels:
        raise HTTPException(422, "BF method origin labels are required before loading precedents.")
    if len(raw_values) != len(method_origin_labels):
        raise HTTPException(
            422,
            f"BF precedent '{requested_name}' has {len(raw_values)} rows; "
            f"expected {len(method_origin_labels)}.",
        )
    return {
        "name": _clean(sidecar.get("dataset_name")) or requested_name,
        "origin_labels": method_origin_labels,
        "values": raw_values,
        "mask": [[value is not None for value in row] for row in raw_values],
    }


def _read_sidecars(
    project_name: str,
    reserving_class: str,
    names: Iterable[Any],
    cache: Dict[str, Dict[str, Any]] | None = None,
) -> Dict[str, Dict[str, Any]]:
    snapshot = cache if cache is not None else {}
    unique = _unique_names(names)
    pending = [name for name in unique if _key(name) not in snapshot]
    futures = {
        name: _READ_EXECUTOR.submit(_read_json, _sidecar_path(project_name, reserving_class, name))
        for name in pending
    }
    for name in pending:
        snapshot[_key(name)] = futures[name].result()
    return {name: snapshot.get(_key(name), {}) for name in unique}


def _source_snapshots(
    project_name: str,
    reserving_class: str,
    method: Mapping[str, Any],
    roles: Iterable[str],
    *,
    prior_names: Iterable[str] | None = None,
    allow_review_needed: bool = False,
    sidecar_cache: Dict[str, Dict[str, Any]] | None = None,
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    tab = _method_tab(method)
    details = _details(method)
    origin_length = int(details.get("origin_length") or 12)
    origin_labels = [
        str(item if item is not None else "")
        for item in tab.get("origin_labels", [])
    ]
    requested_roles = set(roles)
    role_names: List[Tuple[str, str]] = []
    if "latest" in requested_roles:
        role_names.append(("latest", _clean(tab.get("latest_dataset"))))
    if "dfm" in requested_roles:
        role_names.append(("dfm", _clean(tab.get("dfm_dataset"))))
    if "priors" in requested_roles:
        selected_prior_keys = (
            {_key(name) for name in prior_names if _key(name)}
            if prior_names is not None
            else None
        )
        role_names.extend(
            ("priors", _clean(item.get("name")))
            for item in tab.get("prior_datasets", [])
            if isinstance(item, Mapping)
            and (selected_prior_keys is None or _key(item.get("name")) in selected_prior_keys)
        )
    role_names = [(role, name) for role, name in role_names if name]
    sidecars = _read_sidecars(
        project_name,
        reserving_class,
        [name for _role, name in role_names],
        sidecar_cache,
    )
    snapshots = snapshot_cache if snapshot_cache is not None else {}
    origin_axis = tuple(origin_labels)
    futures: Dict[SnapshotCacheKey, Any] = {}
    for role, name in role_names:
        cache_key = (_key(name), role, origin_length, origin_axis)
        if cache_key not in snapshots and cache_key not in futures:
            futures[cache_key] = _READ_EXECUTOR.submit(
                _read_source_snapshot_from_sidecar,
                project_name,
                reserving_class,
                name,
                sidecars.get(name) or {},
                role=role,
                origin_length=origin_length,
                origin_labels=origin_labels,
                allow_review_needed=allow_review_needed,
            )
    for cache_key, future in futures.items():
        snapshots[cache_key] = future.result()
    result: Dict[str, Any] = {}
    prior_snapshots: Dict[str, Dict[str, Any]] = {}
    for role, name in role_names:
        snapshot = snapshots[(_key(name), role, origin_length, origin_axis)]
        if role == "priors":
            prior_snapshots[name] = snapshot
        else:
            result[role] = snapshot
    if prior_snapshots:
        result["priors"] = prior_snapshots
    return result


def _recalculate_with_sources(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
    roles: Iterable[str],
    *,
    changed_precedents: Iterable[str],
    prior_names: Iterable[str] | None = None,
    allow_review_needed: bool = False,
    sidecar_cache: Dict[str, Dict[str, Any]] | None = None,
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    snapshots = _source_snapshots(
        project_name,
        reserving_class,
        payload,
        roles,
        prior_names=prior_names,
        allow_review_needed=allow_review_needed,
        sidecar_cache=sidecar_cache,
        snapshot_cache=snapshot_cache,
    )
    return _contract_call(
        recalculate_bornhuetter_ferguson_method,
        payload,
        source_snapshots=snapshots,
        changed_precedents=changed_precedents,
        timestamp=_now(),
    )


def _csv_text(values: Iterable[Any]) -> str:
    rows: List[str] = []
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


def _output_files(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
) -> Dict[str, str]:
    method_name, output_dataset = _identity(payload)
    del method_name
    data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    safe_name = sanitize_dataset_file_name(output_dataset)
    return {
        os.path.join(data_dir, f"{safe_name}@{period_length}.csv"): _csv_text(values)
        for period_length, values in bornhuetter_ferguson_output_variants(payload).items()
    }


def _output_paths(
    project_name: str,
    reserving_class: str,
    payload: Mapping[str, Any],
) -> List[str]:
    """Project output filenames from geometry without recalculating method values."""

    _method_name, output_dataset = _identity(payload)
    origin_length = int(_details(payload).get("origin_length") or 12)
    periods = [origin_length]
    periods.extend(
        target
        for target in (3, 6, 12)
        if target > origin_length and target % origin_length == 0
    )
    data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    safe_name = sanitize_dataset_file_name(output_dataset)
    return [os.path.join(data_dir, f"{safe_name}@{period}.csv") for period in periods]


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

    _method_name, output_dataset = _identity(payload)
    origin_length = int(_details(payload).get("origin_length") or 12)
    output_files = _output_files(project_name, reserving_class, payload)
    primary = next(
        path for path in output_files if path.endswith(f"@{origin_length}.csv")
    )
    canonical_existing: Dict[str, Any] = dict(existing)
    if not existing:
        graph_seed = {
            "dataset_name": output_dataset,
            "dataset_type": _clean(_details(payload).get("output_type")) or output_dataset,
            "project_name": project_name,
            "reserving_class": reserving_class,
            "source_kind": "bornhuetter_ferguson",
            "method_type": dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON,
            "Precedents": dataset_sidecar_status_service.name_entries(
                bornhuetter_ferguson_precedent_names(payload)
            ),
            "Dependents": [],
        }
        calculated_dataset_service.apply_sidecar_graph_fields(
            graph_seed,
            project_name,
            graph_seed["dataset_type"],
        )
        canonical_existing = graph_seed
    return _contract_call(
        build_bornhuetter_ferguson_output_sidecar,
        payload,
        project_name=project_name,
        reserving_class=reserving_class,
        csv_file=os.path.basename(primary),
        existing=canonical_existing,
        existing_record=bool(existing),
        dependents=canonical_existing.get("Dependents"),
        notes=notes,
        timestamp=_now(),
        user=getpass.getuser(),
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
    new_precedents = bornhuetter_ferguson_precedent_names(payload)
    graph_changed = {_key(item) for item in old_precedents} != {_key(item) for item in new_precedents}
    graph_updated = False
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
                    str(exc.detail).replace("Result Selection", "BF"),
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
        files = {_method_path(project_name, reserving_class, method_name): _json_text(payload)}
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
    method: Mapping[str, Any],
    sidecar: Mapping[str, Any],
) -> None:
    method_name, output_dataset = _identity(method)
    if _key(method_name) != _key(requested_method_name):
        raise HTTPException(409, "BF method identity does not match the requested method.")
    if _key(sidecar.get("dataset_name")) != _key(output_dataset):
        raise HTTPException(409, "BF sidecar identity does not match the method JSON.")
    sidecar_method = _clean(sidecar.get("method_name")) or output_dataset
    if _key(sidecar_method) != _key(method_name):
        raise HTTPException(409, "BF sidecar is owned by a different method.")
    if dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"), sidecar.get("source_kind")
    ) != dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON:
        raise HTTPException(409, "BF output sidecar does not identify a BF output.")
    if _clean(sidecar.get("data_format")).lower() != "vector":
        raise HTTPException(409, "BF output sidecar must identify a Vector dataset.")
    try:
        sidecar_period = int(sidecar.get("period_length"))
    except (TypeError, ValueError):
        sidecar_period = 0
    method_period = int(_details(method).get("origin_length") or 0)
    if sidecar_period != method_period:
        raise HTTPException(409, "BF method and output sidecar origin lengths do not match.")
    method_origins = [str(item) for item in _method_tab(method).get("origin_labels", [])]
    sidecar_origins = (
        [str(item) for item in sidecar.get("origin_labels", [])]
        if isinstance(sidecar.get("origin_labels"), list)
        else []
    )
    if sidecar_origins != method_origins:
        raise HTTPException(409, "BF method and output sidecar origin labels do not match.")
    method_precedents = {_key(item) for item in bornhuetter_ferguson_precedent_names(method)}
    sidecar_precedents = {
        _key(item) for item in dataset_sidecar_status_service.entry_names(sidecar.get("Precedents"))
    }
    if method_precedents != sidecar_precedents:
        raise HTTPException(409, "BF method and output sidecar precedents do not match.")
    if _clean(sidecar.get("publication_revision")) != _revision_response(method)["publication_revision"]:
        raise HTTPException(409, "BF method and output sidecar publication revisions do not match.")


def _method_response(
    project_name: str,
    reserving_class: str,
    method: Mapping[str, Any],
    sidecar: Mapping[str, Any],
    *,
    changed_paths: Iterable[str] = (),
) -> Dict[str, Any]:
    method_name, output_dataset = _identity(method)
    origin_length = int(_details(method).get("origin_length") or 12)
    output_paths = sorted(_output_paths(project_name, reserving_class, method), key=os.path.normcase)
    return {
        "ok": True,
        "project_name": project_name,
        "reserving_class": reserving_class,
        "method_name": method_name,
        "output_dataset": output_dataset,
        "method": dict(method),
        **_revision_response(method),
        "sidecar": _sidecar_response(sidecar, exists=bool(sidecar)),
        "changed_paths": sorted(changed_paths, key=os.path.normcase),
        "aggregated_csv_paths": [
            path for path in output_paths if not path.endswith(f"@{origin_length}.csv")
        ],
    }


def load_bornhuetter_ferguson_method(
    project_name: str,
    reserving_class: str,
    method_name: str,
) -> Dict[str, Any]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(400, "project_name, reserving_class, and method_name are required.")
    method_path = _method_path(project, reserving, name)
    sidecar_path = _sidecar_path(project, reserving, name)
    with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        method_future = _READ_EXECUTOR.submit(_read_json, method_path)
        sidecar_future = _READ_EXECUTOR.submit(_read_json, sidecar_path)
        method = method_future.result()
        sidecar = sidecar_future.result()
        if not method:
            raise HTTPException(404, f"BF method not found: {name}")
        if not sidecar:
            raise HTTPException(409, "BF requires both its method JSON and output sidecar.")
        json_format = _clean(method.get("json_format"))
        if json_format != BF_JSON_FORMAT:
            raise HTTPException(422, f"Unsupported BF JSON format: {json_format or '(missing)'}.")
        normalized = _contract_call(
            normalize_bornhuetter_ferguson_method,
            method,
            require_complete=True,
        )
        _validate_pair(name, normalized, sidecar)
        return _method_response(project, reserving, normalized, sidecar)


def _roles_for_save(
    current: Mapping[str, Any] | None,
    merged: Mapping[str, Any],
) -> Tuple[set[str], List[str] | None]:
    if not current:
        return {"latest", "dfm", "priors"}, None
    current_details = _details(current)
    next_details = _details(merged)
    current_tab = _method_tab(current)
    next_tab = _method_tab(merged)
    latest_changed = _key(current_tab.get("latest_dataset")) != _key(next_tab.get("latest_dataset"))
    geometry_changed = int(current_details.get("origin_length") or 12) != int(
        next_details.get("origin_length") or 12
    )
    if latest_changed or geometry_changed:
        return {"latest", "dfm", "priors"}, None
    roles: set[str] = set()
    if _key(current_tab.get("dfm_dataset")) != _key(next_tab.get("dfm_dataset")):
        roles.add("dfm")
    current_priors = {_key(item.get("name")) for item in current_tab.get("prior_datasets", [])}
    next_priors = {_key(item.get("name")) for item in next_tab.get("prior_datasets", [])}
    new_prior_keys = next_priors - current_priors
    if new_prior_keys:
        roles.add("priors")
    new_prior_names = [
        _clean(item.get("name"))
        for item in next_tab.get("prior_datasets", [])
        if isinstance(item, Mapping) and _key(item.get("name")) in new_prior_keys
    ]
    return roles, new_prior_names


def save_bornhuetter_ferguson_method(
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
    incoming = _contract_call(
        normalize_bornhuetter_ferguson_method,
        method,
        require_complete=False,
    )
    method_name, output_dataset = _identity(incoming)
    method_path = _method_path(project, reserving, method_name)
    sidecar_path = _sidecar_path(project, reserving, output_dataset)
    with _lock(project, reserving), dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        current_future = _READ_EXECUTOR.submit(_read_json, method_path)
        sidecar_future = _READ_EXECUTOR.submit(_read_json, sidecar_path)
        current = current_future.result()
        existing_sidecar = sidecar_future.result()
        if current:
            if _clean(current.get("json_format")) != BF_JSON_FORMAT:
                raise HTTPException(409, "BF changed on disk; reload it before saving.")
            current = _contract_call(
                normalize_bornhuetter_ferguson_method,
                current,
                require_complete=True,
            )
            current_name, current_output = _identity(current)
            if _key(current_name) != _key(method_name) or _key(current_output) != _key(output_dataset):
                raise HTTPException(409, "An existing BF cannot change its method or output identity during Save.")
            current_revisions = _revision_response(current)
            if expected_owned_revision is not None \
                    and _clean(expected_owned_revision) != current_revisions["owned_revision"]:
                raise HTTPException(409, "BF owned settings changed on disk; reload before saving.")
            merged = _contract_call(apply_owned_patch, current, method, timestamp=_now())
        else:
            if expected_owned_revision is not None and _clean(expected_owned_revision):
                raise HTTPException(409, "BF was removed on disk; reload before saving.")
            merged = incoming
        if existing_sidecar:
            owner = _clean(existing_sidecar.get("method_name")) or _clean(
                existing_sidecar.get("dataset_name")
            )
            owner_type = dataset_sidecar_status_service.normalize_method_type(
                existing_sidecar.get("method_type"), existing_sidecar.get("source_kind")
            )
            if _key(owner) != _key(method_name) \
                    or owner_type != dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON:
                raise HTTPException(
                    409,
                    f"Output dataset '{output_dataset}' is already owned by '{owner}'. Choose a unique BF name.",
                )
        roles, prior_names = _roles_for_save(current or None, merged)
        if roles:
            refreshed = _recalculate_with_sources(
                project,
                reserving,
                merged,
                roles,
                changed_precedents=bornhuetter_ferguson_precedent_names(merged),
                prior_names=prior_names,
                allow_review_needed=True,
            )
        else:
            refreshed = _contract_call(
                recalculate_bornhuetter_ferguson_method,
                merged,
                timestamp=_now(),
                update_refresh_timestamp=False,
            )
        previous_publication = _revision_response(current)["publication_revision"] if current else ""
        next_publication = _revision_response(refreshed)["publication_revision"]
        publication_changed = not current or previous_publication != next_publication
        published_sidecar, changed_paths = _publish(
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
        published_sidecar,
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
        bornhuetter_ferguson_precedent_names(refreshed),
    )
    response["unreviewed_precedent_count"] = len(response["unreviewed_precedents"])
    try:
        from app_server.services import calculated_dataset_service

        response["propagation"] = calculated_dataset_service.recalculate_dependents(
            project,
            reserving,
            output_dataset,
            _clean(_details(refreshed).get("output_type")) or output_dataset,
            rebuild_index=True,
        )
    except Exception as exc:
        response["propagation"] = {"ok": False, "errors": [{"reason": str(exc)}]}
    response["propagation_ok"] = bool(response["propagation"].get("ok"))
    response["calculated_updates"] = response["propagation"]
    response["index_ok"] = bool(response["propagation"].get("index_ok", True))
    response["index_error"] = _clean(response["propagation"].get("index_error"))
    return response


def _mark_review_needed(
    project_name: str,
    reserving_class: str,
    output_dataset: str,
) -> Dict[str, Any]:
    sidecar_path = _sidecar_path(project_name, reserving_class, output_dataset)
    with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        sidecar = _read_json(sidecar_path)
        if not sidecar:
            return {}
        if dataset_sidecar_status_service.normalize_status(sidecar.get("status")) \
                == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED:
            return sidecar
        sidecar["status"] = dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
        _commit_text_files({sidecar_path: _json_text(sidecar)})
        return sidecar


def _refresh_one(
    project_name: str,
    reserving_class: str,
    output_dataset: str,
    sidecar: Mapping[str, Any],
    changed_names: Iterable[str],
    *,
    blocked_precedent_keys: set[str],
    sidecar_cache: Dict[str, Dict[str, Any]],
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]],
    method_payload: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    method_name = _clean(sidecar.get("method_name")) or output_dataset
    method = dict(method_payload) if isinstance(method_payload, Mapping) else _read_json(
        _method_path(project_name, reserving_class, method_name)
    )
    if not method:
        raise RuntimeError("BF method JSON is missing.")
    if _clean(method.get("json_format")) != BF_JSON_FORMAT:
        raise RuntimeError("BF automatic refresh requires canonical v3 JSON.")
    method = _contract_call(
        normalize_bornhuetter_ferguson_method,
        method,
        require_complete=True,
    )
    tab = _method_tab(method)
    precedent_names = bornhuetter_ferguson_precedent_names(method)
    blocked = [name for name in precedent_names if _key(name) in blocked_precedent_keys]
    if blocked:
        raise RuntimeError("Required BF precedent needs review: " + ", ".join(blocked))
    changed_keys = {_key(name) for name in changed_names if _key(name)}
    latest_name = _clean(tab.get("latest_dataset"))
    dfm_name = _clean(tab.get("dfm_dataset"))
    prior_names = [
        _clean(item.get("name"))
        for item in tab.get("prior_datasets", [])
        if isinstance(item, Mapping) and _clean(item.get("name"))
    ]
    matched = [name for name in precedent_names if _key(name) in changed_keys]
    if not matched:
        return {
            "ok": True,
            "dataset_name": output_dataset,
            "skipped": True,
            "reason": "stale_reverse_dependency_edge",
        }
    if _key(latest_name) in changed_keys:
        roles = {"latest", "dfm", "priors"}
        selected_priors = None
    else:
        roles: set[str] = set()
        if _key(dfm_name) in changed_keys:
            roles.add("dfm")
        selected_priors = [name for name in prior_names if _key(name) in changed_keys]
        if selected_priors:
            roles.add("priors")
    if not roles:
        return {
            "ok": True,
            "dataset_name": output_dataset,
            "skipped": True,
            "reason": "stale_reverse_dependency_edge",
        }
    refreshed = _recalculate_with_sources(
        project_name,
        reserving_class,
        method,
        roles,
        changed_precedents=matched,
        prior_names=selected_priors,
        allow_review_needed=True,
        sidecar_cache=sidecar_cache,
        snapshot_cache=snapshot_cache,
    )
    before_revisions = _revision_response(method)
    after_revisions = _revision_response(refreshed)
    if before_revisions["derived_revision"] == after_revisions["derived_revision"]:
        # Preserve method bytes when a source save did not change the embedded
        # snapshot; only a Review Needed sidecar may need restoration.
        refreshed["method_metadata"]["data_refreshed"] = method["method_metadata"]["data_refreshed"]
    output_changed = (
        before_revisions["publication_revision"]
        != after_revisions["publication_revision"]
    )
    before_text = _json_text(method)
    after_text = _json_text(refreshed)
    updated_sidecar, changed_paths = _publish(
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
        "dataset_type": _clean(_details(refreshed).get("output_type")) or output_dataset,
        "updated": before_text != after_text,
        "output_changed": output_changed,
        "status_refreshed": (
            dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
            == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
            and dataset_sidecar_status_service.normalize_status(updated_sidecar.get("status"))
            == dataset_sidecar_status_service.STATUS_CURRENT
        ),
        "method": refreshed,
        "sidecar": updated_sidecar,
        "changed_paths": changed_paths,
    }


def _cascade_names(report: Mapping[str, Any]) -> Tuple[List[str], List[str]]:
    fresh: List[str] = []
    failed: List[str] = []
    fresh.extend(
        _clean(item.get("dataset_type_name"))
        for item in report.get("updated", [])
        if isinstance(item, Mapping) and _clean(item.get("dataset_type_name"))
    )
    failed.extend(
        _clean(item.get("dataset_type_name"))
        for item in report.get("skipped", [])
        if isinstance(item, Mapping) and _clean(item.get("dataset_type_name"))
    )
    for field in ("dfm_updates", "result_selection_updates"):
        domain = report.get(field) if isinstance(report.get(field), Mapping) else {}
        for result_field in ("updated", "status_refreshed"):
            fresh.extend(
                _clean(item.get("dataset_name") or item.get("dataset_type"))
                for item in domain.get(result_field, [])
                if isinstance(item, Mapping)
                and _clean(item.get("dataset_name") or item.get("dataset_type"))
            )
        failed.extend(
            _clean(item.get("dataset_name") or item.get("dataset_type"))
            for item in domain.get("errors", [])
            if isinstance(item, Mapping)
            and _clean(item.get("dataset_name") or item.get("dataset_type"))
        )
        if field == "result_selection_updates":
            fresh.extend(
                _clean(name)
                for name in domain.get("downstream_fresh_names", [])
                if _clean(name)
            )
            failed.extend(
                _clean(name)
                for name in domain.get("downstream_blocked_names", [])
                if _clean(name)
            )
    return _unique_names(fresh), _unique_names(failed)


def _refresh_downstream_domains(
    project_name: str,
    reserving_class: str,
    output_name: str,
    output_type: str,
    *,
    finalize_method_review_status: bool = True,
) -> Dict[str, Any]:
    from app_server.services import calculated_dataset_service

    return calculated_dataset_service.recalculate_dependents(
        project_name,
        reserving_class,
        output_name,
        output_type,
        include_bornhuetter_ferguson=False,
        finalize_method_review_status=finalize_method_review_status,
        rebuild_index=False,
    )


def refresh_bornhuetter_ferguson_method(
    project_name: str,
    reserving_class: str,
    method_name: str,
) -> Dict[str, Any]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(400, "project_name, reserving_class, and method_name are required.")
    output_name = name
    sidecar_path = _sidecar_path(project, reserving, output_name)
    with _lock(project, reserving), dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        method_future = _READ_EXECUTOR.submit(
            _read_json,
            _method_path(project, reserving, name),
        )
        sidecar_future = _READ_EXECUTOR.submit(_read_json, sidecar_path)
        method = method_future.result()
        sidecar = sidecar_future.result()
        if not method:
            raise HTTPException(404, f"BF method not found: {name}")
        if not sidecar:
            raise HTTPException(409, "BF output sidecar is missing.")
        if _clean(method.get("json_format")) != BF_JSON_FORMAT:
            raise HTTPException(422, "BF refresh requires canonical v3 JSON.")
        was_review_needed = (
            dataset_sidecar_status_service.normalize_status(sidecar.get("status"))
            == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
        )
        try:
            result = _refresh_one(
                project,
                reserving,
                output_name,
                sidecar,
                bornhuetter_ferguson_precedent_names(method),
                blocked_precedent_keys=set(),
                sidecar_cache={},
                snapshot_cache={},
                method_payload=method,
            )
            if was_review_needed:
                _mark_review_needed(project, reserving, output_name)
                result["sidecar"] = _read_json(sidecar_path) or result.get("sidecar") or sidecar
                result["status_refreshed"] = False
        except Exception:
            _mark_review_needed(project, reserving, output_name)
            dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                project,
                reserving,
                [output_name],
            )
            raise
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
    if response["output_changed"] or response["status_refreshed"]:
        try:
            response["propagation"] = _refresh_downstream_domains(
                project,
                reserving,
                output_name,
                _clean(result.get("dataset_type")) or output_name,
            )
            from app_server.services import dataset_instance_index_service

            try:
                dataset_instance_index_service.rebuild_index(project, reserving)
                response["propagation"]["index_ok"] = True
                response["propagation"]["index_error"] = ""
            except Exception as exc:
                response["propagation"]["index_ok"] = False
                response["propagation"]["index_error"] = str(exc)
        except Exception as exc:
            response["propagation"] = {"ok": False, "errors": [{"reason": str(exc)}]}
    else:
        response["propagation"] = {
            "ok": True,
            "skipped": True,
            "reason": "publication_unchanged",
        }
    response["propagation_ok"] = bool(response["propagation"].get("ok"))
    response["calculated_updates"] = response["propagation"]
    response["index_ok"] = bool(response["propagation"].get("index_ok", True))
    response["index_error"] = _clean(response["propagation"].get("index_error"))
    return response


def refresh_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_names: Iterable[Any],
    *,
    rebuild_index: bool = True,
    blocked_precedent_names: Iterable[Any] = (),
    finalize_method_review_status: bool = True,
) -> Dict[str, Any]:
    """Refresh BF reverse-edge branches and feed changed BF outputs through other domains."""

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    changed_names = _unique_names(changed_dataset_names)
    queue = list(changed_names)
    blocked_keys = {_key(name) for name in blocked_precedent_names if _key(name)}
    sidecar_cache: Dict[str, Dict[str, Any]] = {}
    snapshot_cache: Dict[SnapshotCacheKey, Dict[str, Any]] = {}
    visit_counts: Dict[str, int] = {}
    updated: List[Dict[str, Any]] = []
    status_refreshed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    index_error = ""
    with _lock(project, reserving):
        while queue:
            frontier = _unique_names(queue)
            queue = []
            allowed_frontier: List[str] = []
            for name in frontier:
                normalized = _key(name)
                visit_counts[normalized] = visit_counts.get(normalized, 0) + 1
                if visit_counts[normalized] > MAX_REFRESH_VISITS_PER_DATASET:
                    errors.append({
                        "dataset_name": name,
                        "reason": "BF dependency refresh did not converge.",
                    })
                    continue
                allowed_frontier.append(name)
            if not allowed_frontier:
                continue
            source_sidecars = _read_sidecars(
                project,
                reserving,
                allowed_frontier,
                sidecar_cache,
            )
            dependent_sources: Dict[str, Dict[str, Dict[str, Any]]] = {}
            for source_name in allowed_frontier:
                source_sidecar = source_sidecars.get(source_name) or {}
                for dependent_name in dataset_sidecar_status_service.entry_names(
                    source_sidecar.get("Dependents")
                ):
                    dependent_sources.setdefault(dependent_name, {})[source_name] = source_sidecar
            if not dependent_sources:
                continue
            dependent_sidecars = _read_sidecars(
                project,
                reserving,
                dependent_sources,
                sidecar_cache,
            )
            method_paths_by_dependent: Dict[str, str] = {}
            for dependent_name, sidecar in dependent_sidecars.items():
                if dataset_sidecar_status_service.normalize_method_type(
                    sidecar.get("method_type"), sidecar.get("source_kind")
                ) != dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON:
                    continue
                method_name = _clean(sidecar.get("method_name")) or dependent_name
                method_paths_by_dependent[dependent_name] = _method_path(
                    project,
                    reserving,
                    method_name,
                )
            method_futures = {
                path: _READ_EXECUTOR.submit(_read_json, path)
                for path in set(method_paths_by_dependent.values())
            }
            dependent_methods = {
                dependent_name: method_futures[path].result()
                for dependent_name, path in method_paths_by_dependent.items()
            }
            for dependent_name in sorted(dependent_sources, key=lambda item: (_key(item), item)):
                sidecar = dependent_sidecars.get(dependent_name) or {}
                if not sidecar:
                    errors.append({
                        "dataset_name": dependent_name,
                        "reason": "dependency_sidecar_missing",
                    })
                    blocked_keys.add(_key(dependent_name))
                    continue
                method_type = dataset_sidecar_status_service.normalize_method_type(
                    sidecar.get("method_type"), sidecar.get("source_kind")
                )
                if method_type != dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON:
                    skipped.append({
                        "dataset_name": dependent_name,
                        "reason": "non_bf_dependent_handled_by_central_cascade",
                    })
                    continue
                try:
                    with dataset_sidecar_status_service.sidecar_write_lock(
                        _sidecar_path(project, reserving, dependent_name)
                    ):
                        result = _refresh_one(
                            project,
                            reserving,
                            dependent_name,
                            sidecar,
                            dependent_sources[dependent_name],
                            blocked_precedent_keys=blocked_keys,
                            sidecar_cache=sidecar_cache,
                            snapshot_cache=snapshot_cache,
                            method_payload=dependent_methods.get(dependent_name, {}),
                        )
                except Exception as exc:
                    blocked_keys.add(_key(dependent_name))
                    review_sidecar = _mark_review_needed(project, reserving, dependent_name)
                    if review_sidecar:
                        sidecar_cache[_key(dependent_name)] = review_sidecar
                    touched = dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                        project,
                        reserving,
                        [dependent_name],
                    )
                    for item in touched:
                        sidecar_cache.pop(_key(item.get("dataset_name")), None)
                    errors.append({"dataset_name": dependent_name, "reason": str(exc)})
                    queue.append(dependent_name)
                    continue
                refreshed_sidecar = result.get("sidecar") or sidecar
                sidecar_cache[_key(dependent_name)] = refreshed_sidecar
                if result.get("updated"):
                    updated.append({
                        "dataset_name": dependent_name,
                        "dataset_type": result.get("dataset_type") or dependent_name,
                        "output_changed": bool(result.get("output_changed")),
                    })
                if result.get("status_refreshed"):
                    status_refreshed.append({"dataset_name": dependent_name})
                if not result.get("updated"):
                    skipped.append({
                        "dataset_name": dependent_name,
                        "reason": result.get("reason") or (
                            "status_refreshed" if result.get("status_refreshed") else "not_updated"
                        ),
                    })
                if not result.get("output_changed") and not result.get("status_refreshed"):
                    continue
                blocked_keys.discard(_key(dependent_name))
                touched = dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                    project,
                    reserving,
                    [dependent_name],
                )
                for item in touched:
                    sidecar_cache.pop(_key(item.get("dataset_name")), None)
                queue.append(dependent_name)
                try:
                    cascade = _refresh_downstream_domains(
                        project,
                        reserving,
                        dependent_name,
                        _clean(result.get("dataset_type")) or dependent_name,
                        finalize_method_review_status=False,
                    )
                    fresh_names, failed_names = _cascade_names(cascade)
                    queue.extend(fresh_names)
                    queue.extend(failed_names)
                    blocked_keys.difference_update(_key(name) for name in fresh_names)
                    blocked_keys.update(_key(name) for name in failed_names)
                    for name in [*fresh_names, *failed_names]:
                        sidecar_cache.pop(_key(name), None)
                    if not cascade.get("ok", True):
                        errors.append({
                            "dataset_name": dependent_name,
                            "reason": "Downstream refresh failed after BF publication.",
                            "cascade": cascade,
                        })
                except Exception as exc:
                    sidecar_cache.clear()
                    snapshot_cache.clear()
                    errors.append({
                        "dataset_name": dependent_name,
                        "reason": f"Downstream refresh failed after BF publication: {exc}",
                    })
        review_status_updates = (
            dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                project,
                reserving,
                changed_names,
            )
            if finalize_method_review_status
            else []
        )
        if (updated or status_refreshed or review_status_updates) and rebuild_index:
            try:
                from app_server.services import dataset_instance_index_service

                dataset_instance_index_service.rebuild_index(project, reserving)
            except Exception as exc:
                index_error = str(exc)

    def unique_updates(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        by_key: Dict[str, Dict[str, Any]] = {}
        for item in items:
            name = _clean(item.get("dataset_name"))
            if name:
                by_key.setdefault(_key(name), item)
        return [by_key[key] for key in sorted(by_key)]

    return {
        "ok": not errors,
        "project_name": project,
        "reserving_class": reserving,
        "changed_dataset_names": changed_names,
        "updated": unique_updates(updated),
        "status_refreshed": unique_updates(status_refreshed),
        "skipped": skipped,
        "errors": errors,
        "review_status_updates": review_status_updates,
        "index_ok": not index_error,
        "index_error": index_error,
    }
