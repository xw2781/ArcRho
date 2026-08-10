"""Table-summary cache: single file per project, invalidated by mtime/version/mapping.

The cache lives at a fixed path (`table_summary.json`) in the shared project
folder. There is no per-version file name and no legacy-file adoption: the app
is not shipped yet, so no fleet of installed versions needs to keep separate
caches or read another version's leftover file.
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

PROJECT_NAME = "CacheProject"
DATE_ROLES = {"acc_yrmo": "Origin Date"}


class TableSummaryCacheTests(unittest.TestCase):
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
        self.cache_path = Path(config.get_table_summary_cache_path(PROJECT_NAME))

    def tearDown(self) -> None:
        self.patcher.stop()
        self.temp_dir.cleanup()

    def _write_cache(self, summary_version: int) -> None:
        self.cache_path.write_text(
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

    def test_cache_path_is_a_single_fixed_name(self) -> None:
        self.assertEqual(os.path.basename(str(self.cache_path)), "table_summary.json")

    def test_valid_cache_is_served(self) -> None:
        self._write_cache(table_summary_service.SUMMARY_VERSION)
        cached = table_summary_service.load_valid_cache(
            str(self.master_path), str(self.cache_path), DATE_ROLES)
        self.assertIsNotNone(cached)
        self.assertEqual(cached["summary_version"], table_summary_service.SUMMARY_VERSION)

    def test_cache_from_another_summary_version_is_rejected(self) -> None:
        self._write_cache(table_summary_service.SUMMARY_VERSION - 1)
        cached = table_summary_service.load_valid_cache(
            str(self.master_path), str(self.cache_path), DATE_ROLES)
        self.assertIsNone(cached)

    def test_stale_cache_is_rejected(self) -> None:
        self._write_cache(table_summary_service.SUMMARY_VERSION)
        stamp = os.stat(self.master_path).st_mtime - 60
        os.utime(self.cache_path, (stamp, stamp))
        cached = table_summary_service.load_valid_cache(
            str(self.master_path), str(self.cache_path), DATE_ROLES)
        self.assertIsNone(cached)

    def test_cache_built_against_a_different_mapping_is_rejected(self) -> None:
        self._write_cache(table_summary_service.SUMMARY_VERSION)
        cached = table_summary_service.load_valid_cache(
            str(self.master_path), str(self.cache_path), {"other_col": "Origin Date"})
        self.assertIsNone(cached)

    def test_discard_removes_the_cache_and_reports_whether_it_existed(self) -> None:
        self._write_cache(table_summary_service.SUMMARY_VERSION)
        self.assertTrue(table_summary_service.discard_cached_summary(str(self.cache_path)))
        self.assertFalse(self.cache_path.exists())
        self.assertFalse(table_summary_service.discard_cached_summary(str(self.cache_path)))


if __name__ == "__main__":
    unittest.main()
