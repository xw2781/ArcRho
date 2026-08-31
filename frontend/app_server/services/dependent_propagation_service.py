"""Submit and poll Engine-hosted dependent-propagation jobs.

The client never runs the dependent cascade itself: every save flow calls
:func:`require_reserving_class_writable` before writing anything (live-Engine
heartbeat plus the reserving-class hold probe), writes the saved object, then
enqueues one propagation job through :func:`enqueue_save_propagation`. ArcRho
Engine executes the canonical walk on the server host and publishes
progress/terminal status that :func:`get_dependent_propagation_status`
validates for the UI poller; :func:`get_reserving_class_busy` exposes the hold
to UI pages that freeze their editing surface while a class is rewritten.
"""

from __future__ import annotations

import contextvars
import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Sequence

from fastapi import HTTPException

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    ENGINE_UNAVAILABLE_MESSAGE,
    EngineUnavailableError,
    build_dependent_propagation_request,
    dependent_propagation_request_path,
    dependent_propagation_status_path,
    find_any_reserving_class_propagation_hold,
    find_project_scope_propagation_hold,
    find_reserving_class_propagation_hold,
    require_live_engine,
    validate_dependent_propagation_status,
    validate_request_id,
    write_dependent_propagation_status,
    write_json_atomic,
)
from arcrho_project_duplication_contract import path_is_link_or_reparse

from app_server import config
from app_server.services import user_identity_service


_PROTOCOL_PATH_VALIDATION_CACHE_SECONDS = 30.0
_protocol_path_validation_cache: Dict[str, float] = {}
_protocol_path_validation_cache_lock = threading.Lock()


def _elapsed_ms(started_ns: int) -> float:
    return round((time.perf_counter_ns() - started_ns) / 1_000_000.0, 3)


def _record_latency(
    timings: Dict[str, float] | None,
    key: str,
    started_ns: int,
) -> None:
    if timings is not None:
        timings[key] = _elapsed_ms(started_ns)


def _protocol_path_cache_key(server_root: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(server_root)))


def _protocol_paths_are_cached(server_root: Path) -> bool:
    key = _protocol_path_cache_key(server_root)
    now = time.monotonic()
    with _protocol_path_validation_cache_lock:
        validated_at = _protocol_path_validation_cache.get(key)
        if validated_at is None:
            return False
        if now - validated_at <= _PROTOCOL_PATH_VALIDATION_CACHE_SECONDS:
            return True
        _protocol_path_validation_cache.pop(key, None)
    return False


def _cache_protocol_paths(server_root: Path) -> None:
    with _protocol_path_validation_cache_lock:
        _protocol_path_validation_cache[_protocol_path_cache_key(server_root)] = (
            time.monotonic()
        )


def _invalidate_protocol_path_cache(server_root: Path) -> None:
    with _protocol_path_validation_cache_lock:
        _protocol_path_validation_cache.pop(
            _protocol_path_cache_key(server_root),
            None,
        )


def _clear_protocol_path_validation_cache() -> None:
    """Clear successful path checks; exposed for deterministic tests."""

    with _protocol_path_validation_cache_lock:
        _protocol_path_validation_cache.clear()


def _workspace_server_root(
    *,
    timings: Dict[str, float] | None = None,
    timing_prefix: str = "workspace",
) -> Path:
    started = time.perf_counter_ns()
    try:
        workspace = config.load_workspace_paths()
    finally:
        _record_latency(timings, f"{timing_prefix}_config_load_ms", started)
    server_root_value = str(workspace.get("workspace_root") or "").strip()
    if not server_root_value:
        raise HTTPException(500, "The ArcRho Server workspace is not configured.")
    server_root = Path(server_root_value).expanduser()
    if not server_root.is_absolute():
        raise HTTPException(500, "The ArcRho Server workspace root must be absolute.")
    started = time.perf_counter_ns()
    try:
        root_available = server_root.is_dir()
    except OSError as error:
        _invalidate_protocol_path_cache(server_root)
        _record_latency(timings, f"{timing_prefix}_root_access_ms", started)
        raise HTTPException(
            500, "The ArcRho Server workspace root is inaccessible."
        ) from error
    _record_latency(timings, f"{timing_prefix}_root_access_ms", started)
    if not root_available:
        _invalidate_protocol_path_cache(server_root)
        raise HTTPException(500, "The ArcRho Server workspace root is unavailable.")
    _validate_protocol_paths(
        server_root,
        timings=timings,
        timing_prefix=timing_prefix,
    )
    return server_root


