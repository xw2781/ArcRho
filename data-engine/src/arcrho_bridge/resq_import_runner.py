"""Run canonical ResQ reserving-class imports inside the Bridge worker.

The Bridge deliberately does not own a second set of migration writers.  It
loads the same ``resq_data_migration`` source bundle used by the direct
migration entry point, runs it in an isolated staging reserving-class folder,
then atomically swaps that staged folder into the live project only after the
ResQ portion has succeeded.

The queue request contains logical identifiers only.  In particular, callers
cannot select a server root, staging path, or target folder: all of those are
derived from the Bridge's configured ArcRho Server root.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
import shutil
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping

try:
    from src.arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )
    from src.utils import get_project_root
except ModuleNotFoundError:  # Source-run Bridge entry point.
    from arcrho_bridge.resq_import_contract import (
        load_resq_reserving_class_import_contract,
    )
    from utils import get_project_root


_BUNDLE_DIR_NAME = "resq_importer"
_BUNDLE_MIGRATION_RELATIVE_DIR = Path("python-api") / "migration"
_BUNDLE_PYTHON_API_SRC_RELATIVE_DIR = Path("python-api") / "src"
_MIGRATION_ENTRY_FILE = "resq_data_migration.py"
_MIGRATION_MODULE_NAME = "_arcrho_bridge_resq_data_migration"
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')
_IMPORT_STAGING_ROOT_NAME = "r"
_IMPORT_STAGED_DATA_DIR_NAME = "d"
_IMPORT_LOCK_DIR_NAME = ".locks"
_IMPORT_LOCK_SUFFIX = ".lock"
_MODULE_LOAD_LOCK = threading.RLock()

ProgressCallback = Callable[[dict[str, Any]], None]


class ResQMigrationBundleError(RuntimeError):
    """The Bridge cannot safely use its canonical migration bundle."""


class ResQImportRequestError(ValueError):
    """A shared-server import request contains an unsafe logical value."""


class ResQImportCommitError(RuntimeError):
    """A completed staged import could not be safely committed."""

    def __init__(self, message: str, *, status_result: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status_result = status_result


@dataclass(frozen=True)
class ResQMigrationBundle:
    """Locations of the canonical migration and its API contract dependency."""

    migration_dir: Path
    python_api_src: Path
    source: str

    @property
    def entrypoint(self) -> Path:
        return self.migration_dir / _MIGRATION_ENTRY_FILE


def locate_resq_migration_bundle(
    *,
    frozen: bool | None = None,
    frozen_bundle_root: str | os.PathLike[str] | None = None,
    source_repo_root: str | os.PathLike[str] | None = None,
) -> ResQMigrationBundle:
    """Locate the one migration bundle shipped with this Bridge.

    A frozen Bridge never falls back to a nearby developer checkout.  That
    prevents an installed worker from silently using a different JSON writer
    than the one that was released with it.
    """

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else bool(frozen)
    if is_frozen:
        bundle_root = (
            Path(frozen_bundle_root).expanduser().resolve()
            if frozen_bundle_root is not None
            else _frozen_bundle_root()
        )
        bundle = ResQMigrationBundle(
            migration_dir=bundle_root / _BUNDLE_MIGRATION_RELATIVE_DIR,
            python_api_src=bundle_root / _BUNDLE_PYTHON_API_SRC_RELATIVE_DIR,
            source="frozen",
        )
    else:
        repo_root = (
            Path(source_repo_root).expanduser().resolve()
            if source_repo_root is not None
            else _source_repo_root()
        )
        bundle = ResQMigrationBundle(
            migration_dir=repo_root / _BUNDLE_MIGRATION_RELATIVE_DIR,
            python_api_src=repo_root / _BUNDLE_PYTHON_API_SRC_RELATIVE_DIR,
            source="source",
        )

    _validate_bundle(bundle)
    return bundle


def load_resq_data_migration(
    bundle: ResQMigrationBundle | None = None,
) -> ModuleType:
    """Load and cache the canonical migration module for this worker process."""

    resolved_bundle = bundle or locate_resq_migration_bundle()
    _validate_bundle(resolved_bundle)
    with _MODULE_LOAD_LOCK:
        existing = sys.modules.get(_MIGRATION_MODULE_NAME)
        if existing is not None:
            if _module_file_is(existing, resolved_bundle.entrypoint):
                return existing
            raise ResQMigrationBundleError(
                "A different ResQ migration bundle is already loaded in this Bridge "
                "process. Restart the Bridge worker before importing again."
            )

        _require_matching_imported_package("resq_migration", resolved_bundle.migration_dir)
        _require_matching_imported_package("arcrho_api", resolved_bundle.python_api_src)
        _prepend_import_path(resolved_bundle.python_api_src)
        _prepend_import_path(resolved_bundle.migration_dir)
        importlib.invalidate_caches()

        spec = importlib.util.spec_from_file_location(
            _MIGRATION_MODULE_NAME,
            resolved_bundle.entrypoint,
        )
        if spec is None or spec.loader is None:
            raise ResQMigrationBundleError(
                f"Could not create an import specification for [{resolved_bundle.entrypoint}]."
            )
        module = importlib.util.module_from_spec(spec)
        sys.modules[_MIGRATION_MODULE_NAME] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(_MIGRATION_MODULE_NAME, None)
            raise
        return module


def run_reserving_class_import(
    request: Mapping[str, Any],
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Run one logical Bridge import request through the canonical migration.

    The importer writes only below a request-specific staging folder.  The live
    reserving-class folder is swapped only after the ResQ stage completes and
    the canonical index has been rebuilt.  Engine failures are intentionally
    different: the staged engine component is discarded and the prior live
    engine component is copied into the staged result before the swap.
    """

    project_name = _project_name_from_request(request)
    rc_path = _rc_path_from_request(request)
    export_mode = _export_mode_from_request(request)
    request_id = _request_id_from_request(request)
    server_root = Path(get_project_root()).expanduser().resolve()
    bundle = configure_canonical_runtime(server_root)
    module = load_resq_data_migration(bundle)
    rc_folder = _canonical_rc_folder(module, rc_path)
    project_data_dir = _project_data_dir(server_root, project_name)
    target_rc_dir = _direct_child(project_data_dir, rc_folder, "target reserving-class folder")
    staging_parent = _import_staging_parent(server_root)
    job_root = _direct_child(staging_parent, request_id, "ResQ import job folder")
    stage_data_dir = _direct_child(
        job_root,
        _IMPORT_STAGED_DATA_DIR_NAME,
        "staged project data folder",
    )
    stage_rc_dir = _direct_child(stage_data_dir, rc_folder, "staged reserving-class folder")

    _validate_live_target(target_rc_dir, project_data_dir)
    _prepare_job_root(job_root, staging_parent)
    try:
        lock_path = _acquire_target_lock(staging_parent, project_name, rc_path, request_id)
    except Exception:
        try:
            _remove_job_root(job_root, staging_parent)
        except Exception:
            # Preserve the original lock failure. The isolated job folder is
            # harmless and contains no live reserving-class data.
            pass
        raise
    committed = False
    cleanup_job_root = False
    try:
        _report_progress(
            progress_callback,
            {
                "event": "stage",
                "kind": "resq_import",
                "status": "processing",
                "message": "Preparing a staged reserving-class import.",
            },
        )
        importer = getattr(module, "import_reserving_class_from_resq", None)
        if not callable(importer):
            raise ResQMigrationBundleError(
                "The deployed ResQ migration bundle does not expose "
                "import_reserving_class_from_resq()."
            )

        result = importer(
            project_name,
            rc_path,
            server_root=server_root,
            project_data_dir=stage_data_dir,
            export_mode=export_mode,
            cleanup_target=True,
            skip_unavailable_engine=True,
            progress_callback=_safe_progress_callback(progress_callback),
            verbose=False,
        )
        if not isinstance(result, Mapping):
            raise ResQMigrationBundleError(
                "The canonical ResQ migration returned a non-object result."
            )
        result = dict(result)
        _require_no_non_engine_errors(result)
        _require_staged_rc_dir(stage_rc_dir, stage_data_dir)

        preserve_engine = (not bool(result.get("engine_available"))) or int(
            result.get("engine_errors") or 0
        ) > 0
        restored_engine_artifacts = 0
        if preserve_engine:
            restored_engine_artifacts = _restore_prior_engine_component(
                target_rc_dir,
                stage_rc_dir,
            )
            _report_progress(
                progress_callback,
                {
                    "event": "activity",
                    "kind": "engine_restore",
                    "status": "warning",
                    "message": (
                        "Retained the prior ArcRho Engine datasets because the "
                        "engine stage was unavailable or incomplete."
                    ),
                },
            )

        _refresh_stage_contract(module, project_name, rc_path, server_root, stage_data_dir, stage_rc_dir)
        _report_progress(
            progress_callback,
            {
                "event": "commit",
                "kind": "resq_import",
                "status": "processing",
                "message": "Committing the staged reserving-class import.",
            },
        )
        previous_data_deleted, cleanup_warning = _commit_staged_rc(
            target_rc_dir,
            stage_rc_dir,
            job_root,
            project_data_dir,
        )
        committed = True
        cleanup_job_root = previous_data_deleted

        result["engine_component_preserved"] = preserve_engine
        result["engine_artifacts_restored"] = restored_engine_artifacts
        result["previous_data_deleted"] = previous_data_deleted
        if cleanup_warning:
            result["message"] = cleanup_warning
        result["committed"] = True
        _report_progress(
            progress_callback,
            {
                "event": "commit",
                "kind": "resq_import",
                "status": "success",
                "message": "ResQ import committed.",
            },
        )
        return _json_safe(result)
    finally:
        _release_target_lock(lock_path)
        if committed and cleanup_job_root:
            try:
                _remove_job_root(job_root, staging_parent)
            except Exception:
                # The live commit is already durable. A leftover empty staging
                # folder must not make the Bridge report that committed data
                # was safely rolled back.
                pass


