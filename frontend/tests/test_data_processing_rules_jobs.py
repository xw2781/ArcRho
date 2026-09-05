"""Data-processing-rules saves as Engine jobs: contract, submission, status."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from importlib import import_module
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, SERVER_COMPONENTS_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_data_processing_rules_job_contract import (
    DATA_PROCESSING_RULES_JOB_FUNCTION,
    DataProcessingRulesJobContractError,
    build_data_processing_rules_job_request,
    build_data_processing_rules_job_status,
    data_processing_rules_job_request_path,
    data_processing_rules_job_status_path,
    find_queued_data_processing_rules_job,
    validate_data_processing_rules_job_request,
    validate_data_processing_rules_job_status,
    write_data_processing_rules_job_status,
)
from arcrho_dependent_propagation_contract import ENGINE_UNAVAILABLE_MESSAGE
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS
# ``app_server.api`` re-exports the APIRouter object under the module's own
# name, so the module has to be imported explicitly to reach its handlers.
data_processing_rules_router = import_module("app_server.api.data_processing_rules_router")
from app_server.schemas.data_processing_rules import DataProcessingRulesSaveJobRequest
from app_server.services import (
    data_processing_rules_job_service,
    dependent_propagation_service,
)


PROJECT = "Demo Project"
RULE = {
    "id": "rule-1",
    "name": "Keep BI",
    "enabled": True,
    "target": {"source_measure": "Earned_Premium"},
    "request_conditions": {"all": []},
    "row_conditions": {"all": []},
    "action": {"type": "keep_members", "field": "IBNRCAT", "level": 5, "members": ["BI"]},
}


class DataProcessingRulesJobContractTests(unittest.TestCase):
    REQUEST_ID = "abcdef0123456789abcdef0123456789"

    def test_request_round_trips_and_rejects_unknown_fields(self) -> None:
        request = build_data_processing_rules_job_request(
            request_id=self.REQUEST_ID,
            project_name=PROJECT,
            expected_revision=0,
            rules=[RULE],
            user_name="Test User",
        )
        self.assertEqual(request["Function"], DATA_PROCESSING_RULES_JOB_FUNCTION)
        self.assertEqual(request["ExpectedRevision"], 0)
        self.assertEqual(request["Rules"], [RULE])
        self.assertEqual(validate_data_processing_rules_job_request(request), request)
        with self.assertRaises(DataProcessingRulesJobContractError):
            validate_data_processing_rules_job_request({**request, "Path": "E:\\x"})
        with self.assertRaises(DataProcessingRulesJobContractError):
            validate_data_processing_rules_job_request({**request, "ExpectedRevision": -1})
        with self.assertRaises(DataProcessingRulesJobContractError):
            validate_data_processing_rules_job_request({**request, "Rules": ["not an object"]})

    def test_status_carries_the_save_response_and_the_refusal_code(self) -> None:
        progress = {"stage": "checking", "completed": 3, "total": 9, "label": "Checking"}
        status = build_data_processing_rules_job_status(
            self.REQUEST_ID, "success", progress=progress, result={"ok": True, "data": {}}
        )
        validated = validate_data_processing_rules_job_status(
            status, expected_request_id=self.REQUEST_ID
        )
        self.assertEqual(validated["result"], {"ok": True, "data": {}})
        refused = build_data_processing_rules_job_status(
            self.REQUEST_ID, "error", progress=progress, message="stale", status_code=409
        )
        self.assertEqual(validate_data_processing_rules_job_status(refused)["status_code"], 409)
        with self.assertRaises(DataProcessingRulesJobContractError):
            build_data_processing_rules_job_status(
                self.REQUEST_ID, "success", progress=progress, result=["not", "an", "object"]
            )

    def test_registered_hosted_kinds_point_at_this_service(self) -> None:
        mutation = WORKSPACE_MUTATION_KINDS["data_processing_rules_save_submit"]
        self.assertEqual(mutation.module, "data_processing_rules_job_service")
        self.assertTrue(hasattr(data_processing_rules_job_service, mutation.function))
        # A save may carry revision 0 and no rules at all; the mutation contract
        # would read both as missing if they were required.
        self.assertIn("expected_revision", mutation.optional)
        self.assertIn("rules", mutation.optional)
        read = WORKSPACE_READ_KINDS["data_processing_rules_job_status"]
        self.assertEqual(read.module, "data_processing_rules_job_service")
        self.assertTrue(hasattr(data_processing_rules_job_service, read.function))


class DataProcessingRulesJobServiceTests(unittest.TestCase):
    REQUEST_ID = "abcdef0123456789abcdef0123456789"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        (self.root / "projects" / PROJECT).mkdir(parents=True)
        self.instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        self.workspace = {
            "workspace_root": str(self.root),
            "paths": {"projects_dir": "projects", "requests_dir": "requests"},
        }
        self.patches = [
            patch.object(
                dependent_propagation_service.config,
                "load_workspace_paths",
                return_value=self.workspace,
            ),
            patch.object(
                data_processing_rules_job_service.user_identity_service,
                "get_windows_login_name",
                return_value="Test User",
            ),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self._stop_patches)
        self.addCleanup(self.temp_dir.cleanup)

    def _stop_patches(self) -> None:
        for item in reversed(self.patches):
            item.stop()

    def _write_heartbeat(self) -> None:
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        (self.instances_dir / "engine.json").write_text(
            json.dumps({"Server": "engine", "Last seen": "2026-08-20 12:00:00"}),
            encoding="utf-8",
        )

    def _submit(self, request_id: str = "", revision: int = 0):
        return data_processing_rules_job_service.submit_data_processing_rules_job(
            PROJECT,
            request_id or self.REQUEST_ID,
            expected_revision=revision,
            rules=[RULE],
        )

    def test_no_live_engine_is_a_503_before_anything_is_published(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._submit()
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, ENGINE_UNAVAILABLE_MESSAGE)
        self.assertFalse(data_processing_rules_job_request_path(self.root, self.REQUEST_ID).exists())

    def test_submission_publishes_the_queued_status_then_the_request(self) -> None:
        self._write_heartbeat()
        submitted = self._submit(revision=4)
        self.assertEqual(submitted, {"ok": True, "job_id": self.REQUEST_ID, "status": "queued", "resumed": False})
        request = json.loads(
            data_processing_rules_job_request_path(self.root, self.REQUEST_ID).read_text(encoding="utf-8")
        )
        self.assertEqual(request["ExpectedRevision"], 4)
        self.assertEqual(request["Rules"], [RULE])
        self.assertEqual(request["UserName"], "Test User")
        status = json.loads(
            data_processing_rules_job_status_path(self.root, self.REQUEST_ID).read_text(encoding="utf-8")
        )
        self.assertEqual(status["status"], "queued")
        self.assertEqual(
            find_queued_data_processing_rules_job(self.root, PROJECT),
            {"reason": "queued", "job_id": self.REQUEST_ID},
        )

    def test_a_resubmitted_id_resumes_and_a_second_save_waits(self) -> None:
        self._write_heartbeat()
        self._submit()
        self.assertTrue(self._submit()["resumed"])
        with self.assertRaises(HTTPException) as raised:
            self._submit(request_id="0123456789abcdef0123456789abcdef")
        self.assertEqual(raised.exception.status_code, 423)
        self.assertEqual(raised.exception.detail, data_processing_rules_job_service.RULES_JOB_BUSY_MESSAGE)

    def test_status_reports_the_published_job_and_the_project_hold(self) -> None:
        self._write_heartbeat()
        self._submit()
        write_data_processing_rules_job_status(
            self.root,
            self.REQUEST_ID,
            "success",
            progress={"stage": "complete", "completed": 2, "total": 2, "label": "Saved"},
            result={"ok": True, "data": {"revision": 5}},
        )
        status = data_processing_rules_job_service.get_data_processing_rules_job_status(
            PROJECT, self.REQUEST_ID
        )
        self.assertTrue(status["found"])
        self.assertFalse(status["busy"])
        self.assertEqual(status["status"], "success")
        self.assertEqual(status["result"]["data"]["revision"], 5)
        with self.assertRaises(HTTPException) as raised:
            data_processing_rules_job_service.get_data_processing_rules_job_status(
                PROJECT, "0123456789abcdef0123456789abcdef"
            )
        self.assertEqual(raised.exception.status_code, 404)

    def test_the_route_submits_through_the_hosted_mutation(self) -> None:
        captured = {}

        def run_workspace_mutation(kind, kwargs, *, local):
            captured["kind"] = kind
            captured["kwargs"] = kwargs
            return {"ok": True, "job_id": self.REQUEST_ID, "status": "queued", "resumed": False}

        with patch.object(
            data_processing_rules_router.workspace_mutation_client,
            "run_workspace_mutation",
            side_effect=run_workspace_mutation,
        ):
            response = data_processing_rules_router.submit_data_processing_rules_save_job(
                DataProcessingRulesSaveJobRequest(
                    project_name=PROJECT,
                    request_id=self.REQUEST_ID,
                    expected_revision=2,
                    data={"rules": [RULE]},
                )
            )
        self.assertEqual(response["job_id"], self.REQUEST_ID)
        self.assertEqual(captured["kind"], "data_processing_rules_save_submit")
        self.assertEqual(captured["kwargs"]["expected_revision"], 2)
        self.assertEqual(captured["kwargs"]["rules"][0]["id"], "rule-1")


if __name__ == "__main__":
    unittest.main()