def _validate_protocol_paths(
    server_root: Path,
    *,
    timings: Dict[str, float] | None = None,
    timing_prefix: str = "workspace",
) -> None:
    total_started = time.perf_counter_ns()
    cache_started = time.perf_counter_ns()
    if _protocol_paths_are_cached(server_root):
        _record_latency(
            timings,
            f"{timing_prefix}_protocol_cached_validation_ms",
            cache_started,
        )
        _record_latency(
            timings,
            f"{timing_prefix}_protocol_validation_ms",
            total_started,
        )
        return

    current = server_root
    checks = []
    for label, part in (
        ("requests_root", "requests"),
        ("propagation_root", "dependent_propagation"),
    ):
        current /= part
        checks.append((label, current))
    for leaf in ("requests", "statuses", "locks"):
        checks.append((f"propagation_{leaf}", current / leaf))
    try:
        for label, path in checks:
            started = time.perf_counter_ns()
            try:
                _reject_linked_path(path)
            finally:
                _record_latency(
                    timings,
                    f"{timing_prefix}_protocol_{label}_ms",
                    started,
                )
        _cache_protocol_paths(server_root)
    except Exception:
        _invalidate_protocol_path_cache(server_root)
        raise
    finally:
        _record_latency(
            timings,
            f"{timing_prefix}_protocol_validation_ms",
            total_started,
        )


def _reject_linked_path(path: Path) -> None:
    try:
        unsafe = path_is_link_or_reparse(path)
    except OSError as error:
        raise HTTPException(
            500, "The dependent propagation protocol path is inaccessible."
        ) from error
    if unsafe:
        raise HTTPException(
            500, "The dependent propagation protocol path is unsafe."
        )


RESERVING_CLASS_BUSY_MESSAGE = (
    "Dependent updates are currently running for this reserving class. "
    "Please wait for them to finish, then save again."
)


def require_engine_available() -> None:
    """Refuse a save before anything is written when no live Engine exists."""

    try:
        require_live_engine(_workspace_server_root())
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error


# One orchestrated operation (the Excel workbook retarget) runs several
# canonical saves for one reserving class inside a single request; its first
# save's enqueued job would make the class read as busy and refuse the rest.
# Such an operation preflights the hold once at its entry and suspends the
# refusal for its nested saves, and collects their propagation roots through
# ``deferred_save_propagation`` so the class is walked once at the end.
_hold_check_suspended: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "arcrho_reserving_class_hold_check_suspended", default=False
)


@contextmanager
def suspended_reserving_class_hold_check() -> Iterator[None]:
    """Skip the class-hold refusal for one operation's nested canonical saves.

    The caller must have preflighted :func:`require_reserving_class_writable`
    itself before entering; nested saves still preflight the live-Engine
    heartbeat.
    """

    token = _hold_check_suspended.set(True)
    try:
        yield
    finally:
        _hold_check_suspended.reset(token)


