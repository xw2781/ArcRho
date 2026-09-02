"""The app server's cancel route publishes the marker only for a live job."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, status

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
for root in (FRONTEND_ROOT, PYTHON_API_SRC, SERVER_COMPONENTS_SRC):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from arcrho_project_duplication_contract import (  # noqa: E402
    project_duplication_cancel_path,
    write_project_duplication_status_for_request_id,
)
from app_server.api.project_settings_router import router  # noqa: E402
from app_server.schemas.project_settings import (  # noqa: E402
    DuplicateProjectFolderCancelResponse,
    ProjectDuplicationJobStatusResponse,
)
from app_server.services import project_settings_service  # noqa: E402


class ProjectDuplicationCancelRouteTests(unittest.TestCase):
    REQUEST_ID = "psdup_cancel_0001"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.projects_dir = self.root / "projects"
        self.projects_dir.mkdir()
        self.patches = (
            patch.object(
                project_settings_service.config, "PROJECT_SETTINGS_DIR", str(self.projects_dir)
            ),
            patch.object(
                project_settings_service.config,
                "load_workspace_paths",
                return_value={
                    "workspace_root": str(self.root),
                    "paths": {"projects_dir": "projects", "requests_dir": "requests"},
                },
            ),
            patch.object(project_settings_service.getpass, "getuser", return_value="Test User"),
        )
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def _publish_status(self, value: str, stage: str = "reserving_classes") -> None:
        write_project_duplication_status_for_request_id(
            self.root,
            self.REQUEST_ID,
            value,
            progress={"stage": stage, "completed": 1, "total": 3, "label": "Copying"},
        )

    def _cancel(self) -> dict:
        return project_settings_service.cancel_duplicate_project_folder(
            "project_map", self.REQUEST_ID
        )

    def test_cancel_of_a_running_job_publishes_the_marker(self) -> None:
        self._publish_status("processing")

        outcome = self._cancel()

        self.assertEqual(
            outcome,
            {
                "ok": True,
                "job_id": self.REQUEST_ID,
                "status": "processing",
                "cancel_requested": True,
            },
        )
        marker = project_duplication_cancel_path(self.root, self.REQUEST_ID)
        payload = json.loads(marker.read_text(encoding="utf-8"))
        self.assertEqual(payload["request_id"], self.REQUEST_ID)
        self.assertEqual(payload["user_name"], "Test User")
        self.assertNotIn(str(self.root), json.dumps(payload))

        # A second press is idempotent: the marker is simply rewritten.
        self.assertTrue(self._cancel()["cancel_requested"])
        self.assertTrue(marker.is_file())

    def test_cancel_of_a_queued_job_is_accepted(self) -> None:
        self._publish_status("queued", stage="queued")
        self.assertTrue(self._cancel()["cancel_requested"])

    def test_cancel_after_a_terminal_status_reports_it_without_a_marker(self) -> None:
        for terminal in ("success", "error", "cancelled"):
            with self.subTest(terminal=terminal):
                self._publish_status(terminal)
                outcome = self._cancel()
                self.assertEqual(outcome["status"], terminal)
                self.assertFalse(outcome["cancel_requested"])
                self.assertFalse(
                    project_duplication_cancel_path(self.root, self.REQUEST_ID).exists()
                )

    def test_unknown_job_and_bad_ids_are_rejected(self) -> None:
        with self.assertRaises(HTTPException) as missing:
            self._cancel()
        self.assertEqual(missing.exception.status_code, 404)

        with self.assertRaises(HTTPException) as bad_id:
            project_settings_service.cancel_duplicate_project_folder("project_map", "../x")
        self.assertEqual(bad_id.exception.status_code, 400)

        with self.assertRaises(HTTPException) as bad_source:
            project_settings_service.cancel_duplicate_project_folder("nope", self.REQUEST_ID)
        self.assertEqual(bad_source.exception.status_code, 404)

    def test_router_declares_the_cancel_route_and_accepts_cancelled_status(self) -> None:
        route = next(
            item
            for item in router.routes
            if item.path
            == "/project_settings/{source}/duplicate_project_folder/cancel/{request_id}"
        )
        self.assertIn("POST", route.methods)
        self.assertEqual(route.status_code, status.HTTP_202_ACCEPTED)
        self.assertIs(route.response_model, DuplicateProjectFolderCancelResponse)

        payload = ProjectDuplicationJobStatusResponse(
            ok=True,
            job_id=self.REQUEST_ID,
            contract_version=1,
            status="cancelled",
            updated_at="2026-09-01T00:00:00+00:00",
            request_id=self.REQUEST_ID,
            progress={"stage": "cancelled", "completed": 1, "total": 3, "label": "x"},
        )
        self.assertEqual(payload.status, "cancelled")


if __name__ == "__main__":
    unittest.main()