def _source_repo_root() -> Path:
    # .../data-engine/src/arcrho_bridge/resq_import_runner.py -> repository root
    return Path(__file__).resolve().parents[3]


def configure_canonical_runtime(server_root: str | os.PathLike[str]) -> ResQMigrationBundle:
    """Configure the canonical migration runtime before importing it.

    ``resq_migration.engine`` resolves its frontend path at module import time,
    and the frontend provenance helper resolves its ArcRho Server root from the
    environment.  Set both values before :func:`load_resq_data_migration` so a
    frozen Bridge never falls back to the developer checkout or its own local
    user-preference workspace path.
    """

    root = Path(server_root).expanduser().resolve()
    bundle = locate_resq_migration_bundle()
    frontend_root = bundle.migration_dir.parents[1] / "frontend"
    provenance_helper = frontend_root / "app_server" / "services" / "data_processing_rules_service.py"
    if not provenance_helper.is_file():
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle is missing its frontend provenance "
            f"helper: [{provenance_helper}]."
        )
    os.environ["ARCRHO_RUNTIME_SERVER_ROOT"] = str(root)
    os.environ["ARCRHO_FRONTEND_ROOT"] = str(frontend_root.resolve())
    _prepend_import_path(frontend_root)
    return bundle


def _frozen_bundle_root() -> Path:
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        raise ResQMigrationBundleError(
            "The frozen Bridge could not locate its PyInstaller resource directory."
        )
    return Path(meipass).resolve() / _BUNDLE_DIR_NAME


