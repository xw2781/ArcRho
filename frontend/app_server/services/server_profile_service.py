"""Server profiles: the servers this PC knows, which one is active, and each one's sign-in.

The list and its file belong to ``arcrho_api.config``. This service adds what
the app shows about each profile and what a change of active server must do in
this process. Switching servers is finished by the app's own restart, which
the response asks for rather than performing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from fastapi import HTTPException

from arcrho_api import config as api_config
from arcrho_api.exceptions import InvalidArcRhoServerError

from app_server import config
from app_server.services import hosted_save_enrollment_service


def _launch_overrides() -> Dict[str, str]:
    return {
        "root": api_config.env_server_root(),
        "gateway_config": api_config.env_gateway_config_path(),
    }


def _credential_url(path: Path) -> str:
    try:
        return str(json.loads(path.read_text(encoding="utf-8")).get("url") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def list_server_profiles() -> Dict[str, Any]:
    """Every saved server with its address and credential, and what the launch fixed."""

    cfg = config.load_workspace_config()
    folder = Path(config.WORKSPACE_PATHS_PATH).parent
    profiles = []
    for profile in cfg["profiles"]:
        credential = api_config.profile_gateway_config_path(profile, folder)
        profiles.append({
            "id": profile["id"],
            "name": profile["name"],
            "root": profile["root"] or config.DEFAULT_WORKSPACE_ROOT,
            "gateway_config": str(credential),
            "gateway_url": _credential_url(credential),
            "credential_exists": credential.is_file(),
            "active": profile["id"] == cfg["active_profile"],
        })
    return {
        "ok": True,
        "active_profile": cfg["active_profile"],
        "profiles": profiles,
        "set_at_launch": _launch_overrides(),
        "config_exists": config.workspace_paths_file_exists(),
    }


def _active_server() -> tuple[str, str]:
    return config.get_root_path(), config.get_gateway_config_path()


def _change_profiles(change) -> Dict[str, Any]:
    """Apply one profile change; a new active server takes effect on restart."""

    if any(_launch_overrides().values()):
        raise HTTPException(
            409, "This window's server was set when it was launched, so its server list cannot be changed here."
        )
    before = _active_server()
    try:
        change(Path(config.WORKSPACE_PATHS_PATH))
    except (ValueError, InvalidArcRhoServerError) as exc:
        raise HTTPException(400, str(exc)) from exc
    restart_required = _active_server() != before
    enrollment = None
    if restart_required:
        config.refresh_runtime_paths()
        config.clear_runtime_path_caches()
        enrollment = hosted_save_enrollment_service.auto_enroll_current_user()
    return {**list_server_profiles(), "restart_required": restart_required, "enrollment": enrollment}


def save_server_profile(*, name: str, root: str, profile_id: str = "", gateway_config: str = "") -> Dict[str, Any]:
    return _change_profiles(lambda path: api_config.upsert_server_profile(
        name=name, root=root, profile_id=profile_id, gateway_config=gateway_config, path=path,
    ))


def activate_server_profile(profile_id: str) -> Dict[str, Any]:
    return _change_profiles(lambda path: api_config.activate_server_profile(profile_id, path))
