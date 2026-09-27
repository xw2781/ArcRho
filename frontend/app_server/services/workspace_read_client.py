"""Client-PC transport for Server-hosted workspace reads.

A registered read (``arcrho_workspace_read_contract``) runs on the Arco
Server host through the Gateway. A Client PC has no other way to the
workspace: when the Gateway is not signed in, does not answer, or does not
offer the read, the user is told so (:func:`require_client_gateway`) and
nothing is read over the share. Only a server process (Engine, Gateway,
Bridge), which runs these very service functions against its own disk, runs
the read in place. The transport used is recorded in the client read-latency
log.

A gateway response carries the workspace root the read ran against. Any
machine-local path in the payload (index folder paths, the cached CSV path,
the master table path) is rebased onto this PC's own workspace root before it
reaches the browser, so the response is indistinguishable from a local read.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from typing import Any, Callable, Dict, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request

from fastapi import HTTPException

from arcrho_api import config as api_config
from arcrho_api.gateway_test_guard import gateway_opener
from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    HostedSaveHttpContractError,
    canonical_request_bytes,
    sign_request,
)
from arcrho_workspace_read_contract import (
    WORKSPACE_READ_PATH,
    WORKSPACE_READ_TIMEOUT_SECONDS,
    WORKSPACE_ROOT_HEADER,
    WorkspaceReadContractError,
    build_workspace_read_request,
)

from app_server import config
from app_server.services import (
    client_save_latency_log_service,
    hosted_save_http_client,
)
from app_server.services.hosted_save_http_client import (
    NOT_SIGNED_IN_MESSAGE,
    SERVER_UNREACHABLE_MESSAGE,
    SERVER_UPDATE_MESSAGE,
    SIGN_IN_MESSAGE,
)


TRANSPORT_HTTP = "http_gateway"
TRANSPORT_LOCAL = "smb"
# A successful probe is trusted for this long before the gateway is asked
# again which reads it serves; a failed probe is remembered briefly so a
# stopped gateway does not cost every read its connection timeout.
CAPABILITY_CACHE_SECONDS = 30.0
CAPABILITY_FAILURE_CACHE_SECONDS = 10.0

_CAPABILITY_LOCK = threading.Lock()
_CAPABILITY_CACHE: Dict[str, tuple[float, Dict[str, Any] | None]] = {}
_DIRECT_HTTP_OPENER = gateway_opener()


def _error_detail(error: HTTPError) -> Any:
    """Return the refusal's ``detail`` in the shape the local route would raise.

    Usually that is text. A hosted operation whose refusal the caller acts on
    rather than merely displays answers with an object instead — the cached
    dataset delete returns the dependents that blocked it — and flattening that
    to ``str`` would leave the browser a Python repr to parse.
    """

    try:
        payload = json.loads(error.read().decode("utf-8"))
    except Exception:
        payload = {}
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, (dict, list)):
            return detail
        text = str(detail or payload.get("message") or "").strip()
        if text:
            return text
    return f"Arco Server returned HTTP {error.code}."


def reset_capability_cache() -> None:
    with _CAPABILITY_LOCK:
        _CAPABILITY_CACHE.clear()


def cached_gateway_capabilities(gateway_config: Mapping[str, Any]) -> Dict[str, Any] | None:
    """Return the gateway's ``/api/capabilities`` payload, cached; ``None`` when unreachable."""

    url = str(gateway_config["url"])
    now = time.monotonic()
    with _CAPABILITY_LOCK:
        cached = _CAPABILITY_CACHE.get(url)
        if cached is not None and cached[0] > now:
            return cached[1]
    try:
        payload: Dict[str, Any] | None = hosted_save_http_client.probe_gateway(gateway_config)
        ttl = CAPABILITY_CACHE_SECONDS
    except hosted_save_http_client.GatewayServerMismatch:
        # A different server, not an unreachable one: the user must see why.
        raise
    except HTTPException:
        payload = None
        ttl = CAPABILITY_FAILURE_CACHE_SECONDS
    with _CAPABILITY_LOCK:
        _CAPABILITY_CACHE[url] = (time.monotonic() + ttl, payload)
    return payload


def gateway_supports_read_kind(capabilities: Mapping[str, Any] | None, read_kind: str) -> bool:
    if not isinstance(capabilities, Mapping):
        return False
    advertised = capabilities.get("workspace_read_kinds")
    if not isinstance(advertised, (list, tuple)):
        return False
    return str(read_kind) in {str(item) for item in advertised}


def _normalize_root(root: str) -> str:
    return str(root or "").replace("/", "\\").rstrip("\\")


def rebase_workspace_paths(value: Any, server_root: str, client_root: str) -> Any:
    """Return ``value`` with every server-rooted path moved under ``client_root``."""

    source = _normalize_root(server_root)
    target = _normalize_root(client_root)
    if not source or not target or source.casefold() == target.casefold():
        return value
    source_key = source.casefold()
    prefix = source_key + "\\"

    def rebase(item: Any) -> Any:
        if isinstance(item, str):
            candidate = item.replace("/", "\\")
            key = candidate.casefold()
            if key == source_key:
                return target
            if key.startswith(prefix):
                return target + candidate[len(source):]
            return item
        if isinstance(item, list):
            return [rebase(entry) for entry in item]
        if isinstance(item, dict):
            return {name: rebase(entry) for name, entry in item.items()}
        return item

    return rebase(value)


