"""Canonical first-run enrollment for the Arco Gateway credential.

Two callers install a credential for the logged-in Windows user: the desktop
app, as its app server starts, and the small frozen helper the Excel add-in
runs when it finds no credential on the PC. Both call :func:`enroll_once`, so
the "enroll once" policy — an existing local file is authoritative, the shared
registry's URL is the only URL, that URL is probed before anything is written,
and a failure before enrollment leaves no file — is written here and nowhere
else.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.request import ProxyHandler, Request, build_opener

from arcrho_hosted_save_http_contract import (
    CAPABILITIES_PATH,
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
PROBE_TIMEOUT_SECONDS = 2.0
# A workstation proxy must not be consulted for the server's own address.
_DIRECT_HTTP_OPENER = build_opener(ProxyHandler({}))


def _read_object(path: Path, *, missing: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(missing or {})
    except (OSError, json.JSONDecodeError) as exc:
        raise HostedSaveHttpContractError(
            f"Gateway configuration could not be read: {path}"
        ) from exc
    if not isinstance(payload, dict):
        raise HostedSaveHttpContractError(
            f"Gateway configuration must be an object: {path}"
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
                        "Gateway enrollment is busy. Please try again."
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
            f"Gateway is not configured for automatic enrollment: {path}"
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
                    "Gateway automatic enrollment has no configured client URL."
                )
            gateway["client_url"] = effective_url
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


def probe_gateway_url(client_url: str) -> dict[str, Any]:
    """Ask the Gateway for its capabilities, so a dead address writes no file."""

    request = Request(
        f"{client_url}{CAPABILITIES_PATH}",
        method="GET",
        headers={"Accept": "application/json"},
    )
    with _DIRECT_HTTP_OPENER.open(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise HostedSaveHttpContractError("Gateway capabilities must be an object.")
    return payload


def enroll_once(
    *,
    server_root: str | os.PathLike[str],
    client_output: str | os.PathLike[str],
    user: str,
    probe: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    """Install this user's credential unless the PC already carries one.

    An existing local file is authoritative, including an explicit
    ``enabled: false`` opt-out, which is a deliberate choice rather than a
    missing credential. The shared registry owns the URL; a caller never
    supplies one. Every failure leaves the local file absent, so the next
    launch simply tries again.

    ``probe`` is how the caller reaches the Gateway. The app server passes its
    own, so an unreachable Gateway becomes the HTTP status that transport
    already answers with; every other caller takes :func:`probe_gateway_url`.
    """

    local_path = Path(client_output).expanduser()
    if local_path.is_file():
        return {"status": "existing", "path": str(local_path)}

    reach = probe_gateway_url if probe is None else probe
    try:
        gateway = load_server_gateway_config(server_root)
        client_url = str(gateway.get("client_url") or "").strip()
        if not client_url:
            return {"status": "not_configured"}
        reach(client_url)
        _, installed_path = provision_gateway_user(
            server_root=server_root,
            user=user,
            client_output=local_path,
        )
    except Exception as exc:  # noqa: BLE001 - any failure must leave no credential
        return {"status": "unavailable", "reason": str(exc)}

    return {"status": "enrolled", "path": str(installed_path), "url": client_url}
