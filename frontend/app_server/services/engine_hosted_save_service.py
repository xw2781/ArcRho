"""Client half of Engine-hosted saves.

The save endpoints keep their exact HTTP shapes, but the file work runs on
ArcRho Engine where ``E:\\ArcRho Server`` is local disk: this module
drops the request file in the requests root as the queued state (instant
watchdog pickup), polls after an initial pickup window, and returns the
Engine-written terminal response as if the save had run in-process. Service
``HTTPException`` outcomes (409 conflicts, 400 validation, 423 holds) come
back with their original status codes and details.

:func:`run_hosted_save_plan` is the same round trip for the first half of a
two-step save: it asks which dependent objects the save would reach so the
user can confirm before anything is written, and returns the fingerprint the
matching :func:`run_hosted_save` passes back for the under-lease recheck.
"""

from __future__ import annotations

import contextvars
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from arcrho_engine_save_contract import (
    SAVE_JOB_MODE_COMMIT,
    SAVE_JOB_MODE_PLAN,
    SAVE_JOB_PLAN_TIMEOUT_SECONDS,
    SAVE_JOB_PROCESSING_TIMEOUT_SECONDS,
    SAVE_JOB_QUEUED_TIMEOUT_SECONDS,
    SaveJobContractError,
    build_save_job_request,
    discard_save_job_artifacts,
    read_save_job_result,
    read_save_job_status,
    save_job_request_path,
    save_job_status_response,
    save_job_status_is_terminal,
)

from app_server.services import (
    client_save_latency_log_service,
    dependent_propagation_service,
    user_identity_service,
)

# SMB status reads take ~0.4 s and hold the file open without
# FILE_SHARE_DELETE, blocking the Engine's atomic status replace for their
# duration; the sleep keeps real gaps between reads for the Engine's
# replace retries to land in.
_POLL_SLEEP_SECONDS = 0.35
_INITIAL_POLL_DELAY_SECONDS = 0.5

_ACTIVE_LATENCY_TRACE: contextvars.ContextVar[Dict[str, Any] | None] = (
    contextvars.ContextVar("arcrho_client_save_latency_trace", default=None)
)

HOSTED_SAVE_UNAVAILABLE_MESSAGE = (
    "ArcRho Engine did not pick up the save. Please try again; if this "
    "persists, ask an administrator to check the Engine service."
)
HOSTED_SAVE_TIMEOUT_MESSAGE = (
    "The save is taking longer than expected on ArcRho Engine. It may still "
    "complete; reload the object before retrying."
)
HOSTED_PLAN_UNAVAILABLE_MESSAGE = (
    "ArcRho Engine did not report which dependent objects this save would "
    "update. Please try again; if this persists, ask an administrator to "
    "check the Engine service."
)
HOSTED_PLAN_TIMEOUT_MESSAGE = (
    "ArcRho Engine is taking longer than expected to list the dependent "
    "objects this save would update. Nothing was saved; please try again."
)


def _active_latency_trace() -> Dict[str, Any]:
    trace = _ACTIVE_LATENCY_TRACE.get()
    if trace is None:
        raise RuntimeError("Hosted-save latency trace is not active.")
    return trace


def _set_failure_stage(stage: str) -> None:
    _active_latency_trace()["failure_stage"] = stage


def _record_phase(key: str, started_ns: int) -> None:
    _active_latency_trace()["phase_ms"][key] = _elapsed_ms(started_ns)


def _elapsed_ms(started_ns: int) -> float:
    return round((time.perf_counter_ns() - started_ns) / 1_000_000.0, 3)


def _save_object_name(args: Sequence[Any]) -> str:
    """Return one safe logical label without recording the save payload."""

    candidate = args[2] if len(args) > 2 and isinstance(args[2], Mapping) else {}
    details = candidate.get("details tab")
    if isinstance(details, Mapping):
        for key in ("name", "output dataset"):
            value = str(details.get(key) or "").strip()
            if value:
                return value
    for key in ("dataset_name", "method_name", "name"):
        value = str(candidate.get(key) or "").strip()
        if value:
            return value
    return ""


