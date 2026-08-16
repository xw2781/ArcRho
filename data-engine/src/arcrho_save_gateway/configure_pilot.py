"""Provision one user for the no-IT Save Gateway performance pilot."""

from __future__ import annotations

import argparse
import os
import socket
import sys
import winreg
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = BASE_DIR.parents[2]
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
for path in (API_SOURCE,):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.config import config_dir, get_server_root  # noqa: E402
from arcrho_api.hosted_save_enrollment import provision_gateway_user  # noqa: E402
from arcrho_hosted_save_http_contract import (  # noqa: E402
    CLIENT_CONFIG_FILE_NAME,
    default_gateway_config,
)


STARTUP_VALUE_NAME = "ArcRho Save Gateway"
STARTUP_REGISTRY_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def configure(
    *, server_root: Path, user: str, url: str, client_output: Path
) -> tuple[Path, Path]:
    return provision_gateway_user(
        server_root=server_root,
        user=user,
        client_output=client_output,
        client_url=url,
    )


def remove_current_user_startup() -> bool:
    """Drop the pilot-era login startup entry for this Windows user.

    The Orchestrator supervises the Gateway, so a login entry is a second
    starter racing the first. Both would bind the same port rather than one
    losing, so the stale entry is cleared whenever this user is provisioned.
    """

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, STARTUP_REGISTRY_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.DeleteValue(key, STARTUP_VALUE_NAME)
    except FileNotFoundError:
        return False
    return True


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Provision one user for the ArcRho Save Gateway pilot."
    )
    parser.add_argument("--server-root")
    parser.add_argument("--user", default=os.environ.get("USERNAME", ""))
    parser.add_argument("--url")
    parser.add_argument("--client-output")
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
    server_path, local_path = configure(
        server_root=root,
        user=args.user,
        url=url,
        client_output=client_output,
    )
    print(f"Save Gateway server configuration updated: {server_path}")
    print(f"Client credential installed: {local_path}")
    if remove_current_user_startup():
        print(
            "Removed the pilot-era Save Gateway login entry; the Orchestrator "
            "now starts the Gateway."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
