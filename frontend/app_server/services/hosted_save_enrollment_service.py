"""Automatic per-user enrollment, as the desktop app's server starts."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from arcrho_api.hosted_save_enrollment import enroll_once

from app_server import config
from app_server.services import hosted_save_http_client, user_identity_service


LOGGER = logging.getLogger(__name__)


def auto_enroll_current_user() -> dict[str, Any]:
    """Enroll once when the shared registry is configured and reachable.

    The policy lives in ``arcrho_api.hosted_save_enrollment``, because the
    Excel add-in's credential helper installs a credential the same way. This
    only says who is asking, where the two files are, and how this process
    reaches the Gateway.
    """

    local_path = Path(config.get_gateway_config_path())
    result = enroll_once(
        server_root=Path(config.get_root_path()),
        client_output=local_path,
        user=user_identity_service.get_windows_login_name(),
        probe=lambda client_url: hosted_save_http_client.probe_gateway(
            {"url": client_url}
        ),
    )

    if result["status"] == "unavailable":
        LOGGER.warning("Gateway automatic enrollment skipped: %s", result["reason"])
    elif result["status"] == "enrolled":
        LOGGER.info("Gateway credential installed for the current Windows user.")
    return result
