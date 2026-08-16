"""ArcRho Engine calculation requests: the local exchange, the dataset run, and their Gateway transport.

An ``ArcRhoTri`` / ``ArcRhoVec`` / ``ArcRhoHeaders`` calculation is a
request file the Engine claims from the workspace ``requests`` root plus the
CSV it writes to the caller's ``DataPath``. ``publish_and_wait`` is that
exchange; it is the same code whether it runs on a Client PC over the mapped
drive or inside the ArcRho Gateway on the server host against local disk.

``run_engine_calculation`` is what the runtime service calls. When the output
CSV lives on a network drive and the Gateway advertises the Engine function, it
POSTs the logical request (``arcrho_engine_calculation_contract``) and lets
the server publish and wait locally, so the Client PC pays one HTTP round trip
instead of the request-file write plus a probe-and-poll loop over SMB. In every
other case — a local workspace, a server process, a disabled or unreachable
gateway, a function the gateway does not host, or a refusal before the request
was accepted — it runs the exchange here exactly as before.

Once the Gateway has accepted a request the outcome is never retried over SMB:
a second request file would make the Engine compute the same CSV twice.

``run_hosted_dataset_operation`` moves the whole ``/arcrho/tri*`` and
``/arcrho/vec*`` route — cache validation, the exchange, the sidecar write, the
dependent enqueue, and the index refresh — to the server host under the same
rules; the client keeps only the dataset-handle registration.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Callable, Dict, Mapping, Sequence

from fastapi import HTTPException

from arcrho_engine_calculation_contract import (
    ENGINE_CALCULATION_CAPABILITY_FIELD,
    ENGINE_CALCULATION_HTTP_TIMEOUT_MARGIN_SECONDS,
    ENGINE_CALCULATION_OPERATION_FIELD,
    ENGINE_CALCULATION_PATH,
    ENGINE_CALCULATION_STATUS_COMPLETED,
    ENGINE_CALCULATION_STATUS_TIMEOUT,
    OPERATION_DATASET_PRECHECK,
    OPERATION_DATASET_RUN,
    OPERATION_EXCHANGE,
    OUTPUT_VARIANT_CANONICAL,
    OUTPUT_VARIANT_TEMPORARY_VIEW,
    EngineCalculationContractError,
    build_engine_calculation_request,
    build_engine_calculation_response,
    clamp_engine_calculation_wait,
    engine_function_of,
)
from arcrho_hosted_save_http_contract import HostedSaveHttpContractError

from app_server import config
from app_server.helpers import (
    build_engine_request_info,
    is_network_path,
    send_request_like_vba,
    set_data_path_like_vba,
    wait_for_file,
)
from app_server.services import (
    client_save_latency_log_service,
    user_identity_service,
    workspace_read_client,
)
from app_server.services.workspace_read_client import (
    TRANSPORT_HTTP,
    TRANSPORT_LOCAL,
    GatewayTransportFailure,
    cached_gateway_capabilities,
    post_signed_json,
    rebase_workspace_paths,
)


# Diagnostics record kind in ``client_read_latency.jsonl``.
LATENCY_LOG_KIND = "engine_calculation"
# After the Gateway reports the CSV written on the server, this PC's SMB
# redirector may still hold a cached "not found" for the path the caller
# checked before requesting; ``wait_for_file`` busts that cache with a probe
# write, and a result that stays invisible this long is reported as a timeout.
ENGINE_OUTPUT_VISIBILITY_TIMEOUT_SECONDS = 10.0
STATUS_GATEWAY_ERROR = "gateway_error"
# A hosted dataset run may chain several Engine exchanges (headers,
# calculated inputs, the dataset) plus the sidecar write and dependent
# enqueue; it gets the same budget a hosted workspace read does.
WORKSPACE_OPERATION_TIMEOUT_SECONDS = 120.0


def publish_and_wait(pairs: Sequence[Sequence[str]], data_path: str, timeout_sec: float) -> Dict[str, Any]:
    """Publish one Engine request file and wait for its CSV on this host."""

    started_ns = time.perf_counter_ns()
    request_file = send_request_like_vba(build_engine_request_info(list(pairs), data_path))
    ok = wait_for_file(data_path, timeout_sec=max(0.1, float(timeout_sec)))
    return {
        "ok": bool(ok),
        "status": ENGINE_CALCULATION_STATUS_COMPLETED if ok else ENGINE_CALCULATION_STATUS_TIMEOUT,
        "request_file": request_file,
        "wait_ms": (time.perf_counter_ns() - started_ns) / 1_000_000.0,
    }


def resolve_engine_output_path(pairs: Sequence[Sequence[str]], output_variant: str) -> str:
    """Return the CSV path the Engine writes for ``pairs`` on this host."""

    normalized_pairs = [(str(key), str(value)) for key, value in pairs]
    try:
        data_path = set_data_path_like_vba(normalized_pairs)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    variant = str(output_variant or OUTPUT_VARIANT_CANONICAL)
    if variant == OUTPUT_VARIANT_CANONICAL:
        return data_path
    if variant == OUTPUT_VARIANT_TEMPORARY_VIEW:
        # The runtime service owns the Temporary view cache location; import it
        # here because it is the module that calls this one.
        from app_server.services import arcrho_runtime_service

        return arcrho_runtime_service.temporary_dataset_path(data_path, normalized_pairs)
    raise HTTPException(400, f"Unknown engine-calculation output variant: {variant!r}")


def execute_hosted_engine_calculation(
    pairs: Sequence[Sequence[str]],
    timeout_sec: float,
    output_variant: str = OUTPUT_VARIANT_CANONICAL,
    operation: str = OPERATION_EXCHANGE,
    options: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Run one calculation operation on this host for a remote client.

    The Gateway calls this against server-local disk under the requesting
    user's identity. The output location is derived here from the logical
    pairs, never taken from the client. ``exchange`` publishes and waits;
    the dataset operations run the unchanged ``arcrho_runtime_service`` route
    and return its response verbatim.
    """

    settings = dict(options or {})
    if operation == OPERATION_EXCHANGE:
        data_path = resolve_engine_output_path(pairs, output_variant)
        try:
            os.makedirs(os.path.dirname(data_path), exist_ok=True)
        except OSError as exc:
            raise HTTPException(500, f"Failed to create the ArcRho data folder: {exc}") from exc
        result = publish_and_wait(pairs, data_path, clamp_engine_calculation_wait(timeout_sec))
        return build_engine_calculation_response(
            ok=result["ok"],
            data_path=data_path,
            request_file=result["request_file"],
            wait_ms=result["wait_ms"],
        )
    # The runtime service is the module that calls this one for the exchange;
    # import it here for the routes it owns.
    from app_server.services import arcrho_runtime_service

    normalized_pairs = [(str(key), str(value)) for key, value in pairs]
    data_path = resolve_engine_output_path(normalized_pairs, OUTPUT_VARIANT_CANONICAL)
    if operation == OPERATION_DATASET_RUN:
        return arcrho_runtime_service.run_arcrho_tri(
            normalized_pairs,
            data_path,
            timeout_sec=clamp_engine_calculation_wait(timeout_sec),
            force_refresh=bool(settings.get("force_refresh", False)),
            local_only=bool(settings.get("local_only", False)),
            allow_derived=bool(settings.get("allow_derived", True)),
            write_sidecar=bool(settings.get("write_sidecar", True)),
            temporary_session_id=settings.get("temporary_session_id") or None,
        )
    if operation == OPERATION_DATASET_PRECHECK:
        return arcrho_runtime_service.arcrho_precheck(
            data_path,
            normalized_pairs,
            local_only=bool(settings.get("local_only", False)),
            allow_derived=bool(settings.get("allow_derived", True)),
            temporary_session_id=settings.get("temporary_session_id") or None,
            allow_runtime_cache_provenance=bool(settings.get("allow_runtime_cache_provenance", False)),
        )
    raise HTTPException(400, f"Unknown engine-calculation operation: {operation!r}")


