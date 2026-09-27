"""Automatic per-user enrollment, as the desktop app's server starts."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from arcrho_api.hosted_save_enrollment import ServerIdMismatch, enroll_once
from arcrho_api.hosted_save_enrollment import sign_in_again as sign_in_again_at

from app_server import config
from app_server.services import hosted_save_http_client, workspace_read_client


LOGGER = logging.getLogger(__name__)


def auto_enroll_current_user() -> dict[str, Any]:
    """Sign up once when this app knows its server's Gateway address.

    The policy lives in ``arcrho_api.hosted_save_enrollment``, because the
    Excel add-in's credential helper installs a credential the same way. This
    only says where the credential goes and which address to sign up at. The
    server's registry is never read: the Gateway proves who is asking by
    Windows sign-in and answers with that user's secret, and the server id it
    reports is stored beside it.
    """

    local_path = Path(config.get_gateway_config_path())
    result = enroll_once(
        gateway_url=config.get_gateway_url(),
        client_output=local_path,
        probe=hosted_save_http_client.fetch_gateway_capabilities,
    )

    if result["status"] == "unavailable":
        LOGGER.warning("Gateway automatic enrollment skipped: %s", result["reason"])
    elif result["status"] == "enrolled":
        LOGGER.info("Gateway credential installed for the current Windows user.")
    return result


def sign_in_again() -> dict[str, Any]:
    """Replace this window's credential with a fresh Windows sign-up, for a sign-in the server refused.

    The credential is the one this window uses, a launch override included.
    The old file stays until the new secret has arrived, and a Gateway that
    reports another server than the credential's is refused (409). The
    capability cache is cleared so the next request probes with the new
    credential; nothing else in this process holds it.
    """

    try:
        result = sign_in_again_at(
            gateway_url=config.get_gateway_url(),
            client_output=Path(config.get_gateway_config_path()),
            probe=hosted_save_http_client.fetch_gateway_capabilities,
        )
    except ServerIdMismatch as exc:
        raise hosted_save_http_client.GatewayServerMismatch() from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - the SSPI handshake raises its own error types
        LOGGER.warning("Gateway sign-in again failed: %s", exc)
        raise HTTPException(502, f"Sign-in failed: {exc}") from exc
    workspace_read_client.reset_capability_cache()
    LOGGER.info("Gateway credential replaced for the current Windows user.")
    return result
