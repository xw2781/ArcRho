from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
TEST_TEMP_ROOT = FRONTEND_ROOT.parent / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from fastapi import HTTPException

from app_server import config
from app_server.services import (
    audit_service,
    dependent_propagation_service,
    file_read_cache,
    project_lock_service,
    propagation_gateway_client,
    workspace_mutation_client,
    workspace_read_client,
)
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS


class ProjectLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp.cleanup)
        self.projects_dir = Path(self.temp.name) / "projects"
        self.project = "Demo Project"
        (self.projects_dir / self.project).mkdir(parents=True)
        for patcher in (
            patch.object(config, "PROJECT_SETTINGS_DIR", str(self.projects_dir)),
            patch.object(audit_service, "safe_append_project_audit_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        file_read_cache.clear_file_read_cache()
        self.addCleanup(file_read_cache.clear_file_read_cache)

    def _lock(self, locked: bool) -> dict:
        return project_lock_service.set_project_lock(self.project, locked)

    def test_a_project_is_unlocked_until_someone_locks_it(self) -> None:
        state = project_lock_service.get_project_lock(self.project)
        self.assertFalse(state["locked"])
        project_lock_service.require_project_unlocked(self.project)

        locked = self._lock(True)
        self.assertTrue(locked["locked"])
        self.assertTrue(locked["locked_at"])
        stored = json.loads((self.projects_dir / self.project / "project_lock.json").read_text("utf-8"))
        self.assertIs(stored["locked"], True)
        with self.assertRaises(HTTPException) as raised:
            project_lock_service.require_project_unlocked(self.project.upper())
        self.assertEqual(raised.exception.status_code, 423)
        self.assertEqual(raised.exception.detail, project_lock_service.PROJECT_LOCKED_MESSAGE)

        unlocked = self._lock(False)
        self.assertEqual(
            {key: unlocked[key] for key in ("locked", "locked_by", "locked_at")},
            {"locked": False, "locked_by": "", "locked_at": ""},
        )
        project_lock_service.require_project_unlocked(self.project)

    def test_the_lock_covers_project_data_but_not_preferences_or_itself(self) -> None:
        self._lock(True)
        for kind, kwargs in (
            ("field_mapping_save", {"project_name": self.project}),
            ("source_table_refresh_submit", {"project_name": self.project}),
            ("project_folder_rename", {"old_name": self.project, "new_name": "X"}),
            ("project_folder_delete", {"name": self.project}),
        ):
            with self.subTest(kind=kind), self.assertRaises(HTTPException) as raised:
                project_lock_service.require_mutation_allowed(kind, kwargs)
            self.assertEqual(raised.exception.status_code, 423)
        for kind in ("project_user_preferences_update", "reserving_class_hidden_paths_save", "project_lock_set"):
            with self.subTest(kind=kind):
                project_lock_service.require_mutation_allowed(kind, {"project_name": self.project})

    def test_every_locked_kind_names_one_of_its_own_arguments(self) -> None:
        for kind, spec in WORKSPACE_MUTATION_KINDS.items():
            if spec.locked_project_arg:
                with self.subTest(kind=kind):
                    self.assertIn(spec.locked_project_arg, spec.allowed)

    def test_a_server_local_mutation_is_refused_before_it_runs(self) -> None:
        self._lock(True)
        local = Mock(return_value={"ok": True})
        with patch.object(workspace_read_client, "require_client_gateway", return_value=None):
            with self.assertRaises(HTTPException) as raised:
                workspace_mutation_client.run_workspace_mutation(
                    "field_mapping_save", {"project_name": self.project}, local=local
                )
        self.assertEqual(raised.exception.status_code, 423)
        local.assert_not_called()

    def test_a_method_or_dataset_save_is_refused_on_a_locked_project(self) -> None:
        self._lock(True)
        with patch.object(propagation_gateway_client, "is_server_process", return_value=True), \
                patch.object(dependent_propagation_service, "_workspace_server_root",
                             return_value=Path(self.temp.name)), \
                patch.object(dependent_propagation_service, "require_live_engine"):
            for check in (
                lambda: dependent_propagation_service.require_reserving_class_writable(self.project, "A\\B"),
                lambda: dependent_propagation_service.require_project_scope_writable(self.project),
            ):
                with self.assertRaises(HTTPException) as raised:
                    check()
                self.assertEqual(raised.exception.status_code, 423)
                self.assertEqual(raised.exception.detail, project_lock_service.PROJECT_LOCKED_MESSAGE)


if __name__ == "__main__":
    unittest.main()
