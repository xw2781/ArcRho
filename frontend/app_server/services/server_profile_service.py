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
from arcrho_api.hosted_save_enrollment import load_server_gateway_config

from app_server import config
from app_server.services import hosted_save_enrollment_service, hosted_save_http_client

# A registry bound to every interface names no address a client can dial.
WILDCARD_HOSTS = {"0.0.0.0", "::", ""}


def _launch_overrides() -> Dict[str, str]:
    return {
        "root": api_config.env_server_root(),
        "gateway_config": api_config.env_gateway_config_path(),
    }


def _read_credential(path: Path) -> Dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return {"url": str(payload.get("url") or ""), "user": str(payload.get("user") or "")}
    except (OSError, ValueError, AttributeError):
        return {"url": "", "user": ""}


def registry_gateway_url(root: str) -> str:
    """The Gateway address a server folder's registry gives its clients, or ``""``.

    ``client_url`` is what enrollment writes into a credential; a registry that
    names a real host without one is reached at that host and port.
    The file is read from the folder, over the share for a remote server,
    because it is how a client learns an address before it can ask a Gateway
    anything; enrollment makes the same read.
    """

    try:
        gateway = load_server_gateway_config(root)
    except (OSError, ValueError):
        return ""
    if gateway["client_url"]:
        return gateway["client_url"]
    if gateway["host"] in WILDCARD_HOSTS:
        return ""
    return f"http://{gateway['host']}:{gateway['port']}"


def _server_entry(root: str, credential: Path) -> Dict[str, Any]:
    sign_in = _read_credential(credential)
    return {
        "root": root,
        "gateway_config": str(credential),
        # Before the first switch there is no credential yet; the folder's
        # registry names the address the switch will enroll against.
        "gateway_url": sign_in["url"] or registry_gateway_url(root),
        "user": sign_in["user"],
        "credential_exists": credential.is_file(),
    }


def list_server_profiles() -> Dict[str, Any]:
    """Every saved server with its address and credential, and what the launch fixed.

    ``current`` is the server this process works against, which differs from
    the active profile while a launch override is set.
    """

    cfg = config.load_workspace_config()
    folder = Path(config.WORKSPACE_PATHS_PATH).parent
    profiles = []
    for profile in cfg["profiles"]:
        credential = api_config.profile_gateway_config_path(profile, folder)
        profiles.append({
            "id": profile["id"],
            "name": profile["name"],
            **_server_entry(profile["root"] or config.DEFAULT_WORKSPACE_ROOT, credential),
            "active": profile["id"] == cfg["active_profile"],
        })
    return {
        "ok": True,
        "active_profile": cfg["active_profile"],
        "profiles": profiles,
        "current": _server_entry(config.get_root_path(), Path(config.get_gateway_config_path())),
        "set_at_launch": _launch_overrides(),
        "config_exists": config.workspace_paths_file_exists(),
    }


def server_health(profile_id: str = "") -> Dict[str, Any]:
    """Whether one server's Gateway answers its health check; no id means this window's server."""

    listing = list_server_profiles()
    if profile_id:
        server = next((p for p in listing["profiles"] if p["id"] == profile_id.strip().lower()), None)
        if server is None:
            raise HTTPException(404, f"No server profile named {profile_id!r}.")
    else:
        server = listing["current"]
    url = server["gateway_url"]
    if not url:
        return {"ok": False, "gateway_url": "", "detail": "This server has no Gateway address."}
    try:
        hosted_save_http_client.probe_gateway_health(url)
    except (OSError, ValueError) as exc:
        return {"ok": False, "gateway_url": url, "detail": f"Gateway is not answering: {exc}"}
    return {"ok": True, "gateway_url": url, "detail": ""}


def inspect_server_folder(root: str) -> Dict[str, Any]:
    """What adding ``root`` as a server would record: its folder, a name, and its address."""

    try:
        folder = api_config.validate_server_root(root.strip())
    except InvalidArcRhoServerError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "ok": True,
        "root": str(folder),
        "name": folder.name or str(folder),
        "gateway_url": registry_gateway_url(str(folder)),
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
