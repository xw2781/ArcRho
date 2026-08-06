"""Dependency discovery must read a reserving-class folder once, not per file.

Reserving-class data can live on a mapped or UNC network drive, so a per-file
awaited loop over every cached CSV's sidecar pays one round trip each. These
tests pin the batched shape: one folder enumeration, one read per distinct
sidecar, bounded concurrency, and a deterministic candidate order.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import calculated_dataset_service


PROJECT = "Example Project"
RESERVING_CLASS = "Example RC"
TARGET_SETTINGS = {
    "origin_length": 12,
    "development_length": 12,
    "cumulative": True,
    "calendar": False,
}


class CalculatedDependencyFolderScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.cache_dir = self.root / config.DATASET_CACHE_DIR
        self.sidecar_dir = self.root / config.DATASET_SIDECAR_DIR
        self.method_dir = self.root / config.METHOD_DATA_DIR
        for folder in (self.cache_dir, self.sidecar_dir, self.method_dir):
            folder.mkdir(parents=True)
        self.patchers = [
            patch.object(
                config,
                "get_project_dataset_cache_dir",
                return_value=str(self.cache_dir),
            ),
            patch.object(
                config,
                "get_project_method_data_dir",
                return_value=str(self.method_dir),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in self.patchers:
            patcher.stop()
        self.temp_dir.cleanup()

    def _add_dataset(self, name: str, *, variants: int = 1, dataset_type: str = "") -> None:
        for index in range(variants):
            origin = 12 + index
            (self.cache_dir / f"{name}@{origin}@12@cum@dev.csv").write_text("1\n", encoding="utf-8")
        (self.sidecar_dir / f"{name}.json").write_text(
            json.dumps({
                "dataset_name": name,
                "dataset_type": dataset_type or name,
                "data_format": "Triangle",
                "origin_length": 12,
                "development_length": 12,
                "cumulative": True,
                "calendar": False,
            }),
            encoding="utf-8",
        )

    def test_one_scan_reads_each_distinct_sidecar_once(self) -> None:
        # Two cache variants of one dataset share a single sidecar, so a batched
        # read must deduplicate instead of paying a round trip per CSV.
        self._add_dataset("Paid Loss", variants=2)
        self._add_dataset("Reported Loss")

        with patch.object(
            calculated_dataset_service,
            "_read_sidecar",
            wraps=calculated_dataset_service._read_sidecar,
        ) as read_sidecar:
            scan = calculated_dataset_service._scan_dataset_cache_folder(PROJECT, RESERVING_CLASS)

        self.assertTrue(scan.exists)
        self.assertEqual(len(scan.csv_files), 3)
        self.assertEqual(len(scan.sidecars), 2)
        self.assertEqual(read_sidecar.call_count, 2)

    def test_folder_reads_run_with_bounded_concurrency(self) -> None:
        for index in range(40):
            self._add_dataset(f"Dataset {index:02d}")

        in_flight = 0
        peak = 0
        guard = threading.Lock()
        original = calculated_dataset_service._read_sidecar

        def tracked(path: str):
            nonlocal in_flight, peak
            with guard:
                in_flight += 1
                peak = max(peak, in_flight)
            try:
                return original(path)
            finally:
                with guard:
                    in_flight -= 1

        with patch.object(calculated_dataset_service, "_read_sidecar", side_effect=tracked):
            scan = calculated_dataset_service._scan_dataset_cache_folder(PROJECT, RESERVING_CLASS)

        self.assertEqual(len(scan.sidecars), 40)
        self.assertLessEqual(peak, calculated_dataset_service._FOLDER_SCAN_MAX_WORKERS)

    def test_candidates_reuse_a_supplied_scan_without_new_reads(self) -> None:
        self._add_dataset("Paid Loss")
        self._add_dataset("Reported Loss")
        scan = calculated_dataset_service._scan_dataset_cache_folder(PROJECT, RESERVING_CLASS)

        with patch.object(calculated_dataset_service, "_read_sidecar") as read_sidecar:
            candidates = calculated_dataset_service._candidate_csvs(
                PROJECT,
                RESERVING_CLASS,
                "Paid Loss",
                TARGET_SETTINGS,
                scan=scan,
            )

        read_sidecar.assert_not_called()
        self.assertEqual(
            [Path(item["path"]).name for item in candidates],
            ["Paid Loss@12@12@cum@dev.csv"],
        )

    def test_candidate_order_is_deterministic_across_scans(self) -> None:
        # Same score for every variant, so ordering must not depend on which
        # worker finished first.
        self._add_dataset("Paid Loss", variants=4)
        expected = [
            Path(item["path"]).name
            for item in calculated_dataset_service._candidate_csvs(
                PROJECT, RESERVING_CLASS, "Paid Loss", TARGET_SETTINGS
            )
        ]
        for _attempt in range(4):
            names = [
                Path(item["path"]).name
                for item in calculated_dataset_service._candidate_csvs(
                    PROJECT, RESERVING_CLASS, "Paid Loss", TARGET_SETTINGS
                )
            ]
            self.assertEqual(names, expected)
        self.assertEqual(len(expected), 4)

    def test_missing_folder_and_unreadable_sidecar_do_not_raise(self) -> None:
        self._add_dataset("Paid Loss")
        (self.sidecar_dir / "Paid Loss.json").write_text("{ not json", encoding="utf-8")
        candidates = calculated_dataset_service._candidate_csvs(
            PROJECT, RESERVING_CLASS, "Paid Loss", TARGET_SETTINGS
        )
        # The file stem still identifies the dataset when its sidecar cannot be read.
        self.assertEqual(len(candidates), 1)

        with patch.object(
            config,
            "get_project_dataset_cache_dir",
            return_value=str(self.root / "missing"),
        ):
            self.assertEqual(
                calculated_dataset_service._candidate_csvs(
                    PROJECT, RESERVING_CLASS, "Paid Loss", TARGET_SETTINGS
                ),
                [],
            )

    def test_dfm_method_candidates_batch_their_folder_reads(self) -> None:
        for index in range(6):
            name = f"DFM Output {index}"
            (self.method_dir / f"DFM@{name}.json").write_text(
                json.dumps({
                    "details tab": {"name": f"Method {index}", "output type": name},
                }),
                encoding="utf-8",
            )
        (self.method_dir / "RS@Ignored.json").write_text("{}", encoding="utf-8")

        with patch.object(
            calculated_dataset_service,
            "_read_sidecar",
            wraps=calculated_dataset_service._read_sidecar,
        ) as read_sidecar:
            scan = calculated_dataset_service._scan_dfm_method_folder(PROJECT, RESERVING_CLASS)

        self.assertEqual(len(scan.method_files), 6)
        self.assertEqual(read_sidecar.call_count, 6)

        with patch.object(calculated_dataset_service, "_read_sidecar") as blocked:
            candidates = calculated_dataset_service._candidate_dfm_methods(
                PROJECT,
                RESERVING_CLASS,
                "DFM Output 3",
                scan=scan,
            )
        blocked.assert_not_called()
        self.assertEqual([Path(item["path"]).name for item in candidates], ["DFM@DFM Output 3.json"])

    def test_load_components_enumerates_the_cache_folder_once(self) -> None:
        self._add_dataset("Paid Loss")
        self._add_dataset("Reported Loss")

        with patch.object(
            calculated_dataset_service,
            "_scan_dataset_cache_folder",
            wraps=calculated_dataset_service._scan_dataset_cache_folder,
        ) as scan_folder:
            values, precedents, errors = calculated_dataset_service._load_components(
                PROJECT,
                RESERVING_CLASS,
                ["Paid Loss", "Reported Loss"],
                TARGET_SETTINGS,
            )

        self.assertEqual(errors, [])
        self.assertEqual(sorted(values), ["_d0", "_d1"])
        self.assertEqual([item["dataset_type_name"] for item in precedents], ["Paid Loss", "Reported Loss"])
        self.assertEqual(scan_folder.call_count, 1)


if __name__ == "__main__":
    unittest.main()
