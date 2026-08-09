"""Version-scoped table-summary cache naming.

The cache file lives in the shared project folder, so two installed app
versions read the same folder. Before the file name carried the summary
version, each version rejected the other's payload and rewrote it, so a fleet
running two versions never saw a warm cache and paid a full `read_csv` of the
imported table on every Source Data load.
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

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import table_summary_service

PROJECT_NAME = "CacheVersioningProject"
DATE_ROLES = {"acc_yrmo": "Origin Date"}


class TableSummaryCacheVersioningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.projects_dir = Path(self.temp_dir.name)
        self.project_dir = self.projects_dir / PROJECT_NAME
        (self.project_dir / "source").mkdir(parents=True)
        self.master_path = self.project_dir / "source" / "master_table.csv"
        self.master_path.write_text("acc_yrmo\n202401\n", encoding="utf-8")
        # A cache is only valid when it is newer than the imported table.
        stamp = time.time() - 600
        os.utime(self.master_path, (stamp, stamp))
        self.patcher = patch.object(config, "PROJECT_SETTINGS_DIR", str(self.projects_dir))
        self.patcher.start()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.temp_dir.cleanup()

    def _write_cache(self, path: Path, summary_version: int) -> None:
        path.write_text(
            json.dumps(
                {
                    "ok": True,
                    "summary_version": summary_version,
                    "date_roles": dict(DATE_ROLES),
                    "columns": [{"name": "acc_yrmo"}],
                }
            ),
            encoding="utf-8",
        )

    def _read(self, summary_version: int):
        """One `GET /table_summary` as an app build whose version is `summary_version`."""
        with patch.object(table_summary_service, "SUMMARY_VERSION", summary_version):
            return table_summary_service.read_valid_cache(
                str(self.master_path),
                config.get_cache_path(PROJECT_NAME, summary_version),
                config.get_legacy_cache_path(PROJECT_NAME),
                DATE_ROLES,
            )

    def test_cache_path_carries_the_summary_version(self) -> None:
        path_v6 = config.get_cache_path(PROJECT_NAME, 6)
        path_v5 = config.get_cache_path(PROJECT_NAME, 5)
        self.assertEqual(os.path.basename(path_v6), "table_summary.v6.json")
        self.assertNotEqual(path_v6, path_v5)
        self.assertEqual(
            os.path.basename(config.get_legacy_cache_path(PROJECT_NAME)),
            "table_summary.json",
        )

    def test_two_versions_keep_separate_caches(self) -> None:
        self._write_cache(self.project_dir / "table_summary.v6.json", 6)
        self._write_cache(self.project_dir / "table_summary.v5.json", 5)

        for version in (6, 5, 6):
            cached = self._read(version)
            self.assertIsNotNone(cached, f"version {version} lost its cache")
            self.assertEqual(cached["summary_version"], version)

        # Neither read consumed or rewrote the other version's file.
        self.assertTrue((self.project_dir / "table_summary.v6.json").exists())
        self.assertTrue((self.project_dir / "table_summary.v5.json").exists())

    def test_matching_legacy_cache_is_adopted_once(self) -> None:
        legacy = self.project_dir / "table_summary.json"
        self._write_cache(legacy, 6)

        cached = self._read(6)
        self.assertIsNotNone(cached)
        self.assertEqual(cached["summary_version"], 6)
        # Renamed rather than re-read, so upgrading costs no full CSV parse.
        self.assertFalse(legacy.exists())
        self.assertTrue((self.project_dir / "table_summary.v6.json").exists())

    def test_legacy_cache_of_another_version_is_left_alone(self) -> None:
        legacy = self.project_dir / "table_summary.json"
        self._write_cache(legacy, 5)

        self.assertIsNone(self._read(6))
        # It is the only cache the version that wrote it can still use.
        self.assertTrue(legacy.exists())
        self.assertFalse((self.project_dir / "table_summary.v6.json").exists())

    def test_stale_cache_is_rejected(self) -> None:
        cache_path = self.project_dir / "table_summary.v6.json"
        self._write_cache(cache_path, 6)
        stamp = os.stat(self.master_path).st_mtime - 60
        os.utime(cache_path, (stamp, stamp))

        self.assertIsNone(self._read(6))

    def test_refresh_discards_every_cached_version(self) -> None:
        self._write_cache(self.project_dir / "table_summary.v6.json", 6)
        self._write_cache(self.project_dir / "table_summary.v5.json", 5)
        self._write_cache(self.project_dir / "table_summary.json", 4)
        (self.project_dir / "field_mapping.json").write_text("{}", encoding="utf-8")

        paths = config.list_table_summary_cache_paths(PROJECT_NAME)
        self.assertEqual(len(paths), 3)
        self.assertEqual(table_summary_service.discard_cached_summaries(paths), 3)
        self.assertEqual(config.list_table_summary_cache_paths(PROJECT_NAME), [])
        # Only the cache files went.
        self.assertTrue((self.project_dir / "field_mapping.json").exists())
        self.assertTrue(self.master_path.exists())


if __name__ == "__main__":
    unittest.main()
