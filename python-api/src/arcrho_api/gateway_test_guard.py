"""Keeps every test run off the real Arco Gateways this PC is signed in to.

A developer PC holds a Gateway credential for a real server (production's, or
the private test server's). A test that patches the workspace root but not the
Gateway would still sign its reads and writes to that server. The credential
lookup and every Gateway HTTP client go through this module, so a process
launched as a test run is isolated before any of them can act:

- ``ARCRHO_GATEWAY_CONFIG`` points at a credential file that does not exist,
  so enrollment, capability probes and transport choice all see "no Gateway";
- every Gateway client refuses a URL that no test allowed, as if the Gateway
  were unreachable. A test that starts its own Gateway on loopback allows its
  URL with :func:`allow_test_gateway`.

A process is a test run only by how it was launched (``python -m unittest``,
pytest, or a ``tests/test_*.py`` file run directly) or by inheriting the guard
from one. No app, server component, macro or notebook starts that way, so they
behave exactly as before.

Set ``ARCRHO_TEST_GATEWAY_RECORD`` to a file path to have each refused request
appended there as one JSON line naming the test that sent it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import BaseHandler, OpenerDirector, ProxyHandler, Request, build_opener

GUARD_ENV = "ARCRHO_TEST_GATEWAY_GUARD"
RECORD_ENV = "ARCRHO_TEST_GATEWAY_RECORD"
# A path that never exists. It is not under the temp folder: finding that folder
# writes a probe file, which a read-only sandbox (ArcBot's) refuses, and every
# arcrho_api import would fail with it.
MISSING_CREDENTIAL = Path(__file__).with_name("arcrho-tests-have-no-gateway") / "arcrho_gateway.json"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_TEST_RUNNER_MAINS = {"unittest.__main__", "pytest.__main__"}
_allowed: set[tuple[str, int]] = set()


def _launched_as_test_run() -> bool:
    if "_pytest" in sys.modules:
        return True
    main = sys.modules.get("__main__")
    if getattr(getattr(main, "__spec__", None), "name", None) in _TEST_RUNNER_MAINS:
        return True
    main_file = Path(getattr(main, "__file__", None) or "")
    return main_file.parent.name == "tests" and main_file.name.startswith("test_") and main_file.suffix == ".py"


def guard_active() -> bool:
    return os.environ.get(GUARD_ENV) == "1" or _launched_as_test_run()


def isolate_test_run(credential_env: str) -> None:
    """In a test run, hide this PC's Gateway credential from this process and its children."""

    if guard_active():
        os.environ[GUARD_ENV] = "1"
        os.environ[credential_env] = str(MISSING_CREDENTIAL)


def _origin(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    return (parts.hostname or "").lower(), parts.port or (443 if parts.scheme == "https" else 80)


def allow_test_gateway(url: str) -> Callable[[], None]:
    """Let this process's Gateway clients reach a Gateway the test started on loopback.

    Returns the call that withdraws the permission, for ``addCleanup``.
    """

    origin = _origin(url)
    if origin[0] not in _LOOPBACK_HOSTS:
        raise ValueError(f"Only a Gateway the test started on loopback may be allowed, not {url}.")
    _allowed.add(origin)
    return lambda: _allowed.discard(origin)


def _test_name() -> str:
    unittest = sys.modules.get("unittest")
    frame = sys._getframe(1)
    while frame is not None:
        owner = frame.f_locals.get("self")
        if unittest is not None and isinstance(owner, unittest.TestCase):
            return owner.id()
        frame = frame.f_back
    return ""


def _refuse_unless_allowed(request: Request) -> Request:
    if not guard_active() or _origin(request.full_url) in _allowed:
        return request
    record = os.environ.get(RECORD_ENV)
    if record:
        entry = {"url": request.full_url, "method": request.get_method(), "test": _test_name()}
        with open(record, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
    raise URLError(f"a test run never reaches a real Arco Gateway ({request.full_url} refused)")


def refuse_unless_allowed_url(url: str) -> None:
    """The same refusal for a Gateway client that cannot use :func:`gateway_opener`.

    Sign-up runs its Windows handshake on one kept-open connection, which
    ``urllib`` cannot do, so it checks its URL here before connecting.
    """

    _refuse_unless_allowed(Request(url))


class _TestGatewayGuard(BaseHandler):
    http_request = https_request = staticmethod(_refuse_unless_allowed)


def gateway_opener() -> OpenerDirector:
    """The opener every Gateway client sends through.

    The Gateway lives on the internal network, so a system proxy must never see
    it; and in a test run a request no test allowed is refused before it leaves.
    """

    return build_opener(ProxyHandler({}), _TestGatewayGuard())
