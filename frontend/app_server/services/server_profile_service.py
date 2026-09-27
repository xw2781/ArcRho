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
from arcrho_hosted_save_http_contract import HostedSaveHttpContractError
from arcrho_server_component_status import is_on_local_fixed_disk
import arcrho_server_control as server_control

from app_server import config
from app_server.services import (
    hosted_save_enrollment_service,
    hosted_save_http_client,
    server_component_status_service,
    workspace_read_client,
)

COMPONENT_STATUS_READ_KIND = "server_component_status"
GATEWAY_NOT_ANSWERING = "Gateway not answering."
GATEWAY_NEEDS_UPDATE = "The Gateway is answering but cannot report components until it is updated."


def _launch_overrides() -> Dict[str, str]:
    return {
        "root": api_config.env_server_root(),
        "gateway_config": api_config.env_gateway_config_path(),
        "gateway_url": api_config.env_gateway_url(),
    }


def _read_credential(path: Path) -> Dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return {"url": str(payload.get("url") or ""), "user": str(payload.get("user") or "")}
    except (OSError, ValueError, AttributeError):
        return {"url": "", "user": ""}


def _server_entry(root: str, credential: Path, gateway_url: str) -> Dict[str, Any]:
    sign_in = _read_credential(credential)
    return {
        "root": root,
        "gateway_config": str(credential),
        # Before the first sign-up there is no credential yet; the profile's
        # address is where the switch will sign up. The server's own registry
        # is never read from here.
        "gateway_url": sign_in["url"] or gateway_url,
        "user": sign_in["user"],
        "credential_exists": credential.is_file(),
    }


def list_server_profiles() -> Dict[str, Any]:
    """Every saved server with its address and credential, and what the launch fixed.

    ``current`` is the server this process works against, which differs from
    the active profile while a launch override is set. ``default_profile`` is
    production's id; the title bar shows a badge whenever another server is in use.
    """

    cfg = config.load_workspace_config()
    folder = Path(config.WORKSPACE_PATHS_PATH).parent
    profiles = []
    for profile in cfg["profiles"]:
        credential = api_config.profile_gateway_config_path(profile, folder)
        profiles.append({
            "id": profile["id"],
            "name": profile["name"],
            **_server_entry(
                profile["root"] or config.DEFAULT_WORKSPACE_ROOT, credential, profile.get("gateway_url", "")
            ),
            "active": profile["id"] == cfg["active_profile"],
        })
    return {
        "ok": True,
        "active_profile": cfg["active_profile"],
        "default_profile": api_config.DEFAULT_PROFILE_ID,
        "profiles": profiles,
        "current": _server_entry(
            config.get_root_path(), Path(config.get_gateway_config_path()), config.get_gateway_url()
        ),
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
    """What adding ``root`` as a server would record: its folder and a name.

    The address is typed by the person adding the server; the folder's
    Gateway registry is server-only and never read here.
    """

    try:
        folder = api_config.validate_server_root(root.strip())
    except InvalidArcRhoServerError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "ok": True,
        "root": str(folder),
        "name": folder.name or str(folder),
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


def save_server_profile(
    *, name: str, root: str, profile_id: str = "", gateway_config: str = "", gateway_url: str = "",
) -> Dict[str, Any]:
    return _change_profiles(lambda path: api_config.upsert_server_profile(
        name=name, root=root, profile_id=profile_id, gateway_config=gateway_config,
        gateway_url=gateway_url, path=path,
    ))


def activate_server_profile(profile_id: str) -> Dict[str, Any]:
    return _change_profiles(lambda path: api_config.activate_server_profile(profile_id, path))


def sign_in_again() -> Dict[str, Any]:
    """Sign this window in to its server again; allowed in a launch-time session too."""

    signed_in = hosted_save_enrollment_service.sign_in_again()
    return {**list_server_profiles(), "signed_in": signed_in}


def _silent_gateway_detail() -> str:
    """Why the Gateway gave no component status: it is silent, or too old to know the read."""

    try:
        gateway = config.load_gateway_config()
    except HostedSaveHttpContractError:
        return GATEWAY_NOT_ANSWERING
    if gateway.get("enabled") is not True:
        return GATEWAY_NOT_ANSWERING
    capabilities = workspace_read_client.cached_gateway_capabilities(gateway)
    if capabilities is not None and not workspace_read_client.gateway_supports_read_kind(
        capabilities, COMPONENT_STATUS_READ_KIND
    ):
        return GATEWAY_NEEDS_UPDATE
    return GATEWAY_NOT_ANSWERING


def server_component_status() -> Dict[str, Any]:
    """This window's server's components, from its folder when that is on this PC, else its Gateway.

    A folder on a fixed disk of this PC is read directly, so the tab still
    reports while that server's Gateway is down. Any other server is asked
    through its Gateway only; when the Gateway does not answer the panel says
    so, and nothing is read over the share.
    """

    root = config.get_root_path()
    control = _server_control(root)
    if is_on_local_fixed_disk(root):
        status = server_component_status_service.get_server_component_status()
        return {**status, "source": "disk", "answering": True, "detail": "", "control": control}
    try:
        status = workspace_read_client.run_workspace_read(
            COMPONENT_STATUS_READ_KIND,
            {},
            local=server_component_status_service.get_server_component_status,
        )
    except HTTPException as exc:
        if exc.status_code not in (401, 503, 504):
            raise
        # A refused sign-in is said as such, beside the row's Sign in again button.
        detail = str(exc.detail) if exc.status_code == 401 else _silent_gateway_detail()
        return {
            "ok": True, "source": "gateway", "answering": False, "detail": detail, "roles": [],
            "control": control,
        }
    return {**status, "source": "gateway", "answering": True, "detail": "", "control": control}


def _server_control(root: str) -> Dict[str, Any]:
    """Whether the Server tab may start and stop this server, and which roles that covers."""

    refusal = server_control.control_refusal(root, config.DEFAULT_WORKSPACE_ROOT)
    return {"available": not refusal, "detail": refusal, "roles": list(server_control.SUPERVISED_ROLES)}


def _controllable_root() -> str:
    root = config.get_root_path()
    try:
        server_control.require_local_root(root, config.DEFAULT_WORKSPACE_ROOT)
    except server_control.ServerControlError as exc:
        raise HTTPException(409, str(exc)) from exc
    return root


def start_active_server() -> Dict[str, Any]:
    """Start this window's server: clear its stop switches and launch its Orchestrator.

    Refused unless the server's folder is on a fixed disk of this PC and is not
    production. The launch drops this process's own root and credential
    overrides, so a launch-time session never hands them to the server.
    """

    root = _controllable_root()
    try:
        launched = server_control.start_server(root)
    except server_control.ServerControlError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "launched": launched}


def stop_active_server() -> Dict[str, Any]:
    """Set this window's server's stop switches; the page follows the heartbeats as they go."""

    root = _controllable_root()
    return {"ok": True, "stopped": server_control.stop_server(root, wait_seconds=0)}