def _validate_bundle(bundle: ResQMigrationBundle) -> None:
    required = (
        bundle.entrypoint,
        bundle.migration_dir / "resq_migration" / "core.py",
        bundle.migration_dir / "resq_migration" / "catalog.py",
        bundle.python_api_src / "arcrho_api" / "dataset_index_contract.py",
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle is incomplete; missing: "
            + ", ".join(missing)
        )


def _module_file_is(module: ModuleType, expected: Path) -> bool:
    file_name = getattr(module, "__file__", None)
    if not file_name:
        return False
    try:
        return Path(file_name).resolve() == expected.resolve()
    except OSError:
        return False


def _require_matching_imported_package(package_name: str, expected_root: Path) -> None:
    loaded = sys.modules.get(package_name)
    if loaded is None:
        return
    file_name = getattr(loaded, "__file__", None)
    if not file_name:
        raise ResQMigrationBundleError(
            f"A non-file [{package_name}] module is already loaded; restart the Bridge worker."
        )
    try:
        loaded_path = Path(file_name).resolve()
        root = expected_root.resolve()
        loaded_path.relative_to(root)
    except (OSError, ValueError):
        raise ResQMigrationBundleError(
            f"A different [{package_name}] package is already loaded; restart the Bridge worker."
        ) from None


