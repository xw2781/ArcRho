from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import json


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import dataset_service

PYTHON_API_SRC = FRONTEND_ROOT.parent / "python-api" / "src"
if str(PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(PYTHON_API_SRC))

from arcrho_api.dataset_index_contract import migrate_legacy_notes_files


class DatasetCacheLoadCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.cache_dir = Path(self.temp_dir.name) / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir()
        self.csv_path = self.cache_dir / "Paid@12.csv"
        self.csv_path.write_text("1\n2\n", encoding="utf-8")
        self.sidecar = {
            "dataset_name": "Paid",
            "dataset_type": "Paid",
            "data_format": "Vector",
            "period_length": 12,
            "csv_file": self.csv_path.name,
            "source_kind": "engine",
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_sidecar_csv_is_checked_before_directory_enumeration(self) -> None:
        with (
            patch.object(
                config,
                "get_project_dataset_cache_dir",
                return_value=str(self.cache_dir),
            ),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=self.sidecar),
            patch.object(dataset_service.os, "listdir", side_effect=AssertionError("unexpected listdir")),
            patch.object(dataset_service, "_resolve_origin_labels", return_value=["2020", "2021"]) as resolve_labels,
        ):
            result = dataset_service.load_cached_dataset_values(
                "Example Project",
                "Example RC",
                "Paid",
                origin_length=12,
                development_length=12,
            )

        self.assertEqual(result["csv_file"], self.csv_path.name)
        self.assertEqual(result["values"], [[1], [2]])
        self.assertEqual(result["mask"], [[True], [True]])
        self.assertEqual(result["origin_labels"], ["2020", "2021"])
        resolve_labels.assert_called_once_with(
            result["id"],
            str(self.csv_path),
            "Example Project",
            12,
            2,
        )

    def test_valid_sidecar_origin_labels_keep_the_two_file_fast_path(self) -> None:
        sidecar = {**self.sidecar, "origin_labels": ["2020", "2021"]}
        with (
            patch.object(config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=sidecar),
            patch.object(dataset_service.os, "listdir", side_effect=AssertionError("unexpected listdir")),
            patch.object(dataset_service, "_resolve_origin_labels", side_effect=AssertionError("unexpected header lookup")),
        ):
            result = dataset_service.load_cached_dataset_values(
                "Example Project",
                "Example RC",
                "Paid",
                origin_length=12,
                development_length=12,
            )

        self.assertEqual(result["origin_labels"], ["2020", "2021"])
        self.assertEqual(result["values"], [[1], [2]])

    def test_mismatched_sidecar_origin_labels_use_authoritative_headers(self) -> None:
        sidecar = {**self.sidecar, "origin_labels": ["2020"]}
        with (
            patch.object(config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=sidecar),
            patch.object(dataset_service, "_resolve_origin_labels", return_value=["2020", "2021"]) as resolve_labels,
        ):
            result = dataset_service.load_cached_dataset_values(
                "Example Project",
                "Example RC",
                "Paid",
                origin_length=12,
                development_length=12,
            )

        self.assertEqual(result["origin_labels"], ["2020", "2021"])
        self.assertEqual(len(result["origin_labels"]), len(result["values"]))
        resolve_labels.assert_called_once()

    def test_notes_are_updated_in_the_dataset_sidecar_only(self) -> None:
        sidecar_path = Path(self.temp_dir.name) / "sidecars" / "Paid.json"
        sidecar_path.parent.mkdir()
        sidecar_path.write_text(json.dumps({**self.sidecar, "notes": "before"}), encoding="utf-8")

        with patch.object(dataset_service, "_get_dataset_sidecar_path", return_value=str(sidecar_path)):
            result = dataset_service.save_dataset_notes("Example Project", "Example RC", "Paid", "after")

        self.assertEqual(result["path"], str(sidecar_path))
        self.assertEqual(json.loads(sidecar_path.read_text(encoding="utf-8"))["notes"], "after")
        self.assertEqual(list(sidecar_path.parent.glob("ArcRhoTriNotes@*.json")), [])

    def test_legacy_notes_file_is_migrated_to_the_owning_sidecar(self) -> None:
        rc_dir = Path(self.temp_dir.name) / "reserving-class"
        sidecar_dir = rc_dir / "sidecars"
        sidecar_dir.mkdir(parents=True)
        sidecar_path = sidecar_dir / "Paid.json"
        legacy_path = sidecar_dir / "ArcRhoTriNotes@Paid.json"
        sidecar_path.write_text(json.dumps(self.sidecar), encoding="utf-8")
        legacy_path.write_text(json.dumps({"notes": "legacy note"}), encoding="utf-8")

        self.assertEqual(migrate_legacy_notes_files(rc_dir), 1)
        self.assertEqual(json.loads(sidecar_path.read_text(encoding="utf-8"))["notes"], "legacy note")
        self.assertFalse(legacy_path.exists())


if __name__ == "__main__":
    unittest.main()
