"""Gateway sign-up: a Windows handshake returns the caller's own secret.

A Client PC that has no credential posts to ``/api/enroll`` with a Negotiate
(SSPI) handshake. The Gateway trusts only the account that handshake proves,
never a name the request carries, and answers with that account's secret from
the server registry, minting one the first time. The answer is sealed with the
handshake's session key, so it is readable only by the process that made the
handshake. The registry file stays where it is and the Gateway keeps writing
it, because the released app still reads it over the share.

Anything but a finished handshake for a real user account is refused, and the
number of handshakes one address may start is bounded.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Mapping

from arcrho_api.hosted_save_enrollment import register_gateway_user
from arcrho_hosted_save_http_contract import (
    ENROLLMENT_ATTEMPTS_PER_WINDOW,
    ENROLLMENT_WINDOW_SECONDS,
    NEGOTIATE_SCHEME,
    normalize_user,
)

# Windows SID_NAME_USE for an ordinary user account.
SID_TYPE_USER = 1
# Account SIDs a real person signs in with: domain and local machine accounts.
ACCOUNT_SID_PREFIX = "S-1-5-21-"
# Built-in accounts that are not a person: Guest, DefaultAccount, WDAGUtilityAccount.
REFUSED_ACCOUNT_RIDS = {"501", "503", "504"}
SIGN_IN_REQUIRED = "Sign in with Windows to get this PC's Gateway credential."
SIGN_IN_FAILED = "Windows sign-in to the Gateway failed."
ACCOUNT_REFUSED = "This Windows account cannot sign up to the Gateway."
TOO_MANY_ATTEMPTS = "Too many sign-up attempts from this address. Try again in a minute."


class EnrollmentLimiter:
    """At most ``attempts`` handshakes started per source address in any ``window`` seconds."""

    def __init__(
        self,
        attempts: int = ENROLLMENT_ATTEMPTS_PER_WINDOW,
        window: float = ENROLLMENT_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.attempts = attempts
        self.window = window
        self.clock = clock
        self._starts: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, source: str) -> bool:
        now = self.clock()
        with self._lock:
            for key in list(self._starts):
                starts = self._starts[key]
                while starts and now - starts[0] >= self.window:
                    starts.popleft()
                if not starts:
                    del self._starts[key]
            starts = self._starts.setdefault(source, deque())
            if len(starts) >= self.attempts:
                return False
            starts.append(now)
            return True


class EnrollmentRefused(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def check_account(sid: str, sid_type: int, name: str) -> str:
    """The login a proven account signs up under; anything but a real user account is refused."""

    login = normalize_user(name)
    if (
        sid_type != SID_TYPE_USER
        or not sid.startswith(ACCOUNT_SID_PREFIX)
        or sid.rsplit("-", 1)[-1] in REFUSED_ACCOUNT_RIDS
        or not login
    ):
        raise EnrollmentRefused(403, ACCOUNT_REFUSED)
    return login


def authenticated_login(context: Any) -> str:
    """The login of the account a finished handshake proved, read from its Windows token."""

    import win32security

    token = context.ctxt.QuerySecurityContextToken()
    sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    name, _domain, sid_type = win32security.LookupAccountSid(None, sid)
    return check_account(win32security.ConvertSidToStringSid(sid), sid_type, name)


def new_server_context() -> Any:
    import sspi
    import win32timezone  # noqa: F401 - SSPI converts credential expiry with it; a frozen build needs the import

    return sspi.ServerAuth(NEGOTIATE_SCHEME)


def _negotiate_token(header: str | None) -> bytes:
    scheme, _, token = str(header or "").strip().partition(" ")
    if scheme.lower() != NEGOTIATE_SCHEME.lower() or not token.strip():
        return b""
    try:
        return base64.b64decode(token.strip(), validate=True)
    except ValueError:
        return b""


def _encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class WindowsEnrollment:
    """One Gateway's sign-up route. ``respond`` serves one request of a handshake.

    ``state`` belongs to one connection, because a Negotiate handshake is
    bound to the connection it started on.
    """

    def __init__(
        self,
        root: Path,
        *,
        log: Callable[[Path, str], None],
        limiter: EnrollmentLimiter | None = None,
        new_context: Callable[[], Any] = new_server_context,
        login_of: Callable[[Any], str] = authenticated_login,
    ) -> None:
        self.root = root
        self.log = log
        self.limiter = limiter or EnrollmentLimiter()
        self.new_context = new_context
        self.login_of = login_of

    def respond(
        self, state: dict[str, Any], source: str, authorization: str | None
    ) -> tuple[int, dict[str, Any], Mapping[str, str]]:
        close = {"Connection": "close"}
        token = _negotiate_token(authorization)
        context = state.pop("context", None)
        if context is None:
            if not self.limiter.allow(source):
                self.log(self.root, f"enroll refused source={source} reason=rate-limit")
                return 429, {"detail": TOO_MANY_ATTEMPTS}, {**close, "Retry-After": str(ENROLLMENT_WINDOW_SECONDS)}
            if not token:
                return 401, {"detail": SIGN_IN_REQUIRED}, {**close, "WWW-Authenticate": NEGOTIATE_SCHEME}
            context = self.new_context()
        elif not token:
            return 401, {"detail": SIGN_IN_FAILED}, close
        try:
            status, reply = context.authorize(token)
            reply_token = reply[0].Buffer or b""
            if status != 0:
                state["context"] = context
                return (
                    401,
                    {"detail": SIGN_IN_REQUIRED},
                    {"Connection": "keep-alive", "WWW-Authenticate": f"{NEGOTIATE_SCHEME} {_encode(reply_token)}"},
                )
            login = self.login_of(context)
            secret, _ = register_gateway_user(self.root, login)
            data, trailer = context.encrypt(
                json.dumps({"user": login, "secret": secret}).encode("utf-8")
            )
        except EnrollmentRefused as exc:
            self.log(self.root, f"enroll refused source={source} reason=account")
            return exc.status_code, {"detail": exc.detail}, close
        except Exception as exc:  # noqa: BLE001 - every handshake failure is a refusal
            self.log(self.root, f"enroll refused source={source} reason={type(exc).__name__}")
            return 401, {"detail": SIGN_IN_FAILED}, close
        self.log(self.root, f"enrolled user={login} source={source}")
        headers = dict(close)
        if reply_token:
            headers["WWW-Authenticate"] = f"{NEGOTIATE_SCHEME} {_encode(reply_token)}"
        return 200, {"ok": True, "sealed": _encode(data), "trailer": _encode(trailer)}, headers