def _prepend_import_path(path: Path) -> None:
    text = str(path.resolve())
    if text not in sys.path:
        sys.path.insert(0, text)


def _project_name_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, "ProjectName")
    if any(char in value for char in _INVALID_PROJECT_NAME_CHARS) or value in {".", ".."}:
        raise ResQImportRequestError("ProjectName must be one safe logical project name.")
    return value


def _rc_path_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, "Path")
    normalized = value.replace("/", "\\")
    segments = [part.strip() for part in normalized.split("\\")]
    if (
        not normalized
        or normalized.startswith("\\")
        or ":" in normalized
        or "\x00" in normalized
        or any(part in {"", ".", ".."} for part in segments)
    ):
        raise ResQImportRequestError("Path must be a relative logical reserving-class path.")
    return normalized


def _export_mode_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, "ExportMode").casefold()
    allowed_export_modes = _allowed_export_modes()
    if value not in allowed_export_modes:
        raise ResQImportRequestError(
            "ExportMode must be one of: " + ", ".join(sorted(allowed_export_modes)) + "."
        )
    return value


def _allowed_export_modes() -> frozenset[str]:
    contract = load_resq_reserving_class_import_contract()
    modes = contract.get("allowed_export_modes")
    if not isinstance(modes, tuple):
        raise ResQMigrationBundleError("The ResQ import contract has no allowed export modes.")
    normalized = frozenset(str(mode).strip().casefold() for mode in modes if str(mode).strip())
    if not normalized:
        raise ResQMigrationBundleError("The ResQ import contract has no usable export modes.")
    return normalized


def _request_id_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, "RequestId")
    if not _REQUEST_ID_RE.fullmatch(value):
        raise ResQImportRequestError("RequestId must be a UUID-like safe token.")
    return value


def _required_text(request: Mapping[str, Any], key: str) -> str:
    if not isinstance(request, Mapping):
        raise ResQImportRequestError("The ResQ import request must be a JSON object.")
    value = request.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ResQImportRequestError(f"{key} is required.")
    return value.strip()


def _canonical_rc_folder(module: ModuleType, rc_path: str) -> str:
    encoder = getattr(module, "_encode_rc_folder", None)
    if not callable(encoder):
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle does not expose its RC folder encoder."
        )
    folder = str(encoder(rc_path) or "").strip()
    if not folder or folder in {".", ".."} or any(char in folder for char in "\\/"):
        raise ResQMigrationBundleError("The canonical RC folder encoder returned an unsafe folder name.")
    return folder


def _project_data_dir(server_root: Path, project_name: str) -> Path:
    projects_dir = _direct_child(server_root, "projects", "projects folder")
    project_dir = _direct_child(projects_dir, project_name, "project folder")
    return _direct_child(project_dir, "data", "project data folder")


def _import_staging_parent(server_root: Path) -> Path:
    """Return the short, server-owned staging root for transactional imports.

    A staged import atomically writes GUID-suffixed files. Keeping those files
    below a project/RC path can exceed legacy Windows path limits for valid
    ResQ names, so staging lives directly beneath the configured server root.
    The request ID and data folder are intentionally short for the same reason.
    """

    return _direct_child(
        server_root,
        _IMPORT_STAGING_ROOT_NAME,
        "ResQ import staging folder",
    )


def _direct_child(parent: Path, name: str, label: str) -> Path:
    if not name or name in {".", ".."} or Path(name).name != name:
        raise ResQImportRequestError(f"Unsafe {label} name.")
    parent_resolved = parent.resolve(strict=False)
    child = (parent_resolved / name).resolve(strict=False)
    if child.parent != parent_resolved:
        raise ResQImportRequestError(f"Unsafe {label} path.")
    return child


