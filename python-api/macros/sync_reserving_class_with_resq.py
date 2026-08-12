# <arcrho-macro>
# Title: Sync Reserving Class with ResQ
# Version: 1.0.1
# Release Note: Finalize strict selective writes, recovery-safe baselines, and deployable client runtime support.
# Description: Compare every dataset and supported method output in the selected reserving class, show both ArcRho and ResQ timestamps in a review table, and apply only the synchronization actions the user accepts.
# Scope: Reserving Class
# </arcrho-macro>

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
import shutil
import sys
import tempfile
import time
import traceback
from typing import Any, Mapping


TITLE = "Sync Reserving Class with ResQ"
MACRO_VERSION = "1.0.1"
PROGRESS_ID = "sync-reserving-class-with-resq"
DEFAULT_SERVER_ROOT = Path(r"E:\ArcRho Server")
REVIEW_POLL_SECONDS = 0.5
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


def _load_module(path: Path, module_name: str):
    if not path.is_file():
        raise FileNotFoundError(f"Required ArcRho module not found: {path}")
    parent = str(path.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load ArcRho module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_runtime_modules():
    candidates: list[tuple[Path, Path, Path]] = []

    def add_development_candidate(root: Path) -> None:
        root = root.resolve()
        shapes = (
            (root / "python-api" / "migration", root / "python-api" / "macros"),
            (root / "migration", root / "macros"),
        )
        for migration_root, macro_root in shapes:
            migration_script = migration_root / "resq_data_migration.py"
            exporter = macro_root / "export_reserving_class_to_resq.py"
            if migration_script.is_file() and exporter.is_file():
                candidate = (root, migration_script.resolve(), exporter.resolve())
                if candidate not in candidates:
                    candidates.append(candidate)

    add_development_candidate(
        Path(__file__).resolve().parent.parent if "__file__" in globals() else Path.cwd()
    )

    shared_roots: list[Path] = []
    library_override = str(os.environ.get("ARCRHO_MACRO_LIBRARY_DIR") or "").strip()
    if library_override:
        shared_roots.append(Path(library_override).expanduser().resolve().parent)
    try:
        from arcrho_api import get_server_root

        shared_roots.append((Path(get_server_root(required=True)) / "shared").resolve())
    except Exception:
        pass

    support_roots: list[Path] = []
    support_errors: list[str] = []
    for shared_root in dict.fromkeys(shared_roots):
        support_root = shared_root / "python-api"
        support_roots.append(support_root.resolve())
        pointer_path = support_root / "current.json"
        if pointer_path.is_file():
            try:
                pointer = json.loads(pointer_path.read_text(encoding="utf-8-sig"))
                relative_root = str(pointer.get("relative_root") or "").strip()
                release_root = (support_root / relative_root).resolve()
                if not relative_root or not release_root.is_relative_to(support_root.resolve()):
                    raise ValueError("current.json points outside the shared support folder")
                manifest_path = release_root / "manifest.json"
                manifest_bytes = manifest_path.read_bytes()
                expected_manifest = str(pointer.get("manifest_sha256") or "").strip().casefold()
                if not expected_manifest or hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest:
                    raise ValueError("support manifest hash does not match current.json")
                manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
                if str(manifest.get("release_id") or "") != str(pointer.get("release_id") or ""):
                    raise ValueError("support release ID does not match current.json")
                if int(manifest.get("runtime_api_version") or 0) != 1:
                    raise ValueError("support runtime API is incompatible with this macro")
                if str(manifest.get("sync_macro_version") or "") != MACRO_VERSION:
                    raise ValueError(
                        "support release was built for a different sync macro version"
                    )
                source_path = Path(__file__).resolve() if "__file__" in globals() else None
                if source_path is not None and source_path.is_file():
                    expected_macro_hash = str(manifest.get("sync_macro_sha256") or "").casefold()
                    actual_macro_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
                    if not expected_macro_hash or actual_macro_hash != expected_macro_hash:
                        raise ValueError("installed sync macro does not match the support release")
                files = manifest.get("files") if isinstance(manifest.get("files"), Mapping) else {}
                for relative, expected_hash in files.items():
                    path = (release_root / str(relative)).resolve()
                    if not path.is_relative_to(release_root) or not path.is_file():
                        raise FileNotFoundError(f"support file is missing: {relative}")
                    if hashlib.sha256(path.read_bytes()).hexdigest() != str(expected_hash).casefold():
                        raise ValueError(f"support file hash does not match: {relative}")
                migration_script = release_root / "migration" / "resq_data_migration.py"
                exporter = release_root / "macros" / "export_reserving_class_to_resq.py"
                if not migration_script.is_file() or not exporter.is_file():
                    raise FileNotFoundError("support release omits the migration runtime or pinned exporter")
                candidates.append((release_root, migration_script.resolve(), exporter.resolve()))
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
                support_errors.append(f"{pointer_path}: {exc}")

    if not candidates:
        details = "\n".join(support_errors) or "No development or shared support release was found."
        raise FileNotFoundError(
            "Could not locate one coherent ResQ synchronization runtime and exporter.\n" + details
        )

    _runtime_root, migration_script, export_macro = candidates[0]
    migration_root = migration_script.parent.resolve()

    # ``resq_migration`` is a package whose submodules may load lazily. Remove
    # prior runtime roots so an old immutable release cannot contribute a
    # removed module to this run through namespace/package path accumulation.
    for entry in list(sys.path):
        try:
            entry_path = Path(entry).resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        is_prior_support = any(
            entry_path != migration_root
            and entry_path.is_relative_to(root / "releases")
            for root in support_roots
        )
        is_other_migration = (
            entry_path != migration_root
            and (entry_path / "resq_migration").is_dir()
        )
        if is_prior_support or is_other_migration:
            while entry in sys.path:
                sys.path.remove(entry)
    for module_name in list(sys.modules):
        if module_name != "resq_migration" and not module_name.startswith("resq_migration."):
            continue
        # Purge the complete namespace family, including modules that already
        # came from this root.  Keeping a child while replacing only its
        # namespace package leaves the new package without that child
        # attribute and can also mix module globals across consecutive macro
        # runs in the persistent host.
        sys.modules.pop(module_name, None)
    root_text = str(migration_root)
    if root_text in sys.path:
        sys.path.remove(root_text)
    sys.path.insert(0, root_text)

    migration = _load_module(migration_script, "arcrho_resq_sync_migration")
    exporter_module = _load_module(export_macro, "arcrho_resq_sync_exporter")
    from arcrho_api.dataset_index_contract import _method_entry_from_payload
    from resq_migration import sync as sync_contract

    for module_name, loaded_module in list(sys.modules.items()):
        if module_name != "resq_migration" and not module_name.startswith("resq_migration."):
            continue
        if module_name == "resq_migration":
            package_paths = list(getattr(loaded_module, "__path__", []) or [])
            try:
                coherent = bool(package_paths) and all(
                    Path(value).resolve().is_relative_to(migration_root)
                    for value in package_paths
                )
            except (OSError, RuntimeError, ValueError):
                coherent = False
            if not coherent:
                raise RuntimeError(
                    "Loaded resq_migration package paths outside the pinned support release: "
                    + ", ".join(str(value) for value in package_paths)
                )
            continue
        loaded_path = str(getattr(loaded_module, "__file__", "") or "").strip()
        try:
            coherent = bool(loaded_path) and Path(loaded_path).resolve().is_relative_to(migration_root)
        except (OSError, RuntimeError, ValueError):
            coherent = False
        if not coherent:
            raise RuntimeError(
                f"Loaded {module_name} from outside the pinned support release: {loaded_path or '<unknown>'}"
            )

    try:
        from app_server.helpers import parse_method_last_modified_timestamp
    except ImportError:
        parse_method_last_modified_timestamp = sync_contract.parse_timestamp
    if int(getattr(sync_contract, "SYNC_RUNTIME_API_VERSION", 0) or 0) != 1:
        raise RuntimeError(
            "The shared ResQ synchronization runtime is incompatible with this macro. "
            "Republish the ArcRho macro library from the matching app release."
        )

    return {
        "migration": migration,
        "exporter_module": exporter_module,
        "parse_timestamp": parse_method_last_modified_timestamp,
        "method_entry": _method_entry_from_payload,
        "sync_contract": sync_contract,
    }


def _context_value(context: object, *names: str) -> str:
    if not isinstance(context, Mapping):
        return ""
    for name in names:
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _has_sync_context(context: object) -> bool:
    return bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


def _report_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    reporter = globals().get("report_macro_activity")
    if callable(reporter):
        reporter()


def _message(ui, text: object, *, title: str = TITLE, kind: str = "info", auto_close_ms=None, buttons=None):
    kwargs = {
        "title": title,
        "kind": kind,
        "timeout_sec": 600,
    }
    if auto_close_ms is not None:
        kwargs["auto_close_ms"] = auto_close_ms
    if buttons is not None:
        kwargs["buttons"] = buttons
    try:
        return ui.message_box(str(text or ""), **kwargs)
    except TypeError:
        kwargs.pop("timeout_sec", None)
        return ui.message_box(str(text or ""), **kwargs)


def _result_payload(result: object) -> dict[str, Any]:
    if isinstance(result, Mapping):
        payload = result.get("result")
        return dict(payload) if isinstance(payload, Mapping) else dict(result)
    payload = getattr(result, "result", None)
    return dict(payload) if isinstance(payload, Mapping) else {}


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
    for key in ("method metadata", "method_metadata"):
        metadata = payload.get(key)
        if isinstance(metadata, Mapping):
            value = _first_text(metadata, "last modified", "last_modified", "modified_at", "modified", "updated_at")
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
        method_code = _safe_int(payload.get("method_type_code"), 0)
        if key in method_keys:
            continue
        kind = _kind_from_code(method_code, payload.get("method_type"))
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
            can_receive = kind == KIND_DATASET and not calculated
            receive_reason = "ResQ calculated datasets recompute their own values." if calculated else ""
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


def _timestamp_cell(item: Mapping[str, Any] | None) -> str:
    """Every review row gets an explicit timestamp value for each side."""

    if not item:
        return "Not present"
    value = str(item.get("modified") or "").strip()
    source = str(item.get("timestamp_source") or "").strip()
    if item.get("modified_timestamp") is None:
        if value and source.startswith("ResQ Created"):
            return f"Unknown Modified; Created {value}"
        return "Unknown"
    return f"{value} ({source})" if source == "File modified" else value


def _action_label(action: object) -> str:
    normalized = str(action or "")
    if normalized == "arcrho_to_resq":
        return "ArcRho -> ResQ"
    if normalized == "resq_to_arcrho":
        return "ResQ -> ArcRho"
    return "No action"


def _row_tone(row: Mapping[str, Any]) -> str:
    status = str(row.get("status") or "").casefold()
    if row.get("conflict") or "mismatch" in status or "ambiguous" in status:
        return "warn"
    if "unsupported" in status or "unknown" in status:
        return "muted"
    if row.get("action"):
        return "info"
    if "synchronized" in status or "same timestamp" in status:
        return "ok"
    return "muted"


def review_table_payload(plan: list[dict[str, Any]], project_name: str, rc_path: str, connection_name: str) -> dict[str, Any]:
    """Project the plan into the reusable shell review-table contract."""

    rows = []
    for row in plan:
        tone = _row_tone(row)
        rows.append({
            "id": row["id"],
            "selected": bool(row.get("selected")),
            "disabled": bool(row.get("disabled")),
            "cells": {
                "kind": str(row.get("kind") or KIND_DATASET),
                "name": str(row.get("name") or ""),
                "arcrho_timestamp": _timestamp_cell(row.get("arcrho")),
                "resq_timestamp": _timestamp_cell(row.get("resq")),
                "status": {"text": str(row.get("status") or ""), "tone": tone},
                "action": {"text": _action_label(row.get("action")), "tone": tone},
                "detail": str(row.get("detail") or ""),
            },
        })
    actionable = sum(not bool(row.get("disabled")) for row in plan)
    selected = sum(bool(row.get("selected")) and not bool(row.get("disabled")) for row in plan)
    return {
        "title": TITLE,
        "summary": (
            f"Project: {project_name} | Reserving class: {rc_path} | ResQ: {connection_name}\n"
            f"Compared {len(plan)} logical dataset/method output(s). "
            f"{actionable} action(s) are available; {selected} are selected. "
            "Both timestamp columns are shown for every row."
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "arcrho_timestamp", "label": "ArcRho Timestamp", "width": 220},
            {"key": "resq_timestamp", "label": "ResQ Timestamp", "width": 220},
            {"key": "status", "label": "Status", "width": 190},
            {"key": "action", "label": "Proposed Action", "width": 145},
            {"key": "detail", "label": "Details", "width": 360},
        ],
        "rows": rows,
        "acceptLabel": "Apply Selected",
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter datasets and methods",
        "emptyMessage": "No datasets or methods were found on either side.",
    }


