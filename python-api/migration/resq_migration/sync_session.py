"""Run one ArcRho/ResQ reserving-class synchronization session.

This module owns every step of a synchronization that touches ResQ COM or
reserving-class files: the two inventories, the plan comparison, and the
apply pass that writes each accepted row.  It deliberately owns no user
interface.  The only supported host is a ResQ-connected ArcRho Bridge worker,
which runs it from the shared request queue on behalf of a client macro that
may sit on a machine without ResQ installed at all.

The session is split into the two phases that queue transport requires:

``preview_sync``
    Collect both inventories, build the plan, and return display-ready rows
    plus the immutable ``signature`` of each row.

``apply_sync``
    Recheck those signatures against a freshly observed plan and, only when
    every reviewed row still matches, apply the accepted actions.

Splitting the phases this way keeps the guarantee the single-process macro
used to get for free: nothing is written when an observation changed while a
person was reading the review table.  The reviewed signature travels with the
apply request rather than being recomputed beside the write, so the check now
covers the whole review window instead of a few seconds inside one call.

``runtime`` is supplied by the host rather than discovered here, so the Bridge
can bind its frozen bundle and a test can bind stubs.  Build one with
``build_runtime``.
"""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from arcrho_api.timestamps import format_display_timestamp

_NAME_SPACE_RE = re.compile(r"\s+")


def _name_key(value: object) -> str:
    """Map an ArcRho or ResQ display name onto their shared logical identity.

    ArcRho keeps every name whitespace-normalized. ResQ names can carry stray
    double spaces that stay as they are, so every comparison of a ResQ name
    against an ArcRho name goes through this one key. It is the same rule the
    sync contract's ``logical_key`` applies when pairing rows, so one ResQ
    object maps onto exactly one ArcRho item whatever its spacing; the ResQ
    spelling itself is only ever used to address or name the ResQ object.
    """

    return _NAME_SPACE_RE.sub(" ", str(value or "").strip()).casefold()


# Host contract version. The Bridge refuses a bundle whose session API it was
# not built against, the same way the macro used to pin the support release.
# 2: ``build_runtime`` takes the ResQ account the session connects with.
SYNC_SESSION_API_VERSION = 2

MAX_JSON_READ_WORKERS = 8

KIND_DATASET = "Dataset"
KIND_DFM = "DFM"
KIND_BF = "Bornhuetter Ferguson"
KIND_CC = "Cape Cod"
KIND_RS = "Result Selection"
KIND_BS_SR = "B&S Settlement Rate"
KIND_BS_CRA = "B&S Case Reserve Adequacy"
KIND_BOOTSTRAP = "Bootstrap"

_METHOD_KINDS = {KIND_DFM, KIND_BF, KIND_CC, KIND_RS, KIND_BS_SR, KIND_BS_CRA, KIND_BOOTSTRAP}
_EXPORTABLE_METHOD_KINDS = {KIND_DFM, KIND_BF, KIND_CC, KIND_RS}

# Tie-break rank inside one write direction. The dependency walk decides the
# order wherever one accepted row reads another; rows with no such link fall
# back to this rank so plain datasets precede the methods that read them, DFMs
# precede the BF and Cape Cod methods that read their output, and Result
# Selections, which only consume other outputs, come last.
_WRITE_KIND_RANK = {KIND_DATASET: 0, KIND_DFM: 1, KIND_BF: 2, KIND_CC: 2, KIND_RS: 3}


def _dependency_names(entries: object) -> list[str]:
    """Return the dataset names in a sidecar ``precedents``/``dependents`` list."""

    names: list[str] = []
    for entry in entries if isinstance(entries, list) else []:
        name = entry.get("dataset_name") if isinstance(entry, Mapping) else entry
        text = " ".join(str(name or "").split())
        if text:
            names.append(text)
    return names


def _row_precedent_names(row: Mapping[str, Any]) -> list[str]:
    """Name every ArcRho dataset this row's ArcRho side reads.

    A row carries any sidecar ``precedents`` it has, the same graph ArcRho's
    own recompute walk follows. A method row also names its linked datasets
    in its method tabs; the ResQ writer resolves those links by name, so they
    are dependencies of the ResQ write as well. Calculated datasets never
    reach the plan, so in practice the edges run from plain datasets to the
    methods that read them and between methods.
    """

    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    kind = str(row.get("kind") or KIND_DATASET)
    details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), Mapping) else {}
    names: list[object] = list(_dependency_names(payload.get("precedents")))
    if kind == KIND_DFM:
        names.append(details.get("input_triangle"))
    elif kind == KIND_BF:
        names.extend((method_tab.get("latest_dataset"), method_tab.get("dfm_dataset")))
        priors = method_tab.get("prior_datasets") if isinstance(method_tab.get("prior_datasets"), list) else []
        names.extend(prior.get("name") for prior in priors if isinstance(prior, Mapping))
    elif kind == KIND_CC:
        names.extend((
            method_tab.get("exposure_dataset"),
            method_tab.get("latest_dataset"),
            method_tab.get("prior_ultimate_dataset"),
        ))
    elif kind == KIND_RS:
        loaded = method_tab.get("loaded_datasets") if isinstance(method_tab.get("loaded_datasets"), list) else []
        names.extend(source.get("name") for source in loaded if isinstance(source, Mapping))
    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        text = " ".join(str(name or "").split())
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            out.append(text)
    return out


