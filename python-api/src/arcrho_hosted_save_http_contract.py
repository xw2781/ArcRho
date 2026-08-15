"""Canonical contract for the pilot HTTP transport for Engine-hosted saves.

The logical save payload remains owned by :mod:`arcrho_engine_save_contract`.
This module owns only the HTTP authentication, request fingerprint, gateway
configuration, and durable receipt envelope used to carry that payload.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Mapping


HTTP_CONTRACT_VERSION = 1
GATEWAY_CONFIG_VERSION = 1
RECEIPT_VERSION = 1
HOSTED_SAVE_PATH = "/api/hosted-saves"
CAPABILITIES_PATH = "/api/capabilities"
HEALTH_PATH = "/api/health"
DEFAULT_GATEWAY_HOST = "0.0.0.0"
DEFAULT_GATEWAY_PORT = 28767
DEFAULT_RECEIPT_RETENTION_HOURS = 24
HTTP_PILOT_SAVE_KINDS = ("dataset_sidecar", "dfm_method")
MAX_REQUEST_BYTES = 16 * 1024 * 1024
AUTH_CLOCK_SKEW_SECONDS = 300
AUTH_USER_HEADER = "X-ArcRho-User"
AUTH_TIMESTAMP_HEADER = "X-ArcRho-Timestamp"
AUTH_SIGNATURE_HEADER = "X-ArcRho-Signature"
CLIENT_CONFIG_FILE_NAME = "hosted_save_gateway.json"
SERVER_CONFIG_RELATIVE_PATH = Path("config") / "hosted_save_gateway.json"
RECEIPTS_RELATIVE_PATH = Path("runtime") / "hosted_save_gateway" / "receipts"


class HostedSaveHttpContractError(ValueError):
    """Raised when an HTTP transport payload or configuration is invalid."""


def normalize_user(value: Any) -> str:
    return str(value or "").strip().casefold()


def canonical_request_bytes(payload: Mapping[str, Any]) -> bytes:
    if not isinstance(payload, Mapping):
        raise HostedSaveHttpContractError("Hosted-save request must be an object.")
    return json.dumps(
        dict(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def request_sha256(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_request_bytes(payload)).hexdigest()


def generate_secret() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def _signature_message(
    *, user: str, timestamp: str, method: str, path: str, body: bytes
) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join(
        (
            normalize_user(user),
            str(timestamp).strip(),
            str(method).strip().upper(),
            str(path).strip(),
            body_hash,
        )
    ).encode("utf-8")


def sign_request(
    secret: str,
    *,
    user: str,
    timestamp: str,
    method: str,
    path: str,
    body: bytes,
) -> str:
    key = str(secret or "").encode("utf-8")
    if not key:
        raise HostedSaveHttpContractError("Gateway credential secret is empty.")
    return hmac.new(
        key,
        _signature_message(
            user=user,
            timestamp=timestamp,
            method=method,
            path=path,
            body=body,
        ),
        hashlib.sha256,
    ).hexdigest()


def verify_request_signature(
    secret: str,
    signature: str,
    *,
    user: str,
    timestamp: str,
    method: str,
    path: str,
    body: bytes,
    now: float | None = None,
) -> bool:
    try:
        signed_at = int(str(timestamp).strip())
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else float(now)
    if abs(current - signed_at) > AUTH_CLOCK_SKEW_SECONDS:
        return False
    try:
        expected = sign_request(
            secret,
            user=user,
            timestamp=str(signed_at),
            method=method,
            path=path,
            body=body,
        )
    except HostedSaveHttpContractError:
        return False
    return hmac.compare_digest(expected, str(signature or "").strip().lower())


def default_gateway_config() -> dict[str, Any]:
    return {
        "config_version": GATEWAY_CONFIG_VERSION,
        "host": DEFAULT_GATEWAY_HOST,
        "port": DEFAULT_GATEWAY_PORT,
        "receipt_retention_hours": DEFAULT_RECEIPT_RETENTION_HOURS,
        "allowed_save_kinds": list(HTTP_PILOT_SAVE_KINDS),
        "users": {},
    }


def normalize_gateway_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise HostedSaveHttpContractError("Save Gateway configuration must be an object.")
    if value.get("config_version") != GATEWAY_CONFIG_VERSION:
        raise HostedSaveHttpContractError(
            f"Unsupported Save Gateway config version: {value.get('config_version')!r}."
        )
    host = str(value.get("host") or DEFAULT_GATEWAY_HOST).strip()
    try:
        port = int(value.get("port", DEFAULT_GATEWAY_PORT))
        retention = int(
            value.get("receipt_retention_hours", DEFAULT_RECEIPT_RETENTION_HOURS)
        )
    except (TypeError, ValueError) as exc:
        raise HostedSaveHttpContractError("Gateway port and retention must be integers.") from exc
    if not host or not 1 <= port <= 65535:
        raise HostedSaveHttpContractError("Gateway host or port is invalid.")
    if retention < 1:
        raise HostedSaveHttpContractError("Gateway receipt retention must be positive.")
    raw_kinds = value.get("allowed_save_kinds")
    if not isinstance(raw_kinds, list) or not raw_kinds:
        raise HostedSaveHttpContractError("Gateway save-kind allowlist is empty.")
    allowed_kinds = sorted({str(item or "").strip() for item in raw_kinds if str(item or "").strip()})
    if not allowed_kinds:
        raise HostedSaveHttpContractError("Gateway save-kind allowlist is empty.")
    raw_users = value.get("users")
    if not isinstance(raw_users, Mapping):
        raise HostedSaveHttpContractError("Gateway users must be an object.")
    users: dict[str, str] = {}
    for raw_user, raw_secret in raw_users.items():
        user = normalize_user(raw_user)
        secret = str(raw_secret or "").strip()
        if user and secret:
            users[user] = secret
    return {
        "config_version": GATEWAY_CONFIG_VERSION,
        "host": host,
        "port": port,
        "receipt_retention_hours": retention,
        "allowed_save_kinds": allowed_kinds,
        "users": users,
    }


def normalize_client_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"enabled": False}
    enabled = value.get("enabled") is True
    url = str(value.get("url") or "").strip().rstrip("/")
    user = str(value.get("user") or "").strip()
    secret = str(value.get("secret") or "").strip()
    allow_insecure = value.get("allow_insecure_http") is True
    if not enabled:
        return {"enabled": False}
    if not url or not user or not secret:
        raise HostedSaveHttpContractError(
            "Enabled Save Gateway configuration requires url, user, and secret."
        )
    if url.lower().startswith("http://") and not allow_insecure:
        raise HostedSaveHttpContractError(
            "Plain HTTP requires allow_insecure_http=true for the pilot."
        )
    if not url.lower().startswith(("http://", "https://")):
        raise HostedSaveHttpContractError("Save Gateway URL must use HTTP or HTTPS.")
    return {
        "enabled": True,
        "url": url,
        "user": user,
        "secret": secret,
        "allow_insecure_http": allow_insecure,
    }


def server_config_path(server_root: str | os.PathLike[str]) -> Path:
    return Path(server_root) / SERVER_CONFIG_RELATIVE_PATH


def receipts_root(server_root: str | os.PathLike[str]) -> Path:
    return Path(server_root) / RECEIPTS_RELATIVE_PATH


def receipt_path(server_root: str | os.PathLike[str], request_id: str) -> Path:
    token = str(request_id or "").strip()
    if not token or not token.replace("-", "").isalnum() or len(token) > 128:
        raise HostedSaveHttpContractError("Gateway request id is invalid.")
    return receipts_root(server_root) / f"{token}.json"
