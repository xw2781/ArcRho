"""Automatic per-user enrollment, as the desktop app's server starts."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from arcrho_api.hosted_save_enrollment import enroll_once

from app_server import config
from app_server.services import hosted_save_http_client


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
