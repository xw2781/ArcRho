"""Run canonical ResQ reserving-class imports inside the Bridge worker.

The Bridge deliberately does not own a second set of migration writers.  It
loads the same ``resq_data_migration`` source bundle used by the direct
migration entry point, runs it in an isolated staging reserving-class folder,
then commits that staged folder into the live project file by file, only after
the ResQ portion has succeeded.  Every replaced or removed live file is moved
into the job's backup folder first, so a commit that fails part way still
restores the exact previous reserving-class contents.

The queue request contains logical identifiers only.  In particular, callers
cannot select a server root, staging path, or target folder: all of those are
derived from the Bridge's configured ArcRho Server root.
"""
from __future__ import annotations

import errno
import importlib
import importlib.util
import json
import os
import re
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping

from arcrho_engine_job_lease import (
    EngineJobLease,
    acquire_engine_job_lease,
    release_engine_job_lease,
    start_engine_job_lease_heartbeat,
    stop_engine_job_lease_heartbeat,
)

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
# The Bridge worker that runs an import is force-terminated by its own
# supervisor whenever the ResQ GUI disappears, and by the deploy kill switch.
# TerminateProcess runs no ``finally``, so an import lock that only ever
# unlinked on a clean exit blocked its reserving class forever. The lock is a
# heartbeat lease instead: a live import renews it, and a killed one expires.
# The window is shorter than a durable Engine job's because a person is waiting
# at the Import dialog for it to clear.
RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS = 5.0
RESQ_IMPORT_LOCK_STALE_SECONDS = 120.0
_MODULE_LOAD_LOCK = threading.RLock()
# Windows refuses to replace or delete a file that another process still holds
# open without FILE_SHARE_DELETE, and reports that as access denied (5),
# sharing violation (32), or lock violation (33).  The live reserving class is
# read continuously by the ArcRho app server and by virus scanners, so those
# short-lived readers must not discard a fully staged import.
_TRANSIENT_FOLDER_LOCK_WINERRORS = frozenset({5, 32, 33})
_COMMIT_RETRY_DELAYS = (0.1, 0.2, 0.4, 0.8, 1.5, 2.5)
_FOLDER_DELETE_RETRY_DELAYS = (0.1, 0.3, 0.6)
# Project data can live on a network share, where each file operation costs a
# round trip. Commit files with bounded parallelism instead of one at a time.
_COMMIT_MAX_WORKERS = 8

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
    *,
    resq_credentials: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run one logical Bridge import request through the canonical migration.

    The importer writes only below a request-specific staging folder.  The live
    reserving-class folder is swapped only after the ResQ stage completes and
    the canonical index has been rebuilt.  Engine failures are intentionally
    different: the staged engine component is discarded and the prior live
    engine component is copied into the staged result before the swap.

    ``resq_credentials`` is the account the migration connects to ResQ with;
    the Bridge passes its shared service account so the claiming worker's own
    Windows identity never decides which projects the import can see.
    """

    project_name = _project_name_from_request(request)
    rc_path = _rc_path_from_request(request)
    export_mode = _export_mode_from_request(request)
    import_policy = _import_policy_from_request(request)
    selected_names = _selected_names_from_request(request)
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
        lease = _acquire_target_lock(staging_parent, project_name, rc_path, request_id)
    except Exception:
        try:
            _remove_job_root(job_root, staging_parent)
        except Exception:
            # Preserve the original lock failure. The isolated job folder is
            # harmless and contains no live reserving-class data.
            pass
        raise
    heartbeat_stop, heartbeat_thread = start_engine_job_lease_heartbeat(
        lease,
        interval_seconds=RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        thread_name=f"arcrho-resq-import-lease-{request_id[:8]}",
    )
    committed = False
    commit_started = False
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

        connection = {}
        if resq_credentials:
            connection = {
                "connection_name": resq_credentials["connection_name"],
                "user_name": resq_credentials["user_name"],
                "password": resq_credentials["password"],
            }
        result = importer(
            project_name,
            rc_path,
            requested_by=str(request.get("UserName") or "").strip(),
            server_root=server_root,
            project_data_dir=stage_data_dir,
            export_mode=export_mode,
            selected_names=selected_names,
            cleanup_target=True,
            skip_unavailable_engine=True,
            progress_callback=_safe_progress_callback(progress_callback),
            verbose=False,
            **connection,
        )
        if not isinstance(result, Mapping):
            raise ResQMigrationBundleError(
                "The canonical ResQ migration returned a non-object result."
            )
        result = dict(result)
        skipped_source_items = _sanitize_import_errors(result)
        if skipped_source_items:
            _report_progress(
                progress_callback,
                {
                    "event": "activity",
                    "kind": "resq_skip",
                    "status": "warning",
                    "message": (
                        f"Skipped {skipped_source_items} ResQ item(s) that could not be "
                        "exported; any existing ArcRho copy of each is kept."
                    ),
                },
            )
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

        merge_result = _refresh_stage_contract(
            module,
            project_name,
            rc_path,
            server_root,
            stage_data_dir,
            target_rc_dir,
            stage_rc_dir,
            overwrite=import_policy == "overwrite",
            requested_names=selected_names,
        )
        preserved_groups = int(merge_result.get("groups") or 0)
        if preserved_groups:
            _report_progress(
                progress_callback,
                {
                    "event": "activity",
                    "kind": "arcrho_merge",
                    "status": "success",
                    "message": (
                        f"Retained {preserved_groups} ArcRho-only dataset/method group(s)."
                        if import_policy == "overwrite"
                        else f"Retained {preserved_groups} ArcRho-owned or newer "
                        "dataset/method group(s)."
                    ),
                },
            )
        _report_progress(
            progress_callback,
            {
                "event": "commit",
                "kind": "resq_import",
                "status": "processing",
                "message": "Committing the staged reserving-class import.",
            },
        )
        # From here the job root can hold the only copy of previous live files,
        # so it is no longer unconditionally disposable.
        commit_started = True
        previous_data_deleted, cleanup_warning = _commit_staged_rc(
            target_rc_dir,
            stage_rc_dir,
            job_root,
            project_data_dir,
            _canonical_index_file_name(module),
        )
        committed = True
        cleanup_job_root = previous_data_deleted

        result["engine_component_preserved"] = preserve_engine
        result["engine_artifacts_restored"] = restored_engine_artifacts
        result["import_policy"] = import_policy
        result["selection"] = _remember_import_selection(
            module,
            project_name,
            rc_path,
            server_root,
            selected_names,
            str(request.get("UserName") or "").strip(),
            str(connection.get("connection_name") or ""),
        )
        result["arcrho_groups_preserved"] = preserved_groups
        result["arcrho_artifacts_preserved"] = int(merge_result.get("files") or 0)
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
        stop_engine_job_lease_heartbeat(
            heartbeat_stop,
            heartbeat_thread,
            interval_seconds=RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        )
        release_engine_job_lease(lease)
        # A staged tree is disposable until the commit starts moving live files
        # aside. Once it has, the job's backup folder may be the only copy of
        # the previous reserving class, so it is kept for the operator unless
        # the commit finished and already deleted that backup itself.
        if (not commit_started) or (committed and cleanup_job_root):
            try:
                _remove_job_root(job_root, staging_parent)
            except Exception:
                # The live commit is already durable. A leftover empty staging
                # folder must not make the Bridge report that committed data
                # was safely rolled back.
                pass


def discard_abandoned_import_job(
    request_id: str,
    server_root: str | os.PathLike[str] | None = None,
) -> bool:
    """Delete one interrupted import's staged folder, never its backup.

    A worker killed mid-import runs no ``finally``, so its staged reserving
    class survives in the staging area. That copy is disposable, but the same
    job folder holds ``previous/`` once a commit has started moving live files
    aside, and that backup can be the only remaining copy of the reserving
    class. A job folder that has one is therefore reported, not removed.
    Returns whether a staged folder was deleted.
    """

    root = Path(server_root) if server_root is not None else Path(get_project_root())
    staging_parent = _import_staging_parent(root.expanduser().resolve())
    if not staging_parent.is_dir():
        return False
    job_root = _direct_child(staging_parent, request_id, "ResQ import job folder")
    if not job_root.is_dir() or job_root.is_symlink():
        return False
    if (job_root / "previous").exists():
        return False
    _remove_job_root(job_root, staging_parent)
    return True


def _source_repo_root() -> Path:
    # .../server-components/src/arcrho_bridge/resq_import_runner.py -> repository root
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
        bundle.python_api_src / "arcrho_api" / "engine_dataset_sidecar_contract.py",
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


def _selected_names_from_request(request: Mapping[str, Any]) -> list[str] | None:
    """The ticked dataset and method output names, or ``None`` for the whole class.

    The field is optional, so a request that names nothing still imports
    everything ResQ offers, which is what every import did before the review
    table let a person choose.
    """

    if not isinstance(request, Mapping):
        raise ResQImportRequestError("The ResQ import request must be a JSON object.")
    field = load_resq_reserving_class_import_contract()["selection_names_field"]
    names = request.get(field)
    if names is None:
        return None
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ResQImportRequestError(f"{field} must be a list of item names.")
    return [name.strip() for name in names if name.strip()]


def _import_policy_from_request(request: Mapping[str, Any]) -> str:
    """Return the request's merge/overwrite policy; absent means merge.

    The field is optional so a request written by an older client stays valid
    and keeps today's merge behavior.
    """

    if not isinstance(request, Mapping):
        raise ResQImportRequestError("The ResQ import request must be a JSON object.")
    raw = request.get("ImportPolicy")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return "merge"
    value = str(raw).strip().casefold() if isinstance(raw, str) else ""
    contract = load_resq_reserving_class_import_contract()
    policies = contract.get("allowed_import_policies")
    allowed = (
        frozenset(str(item).strip().casefold() for item in policies if str(item).strip())
        if isinstance(policies, tuple)
        else frozenset()
    )
    if not allowed:
        raise ResQMigrationBundleError("The ResQ import contract has no usable import policies.")
    if value not in allowed:
        raise ResQImportRequestError(
            "ImportPolicy must be one of: " + ", ".join(sorted(allowed)) + "."
        )
    return value


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


def _canonical_index_file_name(module: ModuleType) -> str:
    """Read the index file name from the canonical bundle instead of assuming it."""

    name = str(getattr(module, "INDEX_FILE_NAME", "") or "").strip()
    if not name or name in {".", ".."} or Path(name).name != name:
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle does not expose a safe index file name."
        )
    return name


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
) -> EngineJobLease:
    """Take the reserving class's import lease, recovering an expired one.

    Delegates to the canonical durable-job lease so the Bridge does not own a
    second lock implementation; only the staleness window is import-specific.
    """

    lock_dir = _direct_child(staging_parent, _IMPORT_LOCK_DIR_NAME, "ResQ import lock folder")
    lock_dir.mkdir(parents=True, exist_ok=True)
    if lock_dir.is_symlink():
        raise ResQImportCommitError("Refusing to use a symlinked ResQ import lock folder.")
    lock_path = _direct_child(lock_dir, _lock_file_name(project_name, rc_path), "ResQ import lock")
    lease = acquire_engine_job_lease(
        lock_path,
        stale_seconds=RESQ_IMPORT_LOCK_STALE_SECONDS,
        payload_fields={"request_id": request_id},
    )
    if lease is None:
        raise ResQImportCommitError(
            "Another ResQ import is already processing this reserving class. "
            "If that import was interrupted, its claim clears within "
            f"{int(RESQ_IMPORT_LOCK_STALE_SECONDS)} seconds."
        )
    return lease


def _require_staged_rc_dir(stage_rc_dir: Path, stage_data_dir: Path) -> None:
    if stage_rc_dir.parent != stage_data_dir.resolve(strict=False):
        raise ResQImportCommitError("The staged reserving-class folder escaped staged project data.")
    if not stage_rc_dir.is_dir() or stage_rc_dir.is_symlink():
        raise ResQImportCommitError("The canonical import produced no safe staged reserving-class folder.")


def _sanitize_import_errors(result: dict[str, Any]) -> int:
    """Validate error counts, redact detail messages, and return the non-engine count.

    An item the export could not read is skipped by the canonical migration —
    its staged files are simply absent — and the ArcRho-only merge overlay
    keeps any existing live copy of it under both import policies. The commit
    therefore proceeds; the bounded, redacted details stay in the result so the
    operator sees which items were skipped and why.
    """

    errors = _non_negative_int(result.get("errors"), "errors")
    engine_errors = _non_negative_int(result.get("engine_errors"), "engine_errors")
    if engine_errors > errors:
        raise ResQMigrationBundleError("The canonical import reported more engine errors than total errors.")
    result["error_details"] = _sanitized_error_details(result.get("error_details"))
    result["engine_parity_warnings"] = _sanitized_error_details(result.get("engine_parity_warnings"))
    return errors - engine_errors


def _sanitized_error_details(details: Any) -> list[dict[str, str]]:
    """Project bounded import diagnostics into the location-independent status contract."""

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
    return safe_details


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


def _remember_import_selection(
    module: ModuleType,
    project_name: str,
    rc_path: str,
    server_root: Path,
    selected_names: list[str] | None,
    requested_by: str,
    connection_name: str,
) -> dict[str, object]:
    """Save what this import covered as the next import's default.

    Nothing is saved for an import that named no selection: it covered the
    whole reserving class, which is what an empty saved list already means.
    The commit is durable by the time this runs, so a document that cannot be
    written is reported beside the result rather than failing the import.
    """

    if selected_names is None:
        return {"saved": 0, "path": "", "error": ""}
    recorder = getattr(module, "record_import_selection", None)
    if not callable(recorder):
        raise ResQMigrationBundleError(
            "The deployed ResQ migration bundle does not expose record_import_selection()."
        )
    arguments: dict[str, object] = {
        "server_root": server_root,
        "names": selected_names,
        "requested_by": requested_by,
    }
    if connection_name:
        # The document is scoped by connection, so it must be the one the
        # transfer review read it under, not the migration module's default.
        arguments["connection_name"] = connection_name
    try:
        path = recorder(project_name, rc_path, **arguments)
    except Exception as exc:
        return {"saved": 0, "path": "", "error": f"The selection could not be saved: {exc}"}
    return {"saved": len(selected_names), "path": str(path), "error": ""}


def _refresh_stage_contract(
    module: ModuleType,
    project_name: str,
    rc_path: str,
    server_root: Path,
    stage_data_dir: Path,
    live_rc_dir: Path,
    stage_rc_dir: Path,
    *,
    overwrite: bool = False,
    requested_names: list[str] | None = None,
) -> dict[str, object]:
    apply_scope = getattr(module, "_apply_runtime_scope", None)
    restore_scope = getattr(module, "_restore_runtime_scope", None)
    refresh_graphs = getattr(module, "refresh_sidecar_graphs_for_rc", None)
    rebuild_index = getattr(module, "rebuild_dataset_instance_index", None)
    merge_artifacts = getattr(module, "merge_preserved_arcrho_artifacts", None)
    if not all(
        callable(item)
        for item in (apply_scope, restore_scope, refresh_graphs, rebuild_index, merge_artifacts)
    ):
        raise ResQMigrationBundleError(
            "The canonical ResQ migration bundle does not expose required merge/graph/index helpers."
        )
    previous_scope = apply_scope(project_name, server_root, stage_data_dir)
    try:
        merge_result = merge_artifacts(
            live_rc_dir,
            stage_rc_dir,
            overwrite=overwrite,
            requested_names=requested_names,
        )
        if not isinstance(merge_result, Mapping):
            raise ResQMigrationBundleError("The canonical ArcRho merge returned a non-object result.")
        refresh_graphs(stage_rc_dir)
        rebuild_index(project_name, rc_path, stage_rc_dir)
        return dict(merge_result)
    finally:
        restore_scope(previous_scope)


def _commit_staged_rc(
    live_rc_dir: Path,
    stage_rc_dir: Path,
    job_root: Path,
    project_data_dir: Path,
    index_file_name: str,
) -> tuple[bool, str]:
    """Make the live RC folder identical to the staged folder, reversibly.

    The commit never renames the reserving-class folder itself. Windows refuses
    a folder rename while *any* file below it is open, so one unrelated reader
    could discard a finished import. Committing file by file narrows that to
    the single file a reader actually holds, and every replaced or removed live
    file is moved into this job's backup folder first, so a failure anywhere
    still restores the exact previous folder contents.
    """

    _validate_live_target(live_rc_dir, project_data_dir)
    _require_staged_rc_dir(stage_rc_dir, stage_rc_dir.parent)
    backup_dir = _direct_child(job_root, "previous", "previous reserving-class backup")
    if backup_dir.exists():
        raise ResQImportCommitError("The import job already has a previous-data backup folder.")
    if live_rc_dir.exists() and not live_rc_dir.is_dir():
        raise ResQImportCommitError("The live reserving-class target is not a directory.")

    staged_files = _relative_commit_files(stage_rc_dir, index_file_name)
    live_files = _relative_commit_files(live_rc_dir, index_file_name)
    index_key = index_file_name.casefold()
    if index_key not in staged_files:
        raise ResQImportCommitError(
            "The staged reserving class has no canonical index; refusing to commit it."
        )
    installs = sorted(name for key, name in staged_files.items() if key != index_key)
    removals = sorted(name for key, name in live_files.items() if key not in staged_files)

    journal = _CommitJournal()
    try:
        _apply_commit_plan(
            installs,
            removals,
            live_rc_dir=live_rc_dir,
            stage_rc_dir=stage_rc_dir,
            backup_dir=backup_dir,
            journal=journal,
        )
        # The index is the folder's published summary, so it flips to the new
        # truth only once every file it describes is already in place.
        _install_commit_file(
            staged_files[index_key],
            live_rc_dir=live_rc_dir,
            stage_rc_dir=stage_rc_dir,
            backup_dir=backup_dir,
            journal=journal,
        )
    except Exception as exc:
        restore_errors = journal.rollback()
        detail = "Could not commit staged ResQ import."
        if _is_transient_folder_lock_error(exc):
            detail += (
                " A reserving-class file is still open in another program."
                " Close it in ArcRho, Excel, or Windows Explorer and import again."
            )
        if restore_errors:
            detail += (
                f" Rollback also failed for {len(restore_errors)} file(s); the previous"
                f" contents were retained in the Bridge staging backup: {restore_errors[0]}"
            )
        else:
            detail += " The live reserving class was restored to its previous contents."
        raise ResQImportCommitError(f"{detail} {exc}") from exc

    if not journal.has_backups():
        return True, ""

    try:
        _remove_validated_tree(backup_dir, job_root)
    except Exception as exc:
        # The live folder is already committed. Do not turn a cleanup problem
        # into an apparent rollback-safe failure: retain the prior files under
        # this isolated job root and surface it to the caller for later cleanup.
        return (
            False,
            "Import committed, but the previous reserving-class files could not "
            f"be deleted and were retained in the Bridge staging backup: {exc}",
        )
    return True, ""


class _CommitJournal:
    """Ordered record of live files moved aside so a failed commit can undo."""

    def __init__(self) -> None:
        self._entries: list[tuple[Path, Path | None]] = []
        self._guard = threading.Lock()

    def record(self, live_path: Path, backup_path: Path | None) -> None:
        with self._guard:
            self._entries.append((live_path, backup_path))

    def has_backups(self) -> bool:
        with self._guard:
            return any(backup is not None for _live, backup in self._entries)

    def rollback(self) -> list[str]:
        """Undo every recorded change; return one message per file left wrong."""

        with self._guard:
            entries = list(self._entries)
            self._entries.clear()
        errors: list[str] = []
        for live_path, backup_path in reversed(entries):
            try:
                if live_path.exists():
                    _retry_transient_folder_operation(
                        live_path.unlink,
                        _COMMIT_RETRY_DELAYS,
                    )
                if backup_path is not None:
                    _replace_path(backup_path, live_path)
            except OSError as exc:
                errors.append(f"[{live_path.name}]: {exc}")
        return errors


def _apply_commit_plan(
    installs: list[str],
    removals: list[str],
    *,
    live_rc_dir: Path,
    stage_rc_dir: Path,
    backup_dir: Path,
    journal: _CommitJournal,
) -> None:
    """Install and remove reserving-class files with bounded parallel I/O."""

    def install(name: str) -> None:
        _install_commit_file(
            name,
            live_rc_dir=live_rc_dir,
            stage_rc_dir=stage_rc_dir,
            backup_dir=backup_dir,
            journal=journal,
        )

    def remove(name: str) -> None:
        live_path = live_rc_dir / name
        backup_path = backup_dir / name
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        _replace_path(live_path, backup_path)
        journal.record(live_path, backup_path)

    tasks = [(install, name) for name in installs] + [(remove, name) for name in removals]
    if not tasks:
        return
    workers = min(_COMMIT_MAX_WORKERS, len(tasks))
    failures: list[BaseException] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(action, name) for action, name in tasks]
        # Let every task settle before deciding: the journal must be complete
        # before a rollback can restore the previous folder contents.
        for future in futures:
            error = future.exception()
            if error is not None:
                failures.append(error)
    if failures:
        raise failures[0]


def _install_commit_file(
    name: str,
    *,
    live_rc_dir: Path,
    stage_rc_dir: Path,
    backup_dir: Path,
    journal: _CommitJournal,
) -> None:
    stage_path = stage_rc_dir / name
    live_path = live_rc_dir / name
    if live_path.exists():
        backup_path = backup_dir / name
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        _replace_path(live_path, backup_path)
        journal.record(live_path, backup_path)
    else:
        journal.record(live_path, None)
    live_path.parent.mkdir(parents=True, exist_ok=True)
    _replace_path(stage_path, live_path)


def _relative_commit_files(root: Path, index_file_name: str) -> dict[str, str]:
    """Map casefolded relative path -> relative path for every committable file."""

    if not root.is_dir():
        return {}
    lock_name = f".{index_file_name}.lock".casefold()
    files: dict[str, str] = {}
    try:
        candidates = sorted(root.rglob("*"), key=lambda path: str(path).casefold())
    except OSError as exc:
        raise ResQImportCommitError(f"Could not enumerate reserving-class files: {exc}") from exc
    for path in candidates:
        if path.is_symlink():
            raise ResQImportCommitError(
                f"Refusing to commit a symlinked reserving-class path [{path.name}]."
            )
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        # The index update lock is owned by whichever process holds it, not by
        # the reserving-class contents, so a commit never moves or deletes it.
        if len(relative.parts) == 1 and relative.name.casefold() == lock_name:
            continue
        files[str(relative).casefold()] = str(relative)
    return files


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
    _retry_transient_folder_operation(
        lambda: shutil.rmtree(target),
        _FOLDER_DELETE_RETRY_DELAYS,
    )


def _replace_path(source: Path, destination: Path) -> None:
    """Move one file into place, waiting out transient reader handles.

    The live reserving class is read by the ArcRho app server, the engine, and
    desktop virus scanners while an import runs. Those readers open files
    without ``FILE_SHARE_DELETE``, so Windows can refuse the move for the few
    milliseconds one of them holds a sidecar or CSV open. A fully staged import
    must not be discarded for a handle that closes on its own.
    """

    _retry_transient_folder_operation(
        lambda: os.replace(source, destination),
        _COMMIT_RETRY_DELAYS,
    )


def _retry_transient_folder_operation(
    operation: Callable[[], Any],
    delays: tuple[float, ...],
) -> None:
    for delay in (*delays, None):
        try:
            operation()
            return
        except OSError as error:
            if delay is None or not _is_transient_folder_lock_error(error):
                raise
            time.sleep(delay)


def _is_transient_folder_lock_error(error: BaseException) -> bool:
    if not isinstance(error, OSError):
        return False
    winerror = getattr(error, "winerror", None)
    if winerror is not None:
        return winerror in _TRANSIENT_FOLDER_LOCK_WINERRORS
    # Non-Windows Bridge hosts surface the same contention as EACCES/EBUSY.
    return isinstance(error, PermissionError) or error.errno == errno.EBUSY


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