def _advertises(capabilities: Mapping[str, Any] | None, field: str, value: str) -> bool:
    if not isinstance(capabilities, Mapping):
        return False
    advertised = capabilities.get(field)
    if not isinstance(advertised, (list, tuple)):
        return False
    return str(value) in {str(item) for item in advertised}


def gateway_supports_engine_function(capabilities: Mapping[str, Any] | None, function: str) -> bool:
    return _advertises(capabilities, ENGINE_CALCULATION_CAPABILITY_FIELD, function)


def gateway_supports_operation(capabilities: Mapping[str, Any] | None, operation: str) -> bool:
    return _advertises(capabilities, ENGINE_CALCULATION_OPERATION_FIELD, operation)


def _client_workspace_root() -> str:
    try:
        return config.get_root_path()
    except Exception:
        return ""


def _same_path(left: str, right: str) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _object_name(pairs: Sequence[Sequence[str]]) -> str:
    for wanted in ("InstanceName", "DatasetName", "TriangleName", "VectorName", "PeriodLength"):
        for key, value in pairs:
            if str(key).strip().casefold() == wanted.casefold() and str(value).strip():
                return str(value).strip()
    return ""


def _pair(pairs: Sequence[Sequence[str]], wanted: str) -> str:
    for key, value in pairs:
        if str(key).strip().casefold() == wanted.casefold():
            return str(value).strip()
    return ""


