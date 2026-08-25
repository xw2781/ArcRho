from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, status


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))
if str(SERVER_COMPONENTS_SRC) not in sys.path:
    sys.path.insert(0, str(SERVER_COMPONENTS_SRC))

from app_server import config
from arcrho_project_duplication_contract import (
    PROJECT_DUPLICATION_CONTRACT_VERSION,
    PROJECT_DUPLICATION_FUNCTION,
    build_project_duplication_status,
    project_duplication_request_path,
    project_duplication_status_path,
    project_duplication_submission_receipt_path,
    write_json_atomic,
)
from app_server.api.project_settings_router import router
from app_server.schemas.project_settings import (
    DuplicateProjectFolderJobResponse,
    ProjectDuplicationJobStatusResponse,
)
from app_server.services import project_settings_service
from arcrho_engine.project_duplication import (
    process_durable_project_duplication_request,
)


class ProjectDuplicationJobTests(unittest.TestCase):
    REQUEST_ID = "0123456789abcdef0123456789abcdef"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.projects_dir = self.root / "projects"
        self.requests_dir = self.root / "requests"
        self.projects_dir.mkdir()
        self.source_dir = self.projects_dir / "Source Project"
        self.source_dir.mkdir()
        (self.source_dir / "marker.txt").write_text("source", encoding="utf-8")

        self.path_patches = (
            patch.object(
                project_settings_service.config,
                "PROJECT_SETTINGS_DIR",
                str(self.projects_dir),
            ),
            patch.object(
                project_settings_service.config,
                "REQUEST_DIR",
                str(self.requests_dir),
            ),
            patch.object(
                project_settings_service.config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": str(self.root),
                    "paths": {
                        "projects_dir": "projects",
                        "requests_dir": "requests",
                    },
                },
            ),
        )
        for path_patch in self.path_patches:
            path_patch.start()

    def tearDown(self) -> None:
        for path_patch in reversed(self.path_patches):
            path_patch.stop()
        self.temp_dir.cleanup()

    def _submit(
        self,
        *,
        request_id: str | None = REQUEST_ID,
        old_name: str = "Source Project",
        new_name: str = "Target Project",
    ) -> dict[str, object]:
        with patch.object(
            project_settings_service.getpass,
            "getuser",
            return_value="Test User",
        ):
            return project_settings_service.duplicate_project_folder(
                "project_map",
                old_name,
                new_name,
                request_id=request_id,
            )

    def test_app_server_filename_encoding_delegates_to_canonical_owner(self) -> None:
        with patch.object(
            config,
            "_canonical_encode_filename_segment",
            return_value="canonical-segment",
        ) as encoder:
            self.assertEqual(
                config.encode_filename_segment("Project/Name"),
                "canonical-segment",
            )
        encoder.assert_called_once_with("Project/Name")

    def test_missing_client_request_id_keeps_old_client_compatibility(self) -> None:
        generated = type("GeneratedId", (), {"hex": self.REQUEST_ID})()
        with patch.object(project_settings_service.uuid, "uuid4", return_value=generated):
            result = self._submit(request_id=None)
        self.assertEqual(result["job_id"], self.REQUEST_ID)

    def test_submit_publishes_queued_status_before_path_free_request(self) -> None:
        canonical_request_writer = project_settings_service.write_json_atomic

        def observe_request_write(path: Path, payload: object) -> Path:
            if Path(path) == project_duplication_request_path(self.root, self.REQUEST_ID):
                self.assertTrue(
                    project_duplication_submission_receipt_path(
                        self.root,
                        self.REQUEST_ID,
                    ).is_file()
                )
                self.assertTrue(
                    project_duplication_status_path(
                        self.root,
                        self.REQUEST_ID,
                    ).is_file()
                )
            return canonical_request_writer(path, payload)

        with patch.object(
            project_settings_service,
            "write_json_atomic",
            side_effect=observe_request_write,
        ):
            result = self._submit()

        self.assertEqual(
            result,
            {"ok": True, "job_id": self.REQUEST_ID, "status": "queued"},
        )
        self.assertFalse((self.projects_dir / "Target Project").exists())

        request_path = self.requests_dir / f"{self.REQUEST_ID}.json"
        request = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(
            request,
            {
                "Function": PROJECT_DUPLICATION_FUNCTION,
                "ContractVersion": PROJECT_DUPLICATION_CONTRACT_VERSION,
                "RequestId": self.REQUEST_ID,
                "SourceProjectName": "Source Project",
                "TargetProjectName": "Target Project",
                "ProjectsDirectory": "projects",
                "UserName": "Test User",
            },
        )
        self.assertNotIn(str(self.root), json.dumps(request))

        receipt = json.loads(
            project_duplication_submission_receipt_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            receipt,
            {
                "receipt_version": 1,
                "source_key": "project_map",
                "request": request,
            },
        )
        self.assertNotIn(str(self.root), json.dumps(receipt))

        queued = json.loads(
            project_duplication_status_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(queued["status"], "queued")
        self.assertEqual(
            queued["progress"],
            {
                "stage": "queued",
                "completed": 0,
                "total": 0,
                "label": "Queued for ArcRho Engine",
            },
        )

    def test_app_server_submission_runs_through_engine_and_status_reader(self) -> None:
        source_data = self.source_dir / "data"
        (source_data / "RC East" / "datasets").mkdir(parents=True)
        (source_data / "RC East" / "datasets" / "paid.csv").write_text(
            "origin,development,value\n2025,12,10\n",
            encoding="utf-8",
        )
        (source_data / "RC West" / "sidecars").mkdir(parents=True)
        (source_data / "RC West" / "sidecars" / "paid.json").write_text(
            '{"dataset":"paid"}\n',
            encoding="utf-8",
        )
        (source_data / "tmp").mkdir()
        (source_data / "tmp" / "incomplete.txt").write_text(
            "do not copy",
            encoding="utf-8",
        )

        submitted = self._submit()
        request_path = project_duplication_request_path(self.root, self.REQUEST_ID)
        published_request = json.loads(request_path.read_text(encoding="utf-8"))

        completed = process_durable_project_duplication_request(
            self.root,
            request_path,
            published_request,
        )
        status_result = (
            project_settings_service.get_duplicate_project_folder_status(
                "project_map",
                self.REQUEST_ID,
            )
        )

        self.assertEqual(
            submitted,
            {"ok": True, "job_id": self.REQUEST_ID, "status": "queued"},
        )
        self.assertTrue(completed)
        self.assertEqual(status_result["status"], "success")
        self.assertEqual(
            status_result["progress"],
            {
                "stage": "complete",
                "completed": 2,
                "total": 2,
                "label": "Project duplication complete",
            },
        )

        target = self.projects_dir / "Target Project"
        self.assertEqual(
            (target / "marker.txt").read_text(encoding="utf-8"),
            "source",
        )
        self.assertEqual(
            (target / "data" / "RC East" / "datasets" / "paid.csv").read_text(
                encoding="utf-8"
            ),
            "origin,development,value\n2025,12,10\n",
        )
        self.assertTrue(
            (target / "data" / "RC West" / "sidecars" / "paid.json").is_file()
        )
        self.assertFalse((target / "data" / "tmp").exists())
        self.assertFalse(request_path.exists())

        receipt = json.loads(
            project_duplication_submission_receipt_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        persisted_status = json.loads(
            project_duplication_status_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            set(receipt),
            {"receipt_version", "source_key", "request"},
        )
        self.assertEqual(
            set(receipt["request"]),
            {
                "Function",
                "ContractVersion",
                "RequestId",
                "SourceProjectName",
                "TargetProjectName",
                "ProjectsDirectory",
                "UserName",
            },
        )
        self.assertEqual(
            set(persisted_status),
            {"contract_version", "status", "updated_at", "request_id", "progress"},
        )
        self.assertEqual(
            set(status_result),
            {
                "ok",
                "job_id",
                "contract_version",
                "status",
                "updated_at",
                "request_id",
                "progress",
            },
        )
        escaped_root = str(self.root).replace("\\", "\\\\")
        self.assertNotIn(escaped_root, json.dumps(receipt))
        self.assertNotIn(escaped_root, json.dumps(persisted_status))
        self.assertNotIn(escaped_root, json.dumps(status_result))

    def test_custom_projects_layout_uses_the_fixed_engine_protocol_queue(self) -> None:
        custom_projects = self.root / "project-store" / "active"
        custom_source = custom_projects / "Source Project"
        custom_source.mkdir(parents=True)
        (custom_source / "marker.txt").write_text("custom", encoding="utf-8")
        custom_requests = self.root / "custom-requests"

        with (
            patch.object(
                project_settings_service.config,
                "PROJECT_SETTINGS_DIR",
                str(custom_projects),
            ),
            patch.object(
                project_settings_service.config,
                "REQUEST_DIR",
                str(custom_requests),
            ),
            patch.object(
                project_settings_service.config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": str(self.root),
                    "paths": {
                        "projects_dir": "project-store/active",
                        "requests_dir": "custom-requests",
                    },
                },
            ),
        ):
            submitted = self._submit()
            request_path = project_duplication_request_path(
                self.root,
                self.REQUEST_ID,
            )
            request = json.loads(request_path.read_text(encoding="utf-8"))
            completed = process_durable_project_duplication_request(
                self.root,
                request_path,
                request,
            )
            status_result = (
                project_settings_service.get_duplicate_project_folder_status(
                    "project_map",
                    self.REQUEST_ID,
                )
            )

        self.assertEqual(submitted["status"], "queued")
        self.assertEqual(request["ProjectsDirectory"], "project-store/active")
        self.assertTrue(completed)
        self.assertEqual(status_result["status"], "success")
        self.assertEqual(
            (custom_projects / "Target Project" / "marker.txt").read_text(
                encoding="utf-8"
            ),
            "custom",
        )
        self.assertFalse(custom_requests.exists())

    def test_submit_rejects_invalid_or_conflicting_projects(self) -> None:
        cases = (
            ("missing", "Source Project", "Target Project", 404),
            ("project_map", "..", "Target Project", 400),
            ("project_map", "Source Project", "source project", 400),
            ("project_map", "Missing Project", "Target Project", 404),
        )
        for source, old_name, new_name, expected_status in cases:
            with self.subTest(
                source=source,
                old_name=old_name,
                new_name=new_name,
            ):
                with self.assertRaises(HTTPException) as raised:
                    project_settings_service.duplicate_project_folder(
                        source,
                        old_name,
                        new_name,
                    )
                self.assertEqual(raised.exception.status_code, expected_status)

        (self.projects_dir / "Target Project").mkdir()
        with self.assertRaises(HTTPException) as raised:
            self._submit()
        self.assertEqual(raised.exception.status_code, 409)

    def test_submit_rejects_a_relative_workspace_root(self) -> None:
        with (
            patch.object(
                project_settings_service.config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": "relative-server-root",
                    "paths": {
                        "projects_dir": "projects",
                        "requests_dir": "requests",
                    },
                },
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            self._submit()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("must be absolute", str(raised.exception.detail))

    def test_submit_rejects_a_linked_protocol_ancestor(self) -> None:
        requests_path = self.root / "requests"

        def mark_requests_as_linked(path: Path) -> bool:
            return Path(path) == requests_path

        with (
            patch.object(
                project_settings_service,
                "path_is_link_or_reparse",
                side_effect=mark_requests_as_linked,
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            self._submit()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("protocol path is unsafe", str(raised.exception.detail))
        self.assertFalse(
            project_duplication_request_path(self.root, self.REQUEST_ID).exists()
        )

    def test_failed_request_publication_removes_orphaned_queued_status(self) -> None:
        with patch.object(
            project_settings_service,
            "write_json_atomic",
            side_effect=PermissionError("blocked"),
        ):
            with self.assertRaises(HTTPException) as raised:
                self._submit()

        self.assertEqual(raised.exception.status_code, 423)
        self.assertFalse(
            project_duplication_status_path(
                self.root,
                self.REQUEST_ID,
            ).exists()
        )
        self.assertFalse((self.requests_dir / f"{self.REQUEST_ID}.json").exists())
        self.assertFalse(
            project_duplication_submission_receipt_path(
                self.root,
                self.REQUEST_ID,
            ).exists()
        )

    def test_identical_replay_returns_current_state_without_rewriting_engine_files(self) -> None:
        self._submit()
        request_path = project_duplication_request_path(self.root, self.REQUEST_ID)
        receipt = json.loads(
            project_duplication_submission_receipt_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        request_path.unlink()
        (self.projects_dir / "Target Project").mkdir()

        for engine_status in ("processing", "success", "error"):
            status_payload = build_project_duplication_status(
                receipt["request"],
                engine_status,
                progress={
                    "stage": engine_status,
                    "completed": 1,
                    "total": 1,
                    "label": engine_status.title(),
                },
            )
            status_path = project_duplication_status_path(self.root, self.REQUEST_ID)
            write_json_atomic(status_path, status_payload)
            before = status_path.read_bytes()
            before_mtime = status_path.stat().st_mtime_ns

            with (
                patch.object(project_settings_service, "write_json_atomic") as request_writer,
                patch.object(project_settings_service, "write_project_duplication_status") as status_writer,
            ):
                result = self._submit()

            self.assertEqual(
                result,
                {"ok": True, "job_id": self.REQUEST_ID, "status": engine_status},
            )
            request_writer.assert_not_called()
            status_writer.assert_not_called()
            self.assertEqual(status_path.read_bytes(), before)
            self.assertEqual(status_path.stat().st_mtime_ns, before_mtime)

    def test_projects_directory_case_alias_replays_the_same_receipt(self) -> None:
        self._submit()
        receipt_path = project_duplication_submission_receipt_path(
            self.root,
            self.REQUEST_ID,
        )
        before = receipt_path.read_bytes()

        with patch.object(
            project_settings_service.config,
            "load_workspace_paths",
            return_value={
                "workspace_root": str(self.root),
                "paths": {
                    "projects_dir": "PROJECTS",
                    "requests_dir": "requests",
                },
            },
        ):
            result = self._submit()

        self.assertEqual(result["status"], "queued")
        self.assertEqual(receipt_path.read_bytes(), before)

    def test_matching_receipt_repairs_only_missing_queued_publication(self) -> None:
        self._submit()
        request_path = project_duplication_request_path(self.root, self.REQUEST_ID)
        status_path = project_duplication_status_path(self.root, self.REQUEST_ID)

        request_path.unlink()
        queued_before = status_path.read_bytes()
        queued_mtime = status_path.stat().st_mtime_ns
        self.assertEqual(self._submit()["status"], "queued")
        self.assertTrue(request_path.is_file())
        self.assertEqual(status_path.read_bytes(), queued_before)
        self.assertEqual(status_path.stat().st_mtime_ns, queued_mtime)

        request_path.unlink()
        status_path.unlink()
        self.assertEqual(self._submit()["status"], "queued")
        self.assertTrue(request_path.is_file())
        self.assertTrue(status_path.is_file())

        status_path.unlink()
        request_before = request_path.read_bytes()
        self.assertEqual(self._submit()["status"], "queued")
        self.assertEqual(request_path.read_bytes(), request_before)
        self.assertFalse(status_path.exists())

    def test_same_request_id_with_different_logical_request_is_rejected(self) -> None:
        self._submit()
        receipt_path = project_duplication_submission_receipt_path(
            self.root,
            self.REQUEST_ID,
        )
        before = receipt_path.read_bytes()

        for old_name, new_name in (
            ("Source Project", "Different Target"),
            ("Different Source", "Target Project"),
        ):
            with self.subTest(old_name=old_name, new_name=new_name):
                with self.assertRaises(HTTPException) as raised:
                    self._submit(old_name=old_name, new_name=new_name)
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(receipt_path.read_bytes(), before)

        with (
            patch.dict(
                project_settings_service.config.PROJECT_SETTINGS_SOURCES,
                {"other_map": "other.json"},
                clear=False,
            ),
            patch.object(project_settings_service.getpass, "getuser", return_value="Test User"),
            self.assertRaises(HTTPException) as raised,
        ):
            project_settings_service.duplicate_project_folder(
                "other_map",
                "Source Project",
                "Target Project",
                request_id=self.REQUEST_ID,
            )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(receipt_path.read_bytes(), before)

    def test_concurrent_different_payloads_bind_request_id_once(self) -> None:
        barrier = threading.Barrier(2)

        def submit(target_name: str) -> tuple[int, str]:
            barrier.wait()
            try:
                result = project_settings_service.duplicate_project_folder(
                    "project_map",
                    "Source Project",
                    target_name,
                    request_id=self.REQUEST_ID,
                )
                return 202, str(result["status"])
            except HTTPException as error:
                return error.status_code, str(error.detail)

        with (
            patch.object(project_settings_service.getpass, "getuser", return_value="Test User"),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            results = list(executor.map(submit, ("Target One", "Target Two")))

        self.assertEqual(sorted(status for status, _detail in results), [202, 409])
        receipt = json.loads(
            project_duplication_submission_receipt_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        self.assertIn(
            receipt["request"]["TargetProjectName"],
            {"Target One", "Target Two"},
        )
        request = json.loads(
            project_duplication_request_path(
                self.root,
                self.REQUEST_ID,
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(request, receipt["request"])

    def test_corrupt_existing_status_is_not_overwritten_on_replay(self) -> None:
        self._submit()
        request_path = project_duplication_request_path(self.root, self.REQUEST_ID)
        status_path = project_duplication_status_path(self.root, self.REQUEST_ID)
        request_path.unlink()
        status_path.write_text("{", encoding="utf-8")

        with self.assertRaises(HTTPException) as raised:
            self._submit()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(status_path.read_text(encoding="utf-8"), "{")
        self.assertFalse(request_path.exists())

    def test_status_read_returns_only_validated_location_independent_payload(self) -> None:
        self._submit()

        result = project_settings_service.get_duplicate_project_folder_status(
            "project_map",
            self.REQUEST_ID,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["job_id"], self.REQUEST_ID)
        self.assertEqual(result["request_id"], self.REQUEST_ID)
        self.assertEqual(result["status"], "queued")
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(
            set(result),
            {
                "ok",
                "job_id",
                "contract_version",
                "status",
                "updated_at",
                "request_id",
                "progress",
            },
        )

    def test_status_read_maps_missing_invalid_and_mismatched_statuses(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            project_settings_service.get_duplicate_project_folder_status(
                "project_map",
                "not valid!",
            )
        self.assertEqual(raised.exception.status_code, 400)

        with self.assertRaises(HTTPException) as raised:
            project_settings_service.get_duplicate_project_folder_status(
                "project_map",
                self.REQUEST_ID,
            )
        self.assertEqual(raised.exception.status_code, 404)

        status_path = project_duplication_status_path(self.root, self.REQUEST_ID)
        status_path.parent.mkdir(parents=True)
        status_path.write_text("{", encoding="utf-8")
        with self.assertRaises(HTTPException) as raised:
            project_settings_service.get_duplicate_project_folder_status(
                "project_map",
                self.REQUEST_ID,
            )
        self.assertEqual(raised.exception.status_code, 502)

        status_path.write_text(
            json.dumps(
                {
                    "contract_version": PROJECT_DUPLICATION_CONTRACT_VERSION,
                    "status": "queued",
                    "updated_at": "2026-08-01T12:00:00+00:00",
                    "request_id": "different-job-id",
                    "progress": {
                        "stage": "queued",
                        "completed": 0,
                        "total": 0,
                        "label": "Queued for ArcRho Engine",
                    },
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaises(HTTPException) as raised:
            project_settings_service.get_duplicate_project_folder_status(
                "project_map",
                self.REQUEST_ID,
            )
        self.assertEqual(raised.exception.status_code, 502)

    def test_router_declares_async_and_typed_job_contracts(self) -> None:
        submit_route = next(
            route
            for route in router.routes
            if route.path == "/project_settings/{source}/duplicate_project_folder"
            and "POST" in route.methods
        )
        status_route = next(
            route
            for route in router.routes
            if route.path
            == "/project_settings/{source}/duplicate_project_folder/status/{request_id}"
        )

        self.assertEqual(submit_route.status_code, status.HTTP_202_ACCEPTED)
        self.assertIs(submit_route.response_model, DuplicateProjectFolderJobResponse)
        self.assertIs(
            status_route.response_model,
            ProjectDuplicationJobStatusResponse,
        )


if __name__ == "__main__":
    unittest.main()
