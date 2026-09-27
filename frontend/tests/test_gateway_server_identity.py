"""The client refuses a Gateway that is not the server its credential signed up with."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
TEST_TEMP_ROOT = FRONTEND_ROOT.parent / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

from arcrho_api import config as api_config
from app_server import config
from app_server.services import hosted_save_http_client, workspace_read_client

GATEWAY = {"enabled": True, "url": "http://gateway.test:28767", "user": "alice", "secret": "s"}


class _Opener:
    def __init__(self, capabilities: dict) -> None:
        self.capabilities = capabilities
        self.calls = 0

    def open(self, request, timeout=None):
        self.calls += 1
        return io.BytesIO(json.dumps(self.capabilities).encode("utf-8"))


class GatewayServerIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.credential = Path(self.temp.name) / "arcrho_gateway.json"
        env = {k: v for k, v in os.environ.items() if k != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_gateway_config_path", return_value=str(self.credential)),
            # The check needs nothing from the server's folder.
            patch.object(config, "get_root_path", side_effect=AssertionError("the folder was read")),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _credential(self, server_id: str | None) -> dict:
        stored = {"config_version": 1, **GATEWAY, "allow_insecure_http": True}
        if server_id is not None:
            stored["server_id"] = server_id
        self.credential.write_text(json.dumps(stored), encoding="utf-8")
        return config.load_gateway_config()

    def _probe(self, gateway: dict, reported: str | None) -> dict:
        capabilities = {"hosted_save_http": True, "workspace_read_kinds": ["dataset_index"]}
        if reported is not None:
            capabilities["server_id"] = reported
        with patch.object(hosted_save_http_client, "_DIRECT_HTTP_OPENER", _Opener(capabilities)):
            return hosted_save_http_client.probe_gateway(gateway)

    def test_the_id_signed_up_with_is_served(self) -> None:
        gateway = self._credential("server-a")
        self.assertEqual(self._probe(gateway, "server-a")["server_id"], "server-a")

    def test_a_different_id_is_refused(self) -> None:
        gateway = self._credential("server-a")
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch) as caught:
            self._probe(gateway, "server-b")
        self.assertEqual(caught.exception.status_code, 409)

    def test_a_gateway_without_an_id_is_refused_for_a_credential_with_one(self) -> None:
        gateway = self._credential("server-a")
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
            self._probe(gateway, None)

    def test_a_credential_from_before_ids_adopts_the_first_gateways_id(self) -> None:
        gateway = self._credential(None)
        self._probe(gateway, "server-a")
        adopted = config.load_gateway_config()
        self.assertEqual(adopted["server_id"], "server-a")
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
            self._probe(adopted, "server-b")

    def test_neither_side_having_an_id_is_served(self) -> None:
        gateway = self._credential(None)
        self.assertNotIn("server_id", self._probe(gateway, None))
        self.assertEqual(config.load_gateway_config()["server_id"], "")

    def test_server_processes_skip_the_check(self) -> None:
        gateway = self._credential("server-a")
        with patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: self.temp.name}):
            self._probe(gateway, "server-b")

    def test_a_refused_read_never_runs_on_this_pc(self) -> None:
        gateway = self._credential("server-a")
        local_calls = []
        opener = _Opener(
            {"hosted_save_http": True, "workspace_read_kinds": ["dataset_index"], "server_id": "b"}
        )
        with patch.object(hosted_save_http_client, "_DIRECT_HTTP_OPENER", opener), patch.object(
            config, "load_gateway_config", return_value=gateway
        ), patch.object(workspace_read_client, "_log"):
            with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
                workspace_read_client.run_workspace_read(
                    "dataset_index",
                    {"project_name": "Demo"},
                    local=lambda: local_calls.append(1) or {"ok": True},
                )
        self.assertEqual(local_calls, [])


if __name__ == "__main__":
    unittest.main()