def _client_workspace_root() -> str:
    try:
        return config.get_root_path()
    except Exception:
        return ""


def _log(record: Mapping[str, Any]) -> None:
    client_save_latency_log_service.append_client_read_latency(record)


def _object_name(kwargs: Mapping[str, Any]) -> str:
    for key in ("dataset_name", "method_name"):
        value = str(kwargs.get(key) or "").strip()
        if value:
            return value
    return ""


class GatewayTransportFailure(Exception):
    """The gateway itself, not the operation it hosts, could not serve the request.

    ``accepted`` is True when the server may already have acted on the request
    (the answer timed out or the connection dropped after it was sent), which
    the caller reports as an unconfirmed outcome. It is False when the failure
    came before the server could have acted; :func:`failure_error` is then
    the error the user sees.
    """

    def __init__(self, reason: str, *, timed_out: bool = False, accepted: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.timed_out = timed_out
        self.accepted = accepted or timed_out


def failure_error(failure: GatewayTransportFailure) -> HTTPException:
    """The error for a request the Gateway refused or never received.

    A refused signature (a secret the server no longer knows, another
    server's credential, a clock far off) asks the user to sign in again.
    """

    if failure.reason in ("gateway_rejected:401", "gateway_rejected:403"):
        return HTTPException(401, SIGN_IN_MESSAGE)
    if failure.reason == "gateway_rejected:404":
        return HTTPException(503, SERVER_UPDATE_MESSAGE)
    return HTTPException(503, SERVER_UNREACHABLE_MESSAGE)


def post_signed_json(
    gateway_config: Mapping[str, Any],
    path: str,
    request_payload: Mapping[str, Any],
    *,
    timeout: float,
) -> tuple[Dict[str, Any], str, int]:
    """POST one signed request to the gateway; return (payload, server_root, bytes).

    A refusal raised by the hosted operation itself (404 method not found,
    409 legacy pair, 423 lock, ...) carries the workspace-root header because
    the operation ran; it is the same status the local path would raise, so it
    is raised as that ``HTTPException``. A refusal without that header came
    from the gateway layer (authentication, validation, an older gateway
    without the route) and the operation has not run. Every other failure is a
    ``GatewayTransportFailure`` whose ``accepted`` flag says whether the server
    may already have acted.
    """

    body = canonical_request_bytes(request_payload)
    url = f"{gateway_config['url']}{path}"
    timestamp = str(int(time.time()))
    signature = sign_request(
        gateway_config["secret"],
        user=gateway_config["user"],
        timestamp=timestamp,
        method="POST",
        path=path,
        body=body,
    )
    request = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            AUTH_USER_HEADER: gateway_config["user"],
            AUTH_TIMESTAMP_HEADER: timestamp,
            AUTH_SIGNATURE_HEADER: signature,
        },
    )
    try:
        response = _DIRECT_HTTP_OPENER.open(request, timeout=timeout)
    except HTTPError as exc:
        if exc.headers.get(WORKSPACE_ROOT_HEADER):
            raise HTTPException(int(exc.code), _error_detail(exc)) from exc
        raise GatewayTransportFailure(f"gateway_rejected:{exc.code}") from exc
    except socket.timeout as exc:
        raise GatewayTransportFailure("gateway_timeout", timed_out=True) from exc
    except URLError as exc:
        if isinstance(getattr(exc, "reason", None), socket.timeout):
            raise GatewayTransportFailure("gateway_timeout", timed_out=True) from exc
        raise GatewayTransportFailure("gateway_unreachable") from exc
    except OSError as exc:
        raise GatewayTransportFailure("gateway_unreachable") from exc
    # The server has answered with headers, so it has acted; a body that
    # cannot be read or parsed no longer means the operation did not run.
    try:
        with response:
            raw = response.read()
            server_root = str(response.headers.get(WORKSPACE_ROOT_HEADER) or "")
    except socket.timeout as exc:
        raise GatewayTransportFailure("gateway_timeout", timed_out=True) from exc
    except OSError as exc:
        raise GatewayTransportFailure("gateway_connection_lost", accepted=True) from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatewayTransportFailure("gateway_invalid_response", accepted=True) from exc
    if not isinstance(payload, dict):
        raise GatewayTransportFailure("gateway_invalid_response", accepted=True)
    return payload, server_root, len(raw)


def _is_server_process() -> bool:
    # Engine, Bridge, and Gateway processes pin the runtime server root; the
    # gateway executes these very service functions, so it must never route a
    # read back to itself.
    return bool(str(os.environ.get(api_config.RUNTIME_SERVER_ROOT_ENV) or "").strip())


