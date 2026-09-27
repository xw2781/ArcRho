"""The Server tab's component status and start/stop.

Status comes from the disk for a folder on this PC and the Gateway otherwise, never the
share; start and stop act only on a non-production folder on a fixed disk of this PC.
"""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import arcrho_server_control as server_control  # noqa: E402
from arcrho_api import config as api_config  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.services import (  # noqa: E402
    hosted_save_http_client,
    server_component_status_service,
    server_profile_service,
    workspace_read_client,
)

router = importlib.import_module("app_server.api.workspace_paths_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
KIND = server_profile_service.COMPONENT_STATUS_READ_KIND
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}


class ServerComponentStatusRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        folder = self.root / "runtime" / "instances" / "arcrho_engine"
        folder.mkdir(parents=True)
        (folder / "PC1@alice@260926-220000-000.json").write_text(
            json.dumps({"Server": "PC1@alice@260926-220000-000", "Last seen": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}),
            encoding="utf-8",
        )
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_root_path", return_value=str(self.root)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _remote(self):
        return patch.object(server_profile_service, "is_on_local_fixed_disk", return_value=False)

    def _no_share_read(self):
        return patch.object(
            server_component_status_service,
            "get_server_component_status",
            side_effect=AssertionError("a remote server's runtime folder must never be read over the share"),
        )

    def test_the_read_is_registered_and_names_no_arguments(self) -> None:
        spec = WORKSPACE_READ_KINDS[KIND]
        self.assertEqual((spec.module, spec.function, spec.required, spec.optional),
                         ("server_component_status_service", "get_server_component_status", (), ()))

    def test_a_folder_on_this_pc_is_read_from_disk_even_with_the_gateway_down(self) -> None:
        with patch.object(server_profile_service, "is_on_local_fixed_disk", return_value=True), \
                patch.object(workspace_read_client, "run_workspace_read", side_effect=AssertionError("no Gateway")):
            status = router.get_server_component_status()

        self.assertEqual((status["source"], status["answering"]), ("disk", True))
        engine = next(role for role in status["roles"] if role["role"] == "engine")
        self.assertEqual([(row["machine"], row["status"]) for row in engine["instances"]], [("PC1", "Active")])

    def test_a_remote_folder_is_asked_through_the_gateway_only(self) -> None:
        answer = {"ok": True, "checked_at": "2026-09-26 22:00:00", "roles": []}
        with self._remote(), patch.object(workspace_read_client, "run_workspace_read", return_value=answer) as read:
            status = server_profile_service.server_component_status()

        read.assert_called_once()
        self.assertEqual(read.call_args.args[:2], (KIND, {}))
        self.assertIs(read.call_args.kwargs["gateway_required"], True)
        self.assertEqual((status["source"], status["answering"]), ("gateway", True))

    def test_a_silent_gateway_is_reported_and_nothing_is_read_over_the_share(self) -> None:
        with self._remote(), self._no_share_read(), \
                patch.object(hosted_save_http_client, "probe_gateway", side_effect=HTTPException(503, "down")):
            status = server_profile_service.server_component_status()

        self.assertEqual((status["source"], status["answering"], status["roles"]), ("gateway", False, []))
        self.assertEqual(status["detail"], server_profile_service.GATEWAY_NOT_ANSWERING)

    def test_a_gateway_that_drops_the_request_is_not_answering(self) -> None:
        capabilities = {"workspace_read_kinds": [KIND]}
        failure = workspace_read_client.GatewayTransportFailure("connection_refused")
        with self._remote(), self._no_share_read(), \
                patch.object(hosted_save_http_client, "probe_gateway", return_value=capabilities), \
                patch.object(workspace_read_client, "post_signed_json", side_effect=failure):
            status = server_profile_service.server_component_status()

        self.assertFalse(status["answering"])
        self.assertEqual(status["detail"], server_profile_service.GATEWAY_NOT_ANSWERING)

    def test_a_gateway_too_old_for_the_read_says_it_needs_updating(self) -> None:
        capabilities = {"workspace_read_kinds": ["dataset_index"]}
        with self._remote(), self._no_share_read(), \
                patch.object(hosted_save_http_client, "probe_gateway", return_value=capabilities):
            status = server_profile_service.server_component_status()

        self.assertFalse(status["answering"])
        self.assertEqual(status["detail"], server_profile_service.GATEWAY_NEEDS_UPDATE)

    def test_a_gateway_for_another_server_is_refused_not_hidden(self) -> None:
        mismatch = hosted_save_http_client.GatewayServerMismatch()
        with self._remote(), self._no_share_read(), \
                patch.object(hosted_save_http_client, "probe_gateway", side_effect=mismatch):
            with self.assertRaises(HTTPException) as caught:
                server_profile_service.server_component_status()
        self.assertEqual(caught.exception.status_code, 409)


class ServerStartStopRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "Arco Server"
        (self.root / "config").mkdir(parents=True)
        self.config = self.root / "config" / "config.json"
        self.config.write_text(json.dumps({"apps": {}}), encoding="utf-8")
        exe = server_control.orchestrator_exe(self.root)
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b"exe")

    def _serve(self, root):
        return patch.object(config, "get_root_path", return_value=str(root))

    def _switches(self) -> dict:
        apps = json.loads(self.config.read_text(encoding="utf-8"))["apps"]
        return {role: apps[role]["kill_all"] for role in server_control.SUPERVISED_ROLES}

    def test_a_network_non_fixed_or_production_folder_is_refused_and_left_alone(self) -> None:
        cases = [
            (r"\server\share\Arco Server", None),
            (str(self.root), False),
            (config.DEFAULT_WORKSPACE_ROOT, None),
        ]
        for root, fixed_disk in cases:
            fixed = (
                contextlib.nullcontext() if fixed_disk is None
                else patch.object(server_control, "is_on_local_fixed_disk", return_value=fixed_disk)
            )
            for route in (router.start_server, router.stop_server):
                with self.subTest(root=root, route=route.__name__), self._serve(root),                         patch.object(server_control.subprocess, "Popen") as popen,                         fixed:
                    with self.assertRaises(HTTPException) as caught:
                        route()
                    self.assertEqual(caught.exception.status_code, 409)
                    popen.assert_not_called()
        self.assertEqual(json.loads(self.config.read_text(encoding="utf-8")), {"apps": {}})

    def test_the_status_says_whether_this_server_can_be_started_and_stopped(self) -> None:
        with self._serve(self.root):
            control = router.get_server_component_status()["control"]
        self.assertEqual(control, {"available": True, "detail": "", "roles": ["orchestrator", "engine", "gateway"]})
        with self._serve(config.DEFAULT_WORKSPACE_ROOT),                 patch.object(server_profile_service, "is_on_local_fixed_disk", return_value=False),                 patch.object(workspace_read_client, "run_workspace_read", return_value={"ok": True, "roles": []}):
            control = router.get_server_component_status()["control"]
        self.assertEqual((control["available"], control["detail"]), (False, server_control.PRODUCTION_REFUSAL))

    def test_stop_sets_and_start_clears_the_switches_without_the_windows_overrides(self) -> None:
        with self._serve(self.root):
            self.assertEqual(router.stop_server(), {"ok": True, "stopped": True})
            self.assertEqual(self._switches(), {"orchestrator": True, "engine": True, "gateway": True})
            overrides = {api_config.SERVER_ROOT_ENV: str(self.root), "ARCRHO_GATEWAY_CONFIG": r"C:\cred.json"}
            with patch.dict(os.environ, overrides), patch.object(server_control.subprocess, "Popen") as popen:
                self.assertEqual(router.start_server(), {"ok": True, "launched": True})
        self.assertEqual(self._switches(), {"orchestrator": False, "engine": False, "gateway": False})
        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["ARCRHO_ROOT"], str(self.root))
        self.assertFalse(set(server_control.ROOT_ENV_VARS[:2] + ("ARCRHO_GATEWAY_CONFIG",)) & set(env))


if __name__ == "__main__":
    unittest.main()
