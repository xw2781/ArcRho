"""Automatic per-user enrollment for the hosted-save HTTP pilot."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from arcrho_api.hosted_save_enrollment import (
    load_server_gateway_config,
    provision_gateway_user,
)

from app_server import config
from app_server.services import hosted_save_http_client, user_identity_service


LOGGER = logging.getLogger(__name__)


def auto_enroll_current_user() -> dict[str, Any]:
    """Enroll once when the shared pilot is configured and reachable.

    An existing local file is authoritative, including an explicit
    ``enabled: false`` opt-out. Failures before enrollment leave the file
    absent, which keeps the existing SMB transport available.
    """

    local_path = Path(config.get_hosted_save_gateway_config_path())
    if local_path.is_file():
        return {"status": "existing", "path": str(local_path)}

    try:
        server_root = Path(config.get_root_path())
        gateway = load_server_gateway_config(server_root)
        client_url = str(gateway.get("client_url") or "").strip()
        if not client_url:
            return {"status": "not_configured"}
        hosted_save_http_client.probe_gateway({"url": client_url})
        user = user_identity_service.get_windows_login_name()
        _, installed_path = provision_gateway_user(
            server_root=server_root,
            user=user,
            client_output=local_path,
        )
    except Exception as exc:
        LOGGER.warning("Save Gateway automatic enrollment skipped: %s", exc)
        return {"status": "unavailable", "reason": str(exc)}

    LOGGER.info("Save Gateway credential installed for the current Windows user.")
    return {
        "status": "enrolled",
        "path": str(installed_path),
        "url": client_url,
    }