def require_client_gateway(
    context: Dict[str, Any], supports: Callable[[Mapping[str, Any]], bool]
) -> Mapping[str, Any] | None:
    """The Gateway credential a Client PC sends this operation with.

    Returns ``None`` in a server process, which runs the operation itself.
    On a Client PC every reason the Gateway cannot take it is raised as the
    error the user sees: not signed in or a credential that cannot be read
    (401), no answer (503), or a Gateway that does not offer it (503).
    ``context['reason']`` records which, for the latency log.
    """

    if _is_server_process():
        context["reason"] = "server_process"
        return None
    try:
        gateway_config = config.load_gateway_config()
    except HostedSaveHttpContractError as error:
        context["reason"] = "gateway_config_invalid"
        raise HTTPException(401, NOT_SIGNED_IN_MESSAGE) from error
    if gateway_config.get("enabled") is not True:
        context["reason"] = "gateway_disabled"
        raise HTTPException(401, NOT_SIGNED_IN_MESSAGE)
    capabilities = cached_gateway_capabilities(gateway_config)
    if capabilities is None:
        context["reason"] = "gateway_unreachable"
        raise HTTPException(503, SERVER_UNREACHABLE_MESSAGE)
    if not supports(capabilities):
        context["reason"] = "kind_not_advertised"
        raise HTTPException(503, SERVER_UPDATE_MESSAGE)
    return gateway_config


def run_workspace_read(
    read_kind: str,
    kwargs: Mapping[str, Any],
    *,
    local: Callable[[], Dict[str, Any]],
    finalize: Callable[[Dict[str, Any]], Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Serve one registered read over the Gateway, or in place in a server process.

    ``local`` runs the canonical service function and is called only in a
    server process. ``finalize`` runs on a payload that arrived over HTTP so
    the local process can adopt any per-process state the service would have
    registered had it run here.
    """

    started_ns = time.perf_counter_ns()
    context: Dict[str, Any] = {
        "read_kind": str(read_kind),
        "transport": TRANSPORT_LOCAL,
        "reason": "",
        "project_name": str(kwargs.get("project_name") or "").strip(),
        "reserving_class": str(kwargs.get("reserving_class") or "").strip(),
        "object_name": _object_name(kwargs),
        "request_id": "",
    }
    outcome = "error"
    http_status = 500
    remote_ms: float | None = None
    response_bytes = 0

    def _finish(result: Dict[str, Any]) -> Dict[str, Any]:
        nonlocal outcome, http_status
        outcome = "success"
        http_status = 200
        return result

    try:
        gateway_config = require_client_gateway(
            context, lambda capabilities: gateway_supports_read_kind(capabilities, read_kind)
        )
        if gateway_config is None:
            return _finish(local())
        request_id = uuid.uuid4().hex
        context["request_id"] = request_id
        request_payload = build_workspace_read_request(
            request_id=request_id,
            read_kind=read_kind,
            kwargs=kwargs,
            user_name=str(gateway_config["user"]),
            # The server resolves the signed login's display name.
            user_display_name="",
        )
        remote_started_ns = time.perf_counter_ns()
        try:
            payload, server_root, response_bytes = post_signed_json(
                gateway_config,
                WORKSPACE_READ_PATH,
                request_payload,
                timeout=WORKSPACE_READ_TIMEOUT_SECONDS,
            )
        except GatewayTransportFailure as failure:
            remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
            context["transport"] = TRANSPORT_HTTP
            context["reason"] = failure.reason
            if failure.timed_out:
                raise HTTPException(
                    504, "The Arco Server took too long to answer this read. Try again in a moment."
                ) from failure
            raise failure_error(failure) from failure
        except HTTPException:
            remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
            context["transport"] = TRANSPORT_HTTP
            raise
        remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
        context["transport"] = TRANSPORT_HTTP
        payload = rebase_workspace_paths(payload, server_root, _client_workspace_root())
        if finalize is not None:
            payload = finalize(payload)
        return _finish(payload)
    except WorkspaceReadContractError as error:
        http_status = 400
        raise HTTPException(400, str(error)) from error
    except HTTPException as error:
        http_status = int(error.status_code)
        raise
    finally:
        record = dict(context)
        record.update(
            {
                "outcome": outcome,
                "http_status": http_status,
                "total_ms": round((time.perf_counter_ns() - started_ns) / 1_000_000.0, 3),
                "remote_ms": round(remote_ms, 3) if remote_ms is not None else None,
                "response_bytes": response_bytes,
            }
        )
        _log(record)


def run_polled_workspace_read(
    read_kind: str,
    kwargs: Mapping[str, Any],
    *,
    local: Callable[[], Dict[str, Any]],
    unknown: Dict[str, Any],
) -> Dict[str, Any]:
    """Serve a read that a window polls on a timer.

    The change watches ask whether something moved; when the server cannot be
    asked (not signed in, 401; unreachable, 503) or does not answer in time
    (504) the honest answer is ``unknown``, which the window treats as "ask
    again next poll" and never as an alert or an error. The window's own
    actions show the reason.
    """

    try:
        return run_workspace_read(read_kind, kwargs, local=local)
    except HTTPException as error:
        if error.status_code in (401, 503, 504):
            return {**unknown, "unknown": True}
        raise
