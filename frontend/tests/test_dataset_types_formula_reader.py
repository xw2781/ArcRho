"""The Dataset Types tab reads a formula the way the links do.

Source expansion, save-time validation and the persisted dependency links all
go through one reader, so a formula that quotes one input and leaves another
unquoted is understood the same way wherever it is read.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
PYTHON_API_SRC = FRONTEND_ROOT.parent / "python-api" / "src"
for _path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from app_server.services import dataset_types_service


# Name, Data Format, Category, Calculated, Formula: the canonical submitted row.
MIXED_ROWS = [
    ["Earned Premium", "Triangle", "Premium", False, ""],
    ["Remaining Budget Premium", "Triangle", "Premium", False, ""],
    ["Total Earned Premium", "Triangle", "Premium", True, '"Earned Premium" + Remaining Budget Premium'],
]
SOURCE_MAP = {
    "earned premium": "Earned_Premium",
    "remaining budget premium": "Remaining_Budget_Premium",
}
FIELD_NAMES = ["Earned_Premium", "Remaining_Budget_Premium"]


class DatasetTypesFormulaReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        for name, value in (
            ("_load_dataset_source_map", SOURCE_MAP),
            ("_load_field_mapping_field_names", FIELD_NAMES),
        ):
            patcher = patch.object(dataset_types_service, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_mixed_formula_whose_names_all_exist_is_accepted(self) -> None:
        dataset_types_service.require_resolvable_formulas([list(row) for row in MIXED_ROWS])

    def test_an_unquoted_word_the_table_lacks_is_not_a_reference_to_resolve(self) -> None:
        rows = [list(row) for row in MIXED_ROWS]
        rows[2][4] = '"Earned Premium" + Unbudgeted Premium'
        dataset_types_service.require_resolvable_formulas(rows)

        rows[2][4] = '"Earned Premium" + "Unbudgeted Premium"'
        with self.assertRaises(HTTPException) as caught:
            dataset_types_service.require_resolvable_formulas(rows)
        self.assertIn("Unbudgeted Premium", str(caught.exception.detail))

    def test_source_expansion_uses_both_the_quoted_and_the_unquoted_name(self) -> None:
        resolved = dataset_types_service.resolve_persisted_rows("Demo", [list(row) for row in MIXED_ROWS])
        by_name = {row[0]: row for row in resolved}
        self.assertEqual(by_name["Total Earned Premium"][5], "Earned_Premium + Remaining_Budget_Premium")
        self.assertTrue(by_name["Total Earned Premium"][6])


if __name__ == "__main__":
    unittest.main()
