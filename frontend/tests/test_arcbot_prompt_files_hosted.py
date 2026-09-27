"""ArcBot's shared prompt files are read on the server host.

A Client PC asks the Gateway for them and never opens config\\arcbot over the
share; with no Gateway the route refuses rather than reading the share. The
read itself writes nothing, so a server without the files stays without them.
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
from fastapi.encoders import jsonable_encoder

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import config as api_config  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.services import arcbot_prompt_service, workspace_read_client  # noqa: E402

router = importlib.import_module("app_server.api.app_control_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}


class ArcBotPromptFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.server_root = Path(self.temp.name) / "server"
        self.client_root = Path(self.temp.name) / "client"
        self.client_root.mkdir()
        arcbot = self.server_root / "config" / "arcbot"
        (arcbot / "instructions").mkdir(parents=True)
        (arcbot / "arcbot_prompt.md").write_text("Server entry prompt", encoding="utf-8")
        (arcbot / "instructions" / "dfm_workflow.md").write_text("Select factors with care.", encoding="utf-8")
        (arcbot / "instructions" / "_draft.md").write_text("Not shared yet.", encoding="utf-8")
        (arcbot / "instructions" / "notes.txt").write_text("Not markdown.", encoding="utf-8")
        self.requests: list[dict] = []
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_root_path", return_value=str(self.client_root)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={"workspace_read_kinds": ["arcbot_prompt_files"]},
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        request = json.loads(json.dumps(request_payload))
        self.requests.append(request)
        spec = WORKSPACE_READ_KINDS[request["ReadKind"]]
        self.assertEqual((spec.module, spec.function), ("arcbot_prompt_service", "read_arcbot_prompt_files"))
        with patch.object(config, "get_root_path", return_value=str(self.server_root)):
            answer = jsonable_encoder(arcbot_prompt_service.read_arcbot_prompt_files(**request["Kwargs"]))
        return answer, str(self.server_root), 0

    def _server_files(self) -> list[str]:
        return sorted(str(path.relative_to(self.server_root)) for path in self.server_root.rglob("*"))

    def test_the_route_reads_the_servers_files_through_the_gateway(self) -> None:
        before = self._server_files()
        answer = router.arcbot_prompt_files()
        self.assertEqual(answer["prompt"], "Server entry prompt")
        self.assertEqual(answer["instructions"], [{"name": "dfm_workflow.md", "text": "Select factors with care."}])
        # Paths come back on this PC's own root, for the Prompt Guide to show.
        self.assertEqual(answer["prompt_path"], str(self.client_root / "config" / "arcbot" / "arcbot_prompt.md"))
        self.assertEqual([request["ReadKind"] for request in self.requests], ["arcbot_prompt_files"])
        self.assertEqual(self._server_files(), before)
        self.assertEqual(list(self.client_root.iterdir()), [])

    def test_a_server_without_the_files_answers_none_and_seeds_nothing(self) -> None:
        empty_root = Path(self.temp.name) / "empty"
        empty_root.mkdir()
        with patch.object(config, "get_root_path", return_value=str(empty_root)):
            answer = arcbot_prompt_service.read_arcbot_prompt_files()
        self.assertIsNone(answer["prompt"])
        self.assertEqual(answer["instructions"], [])
        self.assertEqual(list(empty_root.iterdir()), [])

    def test_without_the_gateway_the_route_refuses_instead_of_reading_the_share(self) -> None:
        with patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None):
            with self.assertRaises(HTTPException) as refused:
                router.arcbot_prompt_files()
        self.assertEqual(refused.exception.status_code, 503)
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
