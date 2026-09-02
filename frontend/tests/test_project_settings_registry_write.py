"""Project registry publication retries a momentarily locked index.json."""
from __future__ import annotations

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
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
for root in (FRONTEND_ROOT, PYTHON_API_SRC, SERVER_COMPONENTS_SRC):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from app_server.services import project_settings_service  # noqa: E402


class ProjectRegistryWriteRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.projects_dir = Path(self.temp_dir.name) / "projects"
        self.projects_dir.mkdir()
        self.index_path = self.projects_dir / "index.json"
        self.index_path.write_text(
            json.dumps({"version": 1, "projects": [], "folders": []}),
            encoding="utf-8",
        )
        self.dir_patch = patch.object(
            project_settings_service.config, "PROJECT_SETTINGS_DIR", str(self.projects_dir)
        )
        self.dir_patch.start()
        self.sleeps: list[float] = []
        self.sleep_patch = patch.object(
            project_settings_service.time, "sleep", side_effect=self.sleeps.append
        )
        self.sleep_patch.start()

    def tearDown(self) -> None:
        self.sleep_patch.stop()
        self.dir_patch.stop()
        self.temp_dir.cleanup()

    def _flaky_replace(self, failures: int):
        real_replace = os.replace
        calls = {"count": 0}

        def replace(src, dst, *args, **kwargs):
            calls["count"] += 1
            if calls["count"] <= failures:
                raise PermissionError(13, "The process cannot access the file")
            return real_replace(src, dst, *args, **kwargs)

        return replace, calls

    def test_transient_sharing_refusal_is_retried_and_the_registry_is_written(self) -> None:
        replace, calls = self._flaky_replace(failures=2)
        with patch.object(project_settings_service.os, "replace", side_effect=replace):
            result = project_settings_service.update_project_settings(
                "project_map", [], ["Pricing\\Source Project (2)"], file_mtime=None
            )

        self.assertTrue(result["ok"])
        self.assertEqual(calls["count"], 3)
        self.assertEqual(self.sleeps, [0.2, 0.4])
        written = json.loads(self.index_path.read_text(encoding="utf-8-sig"))
        self.assertEqual([p["name"] for p in written["projects"]], ["Source Project (2)"])
        self.assertFalse((self.projects_dir / "index.json.tmp").exists())

    def test_persistent_lock_reports_423_and_leaves_the_registry_untouched(self) -> None:
        replace, calls = self._flaky_replace(failures=99)
        with patch.object(project_settings_service.os, "replace", side_effect=replace):
            with self.assertRaises(HTTPException) as raised:
                project_settings_service.update_project_settings(
                    "project_map", [], ["Pricing\\Source Project (2)"], file_mtime=None
                )

        self.assertEqual(raised.exception.status_code, 423)
        self.assertEqual(calls["count"], project_settings_service._PROJECT_INDEX_REPLACE_ATTEMPTS)
        self.assertEqual(len(self.sleeps), project_settings_service._PROJECT_INDEX_REPLACE_ATTEMPTS - 1)
        written = json.loads(self.index_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(written["projects"], [])
        self.assertFalse((self.projects_dir / "index.json.tmp").exists(), "abandoned temp file is removed")


if __name__ == "__main__":
    unittest.main()
