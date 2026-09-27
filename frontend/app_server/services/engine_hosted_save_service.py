"""Client half of Engine-hosted saves.

The save endpoints keep their exact HTTP shapes, but the file work runs on
Arco Engine where the workspace is local disk: this module sends the
canonical save request to the Gateway, which queues it for the Engine and
answers with the Engine's terminal response, as if the save had run
in-process. Service ``HTTPException`` outcomes (409 conflicts, 400
validation, 423 holds) come back with their original status codes and
details.

A Client PC has no other way to save: not signed in, a Gateway that does not
answer, and a Gateway that does not offer the save kind are each the error
the user sees (``workspace_read_client.require_client_gateway``), and nothing
is written over the share.

:func:`run_hosted_save_plan` is the same round trip for the first half of a
two-step save: it asks which dependent objects the save would reach so the
user can confirm before anything is written, and returns the fingerprint the
matching :func:`run_hosted_save` passes back for the under-lease recheck.
"""

from __future__ import annotations

import contextvars
import os
import time
import uuid
from typing import Any, Dict, Mapping, Sequence

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from arcrho_engine_save_contract import (
    SAVE_JOB_MODE_COMMIT,
    SAVE_JOB_MODE_PLAN,
    SAVE_JOB_PLAN_TIMEOUT_SECONDS,
    SAVE_JOB_PROCESSING_TIMEOUT_SECONDS,
    SaveJobContractError,
    build_save_job_request,
    read_save_job_status,
    validate_request_id,
)
from arcrho_hosted_save_http_contract import HostedSaveHttpContractError

from app_server import config
from app_server.services import (
    client_save_latency_log_service,
    dependent_propagation_service,
    hosted_save_http_client,
    propagation_gateway_client,
    user_identity_service,
    workspace_read_client,
)

