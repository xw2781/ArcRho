"""Run the canonical Arco/ResQ side-by-side review in the Bridge.

ResQ automation is reachable only where ResQ itself is installed, which is not
the machine most people run Arco on.  The review macro therefore owns no ResQ
session: it publishes a logical request to the shared queue and a
ResQ-connected Bridge worker runs the review here.

The Bridge owns no second copy of the comparison.  It loads
``validation/combined_side_by_side_review.py`` from the same frozen bundle
that serves ResQ imports and synchronizations, and calls its ``run_review``:
one call that reads both sides of one reserving class, writes the workbook,
and reports what needs attention.  Nothing is written back to Arco or ResQ.

The workbook is written where the person who asked for it can open it, under
their own folder in the project: ``<project>/users/<user>/reviews``.  Like the
other queues, the request carries logical identifiers only; the server root
and every folder under it are the Bridge's own.
"""
from __future__ import annotations

import importlib.util
import sys
import threading
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping

try:
    from src.arcrho_bridge.resq_import_runner import (
        ResQMigrationBundle,
        ResQMigrationBundleError,
        _json_safe,
        _project_name_from_request,
        _rc_path_from_request,
        _report_progress,
        _request_id_from_request,
        _required_text,
        configure_canonical_runtime,
        load_resq_data_migration,
    )
    from src.arcrho_bridge.resq_review_contract import (
        load_resq_reserving_class_review_contract,
    )
    from src.utils import get_project_root
except ModuleNotFoundError:  # Source-run Bridge entry point.
    from arcrho_bridge.resq_import_runner import (
        ResQMigrationBundle,
        ResQMigrationBundleError,
        _json_safe,
        _project_name_from_request,
        _rc_path_from_request,
        _report_progress,
        _request_id_from_request,
        _required_text,
        configure_canonical_runtime,
        load_resq_data_migration,
    )
    from arcrho_bridge.resq_review_contract import (
        load_resq_reserving_class_review_contract,
    )
    from utils import get_project_root


REVIEW_CONTRACT = load_resq_reserving_class_review_contract()

# The review API this Bridge was built against. A bundle that changed the
# result shape must not be driven by an older worker.
SUPPORTED_REVIEW_API_VERSION = 2

_REVIEW_MODULE_NAME = "_arcrho_bridge_combined_side_by_side_review"
_REVIEW_RELATIVE_PATH = Path("validation") / "combined_side_by_side_review.py"
_MODULE_LOAD_LOCK = threading.RLock()

REVIEWS_RELATIVE_DIR = Path("reviews")

ProgressCallback = Callable[[dict[str, Any]], None]


class ResQReviewRequestError(ValueError):
    """A shared-server review request contains an unsafe value."""