def _select_transport(
    data_path: str, function: str, operation: str, context: Dict[str, Any]
) -> Mapping[str, Any]:
    """Fill ``context['reason']`` when the operation must run locally; return the gateway config."""

    gateway_config: Mapping[str, Any] = {"enabled": False}
    if not is_network_path(data_path):
        # A local CSV wait is a file-system event; nothing to gain remotely.
        context["reason"] = "local_path"
    elif workspace_read_client._is_server_process():
        context["reason"] = "server_process"
    else:
        try:
            gateway_config = config.load_gateway_config()
        except HostedSaveHttpContractError:
            context["reason"] = "gateway_config_invalid"
        else:
            if gateway_config.get("enabled") is not True:
                context["reason"] = "gateway_disabled"
    if not context["reason"]:
        capabilities = cached_gateway_capabilities(gateway_config)
        if capabilities is None:
            context["reason"] = "gateway_unreachable"
        elif not gateway_supports_engine_function(capabilities, function):
            context["reason"] = "function_not_advertised"
        elif operation != OPERATION_EXCHANGE and not gateway_supports_operation(
            capabilities, operation
        ):
            context["reason"] = "operation_not_advertised"
    return gateway_config


def _local_outcome(result: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "ok": bool(result["ok"]),
        "status": str(result["status"]),
        "request_file": result.get("request_file"),
        "transport": TRANSPORT_LOCAL,
    }