def _discard_artifacts_in_background(
    server_root: Path,
    request_id: str,
    *,
    context: Mapping[str, Any],
) -> None:
    # Consuming a claimed job's leftovers is three sequential SMB unlinks
    # (measured ~0.1 s per existing file on the mapped drive; the Engine's
    # delete-to-claim already removed the request file), so doing it before
    # returning makes every hosted save and plan wait ~0.25 s for pure
    # housekeeping. Cleanup stays best-effort either way: the Engine prunes
    # anything a dead client leaves behind. The unclaimed-request retraction
    # must NOT come through here — deleting the request file before the 503
    # is what guarantees the job never runs.
    def discard_and_log() -> None:
        started = time.perf_counter_ns()
        discard_save_job_artifacts(server_root, request_id)
        client_save_latency_log_service.append_client_save_latency(
            {
                "event": "hosted_save_cleanup",
                "request_id": request_id,
                "process_id": os.getpid(),
                **dict(context),
                "cleanup_ms": _elapsed_ms(started),
            }
        )

    threading.Thread(
        target=discard_and_log,
        name=f"hosted-save-cleanup-{request_id}",
        daemon=True,
    ).start()


def _publish_request(server_root: Path, request: Mapping[str, Any]) -> Path:
    trace = _active_latency_trace()
    started_ns = time.perf_counter_ns()
    serialized = json.dumps(request, ensure_ascii=False)
    _record_phase("request_serialize_ms", started_ns)
    trace["request_bytes"] = len(serialized.encode("utf-8"))

    path = save_job_request_path(server_root, request["RequestId"])
    started_ns = time.perf_counter_ns()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    finally:
        _record_phase("request_directory_ms", started_ns)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        started_ns = time.perf_counter_ns()
        try:
            temp_path.write_text(serialized, encoding="utf-8")
        finally:
            _record_phase("request_temp_write_ms", started_ns)
        # The atomic move fires the Engine watchdog's on_moved with a
        # complete file; a direct write could be observed half-written.
        started_ns = time.perf_counter_ns()
        try:
            os.replace(temp_path, path)
        finally:
            _record_phase("request_atomic_publish_ms", started_ns)
    except Exception:
        try:
            started_ns = time.perf_counter_ns()
            temp_path.unlink(missing_ok=True)
            _record_phase("request_failed_temp_cleanup_ms", started_ns)
        except OSError:
            pass
        raise
    return path


