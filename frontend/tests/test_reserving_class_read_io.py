"""Round-trip discipline for the reserving-class reads on the Project Instance path load.

Project JSON may live on a mapped or UNC network drive where a file read costs a
full round trip regardless of payload size, so these tests pin the number of
reads each request makes rather than only its result. They also pin the
behaviour that deduplication must not change: an unchanged types file is still
not rewritten, a changed one still is, and a malformed one still raises.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import project_user_preferences_service, reserving_class_service


class _OpenCounter:
    """Counts reads of one file name across a block of service calls."""

    def __init__(self, file_name: str) -> None:
        self.file_name = file_name.casefold()
        self.count = 0
        self._real_open = builtins.open

    def _wrapped(self, file, *args, **kwargs):
        try:
            name = os.path.basename(os.fspath(file)).casefold()
        except TypeError:
            name = ""
        if name == self.file_name:
            self.count += 1
        return self._real_open(file, *args, **kwargs)

    def __enter__(self) -> "_OpenCounter":
        self._patch = patch.object(builtins, "open", self._wrapped)
        self._patch.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._patch.stop()


class ReservingClassReadIoTests(unittest.TestCase):
    project_name = "Read IO Project"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.projects_dir = self.root / "projects"
        self.project_dir = self.projects_dir / self.project_name
        self.project_dir.mkdir(parents=True)

        self._write_json(
            "reserving_class_values.json",
            {"fields": [{"field_name": "IBNRCAT", "level": 5, "distinct_values": ["BI", "PD"]}]},
        )
        self._write_json(
            "reserving_class_types.json",
            {
                "columns": ["Name", "Level", "Formula", "Source"],
                "rows": [["BI", "5", "", '"BI"'], ["PD", "5", "", '"PD"']],
            },
        )

        self.project_root_patch = patch.object(
            config, "PROJECT_SETTINGS_DIR", str(self.projects_dir)
        )
        self.project_root_patch.start()
        # Converge the types JSON and its xlsx companion so later assertions
        # measure the steady state the Project Instance page load hits.
        reserving_class_service.refresh_reserving_class_types_json(self.project_name)

    def tearDown(self) -> None:
        self.project_root_patch.stop()
        self.temp_dir.cleanup()

    def _write_json(self, name: str, payload: dict) -> None:
        (self.project_dir / name).write_text(json.dumps(payload), encoding="utf-8")

    def _types_path(self) -> Path:
        return self.project_dir / "reserving_class_types.json"

    def test_types_refresh_reads_the_types_file_once(self) -> None:
        with _OpenCounter("reserving_class_types.json") as counter:
            out = reserving_class_service.refresh_reserving_class_types_json(self.project_name)
        self.assertEqual(
            counter.count,
            1,
            "The types JSON must be read once per refresh; it serves both the merge"
            " base and the unchanged-file comparison.",
        )
        self.assertEqual([row[0] for row in out["data"]["rows"]], ["BI", "PD"])

    def test_types_refresh_reads_the_values_file_once(self) -> None:
        with _OpenCounter("reserving_class_values.json") as counter:
            reserving_class_service.refresh_reserving_class_types_json(self.project_name)
        self.assertEqual(counter.count, 1)

    def test_unchanged_types_file_is_not_rewritten(self) -> None:
        before = self._types_path().stat().st_mtime_ns
        payload_before = self._types_path().read_text(encoding="utf-8")
        reserving_class_service.refresh_reserving_class_types_json(self.project_name)
        self.assertEqual(self._types_path().stat().st_mtime_ns, before)
        self.assertEqual(self._types_path().read_text(encoding="utf-8"), payload_before)

    def test_changed_types_file_is_written(self) -> None:
        out = reserving_class_service.refresh_reserving_class_types_json(
            self.project_name,
            rows_override=[["BI", "5", ""], ["PD", "5", ""], ["TOTAL", "5", "BI + PD"]],
        )
        self.assertIn("TOTAL", [row[0] for row in out["data"]["rows"]])
        on_disk = json.loads(self._types_path().read_text(encoding="utf-8"))
        self.assertIn("TOTAL", [row[0] for row in on_disk["rows"]])

    def test_missing_types_file_still_refreshes_from_source_values(self) -> None:
        self._types_path().unlink()
        out = reserving_class_service.refresh_reserving_class_types_json(self.project_name)
        self.assertEqual([row[0] for row in out["data"]["rows"]], ["BI", "PD"])
        self.assertTrue(self._types_path().exists())

    def test_malformed_types_file_still_raises(self) -> None:
        self._types_path().write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            reserving_class_service.refresh_reserving_class_types_json(self.project_name)

    def test_filter_spec_reads_the_preference_file_once(self) -> None:
        project_user_preferences_service.update_preferences(
            self.project_name,
            {
                "reservingClassTree": {
                    "filterSpec": {"5": ["BI"]},
                    "preferences": {"favoritePaths": ["BI"]},
                }
            },
        )
        with _OpenCounter("preferences.json") as counter:
            out = reserving_class_service.get_filter_spec_for_project(self.project_name)
        self.assertEqual(
            counter.count,
            1,
            "The filter spec and the tree preferences live in one file and must"
            " come from a single read.",
        )
        # The filter spec normalizer casefolds its match keys, and the
        # preferences normalizer emits snake_case regardless of the stored form.
        self.assertEqual(out["filter_spec"], {"5": ["bi"]})
        self.assertEqual(out["preferences"].get("favorite_paths"), ["BI"])

    def test_filter_spec_defaults_when_no_preference_file_exists(self) -> None:
        out = reserving_class_service.get_filter_spec_for_project(self.project_name)
        self.assertEqual(out["filter_spec"], {})
        self.assertEqual(out["preferences"].get("favorite_paths", []), [])


if __name__ == "__main__":
    unittest.main()