_ACTIVE_LATENCY_TRACE: contextvars.ContextVar[Dict[str, Any] | None] = (
    contextvars.ContextVar("arcrho_client_save_latency_trace", default=None)
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
    details = candidate.get("details_tab")
    if isinstance(details, Mapping):
        for key in ("name", "output_dataset"):
            value = str(details.get(key) or "").strip()
            if value:
                return value
    for key in ("dataset_name", "method_name", "name"):
        value = str(candidate.get(key) or "").strip()
        if value:
            return value
    return ""


def _run_hosted_job_http(
    mode: str,
    save_kind: str,
    project_name: str,
    reserving_class: str,
    *,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None,
    plan_fingerprint: str,
    processing_timeout_seconds: float,
    gateway_config: Mapping[str, Any],
) -> Dict[str, Any]:
    """Send the canonical logical request to the server-side gateway."""

    trace = _active_latency_trace()
    _set_failure_stage("identity_lookup")
    started_ns = time.perf_counter_ns()
    try:
        login_name = user_identity_service.get_windows_login_name()
    finally:
        _record_phase("identity_lookup_ms", started_ns)

    configured_user = str(gateway_config.get("user") or "").strip()
    if configured_user.casefold() != login_name.casefold():
        raise HTTPException(
            403,
            "The Gateway credential belongs to a different Windows user.",
        )

    _set_failure_stage("request_encode")
    started_ns = time.perf_counter_ns()
    try:
        request = build_save_job_request(
            request_id=trace["request_id"],
            save_kind=save_kind,
            project_name=project_name,
            path=reserving_class,
            args=jsonable_encoder(list(args)),
            kwargs=jsonable_encoder(dict(kwargs or {})),
            user_name=login_name,
            # The Engine resolves the signed login's display name.
            user_display_name="",
            mode=mode,
            plan_fingerprint=plan_fingerprint,
        )
    except SaveJobContractError as error:
        raise HTTPException(400, str(error)) from error
    finally:
        _record_phase("request_encode_ms", started_ns)

    _set_failure_stage("gateway_round_trip")
    trace["remote_round_trip_started_ns"] = time.perf_counter_ns()
    result, timings = hosted_save_http_client.submit_hosted_save(
        gateway_config,
        request,
        timeout_seconds=processing_timeout_seconds,
    )
    trace["request_bytes"] = int(timings["request_bytes"])
    trace["result_source"] = "http_gateway"
    trace["phase_ms"].update(
        {
            "gateway_round_trip_ms": timings["gateway_round_trip_ms"],
            "gateway_attempts": timings["gateway_attempts"],
        }
    )
    _record_phase("remote_round_trip_ms", trace["remote_round_trip_started_ns"])
    return result


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
    client_request_id: str = "",
) -> Dict[str, Any]:
    """Run one hosted job over the Gateway and append its latency trace locally.

    ``client_request_id`` lets the page that triggered the save pick the save
    job's identity up front, so it can poll the live walk progress for that
    same id while this call is still in flight. An absent or malformed value
    falls back to a fresh id — the save must never fail over its narration.
    """

    request_id = ""
    if str(client_request_id or "").strip():
        try:
            request_id = validate_request_id(str(client_request_id).strip())
        except Exception:
            request_id = ""
    if not request_id:
        request_id = uuid.uuid4().hex
    # ``context`` is the same dict the latency record spreads.
    context = {
        "mode": mode,
        "save_kind": save_kind,
        "transport": workspace_read_client.TRANSPORT_HTTP,
        "reason": "",
        "project_name": str(project_name or "").strip(),
        "reserving_class": str(reserving_class or "").strip(),
        "object_name": _save_object_name(args),
    }
    trace: Dict[str, Any] = {
        "request_id": request_id,
        "context": context,
        "phase_ms": {},
        "remote_round_trip_started_ns": None,
        "request_bytes": 0,
        "result_source": "none",
        "failure_stage": "gateway_capability",
    }
    token = _ACTIVE_LATENCY_TRACE.set(trace)
    total_started_ns = time.perf_counter_ns()
    outcome = "error"
    http_status = 500
    try:
        capability_started_ns = time.perf_counter_ns()
        try:
            gateway_config = workspace_read_client.require_client_gateway(
                context,
                lambda capabilities: hosted_save_http_client.gateway_supports_save_kind(
                    capabilities, save_kind
                ),
            )
        finally:
            _record_phase("gateway_capability_ms", capability_started_ns)
        if gateway_config is None:
            # Server processes run a save's service function themselves under
            # the Engine's lease; only a Client PC's routes send one here.
            raise HTTPException(500, "A save is sent to the server only from a Client PC.")
        result = _run_hosted_job_http(
            mode,
            save_kind,
            project_name,
            reserving_class,
            args=args,
            kwargs=kwargs,
            plan_fingerprint=plan_fingerprint,
            processing_timeout_seconds=processing_timeout_seconds,
            gateway_config=gateway_config,
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
    client_request_id: str = "",
) -> Dict[str, Any]:
    """Execute one allowlisted service save on Arco Engine and return its response.

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
        client_request_id=client_request_id,
        processing_timeout_seconds=SAVE_JOB_PROCESSING_TIMEOUT_SECONDS,
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
    )


def get_hosted_save_progress(request_id: str) -> Dict[str, Any]:
    """Report one in-flight hosted save's live status for the UI poller.

    Clients use Gateway only. An unavailable progress endpoint returns
    unknown without inspecting the share or interrupting the save.
    """

    try:
        normalized_id = validate_request_id(str(request_id or "").strip())
    except Exception as error:
        raise HTTPException(400, "A valid save request id is required.") from error

    if propagation_gateway_client.is_server_process():
        try:
            status = read_save_job_status(
                dependent_propagation_service._workspace_server_root(), normalized_id,
            )
        except Exception:
            status = None
        return _progress_payload(status)
    gateway_config: Mapping[str, Any] = {"enabled": False}
    try:
        gateway_config = config.load_gateway_config()
    except HostedSaveHttpContractError:
        gateway_config = {"enabled": False}
    if gateway_config.get("enabled") is True:
        answer = hosted_save_http_client.fetch_hosted_save_progress(
            gateway_config, normalized_id
        )
        if isinstance(answer, Mapping):
            return _progress_payload(answer)
    return _progress_payload(None)


def _progress_payload(status: Mapping[str, Any] | None) -> Dict[str, Any]:
    if not isinstance(status, Mapping):
        return {"status": "unknown", "progress": None, "message": None}
    progress = status.get("progress")
    return {
        "status": str(status.get("status") or "unknown"),
        "progress": dict(progress) if isinstance(progress, Mapping) else None,
        "message": str(status.get("message") or "") or None,
    }
