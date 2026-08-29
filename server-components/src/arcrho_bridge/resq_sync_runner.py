"""Run canonical ArcRho/ResQ reserving-class synchronizations in the Bridge.

ResQ automation is reachable only where ResQ itself is installed, which is not
the machine most people run ArcRho on.  The synchronization macro therefore
owns no ResQ session at all: it publishes a logical request to the shared queue
and a ResQ-connected Bridge worker runs the session here.

The Bridge owns no second copy of the synchronization rules.  It loads
``resq_migration.sync_session`` from the same frozen bundle that serves ResQ
imports, and runs its two phases:

``preview``
    Read-only.  Returns the review rows and the signature of each observation.

``transfer_preview``
    Read-only.  The whole-class review the Import and Export macros share:
    every dataset and method output either side holds, what the named
    direction would do to it, and the selection the last run in that direction
    saved.

``apply``
    Takes the reserving class's job lease -- the same lease a ResQ import takes,
    so a synchronization and an import can never write one reserving class at
    the same time -- rechecks the reviewed signatures, and writes only when
    every one of them still matches.

``export``
    Takes the same lease and pushes the reserving class from ArcRho into ResQ
    in dependency order -- everything it supports, or the names the transfer
    review ticked -- and remembers that selection for the next export.

Like the import queue, the request carries logical identifiers only: the server
root, queue folders, and status path are all derived from the Bridge's own
configuration.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping

from arcrho_engine_job_lease import (
    release_engine_job_lease,
    start_engine_job_lease_heartbeat,
    stop_engine_job_lease_heartbeat,
)

try:
    from src.arcrho_bridge.resq_import_runner import (
        RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        ResQMigrationBundle,
        ResQMigrationBundleError,
        _acquire_target_lock,
        _import_staging_parent,
        _json_safe,
        _project_name_from_request,
        _rc_path_from_request,
        _report_progress,
        _request_id_from_request,
        _required_text,
        configure_canonical_runtime,
        load_resq_data_migration,
    )
    from src.arcrho_bridge.resq_sync_contract import (
        load_resq_reserving_class_sync_contract,
    )
    from src.utils import get_project_root
except ModuleNotFoundError:  # Source-run Bridge entry point.
    from arcrho_bridge.resq_import_runner import (
        RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        ResQMigrationBundle,
        ResQMigrationBundleError,
        _acquire_target_lock,
        _import_staging_parent,
        _json_safe,
        _project_name_from_request,
        _rc_path_from_request,
        _report_progress,
        _request_id_from_request,
        _required_text,
        configure_canonical_runtime,
        load_resq_data_migration,
    )
    from arcrho_bridge.resq_sync_contract import (
        load_resq_reserving_class_sync_contract,
    )
    from utils import get_project_root


SYNC_CONTRACT = load_resq_reserving_class_sync_contract()
ALLOWED_PHASES = frozenset(SYNC_CONTRACT["allowed_phases"])
ALLOWED_DIRECTIONS = frozenset(SYNC_CONTRACT["allowed_directions"])
SELECTION_FIELD = SYNC_CONTRACT["selection_field"]
SELECTION_NAMES_FIELD = SYNC_CONTRACT["selection_names_field"]
DIRECTION_FIELD = SYNC_CONTRACT["direction_field"]

# The session API this Bridge was built against. A bundle that changed the
# contract must not be driven by an older worker.
SUPPORTED_SYNC_SESSION_API_VERSION = 4

_SESSION_MODULE_NAME = "resq_migration.sync_session"
_EXPORTER_MODULE_NAME = "_arcrho_bridge_resq_sync_exporter"
_EXPORTER_RELATIVE_PATH = Path("macros") / "export_reserving_class_to_resq.py"
_MODULE_LOAD_LOCK = threading.RLock()

ProgressCallback = Callable[[dict[str, Any]], None]


class ResQSyncRequestError(ValueError):
    """A shared-server synchronization request contains an unsafe value."""


def run_reserving_class_sync(
    request: Mapping[str, Any],
    progress_callback: ProgressCallback | None = None,
    *,
    resq_credentials: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run one logical Bridge synchronization request through the canonical session.

    ``resq_credentials`` is the account the session connects to ResQ with; the
    Bridge passes its shared service account so the claiming worker's own
    Windows identity never decides which projects the session can see.
    """

    phase = _phase_from_request(request)
    project_name = _project_name_from_request(request)
    rc_path = _rc_path_from_request(request)
    request_id = _request_id_from_request(request)
    reviewed_rows = _reviewed_rows_from_request(request) if phase == "apply" else []
    selected_names = _selected_names_from_request(request)
    requested_by = str(request.get("UserName") or "").strip()

    server_root = Path(get_project_root()).expanduser().resolve()
    bundle = configure_canonical_runtime(server_root)
    migration = load_resq_data_migration(bundle)
    session = load_sync_session(bundle)
    exporter_module = load_sync_exporter(bundle)
    runtime = session.build_runtime(migration, exporter_module, resq_credentials=resq_credentials)

    def report(event: Mapping[str, Any]) -> None:
        _report_progress(progress_callback, event)

    if phase == "preview":
        result = session.preview_sync(
            runtime,
            project_name,
            rc_path,
            server_root=server_root,
            progress_callback=report,
        )
        return _json_safe(dict(result, phase=phase))

    if phase == "transfer_preview":
        result = session.preview_transfer(
            runtime,
            project_name,
            rc_path,
            direction=_direction_from_request(request),
            server_root=server_root,
            progress_callback=report,
        )
        return _json_safe(dict(result, phase=phase))

    # Only a writing phase competes for the reserving class. A preview is
    # read-only and must never block an import that is already running.
    lease = _acquire_target_lock(
        _import_staging_parent(server_root),
        project_name,
        rc_path,
        request_id,
    )
    heartbeat_stop, heartbeat_thread = start_engine_job_lease_heartbeat(
        lease,
        interval_seconds=RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        thread_name=f"arcrho-resq-sync-lease-{request_id[:8]}",
    )
    try:
        if phase == "apply":
            result = session.apply_sync(
                runtime,
                project_name,
                rc_path,
                server_root=server_root,
                reviewed_rows=reviewed_rows,
                progress_callback=report,
            )
        else:
            result = session.export_reserving_class(
                runtime,
                project_name,
                rc_path,
                server_root=server_root,
                selected_names=selected_names,
                requested_by=requested_by,
                progress_callback=report,
            )
        return _json_safe(dict(result, phase=phase))
    finally:
        stop_engine_job_lease_heartbeat(
            heartbeat_stop,
            heartbeat_thread,
            interval_seconds=RESQ_IMPORT_LOCK_HEARTBEAT_SECONDS,
        )
        release_engine_job_lease(lease)