def _validate_live_target(target_rc_dir: Path, project_data_dir: Path) -> None:
    if target_rc_dir.parent != project_data_dir.resolve(strict=False):
        raise ResQImportCommitError("The target reserving-class folder escaped project data.")
    if target_rc_dir.is_symlink():
        raise ResQImportCommitError("Refusing to replace a symlinked reserving-class folder.")


def _prepare_job_root(job_root: Path, staging_parent: Path) -> None:
    if job_root.parent != staging_parent.resolve(strict=False):
        raise ResQImportCommitError("The staged job folder escaped the import staging area.")
    staging_parent.mkdir(parents=True, exist_ok=True)
    if staging_parent.is_symlink():
        raise ResQImportCommitError("Refusing to use a symlinked ResQ import staging area.")
    try:
        job_root.mkdir()
    except FileExistsError as exc:
        raise ResQImportCommitError(
            "A staged import already exists for this RequestId; do not reuse RequestId values."
        ) from exc
    if job_root.is_symlink():
        raise ResQImportCommitError("Refusing to use a symlinked ResQ import job folder.")


def _lock_file_name(project_name: str, rc_path: str) -> str:
    # Safe, stable, and avoids exposing a logical RC path as a shared filename.
    import hashlib

    digest = hashlib.sha256(f"{project_name}\x00{rc_path.casefold()}".encode("utf-8")).hexdigest()
    return f"{digest}{_IMPORT_LOCK_SUFFIX}"


def _acquire_target_lock(
    staging_parent: Path,
    project_name: str,
    rc_path: str,
    request_id: str,
) -> Path:
    lock_dir = _direct_child(staging_parent, _IMPORT_LOCK_DIR_NAME, "ResQ import lock folder")
    lock_dir.mkdir(parents=True, exist_ok=True)
    if lock_dir.is_symlink():
        raise ResQImportCommitError("Refusing to use a symlinked ResQ import lock folder.")
    lock_path = _direct_child(lock_dir, _lock_file_name(project_name, rc_path), "ResQ import lock")
    payload = {
        "request_id": request_id,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        with lock_path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
    except FileExistsError as exc:
        raise ResQImportCommitError(
            "Another ResQ import is already processing this reserving class."
        ) from exc
    return lock_path


def _release_target_lock(lock_path: Path) -> None:
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _require_staged_rc_dir(stage_rc_dir: Path, stage_data_dir: Path) -> None:
    if stage_rc_dir.parent != stage_data_dir.resolve(strict=False):
        raise ResQImportCommitError("The staged reserving-class folder escaped staged project data.")
    if not stage_rc_dir.is_dir() or stage_rc_dir.is_symlink():
        raise ResQImportCommitError("The canonical import produced no safe staged reserving-class folder.")


def _require_no_non_engine_errors(result: Mapping[str, Any]) -> None:
    errors = _non_negative_int(result.get("errors"), "errors")
    engine_errors = _non_negative_int(result.get("engine_errors"), "engine_errors")
    if engine_errors > errors:
        raise ResQMigrationBundleError("The canonical import reported more engine errors than total errors.")
    non_engine_errors = errors - engine_errors
    if non_engine_errors:
        raise ResQImportCommitError(
            f"The ResQ import reported {non_engine_errors} non-engine error(s); the live RC was not changed.",
            status_result=_error_status_result(result, errors=errors, engine_errors=engine_errors),
        )


def _error_status_result(
    result: Mapping[str, Any],
    *,
    errors: int,
    engine_errors: int,
) -> dict[str, Any]:
    """Project bounded import diagnostics into the location-independent status contract."""

    details = result.get("error_details")
    safe_details: list[dict[str, str]] = []
    if isinstance(details, list):
        for raw in details[:12]:
            if not isinstance(raw, Mapping):
                continue
            kind = str(raw.get("kind") or "item").strip()
            name = str(raw.get("name") or "unnamed").strip()
            message = _redact_machine_paths(str(raw.get("message") or "Import failed.").strip())
            safe_details.append({
                "kind": kind or "item",
                "name": name or "unnamed",
                "message": message or "Import failed.",
            })
    return {
        "errors": errors,
        "engine_errors": engine_errors,
        "error_details": safe_details,
    }


def _redact_machine_paths(value: str) -> str:
    """Avoid publishing local drive or UNC paths in a shared Bridge status."""

    return re.sub(r"(?i)(?:[a-z]:|\\\\)[^\s\"']+", "[path]", value)


def _non_negative_int(value: Any, field: str) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError) as exc:
        raise ResQMigrationBundleError(f"The canonical import returned an invalid {field} count.") from exc
    if number < 0:
        raise ResQMigrationBundleError(f"The canonical import returned a negative {field} count.")
    return number


