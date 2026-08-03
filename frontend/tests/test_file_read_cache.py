from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import file_read_cache


def _backdate(path: Path, seconds_ago: float) -> None:
    stamp = time.time() - seconds_ago
    os.utime(path, (stamp, stamp))


class FileReadCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        file_read_cache.clear_file_read_cache()
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.path = Path(self.temp_dir.name) / "settings.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        file_read_cache.clear_file_read_cache()

    def test_repeat_reads_serve_cache_until_mtime_changes(self) -> None:
        self.path.write_text(json.dumps({"origin_start_date": "202001"}), encoding="utf-8")
        _backdate(self.path, 60)
        with patch.object(
            file_read_cache,
            "_load_json_file",
            side_effect=file_read_cache._load_json_file,
        ) as loader:
            first = file_read_cache.read_json_file_cached(str(self.path))
            second = file_read_cache.read_json_file_cached(str(self.path))
            self.assertEqual(loader.call_count, 1)
            self.assertEqual(first, {"origin_start_date": "202001"})
            self.assertEqual(second, first)

            self.path.write_text(json.dumps({"origin_start_date": "202101"}), encoding="utf-8")
            _backdate(self.path, 30)
            third = file_read_cache.read_json_file_cached(str(self.path))
            self.assertEqual(loader.call_count, 2)
            self.assertEqual(third, {"origin_start_date": "202101"})

    def test_recently_written_files_are_always_reread(self) -> None:
        self.path.write_text(json.dumps({"value": 1}), encoding="utf-8")
        with patch.object(
            file_read_cache,
            "_load_json_file",
            side_effect=file_read_cache._load_json_file,
        ) as loader:
            file_read_cache.read_json_file_cached(str(self.path))
            file_read_cache.read_json_file_cached(str(self.path))
            self.assertEqual(loader.call_count, 2)

    def test_cached_payload_mutation_does_not_leak(self) -> None:
        self.path.write_text(json.dumps({"rows": [["Paid"]]}), encoding="utf-8")
        _backdate(self.path, 60)
        first = file_read_cache.read_json_file_cached(str(self.path))
        first["rows"].append(["Mutated"])
        second = file_read_cache.read_json_file_cached(str(self.path))
        self.assertEqual(second, {"rows": [["Paid"]]})

    def test_missing_file_raises_and_is_not_cached(self) -> None:
        with self.assertRaises(FileNotFoundError):
            file_read_cache.read_json_file_cached(str(self.path))
        self.path.write_text(json.dumps({"value": 2}), encoding="utf-8")
        _backdate(self.path, 60)
        self.assertEqual(file_read_cache.read_json_file_cached(str(self.path)), {"value": 2})

    def test_invalid_json_raises_and_is_not_cached(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")
        _backdate(self.path, 60)
        with self.assertRaises(json.JSONDecodeError):
            file_read_cache.read_json_file_cached(str(self.path))
        self.path.write_text(json.dumps({"value": 3}), encoding="utf-8")
        _backdate(self.path, 30)
        self.assertEqual(file_read_cache.read_json_file_cached(str(self.path)), {"value": 3})

    def test_text_reads_share_the_same_validation(self) -> None:
        label_path = Path(self.temp_dir.name) / "headers.csv"
        label_path.write_text("2020,2021", encoding="utf-8")
        _backdate(label_path, 60)
        with patch.object(
            file_read_cache,
            "_load_text_file",
            side_effect=file_read_cache._load_text_file,
        ) as loader:
            first = file_read_cache.read_text_file_cached(str(label_path))
            second = file_read_cache.read_text_file_cached(str(label_path))
            self.assertEqual(loader.call_count, 1)
            self.assertEqual(first, "2020,2021")
            self.assertEqual(second, first)


if __name__ == "__main__":
    unittest.main()
