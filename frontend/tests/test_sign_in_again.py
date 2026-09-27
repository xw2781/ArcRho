"""Signing in to the server again from the Server tab.

A credential the server refuses is replaced by a fresh Windows sign-up, but
only once the new secret has arrived; the server id it signed up with is kept,
and the next request probes with the new credential without a restart.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import hosted_save_enrollment  # noqa: E402
from app_server import config  # noqa: E402
from app_server.services import hosted_save_http_client, workspace_read_client  # noqa: E402

router = importlib.import_module("app_server.api.workspace_paths_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY_URL = "http://127.0.0.1:28767"


class SignInAgainRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.addCleanup(config.refresh_runtime_paths)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.settings = base / "appdata"
        self.settings.mkdir()
        self.root = base / "server"
        (self.root / "projects").mkdir(parents=True)
        (self.root / "config").mkdir()
        self.config_path = self.settings / "workspace_paths.json"
        self.config_path.write_text(json.dumps({"workspace_root": str(self.root)}), encoding="utf-8")
        self.credential = self.settings / "arcrho_gateway.json"
        self.reported_id = "server-a"
        self.signed_up: list[str] = []
        self.sign_up_error: Exception | None = None
        for patcher in (
            patch.object(config, "WORKSPACE_PATHS_PATH", str(self.config_path)),
            patch.dict(os.environ, {
                "ARCRHO_SERVER_ROOT": "", "ARCRHO_RUNTIME_SERVER_ROOT": "", "ARCRHO_GATEWAY_CONFIG": "",
                "ARCRHO_GATEWAY_URL": "",
            }),
            patch.object(
                hosted_save_http_client,
                "fetch_gateway_capabilities",
                side_effect=lambda _url: {"windows_enrollment": True, "server_id": self.reported_id},
            ),
            patch.object(hosted_save_enrollment, "request_windows_enrollment", side_effect=self._sign_up),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _sign_up(self, url: str) -> dict[str, str]:
        if self.sign_up_error is not None:
            raise self.sign_up_error
        self.signed_up.append(url)
        return {"user": "alice", "secret": "fresh-secret"}

    def _write_credential(self, path: Path, **extra) -> bytes:
        payload = {"config_version": 1, "enabled": True, "url": GATEWAY_URL, "user": "alice",
                   "secret": "refused-secret", "allow_insecure_http": True, **extra}
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path.read_bytes()

    def _stored(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_a_refused_credential_is_replaced_and_the_next_request_probes_again(self) -> None:
        self._write_credential(self.credential, server_id="server-a")
        with workspace_read_client._CAPABILITY_LOCK:
            workspace_read_client._CAPABILITY_CACHE[GATEWAY_URL] = (float("inf"), None)

        listing = router.sign_in_again()

        self.assertEqual(listing["signed_in"]["user"], "alice")
        self.assertEqual(self.signed_up, [GATEWAY_URL])
        stored = self._stored(self.credential)
        self.assertEqual((stored["secret"], stored["server_id"]), ("fresh-secret", "server-a"))
        self.assertEqual(workspace_read_client._CAPABILITY_CACHE, {})

    def test_a_failed_sign_up_leaves_the_old_credential_untouched(self) -> None:
        before = self._write_credential(self.credential, server_id="server-a")
        self.sign_up_error = RuntimeError("The logon attempt failed")

        with self.assertRaises(HTTPException) as caught:
            router.sign_in_again()

        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("The logon attempt failed", caught.exception.detail)
        self.assertEqual(self.credential.read_bytes(), before)

    def test_a_silent_gateway_leaves_the_old_credential_untouched(self) -> None:
        before = self._write_credential(self.credential, server_id="server-a")

        def offline(_url):
            raise HTTPException(503, hosted_save_http_client.SERVER_UNREACHABLE_MESSAGE)

        with patch.object(hosted_save_http_client, "fetch_gateway_capabilities", side_effect=offline):
            with self.assertRaises(HTTPException) as caught:
                router.sign_in_again()

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.credential.read_bytes(), before)

    def test_a_gateway_reporting_another_server_is_refused_before_sign_up(self) -> None:
        before = self._write_credential(self.credential, server_id="server-a")
        self.reported_id = "server-b"

        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
            router.sign_in_again()

        self.assertEqual(self.signed_up, [])
        self.assertEqual(self.credential.read_bytes(), before)

    def test_a_credential_without_a_server_id_takes_the_gateways(self) -> None:
        self._write_credential(self.credential)

        router.sign_in_again()

        self.assertEqual(self._stored(self.credential)["server_id"], "server-a")

    def test_a_launch_session_signs_in_again_for_its_own_credential(self) -> None:
        launch_credential = self.settings / "launch" / "arcrho_gateway.local.json"
        launch_credential.parent.mkdir()
        self._write_credential(launch_credential, server_id="server-a")
        with patch.dict(os.environ, {
            "ARCRHO_GATEWAY_CONFIG": str(launch_credential), "ARCRHO_GATEWAY_URL": GATEWAY_URL,
        }):
            router.sign_in_again()

        self.assertEqual(self._stored(launch_credential)["secret"], "fresh-secret")
        self.assertFalse(self.credential.exists())


if __name__ == "__main__":
    unittest.main()
