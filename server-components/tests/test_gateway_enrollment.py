"""Gateway sign-up: a Windows handshake returns the caller's own secret, and nothing else.

The round trips run a real Negotiate (SSPI) handshake over loopback as the
account running the tests, so they need Windows and pywin32, as the Gateway
does.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
for path in (
    REPOSITORY_ROOT / "server-components" / "src",
    REPOSITORY_ROOT / "python-api" / "src",
    REPOSITORY_ROOT / "frontend",
):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import sspi  # noqa: E402
import win32api  # noqa: E402

from arcrho_api import hosted_save_enrollment  # noqa: E402
from arcrho_api.gateway_test_guard import allow_test_gateway  # noqa: E402
from arcrho_gateway import enrollment as gateway_enrollment  # noqa: E402
from arcrho_gateway import main as gateway_main  # noqa: E402
from arcrho_hosted_save_http_contract import (  # noqa: E402
    ENROLLMENT_CAPABILITY,
    ENROLLMENT_PATH,
    default_gateway_config,
    normalize_client_config,
    normalize_user,
)
from app_server.services import hosted_save_enrollment_service  # noqa: E402

# The account this test process runs as, which is who the handshake proves.
ME = normalize_user(win32api.GetUserName())


class LoopbackGateway:
    def __init__(self, test: unittest.TestCase, root: Path) -> None:
        self.test = test
        self.gateway = gateway_main.Gateway(root)
        self.server = gateway_main.GatewayServer(("127.0.0.1", 0), self.gateway)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        test.addCleanup(allow_test_gateway(self.url))
        test.addCleanup(thread.join, 5)
        test.addCleanup(self.server.server_close)
        test.addCleanup(self.server.shutdown)

    def connection(self) -> http.client.HTTPConnection:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        self.test.addCleanup(connection.close)
        return connection


def _post(connection: http.client.HTTPConnection, headers: dict[str, str], body: bytes = b"") -> tuple[int, dict, str]:
    connection.request("POST", ENROLLMENT_PATH, body=body, headers=headers)
    response = connection.getresponse()
    payload = json.loads(response.read().decode("utf-8"))
    return response.status, payload, response.getheader("WWW-Authenticate") or ""


def _negotiate(token: bytes) -> dict[str, str]:
    return {"Authorization": f"Negotiate {base64.b64encode(token).decode('ascii')}"}


class GatewayEnrollmentRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "server"
        (self.root / "projects").mkdir(parents=True)
        registry = default_gateway_config()
        registry["users"] = {"someone-else": "their-secret"}
        gateway_main._write_json_atomic(self.root / "config" / "arcrho_gateway.json", registry)
        self.gateway = LoopbackGateway(self, self.root)

    def _registry(self) -> dict:
        return json.loads((self.root / "config" / "arcrho_gateway.json").read_text(encoding="utf-8"))

    def test_a_windows_handshake_returns_the_callers_own_secret_minted_once(self) -> None:
        first = hosted_save_enrollment.request_windows_enrollment(self.gateway.url)
        again = hosted_save_enrollment.request_windows_enrollment(self.gateway.url)

        self.assertEqual(first["user"], ME)
        self.assertEqual(again, first)
        users = self._registry()["users"]
        self.assertEqual(users[ME], first["secret"])
        self.assertEqual(users["someone-else"], "their-secret")

    def test_the_capabilities_offer_sign_up(self) -> None:
        self.assertIs(self.gateway.gateway.capabilities()[ENROLLMENT_CAPABILITY], True)

    def test_a_name_in_the_request_is_never_trusted(self) -> None:
        status, payload, challenge = _post(
            self.gateway.connection(),
            {"X-ArcRho-User": "someone-else", "Content-Type": "application/json"},
            json.dumps({"user": "someone-else"}).encode("utf-8"),
        )

        self.assertEqual(status, 401)
        self.assertEqual(challenge, "Negotiate")
        self.assertNotIn("their-secret", json.dumps(payload))
        self.assertEqual(set(self._registry()["users"]), {"someone-else"})

    def test_a_forged_token_is_refused_and_writes_nothing(self) -> None:
        status, payload, _ = _post(self.gateway.connection(), _negotiate(b"NTLMSSP\x00forged"))

        self.assertEqual(status, 401)
        self.assertNotIn("sealed", payload)
        self.assertEqual(set(self._registry()["users"]), {"someone-else"})

    def test_the_handshake_is_bound_to_its_connection(self) -> None:
        client = sspi.ClientAuth("Negotiate")
        _, first = client.authorize(None)
        status, _, challenge = _post(self.gateway.connection(), _negotiate(first[0].Buffer))
        self.assertEqual(status, 401)
        _, second = client.authorize(base64.b64decode(challenge.split(" ", 1)[1]))

        status, payload, _ = _post(self.gateway.connection(), _negotiate(second[0].Buffer))

        self.assertEqual(status, 401)
        self.assertNotIn("sealed", payload)
        self.assertNotIn(ME, self._registry()["users"])

    def test_the_secret_never_crosses_the_wire_in_the_clear(self) -> None:
        connection = self.gateway.connection()
        client = sspi.ClientAuth("Negotiate")
        challenge = None
        while True:
            _, token = client.authorize(challenge)
            connection.request("POST", ENROLLMENT_PATH, body=b"", headers=_negotiate(token[0].Buffer))
            response = connection.getresponse()
            body = response.read()
            if response.status != 401:
                break
            challenge = base64.b64decode(response.getheader("WWW-Authenticate").split(" ", 1)[1])

        self.assertEqual(response.status, 200)
        self.assertNotIn(self._registry()["users"][ME].encode("ascii"), body)

    def test_handshakes_from_one_address_are_bounded(self) -> None:
        self.gateway.gateway.enrollment.limiter = gateway_enrollment.EnrollmentLimiter(attempts=2)
        statuses = [_post(self.gateway.connection(), {})[0] for _ in range(3)]

        self.assertEqual(statuses, [401, 401, 429])


class AccountCheckTests(unittest.TestCase):
    def test_only_a_real_user_account_signs_up(self) -> None:
        self.assertEqual(gateway_enrollment.check_account("S-1-5-21-1-2-3-1105", 1, "Alice"), "alice")
        refused = (
            ("S-1-5-7", 5, "ANONYMOUS LOGON"),
            ("S-1-5-21-1-2-3-501", 1, "Guest"),
            ("S-1-5-21-1-2-3-503", 1, "DefaultAccount"),
            ("S-1-5-18", 5, "SYSTEM"),
            ("S-1-5-21-1-2-3-513", 2, "Domain Users"),
        )
        for sid, sid_type, name in refused:
            with self.subTest(name=name), self.assertRaises(gateway_enrollment.EnrollmentRefused):
                gateway_enrollment.check_account(sid, sid_type, name)

    def test_the_limiter_forgets_an_address_after_its_window(self) -> None:
        now = [0.0]
        limiter = gateway_enrollment.EnrollmentLimiter(attempts=1, window=60, clock=lambda: now[0])

        self.assertTrue(limiter.allow("10.0.0.5"))
        self.assertFalse(limiter.allow("10.0.0.5"))
        self.assertTrue(limiter.allow("10.0.0.6"))
        now[0] = 60.0
        self.assertTrue(limiter.allow("10.0.0.5"))


class ClientSignUpWithoutTheShareTests(unittest.TestCase):
    """The desktop app signs up from the address alone; the server's folder is never opened."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.server_root = base / "server"
        (self.server_root / "projects").mkdir(parents=True)
        gateway_main._write_json_atomic(
            self.server_root / "config" / "arcrho_gateway.json", default_gateway_config()
        )
        self.gateway = LoopbackGateway(self, self.server_root)
        # The client's folder does not exist: nothing it could read is there.
        self.client_root = base / "unreachable share"
        self.credential = base / "client" / "arcrho_gateway.json"

    def _auto_enroll(self) -> dict:
        config = hosted_save_enrollment_service.config
        with (
            patch.object(config, "get_gateway_config_path", return_value=str(self.credential)),
            patch.object(config, "get_gateway_url", return_value=self.gateway.url),
            patch.object(config, "get_root_path", return_value=str(self.client_root)),
            patch.dict(os.environ, {"ARCRHO_RUNTIME_SERVER_ROOT": ""}),
        ):
            return hosted_save_enrollment_service.auto_enroll_current_user()

    def test_a_pc_with_no_share_access_signs_up_and_its_credential_signs_a_request(self) -> None:
        result = self._auto_enroll()

        self.assertEqual(result["status"], "enrolled", result)
        credential = normalize_client_config(json.loads(self.credential.read_text(encoding="utf-8")))
        self.assertEqual(credential["url"], self.gateway.url)
        self.assertEqual(credential["user"], ME)
        self.assertFalse(self.client_root.exists())
        body = b'{"RequestId":"abc"}'
        self.assertEqual(
            gateway_main.Gateway(self.server_root).authenticate(
                _signed_headers(credential, body), body, path=gateway_main.HOSTED_SAVE_PROGRESS_PATH
            ),
            ME,
        )

    def test_sign_up_stores_the_server_id_and_another_server_is_refused_later(self) -> None:
        self.gateway.gateway.server_id = "server-a"

        result = self._auto_enroll()

        self.assertEqual(result["status"], "enrolled", result)
        credential = normalize_client_config(json.loads(self.credential.read_text(encoding="utf-8")))
        self.assertEqual(credential["server_id"], "server-a")
        self.assertFalse(self.client_root.exists())
        # Another server now answers at the same address: the stored id refuses it.
        self.gateway.gateway.server_id = "server-b"
        client = hosted_save_enrollment_service.hosted_save_http_client
        with patch.dict(os.environ, {"ARCRHO_RUNTIME_SERVER_ROOT": ""}), self.assertRaises(
            client.GatewayServerMismatch
        ):
            client.probe_gateway(credential)


def _signed_headers(credential: dict, body: bytes) -> dict[str, str]:
    import time

    from arcrho_hosted_save_http_contract import (
        AUTH_SIGNATURE_HEADER,
        AUTH_TIMESTAMP_HEADER,
        AUTH_USER_HEADER,
        HOSTED_SAVE_PROGRESS_PATH,
        sign_request,
    )

    timestamp = str(int(time.time()))
    return {
        AUTH_USER_HEADER: credential["user"],
        AUTH_TIMESTAMP_HEADER: timestamp,
        AUTH_SIGNATURE_HEADER: sign_request(
            credential["secret"],
            user=credential["user"],
            timestamp=timestamp,
            method="POST",
            path=HOSTED_SAVE_PROGRESS_PATH,
            body=body,
        ),
    }


if __name__ == "__main__":
    unittest.main()