def review_sync_plan(ui, plan: list[dict[str, Any]], project_name: str, rc_path: str, connection_name: str) -> list[str] | None:
    """Open the non-blocking review table and poll until the user decides."""

    opened = ui.send_command(
        "ui.reviewTableOpen",
        args=review_table_payload(plan, project_name, rc_path, connection_name),
        timeout_sec=20,
    )
    opened_payload = _result_payload(opened)
    dialog_id = str(opened_payload.get("dialogId") or opened_payload.get("dialog_id") or "").strip()
    if not dialog_id:
        raise RuntimeError("ArcRho did not return a review-table dialog ID. Update or restart the ArcRho shell.")
    try:
        while True:
            _report_activity()
            status = ui.send_command(
                "ui.reviewTableStatus",
                args={"dialogId": dialog_id},
                timeout_sec=20,
            )
            payload = _result_payload(status)
            state = str(payload.get("status") or payload.get("state") or "").strip().casefold()
            if state == "completed":
                if not bool(payload.get("accepted")):
                    return None
                selected = payload.get("selectedRowIds") or payload.get("selected_row_ids") or []
                return [str(value) for value in selected if str(value).strip()]
            if state not in {"", "pending", "open"}:
                raise RuntimeError(str(payload.get("error") or f"Review table ended in an unexpected state: {state}"))
            time.sleep(REVIEW_POLL_SECONDS)
    finally:
        try:
            ui.send_command(
                "ui.reviewTableClose",
                args={"dialogId": dialog_id},
                timeout_sec=10,
            )
        except Exception:
            pass