def load_sync_session(bundle: ResQMigrationBundle | None = None) -> ModuleType:
    """Import the canonical synchronization session from this Bridge's bundle."""

    resolved = bundle or configure_canonical_runtime(get_project_root())
    with _MODULE_LOAD_LOCK:
        module = sys.modules.get(_SESSION_MODULE_NAME)
        if module is None:
            # ``load_resq_data_migration`` puts the bundle's migration folder on
            # the import path and rejects a foreign ``resq_migration`` package,
            # so importing by name here cannot reach a developer checkout.
            load_resq_data_migration(resolved)
            module = importlib.import_module(_SESSION_MODULE_NAME)
        _require_bundle_module(module, resolved.migration_dir)
        _require_supported_session_api(module)
        return module


def load_sync_exporter(bundle: ResQMigrationBundle | None = None) -> ModuleType:
    """Load the canonical ResQ exporter this Bridge froze beside its migration."""

    resolved = bundle or configure_canonical_runtime(get_project_root())
    path = sync_exporter_path(resolved)
    with _MODULE_LOAD_LOCK:
        existing = sys.modules.get(_EXPORTER_MODULE_NAME)
        if existing is not None:
            if Path(str(getattr(existing, "__file__", "") or "")).resolve() == path:
                return existing
            raise ResQMigrationBundleError(
                "A different ResQ exporter is already loaded in this Bridge process. "
                "Restart the Bridge worker before synchronizing again."
            )
        spec = importlib.util.spec_from_file_location(_EXPORTER_MODULE_NAME, path)
        if spec is None or spec.loader is None:
            raise ResQMigrationBundleError(
                f"Could not create an import specification for [{path}]."
            )
        module = importlib.util.module_from_spec(spec)
        sys.modules[_EXPORTER_MODULE_NAME] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(_EXPORTER_MODULE_NAME, None)
            raise
        return module


