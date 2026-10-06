"""ArcBot's skills are read on the server host.

A skill is a folder under shared\\agent-skills. A Client PC asks the Gateway for
the list, or for one skill's text, and never opens the folder over the share.
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
from app_server.services import agent_skill_service, workspace_read_client  # noqa: E402

router = importlib.import_module("app_server.api.app_control_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}

SKILL_MD = """---
title: DFM Diagnostics
description: Review the open DFM.
scope: DFM
macros: show_diagnostic_triangle, other_macro
version: 1.0.0
---

Step one.
"""


class AgentSkillsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.server_root = Path(self.temp.name) / "server"
        self.client_root = Path(self.temp.name) / "client"
        self.client_root.mkdir()
        skills = self.server_root / "shared" / "agent-skills"
        skill = skills / "dfm-diagnostics"
        (skill / "references").mkdir(parents=True)
        (skill / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
        (skill / "references" / "signals.md").write_text("A high value lowers the factor.", encoding="utf-8")
        (skill / "references" / "mapping.json").write_text('{"mappings": []}', encoding="utf-8")
        (skill / "references" / "scratch.txt").write_text("Not a reference.", encoding="utf-8")
        (skills / "_draft").mkdir()
        (skills / "_draft" / "SKILL.md").write_text("Not shared yet.", encoding="utf-8")
        (skills / "no-skill-file").mkdir()
        self.requests: list[dict] = []
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_root_path", return_value=str(self.client_root)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={"workspace_read_kinds": ["agent_skills"]},
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
        self.assertEqual((spec.module, spec.function), ("agent_skill_service", "read_agent_skills"))
        with patch.object(config, "get_root_path", return_value=str(self.server_root)):
            answer = jsonable_encoder(agent_skill_service.read_agent_skills(**request["Kwargs"]))
        return answer, str(self.server_root), 0

    def test_the_list_carries_each_skills_menu_entry_without_its_text(self) -> None:
        answer = router.arcbot_agent_skills()
        self.assertEqual(answer, {"skills": [{
            "id": "dfm-diagnostics",
            "title": "DFM Diagnostics",
            "description": "Review the open DFM.",
            "scope": "dfm",
            "macros": ["show_diagnostic_triangle", "other_macro"],
            "version": "1.0.0",
        }]})
        self.assertEqual([request["Kwargs"] for request in self.requests], [{}])

    def test_one_skill_carries_its_instructions_and_markdown_and_json_references(self) -> None:
        answer = router.arcbot_agent_skills("dfm-diagnostics")
        [skill] = answer["skills"]
        self.assertEqual(skill["instructions"], "Step one.")
        self.assertEqual(
            skill["references"],
            [
                {"name": "mapping.json", "text": '{"mappings": []}'},
                {"name": "signals.md", "text": "A high value lowers the factor."},
            ],
        )
        self.assertEqual([request["Kwargs"] for request in self.requests], [{"skill_id": "dfm-diagnostics"}])

    def test_a_skill_id_that_is_not_a_folder_name_reads_nothing_more(self) -> None:
        answer = router.arcbot_agent_skills("..")
        self.assertTrue(all("instructions" not in skill for skill in answer["skills"]))

    def test_a_server_without_skills_answers_an_empty_list(self) -> None:
        empty_root = Path(self.temp.name) / "empty"
        empty_root.mkdir()
        with patch.object(config, "get_root_path", return_value=str(empty_root)):
            self.assertEqual(agent_skill_service.read_agent_skills(), {"skills": []})
        self.assertEqual(list(empty_root.iterdir()), [])

    def test_without_the_gateway_the_route_refuses_instead_of_reading_the_share(self) -> None:
        with patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None):
            with self.assertRaises(HTTPException) as refused:
                router.arcbot_agent_skills()
        self.assertEqual(refused.exception.status_code, 503)
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