def _dependency_ordered_rows(sync_contract, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order rows so every dependency accepted in the same batch is written first.

    This is the topological walk ArcRho's own recompute uses, restricted to
    the accepted rows: a row is emitted only after each row it reads. Rows
    with no dependency between them keep the kind rank and then the review
    order, and a cycle, which ArcRho's graph never contains, is broken at its
    back edge instead of failing.
    """

    def seed_order(index: int, row: Mapping[str, Any]) -> tuple[int, int]:
        return _WRITE_KIND_RANK.get(str(row.get("kind") or ""), len(_WRITE_KIND_RANK)), index

    indexed = sorted(enumerate(rows), key=lambda pair: seed_order(*pair))
    by_key: dict[str, tuple[int, dict[str, Any]]] = {}
    key_of_index: dict[int, str] = {}
    for index, row in indexed:
        key = str(row.get("key") or "")
        if not key or key in by_key:
            key = f"#{index}"
        by_key[key] = (index, row)
        key_of_index[index] = key
    ordered: list[dict[str, Any]] = []
    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(key: str) -> None:
        if key in visited or key in visiting:
            return
        visiting.add(key)
        _index, row = by_key[key]
        dependencies: list[tuple[str, tuple[int, dict[str, Any]]]] = []
        for name in _row_precedent_names(row):
            dependency_key = sync_contract.logical_key(name)
            if dependency_key != key and dependency_key in by_key:
                dependencies.append((dependency_key, by_key[dependency_key]))
        for dependency_key, _pair in sorted(dependencies, key=lambda item: seed_order(*item[1])):
            visit(dependency_key)
        visiting.discard(key)
        visited.add(key)
        ordered.append(row)

    for index, _row in indexed:
        visit(key_of_index[index])
    return ordered


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read ArcRho metadata {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"ArcRho metadata must contain a JSON object: {path}")
    return payload


def _directory_files(directory: Path, suffix: str) -> list[tuple[Path, float]]:
    rows: list[tuple[Path, float]] = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if not entry.name.casefold().endswith(suffix) or not entry.is_file(follow_symlinks=False):
                    continue
                try:
                    modified = float(entry.stat(follow_symlinks=False).st_mtime)
                except OSError as exc:
                    raise RuntimeError(f"Could not read ArcRho file metadata {entry.path}: {exc}") from exc
                rows.append((Path(entry.path), modified))
    except (FileNotFoundError, NotADirectoryError):
        return []
    rows.sort(key=lambda item: item[0].name.casefold())
    return rows


def _read_json_entries(entries: list[tuple[Path, float]]) -> list[tuple[Path, float, dict[str, Any]]]:
    if not entries:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_JSON_READ_WORKERS, len(entries))) as executor:
        payloads = list(executor.map(lambda item: _read_json(item[0]), entries))
    return [(path, modified, payload) for (path, modified), payload in zip(entries, payloads)]


def _file_timestamp_text(value: float) -> str:
    if not value:
        return ""
    try:
        return datetime.fromtimestamp(value, timezone.utc).astimezone().isoformat()
    except (OSError, OverflowError, ValueError):
        return ""


def _first_text(container: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(container.get(key) or "").strip()
        if value:
            return value
    return ""


def _parsed_timestamp(parser, value: object) -> float | None:
    try:
        parsed = parser(value)
    except Exception:
        return None
    try:
        number = float(parsed)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _method_kind(method_type: object) -> str:
    normalized = str(method_type or "").strip().casefold().replace("_", " ")
    if normalized in {"", "none"}:
        # A plain dataset's sidecar says ``method_type: "None"``.
        return KIND_DATASET
    if normalized == "dfm":
        return KIND_DFM
    if normalized in {"bornhuetter ferguson", "bf"}:
        return KIND_BF
    if normalized in {"cape cod", "cc"}:
        return KIND_CC
    if normalized in {"result selection", "rs"}:
        return KIND_RS
    if "settlement" in normalized or normalized in {"berquist sherman sr", "b&s sr"}:
        return KIND_BS_SR
    if "case reserve" in normalized or normalized in {"berquist sherman cra", "b&s cra"}:
        return KIND_BS_CRA
    if normalized in {"bootstrap", "bst"}:
        return KIND_BOOTSTRAP
    return str(method_type or "").strip() or KIND_DATASET


def _payload_is_triangle(payload: Mapping[str, Any]) -> bool:
    """A sidecar names its shape in ``data_format``; there is no numeric twin."""
    return str(payload.get("data_format") or "").strip().casefold() == "triangle"


def _kind_from_code(code: object, fallback: object = "") -> str:
    value = _safe_int(code, -1)
    return {
        0: KIND_DATASET,
        1: KIND_DFM,
        2: KIND_BF,
        3: KIND_CC,
        4: KIND_RS,
        6: KIND_BOOTSTRAP,
        8: KIND_BS_SR,
        9: KIND_BS_CRA,
    }.get(value, _method_kind(fallback) if fallback else f"ResQ Method {value}")


def _method_modified(payload: Mapping[str, Any]) -> str:
    for key in ("method_metadata", "method_metadata"):
        metadata = payload.get(key)
        if isinstance(metadata, Mapping):
            value = _first_text(metadata, "last_modified", "last_modified", "modified_at", "modified", "updated_at")
            if value:
                return value
    return ""


def _sidecar_modified(payload: Mapping[str, Any]) -> str:
    if str(payload.get("source_kind") or "").strip().casefold() == "engine":
        source_modified = str(payload.get("source_modified") or "").strip()
        if source_modified:
            return source_modified
    return _first_text(payload, "updated_at", "last_modified", "modified_at", "modified", "updated")


def collect_arcrho_inventory(runtime: Mapping[str, Any], rc_dir: Path) -> list[dict[str, Any]]:
    """Read each ArcRho artifact folder once and return logical datasets/method outputs."""

    migration = runtime["migration"]
    parser = runtime["parse_timestamp"]
    method_entry_from_payload = runtime["method_entry"]
    sync_contract = runtime["sync_contract"]

    sidecar_entries = _read_json_entries(_directory_files(rc_dir / migration.DATASET_SIDECAR_DIR, ".json"))
    method_entries = _read_json_entries(_directory_files(rc_dir / migration.METHOD_DATA_DIR, ".json"))
    csv_entries = _directory_files(rc_dir / migration.DATASET_CACHE_DIR, ".csv")
    csv_by_name = {path.name.casefold(): (path, modified) for path, modified in csv_entries}

    items: list[dict[str, Any]] = []
    method_keys: set[str] = set()
    for path, fallback_modified, payload in method_entries:
        entry = method_entry_from_payload(payload, path.name)
        if not isinstance(entry, Mapping):
            continue
        name = sync_contract.clean_name(entry.get("dataset_name"))
        if not name:
            continue
        kind = _method_kind(entry.get("method_type"))
        modified_text = _method_modified(payload)
        timestamp_source = "Method metadata"
        if not modified_text:
            modified_text = _file_timestamp_text(fallback_modified)
            timestamp_source = "File modified"
        can_export = kind in _EXPORTABLE_METHOD_KINDS
        reason = ""
        if not can_export:
            reason = (
                "ArcRho-to-ResQ write-back is not supported for Berquist Sherman or Bootstrap methods."
                if kind in {KIND_BS_SR, KIND_BS_CRA, KIND_BOOTSTRAP}
                else f"ArcRho-to-ResQ write-back is not supported for {kind}."
            )
        item = {
            "name": name,
            "kind": kind,
            "data_format": str(entry.get("data_format") or ""),
            "dataset_type": str(entry.get("dataset_type") or name),
            "modified": modified_text,
            "modified_timestamp": _parsed_timestamp(parser, modified_text),
            "timestamp_source": timestamp_source,
            "can_export_to_resq": can_export,
            "export_block_reason": reason,
            "export_scope_note": (
                "Only the fields supported by the existing ResQ writer are applied; "
                "see the sync documentation for method-specific limits."
                if can_export else ""
            ),
            "payload": payload,
            "method_name": sync_contract.clean_name(entry.get("method_name") or name),
            "method_file": path.name,
        }
        items.append(item)
        method_keys.add(sync_contract.logical_key(name))

    sidecar_keys: set[str] = set()
    for path, fallback_modified, payload in sidecar_entries:
        name = sync_contract.clean_name(payload.get("dataset_name") or migration._normalize_cached_dataset_name(path.stem))
        key = sync_contract.logical_key(name)
        if not key:
            continue
        sidecar_keys.add(key)
        if key in method_keys:
            continue
        kind = _method_kind(payload.get("method_type"))
        if kind == KIND_DATASET and bool(payload.get("calculated")):
            # A calculated dataset is recomputed by propagation on both sides
            # and nobody edits it directly, so there is nothing to reconcile.
            continue
        if kind == KIND_DATASET and str(payload.get("source_kind") or "").strip().casefold() == "engine":
            # An engine dataset is rebuilt from source data on both sides, so
            # neither side holds a hand-edited copy to reconcile either.
            continue
        modified_text = _sidecar_modified(payload)
        timestamp_source = "Dataset metadata"
        if not modified_text:
            modified_text = _file_timestamp_text(fallback_modified)
            timestamp_source = "File modified"
        csv_file = str(payload.get("csv_file") or "").strip()
        csv_available = bool(csv_file and csv_file.casefold() in csv_by_name)
        can_export = kind == KIND_DATASET and csv_available
        if kind != KIND_DATASET:
            block_reason = f"The {kind} method JSON is missing; only its output sidecar is present."
        elif not csv_available:
            block_reason = "The ArcRho dataset CSV cache is missing; open the dataset once to build it."
        else:
            block_reason = ""
        items.append({
            "name": name,
            "kind": kind,
            "data_format": str(payload.get("data_format") or ""),
            "dataset_type": str(payload.get("dataset_type") or name),
            "modified": modified_text,
            "modified_timestamp": _parsed_timestamp(parser, modified_text),
            "timestamp_source": timestamp_source,
            "can_export_to_resq": can_export,
            "export_block_reason": block_reason,
            "payload": payload,
            "sidecar_file": path.name,
            "csv_file": csv_file,
        })

    # A cache with no sidecar still belongs in the review inventory, but it is
    # deliberately not exportable because the sidecar owns its data contract.
    for path, fallback_modified in csv_entries:
        names = migration._cached_dataset_names_from_file(path.name)
        for raw_name in sorted(names, key=str.casefold):
            name = sync_contract.clean_name(raw_name)
            key = sync_contract.logical_key(name)
            if not key or key in sidecar_keys or key in method_keys:
                continue
            modified_text = _file_timestamp_text(fallback_modified)
            items.append({
                "name": name,
                "kind": KIND_DATASET,
                "data_format": "",
                "dataset_type": "",
                "modified": modified_text,
                "modified_timestamp": _parsed_timestamp(parser, modified_text),
                "timestamp_source": "File modified",
                "can_export_to_resq": False,
                "export_block_reason": "The ArcRho dataset sidecar is missing.",
                "payload": {},
                "csv_file": path.name,
            })
    return items


def _safe_attr(migration, item: object, name: str, default=None):
    return migration._safe_attr(item, name, default)


def _required_resq_attr(item: object, name: str, label: str):
    try:
        return getattr(item, name)
    except Exception as exc:
        raise RuntimeError(f"Could not read ResQ {label} {name}: {exc}") from exc


def _resq_modified_item(runtime: Mapping[str, Any], value: object) -> tuple[str, float | None]:
    text = str(runtime["migration"]._iso_or_text(value) or "").strip()
    return text, _parsed_timestamp(runtime["parse_timestamp"], text)


def _resq_object_timestamp(runtime: Mapping[str, Any], migration, value: object) -> tuple[str, float | None, str]:
    """Return the best database-owned timestamp without inventing a fallback."""

    modified = _safe_attr(migration, value, "Modified", "")
    modified_text, modified_timestamp = _resq_modified_item(runtime, modified)
    if modified_timestamp is not None:
        return modified_text, modified_timestamp, "ResQ Modified"
    created = _safe_attr(migration, value, "Created", "")
    created_text, created_timestamp = _resq_modified_item(runtime, created)
    if created_timestamp is not None:
        # Created is useful context for the required two-column display, but it
        # is not a last-modified timestamp and must never decide sync direction.
        return created_text, None, "ResQ Created (Modified unavailable)"
    return modified_text or created_text, None, "ResQ timestamp"


def _iter_resq_collection(collection: object, label: str):
    """Enumerate a COM collection completely or fail the whole preview."""

    try:
        count = int(getattr(collection, "Count"))
    except Exception as exc:
        raise RuntimeError(f"Could not read the ResQ {label} count: {exc}") from exc
    for index in range(1, count + 1):
        try:
            item = collection.Item(index)
        except Exception as exc:
            raise RuntimeError(f"Could not read ResQ {label} item {index}: {exc}") from exc
        if item is None:
            raise RuntimeError(f"ResQ {label} item {index} is unavailable.")
        yield item


def _resq_method_items(runtime: Mapping[str, Any], exporter) -> list[dict[str, Any]]:
    migration = runtime["migration"]
    exporter_module = runtime["exporter_module"]
    rows: list[dict[str, Any]] = []
    collections = (
        (KIND_DFM, exporter.reserving_class.DFMMethods),
        (KIND_BF, exporter.reserving_class.BFMethods),
        (KIND_CC, exporter.reserving_class.CapeCodMethods),
        (KIND_RS, exporter.reserving_class.ResultSelections),
    )
    for kind, factory in collections:
        try:
            collection = factory()
        except Exception as exc:
            raise RuntimeError(f"Could not enumerate ResQ {kind} methods: {exc}") from exc
        for method in _iter_resq_collection(collection, f"{kind} method"):
            output = _required_resq_attr(method, "OutputVector", f"{kind} method")
            raw_output_name = str(_required_resq_attr(output, "Name", f"{kind} output") or "")
            output_name = exporter_module._clean_label(raw_output_name)
            if not output_name:
                raise RuntimeError(f"A ResQ {kind} method has no readable output dataset name.")
            raw_method_name = str(_required_resq_attr(method, "Name", f"{kind} method") or "")
            dataset_type_obj = _required_resq_attr(output, "DatasetType", f"{kind} output")
            dataset_type = exporter_module._clean_label(
                _required_resq_attr(dataset_type_obj, "Name", f"{kind} output Dataset Type")
            ) or output_name
            known_type = bool(migration._is_known_dataset_type(dataset_type))
            modified_text, modified_timestamp, timestamp_source = _resq_object_timestamp(
                runtime, migration, output
            )
            rows.append({
                "name": output_name,
                "kind": kind,
                "data_format": "Vector",
                "modified": modified_text,
                "modified_timestamp": modified_timestamp,
                "timestamp_source": timestamp_source.replace("ResQ ", "ResQ output ", 1),
                "can_import_to_arcrho": known_type,
                "import_block_reason": (
                    "" if known_type else f"Dataset Type {dataset_type} is not configured in ArcRho."
                ),
                "can_receive_from_arcrho": kind in _EXPORTABLE_METHOD_KINDS,
                "receive_block_reason": "" if kind in _EXPORTABLE_METHOD_KINDS else f"ArcRho cannot write {kind} methods to ResQ.",
                "resq_collection": "vector",
                "resq_object_name": raw_output_name,
                "resq_method_name": raw_method_name or raw_output_name,
                "method_name": exporter_module._clean_label(raw_method_name or raw_output_name),
                "dataset_type": dataset_type,
                "resq_object": output,
                "resq_method": method,
            })
    return rows


def collect_resq_inventory(runtime: Mapping[str, Any], exporter) -> list[dict[str, Any]]:
    """Inventory ResQ datasets and supported method outputs with database timestamps."""

    migration = runtime["migration"]
    exporter_module = runtime["exporter_module"]
    sync_contract = runtime["sync_contract"]
    items = _resq_method_items(runtime, exporter)
    method_keys = {sync_contract.logical_key(item["name"]) for item in items}

    collections = (
        ("triangle", exporter.reserving_class.Triangles),
        ("vector", exporter.reserving_class.Vectors),
    )
    for collection_kind, factory in collections:
        try:
            collection = factory()
        except Exception as exc:
            raise RuntimeError(f"Could not enumerate ResQ {collection_kind} datasets: {exc}") from exc
        for obj in _iter_resq_collection(collection, collection_kind):
            raw_name = str(_required_resq_attr(obj, "Name", f"{collection_kind} dataset") or "")
            name = exporter_module._clean_label(raw_name)
            if not name:
                raise RuntimeError(f"A ResQ {collection_kind} dataset has no readable name.")
            if sync_contract.logical_key(name) in method_keys:
                continue
            method_code = _safe_int(
                _required_resq_attr(obj, "MethodType", f"{collection_kind} dataset"),
                -1,
            )
            kind = _kind_from_code(method_code)
            resq_method_name = raw_name
            bs_method = None
            if kind in {KIND_BS_SR, KIND_BS_CRA}:
                bs_entry = migration._find_berquist_sherman_for_triangle(
                    exporter.reserving_class,
                    raw_name,
                    method_code,
                )
                if bs_entry is not None:
                    _variant, bs_method = bs_entry
                    resq_method_name = exporter_module._clean_label(
                        _required_resq_attr(bs_method, "Name", f"{kind} method")
                    )
            modified_text, modified_timestamp, timestamp_source = _resq_object_timestamp(
                runtime, migration, obj
            )
            dataset_type_obj = _required_resq_attr(obj, "DatasetType", f"{collection_kind} dataset")
            dataset_type = exporter_module._clean_label(
                _required_resq_attr(dataset_type_obj, "Name", f"{collection_kind} Dataset Type")
            ) or name
            known_type = bool(migration._is_known_dataset_type(dataset_type))
            calculated = bool(_required_resq_attr(obj, "Calculated", f"{collection_kind} dataset"))
            if kind == KIND_DATASET and calculated:
                # ResQ recomputes it from its formula, as ArcRho does on its
                # side, so the row would only ever report propagation times.
                continue
            if kind == KIND_DATASET and migration._is_engine_generated_instance(
                {"name": name, "dataset_type": dataset_type}
            ):
                # The same rule the import uses to route a dataset to the
                # Engine: generated on both sides, so nothing to reconcile.
                continue
            import_supported = (
                kind in {KIND_DATASET, KIND_BS_SR, KIND_BS_CRA}
                and known_type
                and (kind not in {KIND_BS_SR, KIND_BS_CRA} or bool(bs_method and resq_method_name))
            )
            if kind in {KIND_DFM, KIND_BF, KIND_CC, KIND_RS}:
                # A method-coded output with no matching method object is unsafe
                # to import as a complete method.
                import_supported = False
                import_reason = f"The matching {kind} method object was not found in ResQ."
            elif kind in {KIND_BS_SR, KIND_BS_CRA} and bs_method is None:
                import_reason = f"The matching {kind} method object was not found in ResQ."
            elif kind in {KIND_BS_SR, KIND_BS_CRA} and not resq_method_name:
                import_reason = f"The matching {kind} method has no stable name in ResQ."
            elif not known_type:
                import_reason = f"Dataset Type {dataset_type} is not configured in ArcRho."
            elif kind not in {KIND_DATASET, KIND_BS_SR, KIND_BS_CRA}:
                import_reason = f"ResQ-to-ArcRho import is not supported for {kind}."
            else:
                import_reason = ""
            can_receive = kind == KIND_DATASET
            receive_reason = ""
            if kind in {KIND_BS_SR, KIND_BS_CRA, KIND_BOOTSTRAP}:
                can_receive = False
                receive_reason = f"ArcRho-to-ResQ write-back is not supported for {kind}."
            items.append({
                "name": name,
                "kind": kind,
                "data_format": "Triangle" if collection_kind == "triangle" else "Vector",
                "modified": modified_text,
                "modified_timestamp": modified_timestamp,
                "timestamp_source": timestamp_source,
                "can_import_to_arcrho": import_supported,
                "import_block_reason": import_reason,
                "can_receive_from_arcrho": can_receive,
                "receive_block_reason": receive_reason,
                "resq_collection": collection_kind,
                "resq_object_name": raw_name,
                "resq_method_name": resq_method_name,
                "dataset_type": dataset_type,
                "calculated": calculated,
                "resq_object": obj,
                "resq_method": bs_method,
            })
    return items


def _timestamp_cell(item: Mapping[str, Any]) -> str:
    """Every review row gets an explicit timestamp value for each side.

    Both sides are shown in this machine's local time, the form ResQ's own
    windows and the ArcRho method list use; the comparison itself runs on the
    epoch seconds and never on this text.
    """

    value = str(item.get("modified") or "").strip()
    shown = format_display_timestamp(value, default=value)
    source = str(item.get("timestamp_source") or "").strip()
    if item.get("modified_timestamp") is None:
        if value and source.startswith("ResQ Created"):
            return f"Unknown Modified; Created {shown}"
        return "Unknown"
    return f"{shown} ({source})" if source == "File modified" else shown


def _action_label(action: object) -> str:
    normalized = str(action or "")
    if normalized == "arcrho_to_resq":
        return "ArcRho -> ResQ"
    if normalized == "resq_to_arcrho":
        return "ResQ -> ArcRho"
    return "No action"


def _resq_credentials(runtime: Mapping[str, Any]) -> Mapping[str, str]:
    """The ResQ account this session connects with.

    The host supplies it through ``build_runtime``. Without one, the migration
    module's own constants apply, which with empty user and password means the
    process's Windows identity -- right for a person running the migration
    directly, wrong for a Bridge worker, whose identity is whichever user's
    session claimed the request.
    """

    credentials = runtime.get("resq_credentials")
    if credentials:
        return credentials
    migration = runtime["migration"]
    return {
        "connection_name": migration.CONNECTION_NAME,
        "user_name": migration.USER_NAME,
        "password": migration.PASSWORD,
    }


def _new_exporter(runtime: Mapping[str, Any], project_name: str, rc_path: str, server_root: Path):
    migration = runtime["migration"]
    exporter_module = runtime["exporter_module"]
    credentials = _resq_credentials(runtime)
    return exporter_module.ResQReservingClassExporter(
        migration,
        arcrho_project_name=project_name,
        rc_path=rc_path,
        server_root=server_root,
        resq_project_name=project_name,
        connection_name=credentials["connection_name"],
        resq_user_name=credentials["user_name"],
        resq_password=credentials["password"],
        progress_callback=None,
    )


def _plan_context(runtime: Mapping[str, Any], project_name: str, rc_path: str, server_root: Path, exporter=None):
    migration = runtime["migration"]
    sync_contract = runtime["sync_contract"]
    rc_dir = migration.PROJECT_DATA_DIR / migration._encode_rc_folder(rc_path)
    local = collect_arcrho_inventory(runtime, rc_dir)
    owns_exporter = exporter is None
    session = exporter or _new_exporter(runtime, project_name, rc_path, server_root)
    if owns_exporter:
        session.connect()
    try:
        remote = collect_resq_inventory(runtime, session)
    finally:
        if owns_exporter:
            session.disconnect()
    connection_name = _resq_credentials(runtime)["connection_name"]
    state_path = sync_contract.sync_state_path(server_root, project_name, rc_path, connection_name)
    state = sync_contract.read_sync_state(state_path, project_name, rc_path, connection_name)
    plan = sync_contract.build_sync_plan(local, remote, state)
    return {
        "rc_dir": rc_dir,
        "arcrho": local,
        "resq": remote,
        "state": state,
        "state_path": state_path,
        "plan": plan,
    }


def _export_result_delta(exporter, before: Mapping[str, Any], kind: str) -> tuple[bool, str]:
    count_field = {
        KIND_DATASET: "datasets_written",
        KIND_DFM: "dfms_written",
        KIND_BF: "bfs_written",
        KIND_CC: "ccs_written",
        KIND_RS: "result_selections_written",
    }.get(kind, "")
    before_errors = int(before.get("errors") or 0)
    if int(exporter.counts.get("errors") or 0) > before_errors and exporter.error_details:
        return False, str(exporter.error_details[-1].get("message") or "ResQ write failed.")
    skipped_before = before.get("_skipped") if isinstance(before.get("_skipped"), Mapping) else {}
    for reason, count in exporter.skipped.items():
        if int(count or 0) > int(skipped_before.get(reason) or 0):
            return False, str(reason).replace("_", " ")
    if count_field and int(exporter.counts.get(count_field) or 0) > int(before.get(count_field) or 0):
        return True, "Written to ResQ."
    return False, "ResQ did not report the item as written."


def _export_one_to_resq(exporter, row: Mapping[str, Any]) -> tuple[bool, str]:
    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    kind = str(row.get("kind") or KIND_DATASET)
    before = dict(exporter.counts)
    before["_skipped"] = dict(exporter.skipped)
    if kind == KIND_DATASET:
        expected_values = _preflight_dataset_export(exporter, row)
        payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
        is_triangle = _payload_is_triangle(payload)
        target = exporter._find_triangle(str(row.get("name") or "")) if is_triangle else None
        if target is not None:
            # The general exporter historically tolerates ClearData failures.
            # Selective sync must fail closed because otherwise ArcRho blanks or
            # a shorter triangle could leave stale ResQ cells and be baselined.
            try:
                target.ClearData()
            except Exception as exc:
                raise RuntimeError(
                    "ResQ could not clear the target triangle before synchronization."
                ) from exc
        exporter.export_datasets([payload])
        _verify_dataset_export(exporter, row, expected_values)
    else:
        _preflight_method_export(exporter, row)
        entry = {
            "name": str(item.get("method_name") or row.get("name") or ""),
            "payload": item.get("payload") or {},
        }
        if kind == KIND_DFM:
            exporter.export_dfms([entry])
        elif kind == KIND_BF:
            exporter.export_bfs([entry])
        elif kind == KIND_CC:
            exporter.export_ccs([entry])
        elif kind == KIND_RS:
            existing = exporter._find_method_by_output(
                exporter.reserving_class.ResultSelections(), str(row.get("name") or "")
            )
            if existing is not None:
                try:
                    existing.ClearOverriddenUltimates()
                except Exception as exc:
                    raise RuntimeError(
                        "ResQ could not clear existing Result Selection ultimate overrides."
                    ) from exc
            exporter.export_result_selections([entry])
        else:
            return False, f"ArcRho-to-ResQ write-back is not supported for {kind}."
        _verify_method_export(exporter, row)
    return _export_result_delta(exporter, before, kind)


def _dataset_export_values(exporter, row: Mapping[str, Any]) -> list[list[float | None]]:
    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    csv_file = str(payload.get("csv_file") or "").strip()
    csv_path = (
        exporter.server_root
        / "projects"
        / exporter.arcrho_project_name
        / "data"
        / exporter.migration._encode_rc_folder(exporter.rc_path)
        / exporter.migration.DATASET_CACHE_DIR
        / csv_file
    )
    if not csv_file or not csv_path.is_file():
        raise RuntimeError("The ArcRho dataset CSV cache is missing.")
    values: list[list[float | None]] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as stream:
        for raw_row in csv.reader(stream):
            row_values: list[float | None] = []
            for raw in raw_row:
                text = str(raw or "").strip()
                row_values.append(float(text) if text else None)
            values.append(row_values)
    return values


def _preflight_dataset_export(exporter, row: Mapping[str, Any]) -> list[list[float | None]]:
    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    values = _dataset_export_values(exporter, row)
    is_triangle = _payload_is_triangle(payload)
    if is_triangle:
        return values
    flat = [source[0] if source else None for source in values]
    if any(value is None for value in flat):
        raise RuntimeError(
            "Vector write-back is blocked because ArcRho contains blank values and "
            "the ResQ COM API has no verified blank-cell writer."
        )
    target = exporter._find_vector(str(row.get("name") or ""))
    if target is not None and int(getattr(target, "Count")) != len(flat):
        raise RuntimeError(
            f"Vector length mismatch: ArcRho has {len(flat)} values; ResQ has {int(getattr(target, 'Count'))}."
        )
    return values


def _verify_dataset_export(
    exporter,
    row: Mapping[str, Any],
    values: list[list[float | None]],
) -> None:
    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    is_triangle = _payload_is_triangle(payload)
    name = str(row.get("name") or "")
    if is_triangle:
        target = exporter._find_triangle(name)
        if target is None:
            raise RuntimeError("ResQ did not expose the triangle after the write.")
        origin_count = int(getattr(target, "OriginCount"))
        if origin_count != len(values):
            raise RuntimeError(
                f"ResQ triangle row count did not match ArcRho after the write "
                f"({origin_count} versus {len(values)})."
            )
        for origin_index in range(1, origin_count + 1):
            source_row = values[origin_index - 1]
            width = exporter._triangle_row_width(target, origin_index)
            if width < len(source_row):
                trailing = source_row[width:]
                if any(value is not None for value in trailing):
                    raise RuntimeError("ResQ triangle truncated nonblank ArcRho development values.")
            for development_index in range(1, width + 1):
                expected = source_row[development_index - 1] if development_index <= len(source_row) else None
                if expected is None:
                    try:
                        actual_blank = target.ValuesByIndex(origin_index, development_index)
                    except Exception:
                        # ResQ commonly exposes cleared cells as an unreadable
                        # empty value. ClearData already succeeded before write.
                        continue
                    if actual_blank is not None and abs(float(actual_blank)) > 1e-9:
                        raise RuntimeError(
                            f"ResQ triangle retained a value in ArcRho blank cell "
                            f"({origin_index}, {development_index})."
                        )
                    continue
                actual = float(target.ValuesByIndex(origin_index, development_index))
                if abs(actual - expected) > 1e-9:
                    raise RuntimeError(
                        f"ResQ triangle verification failed at ({origin_index}, {development_index})."
                    )
        return

    flat = [source[0] for source in values]
    target = exporter._find_vector(name)
    if target is None or int(getattr(target, "Count")) != len(flat):
        raise RuntimeError("ResQ vector length did not match ArcRho after the write.")
    for index, expected in enumerate(flat, start=1):
        actual = float(target.ValuesByIndex(index))
        if expected is None or abs(actual - expected) > 1e-9:
            raise RuntimeError(f"ResQ vector verification failed at position {index}.")


def _preflight_method_export(
    exporter,
    row: Mapping[str, Any],
    *,
    satisfied: Callable[[str], bool] | None = None,
) -> None:
    """Block known lossy dependency failures before mutating a ResQ method.

    ``satisfied`` names datasets an earlier row of the same batch will have
    created by the time this row is written; the strict check without it runs
    again immediately before the write.
    """

    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    kind = str(row.get("kind") or "")
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), Mapping) else {}

    def require(name: object, finder, role: str) -> None:
        clean = str(name or "").strip()
        if not clean or finder(clean) is not None:
            return
        if satisfied is not None and satisfied(clean):
            return
        raise RuntimeError(f"Required {role} dataset is not present in ResQ: {clean}")

    def require_present(name: object, finder, role: str) -> None:
        clean = str(name or "").strip()
        if not clean:
            raise RuntimeError(
                f"The ArcRho {role} link is blank; ResQ link clearing is not supported safely."
            )
        require(clean, finder, role)

    def find_triangle_or_vector(name: str):
        triangle = exporter._find_triangle(name)
        return triangle if triangle is not None else exporter._find_vector(name)

    if kind == KIND_DFM:
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
        method_name = str(details.get("name") or item.get("method_name") or row.get("name") or "").strip()
        target = exporter._find_in("dfm_methods", exporter.reserving_class.DFMMethods, method_name)
        require_present(details.get("input_triangle"), exporter._find_triangle, "DFM input triangle")
        if target is None:
            return
        expected_input = _name_key(details.get("input_triangle"))
        actual_input = _name_key(getattr(getattr(target, "InputTriangle"), "Name"))
        if actual_input != expected_input:
            raise RuntimeError(
                "Existing ResQ DFM input triangle differs from ArcRho; safe retargeting is not supported."
            )
        expected_origin_length = int(details.get("origin_length") or 0)
        expected_development_length = int(details.get("development_length") or 0)
        if expected_origin_length and int(getattr(target, "OriginLength")) != expected_origin_length:
            raise RuntimeError("Existing ResQ DFM origin length differs from ArcRho.")
        if expected_development_length and int(getattr(target, "DevelopmentLength")) != expected_development_length:
            raise RuntimeError("Existing ResQ DFM development length differs from ArcRho.")
        ratios_tab = payload.get("ratios_tab") if isinstance(payload.get("ratios_tab"), Mapping) else {}
        ratio_triangle = ratios_tab.get("ratio_triangle") if isinstance(ratios_tab.get("ratio_triangle"), Mapping) else {}
        excluded = ratio_triangle.get("excluded") if isinstance(ratio_triangle.get("excluded"), list) else []
        origin_count = int(getattr(target, "OriginCount", 0) or 0)
        for origin_index, source_row in enumerate(excluded, start=1):
            if not isinstance(source_row, list):
                continue
            meaningful = [
                index for index, value in enumerate(source_row, start=1)
                if value in (0, 1, False, True, "0", "1")
            ]
            if not meaningful:
                continue
            if origin_index > origin_count:
                raise RuntimeError("ResQ DFM has fewer origin rows than the ArcRho exclusion pattern.")
            ratio_count = max(int(target.DevelopmentCount(origin_index)) - 1, 0)
            if max(meaningful) > ratio_count:
                raise RuntimeError("ResQ DFM has fewer ratio columns than the ArcRho exclusion pattern.")

        averages = ratios_tab.get("average_formulas") if isinstance(ratios_tab.get("average_formulas"), Mapping) else {}
        labels = averages.get("label") if isinstance(averages.get("label"), list) else []
        selected = averages.get("selected") if isinstance(averages.get("selected"), list) else []
        available = exporter._average_formula_display_indexes(target)
        columns = exporter._dfm_development_column_count(target)
        for development_index in range(1, columns + 1):
            selected_label = ""
            for row_index, source_row in enumerate(selected):
                if row_index < len(labels) and isinstance(source_row, list) and development_index - 1 < len(source_row):
                    if source_row[development_index - 1] in (1, True, "1"):
                        selected_label = str(labels[row_index])
                        break
            if selected_label and selected_label not in available:
                raise RuntimeError(f"ResQ DFM has no selected-average label: {selected_label}")
        for row_index, source_row in enumerate(selected):
            if not isinstance(source_row, list):
                continue
            if any(value in (1, True, "1") for value in source_row[columns:]):
                raise RuntimeError("ResQ DFM has fewer selection columns than ArcRho.")

        values = averages.get("values") if isinstance(averages.get("values"), list) else []
        user_row = exporter._user_entry_payload_row_index(averages)
        if user_row is not None and user_row < len(values) and isinstance(values[user_row], list):
            positive_indexes = []
            for index, value in enumerate(values[user_row], start=1):
                try:
                    positive = not isinstance(value, bool) and float(value) > 0
                except (TypeError, ValueError):
                    positive = False
                if positive:
                    positive_indexes.append(index)
            if positive_indexes:
                has_user_entry = any(
                    str(label or "").strip().casefold().startswith("user entry")
                    for label in available
                )
                if not has_user_entry:
                    raise RuntimeError("ResQ DFM has no User Entry average row.")
                if max(positive_indexes) > columns:
                    raise RuntimeError("ResQ DFM has fewer User Entry columns than ArcRho.")
    elif kind == KIND_BF:
        require_present(method_tab.get("latest_dataset"), find_triangle_or_vector, "latest")
        require_present(method_tab.get("dfm_dataset"), exporter._find_vector, "percentage-developed")
        priors = method_tab.get("prior_datasets") if isinstance(method_tab.get("prior_datasets"), list) else []
        if len(priors) > 1:
            raise RuntimeError("ResQ write-back supports only one BF prior dataset; this method has multiple priors.")
        prior = priors[0] if priors and isinstance(priors[0], Mapping) else {}
        require_present(prior.get("name"), exporter._find_vector, "prior")
    elif kind == KIND_CC:
        require_present(method_tab.get("exposure_dataset"), exporter._find_vector, "exposure")
        require_present(method_tab.get("latest_dataset"), exporter._find_triangle, "latest")
        require_present(method_tab.get("prior_ultimate_dataset"), exporter._find_vector, "prior-ultimate")
    elif kind == KIND_RS:
        loaded = method_tab.get("loaded_datasets") if isinstance(method_tab.get("loaded_datasets"), list) else []
        desired = {
            _name_key(source.get("name"))
            for source in loaded
            if isinstance(source, Mapping) and str(source.get("name") or "").strip()
        }
        for source in loaded:
            if isinstance(source, Mapping):
                require(source.get("name"), exporter._find_dataset, "Result Selection source")
        target = exporter._find_method_by_output(
            exporter.reserving_class.ResultSelections(), str(row.get("name") or "")
        )
        if target is not None:
            # The comparison runs on the shared key so a stray double space in
            # ResQ does not read as a source ArcRho would have to remove; the
            # ResQ spelling is kept only to name a genuine extra.
            existing: dict[str, str] = {}
            count = int(getattr(target, "DatasetCount", 0) or 0)
            for index in range(1, count + 1):
                resq_name = str(target.Dataset(index).Name or "").strip()
                existing.setdefault(_name_key(resq_name), resq_name)
            extras = sorted(name for key, name in existing.items() if key not in desired)
            if extras:
                raise RuntimeError(
                    "ResQ Result Selection has source datasets ArcRho cannot remove: "
                    + ", ".join(extras)
                )
            origin_count = int(getattr(target, "OriginCount", 0) or 0)
            for source in loaded:
                if not isinstance(source, Mapping):
                    continue
                weights = source.get("weights") if isinstance(source.get("weights"), list) else []
                if len(weights) > origin_count:
                    raise RuntimeError(
                        "ArcRho Result Selection has more weights than the ResQ origin count."
                    )
            overrides = method_tab.get("ultimate_overrides")
            if isinstance(overrides, list) and len(overrides) > origin_count:
                raise RuntimeError(
                    "ArcRho Result Selection has more ultimate overrides than the ResQ origin count."
                )


def _verify_method_export(exporter, row: Mapping[str, Any]) -> None:
    """Read back every method field the ArcRho-to-ResQ writer claims to apply."""

    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    kind = str(row.get("kind") or "")
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), Mapping) else {}

    def key(value: object) -> str:
        return _name_key(value)

    def assert_link(actual: object, expected: object, role: str) -> None:
        actual_name = key(getattr(actual, "Name"))
        if actual_name != key(expected):
            raise RuntimeError(f"ResQ {role} link did not match ArcRho after the write.")

    if kind == KIND_DFM:
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
        name = str(details.get("name") or item.get("method_name") or row.get("name") or "").strip()
        target = exporter._find_in("dfm_methods", exporter.reserving_class.DFMMethods, name)
        if target is None:
            raise RuntimeError("ResQ did not expose the DFM after the write.")
        _preflight_method_export(exporter, row)
        ratios_tab = payload.get("ratios_tab") if isinstance(payload.get("ratios_tab"), Mapping) else {}
        ratio_triangle = ratios_tab.get("ratio_triangle") if isinstance(ratios_tab.get("ratio_triangle"), Mapping) else {}
        excluded = ratio_triangle.get("excluded") if isinstance(ratio_triangle.get("excluded"), list) else []
        for origin_index, source_row in enumerate(excluded, start=1):
            if not isinstance(source_row, list):
                continue
            ratio_count = max(int(target.DevelopmentCount(origin_index)) - 1, 0)
            for development_index, expected in enumerate(source_row[:ratio_count], start=1):
                if expected not in (0, 1, False, True, "0", "1"):
                    continue
                actual = 1 if int(target.ExcludedRatios(origin_index, development_index)) == 1 else 0
                if actual != int(expected):
                    raise RuntimeError(
                        f"ResQ DFM exclusion verification failed at ({origin_index}, {development_index})."
                    )

        averages = ratios_tab.get("average_formulas") if isinstance(ratios_tab.get("average_formulas"), Mapping) else {}
        labels = averages.get("label") if isinstance(averages.get("label"), list) else []
        selected = averages.get("selected") if isinstance(averages.get("selected"), list) else []
        available = exporter._average_formula_display_indexes(target)
        columns = exporter._dfm_development_column_count(target)
        for development_index in range(1, columns + 1):
            expected_label = ""
            for row_index, source_row in enumerate(selected):
                if row_index < len(labels) and isinstance(source_row, list) and development_index - 1 < len(source_row):
                    if source_row[development_index - 1] in (1, True, "1"):
                        expected_label = str(labels[row_index])
                        break
            if expected_label:
                expected_index = int(available[expected_label])
                if int(target.SelectedRatios(DevIndex=development_index)) != expected_index:
                    raise RuntimeError(
                        f"ResQ DFM selected-average verification failed at column {development_index}."
                    )

        values = averages.get("values") if isinstance(averages.get("values"), list) else []
        user_row = exporter._user_entry_payload_row_index(averages)
        if user_row is not None and user_row < len(values) and isinstance(values[user_row], list):
            user_indexes = [
                int(display_index)
                for label, display_index in available.items()
                if key(label).startswith("user entry")
            ]
            if user_indexes:
                user_index = user_indexes[0]
                for development_index, expected in enumerate(values[user_row][:columns], start=1):
                    try:
                        expected_value = float(expected)
                    except (TypeError, ValueError):
                        continue
                    if expected_value <= 0:
                        continue
                    actual_value = float(target.AverageRatioValues(development_index, user_index))
                    if abs(actual_value - expected_value) > 1e-9:
                        raise RuntimeError(
                            f"ResQ DFM User Entry verification failed at column {development_index}."
                        )
        return

    if kind == KIND_BF:
        target = exporter._find_method_by_output(
            exporter.reserving_class.BFMethods(), str(row.get("name") or "")
        )
        if target is None:
            raise RuntimeError("ResQ did not expose the BF method after the write.")
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
        expected_origin_length = int(details.get("origin_length") or 0)
        if expected_origin_length and int(getattr(target, "OriginLength")) != expected_origin_length:
            raise RuntimeError("ResQ BF origin length did not match ArcRho after the write.")
        assert_link(getattr(target, "Latest"), method_tab.get("latest_dataset"), "BF latest")
        expected_latest = exporter._find_triangle(str(method_tab.get("latest_dataset") or ""))
        expected_latest_type = 0 if expected_latest is not None else 1
        if int(getattr(target, "LatestType")) != expected_latest_type:
            raise RuntimeError("ResQ BF latest data format did not match ArcRho after the write.")
        assert_link(getattr(target, "PercentageDeveloped"), method_tab.get("dfm_dataset"), "BF percentage-developed")
        expected_pd_type = method_tab.get("percentage_developed_type_code")
        expected_pd_type = 2 if expected_pd_type is None else int(expected_pd_type)
        if int(getattr(target, "PercentageDevelopedType")) != expected_pd_type:
            raise RuntimeError("ResQ BF percentage-developed type did not match ArcRho after the write.")
        priors = method_tab.get("prior_datasets") if isinstance(method_tab.get("prior_datasets"), list) else []
        prior = priors[0] if priors and isinstance(priors[0], Mapping) else {}
        assert_link(getattr(target, "Prior"), prior.get("name"), "BF prior")
        expected_prior_type = method_tab.get("prior_type_code")
        expected_prior_type = 0 if expected_prior_type is None else int(expected_prior_type)
        if int(getattr(target, "PriorType")) != expected_prior_type:
            raise RuntimeError("ResQ BF prior type did not match ArcRho after the write.")
        return

    if kind == KIND_CC:
        target = exporter._find_method_by_output(
            exporter.reserving_class.CapeCodMethods(), str(row.get("name") or "")
        )
        if target is None:
            raise RuntimeError("ResQ did not expose the Cape Cod method after the write.")
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
        expected_origin_length = int(details.get("origin_length") or 0)
        if expected_origin_length and int(getattr(target, "OriginLength")) != expected_origin_length:
            raise RuntimeError("ResQ Cape Cod origin length did not match ArcRho after the write.")
        assert_link(getattr(target, "Exposure"), method_tab.get("exposure_dataset"), "Cape Cod exposure")
        assert_link(getattr(target, "Latest"), method_tab.get("latest_dataset"), "Cape Cod latest")
        if int(getattr(target, "LatestType")) != 0:
            raise RuntimeError("ResQ Cape Cod latest data format did not match ArcRho after the write.")
        assert_link(
            getattr(target, "PercentageDeveloped"),
            method_tab.get("prior_ultimate_dataset"),
            "Cape Cod prior-ultimate",
        )
        expected_pd_type = 1 if key(method_tab.get("prior_ultimate_mode")) == "pattern" else 2
        if int(getattr(target, "PercentageDevelopedType")) != expected_pd_type:
            raise RuntimeError(
                "ResQ Cape Cod prior-ultimate mode did not match ArcRho after the write."
            )
        for member, field in (
            ("AutoTrendFit", "auto_trend_fit"),
            ("DecayFactor", "decay_factor"),
            ("AltUltimateCalc", "alternative_ultimate_calculation"),
        ):
            expected = method_tab.get(field)
            if expected is not None and getattr(target, member) != expected:
                raise RuntimeError(f"ResQ Cape Cod {field} did not match ArcRho after the write.")
        if method_tab.get("trend_rate") is not None and not bool(method_tab.get("auto_trend_fit")):
            if abs(float(getattr(target, "TrendRate")) - float(method_tab["trend_rate"])) > 1e-9:
                raise RuntimeError("ResQ Cape Cod trend rate did not match ArcRho after the write.")
        return

    if kind == KIND_RS:
        target = exporter._find_method_by_output(
            exporter.reserving_class.ResultSelections(), str(row.get("name") or "")
        )
        if target is None:
            raise RuntimeError("ResQ did not expose the Result Selection after the write.")
        details = payload.get("details_tab") if isinstance(payload.get("details_tab"), Mapping) else {}
        expected_origin_length = int(details.get("origin_length") or 0)
        if expected_origin_length and int(getattr(target, "OriginLength")) != expected_origin_length:
            raise RuntimeError("ResQ Result Selection origin length did not match ArcRho after the write.")
        loaded = method_tab.get("loaded_datasets") if isinstance(method_tab.get("loaded_datasets"), list) else []
        expected_names = [key(source.get("name")) for source in loaded if isinstance(source, Mapping)]
        actual_names = [key(target.Dataset(index).Name) for index in range(1, int(target.DatasetCount) + 1)]
        if set(actual_names) != set(expected_names):
            raise RuntimeError("ResQ Result Selection source datasets did not match ArcRho after the write.")
        origin_count = int(getattr(target, "OriginCount", 0) or 0)
        for source in loaded:
            if not isinstance(source, Mapping):
                continue
            source_key = key(source.get("name"))
            dataset_index = actual_names.index(source_key) + 1
            weights = source.get("weights") if isinstance(source.get("weights"), list) else []
            for origin_index, expected in enumerate(weights[:origin_count], start=1):
                expected_value = 0.0 if expected is None else float(expected)
                if abs(float(target.Weights(dataset_index, origin_index)) - expected_value) > 1e-9:
                    raise RuntimeError("ResQ Result Selection weight verification failed.")
        overrides = method_tab.get("ultimate_overrides") if isinstance(method_tab.get("ultimate_overrides"), list) else []
        rs_origin_length = int(getattr(target, "OriginLength", 0) or 0)
        for origin_index, expected in enumerate(overrides[:origin_count], start=1):
            overridden = bool(target.UltimateOverridden(origin_index))
            if expected is None:
                if overridden:
                    raise RuntimeError("ResQ Result Selection retained a cleared ultimate override.")
                continue
            if not overridden:
                raise RuntimeError("ResQ Result Selection did not retain an ArcRho ultimate override.")
            actual = float(target.Ultimates(origin_index, rs_origin_length))
            if abs(actual - float(expected)) > 1e-9:
                raise RuntimeError("ResQ Result Selection ultimate override verification failed.")


def _resq_import_target(row: Mapping[str, Any]) -> dict[str, Any]:
    item = row.get("resq") if isinstance(row.get("resq"), Mapping) else {}
    kind = str(row.get("kind") or KIND_DATASET)
    collection = str(item.get("resq_collection") or "")
    name = str(item.get("resq_object_name") or row.get("name") or "")
    method_name = str(item.get("resq_method_name") or "").strip()
    if collection not in {"triangle", "vector"}:
        raise ValueError(f"Unsupported ResQ collection for {row.get('name')}: {collection or '<missing>'}")
    return {
        "export_kind": collection,
        "names": [name],
        "include_dfm_methods": kind == KIND_DFM,
        "include_bf_methods": kind == KIND_BF,
        "include_cc_methods": kind == KIND_CC,
        "dfm_names": [str(item.get("resq_method_name") or "")] if kind == KIND_DFM else None,
        "method_names": [method_name] if kind != KIND_DATASET and method_name else [],
        "display_kind": kind,
    }


def _cleanup_sync_target_artifacts(
    runtime: Mapping[str, Any],
    rc_dir: Path,
    target: Mapping[str, Any],
) -> tuple[int, int]:
    """Delete only the selected logical group, leaving dependents for propagation."""

    migration = runtime["migration"]
    prefix_by_kind = {
        KIND_DFM: "DFM@",
        KIND_BF: "BF@",
        KIND_CC: "CC@",
        KIND_RS: "RS@",
        KIND_BS_SR: migration.BS_SR_FILE_PREFIX,
        KIND_BS_CRA: migration.BS_CRA_FILE_PREFIX,
    }
    method_prefix = prefix_by_kind.get(str(target.get("display_kind") or ""))
    return migration.cleanup_target_dataset_artifacts(
        rc_dir,
        dataset_names=list(target.get("names") or []),
        method_names=list(target.get("method_names") or []),
        match_method_dependencies=False,
        method_prefixes=[method_prefix] if method_prefix else [],
    )


def _snapshot_groups(runtime: Mapping[str, Any], rc_dir: Path, keys: set[str], backup_root: Path) -> dict[str, list[Path]]:
    migration = runtime["migration"]
    sync_contract = runtime["sync_contract"]
    groups: dict[str, list[Path]] = {}
    sidecars = _read_json_entries(_directory_files(rc_dir / migration.DATASET_SIDECAR_DIR, ".json"))
    for path, _modified, payload in sidecars:
        name = payload.get("dataset_name") or migration._normalize_cached_dataset_name(path.stem)
        key = sync_contract.logical_key(name)
        if key:
            groups.setdefault(key, []).append(path)
    methods = _read_json_entries(_directory_files(rc_dir / migration.METHOD_DATA_DIR, ".json"))
    for path, _modified, payload in methods:
        entry = runtime["method_entry"](payload, path.name)
        key = sync_contract.logical_key(entry.get("dataset_name")) if isinstance(entry, Mapping) else ""
        if key:
            groups.setdefault(key, []).append(path)
    for path, _modified in _directory_files(rc_dir / migration.DATASET_CACHE_DIR, ".csv"):
        for name in migration._cached_dataset_names_from_file(path.name):
            key = sync_contract.logical_key(name)
            if key:
                groups.setdefault(key, []).append(path)

    copied: dict[str, list[Path]] = {}
    for key in keys:
        paths = sorted(set(groups.get(key, [])), key=lambda path: str(path).casefold())
        for source in paths:
            relative = source.relative_to(rc_dir)
            target = backup_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied.setdefault(key, []).append(relative)
    return copied


def _preflight_import_method_filename_collision(
    runtime: Mapping[str, Any],
    rc_dir: Path,
    row: Mapping[str, Any],
) -> None:
    """Fail before cleanup if the target method filename belongs to another output."""

    if str(row.get("kind") or KIND_DATASET) == KIND_DATASET:
        return
    target = _resq_import_target(row)
    method_names = [str(value).strip() for value in target.get("method_names") or [] if str(value).strip()]
    if not method_names:
        raise RuntimeError("The ResQ method has no stable method name for selective import.")
    prefix_by_kind = {
        KIND_DFM: "DFM@",
        KIND_BF: "BF@",
        KIND_CC: "CC@",
        KIND_RS: "RS@",
        KIND_BS_SR: runtime["migration"].BS_SR_FILE_PREFIX,
        KIND_BS_CRA: runtime["migration"].BS_CRA_FILE_PREFIX,
    }
    prefix = prefix_by_kind.get(str(row.get("kind") or ""))
    if not prefix:
        return
    method_name = method_names[0]
    method_path = rc_dir / runtime["migration"].METHOD_DATA_DIR / (
        f"{prefix}{runtime['migration']._encode_name_part(method_name)}.json"
    )
    if not method_path.is_file():
        return
    payload = _read_json(method_path)
    entry = runtime["method_entry"](payload, method_path.name)
    existing_output = str(entry.get("dataset_name") or "").strip() if isinstance(entry, Mapping) else ""
    if not existing_output:
        raise RuntimeError(
            f"Existing target method file {method_path.name} has no readable output identity."
        )
    if runtime["sync_contract"].logical_key(existing_output) != str(row.get("key") or ""):
        raise RuntimeError(
            f"Method filename collision: {method_path.name} currently belongs to output "
            f"{existing_output!r}, not {row.get('name')!r}."
        )


def _restore_group(
    runtime: Mapping[str, Any],
    exporter,
    rc_dir: Path,
    row: Mapping[str, Any],
    backup_root: Path,
    backup_paths: Mapping[str, list[Path]],
) -> None:
    migration = runtime["migration"]
    target = _resq_import_target(row)
    _cleanup_sync_target_artifacts(runtime, rc_dir, target)
    key = str(row.get("key") or "")
    for relative in backup_paths.get(key, []):
        source = backup_root / relative
        destination = rc_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{os.getpid()}.restore.tmp")
        try:
            shutil.copy2(source, temporary)
            os.replace(temporary, destination)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _import_one_from_resq(
    runtime: Mapping[str, Any],
    exporter,
    rc_path: str,
    rc_dir: Path,
    row: Mapping[str, Any],
    progress_callback,
) -> tuple[bool, str]:
    migration = runtime["migration"]
    target = _resq_import_target(row)
    names = list(target["names"])
    _cleanup_sync_target_artifacts(runtime, rc_dir, target)
    progress_state = {"completed": 0, "total": 1, "skipped": 0, "count_methods": False}
    method_counts = {
        "dfms_written": 0,
        "bfs_written": 0,
        "ccs_written": 0,
        "result_selections_written": 0,
        "bssr_written": 0,
        "bscra_written": 0,
    }
    if target["export_kind"] == "triangle":
        written, errors = migration.export_triangles_for_rc(
            exporter.reserving_class,
            rc_path,
            rc_dir,
            progress_callback=progress_callback,
            progress_state=progress_state,
            triangle_names=names,
            method_counts=method_counts,
            strict_extraction=True,
            verbose=False,
        )
    else:
        written, errors = migration.export_vectors_for_rc(
            exporter.reserving_class,
            rc_path,
            rc_dir,
            progress_callback=progress_callback,
            progress_state=progress_state,
            vector_names=names,
            include_dfm_methods=bool(target.get("include_dfm_methods")),
            include_bf_methods=bool(target.get("include_bf_methods")),
            include_cc_methods=bool(target.get("include_cc_methods")),
            dfm_names=target.get("dfm_names"),
            method_counts=method_counts,
            preserve_local_dfm_owned_state=False,
            strict_extraction=True,
            verbose=False,
        )
    if errors:
        details = progress_state.get("error_details") if isinstance(progress_state.get("error_details"), list) else []
        message = str(details[-1].get("message") or "ResQ import failed.") if details else "ResQ import failed."
        return False, message
    if int(progress_state.get("skipped") or 0) or written < 1:
        return False, "The canonical ResQ importer skipped this item."
    expected_count = {
        KIND_DFM: "dfms_written",
        KIND_BF: "bfs_written",
        KIND_CC: "ccs_written",
        KIND_RS: "result_selections_written",
        KIND_BS_SR: "bssr_written",
        KIND_BS_CRA: "bscra_written",
    }.get(str(row.get("kind") or ""))
    if expected_count and int(method_counts.get(expected_count) or 0) < 1:
        return False, f"The ResQ output was read, but its {row.get('kind')} method was not imported."
    return True, "Imported into ArcRho."


def _plan_by_id(plan: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(row.get("id") or ""): row for row in plan if str(row.get("id") or "")}


def _selected_rows(plan: list[dict[str, Any]], selected_ids: list[str]) -> list[dict[str, Any]]:
    by_id = _plan_by_id(plan)
    rows = []
    seen: set[str] = set()
    for row_id in selected_ids:
        if row_id in seen:
            continue
        seen.add(row_id)
        row = by_id.get(row_id)
        if row is not None and not row.get("disabled") and row.get("action"):
            rows.append(row)
    return rows


def _reviewed_signature(sync_contract, reviewed: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the observation a row must still match, or None when it has none.

    A row echoed back from the review table carries the ``signature`` it was
    shown with. A plan row this session observed itself is its own
    observation, so the write phase can recheck the rows it selected from an
    earlier plan even though those rows never left the process and were never
    given a separate ``signature`` field.
    """

    signature = reviewed.get("signature")
    if isinstance(signature, Mapping):
        return signature
    if isinstance(reviewed.get("state_signature"), Mapping):
        return sync_contract.plan_signature(reviewed)
    return None


def _stale_selected_rows(
    runtime: Mapping[str, Any],
    reviewed_rows: list[Mapping[str, Any]],
    current_plan: list[dict[str, Any]],
) -> list[str]:
    """Name every reviewed row whose observation changed before the write.

    ``reviewed_rows`` carries the signature the person actually saw, taken
    from the preview phase, so a change made while the review table was open
    is caught here rather than being silently written over. The write phase
    runs this once more under the reserving-class lock before its first
    write; the per-row check inside the batch is ``_row_moved_before_write``.
    """

    sync_contract = runtime["sync_contract"]
    current = _plan_by_id(current_plan)
    stale: list[str] = []
    for reviewed in reviewed_rows:
        row_id = str(reviewed.get("id") or "")
        observed = current.get(row_id)
        reviewed_signature = _reviewed_signature(sync_contract, reviewed)
        if reviewed_signature is None:
            # A reviewed row without its signature cannot be proven unchanged.
            stale.append(str(reviewed.get("name") or row_id or "item"))
            continue
        if observed is None or not sync_contract.signatures_equal(
            reviewed_signature,
            sync_contract.plan_signature(observed),
        ):
            stale.append(str(reviewed.get("name") or row_id or "item"))
    return stale


def _row_moved_before_write(
    runtime: Mapping[str, Any],
    row: Mapping[str, Any],
    current_row: Mapping[str, Any] | None,
) -> bool:
    """Tell whether the side a row is written from moved since the batch began.

    ``row`` is the plan row selected under the reserving-class lock and
    ``current_row`` its fresh observation taken right before the write. Only
    the source side's timestamp and both sides' identity count: an earlier
    write in the same batch re-stamps the target side of everything
    downstream of it, which is the batch doing its job, not a change to
    refuse.
    """

    sync_contract = runtime["sync_contract"]
    if current_row is None:
        return True
    source_side = (
        "arcrho"
        if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ
        else "resq"
    )
    return not sync_contract.write_signatures_equal(
        sync_contract.plan_signature(row),
        sync_contract.plan_signature(current_row),
        source_side=source_side,
    )


def apply_sync_plan(
    runtime: Mapping[str, Any],
    *,
    project_name: str,
    rc_path: str,
    server_root: Path,
    exporter,
    selected_rows: list[dict[str, Any]],
    state: Mapping[str, Any],
    state_path: Path,
    progress_callback,
) -> dict[str, Any]:
    """Apply selected actions in dependency-safe phases and record successful baselines."""

    migration = runtime["migration"]
    sync_contract = runtime["sync_contract"]
    rc_dir = migration.PROJECT_DATA_DIR / migration._encode_rc_folder(rc_path)

    from app_server.services.dataset_sidecar_status_service import reserving_class_io_lock
    from arcrho_api.client import ArcRhoClient
    from arcrho_api.dfm_propagation import _refresh_dfm_dependents_for_sources_locked
    from arcrho_dependent_propagation_contract import held_reserving_class_lease

    results: list[dict[str, Any]] = []
    successful_keys: list[str] = []
    local_mutated_names: list[str] = []
    post_write_observations: dict[str, dict[str, Any]] = {}
    total = len(selected_rows)
    completed = 0

    def record(row: Mapping[str, Any], success: bool, message: str) -> None:
        nonlocal completed
        completed += 1
        if success:
            successful_keys.append(str(row.get("key") or ""))
        results.append({
            "id": row.get("id"),
            "name": row.get("name"),
            "kind": row.get("kind"),
            "action": row.get("action"),
            "success": success,
            "message": message,
        })
        try:
            progress_callback({
                "completed": completed,
                "total": total,
                "status": "success" if success else "error",
                "message": f"{row.get('name')}: {message}",
            })
        except Exception:
            # A row may already be durable; UI/activity reporting must not turn
            # that success into an un-baselined half-completion.
            pass

    def plan_with_baseline(baseline_state: Mapping[str, Any]) -> dict[str, Any]:
        observation = _plan_context(
            runtime, project_name, rc_path, server_root, exporter=exporter
        )
        observation["plan"] = sync_contract.build_sync_plan(
            observation["arcrho"], observation["resq"], baseline_state
        )
        return observation

    def observation_signature(row: Mapping[str, Any]) -> dict[str, Any]:
        signature = sync_contract.plan_signature(row)
        signature["action"] = ""
        signature["disabled"] = False
        return signature

    def remember_post_write(
        row: Mapping[str, Any],
        baseline_state: Mapping[str, Any],
        before_row: Mapping[str, Any],
    ) -> tuple[bool, str]:
        current = _plan_by_id(plan_with_baseline(baseline_state)["plan"])
        observed = current.get(str(row.get("id") or ""))
        key = str(row.get("key") or "")
        if observed is None:
            post_write_observations[key] = {}
            return False, "The item disappeared while its write was being verified."
        source_side = (
            "arcrho"
            if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ
            else "resq"
        )
        before_source = sync_contract.plan_signature(before_row).get(source_side)
        after_source = sync_contract.plan_signature(observed).get(source_side)
        if before_source != after_source:
            post_write_observations[key] = {}
            return False, (
                f"The authoritative {source_side.title()} source changed during the write; "
                "the result was not baselined. Rerun the review."
            )
        post_write_observations[key] = observation_signature(observed)
        return True, ""

    runtime_dir = server_root / "r"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    io_lock = reserving_class_io_lock(project_name, rc_path)
    lease_context = held_reserving_class_lease(
        server_root, project_name, rc_path, timeout_seconds=60.0
    )
    with io_lock, lease_context, tempfile.TemporaryDirectory(
        prefix="resq-sync-", dir=str(runtime_dir)
    ) as temp_name:
        locked_observation = _plan_context(
            runtime, project_name, rc_path, server_root, exporter=exporter
        )
        locked_stale = _stale_selected_rows(
            runtime, selected_rows, locked_observation["plan"]
        )
        if locked_stale:
            return {
                "successes": 0,
                "failures": 0,
                "results": [],
                "successful_keys": [],
                "stale_items": locked_stale,
            }
        selected_rows = _selected_rows(
            locked_observation["plan"],
            [str(row.get("id") or "") for row in selected_rows],
        )
        state = locked_observation["state"]
        state_path = locked_observation["state_path"]
        # Each direction is written in ArcRho's dependency order: a row comes
        # after every accepted row it reads, whether that is a formula input,
        # a method's linked dataset, or another method's output.
        local_to_remote = _dependency_ordered_rows(sync_contract, [
            row for row in selected_rows
            if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ
        ])
        remote_to_local = _dependency_ordered_rows(sync_contract, [
            row for row in selected_rows
            if row.get("action") == sync_contract.ACTION_RESQ_TO_ARCRHO
        ])

        preflight_failed_ids: set[str] = set()
        for row in remote_to_local:
            try:
                _preflight_import_method_filename_collision(runtime, rc_dir, row)
            except Exception as exc:
                preflight_failed_ids.add(str(row.get("id") or ""))
                record(row, False, f"Preflight blocked the import: {exc}")
        # A link may point at an earlier accepted row rather than at an object
        # ResQ already holds. A row whose own preflight failed never joins the
        # batch, so anything that reads it is blocked here as well.
        batch_keys: set[str] = set()

        def satisfied_by_batch(name: str) -> bool:
            return sync_contract.logical_key(name) in batch_keys

        for row in local_to_remote:
            try:
                if row.get("kind") == KIND_DATASET:
                    _preflight_dataset_export(exporter, row)
                else:
                    _preflight_method_export(exporter, row, satisfied=satisfied_by_batch)
            except Exception as exc:
                preflight_failed_ids.add(str(row.get("id") or ""))
                record(row, False, f"Preflight blocked the write: {exc}")
                continue
            batch_keys.add(str(row.get("key") or ""))
        if preflight_failed_ids:
            selected_rows = [
                row for row in selected_rows
                if str(row.get("id") or "") not in preflight_failed_ids
            ]
            local_to_remote = [row for row in local_to_remote if str(row.get("id") or "") not in preflight_failed_ids]
            remote_to_local = [row for row in remote_to_local if str(row.get("id") or "") not in preflight_failed_ids]
        write_order = local_to_remote + remote_to_local

        rc_dir.mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.DATASET_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.METHOD_DATA_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.DATASET_SIDECAR_DIR).mkdir(parents=True, exist_ok=True)
        backup_root = Path(temp_name) / "previous"
        backup_paths = _snapshot_groups(
            runtime,
            rc_dir,
            {str(row.get("key") or "") for row in remote_to_local},
            backup_root,
        )
        with nullcontext():
            # Writes are deliberately sequential and follow the dependency
            # order above: every ArcRho-to-ResQ row, each after the rows it
            # reads, then every ResQ-to-ArcRho row the same way. A ResQ Save
            # or an ArcRho dependency refresh can recalculate a later selected
            # row, so each row is re-inventoried immediately before its own
            # mutation and local propagation runs before the next row.
            for row in write_order:
                current = plan_with_baseline(locked_observation["state"])
                current_row = _plan_by_id(current["plan"]).get(str(row.get("id") or ""))
                if _row_moved_before_write(runtime, row, current_row):
                    source = (
                        "ArcRho"
                        if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ
                        else "ResQ"
                    )
                    record(
                        row,
                        False,
                        f"The {source} source changed during synchronization; rerun the review.",
                    )
                    continue
                if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ:
                    try:
                        ok, message = _export_one_to_resq(exporter, row)
                    except Exception as exc:
                        ok, message = False, str(exc)
                else:
                    with migration.defer_sidecar_graph_enrichment():
                        try:
                            ok, message = _import_one_from_resq(
                                runtime, exporter, rc_path, rc_dir, row, progress_callback
                            )
                        except Exception as exc:
                            ok, message = False, str(exc)
                    if not ok:
                        try:
                            _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                        except Exception as restore_error:
                            message = f"{message} Rollback also failed: {restore_error}"
                    else:
                        stable, stability_message = remember_post_write(
                            row, locked_observation["state"], current_row
                        )
                        if not stable:
                            ok, message = False, f"{message} {stability_message}".strip()
                            try:
                                _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                            except Exception as restore_error:
                                message = f"{message} Rollback also failed: {restore_error}"
                        else:
                            local_mutated_names.append(str(row.get("name") or ""))
                            migration.refresh_sidecar_graphs_for_rc(rc_dir)
                            reserving_class = ArcRhoClient(server_root).project(project_name).reserving_class(rc_path)
                            propagation = _refresh_dfm_dependents_for_sources_locked(
                                reserving_class, [str(row.get("name") or "")]
                            )
                            for warning in propagation.warnings:
                                results.append({
                                    "id": "",
                                    "name": "Dependent refresh",
                                    "kind": "Warning",
                                    "action": "",
                                    "success": False,
                                    "message": str(warning),
                                })
                if ok and row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ:
                    stable, stability_message = remember_post_write(
                        row, locked_observation["state"], current_row
                    )
                    if not stable:
                        ok, message = False, f"{message} {stability_message}".strip()
                record(row, ok, message)
            if local_mutated_names:
                migration.rebuild_dataset_instance_index(project_name, rc_path, rc_dir)

            final_local = collect_arcrho_inventory(runtime, rc_dir)
            final_remote = collect_resq_inventory(runtime, exporter)
            final_plan = sync_contract.build_sync_plan(
                final_local, final_remote, locked_observation["state"]
            )
            final_by_id = _plan_by_id(final_plan)
            unstable_keys: set[str] = set()
            for row in selected_rows:
                key = str(row.get("key") or "")
                remembered = post_write_observations.get(key)
                final_row = final_by_id.get(str(row.get("id") or ""))
                if key not in successful_keys:
                    continue
                if not remembered or final_row is None or not sync_contract.signatures_equal(
                    remembered, observation_signature(final_row)
                ):
                    unstable_keys.add(key)
            if unstable_keys:
                successful_keys = [key for key in successful_keys if key not in unstable_keys]
                for item in results:
                    if str(item.get("id") or "") and any(
                        str(row.get("id") or "") == str(item.get("id") or "")
                        and str(row.get("key") or "") in unstable_keys
                        for row in selected_rows
                    ):
                        item["success"] = False
                        item["message"] = (
                            f"{item.get('message')} The item changed again later in this batch; "
                            "its baseline was not recorded. Rerun the review."
                        )
            updated_state = sync_contract.record_synced_items(
                state,
                successful_keys,
                final_local,
                final_remote,
            )
            recorded_keys = {
                str(key) for key in updated_state.get("_recorded_keys", [])
            }
            unrecorded_keys = {
                key for key in successful_keys if key not in recorded_keys
            }
            if unrecorded_keys:
                successful_keys = [
                    key for key in successful_keys if key not in unrecorded_keys
                ]
                selected_key_by_id = {
                    str(row.get("id") or ""): str(row.get("key") or "")
                    for row in selected_rows
                }
                for item in results:
                    if selected_key_by_id.get(str(item.get("id") or "")) in unrecorded_keys:
                        item["success"] = False
                        item["message"] = (
                            f"{item.get('message')} The final ArcRho/ResQ timestamps "
                            "could not be recorded; the row remains in recovery state."
                        )
            sync_contract.write_sync_state(state_path, updated_state)

    successes = sum(bool(item.get("success")) for item in results if item.get("id"))
    failures = sum(not bool(item.get("success")) for item in results if item.get("id"))
    return {
        "successes": successes,
        "failures": failures,
        "results": results,
        "successful_keys": successful_keys,
    }


