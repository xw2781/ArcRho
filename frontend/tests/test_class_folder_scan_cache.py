"""Scandir-validated class folder caches behind calculated-dataset reads.

Live preview posts one request per debounced edit, and each request used to
re-read every sidecar and component CSV in the reserving class over the
network share. These tests pin the cache that turns repeat requests into
directory listings: unchanged files are served from memory, changed or
recently written files are re-read, and unvalidatable paths are never cached.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app_server.services import calculated_dataset_service, class_folder_scan_cache


def _age_file(path: Path, seconds: float = 120.0) -> None:
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


class ClassFolderScanCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        class_folder_scan_cache.clear_class_folder_scan_cache()
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        class_folder_scan_cache.clear_class_folder_scan_cache()
        self.temp_dir.cleanup()

    def _write_json(self, name: str, payload: dict, age_seconds: float = 120.0) -> Path:
        path = self.root / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        _age_file(path, age_seconds)
        return path

    def _listing(self):
        exists, entries = class_folder_scan_cache.scan_files_with_stats(str(self.root), ".json")
        self.assertTrue(exists)
        return class_folder_scan_cache.stats_by_normcase_path(entries)

    def test_unchanged_files_are_served_from_memory(self) -> None:
        first = self._write_json("a.json", {"value": 1})
        second = self._write_json("b.json", {"value": 2})
        paths = [str(first), str(second)]
        with patch.object(
            class_folder_scan_cache,
            "_load_json_payload",
            wraps=class_folder_scan_cache._load_json_payload,
        ) as loader:
            initial = class_folder_scan_cache.read_json_files_cached(paths, self._listing())
            self.assertEqual(loader.call_count, 2)
            repeat = class_folder_scan_cache.read_json_files_cached(paths, self._listing())
            self.assertEqual(loader.call_count, 2, "unchanged files must not be re-read")
        self.assertEqual(initial[str(first)], {"value": 1})
        self.assertEqual(repeat, initial)
        # Served payloads are copies: mutating a result must not poison the cache.
        repeat[str(first)]["value"] = "mutated"
        again = class_folder_scan_cache.read_json_files_cached(paths, self._listing())
        self.assertEqual(again[str(first)], {"value": 1})

    def test_changed_and_recently_written_files_are_re_read(self) -> None:
        target = self._write_json("a.json", {"value": 1})
        paths = [str(target)]
        class_folder_scan_cache.read_json_files_cached(paths, self._listing())
        self._write_json("a.json", {"value": 99})
        updated = class_folder_scan_cache.read_json_files_cached(paths, self._listing())
        self.assertEqual(updated[str(target)], {"value": 99})
        # A fresh write stays inside the recent-write guard, so it is re-read
        # every time until the timestamp ages out of the ambiguity window.
        target.write_text(json.dumps({"value": 7}), encoding="utf-8")
        with patch.object(
            class_folder_scan_cache,
            "_load_json_payload",
            wraps=class_folder_scan_cache._load_json_payload,
        ) as loader:
            class_folder_scan_cache.read_json_files_cached(paths, self._listing())
            class_folder_scan_cache.read_json_files_cached(paths, self._listing())
            self.assertEqual(loader.call_count, 2)

    def test_paths_missing_from_the_listing_are_never_cached(self) -> None:
        target = self._write_json("a.json", {"value": 1})
        with patch.object(
            class_folder_scan_cache,
            "_load_json_payload",
            wraps=class_folder_scan_cache._load_json_payload,
        ) as loader:
            for _ in range(2):
                result = class_folder_scan_cache.read_json_files_cached([str(target)], {})
                self.assertEqual(result[str(target)], {"value": 1})
            self.assertEqual(loader.call_count, 2, "unvalidatable paths must be read fresh")

    def test_matrix_cache_reuses_unchanged_content_and_copies_results(self) -> None:
        csv_path = self.root / "component.csv"
        csv_path.write_text("1,2\n3,4\n", encoding="utf-8")
        _age_file(csv_path)
        loads = []

        def loader(path: str):
            loads.append(path)
            import numpy as np

            return np.asarray([[1.0, 2.0], [3.0, 4.0]]), {"mtime_ns": 1}

        first, meta = class_folder_scan_cache.read_matrix_cached(str(csv_path), loader)
        second, _meta = class_folder_scan_cache.read_matrix_cached(str(csv_path), loader)
        self.assertEqual(len(loads), 1, "unchanged content must be served from memory")
        self.assertEqual(meta, {"mtime_ns": 1})
        first[0][0] = 999.0
        third, _meta = class_folder_scan_cache.read_matrix_cached(str(csv_path), loader)
        self.assertEqual(float(third[0][0]), 1.0, "served matrices must be copies")
        self.assertEqual(second.tolist(), third.tolist())

    def test_matrix_cache_re_reads_changed_files_and_never_caches_failures(self) -> None:
        csv_path = self.root / "component.csv"
        csv_path.write_text("1\n", encoding="utf-8")
        _age_file(csv_path)

        def failing(path: str):
            raise ValueError("bad csv")

        with self.assertRaises(ValueError):
            class_folder_scan_cache.read_matrix_cached(str(csv_path), failing)

        loads = []

        def loader(path: str):
            loads.append(path)
            import numpy as np

            return np.asarray([[float(len(loads))]]), {}

        value, _meta = class_folder_scan_cache.read_matrix_cached(str(csv_path), loader)
        self.assertEqual(float(value[0][0]), 1.0)
        csv_path.write_text("2\n", encoding="utf-8")
        _age_file(csv_path)
        value, _meta = class_folder_scan_cache.read_matrix_cached(str(csv_path), loader)
        self.assertEqual(len(loads), 2, "a changed stat identity must re-read")

    def test_dataset_folder_scan_reuses_cached_sidecars(self) -> None:
        datasets_dir = self.root / "datasets"
        sidecars_dir = self.root / "sidecars"
        datasets_dir.mkdir()
        sidecars_dir.mkdir()
        csv_path = datasets_dir / "Paid Loss@12.csv"
        csv_path.write_text("1\n", encoding="utf-8")
        _age_file(csv_path)
        sidecar_path = sidecars_dir / "Paid Loss@12.json"
        sidecar_path.write_text(json.dumps({"dataset_name": "Paid Loss"}), encoding="utf-8")
        _age_file(sidecar_path)

        with (
            patch.object(
                calculated_dataset_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(datasets_dir),
            ),
            patch.object(
                calculated_dataset_service.config,
                "get_project_dataset_sidecar_dir",
                return_value=str(sidecars_dir),
            ),
            patch.object(
                calculated_dataset_service.dataset_instance_index_service,
                "_dataset_sidecar_path_for_cached_csv",
                return_value=str(sidecar_path),
            ),
            patch.object(
                class_folder_scan_cache,
                "_load_json_payload",
                wraps=class_folder_scan_cache._load_json_payload,
            ) as loader,
        ):
            first = calculated_dataset_service._scan_dataset_cache_folder("Proj", "RC")
            second = calculated_dataset_service._scan_dataset_cache_folder("Proj", "RC")
        self.assertTrue(first.exists)
        self.assertEqual(loader.call_count, 1, "the repeat scan must serve sidecars from memory")
        self.assertEqual(
            second.sidecars[str(sidecar_path)],
            {"dataset_name": "Paid Loss"},
        )
        self.assertIn(os.path.normcase(str(csv_path)), second.csv_stats)


if __name__ == "__main__":
    unittest.main()