def _restore_prior_engine_component(live_rc_dir: Path, stage_rc_dir: Path) -> int:
    """Replace staged engine artifacts with the last complete live engine component."""

    _remove_engine_artifacts(stage_rc_dir)
    if not live_rc_dir.is_dir():
        return 0
    if live_rc_dir.is_symlink():
        raise ResQImportCommitError("Refusing to read a symlinked live reserving-class folder.")

    copied = 0
    for sidecar in _engine_sidecar_paths(live_rc_dir):
        payload = _read_json_object(sidecar)
        csv_name = payload.get("csv_file")
        if not isinstance(csv_name, str) or not csv_name.strip() or Path(csv_name).name != csv_name:
            raise ResQImportCommitError(
                f"Live engine sidecar [{sidecar.name}] has an unsafe or missing csv_file."
            )
        source_csv = live_rc_dir / "datasets" / csv_name
        if not source_csv.is_file() or source_csv.is_symlink():
            raise ResQImportCommitError(
                f"Live engine sidecar [{sidecar.name}] is missing its CSV [{csv_name}]."
            )
        target_sidecar = stage_rc_dir / "sidecars" / sidecar.name
        target_csv = stage_rc_dir / "datasets" / csv_name
        target_sidecar.parent.mkdir(parents=True, exist_ok=True)
        target_csv.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sidecar, target_sidecar)
        shutil.copy2(source_csv, target_csv)
        copied += 1
    return copied


def _remove_engine_artifacts(rc_dir: Path) -> int:
    removed = 0
    for sidecar in _engine_sidecar_paths(rc_dir):
        payload = _read_json_object(sidecar)
        csv_name = payload.get("csv_file")
        if isinstance(csv_name, str) and csv_name.strip() and Path(csv_name).name == csv_name:
            csv_path = rc_dir / "datasets" / csv_name
            try:
                csv_path.unlink()
                removed += 1
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise ResQImportCommitError(
                    f"Could not remove staged engine CSV [{csv_path.name}]: {exc}"
                ) from exc
        try:
            sidecar.unlink()
            removed += 1
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise ResQImportCommitError(
                f"Could not remove staged engine sidecar [{sidecar.name}]: {exc}"
            ) from exc
    return removed


def _engine_sidecar_paths(rc_dir: Path) -> tuple[Path, ...]:
    sidecar_dir = rc_dir / "sidecars"
    if not sidecar_dir.is_dir() or sidecar_dir.is_symlink():
        return ()
    paths: list[Path] = []
    try:
        candidates = sorted(sidecar_dir.glob("*.json"), key=lambda path: path.name.casefold())
    except OSError as exc:
        raise ResQImportCommitError(f"Could not enumerate engine sidecars: {exc}") from exc
    for path in candidates:
        if path.is_symlink():
            raise ResQImportCommitError(f"Refusing to use a symlinked sidecar [{path.name}].")
        payload = _read_json_object(path)
        if str(payload.get("source_kind") or "").strip().casefold() == "engine":
            paths.append(path)
    return tuple(paths)


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ResQImportCommitError(f"Could not read sidecar [{path.name}]: {exc}") from exc
    if not isinstance(payload, dict):
        raise ResQImportCommitError(f"Sidecar [{path.name}] must contain a JSON object.")
    return payload


