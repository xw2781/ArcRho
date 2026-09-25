"""The reserving classes the tree's "Hide paths with no data" filter keeps."""

from __future__ import annotations

import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPO_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.helpers import _normalize_reserving_filter_preferences  # noqa: E402
from app_server.services import reserving_class_service  # noqa: E402

TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class ReservingClassesWithDataTests(unittest.TestCase):
    project_name = "Data Paths Project"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        projects_dir = Path(self.temp_dir.name) / "projects"
        self.data_dir = projects_dir / self.project_name / config.PROJECT_DATA_DIR
        self.data_dir.mkdir(parents=True)
        self.project_root_patch = patch.object(config, "PROJECT_SETTINGS_DIR", str(projects_dir))
        self.project_root_patch.start()

    def tearDown(self) -> None:
        self.project_root_patch.stop()
        self.temp_dir.cleanup()

    def _class_folder(self, reserving_class: str, with_index: bool) -> None:
        folder = self.data_dir / config.sanitize_reserving_class_folder(reserving_class)
        folder.mkdir()
        if with_index:
            (folder / "index.json").write_text("{}", encoding="utf-8")

    def test_lists_only_classes_whose_folder_holds_an_index(self) -> None:
        self._class_folder("ALN_ATHO\\NJ\\BI", with_index=True)
        self._class_folder("ALN_ATHO\\NJ\\PD", with_index=False)
        self._class_folder("Auto\\NY\\BI", with_index=True)
        (self.data_dir / "ArcRhoHeaders@0@False@False@12@-1.csv").write_text("", encoding="utf-8")

        out = reserving_class_service.list_reserving_classes_with_data(self.project_name)

        self.assertEqual(out["reserving_classes"], ["ALN_ATHO\\NJ\\BI", "Auto\\NY\\BI"])

    def test_missing_project_raises(self) -> None:
        with self.assertRaises(ValueError):
            reserving_class_service.list_reserving_classes_with_data("No Such Project")

    def test_read_kind_matches_the_service_signature(self) -> None:
        spec = WORKSPACE_READ_KINDS["reserving_classes_with_data"]
        self.assertEqual((spec.module, spec.function), ("reserving_class_service", "list_reserving_classes_with_data"))
        params = inspect.signature(reserving_class_service.list_reserving_classes_with_data).parameters
        self.assertEqual(tuple(params), spec.required)

    def test_preference_round_trips_and_defaults_off(self) -> None:
        self.assertFalse(_normalize_reserving_filter_preferences({})["hide_paths_without_data"])
        self.assertTrue(
            _normalize_reserving_filter_preferences({"hide_paths_without_data": True})["hide_paths_without_data"]
        )


if __name__ == "__main__":
    unittest.main()