def _progress_callback(progress):
    def callback(event: Mapping[str, Any]) -> None:
        _report_activity()
        target = progress() if callable(progress) else progress
        if target is None or not isinstance(event, Mapping):
            return
        total = _safe_int(event.get("total"), 0)
        completed = _safe_int(event.get("completed"), 0)
        status = str(event.get("status") or "").casefold()
        tone = {"success": "success", "error": "error", "skipped": "warning", "warning": "warning"}.get(status)
        message = str(event.get("message") or "Synchronizing ArcRho and ResQ")
        try:
            target.update(
                label=message,
                detail=message,
                total=total if total > 0 else None,
                completed=completed if total > 0 else None,
                tone=tone,
            )
        except Exception:
            pass

    return callback


def _new_exporter(runtime: Mapping[str, Any], project_name: str, rc_path: str, server_root: Path):
    migration = runtime["migration"]
    exporter_module = runtime["exporter_module"]
    return exporter_module.ResQReservingClassExporter(
        migration,
        arcrho_project_name=project_name,
        rc_path=rc_path,
        server_root=server_root,
        resq_project_name=project_name,
        connection_name=migration.CONNECTION_NAME,
        resq_user_name=migration.USER_NAME,
        resq_password=migration.PASSWORD,
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
    state_path = sync_contract.sync_state_path(server_root, project_name, rc_path, migration.CONNECTION_NAME)
    state = sync_contract.read_sync_state(state_path, project_name, rc_path, migration.CONNECTION_NAME)
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
        payload = item.get("payload") or {}
        format_code = payload.get("data_format_code") if isinstance(payload, Mapping) else None
        is_triangle = (
            int(format_code) == 0
            if format_code is not None
            else str(payload.get("data_format") or "").strip().casefold() == "triangle"
        )
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
    format_code = payload.get("data_format_code")
    is_triangle = (
        int(format_code) == 0
        if format_code is not None
        else str(payload.get("data_format") or "").strip().casefold() == "triangle"
    )
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
    format_code = payload.get("data_format_code")
    is_triangle = (
        int(format_code) == 0
        if format_code is not None
        else str(payload.get("data_format") or "").strip().casefold() == "triangle"
    )
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


def _preflight_method_export(exporter, row: Mapping[str, Any]) -> None:
    """Block known lossy dependency failures before mutating a ResQ method."""

    item = row.get("arcrho") if isinstance(row.get("arcrho"), Mapping) else {}
    payload = item.get("payload") if isinstance(item.get("payload"), Mapping) else {}
    kind = str(row.get("kind") or "")
    method_tab = payload.get("method_tab") if isinstance(payload.get("method_tab"), Mapping) else {}

    def require(name: object, finder, role: str) -> None:
        clean = str(name or "").strip()
        if clean and finder(clean) is None:
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
        details = payload.get("details tab") if isinstance(payload.get("details tab"), Mapping) else {}
        method_name = str(details.get("name") or item.get("method_name") or row.get("name") or "").strip()
        target = exporter._find_in("dfm_methods", exporter.reserving_class.DFMMethods, method_name)
        require_present(details.get("input triangle"), exporter._find_triangle, "DFM input triangle")
        if target is None:
            return
        expected_input = str(details.get("input triangle") or "").strip().casefold()
        actual_input = str(getattr(getattr(target, "InputTriangle"), "Name") or "").strip().casefold()
        if actual_input != expected_input:
            raise RuntimeError(
                "Existing ResQ DFM input triangle differs from ArcRho; safe retargeting is not supported."
            )
        expected_origin_length = int(details.get("origin length") or 0)
        expected_development_length = int(details.get("development length") or 0)
        if expected_origin_length and int(getattr(target, "OriginLength")) != expected_origin_length:
            raise RuntimeError("Existing ResQ DFM origin length differs from ArcRho.")
        if expected_development_length and int(getattr(target, "DevelopmentLength")) != expected_development_length:
            raise RuntimeError("Existing ResQ DFM development length differs from ArcRho.")
        ratios_tab = payload.get("ratios tab") if isinstance(payload.get("ratios tab"), Mapping) else {}
        ratio_triangle = ratios_tab.get("ratio triangle") if isinstance(ratios_tab.get("ratio triangle"), Mapping) else {}
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

        averages = ratios_tab.get("average formulas") if isinstance(ratios_tab.get("average formulas"), Mapping) else {}
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
            str(source.get("name") or "").strip().casefold()
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
            existing = set()
            count = int(getattr(target, "DatasetCount", 0) or 0)
            for index in range(1, count + 1):
                existing.add(str(target.Dataset(index).Name or "").strip().casefold())
            extras = sorted(existing - desired)
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
        return str(value or "").strip().casefold()

    def assert_link(actual: object, expected: object, role: str) -> None:
        actual_name = key(getattr(actual, "Name"))
        if actual_name != key(expected):
            raise RuntimeError(f"ResQ {role} link did not match ArcRho after the write.")

    if kind == KIND_DFM:
        details = payload.get("details tab") if isinstance(payload.get("details tab"), Mapping) else {}
        name = str(details.get("name") or item.get("method_name") or row.get("name") or "").strip()
        target = exporter._find_in("dfm_methods", exporter.reserving_class.DFMMethods, name)
        if target is None:
            raise RuntimeError("ResQ did not expose the DFM after the write.")
        _preflight_method_export(exporter, row)
        ratios_tab = payload.get("ratios tab") if isinstance(payload.get("ratios tab"), Mapping) else {}
        ratio_triangle = ratios_tab.get("ratio triangle") if isinstance(ratios_tab.get("ratio triangle"), Mapping) else {}
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

        averages = ratios_tab.get("average formulas") if isinstance(ratios_tab.get("average formulas"), Mapping) else {}
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


def _stale_selected_rows(runtime: Mapping[str, Any], preview_rows: list[dict[str, Any]], current_plan: list[dict[str, Any]]) -> list[str]:
    sync_contract = runtime["sync_contract"]
    current = _plan_by_id(current_plan)
    stale: list[str] = []
    for preview in preview_rows:
        observed = current.get(str(preview.get("id") or ""))
        if observed is None or not sync_contract.signatures_equal(
            sync_contract.plan_signature(preview),
            sync_contract.plan_signature(observed),
        ):
            stale.append(str(preview.get("name") or preview.get("id") or "item"))
    return stale


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
    clear_pending_keys: list[str] = []
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
        local_to_remote = [
            row for row in selected_rows
            if row.get("action") == sync_contract.ACTION_ARCRHO_TO_RESQ
        ]
        remote_to_local = [
            row for row in selected_rows
            if row.get("action") == sync_contract.ACTION_RESQ_TO_ARCRHO
        ]
        data_local = [row for row in local_to_remote if row.get("kind") == KIND_DATASET]
        method_local = [row for row in local_to_remote if row.get("kind") != KIND_DATASET]
        data_remote = [row for row in remote_to_local if row.get("kind") == KIND_DATASET]
        method_remote = [row for row in remote_to_local if row.get("kind") != KIND_DATASET]

        preflight_failed_ids: set[str] = set()
        for row in remote_to_local:
            try:
                _preflight_import_method_filename_collision(runtime, rc_dir, row)
            except Exception as exc:
                preflight_failed_ids.add(str(row.get("id") or ""))
                record(row, False, f"Preflight blocked the import: {exc}")
        for row in local_to_remote:
            try:
                if row.get("kind") == KIND_DATASET:
                    _preflight_dataset_export(exporter, row)
                else:
                    _preflight_method_export(exporter, row)
            except Exception as exc:
                preflight_failed_ids.add(str(row.get("id") or ""))
                record(row, False, f"Preflight blocked the write: {exc}")
        if preflight_failed_ids:
            selected_rows = [
                row for row in selected_rows
                if str(row.get("id") or "") not in preflight_failed_ids
            ]
            local_to_remote = [row for row in local_to_remote if str(row.get("id") or "") not in preflight_failed_ids]
            remote_to_local = [row for row in remote_to_local if str(row.get("id") or "") not in preflight_failed_ids]
            data_local = [row for row in local_to_remote if row.get("kind") == KIND_DATASET]
            method_local = [row for row in local_to_remote if row.get("kind") != KIND_DATASET]
            data_remote = [row for row in remote_to_local if row.get("kind") == KIND_DATASET]
            method_remote = [row for row in remote_to_local if row.get("kind") != KIND_DATASET]

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
        state = sync_contract.mark_sync_pending(
            state,
            [str(row.get("key") or "") for row in selected_rows],
            actions={
                str(row.get("key") or ""): str(row.get("action") or "")
                for row in selected_rows
            },
        )
        sync_contract.write_sync_state(state_path, state)
        with nullcontext():
            # Data writes are deliberately sequential. A ResQ Save or ArcRho
            # dependency refresh can recalculate a later selected row, so each
            # row is re-inventoried immediately before its own mutation.
            for row in data_local:
                current = plan_with_baseline(locked_observation["state"])
                current_row = _plan_by_id(current["plan"]).get(str(row.get("id") or ""))
                stale = _stale_selected_rows(runtime, [row], current["plan"])
                if stale or current_row is None:
                    clear_pending_keys.append(str(row.get("key") or ""))
                    record(row, False, "Timestamp changed during synchronization; rerun the review.")
                    continue
                try:
                    ok, message = _export_one_to_resq(exporter, row)
                except Exception as exc:
                    ok, message = False, str(exc)
                if ok:
                    stable, stability_message = remember_post_write(
                        row, locked_observation["state"], current_row
                    )
                    if not stable:
                        ok, message = False, f"{message} {stability_message}".strip()
                record(row, ok, message)

            for row in data_remote:
                current = plan_with_baseline(locked_observation["state"])
                current_row = _plan_by_id(current["plan"]).get(str(row.get("id") or ""))
                stale = _stale_selected_rows(runtime, [row], current["plan"])
                if stale or current_row is None:
                    clear_pending_keys.append(str(row.get("key") or ""))
                    record(row, False, "Timestamp changed during synchronization; rerun the review.")
                    continue
                with migration.defer_sidecar_graph_enrichment():
                    try:
                        ok, message = _import_one_from_resq(
                            runtime, exporter, rc_path, rc_dir, row, progress_callback
                        )
                    except Exception as exc:
                        ok, message = False, str(exc)
                if not ok:
                    restored = False
                    try:
                        _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                        restored = True
                    except Exception as restore_error:
                        message = f"{message} Rollback also failed: {restore_error}"
                    if restored:
                        clear_pending_keys.append(str(row.get("key") or ""))
                else:
                    stable, stability_message = remember_post_write(
                        row, locked_observation["state"], current_row
                    )
                    if not stable:
                        ok, message = False, f"{message} {stability_message}".strip()
                        try:
                            _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                            clear_pending_keys.append(str(row.get("key") or ""))
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
                record(row, ok, message)

            # Method writes can recalculate other method outputs on either side.
            # Recheck each method immediately before its mutation, then run local
            # propagation before the next row. This sequential I/O is required by
            # the dependency ordering; the inventory itself uses bounded reads.
            for row in method_local + method_remote:
                current = plan_with_baseline(locked_observation["state"])
                current_row = _plan_by_id(current["plan"]).get(str(row.get("id") or ""))
                stale = _stale_selected_rows(runtime, [row], current["plan"])
                if stale or current_row is None:
                    clear_pending_keys.append(str(row.get("key") or ""))
                    record(row, False, "Timestamp changed during synchronization; rerun the review.")
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
                        restored = False
                        try:
                            _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                            restored = True
                        except Exception as restore_error:
                            message = f"{message} Rollback also failed: {restore_error}"
                        if restored:
                            clear_pending_keys.append(str(row.get("key") or ""))
                    else:
                        stable, stability_message = remember_post_write(
                            row, locked_observation["state"], current_row
                        )
                        if not stable:
                            ok, message = False, f"{message} {stability_message}".strip()
                            try:
                                _restore_group(runtime, exporter, rc_dir, row, backup_root, backup_paths)
                                clear_pending_keys.append(str(row.get("key") or ""))
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
            updated_state = sync_contract.clear_sync_pending(
                updated_state, clear_pending_keys
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


def _public_plan_rows(plan: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a serializable preview without COM objects or full JSON payloads."""

    return [
        {
            "id": str(row.get("id") or ""),
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


def _selection_result(value: object) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, Mapping):
        if value.get("accepted") is False:
            return None
        value = value.get("selectedRowIds") or value.get("selected_row_ids") or []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        raise TypeError("The sync selection must be a collection of review-table row IDs.")
    return [str(item).strip() for item in value if str(item).strip()]


def sync_reserving_class_with_resq(
    project_name: str,
    rc_path: str,
    *,
    server_root: str | Path | None = None,
    selected_row_ids: list[str] | None = None,
    selection_callback=None,
    progress_callback=None,
    runtime: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Preview and selectively synchronize one same-named project/RC scope.

    With neither ``selected_row_ids`` nor ``selection_callback``, this is a
    read-only preview.  The UI macro passes ``selection_callback`` so no write
    can begin before the reusable review table returns an accepted selection.
    """

    project_name = str(project_name or "").strip()
    rc_path = str(rc_path or "").strip()
    if not project_name:
        raise ValueError("project_name is required.")
    if not rc_path:
        raise ValueError("rc_path is required.")
    runtime = dict(runtime or _load_runtime_modules())
    migration = runtime["migration"]
    root = Path(server_root or DEFAULT_SERVER_ROOT).expanduser().resolve()
    previous_scope = migration._apply_runtime_scope(project_name, root)
    exporter = None
    try:
        _emit_progress(progress_callback, {
            "event": "scan",
            "completed": 0,
            "total": 0,
            "message": f"Comparing ArcRho and ResQ: {rc_path}",
        })
        preview = _plan_context(runtime, project_name, rc_path, root)
        public_preview = _public_plan_rows(preview["plan"])
        _emit_progress(progress_callback, {
            "event": "review",
            "completed": 0,
            "total": len(preview["plan"]),
            "message": f"Review {len(preview['plan'])} dataset/method output(s)",
        })

        if selected_row_ids is None and selection_callback is None:
            return {
                "status": "review_required",
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": migration.CONNECTION_NAME,
                "preview": public_preview,
            }

        selection = (
            selection_callback(preview["plan"])
            if selected_row_ids is None
            else selected_row_ids
        )
        selected_ids = _selection_result(selection)
        if selected_ids is None:
            return {
                "status": "cancelled",
                "cancelled": True,
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": migration.CONNECTION_NAME,
                "preview": public_preview,
            }

        selected_preview = _selected_rows(preview["plan"], selected_ids)
        if not selected_preview:
            return {
                "status": "no_changes",
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": migration.CONNECTION_NAME,
                "preview": public_preview,
                "successes": 0,
                "failures": 0,
                "results": [],
            }

        _emit_progress(progress_callback, {
            "event": "revalidate",
            "completed": 0,
            "total": len(selected_preview),
            "message": "Rechecking selected timestamps before writing",
        })
        exporter = _new_exporter(runtime, project_name, rc_path, root)
        exporter.connect()
        current = _plan_context(runtime, project_name, rc_path, root, exporter=exporter)
        stale = _stale_selected_rows(runtime, selected_preview, current["plan"])
        if stale:
            return {
                "status": "stale",
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": migration.CONNECTION_NAME,
                "preview": public_preview,
                "stale_items": stale,
                "successes": 0,
                "failures": 0,
                "results": [],
            }

        current_rows = _selected_rows(current["plan"], selected_ids)
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
            result.update({
                "status": "stale",
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": migration.CONNECTION_NAME,
                "preview": public_preview,
            })
            return result
        result.update({
            "status": "completed_with_errors" if result.get("failures") else "completed",
            "project_name": project_name,
            "rc_path": rc_path,
            "connection_name": migration.CONNECTION_NAME,
            "preview": public_preview,
        })
        return result
    finally:
        if exporter is not None:
            try:
                exporter.disconnect()
            except Exception:
                pass
        migration._restore_runtime_scope(previous_scope)


def _sync_summary_message(result: Mapping[str, Any]) -> str:
    status = str(result.get("status") or "")
    if status == "stale":
        names = [str(value) for value in result.get("stale_items") or []]
        details = "\n".join(f"- {name}" for name in names[:12])
        return (
            "No actions were applied because one or more selected timestamps changed during review.\n"
            "Run the macro again to review a fresh comparison."
            + (f"\n\nChanged items:\n{details}" if details else "")
        )
    if status == "no_changes":
        return "No synchronization actions were selected. Nothing was changed."

    results = [item for item in result.get("results") or [] if isinstance(item, Mapping)]
    successful = [item for item in results if item.get("id") and item.get("success")]
    failed = [item for item in results if item.get("id") and not item.get("success")]
    warnings = [item for item in results if not item.get("id")]
    to_resq = sum(item.get("action") == "arcrho_to_resq" for item in successful)
    to_arcrho = sum(item.get("action") == "resq_to_arcrho" for item in successful)
    lines = [
        "Reserving-class synchronization completed." if not failed else "Reserving-class synchronization completed with errors.",
        f"Project: {result.get('project_name')}",
        f"Path: {result.get('rc_path')}",
        f"ResQ connection: {result.get('connection_name')}",
        "",
        f"Applied: {len(successful)}",
        f"ArcRho -> ResQ: {to_resq}",
        f"ResQ -> ArcRho: {to_arcrho}",
        f"Failed or skipped: {len(failed)}",
    ]
    if failed or warnings:
        lines.extend(("", "Details:"))
        for item in (failed + warnings)[:12]:
            lines.append(f"- {item.get('name')}: {item.get('message')}")
    return "\n".join(lines)


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    progress_holder = {"value": None}
    try:
        runtime = _load_runtime_modules()
    except Exception as exc:
        message = f"Could not load the ArcRho/ResQ synchronization helpers.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"status": "error", "error": str(exc), "message": message}

    try:
        context = (
            active_context
            if _has_sync_context(active_context)
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = _context_value(context, "projectName", "project_name")
        rc_path = _context_value(context, "selectedPath", "selected_path", "path")
        if not project_name or not rc_path:
            raise ValueError("The active Project Instance page does not expose a project and reserving-class path.")

        active_window = ui.project_instance.active_window(timeout_sec=10)
        if active_window is not None and active_window.get_properties(timeout_sec=10).dirty:
            message = "Save or close unsaved dataset/method changes before synchronizing this reserving class."
            _message(ui, message, kind="warning", auto_close_ms=9000)
            return {"status": "cancelled", "cancelled": True, "reason": "active_window_dirty"}

        root = get_server_root(required=True)
        progress_holder["value"] = ui.progress_bar(
            progress_id=f"{PROGRESS_ID}-scan",
            title=TITLE,
            label=f"Comparing ArcRho and ResQ: {rc_path}",
            total=0,
        )

        def review(plan):
            current_progress = progress_holder.get("value")
            if current_progress is not None:
                try:
                    current_progress.close()
                except Exception:
                    pass
                progress_holder["value"] = None
            selected = review_sync_plan(
                ui,
                plan,
                project_name,
                rc_path,
                runtime["migration"].CONNECTION_NAME,
            )
            if selected is not None:
                progress_holder["value"] = ui.progress_bar(
                    progress_id=f"{PROGRESS_ID}-apply",
                    title=TITLE,
                    label="Rechecking selected timestamps",
                    total=len(selected),
                )
            return selected

        result = sync_reserving_class_with_resq(
            project_name,
            rc_path,
            server_root=root,
            selection_callback=review,
            progress_callback=_progress_callback(lambda: progress_holder.get("value")),
            runtime=runtime,
        )
        status = str(result.get("status") or "")
        if status == "cancelled":
            return result

        local_writes = any(
            item.get("success") and item.get("action") == "resq_to_arcrho"
            for item in result.get("results") or []
            if isinstance(item, Mapping)
        )
        if local_writes:
            try:
                ui.project_instance.reload_dataset_table(timeout_sec=30)
                result["dataset_table_reloaded"] = True
            except Exception as exc:
                result["dataset_table_reloaded"] = False
                result["reload_error"] = str(exc)

        summary = _sync_summary_message(result)
        kind = "warning" if status in {"stale", "no_changes", "completed_with_errors"} else "success"
        _message(ui, summary, kind=kind, auto_close_ms=None if status in {"stale", "completed_with_errors"} else 7000)
        result["message"] = summary
        return result
    except Exception as exc:
        tb = traceback.format_exc()
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.update(label="Synchronization failed", detail=str(exc), tone="error")
            except Exception:
                pass
        message = f"Reserving-class synchronization failed:\n{exc}\n\n{tb}"
        _message(ui, message, kind="error")
        return {"status": "error", "error": str(exc), "traceback": tb, "message": message}
    finally:
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.close(auto_close_ms=1500)
            except Exception:
                pass
