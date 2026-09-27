"""The client refuses a Gateway that serves a different server from its folder."""

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
        self.root = self.temp.name
        env = {k: v for k, v in os.environ.items() if k != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_root_path", return_value=self.root),
            patch.dict(hosted_save_http_client._ROOT_SERVER_IDS, clear=True),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)
        self.addCleanup(self.temp.cleanup)

    def _root_id(self, server_id: str) -> None:
        path = Path(self.root) / "config" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"server_id": server_id}), encoding="utf-8")

    def _probe(self, reported: str | None) -> dict:
        capabilities = {"hosted_save_http": True, "workspace_read_kinds": ["dataset_index"]}
        if reported is not None:
            capabilities["server_id"] = reported
        with patch.object(hosted_save_http_client, "_DIRECT_HTTP_OPENER", _Opener(capabilities)):
            return hosted_save_http_client.probe_gateway(GATEWAY)

    def test_matching_ids_are_served(self) -> None:
        self._root_id("server-a")
        self.assertEqual(self._probe("server-a")["server_id"], "server-a")

    def test_a_different_id_is_refused(self) -> None:
        self._root_id("server-a")
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch) as caught:
            self._probe("server-b")
        self.assertEqual(caught.exception.status_code, 409)

    def test_a_gateway_without_an_id_is_refused_for_a_root_with_one(self) -> None:
        self._root_id("server-a")
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
            self._probe(None)

    def test_a_root_without_an_id_refuses_a_gateway_with_one(self) -> None:
        with self.assertRaises(hosted_save_http_client.GatewayServerMismatch):
            self._probe("server-b")

    def test_neither_side_having_an_id_is_served(self) -> None:
        self.assertNotIn("server_id", self._probe(None))

    def test_server_processes_skip_the_check(self) -> None:
        self._root_id("server-a")
        with patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: self.root}):
            self._probe("server-b")

    def test_a_found_id_is_read_once_and_a_missing_one_again_later(self) -> None:
        with patch.object(api_config, "read_server_id", return_value="") as read:
            hosted_save_http_client.root_server_id(self.root)
            hosted_save_http_client.root_server_id(self.root)
            self.assertEqual(read.call_count, 1)
            with patch.object(hosted_save_http_client.time, "monotonic", return_value=1e12):
                hosted_save_http_client.root_server_id(self.root)
            self.assertEqual(read.call_count, 2)
        with patch.object(api_config, "read_server_id", return_value="server-a") as read:
            with patch.object(hosted_save_http_client.time, "monotonic", return_value=2e12):
                hosted_save_http_client.root_server_id(self.root)
                hosted_save_http_client.root_server_id(self.root)
            with patch.object(hosted_save_http_client.time, "monotonic", return_value=3e12):
                self.assertEqual(hosted_save_http_client.root_server_id(self.root), "server-a")
            self.assertEqual(read.call_count, 1)

    def test_a_refused_read_never_falls_back_to_the_share(self) -> None:
        self._root_id("server-a")
        local_calls = []
        opener = _Opener(
            {"hosted_save_http": True, "workspace_read_kinds": ["dataset_index"], "server_id": "b"}
        )
        with patch.object(hosted_save_http_client, "_DIRECT_HTTP_OPENER", opener), patch.object(
            config, "load_gateway_config", return_value=GATEWAY
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
