"""Client-PC HTTP transport for Engine-hosted save requests."""

from __future__ import annotations

import json
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from fastapi import HTTPException

from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    CAPABILITIES_PATH,
    HOSTED_SAVE_PATH,
    canonical_request_bytes,
    sign_request,
)


GATEWAY_HEALTH_TIMEOUT_SECONDS = 2.0
GATEWAY_RETRY_DELAY_SECONDS = 0.5
_DIRECT_HTTP_OPENER = build_opener(ProxyHandler({}))


def _response_json(response: Any) -> dict[str, Any]:
    payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Save Gateway response must be an object.")
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
    return f"Save Gateway returned HTTP {error.code}."


def probe_gateway(gateway_config: Mapping[str, Any]) -> dict[str, Any]:
    url = f"{gateway_config['url']}{CAPABILITIES_PATH}"
    request = Request(url, method="GET", headers={"Accept": "application/json"})
    try:
        with _DIRECT_HTTP_OPENER.open(
            request, timeout=GATEWAY_HEALTH_TIMEOUT_SECONDS
        ) as response:
            payload = _response_json(response)
    except (OSError, URLError, ValueError) as exc:
        raise HTTPException(
            503,
            "ArcRho Save Gateway is unavailable. The dataset remains unsaved.",
        ) from exc
    if payload.get("hosted_save_http") is not True:
        raise HTTPException(503, "ArcRho Save Gateway is not ready for dataset saves.")
    return payload


def submit_hosted_save(
    gateway_config: Mapping[str, Any],
    request_payload: Mapping[str, Any],
    *,
    timeout_seconds: float,
) -> tuple[dict[str, Any], dict[str, float | int]]:
    """Submit once logically, retrying uncertain connections with the same ID."""

    probe_started = time.perf_counter_ns()
    probe_gateway(gateway_config)
    probe_ms = round((time.perf_counter_ns() - probe_started) / 1_000_000.0, 3)

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
                "gateway_capability_ms": probe_ms,
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
        "The Save Gateway response was interrupted. ArcRho retained the same "
        "request identity while recovering; reload the dataset before saving again.",
    ) from last_error
