"""Client-PC transport for Server-hosted workspace mutations.

A registered mutation (``arcrho_workspace_mutation_contract``) runs on the
Arco Server host through the Gateway. A Client PC never writes the workspace
itself: a Gateway that is not signed in, does not answer, or does not offer
the kind is reported to the user, exactly as a read is. Only a server process
runs the mutation in place.

The transport reuses the read transport's signing, capability probe, and path
rebasing. Once the request has been accepted, an ambiguous outcome is
reported as unconfirmed, because the server may already have applied it.

A kind the contract marks ``receipt`` is not idempotent. The caller names the
user's action with one request id, and when the answer is lost after the
server had the request the transport sends that same request once more: the
Gateway answers the repeat from its receipt, so the change is never applied
twice and the user still learns its outcome.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable, Dict, Mapping

from fastapi import HTTPException

from arcrho_workspace_mutation_contract import (
    WORKSPACE_MUTATION_CAPABILITY_FIELD,
    WORKSPACE_MUTATION_KINDS,
    WORKSPACE_MUTATION_PATH,
    WORKSPACE_MUTATION_TIMEOUT_SECONDS,
    WorkspaceMutationContractError,
    build_workspace_mutation_request,
)

from app_server.services import project_lock_service, workspace_read_client
from app_server.services.workspace_read_client import (
    GatewayTransportFailure,
    TRANSPORT_HTTP,
    TRANSPORT_LOCAL,
)


def gateway_supports_mutation_kind(
    capabilities: Mapping[str, Any] | None,
    mutation_kind: str,
) -> bool:
    if not isinstance(capabilities, Mapping):
        return False
    advertised = capabilities.get(WORKSPACE_MUTATION_CAPABILITY_FIELD)
    if not isinstance(advertised, (list, tuple)):
        return False
    return str(mutation_kind) in {str(item) for item in advertised}


def _post_mutation(
    gateway_config: Mapping[str, Any],
    mutation_kind: str,
    request_payload: Mapping[str, Any],
) -> tuple[Dict[str, Any], str, int]:
    """Send one mutation; a receipt kind whose answer was lost is asked once more.

    The repeat carries the same request id, so the Gateway answers it from the
    first run's receipt. A timeout is not repeated: the first run may still be
    working, and the repeat would only wait on it for another full budget.
    """

    attempts = 2 if WORKSPACE_MUTATION_KINDS[mutation_kind].receipt else 1
    for attempt in range(1, attempts + 1):
        try:
            return workspace_read_client.post_signed_json(
                gateway_config,
                WORKSPACE_MUTATION_PATH,
                request_payload,
                timeout=WORKSPACE_MUTATION_TIMEOUT_SECONDS,
            )
        except GatewayTransportFailure as failure:
            if attempt == attempts or not failure.accepted or failure.timed_out:
                raise
    raise AssertionError("unreachable")


def run_workspace_mutation(
    mutation_kind: str,
    kwargs: Mapping[str, Any],
    *,
    local: Callable[[], Dict[str, Any]],
    request_id: str | None = None,
) -> Dict[str, Any]:
    """Serve one registered mutation over the Gateway, or in place in a server process.

    ``local`` runs the canonical service function and is called only in a
    server process. ``request_id`` names the user's action for a receipt
    kind; a fresh one is used when the caller has none.
    """

    started_ns = time.perf_counter_ns()
    context: Dict[str, Any] = {
        "read_kind": f"mutation:{mutation_kind}",
        "transport": TRANSPORT_LOCAL,
        "reason": "",
        "project_name": str(kwargs.get("project_name") or "").strip(),
        "reserving_class": str(kwargs.get("reserving_class") or "").strip(),
        "object_name": "",
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
        gateway_config = workspace_read_client.require_client_gateway(
            context, lambda capabilities: gateway_supports_mutation_kind(capabilities, mutation_kind)
        )
        if gateway_config is None:
            # The Gateway checks the project lock itself before it runs a kind.
            project_lock_service.require_mutation_allowed(mutation_kind, kwargs)
            return _finish(local())
        request_id = str(request_id or "").strip() or uuid.uuid4().hex
        context["request_id"] = request_id
        try:
            request_payload = build_workspace_mutation_request(
                request_id=request_id,
                mutation_kind=mutation_kind,
                kwargs=kwargs,
                user_name=str(gateway_config["user"]),
                # The server resolves the signed login's display name.
                user_display_name="",
            )
        except WorkspaceMutationContractError as error:
            raise HTTPException(400, str(error)) from error
        remote_started_ns = time.perf_counter_ns()
        try:
            payload, server_root, response_bytes = _post_mutation(
                gateway_config, mutation_kind, request_payload
            )
        except GatewayTransportFailure as failure:
            remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
            context["transport"] = TRANSPORT_HTTP
            context["reason"] = failure.reason
            if failure.accepted:
                # The server may already have applied this, so the user is told
                # to reload and look rather than to try again blindly.
                raise HTTPException(
                    504,
                    "The Arco Server did not confirm this change. "
                    "Refresh the dataset table to see whether it was applied.",
                ) from failure
            raise workspace_read_client.failure_error(failure) from failure
        except HTTPException:
            remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
            context["transport"] = TRANSPORT_HTTP
            raise
        remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
        context["transport"] = TRANSPORT_HTTP
        payload = workspace_read_client.rebase_workspace_paths(
            payload, server_root, workspace_read_client._client_workspace_root()
        )
        return _finish(payload)
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
        workspace_read_client._log(record)
