"""Reading a dataset cache CSV whose first origin has no value.

A blank line is an empty origin on disk. Pandas sizes the frame from the first
line, so a file that starts with one used to fail with "No columns to parse
from file" -- a Result Selection with nothing selected for its oldest year
broke every dependent that read it.
"""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for _path in (FRONTEND_ROOT, API_SOURCE):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from app_server.helpers import read_dataset_csv  # noqa: E402


class ReadDatasetCsvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def _file(self, text: str) -> Path:
        path = Path(self.temp.name) / "dataset@12.csv"
        path.write_bytes(text.encode("utf-8"))
        return path

    def _values(self, frame) -> list:
        return [None if isinstance(v, float) and math.isnan(v) else v for v in frame[0].tolist()]

    def test_a_vector_whose_first_origins_are_empty_keeps_every_row(self) -> None:
        frame = read_dataset_csv(self._file("\n\n7416.75\n\n13124.66\n"))
        self.assertEqual(self._values(frame), [None, None, 7416.75, None, 13124.66])

    def test_a_triangle_whose_first_row_is_empty_takes_its_widest_row(self) -> None:
        frame = read_dataset_csv(self._file("\n1,2,3\n4,5\n"))
        self.assertEqual(frame.shape, (3, 3))
        self.assertTrue(frame.iloc[0].isna().all())
        self.assertEqual(frame.iloc[1].tolist(), [1.0, 2.0, 3.0])

    def test_a_file_of_only_empty_origins_reads_as_that_many_empty_rows(self) -> None:
        frame = read_dataset_csv(self._file("\n\n\n"))
        self.assertEqual(frame.shape[0], 3)
        self.assertTrue(frame[0].isna().all())

    def test_a_file_that_starts_with_data_reads_as_before(self) -> None:
        frame = read_dataset_csv(self._file("1.5\n\n2.5\n"))
        self.assertEqual(self._values(frame), [1.5, None, 2.5])

    def test_windows_line_endings_are_read_the_same_way(self) -> None:
        frame = read_dataset_csv(self._file("\r\n3.25\r\n"))
        self.assertEqual(self._values(frame), [None, 3.25])


if __name__ == "__main__":
    unittest.main()
