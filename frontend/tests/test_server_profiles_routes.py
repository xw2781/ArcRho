"""Server profile routes: list, add and activate servers, each with its own sign-in."""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_hosted_save_http_contract import default_gateway_config  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.workspace_paths import (  # noqa: E402
    ServerProfileActivateRequest,
    ServerProfileSaveRequest,
)
from app_server.services import hosted_save_enrollment_service, server_profile_service  # noqa: E402

# The api package re-exports each module's router object under the module's name.
router = importlib.import_module("app_server.api.workspace_paths_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class ServerProfileRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        # Runs last, once the patches are gone, so later tests see the real paths.
        self.addCleanup(config.refresh_runtime_paths)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        base = Path(self.temp.name)
        self.settings = base / "appdata"
        self.settings.mkdir()
        self.config_path = self.settings / "workspace_paths.json"
        self.production = base / "production"
        self.local = base / "local"
        for root in (self.production, self.local):
            (root / "projects").mkdir(parents=True)
            (root / "config").mkdir()
        registry = default_gateway_config()
        registry["client_url"] = "http://127.0.0.1:28767"
        (self.local / "config" / "arcrho_gateway.json").write_text(json.dumps(registry), encoding="utf-8")
        self.config_path.write_text(json.dumps({"workspace_root": str(self.production)}), encoding="utf-8")
        (self.settings / "arcrho_gateway.json").write_text(
            json.dumps({"url": "http://production:28767"}), encoding="utf-8"
        )
        for patcher in (
            patch.object(config, "WORKSPACE_PATHS_PATH", str(self.config_path)),
            patch.dict(os.environ, {"ARCRHO_SERVER_ROOT": "", "ARCRHO_RUNTIME_SERVER_ROOT": "", "ARCRHO_GATEWAY_CONFIG": ""}),
            patch.object(hosted_save_enrollment_service.user_identity_service, "get_windows_login_name", return_value="Alice"),
            patch.object(hosted_save_enrollment_service.hosted_save_http_client, "probe_gateway", return_value={}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)

    def _add_local(self):
        return router.save_server_profile(
            ServerProfileSaveRequest(name="Local test", root=str(self.local), id="local")
        )

    def test_listing_a_file_without_profiles_writes_nothing(self) -> None:
        before = self.config_path.read_bytes()

        listing = router.get_server_profiles()

        self.assertEqual(listing["active_profile"], "default")
        [profile] = listing["profiles"]
        self.assertEqual(profile["root"], str(self.production))
        self.assertEqual(profile["gateway_url"], "http://production:28767")
        self.assertTrue(profile["credential_exists"])
        self.assertEqual(listing["set_at_launch"], {"root": "", "gateway_config": ""})
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_adding_a_server_keeps_the_active_one(self) -> None:
        result = self._add_local()

        self.assertFalse(result["restart_required"])
        self.assertEqual([p["id"] for p in result["profiles"]], ["default", "local"])
        local = result["profiles"][1]
        self.assertEqual(local["gateway_config"], str(self.settings / "arcrho_gateway.local.json"))
        self.assertFalse(local["credential_exists"])
        self.assertEqual(config.get_root_path(), str(self.production))

    def test_activating_a_server_enrolls_against_its_own_gateway_and_asks_for_restart(self) -> None:
        self._add_local()

        result = router.activate_server_profile(ServerProfileActivateRequest(id="local"))

        self.assertTrue(result["restart_required"])
        self.assertEqual(result["enrollment"]["status"], "enrolled")
        credential = json.loads((self.settings / "arcrho_gateway.local.json").read_text(encoding="utf-8"))
        self.assertEqual(credential["url"], "http://127.0.0.1:28767")
        registry = json.loads((self.local / "config" / "arcrho_gateway.json").read_text(encoding="utf-8"))
        self.assertEqual(registry["users"]["alice"], credential["secret"])
        self.assertEqual(config.get_root_path(), str(self.local))
        self.assertEqual(config.get_gateway_config_path(), str(self.settings / "arcrho_gateway.local.json"))
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf-8"))["workspace_root"], str(self.local))

        back = router.activate_server_profile(ServerProfileActivateRequest(id="default"))
        self.assertTrue(back["restart_required"])
        self.assertEqual(back["enrollment"]["status"], "existing")
        self.assertEqual(config.get_gateway_config_path(), str(self.settings / "arcrho_gateway.json"))

    def test_a_server_set_at_launch_cannot_be_changed(self) -> None:
        self._add_local()
        before = self.config_path.read_bytes()

        with patch.dict(os.environ, {"ARCRHO_SERVER_ROOT": str(self.local)}):
            listing = router.get_server_profiles()
            with self.assertRaises(HTTPException) as caught:
                router.activate_server_profile(ServerProfileActivateRequest(id="local"))

        self.assertEqual(listing["set_at_launch"]["root"], str(self.local))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_a_server_without_a_credential_shows_its_registry_address(self) -> None:
        self._add_local()

        listing = router.get_server_profiles()

        local = listing["profiles"][1]
        self.assertEqual(local["gateway_url"], "http://127.0.0.1:28767")
        self.assertEqual(local["user"], "")
        self.assertEqual(listing["current"]["root"], str(self.production))
        self.assertEqual(listing["current"]["gateway_url"], "http://production:28767")

    def test_health_is_probed_by_the_app_server_for_one_profile_or_this_window(self) -> None:
        self._add_local()
        probed = []

        def probe(url):
            probed.append(url)
            if "127.0.0.1" in url:
                raise URLError("connection refused")

        with patch.object(server_profile_service.hosted_save_http_client, "probe_gateway_health", side_effect=probe):
            local = router.get_server_health(id="local")
            current = router.get_server_health(id="")

        self.assertEqual(probed, ["http://127.0.0.1:28767", "http://production:28767"])
        self.assertFalse(local["ok"])
        self.assertIn("connection refused", local["detail"])
        self.assertTrue(current["ok"])
        with self.assertRaises(HTTPException) as caught:
            router.get_server_health(id="missing")
        self.assertEqual(caught.exception.status_code, 404)

    def test_the_health_probe_asks_the_gateway_health_path(self) -> None:
        opened = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"ok": true}'

        def open_request(request, timeout):
            opened.append((request.full_url, timeout))
            return Response()

        client = server_profile_service.hosted_save_http_client
        with patch.object(client._DIRECT_HTTP_OPENER, "open", side_effect=open_request):
            client.probe_gateway_health("http://127.0.0.1:28767")

        self.assertEqual(opened, [("http://127.0.0.1:28767/api/health", client.GATEWAY_HEALTH_TIMEOUT_SECONDS)])

    def test_inspecting_a_folder_reads_its_registry_address(self) -> None:
        found = router.inspect_server_folder(root=str(self.local))

        self.assertEqual(found["root"], str(self.local.resolve()))
        self.assertEqual(found["name"], "local")
        self.assertEqual(found["gateway_url"], "http://127.0.0.1:28767")

        registry = default_gateway_config()
        registry["host"] = "SERVERPC"
        (self.production / "config" / "arcrho_gateway.json").write_text(json.dumps(registry), encoding="utf-8")
        self.assertEqual(router.inspect_server_folder(root=str(self.production))["gateway_url"], "http://SERVERPC:28767")

        with self.assertRaises(HTTPException) as caught:
            router.inspect_server_folder(root=str(self.settings))
        self.assertEqual(caught.exception.status_code, 400)

    def test_unknown_server_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            router.activate_server_profile(ServerProfileActivateRequest(id="missing"))
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