def run_engine_calculation(
    pairs: Sequence[Sequence[str]],
    data_path: str,
    timeout_sec: float,
    *,
    output_variant: str = OUTPUT_VARIANT_CANONICAL,
) -> Dict[str, Any]:
    """Publish one Engine request and wait for ``data_path``, via the Gateway when it pays.

    Returns ``ok``, ``status`` (``completed`` / ``timeout`` / ``gateway_error``),
    ``request_file``, ``transport``, and — for a failure the caller should show
    — ``message``. A refusal raised by the hosted exchange itself (a project the
    server cannot find, an invalid variant) is raised as the same
    ``HTTPException`` the local exchange would have raised.
    """

    started_ns = time.perf_counter_ns()
    function = engine_function_of(pairs)
    context: Dict[str, Any] = {
        "read_kind": LATENCY_LOG_KIND,
        "engine_function": function,
        "transport": TRANSPORT_LOCAL,
        "reason": "",
        "project_name": _pair(pairs, "ProjectName"),
        "reserving_class": _pair(pairs, "Path"),
        "object_name": _object_name(pairs),
        "request_id": "",
    }
    outcome_status = "error"
    http_status = 500
    remote_ms: float | None = None
    response_bytes = 0
    wait_ms: float | None = None

    def _finish(result: Dict[str, Any]) -> Dict[str, Any]:
        nonlocal outcome_status, http_status
        outcome_status = str(result.get("status") or "")
        http_status = 200
        return result

    try:
        gateway_config = _select_transport(data_path, function, OPERATION_EXCHANGE, context)
        if not context["reason"]:
            request_id = uuid.uuid4().hex
            context["request_id"] = request_id
            wait_seconds = clamp_engine_calculation_wait(max(0.1, float(timeout_sec)))
            try:
                request_payload = build_engine_calculation_request(
                    request_id=request_id,
                    pairs=[[str(key), str(value)] for key, value in pairs],
                    timeout_sec=wait_seconds,
                    user_name=str(gateway_config["user"]),
                    user_display_name=user_identity_service.get_current_identity()["display_name"],
                    output_variant=str(output_variant or OUTPUT_VARIANT_CANONICAL),
                )
            except EngineCalculationContractError:
                # This request cannot travel; the local exchange still can.
                context["reason"] = "request_not_hostable"
            else:
                remote_started_ns = time.perf_counter_ns()
                try:
                    payload, server_root, response_bytes = post_signed_json(
                        gateway_config,
                        ENGINE_CALCULATION_PATH,
                        request_payload,
                        timeout=wait_seconds + ENGINE_CALCULATION_HTTP_TIMEOUT_MARGIN_SECONDS,
                    )
                except GatewayTransportFailure as failure:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    if failure.accepted:
                        # The server may already have published the request;
                        # a second request file must not be written.
                        context["transport"] = TRANSPORT_HTTP
                        context["reason"] = failure.reason
                        return _finish(
                            {
                                "ok": False,
                                "status": (
                                    ENGINE_CALCULATION_STATUS_TIMEOUT
                                    if failure.timed_out
                                    else STATUS_GATEWAY_ERROR
                                ),
                                "request_file": None,
                                "transport": TRANSPORT_HTTP,
                                "message": (
                                    "The ArcRho Server took too long to finish this calculation. "
                                    "Verify the data engine is running, then try again."
                                    if failure.timed_out
                                    else "The ArcRho Server connection failed while waiting for "
                                    "this calculation. Try again in a moment."
                                ),
                            }
                        )
                    context["reason"] = failure.reason
                except HTTPException:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    context["transport"] = TRANSPORT_HTTP
                    raise
                else:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    context["transport"] = TRANSPORT_HTTP
                    payload = rebase_workspace_paths(payload, server_root, _client_workspace_root())
                    wait_ms = payload.get("wait_ms")
                    server_data_path = str(payload.get("data_path") or "")
                    if not _same_path(server_data_path, data_path):
                        raise HTTPException(
                            500,
                            "The ArcRho Server resolved this calculation to a different output "
                            "location than this PC. Check that both use the same workspace.",
                        )
                    result = {
                        "ok": bool(payload.get("ok")),
                        "status": str(payload.get("status") or STATUS_GATEWAY_ERROR),
                        "request_file": payload.get("request_file"),
                        "transport": TRANSPORT_HTTP,
                    }
                    if result["ok"] and not wait_for_file(
                        data_path, timeout_sec=ENGINE_OUTPUT_VISIBILITY_TIMEOUT_SECONDS
                    ):
                        result.update(
                            ok=False,
                            status=ENGINE_CALCULATION_STATUS_TIMEOUT,
                            message=(
                                "The ArcRho Server finished this calculation but its output is "
                                "not yet visible on this PC's network drive. Try again."
                            ),
                        )
                    return _finish(result)
        return _finish(_local_outcome(publish_and_wait(pairs, data_path, timeout_sec)))
    except HTTPException as error:
        http_status = int(error.status_code)
        raise
    finally:
        record = dict(context)
        record.update(
            {
                "outcome": outcome_status,
                "http_status": http_status,
                "total_ms": round((time.perf_counter_ns() - started_ns) / 1_000_000.0, 3),
                "remote_ms": round(remote_ms, 3) if remote_ms is not None else None,
                "server_wait_ms": wait_ms,
                "response_bytes": response_bytes,
            }
        )
        client_save_latency_log_service.append_client_read_latency(record)


def _register_hosted_dataset_handle(payload: Mapping[str, Any]) -> None:
    """Adopt the dataset handle a hosted run registered on the server."""

    ds_id = str(payload.get("ds_id") or "").strip()
    data_path = str(payload.get("data_path") or "").strip()
    if ds_id and data_path and payload.get("ok"):
        from app_server.services import dataset_service

        dataset_service.register_dataset_handle(ds_id, data_path)