def _run_hosted_job_impl(
    mode: str,
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None,
    plan_fingerprint: str,
    processing_timeout_seconds: float,
    missing_result_message: str,
    unavailable_message: str,
    timeout_message: str,
    failure_message: str,
) -> Dict[str, Any]:
    # Fast local fail with today's exact UX: 503 without a live Engine, 423
    # while a walk still holds this reserving class. A plan preflights the
    # same way, so a user is never shown a list they could not act on.
    trace = _active_latency_trace()
    phases = trace["phase_ms"]
    _set_failure_stage("preflight")
    started_ns = time.perf_counter_ns()
    try:
        server_root = (
            dependent_propagation_service.require_reserving_class_writable(
                project_name,
                reserving_class,
                timings=phases,
            )
        )
    finally:
        _record_phase("preflight_total_ms", started_ns)

    request_id = trace["request_id"]
    # The Engine instance that claims this runs under its own service profile,
    # so the requesting user travels with the request: the login for identity
    # and the display name this process already resolved against the workspace
    # username index.
    _set_failure_stage("identity_lookup")
    started_ns = time.perf_counter_ns()
    try:
        identity = user_identity_service.get_current_identity()
    finally:
        _record_phase("identity_lookup_ms", started_ns)
    _set_failure_stage("request_encode")
    started_ns = time.perf_counter_ns()
    try:
        request = build_save_job_request(
            request_id=request_id,
            save_kind=save_kind,
            project_name=project_name,
            path=reserving_class,
            # Router payloads can carry pydantic models; the request file is
            # plain JSON, so encode exactly the way FastAPI would respond.
            args=jsonable_encoder(list(args)),
            kwargs=jsonable_encoder(dict(kwargs or {})),
            user_name=identity["login_name"],
            user_display_name=identity["display_name"],
            mode=mode,
            plan_fingerprint=plan_fingerprint,
        )
    except SaveJobContractError as error:
        raise HTTPException(400, str(error)) from error
    finally:
        _record_phase("request_encode_ms", started_ns)

    _set_failure_stage("request_publish")
    started_ns = time.perf_counter_ns()
    try:
        _publish_request(server_root, request)
    except Exception:
        dependent_propagation_service._invalidate_protocol_path_cache(server_root)
        raise
    finally:
        _record_phase("request_publish_ms", started_ns)

    trace["remote_round_trip_started_ns"] = time.perf_counter_ns()
    started = time.monotonic()
    claim_deadline = started + SAVE_JOB_QUEUED_TIMEOUT_SECONDS
    total_deadline = started + processing_timeout_seconds
    request_claimed = False

    # A tiny SMB read costs more than the Engine normally needs to claim the
    # request. Give watchdog pickup one local sleep before the first poll.
    _set_failure_stage("initial_poll_delay")
    sleep_started_ns = time.perf_counter_ns()
    time.sleep(_INITIAL_POLL_DELAY_SECONDS)
    initial_delay_ms = _elapsed_ms(sleep_started_ns)
    trace["poll_sleep_ms"] += initial_delay_ms
    phases["initial_poll_delay_ms"] = initial_delay_ms

    while True:
        _set_failure_stage("status_read")
        status_started_ns = time.perf_counter_ns()
        try:
            status = read_save_job_status(server_root, request_id)
        finally:
            trace["status_reads_ms"].append(_elapsed_ms(status_started_ns))
        current = str((status or {}).get("status") or "queued")
        trace["status_observations"].append(current if status else "missing")
        if current != "queued":
            request_claimed = True
        if save_job_status_is_terminal(status):
            _record_phase(
                "remote_round_trip_ms",
                trace["remote_round_trip_started_ns"],
            )
            if current == "success":
                result = save_job_status_response(status)
                if result is not None:
                    trace["result_source"] = "terminal_status"
                else:
                    # Compatibility with an older Engine that publishes the
                    # success status and result as two separate files.
                    _set_failure_stage("legacy_result_read")
                    result_started_ns = time.perf_counter_ns()
                    try:
                        result = read_save_job_result(server_root, request_id)
                    finally:
                        _record_phase("legacy_result_read_ms", result_started_ns)
                    trace["result_source"] = "legacy_result_file"
                cleanup_started_ns = time.perf_counter_ns()
                _discard_artifacts_in_background(
                    server_root,
                    request_id,
                    context=trace["context"],
                )
                _record_phase("cleanup_schedule_ms", cleanup_started_ns)
                if result is None:
                    raise HTTPException(500, missing_result_message)
                return result
            code = int(status.get("status_code") or 500)
            message = str(status.get("message") or failure_message)
            cleanup_started_ns = time.perf_counter_ns()
            _discard_artifacts_in_background(
                server_root,
                request_id,
                context=trace["context"],
            )
            _record_phase("cleanup_schedule_ms", cleanup_started_ns)
            raise HTTPException(code, message)

        now = time.monotonic()
        if not request_claimed and current == "queued" and now >= claim_deadline:
            # A missing status can mean not-yet-claimed or claimed before the
            # Engine published processing. Check the request only at this
            # deadline; if delete-to-claim already removed it, allow the full
            # processing timeout rather than falsely reporting an unclaimed job.
            _set_failure_stage("claim_state_check")
            claim_check_started_ns = time.perf_counter_ns()
            request_still_queued = save_job_request_path(
                server_root,
                request_id,
            ).is_file()
            _record_phase("claim_state_check_ms", claim_check_started_ns)
            if request_still_queued:
                _set_failure_stage("unclaimed_retraction")
                retraction_started_ns = time.perf_counter_ns()
                discard_save_job_artifacts(server_root, request_id)
                _record_phase("unclaimed_retraction_ms", retraction_started_ns)
                raise HTTPException(503, unavailable_message)
            request_claimed = True
        if now >= total_deadline:
            # Claimed but never finished: leave the artifacts for the Engine
            # pruner — the save may still land after this response.
            raise HTTPException(504, timeout_message)
        _set_failure_stage("poll_sleep")
        sleep_started_ns = time.perf_counter_ns()
        time.sleep(_POLL_SLEEP_SECONDS)
        trace["poll_sleep_ms"] += _elapsed_ms(sleep_started_ns)