class DeferredSavePropagation:
    """Roots collected from one operation's nested saves, walked once at the end.

    Inside :func:`deferred_save_propagation`, every ``enqueue_save_propagation``
    call for this reserving class adds its roots here instead of running or
    queueing a walk. The orchestrator calls :meth:`flush` after leaving the
    context, and that single call runs the walk inline on the Engine or queues
    one job from a client, exactly as one save would.
    """

    def __init__(self, project_name: str, reserving_class: str) -> None:
        self.project_name = str(project_name or "").strip()
        self.reserving_class = str(reserving_class or "").strip()
        self._roots: List[Dict[str, str]] = []
        self._seen: set[str] = set()

    def covers(self, project_name: str, reserving_class: str) -> bool:
        return (
            str(project_name or "").strip().casefold() == self.project_name.casefold()
            and str(reserving_class or "").strip().casefold() == self.reserving_class.casefold()
        )

    def add_roots(self, changed_roots: Sequence[Mapping[str, Any]]) -> None:
        for root in changed_roots:
            name = str(root.get("dataset_name") or "").strip()
            key = name.casefold()
            if not name or key in self._seen:
                continue
            self._seen.add(key)
            self._roots.append(changed_root(name, str(root.get("dataset_type") or "")))

    @property
    def roots(self) -> List[Dict[str, str]]:
        return list(self._roots)

    def flush(self) -> Dict[str, Any]:
        """Run or queue the one walk for every collected root.

        Must be called after the ``deferred_save_propagation`` context has
        exited; inside it the call would only collect the roots again.
        """

        if not self._roots:
            return unchanged_propagation()
        return enqueue_save_propagation(self.project_name, self.reserving_class, self._roots)


_deferred_save_propagation: contextvars.ContextVar[DeferredSavePropagation | None] = (
    contextvars.ContextVar("arcrho_deferred_save_propagation", default=None)
)


@contextmanager
def deferred_save_propagation(
    project_name: str, reserving_class: str
) -> Iterator[DeferredSavePropagation]:
    """Collect nested saves' propagation roots for one class into one walk.

    Without this, an operation saving N objects inside an Engine-hosted save
    would run N inline walks of the same class; from a client it would queue N
    jobs the Engine merges anyway. Saves for another reserving class are not
    intercepted.
    """

    collector = DeferredSavePropagation(project_name, reserving_class)
    token = _deferred_save_propagation.set(collector)
    try:
        yield collector
    finally:
        _deferred_save_propagation.reset(token)


def require_reserving_class_writable(
    project_name: str,
    reserving_class: str,
    *,
    timings: Dict[str, float] | None = None,
) -> Path:
    """Refuse a save while a propagation walk or queued job owns the class.

    Runs the live-Engine preflight first (503), then the canonical hold probe
    (423). Every propagation-triggering save calls this before writing
    anything, so one user's dependent walk cannot race another user's edits
    inside the same reserving class; other reserving classes are unaffected.
    The probe's freshness windows guarantee a dead worker releases the hold by
    itself, and the Engine's queued-request merge stays the backstop for the
    saves a non-atomic filesystem check lets through together. Return the
    validated workspace root so a caller can reuse it without repeating the
    network-drive path checks.
    """

    server_root = _workspace_server_root(
        timings=timings,
        timing_prefix="preflight_workspace",
    )
    started = time.perf_counter_ns()
    try:
        require_live_engine(server_root)
    except EngineUnavailableError as error:
        _record_latency(timings, "preflight_engine_heartbeat_ms", started)
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error
    _record_latency(timings, "preflight_engine_heartbeat_ms", started)
    if _hold_check_suspended.get():
        return server_root
    started = time.perf_counter_ns()
    try:
        hold = find_reserving_class_propagation_hold(
            server_root, project_name, reserving_class
        )
    except DependentPropagationContractError as error:
        _record_latency(timings, "preflight_class_hold_ms", started)
        raise HTTPException(400, str(error)) from error
    _record_latency(timings, "preflight_class_hold_ms", started)
    if hold is not None:
        raise HTTPException(423, RESERVING_CLASS_BUSY_MESSAGE)
    return server_root