def run_hosted_dataset_operation(
    operation: str,
    pairs: Sequence[Sequence[str]],
    data_path: str,
    options: Mapping[str, Any],
    *,
    timeout_sec: float,
    local: Callable[[], Dict[str, Any]],
) -> Dict[str, Any]:
    """Serve one ``dataset_run`` / ``dataset_precheck`` on the Gateway when possible, else locally.

    ``local`` runs the canonical ``arcrho_runtime_service`` route in this
    process. A hosted response is returned verbatim with its server paths
    rebased onto this PC's workspace root; a successful run's dataset handle is
    registered here so the id-addressed grid routes keep working. A refusal
    the hosted route raised passes through with its own status. Once the
    Gateway may have accepted the request the route is not re-run locally: a
    timeout or lost connection surfaces as ``504`` and the user retries.
    """

    started_ns = time.perf_counter_ns()
    function = engine_function_of(pairs)
    context: Dict[str, Any] = {
        "read_kind": LATENCY_LOG_KIND,
        "engine_function": function,
        "operation": operation,
        "transport": TRANSPORT_LOCAL,
        "reason": "",
        "project_name": _pair(pairs, "ProjectName"),
        "reserving_class": _pair(pairs, "Path"),
        "object_name": _object_name(pairs),
        "request_id": "",
    }
    outcome_status = "error"
    http_status = 500
    remote_ms: float | None = None
    response_bytes = 0

    def _finish(result: Dict[str, Any]) -> Dict[str, Any]:
        nonlocal outcome_status, http_status
        outcome_status = "success" if result.get("ok") else str(result.get("status") or "not_ok")
        http_status = 200
        return result

    try:
        gateway_config = _select_transport(data_path, function, operation, context)
        if not context["reason"]:
            request_id = uuid.uuid4().hex
            context["request_id"] = request_id
            wait_seconds = clamp_engine_calculation_wait(max(0.1, float(timeout_sec)))
            try:
                request_payload = build_engine_calculation_request(
                    request_id=request_id,
                    pairs=[[str(key), str(value)] for key, value in pairs],
                    timeout_sec=wait_seconds,
                    user_name=str(gateway_config["user"]),
                    user_display_name=user_identity_service.get_current_identity()["display_name"],
                    operation=operation,
                    options=options,
                )
            except EngineCalculationContractError:
                context["reason"] = "request_not_hostable"
            else:
                remote_started_ns = time.perf_counter_ns()
                try:
                    payload, server_root, response_bytes = post_signed_json(
                        gateway_config,
                        ENGINE_CALCULATION_PATH,
                        request_payload,
                        # A run may chain several Engine exchanges plus the
                        # sidecar and dependent work; allow the route its
                        # own budget on top of one exchange wait.
                        timeout=WORKSPACE_OPERATION_TIMEOUT_SECONDS,
                    )
                except GatewayTransportFailure as failure:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    if failure.accepted:
                        context["transport"] = TRANSPORT_HTTP
                        context["reason"] = failure.reason
                        raise HTTPException(
                            504,
                            "The ArcRho Server took too long to finish this dataset request. "
                            "Reload the dataset before retrying.",
                        ) from failure
                    context["reason"] = failure.reason
                except HTTPException:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    context["transport"] = TRANSPORT_HTTP
                    raise
                else:
                    remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                    context["transport"] = TRANSPORT_HTTP
                    payload = rebase_workspace_paths(payload, server_root, _client_workspace_root())
                    if operation == OPERATION_DATASET_RUN:
                        _register_hosted_dataset_handle(payload)
                    return _finish(payload)
        return _finish(local())
    except HTTPException as error:
        http_status = int(error.status_code)
        raise
    finally:
        record = dict(context)
        record.update(
            {
                "outcome": outcome_status,
                "http_status": http_status,
                "total_ms": round((time.perf_counter_ns() - started_ns) / 1_000_000.0, 3),
                "remote_ms": round(remote_ms, 3) if remote_ms is not None else None,
                "response_bytes": response_bytes,
            }
        )
        client_save_latency_log_service.append_client_read_latency(record)