def _run_hosted_job(
    mode: str,
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None,
    plan_fingerprint: str,
    processing_timeout_seconds: float,
    missing_result_message: str,
    unavailable_message: str,
    timeout_message: str,
    failure_message: str,
) -> Dict[str, Any]:
    """Run one hosted job and append its client-side latency trace locally."""

    request_id = uuid.uuid4().hex
    context = {
        "mode": mode,
        "save_kind": save_kind,
        "project_name": str(project_name or "").strip(),
        "reserving_class": str(reserving_class or "").strip(),
        "object_name": _save_object_name(args),
    }
    trace: Dict[str, Any] = {
        "request_id": request_id,
        "context": context,
        "phase_ms": {},
        "status_reads_ms": [],
        "status_observations": [],
        "poll_sleep_ms": 0.0,
        "remote_round_trip_started_ns": None,
        "request_bytes": 0,
        "result_source": "none",
        "failure_stage": "preflight",
    }
    token = _ACTIVE_LATENCY_TRACE.set(trace)
    total_started_ns = time.perf_counter_ns()
    outcome = "error"
    http_status = 500
    try:
        result = _run_hosted_job_impl(
            mode,
            save_kind,
            project_name,
            reserving_class,
            args=args,
            kwargs=kwargs,
            plan_fingerprint=plan_fingerprint,
            processing_timeout_seconds=processing_timeout_seconds,
            missing_result_message=missing_result_message,
            unavailable_message=unavailable_message,
            timeout_message=timeout_message,
            failure_message=failure_message,
        )
        outcome = "success"
        http_status = 200
        trace["failure_stage"] = ""
        return result
    except HTTPException as error:
        http_status = int(error.status_code)
        raise
    finally:
        remote_started_ns = trace.get("remote_round_trip_started_ns")
        if (
            remote_started_ns is not None
            and "remote_round_trip_ms" not in trace["phase_ms"]
        ):
            trace["phase_ms"]["remote_round_trip_ms"] = _elapsed_ms(
                remote_started_ns
            )
        trace["phase_ms"]["status_read_total_ms"] = round(
            sum(trace["status_reads_ms"]),
            3,
        )
        trace["phase_ms"]["poll_sleep_total_ms"] = round(
            trace["poll_sleep_ms"],
            3,
        )
        try:
            client_save_latency_log_service.append_client_save_latency(
                {
                    "event": "hosted_save_round_trip",
                    "request_id": request_id,
                    "process_id": os.getpid(),
                    **context,
                    "outcome": outcome,
                    "http_status": http_status,
                    "failure_stage": trace["failure_stage"],
                    "request_bytes": trace["request_bytes"],
                    "result_source": trace["result_source"],
                    "total_ms": _elapsed_ms(total_started_ns),
                    "phase_ms": trace["phase_ms"],
                    "status_poll_count": len(trace["status_reads_ms"]),
                    "status_reads_ms": trace["status_reads_ms"],
                    "status_observations": trace["status_observations"],
                }
            )
        finally:
            _ACTIVE_LATENCY_TRACE.reset(token)


def run_hosted_save(
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None = None,
    plan_fingerprint: str = "",
) -> Dict[str, Any]:
    """Execute one allowlisted service save on ArcRho Engine and return its response.

    ``plan_fingerprint`` is the fingerprint of the dependent-update plan the
    user reviewed. When present the Engine recomputes it under the
    reserving-class lease and refuses with 409 if the class moved in between,
    so a save can never land against a list the user never saw.
    """

    return _run_hosted_job(
        SAVE_JOB_MODE_COMMIT,
        save_kind,
        project_name,
        reserving_class,
        args=args,
        kwargs=kwargs,
        plan_fingerprint=plan_fingerprint,
        processing_timeout_seconds=SAVE_JOB_PROCESSING_TIMEOUT_SECONDS,
        missing_result_message=(
            "ArcRho Engine reported a successful save but its result payload "
            "could not be read."
        ),
        unavailable_message=HOSTED_SAVE_UNAVAILABLE_MESSAGE,
        timeout_message=HOSTED_SAVE_TIMEOUT_MESSAGE,
        failure_message="The hosted save failed.",
    )


def run_hosted_save_plan(
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Report the dependent objects one save would reach, without saving.

    The Engine walks both dependency graphs on local disk and answers with
    the reachable objects plus the fingerprint that authorizes the matching
    :func:`run_hosted_save`.
    """

    return _run_hosted_job(
        SAVE_JOB_MODE_PLAN,
        save_kind,
        project_name,
        reserving_class,
        args=args,
        kwargs=kwargs,
        plan_fingerprint="",
        processing_timeout_seconds=SAVE_JOB_PLAN_TIMEOUT_SECONDS,
        missing_result_message=(
            "ArcRho Engine reported the dependent-update plan but its payload "
            "could not be read."
        ),
        unavailable_message=HOSTED_PLAN_UNAVAILABLE_MESSAGE,
        timeout_message=HOSTED_PLAN_TIMEOUT_MESSAGE,
        failure_message="The dependent-update plan failed.",
    )
