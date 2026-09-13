from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
PYTHON_API_SRC = FRONTEND_ROOT.parent / "python-api" / "src"
for _path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from arcrho_api.dataset_type_contract import (
    dataset_type_formula_graph,
    generated_formula_refresh_names,
)
from app_server.services import calculated_dataset_service, dataset_service


# ArcRho's library flags "F 35" calculated, but its formula names "C 91",
# a ResQ type ArcRho never imported, so nothing could ever rebuild it.
ROWS = [
    {"name": "Net Loss--Paid", "data_format": "Triangle", "category": "Loss", "calculated": True, "formula": '"Gross Loss--Paid"', "source": "", "generated": True},
    {"name": "Claim Counts--CWP", "data_format": "Triangle", "category": "Counts", "calculated": False, "formula": "", "source": "", "generated": True},
    {"name": "H 06 - Net Paid per CWP", "data_format": "Vector", "category": "Severity", "calculated": True, "formula": '"Net Loss--Paid" / "Claim Counts--CWP" * 1000', "source": "", "generated": False},
    {"name": "F 35 - Claim Count x Severity", "data_format": "Vector", "category": "Loss", "calculated": True, "formula": '"C 91 - Current Qtr Indicated" * "H 06 - Net Paid per CWP" / 1000', "source": "", "generated": False},
]


class DatasetTypeCalculatedRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[dict(row) for row in ROWS])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_unresolvable_type_has_no_calculated_contract(self) -> None:
        self.assertIsNotNone(calculated_dataset_service.calculated_dataset_contract("Demo", "H 06 - Net Paid per CWP"))
        self.assertIsNone(calculated_dataset_service.calculated_dataset_contract("Demo", "F 35 - Claim Count x Severity"))
        self.assertIsNone(calculated_dataset_service.calculated_dataset_dependency_names("Demo", "F 35 - Claim Count x Severity"))

    def test_unresolvable_type_is_nobody_s_dependent_and_no_walk_target(self) -> None:
        self.assertEqual(calculated_dataset_service._direct_dependent_names("Demo", "H 06 - Net Paid per CWP"), [])
        self.assertEqual(calculated_dataset_service._direct_dependent_names("Demo", "Net Loss--Paid"), ["H 06 - Net Paid per CWP"])
        self.assertEqual(calculated_dataset_service._downstream_keys("Demo", ["H 06 - Net Paid per CWP"]), [])
        self.assertNotIn("f 35 - claim count x severity", calculated_dataset_service._calculated_rows_by_key("Demo"))
        result = calculated_dataset_service.recalculate_dataset("Demo", "Auto", "F 35 - Claim Count x Severity")
        self.assertEqual(result["reason"], "not_calculated")

    def test_an_app_calculated_reader_is_not_the_engine_s_to_rebuild(self) -> None:
        # "H 06" reads the claim counts, but ArcRho's own evaluator owns it, so
        # a source refresh leaves it to the dependent walk.
        self.assertEqual(
            calculated_dataset_service.generated_formula_refresh_types("Demo", ["Claim Counts--CWP"]),
            ["Claim Counts--CWP"],
        )

    def test_sidecar_writer_treats_unresolvable_type_as_input_without_a_formula(self) -> None:
        calculation_map = dataset_service._dataset_type_calculation_map("Demo")
        self.assertEqual(dataset_service._is_app_calculated_dataset_type("Demo", "F 35 - Claim Count x Severity", calculation_map=calculation_map), (False, ""))
        self.assertEqual(
            dataset_service._is_app_calculated_dataset_type("Demo", "H 06 - Net Paid per CWP", calculation_map=calculation_map),
            (True, '"Net Loss--Paid" / "Claim Counts--CWP" * 1000'),
        )
        # A generated type keeps the Engine's formula for display.
        self.assertEqual(
            dataset_service._is_app_calculated_dataset_type("Demo", "Net Loss--Paid", calculation_map=calculation_map),
            (False, '"Gross Loss--Paid"'),
        )


# The fake project's three generated types: two source columns and the formula
# the Engine builds from them.
GENERATED_ROWS = [
    {"name": "Earned Premium", "data_format": "Triangle", "category": "Premium", "calculated": False, "formula": "", "source": "Earned_Premium", "generated": True},
    {"name": "Remaining Budget Premium", "data_format": "Triangle", "category": "Premium", "calculated": False, "formula": "", "source": "Remaining_Budget_Premium", "generated": True},
    {"name": "Total Earned Premium", "data_format": "Triangle", "category": "Premium", "calculated": True, "formula": '"Earned Premium" + "Remaining Budget Premium"', "source": "Earned_Premium + Remaining_Budget_Premium", "generated": True},
]


class GeneratedFormulaGraphTests(unittest.TestCase):
    """A generated formula has logical inputs even though the Engine computes it."""

    def setUp(self) -> None:
        patcher = patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[dict(row) for row in GENERATED_ROWS])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_shared_graph_links_both_source_types_to_the_formula(self) -> None:
        graph = dataset_type_formula_graph(GENERATED_ROWS)
        self.assertEqual(
            graph.precedents["total earned premium"],
            ("earned premium", "remaining budget premium"),
        )
        self.assertEqual(graph.dependents["earned premium"], ("total earned premium",))
        self.assertEqual(graph.dependents["remaining budget premium"], ("total earned premium",))

    def test_a_generated_formula_is_still_not_the_evaluator_s_to_compute(self) -> None:
        rows = calculated_dataset_service._dataset_type_rows("Demo")
        self.assertEqual(calculated_dataset_service._app_calculated_rows(rows), [])
        self.assertEqual(calculated_dataset_service._target_dependency_map("Demo"), {})
        self.assertEqual(calculated_dataset_service._dependency_map("Demo"), {})
        self.assertIsNone(calculated_dataset_service.calculated_dataset_contract("Demo", "Total Earned Premium"))


class GeneratedFormulaRefreshSetTests(unittest.TestCase):
    """What a refresh narrowed to one type has to rebuild with it."""

    def setUp(self) -> None:
        patcher = patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[dict(row) for row in GENERATED_ROWS])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_selected_source_type_carries_the_formula_built_on_it(self) -> None:
        self.assertEqual(
            calculated_dataset_service.generated_formula_refresh_types("Demo", ["Earned Premium"]),
            ["Earned Premium", "Total Earned Premium"],
        )

    def test_the_formula_itself_carries_nothing_further_and_no_scope_stays_none(self) -> None:
        self.assertEqual(
            calculated_dataset_service.generated_formula_refresh_types("Demo", ["Total Earned Premium"]),
            ["Total Earned Premium"],
        )
        self.assertEqual(calculated_dataset_service.generated_formula_refresh_types("Demo", []), [])

    def test_the_chain_is_followed_through_a_type_that_was_not_selected(self) -> None:
        rows = [
            *GENERATED_ROWS,
            {"name": "Premium Ratio", "data_format": "Triangle", "category": "Premium", "calculated": True, "formula": '"Total Earned Premium" / "Earned Premium"', "source": "", "generated": True},
        ]
        # The selection is matched however it is spelled, and each name is
        # returned once, in the order the walk reaches it.
        self.assertEqual(
            generated_formula_refresh_names(rows, ["EARNED premium", "Earned Premium"]),
            ["EARNED premium", "Total Earned Premium", "Premium Ratio"],
        )


if __name__ == "__main__":
    unittest.main()
