from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
TEST_TEMP_ROOT = FRONTEND_ROOT.parent / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import dataset_service, precedent_cache_service


class EngineDatasetDisplayShapeLoadTests(unittest.TestCase):
    """The window reopens a generated dataset at the display its sidecar saved.

    A generated dataset's file is the Engine's build at the display the dataset
    had when the file was written; saving a new display moves only the
    sidecar's display pair. The open asks for the display shape, and the file's
    own shape must not win over the saved one.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.cache_dir = Path(self.temp_dir.name) / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir()
        # The Engine's file at the yearly display the dataset was created at.
        self.csv_path = self.cache_dir / "Paid@12@12@cum@dev.csv"
        self.csv_path.write_text("10,20\n10,\n", encoding="utf-8")
        self.sidecar = {
            "dataset_name": "Paid",
            "dataset_type": "Paid",
            "data_format": "Triangle",
            "source_kind": "engine",
            "csv_file": self.csv_path.name,
            "origin_length": 12,
            "development_length": 12,
            # A generated dataset's stored pair is the source table's grain.
            "stored_origin_length": 1,
            "stored_development_length": 1,
            "cumulative": True,
            "calendar": False,
            "origin_labels": ["2023", "2024"],
        }
        self.patches = [
            patch.object(config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=self.sidecar),
            patch.object(dataset_service, "_resolve_development_labels", return_value=["12", "24"]),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        config.DATASETS.clear()
        self.temp_dir.cleanup()

    def _load(self, **kwargs: object) -> dict:
        return dataset_service.load_cached_dataset_values(
            "Example Project",
            "Example RC",
            "Paid",
            **kwargs,
        )

    def _materialize_quarterly(self, project, reserving_class, dataset_name, sidecar, origin, development) -> str:
        self.assertEqual((project, reserving_class, dataset_name), ("Example Project", "Example RC", "Paid"))
        self.assertIs(sidecar, self.sidecar)
        self.assertEqual((origin, development), (12, 3))
        path = self.cache_dir / "Paid@12@3@cum@dev.csv"
        path.write_text("1,2,3,4,5,6,7,8\n1,2,3,4,,,,\n", encoding="utf-8")
        return str(path)

    def test_a_saved_display_that_differs_from_the_file_is_produced_at_that_display(self) -> None:
        self.sidecar["development_length"] = 3

        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            side_effect=self._materialize_quarterly,
        ) as materialize:
            result = self._load(at_display_shape=True)

        materialize.assert_called_once()
        # The grid is the quarterly build and the lengths describe it, so the
        # window's controls land on the pair the save wrote.
        self.assertEqual((result["origin_length"], result["development_length"]), (12, 3))
        self.assertEqual(result["csv_file"], "Paid@12@3@cum@dev.csv")
        self.assertEqual(len(result["values"][0]), 8)
        # The stored pair still names the source table's grain.
        self.assertEqual(
            (result["stored_origin_length"], result["stored_development_length"]), (1, 1)
        )

    def test_a_file_already_at_the_saved_display_is_read_as_it_stands(self) -> None:
        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            side_effect=AssertionError("no rebuild is needed"),
        ):
            result = self._load(at_display_shape=True)

        self.assertEqual((result["origin_length"], result["development_length"]), (12, 12))
        self.assertEqual(result["values"], [[10.0, 20.0], [10.0, None]])
        self.assertEqual(result["path"], str(self.csv_path))

    def test_a_method_reading_its_input_keeps_the_file_whatever_the_display_says(self) -> None:
        self.sidecar["development_length"] = 3

        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            side_effect=AssertionError("a plain read never rebuilds"),
        ):
            result = self._load()

        self.assertEqual((result["origin_length"], result["development_length"]), (12, 12))
        self.assertEqual(result["path"], str(self.csv_path))

    def test_a_rebuild_the_engine_refuses_is_reported_not_papered_over(self) -> None:
        self.sidecar["development_length"] = 3

        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            side_effect=RuntimeError("source table is unavailable"),
        ):
            with self.assertRaises(dataset_service.HTTPException) as raised:
                self._load(at_display_shape=True)

        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("could not be generated", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
