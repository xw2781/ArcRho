"""ArcRho host workspace configuration for the Python API.

This module is the canonical owner of ArcRho Server root resolution. Every
ArcRho component that needs the server root -- including the bundled app server
in ``frontend/app_server/config.py`` -- must read these constants and helpers
instead of redefining its own environment names, config file name, or default
root, so a macro and the desktop app can never disagree about the workspace.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .exceptions import InvalidArcRhoServerError
from .io import persisted_json_text

WORKSPACE_PATHS_FILE_NAME = "workspace_paths.json"
DEFAULT_WORKSPACE_ROOT = r"E:\ArcRho Server"
DEFAULT_WORKSPACE_PATHS = {
    "projects_dir": "projects",
    "requests_dir": "requests",
}
# Environment overrides, highest precedence first. ``ARCRHO_RUNTIME_SERVER_ROOT``
# is what the ArcRho Bridge import runner exports into worker processes.
SERVER_ROOT_ENV = "ARCRHO_SERVER_ROOT"
RUNTIME_SERVER_ROOT_ENV = "ARCRHO_RUNTIME_SERVER_ROOT"
SERVER_ROOT_ENV_VARS = (SERVER_ROOT_ENV, RUNTIME_SERVER_ROOT_ENV)
# A running desktop app already knows its workspace root; asking it is the last
# resort before the packaged default, so keep the probe short enough that a
# stopped app never stalls a macro.
APP_QUERY_TIMEOUT_SEC = 3.0


def config_dir() -> Path:
    """Return the per-user ArcRho config folder (``%APPDATA%\\ArcRho``)."""

    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "ArcRho"
    return Path.home() / "AppData" / "Roaming" / "ArcRho"


def get_config_path() -> Path:
    """Return the ArcRho host workspace config file used by the Python API."""

    return config_dir() / WORKSPACE_PATHS_FILE_NAME


def env_server_root() -> str:
    """Return the ArcRho Server root set by environment override, if any."""

    for name in SERVER_ROOT_ENV_VARS:
        value = str(os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _normalize_path(path_like: str | Path) -> Path:
    return Path(path_like).expanduser().resolve()


def _validate_server_root(path_like: str | Path) -> Path:
    root = _normalize_path(path_like)
    try:
        valid_root = root.exists() and root.is_dir()
        valid_projects = (root / "projects").exists() and (root / "projects").is_dir()
    except OSError as exc:
        raise InvalidArcRhoServerError(f"ArcRho Server root is not accessible: {root}") from exc
    if not valid_root:
        raise InvalidArcRhoServerError(f"ArcRho Server root does not exist: {root}")
    projects_dir = root / "projects"
    if not valid_projects:
        raise InvalidArcRhoServerError(
            f"ArcRho Server root must contain a projects folder: {projects_dir}"
        )
    return root


def _read_workspace_config() -> dict:
    path = get_config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _load_host_server_root() -> Path | None:
    raw = str(_read_workspace_config().get("workspace_root") or "").strip()
    return _normalize_path(raw) if raw else None


def _save_host_server_root(root: Path) -> None:
    config_path = get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = config_path.with_suffix(f"{config_path.suffix}.tmp")
    payload = _read_workspace_config()
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        paths = {}
    payload["workspace_root"] = str(root)
    payload["paths"] = {
        "projects_dir": str(paths.get("projects_dir") or DEFAULT_WORKSPACE_PATHS["projects_dir"]),
        "requests_dir": str(paths.get("requests_dir") or DEFAULT_WORKSPACE_PATHS["requests_dir"]),
    }
    tmp_path.write_text(persisted_json_text(payload), encoding="utf-8")
    os.replace(tmp_path, config_path)


def _load_env_server_root() -> Path | None:
    raw = env_server_root()
    return _normalize_path(raw) if raw else None


def _load_running_app_server_root() -> Path | None:
    """Ask the running ArcRho desktop app which workspace root it is using.

    The host config file is only written when a user saves ArcRho Server
    Connection, so a fresh client install has no file at all. The desktop app
    resolves a root regardless, and its endpoint is discoverable, so querying it
    keeps macros on exactly the workspace the app is showing.
    """

    try:
        from .ui import _request_json

        payload = _request_json("/workspace_paths", timeout_sec=APP_QUERY_TIMEOUT_SEC)
    except Exception:
        return None
    config = payload.get("config")
    if not isinstance(config, dict):
        return None
    raw = str(config.get("workspace_root") or "").strip()
    return _normalize_path(raw) if raw else None


def _load_default_server_root() -> Path | None:
    """Return the packaged default root only when it is a real ArcRho Server."""

    try:
        return _validate_server_root(DEFAULT_WORKSPACE_ROOT)
    except InvalidArcRhoServerError:
        return None


def _resolve_configured_server_root() -> Path | None:
    """Resolve the root from local configuration only (no network probes)."""

    return _load_env_server_root() or _load_host_server_root()


def _discover_server_root() -> Path | None:
    """Resolve the root from the running app, then the packaged default."""

    return _load_running_app_server_root() or _load_default_server_root()


def _resolve_default_server_root() -> Path | None:
    return _resolve_configured_server_root() or _discover_server_root()


# Set only by set_server_root(); an explicit call outranks every other source.
_explicit_server_root: Path | None = None
# Cached file/app/default resolution. The environment is deliberately not cached
# here: the ArcRho Bridge exports ARCRHO_RUNTIME_SERVER_ROOT into an already
# running process, and that must not lose to a root cached at import time.
_server_root: Path | None = _load_host_server_root()
_discovery_attempted = False


def get_server_root(*, required: bool = False) -> Path | None:
    """Return the current default ArcRho Server root.

    Resolution order:

    1. an in-process root from :func:`set_server_root`;
    2. the ``ARCRHO_SERVER_ROOT`` / ``ARCRHO_RUNTIME_SERVER_ROOT`` environment
       overrides, re-read on every call;
    3. the ArcRho host app workspace config file
       (``%APPDATA%\\ArcRho\\workspace_paths.json``);
    4. the workspace root reported by the running ArcRho desktop app;
    5. the packaged default root, when it exists and holds a projects folder.

    Steps 4 and 5 are attempted once per process; call
    :func:`reload_server_root` to retry them.
    """

    global _server_root, _discovery_attempted
    if _explicit_server_root is not None:
        return _explicit_server_root
    env_root = _load_env_server_root()
    if env_root is not None:
        return env_root
    if _server_root is None:
        _server_root = _load_host_server_root()
    if _server_root is None and not _discovery_attempted:
        _discovery_attempted = True
        _server_root = _discover_server_root()
    if _server_root is not None:
        return _server_root
    if required:
        raise InvalidArcRhoServerError(
            "ArcRho Server root was not found in the ArcRho host config file. "
            "Use ArcRho Server Connection, call set_server_root(...), set "
            f"{SERVER_ROOT_ENV}, or pass server_root=... to ArcRhoClient(...)."
        )
    return None


def set_server_root(server_root: str | Path, *, persist: bool = True, validate: bool = True) -> Path:
    """Set the default ArcRho Server root in process and in the host config."""

    global _explicit_server_root, _server_root, _discovery_attempted
    root = _validate_server_root(server_root) if validate else _normalize_path(server_root)
    _explicit_server_root = root
    _server_root = root
    _discovery_attempted = False
    if persist:
        _save_host_server_root(root)
    return root


def reload_server_root() -> Path | None:
    """Re-resolve the server root, dropping any in-process override.

    Retries the running-app query and the packaged default that
    :func:`get_server_root` attempts only once per process.
    """

    global _explicit_server_root, _server_root, _discovery_attempted
    _explicit_server_root = None
    _discovery_attempted = True
    _server_root = _resolve_default_server_root()
    return _server_root
