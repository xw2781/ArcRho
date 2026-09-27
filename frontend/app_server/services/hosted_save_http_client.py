"""Client-PC HTTP transport for Engine-hosted save requests."""

from __future__ import annotations

import json
import os
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request

from fastapi import HTTPException

from arcrho_api import config as api_config
from arcrho_api.gateway_test_guard import gateway_opener
from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    CAPABILITIES_PATH,
    HEALTH_PATH,
    HOSTED_SAVE_PATH,
    HOSTED_SAVE_PROGRESS_PATH,
    canonical_request_bytes,
    sign_request,
)

from app_server import config


GATEWAY_HEALTH_TIMEOUT_SECONDS = 2.0
GATEWAY_PROGRESS_TIMEOUT_SECONDS = 2.0
GATEWAY_RETRY_DELAY_SECONDS = 0.5
_DIRECT_HTTP_OPENER = gateway_opener()
# A root's server id is written once, so a found id is kept for the process;
# a root without one is asked again after this long.
ROOT_SERVER_ID_RETRY_SECONDS = 30.0
_ROOT_SERVER_IDS: dict[str, tuple[float, str]] = {}
SERVER_MISMATCH_MESSAGE = (
    "This app is signed in to a different server than the folder it is pointed at. "
    "Open the Server tab and switch servers again."
)


class GatewayServerMismatch(HTTPException):
    """The Gateway serves a different server from the folder this app uses.

    Every hosted read, mutation, save and calculation learns the Gateway's
    capabilities through :func:`probe_gateway`, so this is raised there and
    nowhere else. Callers must let it through rather than fall back to the
    share: the folder and the Gateway disagree about which server is meant.
    """

    def __init__(self) -> None:
        super().__init__(409, SERVER_MISMATCH_MESSAGE)


def _response_json(response: Any) -> dict[str, Any]:
    payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Gateway response must be an object.")
    return payload


def _error_detail(error: HTTPError) -> str:
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except Exception:
        payload = {}
    if isinstance(payload, dict):
        detail = str(payload.get("detail") or payload.get("message") or "").strip()
        if detail:
            return detail
    return f"Gateway returned HTTP {error.code}."


def root_server_id(root: str) -> str:
    key = str(root).casefold()
    cached = _ROOT_SERVER_IDS.get(key)
    if cached is not None and (cached[1] or cached[0] > time.monotonic()):
        return cached[1]
    server_id = api_config.read_server_id(root)
    _ROOT_SERVER_IDS[key] = (time.monotonic() + ROOT_SERVER_ID_RETRY_SECONDS, server_id)
    return server_id


def require_same_server(capabilities: Mapping[str, Any]) -> None:
    """Refuse a Gateway whose server id differs from the active root's.

    Both sides lacking an id is the one agreement allowed without one: it is a
    server whose Gateway predates server ids. A Gateway reporting no id for a
    root that has one is a different server or a stale Gateway, and refused.
    Server processes run against their own root and skip the check.
    """

    if str(os.environ.get(api_config.RUNTIME_SERVER_ROOT_ENV) or "").strip():
        return
    reported = str(capabilities.get(api_config.SERVER_ID_KEY) or "").strip()
    if reported != root_server_id(config.get_root_path()):
        raise GatewayServerMismatch()


def probe_gateway_health(url: str) -> None:
    """Raise unless the Gateway at ``url`` answers its unauthenticated health check."""

    request = Request(f"{url}{HEALTH_PATH}", method="GET", headers={"Accept": "application/json"})
    with _DIRECT_HTTP_OPENER.open(request, timeout=GATEWAY_HEALTH_TIMEOUT_SECONDS) as response:
        if _response_json(response).get("ok") is not True:
            raise ValueError("Gateway health check did not report ok.")


