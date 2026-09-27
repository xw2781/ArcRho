"""Canonical first-run enrollment for the Arco Gateway credential.

Two callers install a credential for the logged-in Windows user: the desktop
app, as its app server starts, and the small frozen helper the Excel add-in
runs when it finds no credential on the PC. Both call :func:`enroll_once`, so
the "enroll once" policy — an existing local file is authoritative, the caller
supplies the Gateway address, that Gateway is probed before anything is
written, and a failure before enrollment leaves no file — is written here and
nowhere else.

The client never reads the server's registry. It proves who it is to the
Gateway with a Windows (Negotiate) handshake and receives only its own secret,
sealed with that handshake's session key (:func:`request_windows_enrollment`).
The registry itself, ``<root>\config\arcrho_gateway.json``, is written only on
the server: by the Gateway's sign-up route and by the two server-side tools
that call :func:`provision_gateway_user`.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlsplit
from urllib.request import Request

from arcrho_hosted_save_http_contract import (
    CAPABILITIES_PATH,
    ENROLLMENT_CAPABILITY,
    ENROLLMENT_PATH,
    NEGOTIATE_SCHEME,
    HostedSaveHttpContractError,
    client_credential,
    default_gateway_config,
    generate_secret,
    normalize_gateway_client_url,
    normalize_gateway_config,
    normalize_user,
    server_config_path,
)

from .gateway_test_guard import gateway_opener, refuse_unless_allowed_url
from .io import write_json_atomic


LOCK_TIMEOUT_SECONDS = 10.0
LOCK_RETRY_SECONDS = 0.05
PROBE_TIMEOUT_SECONDS = 2.0
ENROLLMENT_TIMEOUT_SECONDS = 10.0
# Negotiate over NTLM takes two round trips, Kerberos one.
ENROLLMENT_MAX_LEGS = 4
_DIRECT_HTTP_OPENER = gateway_opener()


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


def register_gateway_user(
    server_root: str | os.PathLike[str],
    user: str,
    *,
    client_url: str = "",
) -> tuple[str, str]:
    """Return one user's secret from the server registry, minting it if absent.

    Server side only: the Gateway's sign-up route and the server-side tools
    call it on the machine that holds the registry. The registry is rewritten
    only when a secret is minted or the address changes. Returns the secret
    and the registry's client address.
    """

    normalized_user = normalize_user(user)
    if not normalized_user:
        raise HostedSaveHttpContractError("A Windows login is required.")
    server_path = server_config_path(server_root)
    with _exclusive_file_lock(server_path.with_name(f".{server_path.name}.lock")):
        gateway = normalize_gateway_config(
            _read_object(server_path, missing=default_gateway_config())
        )
        secret = gateway["users"].get(normalized_user)
        if secret is None or (client_url and client_url != gateway["client_url"]):
            gateway["users"][normalized_user] = secret = secret or generate_secret()
            gateway["client_url"] = client_url or gateway["client_url"]
            write_json_atomic(server_path, gateway)
    return secret, gateway["client_url"]


def provision_gateway_user(
    *,
    server_root: str | os.PathLike[str],
    user: str,
    client_output: str | os.PathLike[str],
    client_url: str | None = None,
) -> tuple[Path, Path]:
    """Register one user and install that user's credential, on the server machine.

    Used by the pilot configuration tool and the local test root's ``init``,
    which run where the registry is local disk. A Client PC signs up through
    :func:`enroll_once` instead.
    """

    requested_url = normalize_gateway_client_url(client_url) if client_url is not None else ""
    local_path = Path(client_output).expanduser()
    with _exclusive_file_lock(local_path.with_name(f".{local_path.name}.lock")):
        secret, effective_url = register_gateway_user(
            server_root, user, client_url=requested_url
        )
        if not effective_url:
            raise HostedSaveHttpContractError(
                "Gateway automatic enrollment has no configured client URL."
            )
        write_json_atomic(local_path, client_credential(effective_url, user, secret))
    return server_config_path(server_root), local_path


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


def _negotiate_token(header: str | None) -> bytes:
    scheme, _, token = str(header or "").strip().partition(" ")
    if scheme.lower() != NEGOTIATE_SCHEME.lower() or not token.strip():
        return b""
    return base64.b64decode(token.strip())


def _response_detail(body: bytes, status: int) -> str:
    try:
        detail = json.loads(body.decode("utf-8")).get("detail")
    except (ValueError, AttributeError):
        detail = ""
    return str(detail or f"Gateway sign-up answered HTTP {status}.")


def request_windows_enrollment(client_url: str) -> dict[str, str]:
    """Sign up with the Gateway as the logged-in Windows user.

    The handshake runs on one connection, as Negotiate requires. No target
    name is given, so Windows settles on NTLM, which works whatever account
    the Gateway runs under; Kerberos would need an HTTP service name
    registered for that account. The answer is sealed with the handshake's
    session key, so neither a listener on the network nor a relay of this
    user's handshake can read the secret.
    """

    import sspi  # pywin32; imported here so the module still loads off Windows
    import win32timezone  # noqa: F401 - SSPI converts credential expiry with it; a frozen build needs the import

    url = normalize_gateway_client_url(client_url)
    refuse_unless_allowed_url(url)
    parts = urlsplit(url)
    connection_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parts.hostname, parts.port, timeout=ENROLLMENT_TIMEOUT_SECONDS)
    client = sspi.ClientAuth(NEGOTIATE_SCHEME)
    challenge = None
    try:
        for _ in range(ENROLLMENT_MAX_LEGS):
            _, token = client.authorize(challenge)
            encoded = base64.b64encode(token[0].Buffer).decode("ascii")
            connection.request(
                "POST",
                ENROLLMENT_PATH,
                body=b"",
                headers={
                    "Accept": "application/json",
                    "Authorization": f"{NEGOTIATE_SCHEME} {encoded}",
                },
            )
            response = connection.getresponse()
            body = response.read()
            challenge = _negotiate_token(response.getheader("WWW-Authenticate"))
            if response.status == 401 and challenge:
                continue
            if response.status != 200:
                raise HostedSaveHttpContractError(_response_detail(body, response.status))
            if challenge and not client.authenticated:
                client.authorize(challenge)
            payload = json.loads(body.decode("utf-8"))
            sealed = client.decrypt(
                base64.b64decode(payload["sealed"]), base64.b64decode(payload["trailer"])
            )
            answer = json.loads(sealed.decode("utf-8"))
            return {"user": str(answer["user"]), "secret": str(answer["secret"])}
    finally:
        connection.close()
    raise HostedSaveHttpContractError("Gateway sign-up did not finish its Windows handshake.")


def enroll_once(
    *,
    gateway_url: str,
    client_output: str | os.PathLike[str],
    probe: Callable[[str], Any] | None = None,
    enroll: Callable[[str], dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Install this user's credential unless the PC already carries one.

    An existing local file is authoritative, including an explicit
    ``enabled: false`` opt-out, which is a deliberate choice rather than a
    missing credential. ``gateway_url`` is the address the active server
    profile (or a launch override) supplies; without one nothing is written
    and the caller asks for it. Every failure leaves the local file absent, so
    the next launch simply tries again.

    ``probe`` is how the caller reaches the Gateway's capabilities. The app
    server passes its own, which also refuses a Gateway serving another
    server's folder; every other caller takes :func:`probe_gateway_url`.
    ``enroll`` is the sign-up itself, :func:`request_windows_enrollment`
    unless a test replaces it.
    """

    local_path = Path(client_output).expanduser()
    if local_path.is_file():
        return {"status": "existing", "path": str(local_path)}
    client_url = str(gateway_url or "").strip().rstrip("/")
    if not client_url:
        return {"status": "not_configured"}

    try:
        capabilities = (probe or probe_gateway_url)(client_url)
        if not isinstance(capabilities, dict) or capabilities.get(ENROLLMENT_CAPABILITY) is not True:
            raise HostedSaveHttpContractError(
                "This server's Gateway does not offer sign-up yet; it needs updating."
            )
        answer = (enroll or request_windows_enrollment)(client_url)
        with _exclusive_file_lock(local_path.with_name(f".{local_path.name}.lock")):
            write_json_atomic(
                local_path, client_credential(client_url, answer["user"], answer["secret"])
            )
    except Exception as exc:  # noqa: BLE001 - any failure must leave no credential
        return {"status": "unavailable", "reason": str(exc)}

    return {"status": "enrolled", "path": str(local_path), "url": client_url}