def _refresh_stage_contract(
    module: ModuleType,
    project_name: str,
    rc_path: str,
    server_root: Path,
    stage_data_dir: Path,
    stage_rc_dir: Path,
) -> None:
    apply_scope = getattr(module, "_apply_runtime_scope", None)
    restore_scope = getattr(module, "_restore_runtime_scope", None)
    refresh_graphs = getattr(module, "refresh_sidecar_graphs_for_rc", None)
    rebuild_index = getattr(module, "rebuild_dataset_instance_index", None)
    if not all(callable(item) for item in (apply_scope, restore_scope, refresh_graphs, rebuild_index)):
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle does not expose required graph/index helpers."
        )
    previous_scope = apply_scope(project_name, server_root, stage_data_dir)
    try:
        refresh_graphs(stage_rc_dir)
        rebuild_index(project_name, rc_path, stage_rc_dir)
    finally:
        restore_scope(previous_scope)


def _commit_staged_rc(
    live_rc_dir: Path,
    stage_rc_dir: Path,
    job_root: Path,
    project_data_dir: Path,
) -> tuple[bool, str]:
    """Swap stage into the live direct-child RC folder with rollback on failure."""

    _validate_live_target(live_rc_dir, project_data_dir)
    _require_staged_rc_dir(stage_rc_dir, stage_rc_dir.parent)
    backup_dir = _direct_child(job_root, "previous", "previous reserving-class backup")
    if backup_dir.exists():
        raise ResQImportCommitError("The import job already has a previous-data backup folder.")
    if live_rc_dir.exists() and not live_rc_dir.is_dir():
        raise ResQImportCommitError("The live reserving-class target is not a directory.")

    moved_live = False
    try:
        if live_rc_dir.exists():
            live_rc_dir.rename(backup_dir)
            moved_live = True
        stage_rc_dir.rename(live_rc_dir)
    except Exception as exc:
        rollback_error: Exception | None = None
        if moved_live and backup_dir.exists() and not live_rc_dir.exists():
            try:
                backup_dir.rename(live_rc_dir)
            except Exception as rollback_exc:  # pragma: no cover - catastrophic filesystem state
                rollback_error = rollback_exc
        detail = "Could not commit staged ResQ import."
        if rollback_error is not None:
            detail += f" Rollback also failed: {rollback_error}"
        raise ResQImportCommitError(f"{detail} {exc}") from exc

    if not moved_live:
        return True, ""

    try:
        _remove_validated_tree(backup_dir, job_root)
    except Exception as exc:
        # The live folder has already been atomically replaced. Do not turn a
        # cleanup problem into an apparent rollback-safe failure: retain the
        # prior folder under this isolated job root and surface it to the
        # caller for later cleanup.
        return (
            False,
            "Import committed, but the previous reserving-class folder could not "
            f"be deleted and was retained in its Bridge staging backup: {exc}",
        )
    return True, ""


def _remove_job_root(job_root: Path, staging_parent: Path) -> None:
    if not job_root.exists():
        return
    _remove_validated_tree(job_root, staging_parent)


def _remove_validated_tree(path: Path, expected_parent: Path) -> None:
    parent = expected_parent.resolve(strict=False)
    target = path.resolve(strict=False)
    if target.parent != parent:
        raise ResQImportCommitError("Refusing to delete a path outside the validated import folder.")
    if target.is_symlink():
        raise ResQImportCommitError("Refusing to recursively delete a symlinked import path.")
    shutil.rmtree(target)


def _safe_progress_callback(callback: ProgressCallback | None) -> ProgressCallback | None:
    if callback is None:
        return None

    def forward(event: dict[str, Any]) -> None:
        _report_progress(callback, event)

    return forward


def _report_progress(callback: ProgressCallback | None, event: Mapping[str, Any]) -> None:
    if callback is None:
        return
    try:
        callback(_json_safe(dict(event)))
    except Exception:
        # Progress publication must not alter the import result.
        pass


def _json_safe(value: Any, depth: int = 0) -> Any:
    """Make status/progress values safe for Bridge JSON persistence."""

    if depth > 12:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, depth + 1) for item in value]
    if isinstance(value, set):
        return [_json_safe(item, depth + 1) for item in sorted(value, key=str)]
    return str(value)
