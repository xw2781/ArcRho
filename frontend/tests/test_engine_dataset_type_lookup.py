"""The Engine finds a dataset type however a request spaces or cases its name.

ResQ spells some type names with a doubled space ("C 92 -  Current Qtr
Selected") that ArcRho's own spelling of the same dataset and the Excel
add-in's normalised request do not carry, and production workbooks still ask
with the old names. The Engine therefore matches its dataset-type table on the
same key the app compares type names with, and the key it ships is a mirror of
the canonical one, pinned here so the two can never drift apart.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
for path in (
    REPOSITORY_ROOT / "frontend",
    REPOSITORY_ROOT / "server-components" / "src",
    REPOSITORY_ROOT / "python-api" / "src",
):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.dataset_type_contract import dataset_type_key as canonical_key
from arcrho_engine import data_processing


class DatasetTypeKeyMirrorTests(unittest.TestCase):
    """The Engine's key is the canonical one, name for name."""

    NAMES = [
        "C 92 -  Current Qtr Selected",
        "C 92 - Current Qtr Selected",
        "  Paid Losses  ",
        '"Claim Counts--CWP"',
        "'E 23 - Recd/Paid Loss  * Ultimate Gross Loss'",
        "Net\tLoss--Paid",
        "PAID losses",
        "",
        None,
    ]

    def test_the_engine_key_matches_the_canonical_key(self) -> None:
        for name in self.NAMES:
            with self.subTest(name=name):
                self.assertEqual(data_processing.dataset_type_key(name), canonical_key(name))


class DatasetTypeRowTests(unittest.TestCase):
    """Which row of the dataset-type table a request names."""

    def setUp(self) -> None:
        self.table = data_processing._json_table_to_df(
            {
                "columns": ["Name", "Data Format", "Source"],
                "rows": [
                    ["C 92 -  Current Qtr Selected", "Vector", ""],
                    ["Paid Losses", "Triangle", "paid"],
                    ["paid losses", "Triangle", "paid_lower"],
                    ["Claim Counts--CWP", "Triangle", "cwp"],
                ],
            }
        )

    def _row(self, name: str):
        return data_processing._dataset_type_row(self.table, name)

    def test_the_exact_spelling_wins_over_a_key_match(self) -> None:
        self.assertEqual(self._row("paid losses")["Source"], "paid_lower")
        self.assertEqual(self._row("Paid Losses")["Source"], "paid")

    def test_the_normalised_name_finds_a_type_the_project_spells_with_a_doubled_space(self) -> None:
        row = self._row("C 92 - Current Qtr Selected")
        self.assertIsNotNone(row)
        self.assertEqual(row["Name"], "C 92 -  Current Qtr Selected")
        self.assertEqual(row["Data Format"], "Vector")

    def test_a_doubled_space_in_the_request_finds_the_project_spelling(self) -> None:
        row = self._row("Claim  Counts--CWP")
        self.assertIsNotNone(row)
        self.assertEqual(row["Source"], "cwp")

    def test_outer_space_and_case_do_not_hide_a_type(self) -> None:
        row = self._row("  CLAIM COUNTS--CWP ")
        self.assertIsNotNone(row)
        self.assertEqual(row["Source"], "cwp")

    def test_a_name_the_project_does_not_define_is_none(self) -> None:
        self.assertIsNone(self._row("Claim Counts--Reported"))
        self.assertIsNone(self._row(""))

    def test_a_table_without_names_holds_no_type(self) -> None:
        table = data_processing._json_table_to_df({"columns": ["Source"], "rows": [["paid"]]})
        self.assertIsNone(data_processing._dataset_type_row(table, "Paid Losses"))


if __name__ == "__main__":
    unittest.main()
