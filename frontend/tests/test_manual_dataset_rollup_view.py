"""A coarser view of a hand-entered dataset is built fresh, never read back."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import arcrho_runtime_service, dataset_service


class ManualDatasetRollupViewTests(unittest.TestCase):
    project_name = "Example Project"
    reserving_class = "Example Reserving Class"
    dataset_name = "Paid Losses"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        root = Path(self.temp_dir.name)
        self.cache_dir = root / "data" / self.reserving_class / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sidecar_dir = self.cache_dir.parent / config.DATASET_SIDECAR_DIR
        self.sidecar_dir.mkdir(parents=True, exist_ok=True)
        # Twenty-four monthly origins valued at the end of the second year, so
        # the yearly view is valued at 12 and 24 months of age.
        settings_path = root / "general_settings.json"
        settings_path.write_text(
            '{"origin_start_date":"202301","origin_end_date":"202412","development_end_date":"202412"}',
            encoding="utf-8",
        )
        self._settings_patch = patch.object(
            config, "get_general_settings_path", return_value=str(settings_path)
        )
        self._settings_patch.start()
        self.addCleanup(self._settings_patch.stop)

        self.stored_csv = self.cache_dir / f"{self.dataset_name}@1@1@cum@dev.csv"
        self.view_csv = self.cache_dir / f"{self.dataset_name}@12@12@cum@dev.csv"
        self.add_in_view_dir = self.cache_dir / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
        self.add_in_view_csv = self.add_in_view_dir / self.view_csv.name
        self._write_stored_rows(100.0)

        sidecar = {
            "dataset_name": self.dataset_name,
            "dataset_type": self.dataset_name,
            "reserving_class": self.reserving_class,
            "project_name": self.project_name,
            "source_kind": "input",
            "data_format": "Triangle",
            "csv_file": self.stored_csv.name,
            "cumulative": True,
            "calendar": False,
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 1,
            "stored_development_length": 1,
        }
        (self.sidecar_dir / f"{self.dataset_name}.json").write_text(
            json.dumps(sidecar, indent=2), encoding="utf-8"
        )

    def tearDown(self) -> None:
        config.DATASETS.clear()
        config.DATASET_ROLLUPS.clear()
        self.temp_dir.cleanup()

    def _write_stored_rows(self, scale: float) -> None:
        """A 24-month cumulative triangle whose every cell is scale x age."""
        lines = []
        for row in range(24):
            cells = [f"{scale * (col + 1):.1f}" for col in range(24 - row)]
            cells += [""] * row
            lines.append(",".join(cells))
        self.stored_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _pairs(self) -> list:
        return [
            ("Function", "ArcRhoTri"),
            ("Path", self.reserving_class),
            ("DatasetName", self.dataset_name),
            ("InstanceName", self.dataset_name),
            ("ProjectName", self.project_name),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def _resolve_view(self) -> dict:
        return arcrho_runtime_service.resolve_local_triangle_cache(
            str(self.view_csv),
            self._pairs(),
        )

    def _view_values(self, result: dict) -> list:
        ds_id = arcrho_runtime_service._register_arcrho_dataset(
            str(result["data_path"]), self._pairs()
        )
        rolled_up = dataset_service._rolled_up_dataset(ds_id)
        self.assertIsNotNone(rolled_up, "the coarser view is not served from memory")
        frame = rolled_up[0]
        return frame.values.tolist()

    def test_coarser_view_is_derived_without_writing_a_variant(self) -> None:
        result = self._resolve_view()

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "cache_derived")
        self.assertTrue(result["derived"]["in_memory"])
        self.assertFalse(
            self.view_csv.exists(),
            "a coarser copy of a hand-entered dataset was written beside it",
        )
        values = self._view_values(result)
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0][0], 7800.0)

    def test_edited_figures_reach_the_coarser_view(self) -> None:
        first = self._view_values(self._resolve_view())
        self._write_stored_rows(200.0)
        second = self._view_values(self._resolve_view())

        self.assertEqual(first[0][0], 7800.0)
        self.assertEqual(second[0][0], 15600.0)

    def test_a_leftover_coarser_copy_is_never_served(self) -> None:
        self.view_csv.write_text("1,2\n3,4\n", encoding="utf-8")

        result = self._resolve_view()

        self.assertEqual(result["status"], "cache_derived")
        self.assertTrue(result["derived"]["in_memory"])
        self.assertEqual(self.view_csv.read_text(encoding="utf-8"), "1,2\n3,4\n")
        self.assertEqual(self._view_values(result)[0][0], 7800.0)

    def _cache_dir_patches(self) -> ExitStack:
        stack = ExitStack()
        stack.enter_context(
            patch.object(
                config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)
            )
        )
        stack.enter_context(
            patch.object(
                config,
                "get_project_temporary_view_dataset_cache_dir",
                return_value=str(self.add_in_view_dir),
            )
        )
        return stack

    def _materialize_add_in_view(self, target: Path | None = None) -> dict:
        with self._cache_dir_patches():
            return arcrho_runtime_service.materialize_dataset_view(
                self._pairs(), str(target or self.add_in_view_csv)
            )

    def _add_in_view_rows(self) -> list:
        text = self.add_in_view_csv.read_text(encoding="utf-8").strip()
        return [[cell for cell in line.split(",")] for line in text.splitlines()]

    def test_the_add_in_view_is_written_into_the_view_cache(self) -> None:
        result = self._materialize_add_in_view()

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "cache_derived")
        self.assertFalse(result["derived"].get("in_memory"))
        self.assertTrue(self.add_in_view_csv.exists())
        self.assertFalse(
            self.view_csv.exists(),
            "a coarser copy of a hand-entered dataset was written beside it",
        )
        rows = self._add_in_view_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(float(rows[0][0]), 7800.0)

    def test_a_rebuilt_add_in_view_carries_the_edited_figures(self) -> None:
        self._materialize_add_in_view()
        first = float(self._add_in_view_rows()[0][0])
        self._write_stored_rows(200.0)
        self._materialize_add_in_view()
        second = float(self._add_in_view_rows()[0][0])

        self.assertEqual(first, 7800.0)
        self.assertEqual(second, 15600.0)

    def test_an_add_in_view_beside_the_stored_data_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._materialize_add_in_view(self.view_csv)

        self.assertEqual(raised.exception.status_code, 400)
        self.assertFalse(self.view_csv.exists())


if __name__ == "__main__":
    unittest.main()