def sync_exporter_path(bundle: ResQMigrationBundle) -> Path:
    """Return the frozen exporter beside the migration folder, or explain why not."""

    path = (bundle.migration_dir.parent / _EXPORTER_RELATIVE_PATH).resolve()
    if not path.is_file():
        raise ResQMigrationBundleError(
            "This ArcRho Bridge does not carry the canonical ResQ exporter "
            f"[{path}]. Rebuild and redeploy the Bridge."
        )
    return path


def _require_bundle_module(module: ModuleType, migration_dir: Path) -> None:
    loaded = str(getattr(module, "__file__", "") or "").strip()
    try:
        coherent = bool(loaded) and Path(loaded).resolve().is_relative_to(migration_dir.resolve())
    except (OSError, RuntimeError, ValueError):
        coherent = False
    if not coherent:
        raise ResQMigrationBundleError(
            f"Loaded {module.__name__} from outside this Bridge's canonical bundle: "
            f"{loaded or '<unknown>'}"
        )


def _require_supported_session_api(module: ModuleType) -> None:
    version = getattr(module, "SYNC_SESSION_API_VERSION", None)
    if isinstance(version, bool) or not isinstance(version, int):
        raise ResQMigrationBundleError(
            "The canonical synchronization session does not declare its API version."
        )
    if version != SUPPORTED_SYNC_SESSION_API_VERSION:
        raise ResQMigrationBundleError(
            f"This ArcRho Bridge supports synchronization session API "
            f"{SUPPORTED_SYNC_SESSION_API_VERSION}, but its bundle provides {version}. "
            "Rebuild and redeploy the Bridge."
        )


def _phase_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, "Phase").casefold()
    if value not in ALLOWED_PHASES:
        raise ResQSyncRequestError(
            "Phase must be one of: " + ", ".join(sorted(ALLOWED_PHASES)) + "."
        )
    return value


def _direction_from_request(request: Mapping[str, Any]) -> str:
    value = _required_text(request, DIRECTION_FIELD).casefold()
    if value not in ALLOWED_DIRECTIONS:
        raise ResQSyncRequestError(
            f"{DIRECTION_FIELD} must be one of: " + ", ".join(sorted(ALLOWED_DIRECTIONS)) + "."
        )
    return value


def _selected_names_from_request(request: Mapping[str, Any]) -> list[str] | None:
    """The ticked dataset and method output names, or ``None`` for the whole class.

    The field is absent when a caller wants everything, which is what a run
    started before selection existed asked for.
    """

    names = request.get(SELECTION_NAMES_FIELD)
    if names is None:
        return None
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ResQSyncRequestError(f"{SELECTION_NAMES_FIELD} must be a list of item names.")
    return [name.strip() for name in names if name.strip()]


def _reviewed_rows_from_request(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the accepted rows exactly as the preview phase reported them.

    The signature is the observation the person reviewed. It is echoed back
    rather than recomputed here, which is what lets the apply phase refuse to
    write when anything moved while the review table was open.
    """

    if not isinstance(request, Mapping):
        raise ResQSyncRequestError("The ResQ synchronization request must be a JSON object.")
    rows = request.get(SELECTION_FIELD)
    if not isinstance(rows, list) or not rows:
        raise ResQSyncRequestError(
            f"{SELECTION_FIELD} must list the accepted review rows for an apply request."
        )
    reviewed: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            raise ResQSyncRequestError(f"Every {SELECTION_FIELD} entry must be a JSON object.")
        row_id = str(row.get("Id") or "").strip()
        signature = row.get("Signature")
        if not row_id:
            raise ResQSyncRequestError(f"Every {SELECTION_FIELD} entry must carry its row ID.")
        if not isinstance(signature, Mapping):
            raise ResQSyncRequestError(
                f"Every {SELECTION_FIELD} entry must carry the reviewed row signature."
            )
        if row_id in seen:
            continue
        seen.add(row_id)
        reviewed.append({"id": row_id, "signature": dict(signature), "name": str(row.get("Name") or "").strip()})
    return reviewed
