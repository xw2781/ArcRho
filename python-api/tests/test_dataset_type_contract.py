import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.dataset_type_contract import (
    dataset_type_formula_graph,
    dataset_type_key,
    dataset_type_keys,
    formula_closure,
    formula_references,
    is_app_calculated_dataset_type,
    quoted_formula_names,
)


ROWS = [
    {"name": "Net Loss--Paid", "calculated": True, "generated": True, "formula": '"Gross Loss--Paid " + "Recoveries--Received"'},
    {"name": "Claim Counts--CWP", "calculated": False, "generated": True, "formula": ""},
    {"name": "H 06 - Net Paid per CWP", "calculated": True, "generated": False, "formula": '"Net Loss--Paid" / "Claim Counts--CWP" * 1000'},
    {"name": "F 35 - Claim Count * Severity", "calculated": True, "generated": False, "formula": '"C 91 - Current Qtr Indicated" * "H 06 - Net Paid per CWP" / 1000'},
    {"name": "Prior Qtr Indicated", "calculated": False, "generated": False, "formula": '"Current Qtr Indicated"'},
    {"name": "Adjusted*", "calculated": True, "generated": False, "formula": "   "},
]
KEYS = dataset_type_keys(ROWS)


def _row(name: str) -> dict:
    return next(row for row in ROWS if row["name"] == name)


class DatasetTypeContractTests(unittest.TestCase):
    def test_key_ignores_quotes_outer_space_inner_runs_and_case(self) -> None:
        self.assertEqual(dataset_type_key('  "Gross  Loss--Paid " '), "gross loss--paid")
        self.assertEqual(dataset_type_key(None), "")

    def test_quoted_names_come_back_in_order_once_each(self) -> None:
        self.assertEqual(
            quoted_formula_names('"A" * ("B" + "A") / "b"'),
            ["A", "B"],
        )
        self.assertEqual(quoted_formula_names("Earned Premium + Remaining Budget Premium"), [])

    def test_calculated_type_over_known_types_is_app_calculated(self) -> None:
        self.assertTrue(is_app_calculated_dataset_type(_row("H 06 - Net Paid per CWP"), KEYS))

    def test_calculated_type_naming_a_type_the_table_lacks_is_an_input(self) -> None:
        self.assertFalse(is_app_calculated_dataset_type(_row("F 35 - Claim Count * Severity"), KEYS))
        self.assertTrue(is_app_calculated_dataset_type(_row("F 35 - Claim Count * Severity"), KEYS | {"c 91 - current qtr indicated"}))

    def test_generated_unflagged_and_blank_formula_rows_are_never_app_calculated(self) -> None:
        self.assertFalse(is_app_calculated_dataset_type(_row("Net Loss--Paid"), KEYS))
        self.assertFalse(is_app_calculated_dataset_type(_row("Claim Counts--CWP"), KEYS))
        self.assertFalse(is_app_calculated_dataset_type(_row("Prior Qtr Indicated"), KEYS))
        self.assertFalse(is_app_calculated_dataset_type(_row("Adjusted*"), KEYS))


# The fake project's three generated types, plus a hand-edited ratio over them
# and the shorter name "Premium" that their names contain.
GRAPH_ROWS = [
    {"name": "Earned Premium", "calculated": False, "generated": True, "formula": ""},
    {"name": "Remaining Budget Premium", "calculated": False, "generated": True, "formula": ""},
    {"name": "Premium", "calculated": False, "generated": True, "formula": ""},
    {"name": "Total Earned Premium", "calculated": True, "generated": True, "formula": '"Earned Premium" + Remaining Budget Premium'},
    {"name": "Premium Ratio", "calculated": True, "generated": False, "formula": 'TOTAL EARNED PREMIUM / "Earned Premium"'},
]


class FormulaReferenceTests(unittest.TestCase):
    def test_quoted_unquoted_and_mixed_names_all_count(self) -> None:
        known = ["Earned Premium", "Remaining Budget Premium"]
        self.assertEqual(
            formula_references('"Earned Premium" + "Remaining Budget Premium"', known),
            ["Earned Premium", "Remaining Budget Premium"],
        )
        # Unquoted names are looked for longest first, so they come back that way.
        self.assertEqual(
            formula_references("Earned Premium + Remaining Budget Premium", known),
            ["Remaining Budget Premium", "Earned Premium"],
        )
        self.assertEqual(
            formula_references('"Earned Premium" + Remaining Budget Premium', known),
            ["Earned Premium", "Remaining Budget Premium"],
        )

    def test_case_and_whitespace_differences_name_the_same_type_once(self) -> None:
        self.assertEqual(
            formula_references("EARNED premium * 2 + earned premium", ["Earned Premium"]),
            ["Earned Premium"],
        )
        self.assertEqual(
            formula_references('  "Earned  Premium " + Earned Premium  ', ["Earned Premium"]),
            ["Earned  Premium"],
        )

    def test_a_longer_name_takes_the_text_from_the_shorter_one_it_contains(self) -> None:
        known = ["Premium", "Earned Premium"]
        self.assertEqual(formula_references("Earned Premium * 2", known), ["Earned Premium"])
        self.assertEqual(formula_references("Earned Premium + Premium", known), ["Earned Premium", "Premium"])

    def test_an_unquoted_word_the_table_does_not_know_is_not_a_reference(self) -> None:
        self.assertEqual(formula_references("Unknown Premium Type * 2", ["Earned Premium"]), [])
        self.assertEqual(formula_references("   ", ["Earned Premium"]), [])


class FormulaGraphTests(unittest.TestCase):
    def test_a_generated_formula_has_its_edges_both_ways(self) -> None:
        graph = dataset_type_formula_graph(GRAPH_ROWS)
        self.assertEqual(
            graph.precedents["total earned premium"],
            ("earned premium", "remaining budget premium"),
        )
        self.assertEqual(graph.dependents["earned premium"], ("total earned premium", "premium ratio"))
        self.assertEqual(graph.dependents["remaining budget premium"], ("total earned premium",))
        self.assertEqual(graph.names["remaining budget premium"], "Remaining Budget Premium")
        self.assertNotIn("earned premium", graph.precedents)
        self.assertNotIn("premium", graph.dependents)

    def test_closure_walks_the_chain_both_ways(self) -> None:
        self.assertEqual(
            formula_closure(GRAPH_ROWS, ["Earned Premium"], "dependents"),
            ["total earned premium", "premium ratio"],
        )
        self.assertEqual(
            formula_closure(GRAPH_ROWS, ["Premium Ratio"], "precedents"),
            ["earned premium", "total earned premium", "remaining budget premium"],
        )
        self.assertEqual(formula_closure(GRAPH_ROWS, ["Remaining Budget Premium"], "precedents"), [])

    def test_a_formula_cycle_ends_the_walk(self) -> None:
        rows = [
            {"name": "A", "calculated": True, "generated": True, "formula": '"C" + 1'},
            {"name": "B", "calculated": True, "generated": True, "formula": '"A" + 1'},
            {"name": "C", "calculated": True, "generated": True, "formula": '"B" + 1'},
        ]
        self.assertEqual(formula_closure(rows, ["A"], "dependents"), ["b", "c"])
        self.assertEqual(formula_closure(rows, ["A"], "precedents"), ["c", "b"])


if __name__ == "__main__":
    unittest.main()