def run_reserving_class_review(
    request: Mapping[str, Any],
    progress_callback: ProgressCallback | None = None,
    *,
    resq_credentials: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run one queued review and return where its workbook was written.

    ``resq_credentials`` is the account the review connects to ResQ with; the
    Bridge passes its shared service account so the claiming worker's own
    Windows identity never decides which projects the review can see.
    """

    project_name = _project_name_from_request(request)
    rc_path = _rc_path_from_request(request)
    request_id = _request_id_from_request(request)
    requested_by = _required_text(request, "UserName")

    server_root = Path(get_project_root()).expanduser().resolve()
    bundle = configure_canonical_runtime(server_root)
    migration = load_resq_data_migration(bundle)
    review = load_review_module(bundle)

    workbook_path = review_workbook_path(server_root, project_name, rc_path, requested_by)
    completed = 0

    def report(message: object) -> None:
        nonlocal completed
        completed += 1
        _report_progress(
            progress_callback,
            {"message": str(message or "").strip(), "completed": completed, "total": 0},
        )

    # The migration module carries a default server root of its own, so the
    # Arco side of the comparison is pointed at this Bridge's workspace
    # before the review reads a single file.
    previous_scope = migration._apply_runtime_scope(project_name, server_root)
    try:
        result = review.run_review(
            project_name=project_name,
            rc_paths=[rc_path],
            output_path=workbook_path,
            credentials=dict(resq_credentials) if resq_credentials else None,
            progress=report,
        )
    finally:
        migration._restore_runtime_scope(previous_scope)
    # The waiting macro reaches the same file through its own server root,
    # which may be a mapped drive or a UNC alias. It is told where the
    # workbook sits under that root, never this worker's own absolute path.
    payload = dict(result)
    payload.pop("workbook_path", None)
    payload["workbook_relative_path"] = str(workbook_path.relative_to(server_root))
    return _json_safe(dict(payload, request_id=request_id, rc_path=rc_path, requested_by=requested_by))


def review_workbook_path(
    server_root: Path,
    project_name: str,
    rc_path: str,
    requested_by: str,
) -> Path:
    """Where this run's workbook is written, under the asking person's folder.

    One file per run rather than one per reserving class: a review is a dated
    observation, and the person comparing two runs of the same class needs
    both.
    """

    from arcrho_api.paths import project_dir_case_insensitive, sanitize_file_name_part

    project_dir = project_dir_case_insensitive(server_root / "projects", project_name)
    if project_dir is None:
        raise ResQReviewRequestError(
            f"Arco has no project folder named [{project_name}] under this server root."
        )
    leaf = sanitize_file_name_part(rc_path.split("\\")[-1], "reserving class")
    user = sanitize_file_name_part(requested_by, "unknown")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Built from the server root the caller passed, carrying only the project
    # folder's own spelling from the lookup, so the result is always under
    # that root and can be named relative to it for the waiting client.
    folder = Path(server_root) / "projects" / project_dir.name / "users" / user / REVIEWS_RELATIVE_DIR
    return folder / f"Side by side {leaf} {stamp}.xlsx"


def load_review_module(bundle: ResQMigrationBundle | None = None) -> ModuleType:
    """Load the canonical side-by-side review from this Bridge's bundle."""

    resolved = bundle or configure_canonical_runtime(get_project_root())
    path = review_module_path(resolved)
    with _MODULE_LOAD_LOCK:
        existing = sys.modules.get(_REVIEW_MODULE_NAME)
        if existing is not None:
            if Path(str(getattr(existing, "__file__", "") or "")).resolve() == path:
                return existing
            raise ResQMigrationBundleError(
                "A different Arco/ResQ review is already loaded in this Bridge process. "
                "Restart the Bridge worker before reviewing again."
            )
        spec = importlib.util.spec_from_file_location(_REVIEW_MODULE_NAME, path)
        if spec is None or spec.loader is None:
            raise ResQMigrationBundleError(
                f"Could not create an import specification for [{path}]."
            )
        module = importlib.util.module_from_spec(spec)
        sys.modules[_REVIEW_MODULE_NAME] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(_REVIEW_MODULE_NAME, None)
            raise
        _require_supported_review_api(module)
        return module


def review_module_path(bundle: ResQMigrationBundle) -> Path:
    """Return the frozen review inside the migration folder, or explain why not."""

    path = (bundle.migration_dir / _REVIEW_RELATIVE_PATH).resolve()
    if not path.is_file():
        raise ResQMigrationBundleError(
            "This Arco Bridge does not carry the canonical Arco/ResQ review "
            f"[{path}]. Rebuild and redeploy the Bridge."
        )
    return path


def _require_supported_review_api(module: ModuleType) -> None:
    version = getattr(module, "REVIEW_API_VERSION", None)
    if isinstance(version, bool) or not isinstance(version, int):
        raise ResQMigrationBundleError(
            "The canonical Arco/ResQ review does not declare its API version."
        )
    if version != SUPPORTED_REVIEW_API_VERSION:
        raise ResQMigrationBundleError(
            f"This Arco Bridge supports review API {SUPPORTED_REVIEW_API_VERSION}, but its "
            f"bundle provides {version}. Rebuild and redeploy the Bridge."
        )