def _emit_progress(progress_callback, event: Mapping[str, Any]) -> None:
    if callable(progress_callback):
        progress_callback(dict(event))


def _public_plan_rows(runtime: Mapping[str, Any], plan: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a serializable preview without COM objects or full JSON payloads.

    Each row carries its ``signature``: the observation the review table was
    drawn from. The apply request sends the signatures of the accepted rows
    back, which is how a queued session proves nothing moved underneath a
    person while they were reviewing.
    """

    sync_contract = runtime["sync_contract"]
    return [
        {
            "id": str(row.get("id") or ""),
            "signature": sync_contract.plan_signature(row),
            "name": str(row.get("name") or ""),
            "kind": str(row.get("kind") or KIND_DATASET),
            "arcrho_timestamp": _timestamp_cell(row.get("arcrho")),
            "resq_timestamp": _timestamp_cell(row.get("resq")),
            "status": str(row.get("status") or ""),
            "action": str(row.get("action") or ""),
            "action_label": _action_label(row.get("action")),
            "detail": str(row.get("detail") or ""),
            "selected": bool(row.get("selected")),
            "disabled": bool(row.get("disabled")),
            "conflict": bool(row.get("conflict")),
        }
        for row in plan
    ]



def _session_scope(project_name: str, rc_path: str, server_root: object) -> tuple[str, str, Path]:
    """Validate the logical identifiers one session is allowed to touch."""

    project = str(project_name or "").strip()
    path = str(rc_path or "").strip()
    if not project:
        raise ValueError("project_name is required.")
    if not path:
        raise ValueError("rc_path is required.")
    if server_root is None:
        raise ValueError("server_root is required.")
    return project, path, Path(server_root).expanduser().resolve()


def preview_sync(
    runtime: Mapping[str, Any],
    project_name: str,
    rc_path: str,
    *,
    server_root: object,
    progress_callback=None,
) -> dict[str, Any]:
    """Compare one same-named project/RC scope without writing anything.

    The returned ``preview`` rows are display-ready and carry the signature
    the apply phase rechecks, so the caller never needs the plan's internal
    rows or a ResQ session of its own.
    """

    migration = runtime["migration"]
    project_name, rc_path, root = _session_scope(project_name, rc_path, server_root)
    previous_scope = migration._apply_runtime_scope(project_name, root)
    try:
        _emit_progress(progress_callback, {
            "event": "scan",
            "completed": 0,
            "total": 0,
            "message": f"Comparing ArcRho and ResQ: {rc_path}",
        })
        preview = _plan_context(runtime, project_name, rc_path, root)
        rows = _public_plan_rows(runtime, preview["plan"])
        _emit_progress(progress_callback, {
            "event": "review",
            "completed": 0,
            "total": len(rows),
            "message": f"Review {len(rows)} dataset/method output(s)",
        })
        return {
            "status": "review_required",
            "project_name": project_name,
            "rc_path": rc_path,
            "connection_name": _resq_credentials(runtime)["connection_name"],
            "preview": rows,
        }
    finally:
        migration._restore_runtime_scope(previous_scope)


def apply_sync(
    runtime: Mapping[str, Any],
    project_name: str,
    rc_path: str,
    *,
    server_root: object,
    reviewed_rows: list[Mapping[str, Any]],
    progress_callback=None,
) -> dict[str, Any]:
    """Apply the reviewed rows, or apply nothing if any observation moved.

    ``reviewed_rows`` are the accepted rows exactly as the preview phase
    returned them, each with its ``id`` and ``signature``.
    """

    migration = runtime["migration"]
    project_name, rc_path, root = _session_scope(project_name, rc_path, server_root)
    accepted = [row for row in reviewed_rows or [] if isinstance(row, Mapping) and str(row.get("id") or "").strip()]
    previous_scope = migration._apply_runtime_scope(project_name, root)
    exporter = None
    try:
        base = {
            "project_name": project_name,
            "rc_path": rc_path,
            "connection_name": _resq_credentials(runtime)["connection_name"],
        }
        if not accepted:
            return {**base, "status": "no_changes", "successes": 0, "failures": 0, "results": []}

        _emit_progress(progress_callback, {
            "event": "revalidate",
            "completed": 0,
            "total": len(accepted),
            "message": "Rechecking selected timestamps before writing",
        })
        exporter = _new_exporter(runtime, project_name, rc_path, root)
        exporter.connect()
        current = _plan_context(runtime, project_name, rc_path, root, exporter=exporter)
        stale = _stale_selected_rows(runtime, accepted, current["plan"])
        if stale:
            return {
                **base,
                "status": "stale",
                "stale_items": stale,
                "successes": 0,
                "failures": 0,
                "results": [],
            }

        selected_ids = [str(row.get("id") or "") for row in accepted]
        current_rows = _selected_rows(current["plan"], selected_ids)
        if not current_rows:
            return {**base, "status": "no_changes", "successes": 0, "failures": 0, "results": []}

        result = apply_sync_plan(
            runtime,
            project_name=project_name,
            rc_path=rc_path,
            server_root=root,
            exporter=exporter,
            selected_rows=current_rows,
            state=current["state"],
            state_path=current["state_path"],
            progress_callback=progress_callback or (lambda event: None),
        )
        if result.get("stale_items"):
            return {**result, **base, "status": "stale"}
        return {
            **result,
            **base,
            "status": "completed_with_errors" if result.get("failures") else "completed",
        }
    finally:
        if exporter is not None:
            try:
                exporter.disconnect()
            except Exception:
                pass
        migration._restore_runtime_scope(previous_scope)


def build_runtime(migration, exporter_module, *, resq_credentials=None) -> dict[str, Any]:
    """Bind one session to its ResQ migration runtime and exporter.

    Every host builds the runtime the same way, so a Bridge worker running
    from its frozen bundle and a test running from the working tree observe
    identical timestamp parsing and plan comparison rules.

    ``resq_credentials`` is the account every ResQ session opens with, as
    ``connection_name``, ``user_name`` and ``password``. The Bridge passes the
    shared service account from its server config, so which user's worker
    claimed the request cannot change what ResQ shows the session.
    """

    from arcrho_api.dataset_index_contract import _method_entry_from_payload
    from resq_migration import sync as sync_contract

    try:
        from app_server.helpers import parse_method_last_modified_timestamp
    except ImportError:
        # A host without the bundled app server falls back to the same parser
        # the plan contract itself uses, rather than to a private copy.
        parse_method_last_modified_timestamp = sync_contract.parse_timestamp

    return {
        "migration": migration,
        "exporter_module": exporter_module,
        "parse_timestamp": parse_method_last_modified_timestamp,
        "method_entry": _method_entry_from_payload,
        "sync_contract": sync_contract,
        "resq_credentials": dict(resq_credentials) if resq_credentials else None,
    }
