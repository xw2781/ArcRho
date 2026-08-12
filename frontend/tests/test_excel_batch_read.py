from __future__ import annotations

import sys
import stat
import unittest
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import excel_service


class _Workbook:
    sheetnames = ["Sheet1"]

    def __init__(self, value: float) -> None:
        self.value = value
        self.closed = False

    def __getitem__(self, key: str):
        if key == "Sheet1":
            return self
        return SimpleNamespace(value=self.value)

    def close(self) -> None:
        self.closed = True


class _RecordingExecutor:
    max_workers = 0

    def __init__(self, *, max_workers: int, thread_name_prefix: str) -> None:
        del thread_name_prefix
        type(self).max_workers = max_workers

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def submit(self, fn, *args):
        future = Future()
        future.set_result(fn(*args))
        return future


class ExcelBatchReadTests(unittest.TestCase):
    def item(self, book: str, cell: str = "A1"):
        return SimpleNamespace(book_path=book, sheet="Sheet1", cell=cell)

    def test_deduplicates_cells_opens_each_workbook_once_and_preserves_order(self) -> None:
        first = _Workbook(12.5)
        second = _Workbook(33.0)
        items = [
            self.item("first.xlsx"),
            self.item("second.xlsx"),
            self.item("first.xlsx"),
        ]
        with (
            mock.patch.object(Path, "exists", return_value=True),
            mock.patch.object(
                excel_service.openpyxl,
                "load_workbook",
                side_effect=[first, second],
            ) as load,
        ):
            result = excel_service.excel_read_cells_batch(items)

        self.assertTrue(result["ok"])
        self.assertEqual(result["results"], [
            {"ok": True, "value": 12.5},
            {"ok": True, "value": 33.0},
            {"ok": True, "value": 12.5},
        ])
        self.assertEqual(load.call_count, 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)

    def test_bounds_workbook_concurrency(self) -> None:
        items = [self.item(f"missing-{index}.xlsx") for index in range(8)]
        with mock.patch.object(excel_service, "ThreadPoolExecutor", _RecordingExecutor):
            result = excel_service.excel_read_cells_batch(items)

        self.assertEqual(_RecordingExecutor.max_workers, excel_service.EXCEL_BATCH_MAX_WORKERS)
        self.assertEqual(len(result["results"]), len(items))
        self.assertTrue(all(not item["ok"] for item in result["results"]))

    def test_file_mtimes_deduplicate_stat_calls_and_preserve_order(self) -> None:
        calls = []

        def fake_stat(path: str):
            calls.append(path)
            return SimpleNamespace(
                st_mtime=101.0 if "first" in path else 202.0,
                st_mode=stat.S_IFREG,
            )

        paths = ["first.xlsx", "second.xlsx", "first.xlsx", ""]
        with (
            mock.patch.object(excel_service.os, "stat", side_effect=fake_stat),
            mock.patch.object(excel_service, "ThreadPoolExecutor", _RecordingExecutor),
        ):
            result = excel_service.excel_file_mtimes_batch(paths)

        self.assertTrue(result["ok"])
        self.assertEqual([item.get("mtime") for item in result["results"][:3]], [101.0, 202.0, 101.0])
        self.assertFalse(result["results"][3]["ok"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(_RecordingExecutor.max_workers, 3)

    def test_file_mtime_concurrency_is_bounded(self) -> None:
        paths = [f"workbook-{index}.xlsx" for index in range(8)]
        with (
            mock.patch.object(
                excel_service.os,
                "stat",
                return_value=SimpleNamespace(st_mtime=100.0, st_mode=stat.S_IFREG),
            ),
            mock.patch.object(excel_service, "ThreadPoolExecutor", _RecordingExecutor),
        ):
            result = excel_service.excel_file_mtimes_batch(paths)

        self.assertEqual(_RecordingExecutor.max_workers, excel_service.EXCEL_BATCH_MAX_WORKERS)
        self.assertEqual(len(result["results"]), len(paths))


if __name__ == "__main__":
    unittest.main()
