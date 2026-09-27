"""The project audit log is read and appended on the server host.

A Client PC sends both through the Gateway and refuses when it cannot; a
server process writes locally. An append carries a client-owned entry id so a
repeated request lands once.
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

from arcrho_api import config as api_config  # noqa: E402
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.audit_log import AuditLogWriteRequest  # noqa: E402
from app_server.services import audit_service, workspace_mutation_client, workspace_read_client  # noqa: E402

audit_log_router = importlib.import_module("app_server.api.audit_log_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
CAPABILITIES = {
    "workspace_read_kinds": [audit_service.AUDIT_LOG_READ_KIND],
    "workspace_mutation_kinds": [audit_service.AUDIT_LOG_APPEND_KIND],
}


class AuditLogHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "Demo" / "audit_log.json"
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_audit_log_path", return_value=str(self.path)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(audit_service, "_resolve_audit_user_name", return_value="Alice"),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _stored(self) -> list[dict]:
        return json.loads(self.path.read_text(encoding="utf-8"))["audit_log"]

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: self.temp.name})

    def test_both_kinds_are_registered(self) -> None:
        read = WORKSPACE_READ_KINDS[audit_service.AUDIT_LOG_READ_KIND]
        append = WORKSPACE_MUTATION_KINDS[audit_service.AUDIT_LOG_APPEND_KIND]
        self.assertEqual((read.module, read.function, read.required, read.optional),
                         ("audit_service", "read_audit_log", ("project_name",), ("limit",)))
        self.assertEqual((append.module, append.function, append.required, append.optional),
                         ("audit_service", "append_project_audit_log",
                          ("project_name", "action", "entry_id"), ("user_name",)))

    def test_the_same_entry_id_is_written_once(self) -> None:
        first = audit_service.append_project_audit_log("Demo", "Saved Field Mapping", entry_id="e1")
        again = audit_service.append_project_audit_log("Demo", "Saved Field Mapping", entry_id="e1")

        self.assertEqual(len(self._stored()), 1)
        self.assertEqual(again["entry"], first["entry"])
        self.assertEqual(self._stored()[0]["entry_id"], "e1")

    def test_entries_without_an_id_still_read_and_keep_no_id(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"audit_log": [
            {"event_date": "2026-09-01 10:00:00", "action": "Update", "change_info": "Old", "user": "Bob"},
        ]}), encoding="utf-8")

        audit_service.append_project_audit_log("Demo", "New", entry_id="e2")
        audit_service.append_project_audit_log("Demo", "Newer")

        stored = self._stored()
        self.assertEqual([entry.get("entry_id") for entry in stored], [None, "e2", None])
        rows = audit_service.read_audit_log("Demo")["data"]["rows"]
        self.assertEqual([row[3] for row in rows], ["Newer", "New", "Old"])

    def test_a_server_process_appends_locally(self) -> None:
        with self._server_process(), patch.object(
            workspace_mutation_client, "run_workspace_mutation", side_effect=AssertionError("no Gateway hop")
        ):
            audit_service.safe_append_project_audit_log("Demo", "Saved Dataset Types (3 rows)")

        self.assertEqual([entry["change_info"] for entry in self._stored()], ["Saved Dataset Types (3 rows)"])

    def test_a_client_append_goes_through_the_gateway_with_an_entry_id(self) -> None:
        answer = ({"path": "x", "entry": {}, "count": 1}, "", 10)
        with patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=CAPABILITIES), \
                patch.object(workspace_read_client, "post_signed_json", return_value=answer) as post:
            out = audit_log_router.write_audit_log(
                AuditLogWriteRequest(project_name="Demo", action="Saved notes", user_name="alice")
            )

        self.assertTrue(out["ok"])
        request = post.call_args.args[2]
        self.assertEqual(request["MutationKind"], audit_service.AUDIT_LOG_APPEND_KIND)
        self.assertEqual(sorted(request["Kwargs"]), ["action", "entry_id", "project_name", "user_name"])
        self.assertTrue(request["Kwargs"]["entry_id"])
        self.assertFalse(self.path.exists())

    def test_a_client_read_goes_through_the_gateway(self) -> None:
        answer = ({"exists": True, "path": "x", "data": {"columns": [], "rows": []}}, "", 10)
        with patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=CAPABILITIES), \
                patch.object(workspace_read_client, "post_signed_json", return_value=answer) as post, \
                patch.object(audit_service, "read_audit_log", side_effect=AssertionError("no share read")):
            out = audit_log_router.get_audit_log("Demo", limit=20)

        self.assertTrue(out["ok"])
        self.assertEqual(post.call_args.args[2]["Kwargs"], {"project_name": "Demo", "limit": 20})

    def test_a_client_refuses_without_the_gateway(self) -> None:
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            with self.assertRaises(HTTPException) as read:
                audit_log_router.get_audit_log("Demo")
            with self.assertRaises(HTTPException) as write:
                audit_log_router.write_audit_log(AuditLogWriteRequest(project_name="Demo", action="Saved"))
            audit_service.safe_append_project_audit_log("Demo", "Saved")

        self.assertEqual((read.exception.status_code, write.exception.status_code), (503, 503))
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
