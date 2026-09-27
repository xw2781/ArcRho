"""Which of this server's components are running, read where the server folder is.

Registered as the ``server_component_status`` workspace read, so a Client PC
asks the server's Gateway and the look is taken on the server host; the
heartbeat and stop-switch rules live in ``arcrho_server_component_status``,
which Admin Control shares.
"""

from __future__ import annotations

from typing import Any, Dict

from arcrho_server_component_status import component_status

from app_server import config


def get_server_component_status() -> Dict[str, Any]:
    return {"ok": True, **component_status(config.get_root_path())}