def workspace_server_root() -> Path:
    """Return the validated ArcRho Server workspace root for this process.

    Exposed so a sibling job service reaches the same validated root through
    the module that owns the propagation protocol paths instead of deriving
    one of its own.
    """

    return _workspace_server_root()


PROJECT_SCOPE_BUSY_MESSAGE = (
    "A project-wide update is currently running for this project. "
    "Please wait for it to finish, then try again."
)
PROJECT_SCOPE_CLASS_BUSY_MESSAGE = (
    "Dependent updates are still running in this project. "
    "Please wait for them to finish, then try again."
)


def require_project_scope_writable(project_name: str) -> Path:
    """Refuse a project-wide job while anything else owns part of the project.

    A project-scope job rewrites what every reserving class derives from, so it
    may not start while a single class is being walked, nor while another
    project-wide job is running. The reserving-class preflight cannot answer
    that: it only knows about the one class its caller named. Returns the
    validated workspace root so the caller can reuse it.
    """

    server_root = _workspace_server_root()
    try:
        require_live_engine(server_root)
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error

    try:
        project_hold = find_project_scope_propagation_hold(server_root, project_name)
        class_hold = (
            find_any_reserving_class_propagation_hold(server_root, project_name)
            if project_hold is None
            else None
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error

    if project_hold is not None:
        raise HTTPException(423, PROJECT_SCOPE_BUSY_MESSAGE)
    if class_hold is not None:
        reserving_class = str(class_hold.get("reserving_class") or "").strip()
        detail = PROJECT_SCOPE_CLASS_BUSY_MESSAGE
        if reserving_class:
            detail = (
                f"Dependent updates are still running for '{reserving_class}'. "
                "Please wait for them to finish, then try again."
            )
        raise HTTPException(423, detail)
    return server_root


def get_reserving_class_busy(
    project_name: str, reserving_class: str
) -> Dict[str, Any]:
    """Report whether a propagation hold currently covers one reserving class.

    Read-only view of the same probe :func:`require_reserving_class_writable`
    enforces, for UI pages that freeze their editing surface while the class
    is being rewritten.
    """

    try:
        hold = find_reserving_class_propagation_hold(
            _workspace_server_root(), project_name, reserving_class
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error
    return {
        "ok": True,
        "busy": hold is not None,
        "reason": hold["reason"] if hold is not None else None,
    }


def submit_dependent_propagation_job(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
    *,
    request_id: str | None = None,
) -> Dict[str, Any]:
    """Publish one queued propagation request and return its job identity."""

    server_root = _workspace_server_root()
    try:
        require_live_engine(server_root)
    except EngineUnavailableError as error:
        raise HTTPException(503, ENGINE_UNAVAILABLE_MESSAGE) from error

    try:
        request = build_dependent_propagation_request(
            request_id=request_id if request_id is not None else uuid.uuid4().hex,
            project_name=project_name,
            path=reserving_class,
            changed_roots=list(changed_roots),
            # The Engine acts as this user while it walks, so the login must be
            # the person who saved, not the process that publishes the request
            # — which, for a save already hosted on the Engine, is an Engine.
            user_name=user_identity_service.get_windows_login_name(),
        )
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error

    normalized_request_id = request["RequestId"]
    request_path = dependent_propagation_request_path(
        server_root, normalized_request_id
    )
    published_status_path: Path | None = None
    try:
        published_status_path = write_dependent_propagation_status(
            server_root,
            normalized_request_id,
            "queued",
            progress={
                "stage": "queued",
                "completed": 0,
                "total": 0,
                "label": "Queued for ArcRho Engine",
            },
        )
        write_json_atomic(request_path, request)
    except PermissionError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            423,
            "The dependent propagation request queue is locked or inaccessible.",
        ) from error
    except OSError as error:
        _remove_unpublished_files(request_path, published_status_path)
        raise HTTPException(
            500, "Failed to submit the dependent propagation job."
        ) from error

    return {"ok": True, "job_id": normalized_request_id, "status": "queued"}


def _remove_unpublished_files(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def enqueue_save_propagation(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Submit a save's propagation job and shape the response payload.

    A save that already committed must never turn into an HTTP error because
    the queue write failed afterwards, so submission problems are reported in
    the returned payload instead of raised.

    Inside an Engine-hosted save the walk runs synchronously here instead. The
    decision belongs at this level, not at each call site: a queued job forces
    the client to poll a status file it reaches over SMB, where the Windows
    redirector caches the file for its default 10 s and hides a terminal status
    that has already been written. Every save that reaches an Engine holding
    the reserving-class lease should therefore answer with the finished walk.

    Inside :func:`deferred_save_propagation` for this class the roots are only
    collected; the operation's one flush runs or queues the walk.
    """

    deferred = _deferred_save_propagation.get()
    if deferred is not None and deferred.covers(project_name, reserving_class):
        deferred.add_roots(changed_roots)
        return {"ok": True, "status": "deferred"}

    if _inline_engine_propagation.get():
        return _run_inline_save_propagation(
            project_name, reserving_class, changed_roots
        )

    try:
        submitted = submit_dependent_propagation_job(
            project_name, reserving_class, changed_roots
        )
    except HTTPException as error:
        return {
            "ok": False,
            "status": "error",
            "message": str(error.detail),
        }
    return {
        "ok": True,
        "job_id": submitted["job_id"],
        "status": submitted["status"],
    }


def changed_root(dataset_name: str, dataset_type: str = "") -> Dict[str, str]:
    return {
        "dataset_name": str(dataset_name or "").strip(),
        "dataset_type": str(dataset_type or "").strip(),
    }


_inline_engine_propagation: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "arcrho_inline_engine_propagation", default=False
)


@contextmanager
def inline_engine_propagation() -> Iterator[None]:
    """Run save-triggered propagation inline instead of enqueueing a job.

    The Engine's hosted-save executor sets this around the canonical service
    save: the process already runs on the server host under the
    reserving-class lease, so the walk runs synchronously on local disk and
    the save response carries the finished outcome (with the refreshed
    dataset names) instead of a job id to poll.
    """

    token = _inline_engine_propagation.set(True)
    try:
        yield
    finally:
        _inline_engine_propagation.reset(token)


# The Engine's hosted-save executor installs a publisher here so the inline
# walk can narrate itself: each callback becomes one live update in the
# save-job status the client polls while its save request is still in flight.
_inline_save_progress_publisher: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "arcrho_inline_save_progress_publisher", default=None
)


@contextmanager
def inline_save_progress(publisher: Any) -> Iterator[None]:
    """Route the inline walk's progress callbacks to ``publisher``.

    ``publisher`` receives ``(stage, completed, total, label)`` — the same
    shape :func:`calculated_dataset_service.recalculate_dependents` emits and
    the durable propagation queue publishes. It must never raise into the
    walk; the Engine's publisher already swallows its own failures.
    """

    token = _inline_save_progress_publisher.set(publisher)
    try:
        yield
    finally:
        _inline_save_progress_publisher.reset(token)


def _collect_refreshed_dataset_names(walk_result: Mapping[str, Any]) -> List[str]:
    names: List[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        text = str(value or "").strip()
        key = text.casefold()
        if text and key not in seen:
            seen.add(key)
            names.append(text)

    for item in walk_result.get("updated") or []:
        if isinstance(item, Mapping):
            add(item.get("dataset_type_name") or item.get("dataset_name"))
    for bucket in (
        "dfm_updates",
        "result_selection_updates",
        "berquist_sherman_updates",
        "bornhuetter_ferguson_updates",
        "cape_cod_updates",
        "bootstrap_updates",
    ):
        updates = walk_result.get(bucket)
        if not isinstance(updates, Mapping):
            continue
        for item in updates.get("updated") or []:
            if isinstance(item, Mapping):
                add(item.get("dataset_name") or item.get("method_name"))
    link_updates = walk_result.get("link_updates")
    if isinstance(link_updates, Mapping):
        for name in link_updates.get("refreshed") or []:
            add(name)
    return names


def _collect_link_warnings(walk_result: Mapping[str, Any]) -> List[Dict[str, str]]:
    """The Excel keep-stale warnings a walk collected, shaped for the client."""

    link_updates = walk_result.get("link_updates")
    if not isinstance(link_updates, Mapping):
        return []
    warnings: List[Dict[str, str]] = []
    for item in link_updates.get("warnings") or []:
        if not isinstance(item, Mapping):
            continue
        warning = {
            "dataset_name": str(item.get("dataset_name") or "").strip(),
            "reference": str(item.get("reference") or "").strip(),
            # The reason reaches the client alert; a quoted workbook error
            # must not leak server paths.
            "reason": _WALK_FAILURE_PATH_RE.sub("[path]", str(item.get("reason") or "").strip()),
        }
        if warning["dataset_name"]:
            warnings.append(warning)
    return warnings


def _run_inline_save_propagation(
    project_name: str,
    reserving_class: str,
    changed_roots: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Run the canonical walk synchronously and shape a completed payload.

    Mirrors ``enqueue_save_propagation``'s promise: a save that already
    committed must never turn into an HTTP error because the follow-up walk
    failed, so walk trouble is reported in the payload (`ok: False`) and the
    dataset table's review-needed flags stay the failure surface.
    """

    roots = [root for root in changed_roots if str(root.get("dataset_name") or "").strip()]
    if not roots:
        return unchanged_propagation()
    first, *rest = roots
    try:
        from app_server.services import calculated_dataset_service

        result = calculated_dataset_service.recalculate_dependents(
            project_name,
            reserving_class,
            first.get("dataset_name"),
            first.get("dataset_type"),
            additional_roots=[
                (root.get("dataset_name"), root.get("dataset_type")) for root in rest
            ],
            rebuild_index=True,
            progress_callback=_inline_save_progress_publisher.get(),
        )
    except Exception as exc:
        return {
            "ok": False,
            "status": "completed",
            "message": str(exc),
            "refreshed_datasets": [],
        }
    payload: Dict[str, Any] = {
        "ok": bool(result.get("ok")),
        "status": "completed",
        "refreshed_datasets": _collect_refreshed_dataset_names(result),
    }
    link_warnings = _collect_link_warnings(result)
    if link_warnings:
        payload["link_warnings"] = link_warnings
    if not payload["ok"]:
        # Without this the client and the hosted-save log can only report a
        # generic scheduling warning; the walk knows exactly which dependent
        # declined and why.
        payload["message"] = _summarize_walk_failure(result)
    return payload


def _summarize_walk_failure(result: Mapping[str, Any]) -> str:
    """Name what actually failed in a finished-but-unhealthy walk."""

    failed = sorted(
        {
            str(item.get("dataset_type_name") or item.get("dataset_name") or "").strip()
            for item in result.get("skipped") or []
            if isinstance(item, Mapping)
        }
        - {""}
    )
    method_failures: List[str] = []
    for bucket in (
        "dfm_updates",
        "result_selection_updates",
        "berquist_sherman_updates",
        "bornhuetter_ferguson_updates",
        "cape_cod_updates",
        "bootstrap_updates",
    ):
        updates = result.get(bucket)
        if not isinstance(updates, Mapping) or updates.get("ok", True):
            continue
        for error in updates.get("errors") or []:
            if not isinstance(error, Mapping):
                continue
            name = str(error.get("dataset_name") or error.get("method_name") or "").strip()
            reason = str(error.get("reason") or "").strip()
            text = f"{name}: {reason}" if name and reason else (name or reason)
            if text:
                method_failures.append(text)
    link_failures: List[str] = []
    link_updates = result.get("link_updates")
    if isinstance(link_updates, Mapping):
        for error in link_updates.get("errors") or []:
            if not isinstance(error, Mapping):
                continue
            name = str(error.get("dataset_name") or "").strip()
            details = "; ".join(
                str(item).strip() for item in error.get("errors") or [] if str(item).strip()
            )
            text = f"{name}: {details}" if name and details else (name or details)
            if text:
                link_failures.append(text)
    parts: List[str] = []
    if failed:
        parts.append("Dependent update(s) did not refresh: " + ", ".join(failed))
    if link_failures:
        parts.append(
            "Linked dataset refresh failure(s): " + "; ".join(sorted(set(link_failures)))
        )
    if method_failures:
        parts.append(
            "Method refresh failure(s): " + "; ".join(sorted(set(method_failures)))
        )
    if result.get("index_error"):
        parts.append("The reserving-class index rebuild failed.")
    if not parts:
        parts.append("One or more dependent updates failed.")
    # The message reaches the client and the shared hosted-saves log; a
    # failure reason quoting an exception must not leak server paths.
    return _WALK_FAILURE_PATH_RE.sub("[path]", " ".join(parts))


_WALK_FAILURE_PATH_RE = re.compile(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\s\"']+")


def enqueue_marked_save_propagation(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    dataset_type: str = "",
) -> Dict[str, Any]:
    """Mark the first dependent method tier, then enqueue the Engine walk.

    Only the nearest reachable methods are marked here (a handful of SMB
    round trips from a Client PC); the Engine job marks the full reachable
    closure as its first claimed step, where the walk runs on local disk. If
    the job is never claimed, the first method tier stays visibly flagged
    and the next save or refresh re-enqueues the walk that restores the
    deeper tiers.

    Inside an Engine-hosted save the marking is skipped entirely: the walk runs
    synchronously and finalizes every status itself. Whether to run inline is
    decided once, by `enqueue_save_propagation`; this function only declines to
    pay for marking that the inline walk would immediately redo.
    """

    if not _inline_engine_propagation.get():
        try:
            from app_server.services import dataset_sidecar_status_service

            dataset_sidecar_status_service.refresh_method_statuses_for_dependents(
                project_name,
                reserving_class,
                [dataset_name, dataset_type],
                direct_only=True,
            )
        except Exception as exc:
            return {"ok": False, "status": "error", "message": str(exc)}
    return enqueue_save_propagation(
        project_name,
        reserving_class,
        [changed_root(dataset_name, dataset_type)],
    )


def unchanged_propagation() -> Dict[str, Any]:
    """The canonical no-op-save payload: nothing changed, no job enqueued."""

    return {"ok": True, "status": "unchanged"}


def get_dependent_propagation_status(request_id: str) -> Dict[str, Any]:
    try:
        normalized_request_id = validate_request_id(request_id)
    except DependentPropagationContractError as error:
        raise HTTPException(400, str(error)) from error

    status_path = dependent_propagation_status_path(
        _workspace_server_root(), normalized_request_id
    )
    try:
        with status_path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except FileNotFoundError as error:
        raise HTTPException(
            404, "Dependent propagation job was not found."
        ) from error
    except PermissionError as error:
        raise HTTPException(
            423, "Dependent propagation status is locked or inaccessible."
        ) from error
    except json.JSONDecodeError as error:
        raise HTTPException(
            502,
            "ArcRho Engine published an invalid dependent propagation status.",
        ) from error
    except OSError as error:
        raise HTTPException(
            500, "Failed to read the dependent propagation status."
        ) from error

    try:
        status = validate_dependent_propagation_status(
            payload, expected_request_id=normalized_request_id
        )
    except DependentPropagationContractError as error:
        raise HTTPException(
            502,
            "ArcRho Engine published an invalid dependent propagation status.",
        ) from error

    return {"ok": True, "job_id": normalized_request_id, **status}
