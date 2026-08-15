"""Canonical first-run enrollment for the hosted-save HTTP pilot."""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from arcrho_hosted_save_http_contract import (
    HTTP_PILOT_SAVE_KINDS,
    HostedSaveHttpContractError,
    default_gateway_config,
    generate_secret,
    normalize_gateway_client_url,
    normalize_gateway_config,
    normalize_user,
    server_config_path,
)

from .io import write_json_atomic


LOCK_TIMEOUT_SECONDS = 10.0
LOCK_RETRY_SECONDS = 0.05


def _read_object(path: Path, *, missing: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(missing or {})
    except (OSError, json.JSONDecodeError) as exc:
        raise HostedSaveHttpContractError(
            f"Save Gateway configuration could not be read: {path}"
        ) from exc
    if not isinstance(payload, dict):
        raise HostedSaveHttpContractError(
            f"Save Gateway configuration must be an object: {path}"
        )
    return payload


@contextmanager
def _exclusive_file_lock(path: Path) -> Iterator[None]:
    """Serialize shared enrollment updates with a one-byte OS file lock."""

    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
    try:
        handle = path.open("x+b")
    except FileExistsError:
        handle = path.open("r+b")
    with handle:
        if handle.seek(0, os.SEEK_END) == 0 and handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise HostedSaveHttpContractError(
                        "Save Gateway enrollment is busy. Please try again."
                    ) from exc
                time.sleep(LOCK_RETRY_SECONDS)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_server_gateway_config(server_root: str | os.PathLike[str]) -> dict[str, Any]:
    """Read and normalize an existing shared Gateway configuration."""

    path = server_config_path(server_root)
    raw = _read_object(path)
    if not raw:
        raise HostedSaveHttpContractError(
            f"Save Gateway is not configured for automatic enrollment: {path}"
        )
    return normalize_gateway_config(raw)


def provision_gateway_user(
    *,
    server_root: str | os.PathLike[str],
    user: str,
    client_output: str | os.PathLike[str],
    client_url: str | None = None,
) -> tuple[Path, Path]:
    """Register one user and install that user's machine-local credential."""

    normalized_user = normalize_user(user)
    if not normalized_user:
        raise HostedSaveHttpContractError("A Windows login is required.")
    requested_url = (
        normalize_gateway_client_url(client_url)
        if client_url is not None
        else ""
    )
    server_path = server_config_path(server_root)
    local_path = Path(client_output).expanduser()
    local_lock = local_path.with_name(f".{local_path.name}.lock")
    shared_lock = server_path.with_name(f".{server_path.name}.lock")

    with _exclusive_file_lock(local_lock):
        with _exclusive_file_lock(shared_lock):
            raw = _read_object(server_path, missing=default_gateway_config())
            gateway = normalize_gateway_config(raw)
            effective_url = requested_url or gateway["client_url"]
            if not effective_url:
                raise HostedSaveHttpContractError(
                    "Save Gateway automatic enrollment has no configured client URL."
                )
            gateway["client_url"] = effective_url
            gateway["allowed_save_kinds"] = sorted(
                set(gateway["allowed_save_kinds"]) | set(HTTP_PILOT_SAVE_KINDS)
            )
            secret = gateway["users"].get(normalized_user) or generate_secret()
            gateway["users"][normalized_user] = secret
            write_json_atomic(server_path, gateway)

        client = {
            "config_version": 1,
            "enabled": True,
            "url": effective_url,
            "user": user,
            "secret": secret,
            "allow_insecure_http": effective_url.lower().startswith("http://"),
        }
        write_json_atomic(local_path, client)
    return server_path, local_path
