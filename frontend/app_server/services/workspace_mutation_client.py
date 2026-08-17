"""Client-PC transport selection for Server-hosted workspace mutations.

A registered mutation (``arcrho_workspace_mutation_contract``) runs on the
ArcRho Server host through the Gateway when the gateway advertises it, and
locally over the mapped drive otherwise. Deleting a reserving class's cached
files is the first such kind: every unlink is its own SMB round trip and the
index rebuild that follows reads the whole folder again, so a delete a user
waits seconds for on a Client PC is milliseconds of local disk on the server.

The transport reuses the read transport's signing, capability probe, and path
rebasing. What it does not reuse is the fallback: a read may be re-answered
locally after any gateway failure because it changes nothing, while a mutation
may only fall back when the failure proves the server never acted. Once the
request has been accepted, an ambiguous outcome is reported to the user rather
than re-run against the mapped drive, because the local run would be reasoning
about a workspace the server has already changed.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable, Dict, Mapping

from fastapi import HTTPException

from arcrho_hosted_save_http_contract import HostedSaveHttpContractError
from arcrho_workspace_mutation_contract import (
    WORKSPACE_MUTATION_CAPABILITY_FIELD,
    WORKSPACE_MUTATION_PATH,
    WORKSPACE_MUTATION_TIMEOUT_SECONDS,
    WorkspaceMutationContractError,
    build_workspace_mutation_request,
)

from app_server import config
from app_server.services import user_identity_service, workspace_read_client
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


def run_workspace_mutation(
    mutation_kind: str,
    kwargs: Mapping[str, Any],
    *,
    local: Callable[[], Dict[str, Any]],
) -> Dict[str, Any]:
    """Serve one registered mutation over the gateway when possible, else locally.

    ``local`` runs the canonical service function in this process. It is used
    only when the gateway is unavailable, disabled, or has not advertised the
    kind — never after a request the server may already have acted on.
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
        gateway_config: Mapping[str, Any] = {"enabled": False}
        if workspace_read_client._is_server_process():
            # The gateway executes this very service function; routing back to
            # itself would be an infinite hop.
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
            capabilities = workspace_read_client.cached_gateway_capabilities(gateway_config)
            if capabilities is None:
                context["reason"] = "gateway_unreachable"
            elif not gateway_supports_mutation_kind(capabilities, mutation_kind):
                context["reason"] = "kind_not_advertised"
        request_payload: Mapping[str, Any] | None = None
        if not context["reason"]:
            request_id = uuid.uuid4().hex
            context["request_id"] = request_id
            try:
                request_payload = build_workspace_mutation_request(
                    request_id=request_id,
                    mutation_kind=mutation_kind,
                    kwargs=kwargs,
                    user_name=str(gateway_config["user"]),
                    user_display_name=user_identity_service.get_current_identity()["display_name"],
                )
            except WorkspaceMutationContractError:
                # Nothing was sent, so the canonical service still owns this
                # request's answer: running it locally reports the same refusal
                # a Client PC without a gateway would have seen, rather than
                # turning a bad argument into a transport-shaped 500.
                context["reason"] = "contract_rejected"
        if request_payload is not None:
            remote_started_ns = time.perf_counter_ns()
            try:
                payload, server_root, response_bytes = workspace_read_client.post_signed_json(
                    gateway_config,
                    WORKSPACE_MUTATION_PATH,
                    request_payload,
                    timeout=WORKSPACE_MUTATION_TIMEOUT_SECONDS,
                )
            except GatewayTransportFailure as failure:
                remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                if failure.accepted:
                    # The server may already have applied this. Running it here
                    # as well would report on a workspace it no longer owns
                    # alone, so the user is told to reload and look instead.
                    context["transport"] = TRANSPORT_HTTP
                    context["reason"] = failure.reason
                    raise HTTPException(
                        504,
                        "The ArcRho Server did not confirm this change. "
                        "Refresh the dataset table to see whether it was applied.",
                    ) from failure
                context["reason"] = failure.reason
            except HTTPException:
                remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                context["transport"] = TRANSPORT_HTTP
                raise
            else:
                remote_ms = (time.perf_counter_ns() - remote_started_ns) / 1_000_000.0
                context["transport"] = TRANSPORT_HTTP
                payload = workspace_read_client.rebase_workspace_paths(
                    payload, server_root, workspace_read_client._client_workspace_root()
                )
                return _finish(payload)
        return _finish(local())
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
