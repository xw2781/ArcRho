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

from arcrho_api import hosted_save_enrollment  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.workspace_paths import (  # noqa: E402
    ServerProfileActivateRequest,
    ServerProfileSaveRequest,
    WorkspacePathsUpdateRequest,
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
        self.config_path.write_text(json.dumps({"workspace_root": str(self.production)}), encoding="utf-8")
        (self.settings / "arcrho_gateway.json").write_text(
            json.dumps({"url": "http://production:28767"}), encoding="utf-8"
        )
        for patcher in (
            patch.object(config, "WORKSPACE_PATHS_PATH", str(self.config_path)),
            patch.dict(os.environ, {
                "ARCRHO_SERVER_ROOT": "", "ARCRHO_RUNTIME_SERVER_ROOT": "", "ARCRHO_GATEWAY_CONFIG": "",
                "ARCRHO_GATEWAY_URL": "",
            }),
            patch.object(
                hosted_save_enrollment_service.hosted_save_http_client,
                "probe_gateway_identity",
                side_effect=lambda url: self.probed.append(url) or {"windows_enrollment": True},
            ),
            # The Gateway proves who is asking by Windows sign-in; here it answers for Alice.
            patch.object(
                hosted_save_enrollment,
                "request_windows_enrollment",
                return_value={"user": "alice", "secret": "local-secret"},
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)
        self.probed: list[str] = []

    def _add_local(self):
        return router.save_server_profile(
            ServerProfileSaveRequest(
                name="Local test", root=str(self.local), id="local", gateway_url="http://127.0.0.1:28767/"
            )
        )

    def test_listing_a_file_without_profiles_writes_nothing(self) -> None:
        before = self.config_path.read_bytes()

        listing = router.get_server_profiles()

        self.assertEqual(listing["active_profile"], "default")
        # Production is the default profile, the one the title bar shows no badge for.
        self.assertEqual(listing["default_profile"], "default")
        [profile] = listing["profiles"]
        self.assertEqual(profile["root"], str(self.production))
        self.assertEqual(profile["gateway_url"], "http://production:28767")
        self.assertTrue(profile["credential_exists"])
        self.assertEqual(listing["set_at_launch"], {"root": "", "gateway_config": "", "gateway_url": ""})
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_adding_a_server_keeps_the_active_one(self) -> None:
        result = self._add_local()

        self.assertFalse(result["restart_required"])
        self.assertEqual([p["id"] for p in result["profiles"]], ["default", "local"])
        local = result["profiles"][1]
        self.assertEqual(local["gateway_config"], str(self.settings / "arcrho_gateway.local.json"))
        self.assertFalse(local["credential_exists"])
        self.assertEqual(config.get_root_path(), str(self.production))

    def test_activating_a_server_signs_up_at_its_own_address_and_asks_for_restart(self) -> None:
        self._add_local()

        result = router.activate_server_profile(ServerProfileActivateRequest(id="local"))

        self.assertTrue(result["restart_required"])
        self.assertEqual(result["enrollment"]["status"], "enrolled")
        self.assertEqual(self.probed, ["http://127.0.0.1:28767"])
        credential = json.loads((self.settings / "arcrho_gateway.local.json").read_text(encoding="utf-8"))
        self.assertEqual(credential["url"], "http://127.0.0.1:28767")
        self.assertEqual((credential["user"], credential["secret"]), ("alice", "local-secret"))
        # The server's registry is server-only: the client neither reads nor writes it.
        self.assertFalse((self.local / "config" / "arcrho_gateway.json").exists())
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

    def test_a_server_without_a_credential_shows_its_profile_address(self) -> None:
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

    def test_inspecting_a_folder_names_it_without_reading_its_registry(self) -> None:
        found = router.inspect_server_folder(root=str(self.local))

        self.assertEqual(found, {"ok": True, "root": str(self.local.resolve()), "name": "local"})

        with self.assertRaises(HTTPException) as caught:
            router.inspect_server_folder(root=str(self.settings))
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_server_connection_save_keeps_the_address_and_reports_the_sign_up(self) -> None:
        (self.settings / "arcrho_gateway.json").unlink()

        saved = router.update_workspace_paths(
            WorkspacePathsUpdateRequest(workspace_root=str(self.production), gateway_url="http://production:28767")
        )

        self.assertEqual(saved["config"]["gateway_url"], "http://production:28767")
        self.assertEqual(saved["enrollment"]["status"], "enrolled")
        self.assertEqual(self.probed, ["http://production:28767"])
        self.assertEqual(router.get_workspace_paths()["config"]["gateway_url"], "http://production:28767")

    def test_a_first_run_without_an_address_asks_for_one(self) -> None:
        (self.settings / "arcrho_gateway.json").unlink()

        saved = router.update_workspace_paths(WorkspacePathsUpdateRequest(workspace_root=str(self.production)))

        self.assertEqual(saved["enrollment"], {"status": "not_configured"})
        self.assertEqual(self.probed, [])
        self.assertFalse((self.settings / "arcrho_gateway.json").exists())

    def test_unknown_server_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            router.activate_server_profile(ServerProfileActivateRequest(id="missing"))
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
