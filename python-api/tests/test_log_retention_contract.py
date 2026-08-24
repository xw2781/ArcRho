from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_log_retention_contract import (  # noqa: E402
    LOG_RETENTION_DAYS,
    apply_log_retention,
    prune_aged_log_files,
    trim_aged_log_lines,
)


DAY = 86400


def _write(path: Path, text: str, age_days: float = 0.0) -> Path:
    path.write_text(text, encoding="utf-8", newline="")
    stamp = time.time() - age_days * DAY
    os.utime(path, (stamp, stamp))
    return path


class PruneAgedLogFilesTests(unittest.TestCase):
    def test_keeps_the_window_and_drops_what_is_older(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            fresh = _write(directory / "electron-main-new.log", "x", age_days=1)
            edge = _write(directory / "electron-main-edge.log", "x", age_days=29)
            stale = _write(directory / "electron-main-old.log", "x", age_days=31)

            removed = prune_aged_log_files(directory)

            self.assertEqual(removed, 1)
            self.assertTrue(fresh.exists())
            self.assertTrue(edge.exists())
            self.assertFalse(stale.exists())

    def test_prunes_rotated_backups_and_leaves_other_files(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            rotated = _write(directory / "gateway.log.1", "x", age_days=40)
            jsonl = _write(directory / "client_save_latency.jsonl.2", "x", age_days=40)
            other = _write(directory / "notes.txt", "x", age_days=40)

            prune_aged_log_files(directory)

            self.assertFalse(rotated.exists())
            self.assertFalse(jsonl.exists())
            self.assertTrue(other.exists())

    def test_a_missing_directory_prunes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(prune_aged_log_files(Path(folder) / "absent"), 0)

    def test_request_log_suffixes_are_the_caller_s_choice(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            request = _write(directory / "2026-07-01_request.json", "{}", age_days=40)

            self.assertEqual(prune_aged_log_files(directory), 0)
            self.assertEqual(prune_aged_log_files(directory, suffixes=(".json",)), 1)
            self.assertFalse(request.exists())


class TrimAgedLogLinesTests(unittest.TestCase):
    def _dated(self, days_ago: float) -> str:
        stamp = time.time() - days_ago * DAY
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stamp))

    def test_drops_old_lines_and_keeps_the_recent_ones(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gateway.log"
            old = f"{self._dated(45)} started\n"
            recent = f"{self._dated(2)} ready\n"
            path.write_text(old + recent, encoding="utf-8", newline="")

            dropped = trim_aged_log_lines(path)

            self.assertEqual(dropped, 1)
            self.assertEqual(path.read_text(encoding="utf-8"), recent)

    def test_a_traceback_body_follows_the_line_above_it(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "arcrho_admin.log"
            old = f"{self._dated(45)} startup failed\nTraceback (most recent call last):\n  boom\n"
            recent = f"{self._dated(1)} server ready\n"
            path.write_text(old + recent, encoding="utf-8", newline="")

            dropped = trim_aged_log_lines(path)

            self.assertEqual(dropped, 3)
            self.assertEqual(path.read_text(encoding="utf-8"), recent)

    def test_a_json_record_is_dated_by_its_first_field(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "resq_data_migration_debug.log"
            old = '{"ts": "%s", "event": "start"}\n' % self._dated(60).replace(" ", "T")
            recent = '{"ts": "%s", "event": "start"}\n' % self._dated(3).replace(" ", "T")
            path.write_text(old + recent, encoding="utf-8", newline="")

            trim_aged_log_lines(path)

            self.assertEqual(path.read_text(encoding="utf-8"), recent)

    def test_an_undated_log_is_left_alone(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gateway.log"
            text = "no dates here\nnor here\n"
            path.write_text(text, encoding="utf-8", newline="")

            self.assertEqual(trim_aged_log_lines(path), 0)
            self.assertEqual(path.read_text(encoding="utf-8"), text)

    def test_a_wholly_old_log_ends_up_empty(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gateway.log"
            path.write_text(f"{self._dated(90)} stopped\n", encoding="utf-8", newline="")

            trim_aged_log_lines(path)

            self.assertEqual(path.read_text(encoding="utf-8"), "")

    def test_a_missing_log_trims_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(trim_aged_log_lines(Path(folder) / "absent.log"), 0)


class ApplyLogRetentionTests(unittest.TestCase):
    def test_prunes_the_folder_and_trims_the_appended_log(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            stale = _write(directory / "hosted_saves.log", "x", age_days=60)
            appended = directory / "gateway.log"
            old_line = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 60 * DAY)
            )
            new_line = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
            appended.write_text(
                f"{old_line} one\n{new_line} two\n", encoding="utf-8", newline=""
            )

            apply_log_retention(directory, appended_files=(appended,))

            self.assertFalse(stale.exists())
            self.assertEqual(appended.read_text(encoding="utf-8"), f"{new_line} two\n")


class RetentionWindowTests(unittest.TestCase):
    def test_the_window_is_thirty_days(self):
        self.assertEqual(LOG_RETENTION_DAYS, 30)


if __name__ == "__main__":
    unittest.main()
