"""Dataset-type changes and project duplication run through the Gateway.

A Client PC saves the dataset-type table, submits both Engine jobs, polls
their status and cancels a duplication through the Gateway; it refuses a save
or submit when the Gateway cannot answer, and a status poll it cannot answer is
"unknown" rather than a failed job. A server process runs the same service
locally. Every write here lands in a temporary root.
"""

from __future__ import annotations

import importlib
import inspect
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
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src", REPOSITORY_ROOT / "server-components" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import config as api_config  # noqa: E402
from arcrho_dataset_types_change_contract import dataset_types_change_request_path  # noqa: E402
from arcrho_project_duplication_contract import (  # noqa: E402
    project_duplication_cancel_path,
    project_duplication_request_path,
)
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.dataset_types import DatasetTypesSaveRequest  # noqa: E402
from app_server.schemas.project_settings import DuplicateProjectFolderRequest  # noqa: E402
from app_server.services import (  # noqa: E402
    dataset_types_change_service,
    dataset_types_service,
    user_identity_service,
    workspace_read_client,
)

dataset_types_router = importlib.import_module("app_server.api.dataset_types_router")
project_settings_router = importlib.import_module("app_server.api.project_settings_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
SOURCE = "project_map"
PROJECT = "Demo Project"
COLUMNS = ["Name", "Data Format", "Category", "Calculated", "Formula"]
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
MUTATION_KINDS = ("dataset_types_save", "project_duplication_submit", "project_duplication_cancel")
READ_KINDS = ("dataset_types_change_status", "project_duplication_status")


class ProjectJobsHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        (self.projects / PROJECT / "data").mkdir(parents=True)
        engine = self.root / "runtime" / "instances" / "arcrho_engine"
        engine.mkdir(parents=True)
        (engine / "engine.json").write_text(
            json.dumps({"Server": "engine", "Last seen": "2026-09-27 12:00:00"}), encoding="utf-8"
        )
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.requests: list[dict] = []
        self.audit: list[str] = []
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(self.projects)),
            patch.object(
                config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": str(self.root),
                    "paths": {"projects_dir": "projects", "requests_dir": "requests"},
                },
            ),
            patch.object(
                config,
                "get_dataset_types_path",
                side_effect=lambda name: str(self.projects / name / "dataset_types.json"),
            ),
            # Source and Generated come from the field mapping, which the
            # transport under test has no need for.
            patch.object(dataset_types_service, "_load_dataset_source_map", return_value={}),
            patch.object(dataset_types_service, "_load_field_mapping_field_names", return_value=[]),
            patch.object(
                dataset_types_change_service,
                "safe_append_project_audit_log",
                side_effect=lambda **kwargs: self.audit.append(kwargs["action"]),
            ),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={
                    "workspace_read_kinds": list(READ_KINDS),
                    "workspace_mutation_kinds": list(MUTATION_KINDS),
                },
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the request as the Gateway does: the registered service, as the signed user."""

        request = json.loads(json.dumps(request_payload))
        self.requests.append(request)
        spec = (
            WORKSPACE_READ_KINDS[request["ReadKind"]]
            if "ReadKind" in request
            else WORKSPACE_MUTATION_KINDS[request["MutationKind"]]
        )
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)}):
            with user_identity_service.acting_identity(request["UserName"]):
                answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _kinds(self) -> list[str]:
        return [request.get("MutationKind") or request.get("ReadKind") for request in self.requests]

    def _files(self) -> dict[str, bytes]:
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def _seed_table(self, rows) -> None:
        dataset_types_service.apply_dataset_types_rows(PROJECT, rows)

    def _save(self, rows, request_id: str):
        return dataset_types_router.save_dataset_types(
            DatasetTypesSaveRequest(project_name=PROJECT, columns=COLUMNS, rows=rows, request_id=request_id)
        )

    def _gateway_down(self):
        return patch.object(config, "load_gateway_config", return_value={"enabled": False})

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kinds, table in ((MUTATION_KINDS, WORKSPACE_MUTATION_KINDS), (READ_KINDS, WORKSPACE_READ_KINDS)):
            for kind in kinds:
                with self.subTest(kind):
                    spec = table[kind]
                    module = importlib.import_module(f"app_server.services.{spec.module}")
                    signature = inspect.signature(getattr(module, spec.function))
                    signature.bind(**{name: "x" for name in spec.required})
                    signature.bind(**{name: "x" for name in spec.allowed})
                    # Both submits are keyed by their own request id, so no
                    # Gateway receipt is kept on top.
                    self.assertFalse(getattr(spec, "receipt", False))

    def test_a_presentation_only_save_runs_on_the_gateway_and_a_replay_writes_nothing(self) -> None:
        self._seed_table([["Paid", "Triangle", "A Loss", False, ""]])
        rows = [["Paid", "Triangle", "B Renamed", False, ""]]
        first = self._save(rows, "psdtc_direct-1")
        self.assertEqual(first["applied"], "direct")
        self.assertEqual(self._kinds(), ["dataset_types_save"])
        self.assertEqual(self.requests[0]["RequestId"], "psdtc_direct-1")
        self.assertEqual(self.requests[0]["UserName"], "alice")
        saved = json.loads((self.projects / PROJECT / "dataset_types.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["rows"][0][2], "B Renamed")
        self.assertEqual(len(self.audit), 1)

        before = self._files()
        replay = self._save(rows, "psdtc_direct-1")
        self.assertEqual(replay["applied"], "direct")
        self.assertEqual(self._files(), before)
        self.assertEqual(len(self.audit), 1)

    def test_a_replayed_job_submit_returns_the_job_already_queued(self) -> None:
        self._seed_table(
            [
                ["Paid", "Triangle", "A Loss", False, ""],
                ["Growth Adjustment - Counts", "Vector", "B Exposure", False, ""],
            ]
        )
        rows = [["Paid", "Triangle", "A Loss", False, ""]]
        first = self._save(rows, "psdtc_job-1")
        self.assertEqual(first["applied"], "job")
        self.assertEqual(first["job"]["job_id"], "psdtc_job-1")
        self.assertFalse(first["job"]["resumed"])
        self.assertTrue(dataset_types_change_request_path(self.root, "psdtc_job-1").is_file())

        replay = self._save(rows, "psdtc_job-1")
        self.assertEqual(replay["job"]["job_id"], "psdtc_job-1")
        self.assertTrue(replay["job"]["resumed"])
        requests = list((self.root / "requests" / "dataset_types_change" / "requests").iterdir())
        self.assertEqual(len(requests), 1)

        status = dataset_types_router.get_dataset_types_change_job_status(PROJECT, "psdtc_job-1")
        self.assertEqual(status["status"], "queued")
        self.assertEqual(
            self._kinds(), ["dataset_types_save", "dataset_types_save", "dataset_types_change_status"]
        )

    def test_a_duplication_is_submitted_polled_and_cancelled_on_the_gateway(self) -> None:
        (self.projects / "Source").mkdir()
        request = DuplicateProjectFolderRequest(old_name="Source", new_name="Copy", request_id="psdup_hosted-1")
        submitted = project_settings_router.duplicate_project_folder(SOURCE, request)
        self.assertEqual(submitted["job_id"], "psdup_hosted-1")
        self.assertEqual(self.requests[0]["RequestId"], "psdup_hosted-1")
        published = json.loads(project_duplication_request_path(self.root, "psdup_hosted-1").read_text(encoding="utf-8"))
        self.assertEqual(published["UserName"], "alice")

        before = self._files()
        replay = project_settings_router.duplicate_project_folder(SOURCE, request)
        self.assertEqual(replay["job_id"], "psdup_hosted-1")
        self.assertEqual(self._files(), before)

        status = project_settings_router.get_duplicate_project_folder_status(SOURCE, "psdup_hosted-1")
        self.assertEqual(status["status"], "queued")
        cancelled = project_settings_router.cancel_duplicate_project_folder(SOURCE, "psdup_hosted-1")
        self.assertTrue(cancelled["cancel_requested"])
        self.assertTrue(project_duplication_cancel_path(self.root, "psdup_hosted-1").is_file())
        self.assertEqual(
            self._kinds(),
            [
                "project_duplication_submit",
                "project_duplication_submit",
                "project_duplication_status",
                "project_duplication_cancel",
            ],
        )

    def test_a_status_poll_the_gateway_cannot_answer_is_unknown(self) -> None:
        with self._gateway_down():
            types_status = dataset_types_router.get_dataset_types_change_job_status(PROJECT, "psdtc_job-1")
            copy_status = project_settings_router.get_duplicate_project_folder_status(SOURCE, "psdup_hosted-1")
        self.assertTrue(types_status["unknown"])
        self.assertEqual(types_status["job_id"], "psdtc_job-1")
        self.assertEqual(copy_status, {"ok": True, "job_id": "psdup_hosted-1", "unknown": True})
        self.assertEqual(self.requests, [])

    def test_a_client_refuses_to_save_submit_or_cancel_without_the_gateway(self) -> None:
        (self.projects / "Source").mkdir()
        self._seed_table([["Paid", "Triangle", "A Loss", False, ""]])
        before = self._files()
        routes = (
            lambda: self._save([["Paid", "Triangle", "B Renamed", False, ""]], "psdtc_down-1"),
            lambda: project_settings_router.duplicate_project_folder(
                SOURCE, DuplicateProjectFolderRequest(old_name="Source", new_name="Copy", request_id="psdup_down-1")
            ),
            lambda: project_settings_router.cancel_duplicate_project_folder(SOURCE, "psdup_down-1"),
        )
        with self._gateway_down():
            for route in routes:
                with self.assertRaises(HTTPException) as refused:
                    route()
                self.assertEqual(refused.exception.status_code, 503)
        self.assertEqual(self.requests, [])
        self.assertEqual(self._files(), before)


if __name__ == "__main__":
    unittest.main()