def probe_gateway_identity(url: str) -> dict[str, Any]:
    """The Gateway's capabilities, refused unless it serves this app's server.

    Sign-up probes with this: it needs the same server check as every other
    use, but not a Gateway that already has users.
    """

    request = Request(f"{url}{CAPABILITIES_PATH}", method="GET", headers={"Accept": "application/json"})
    try:
        with _DIRECT_HTTP_OPENER.open(
            request, timeout=GATEWAY_HEALTH_TIMEOUT_SECONDS
        ) as response:
            payload = _response_json(response)
    except (OSError, URLError, ValueError) as exc:
        raise HTTPException(
            503,
            "Arco Gateway is unavailable. The dataset remains unsaved.",
        ) from exc
    require_same_server(payload)
    return payload


def probe_gateway(gateway_config: Mapping[str, Any]) -> dict[str, Any]:
    payload = probe_gateway_identity(gateway_config["url"])
    if payload.get("hosted_save_http") is not True:
        raise HTTPException(503, "Arco Gateway is not ready for dataset saves.")
    return payload


def gateway_supports_save_kind(
    capabilities: Mapping[str, Any], save_kind: str
) -> bool:
    """Report whether a probed gateway advertises this save kind.

    A gateway deployed before a save kind reached the HTTP transport advertises
    a narrower list than this client knows about. Posting such a kind would be
    refused outright, so the caller keeps it on the SMB transport until the
    gateway is upgraded instead of failing the save.
    """

    advertised = capabilities.get("allowed_save_kinds")
    if not isinstance(advertised, (list, tuple)):
        return False
    return str(save_kind) in {str(item) for item in advertised}


def fetch_hosted_save_progress(
    gateway_config: Mapping[str, Any], request_id: str
) -> dict[str, Any] | None:
    """Ask the Gateway for one save's live status; None on any trouble.

    Called from a UI poll loop while the save request itself is still in
    flight, so it makes exactly one attempt and treats every failure —
    an old Gateway without the endpoint included — as "nothing to show".
    """

    body = json.dumps({"RequestId": str(request_id)}).encode("utf-8")
    url = f"{gateway_config['url']}{HOSTED_SAVE_PROGRESS_PATH}"
    timestamp = str(int(time.time()))
    try:
        signature = sign_request(
            gateway_config["secret"],
            user=gateway_config["user"],
            timestamp=timestamp,
            method="POST",
            path=HOSTED_SAVE_PROGRESS_PATH,
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
        with _DIRECT_HTTP_OPENER.open(
            request, timeout=GATEWAY_PROGRESS_TIMEOUT_SECONDS
        ) as response:
            return _response_json(response)
    except Exception:
        return None


def submit_hosted_save(
    gateway_config: Mapping[str, Any],
    request_payload: Mapping[str, Any],
    *,
    timeout_seconds: float,
) -> tuple[dict[str, Any], dict[str, float | int]]:
    """Submit once logically, retrying uncertain connections with the same ID.

    The caller probes capabilities before choosing this transport, so this
    function costs exactly one request.
    """

    body = canonical_request_bytes(request_payload)
    url = f"{gateway_config['url']}{HOSTED_SAVE_PATH}"
    deadline = time.monotonic() + float(timeout_seconds) + 5.0
    attempts = 0
    transport_started = time.perf_counter_ns()
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        attempts += 1
        timestamp = str(int(time.time()))
        signature = sign_request(
            gateway_config["secret"],
            user=gateway_config["user"],
            timestamp=timestamp,
            method="POST",
            path=HOSTED_SAVE_PATH,
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
        remaining = max(0.1, deadline - time.monotonic())
        try:
            with _DIRECT_HTTP_OPENER.open(request, timeout=remaining) as response:
                payload = _response_json(response)
            return payload, {
                "gateway_round_trip_ms": round(
                    (time.perf_counter_ns() - transport_started) / 1_000_000.0,
                    3,
                ),
                "gateway_attempts": attempts,
                "request_bytes": len(body),
            }
        except HTTPError as exc:
            raise HTTPException(int(exc.code), _error_detail(exc)) from exc
        except (OSError, URLError, ValueError) as exc:
            last_error = exc
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(GATEWAY_RETRY_DELAY_SECONDS, remaining))

    raise HTTPException(
        504,
        "The Gateway response was interrupted. Arco retained the same "
        "request identity while recovering; reload the dataset before saving again.",
    ) from last_error
