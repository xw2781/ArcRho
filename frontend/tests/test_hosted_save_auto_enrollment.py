"""Automatic sign-up as the desktop app's server starts.

The app signs up at the address its server profile (or a launch override)
names, and never opens the server's folder: the Gateway proves who is asking
by Windows sign-in and answers with that user's own secret.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import hosted_save_enrollment
from arcrho_api.hosted_save_enrollment import provision_gateway_user
from arcrho_hosted_save_http_contract import default_gateway_config, normalize_client_config
from app_server.services import hosted_save_enrollment_service

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY_URL = "http://gateway.test:28767"


class HostedSaveAutoEnrollmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.local_path = self.root / "local" / "arcrho_gateway.json"
        self.signed_up: list[str] = []

    def _auto_enroll(self, *, url: str = GATEWAY_URL, probe=None):
        config = hosted_save_enrollment_service.config
        client = hosted_save_enrollment_service.hosted_save_http_client
        with (
            patch.object(config, "get_gateway_config_path", return_value=str(self.local_path)),
            patch.object(config, "get_gateway_url", return_value=url),
            # Any read of the server's folder would fail: there is none.
            patch.object(config, "get_root_path", side_effect=AssertionError("the share was read")),
            patch.object(
                client,
                "fetch_gateway_capabilities",
                side_effect=probe or (lambda _url: {"windows_enrollment": True}),
            ) as probed,
            patch.object(
                hosted_save_enrollment,
                "request_windows_enrollment",
                side_effect=lambda url: self.signed_up.append(url) or {"user": "alice", "secret": "s3cret"},
            ),
        ):
            return hosted_save_enrollment_service.auto_enroll_current_user(), probed

    def test_startup_signs_up_at_the_profile_address(self) -> None:
        result, probe = self._auto_enroll()

        self.assertEqual(result["status"], "enrolled")
        probe.assert_called_once_with(GATEWAY_URL)
        self.assertEqual(self.signed_up, [GATEWAY_URL])
        local = normalize_client_config(json.loads(self.local_path.read_text(encoding="utf-8")))
        self.assertEqual((local["url"], local["user"], local["secret"]), (GATEWAY_URL, "alice", "s3cret"))

    def test_existing_local_config_is_never_replaced(self) -> None:
        self.local_path.parent.mkdir(parents=True)
        self.local_path.write_text('{"enabled": false}\n', encoding="utf-8")

        result, probe = self._auto_enroll()

        self.assertEqual(result["status"], "existing")
        probe.assert_not_called()
        self.assertEqual(self.local_path.read_text(encoding="utf-8"), '{"enabled": false}\n')

    def test_an_unreachable_gateway_writes_nothing(self) -> None:
        def offline(_url):
            raise HTTPException(503, "Arco Gateway is unavailable.")

        result, _ = self._auto_enroll(probe=offline)

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(self.signed_up, [])
        self.assertFalse(self.local_path.exists())

    def test_sign_up_stores_the_server_id_the_gateway_reports(self) -> None:
        result, _ = self._auto_enroll(
            probe=lambda _url: {"windows_enrollment": True, "server_id": "server-a"}
        )

        self.assertEqual(result["status"], "enrolled")
        local = normalize_client_config(json.loads(self.local_path.read_text(encoding="utf-8")))
        self.assertEqual(local["server_id"], "server-a")

    def test_a_gateway_without_sign_up_is_reported_as_needing_an_update(self) -> None:
        result, _ = self._auto_enroll(probe=lambda _url: {"hosted_save_http": True})

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("needs updating", result["reason"])
        self.assertFalse(self.local_path.exists())

    def test_no_known_address_writes_nothing(self) -> None:
        result, probe = self._auto_enroll(url="")

        self.assertEqual(result["status"], "not_configured")
        probe.assert_not_called()
        self.assertFalse(self.local_path.exists())


class ServerSideProvisioningTests(unittest.TestCase):
    """The server-side tools still write the registry directly, where it is local disk."""

    def test_concurrent_provisioning_preserves_multiple_users(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT)) as temporary:
            root = Path(temporary)
            registry = default_gateway_config()
            registry["client_url"] = GATEWAY_URL
            (root / "config").mkdir()
            (root / "config" / "arcrho_gateway.json").write_text(json.dumps(registry), encoding="utf-8")
            paths = {"Alice": root / "alice" / "arcrho_gateway.json", "Bob": root / "bob" / "arcrho_gateway.json"}
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [
                    executor.submit(provision_gateway_user, server_root=root, user=user, client_output=path)
                    for user, path in paths.items()
                ]
                for future in futures:
                    future.result(timeout=5)

            shared = json.loads((root / "config" / "arcrho_gateway.json").read_text(encoding="utf-8"))
            self.assertEqual(set(shared["users"]), {"alice", "bob"})
            for user, path in paths.items():
                self.assertEqual(
                    shared["users"][user.lower()], json.loads(path.read_text(encoding="utf-8"))["secret"]
                )


if __name__ == "__main__":
    unittest.main()
