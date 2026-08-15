"""Provision one user for the no-IT Save Gateway performance pilot."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import winreg
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = BASE_DIR.parents[2]
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
for path in (API_SOURCE,):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.config import config_dir, get_server_root  # noqa: E402
from arcrho_api.io import persisted_json_text  # noqa: E402
from arcrho_hosted_save_http_contract import (  # noqa: E402
    CLIENT_CONFIG_FILE_NAME,
    HTTP_PILOT_SAVE_KINDS,
    default_gateway_config,
    generate_secret,
    normalize_gateway_config,
    normalize_user,
    server_config_path,
)


STARTUP_VALUE_NAME = "ArcRho Save Gateway"
STARTUP_REGISTRY_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(payload, dict):
        raise ValueError(f"Configuration must be a JSON object: {path}")
    return payload


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temporary.write_text(persisted_json_text(payload), encoding="utf-8")
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def configure(
    *, server_root: Path, user: str, url: str, client_output: Path
) -> tuple[Path, Path]:
    normalized_user = normalize_user(user)
    if not normalized_user:
        raise ValueError("A Windows login is required.")
    server_path = server_config_path(server_root)
    raw = _read_json(server_path) or default_gateway_config()
    gateway = normalize_gateway_config(raw)
    gateway["allowed_save_kinds"] = sorted(
        set(gateway["allowed_save_kinds"]) | set(HTTP_PILOT_SAVE_KINDS)
    )
    secret = gateway["users"].get(normalized_user) or generate_secret()
    gateway["users"][normalized_user] = secret
    _write_json_atomic(server_path, gateway)
    client = {
        "config_version": 1,
        "enabled": True,
        "url": str(url).strip().rstrip("/"),
        "user": user,
        "secret": secret,
        "allow_insecure_http": str(url).lower().startswith("http://"),
    }
    _write_json_atomic(client_output, client)
    return server_path, client_output


def install_current_user_startup(executable: Path) -> None:
    """Start the machine-wide gateway whenever this Windows user signs in."""

    resolved = executable.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Save Gateway executable not found: {resolved}")
    command = f'"{resolved}"'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, STARTUP_REGISTRY_KEY) as key:
        winreg.SetValueEx(key, STARTUP_VALUE_NAME, 0, winreg.REG_SZ, command)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Provision one user for the ArcRho Save Gateway pilot."
    )
    parser.add_argument("--server-root")
    parser.add_argument("--user", default=os.environ.get("USERNAME", ""))
    parser.add_argument("--url")
    parser.add_argument("--client-output")
    parser.add_argument(
        "--install-current-user-startup",
        action="store_true",
        help="Register the deployed gateway in this user's login startup (no admin).",
    )
    parser.add_argument("--gateway-executable")
    return parser


def main() -> int:
    args = _parser().parse_args()
    root = (
        Path(args.server_root).expanduser().resolve()
        if args.server_root
        else get_server_root(required=True)
    )
    url = args.url or f"http://{socket.getfqdn()}:{default_gateway_config()['port']}"
    client_output = (
        Path(args.client_output).expanduser()
        if args.client_output
        else config_dir() / CLIENT_CONFIG_FILE_NAME
    )
    gateway_executable = (
        Path(args.gateway_executable).expanduser()
        if args.gateway_executable
        else root / "apps" / "ArcRho Save Gateway" / "ArcRho Save Gateway.exe"
    )
    if args.install_current_user_startup and not gateway_executable.resolve().is_file():
        raise FileNotFoundError(
            f"Save Gateway executable not found: {gateway_executable.resolve()}"
        )
    server_path, local_path = configure(
        server_root=root,
        user=args.user,
        url=url,
        client_output=client_output,
    )
    print(f"Save Gateway server configuration updated: {server_path}")
    print(f"Client credential installed: {local_path}")
    if args.install_current_user_startup:
        install_current_user_startup(gateway_executable)
        print("Save Gateway login startup installed for the current Windows user.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
