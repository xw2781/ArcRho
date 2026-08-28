"""The server-side Berquist Sherman calculation must match the page's, cell for cell.

The page under ``frontend/ui/method_pages/berquist_sherman`` and the contract
module are pinned to the same COL golden fixture, so a formula change on one
side fails here until the other side follows.
"""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
if str(PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(PYTHON_API_SRC))

from arcrho_api import berquist_sherman_contract as bs  # noqa: E402

FIXTURE_PATH = REPO_ROOT / "frontend" / "tests" / "fixtures" / "berquist_sherman_col_golden.json"

SR_EXPECTED_FIELDS = {
    "proportionSettled": "proportion_settled",
    "selectedClaimNumbers": "selected_claim_numbers",
    "pairsAdjustment": "pairs_adjustment",
    "allAdjustment": "all_adjustment",
    "loessAdjustment": "loess_adjustment",
    "adjustedPaidClaims": "adjusted_paid_claims",
}
CRA_EXPECTED_FIELDS = {
    "openClaimNumbers": "open_claim_numbers",
    "caseReserves": "case_reserves",
    "averageCaseReserves": "average_case_reserves",
    "averagePaidClaims": "average_paid_claims",
    "caseInflationByColumn": "case_inflation_by_column",
    "caseInflationOverall": "case_inflation_overall",
    "paidInflationByColumn": "paid_inflation_by_column",
    "paidInflationOverall": "paid_inflation_overall",
    "selectedInflation": "selected_inflation",
    "latestAverageCaseReserves": "latest_average_case_reserves",
    "monotoneAverageCaseReserves": "monotone_average_case_reserves",
    "loessAverageCaseReserves": "loess_average_case_reserves",
    "selectedAverageCaseReserves": "selected_average_case_reserves",
    "adjustedAverageCaseReserves": "adjusted_average_case_reserves",
    "adjustedIncurredClaims": "adjusted_incurred_claims",
}


def _sr_source(fixture_input: dict) -> dict:
    return {
        "paid_claims": fixture_input["paidClaims"],
        "closed_claim_numbers": fixture_input["closedClaimNumbers"],
        "ultimate_claim_numbers": fixture_input["ultimateClaimNumbers"],
        "selected_proportion_settled": fixture_input["selectedProportionSettled"],
        "selected_proportion_is_default": fixture_input["selectedProportionIsDefault"],
        "selected_adjustment": fixture_input["selectedAdjustment"],
        "loess_span": fixture_input["loessSpan"],
    }


def _cra_source(fixture_input: dict) -> dict:
    return {
        "reported_claim_numbers": fixture_input["reportedClaimNumbers"],
        "closed_claim_numbers": fixture_input["closedClaimNumbers"],
        "incurred_claims": fixture_input["incurredClaims"],
        "paid_claims": fixture_input["paidClaims"],
        "avg_case_reserve_exclusions": fixture_input["avgCaseReserveExclusions"],
        "avg_paid_claims_exclusions": fixture_input["avgPaidClaimsExclusions"],
        "inflation_selection": fixture_input["inflationSelection"],
        "user_inflation": fixture_input["userInflation"],
        "average_case_reserve_selection": fixture_input["averageCaseReserveSelection"],
        "user_average_case_reserves": fixture_input["userAverageCaseReserves"],
        "loess_span": fixture_input["loessSpan"],
    }


class BerquistShermanContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def assert_close(self, actual, expected, path: str = "value") -> None:
        if isinstance(expected, list):
            self.assertIsInstance(actual, list, f"{path} must be a list")
            self.assertEqual(len(actual), len(expected), f"{path} length")
            for index, value in enumerate(expected):
                self.assert_close(actual[index], value, f"{path}[{index}]")
            return
        if expected is None:
            self.assertIsNone(actual, path)
            return
        self.assertIsNotNone(actual, f"{path} must be a number")
        tolerance = max(1e-9, abs(expected) * 1e-11)
        self.assertLessEqual(abs(actual - expected), tolerance, f"{path}: expected {expected}, got {actual}")

    def test_settlement_rate_reproduces_the_annual_col_resq_object(self) -> None:
        source = self.fixture["settlementRate"]
        result = bs.calculate_settlement_rate(_sr_source(source["input"]))
        self.assertIs(result["output"], result["adjusted_paid_claims"])
        for fixture_name, field in SR_EXPECTED_FIELDS.items():
            self.assert_close(result[field], source["expected"][fixture_name], fixture_name)

    def test_settlement_rate_loess_selections_reproduce_the_col_loess_estimates(self) -> None:
        source = self.fixture["settlementRate"]
        payload = _sr_source(source["input"])
        payload["selected_adjustment"] = [["loess"] * len(row) for row in source["input"]["selectedAdjustment"]]
        result = bs.calculate_settlement_rate(payload)
        self.assertEqual(result["loess_span"], source["input"]["loessSpan"])
        self.assert_close(result["adjusted_paid_claims"], source["expected"]["loessAdjustment"], "loess output")

    def test_settlement_rate_loess_uses_the_default_span_and_reverts_to_pairs(self) -> None:
        source = self.fixture["settlementRate"]
        payload = _sr_source(source["input"])
        payload["loess_span"] = None
        result = bs.calculate_settlement_rate(payload)
        self.assertEqual(result["loess_span"], bs.DEFAULT_LOESS_SPAN)
        self.assert_close(result["loess_adjustment"], source["expected"]["loessAdjustment"], "default span loess")
        # Two populated points leave a single non-zero tri-cube weight, so the
        # degenerate loess fit falls back to the pair-wise interpolation.
        self.assert_close(result["loess_adjustment"][8], source["expected"]["pairsAdjustment"][8], "pairs fallback")

    def test_settlement_rate_defaults_use_the_leading_diagonal(self) -> None:
        result = bs.calculate_settlement_rate({
            "paid_claims": [[100, 400, 900], [40]],
            "closed_claim_numbers": [[10, 20, 20], [5]],
            "ultimate_claim_numbers": [20, 10],
            "selected_proportion_is_default": [True, True, True],
        })
        self.assertEqual(result["selected_proportion_settled"], [0.5, 1, 1])
        self.assertAlmostEqual(result["pairs_adjustment"][0][2], 600)
        self.assertEqual(result["selected_adjustment"][1][0], "unadjusted")
        self.assertEqual(result["adjusted_paid_claims"][1][0], 40)

    def test_settlement_rate_ignores_a_stored_proportion_flagged_as_default(self) -> None:
        # The page stores the proportion it last computed next to the flag; the
        # flag wins, so a moved source re-derives the leading diagonal.
        result = bs.calculate_settlement_rate({
            "paid_claims": [[100, 400, 900], [40]],
            "closed_claim_numbers": [[10, 20, 20], [5]],
            "ultimate_claim_numbers": [20, 10],
            "selected_proportion_settled": [0.9, 0.9, 0.9],
            "selected_proportion_is_default": [True, False, True],
        })
        self.assertEqual(result["selected_proportion_settled"], [0.5, 0.9, 1])

    def test_settlement_rate_duplicate_closed_counts_use_the_pair_geometric_mean(self) -> None:
        result = bs.calculate_settlement_rate({
            "paid_claims": [[25, 100, 400]],
            "closed_claim_numbers": [[5, 10, 10]],
            "ultimate_claim_numbers": [10],
            "selected_proportion_settled": [1, 1, 1],
            "selected_adjustment": [["pairs", "pairs", "pairs"]],
        })
        self.assertAlmostEqual(result["pairs_adjustment"][0][2], 200)

    def test_settlement_rate_rejects_a_blank_ultimate_and_a_shape_mismatch(self) -> None:
        with self.assertRaises(bs.BerquistShermanContractError):
            bs.calculate_settlement_rate({
                "paid_claims": [[100, 400], [40]],
                "closed_claim_numbers": [[10, 20], [5]],
                "ultimate_claim_numbers": [20, None],
            })
        with self.assertRaises(bs.BerquistShermanContractError):
            bs.calculate_settlement_rate({
                "paid_claims": [[100, 400], [40]],
                "closed_claim_numbers": [[10, 20], [5, 6]],
                "ultimate_claim_numbers": [20, 10],
            })

    def test_case_reserve_adequacy_reproduces_the_annual_col_resq_object(self) -> None:
        source = self.fixture["caseReserveAdequacy"]
        result = bs.calculate_case_reserve_adequacy(_cra_source(source["input"]))
        self.assertIs(result["output"], result["adjusted_incurred_claims"])
        for fixture_name, field in CRA_EXPECTED_FIELDS.items():
            self.assert_close(result[field], source["expected"][fixture_name], fixture_name)

    def test_case_reserve_adequacy_exclusion_flags_do_not_change_the_result(self) -> None:
        source = self.fixture["caseReserveAdequacy"]
        payload = _cra_source(source["input"])
        payload["avg_case_reserve_exclusions"] = []
        payload["avg_paid_claims_exclusions"] = []
        result = bs.calculate_case_reserve_adequacy(payload)
        self.assert_close(result["paid_inflation_overall"], source["expected"]["paidInflationOverall"])
        self.assert_close(result["output"], source["expected"]["adjustedIncurredClaims"], "output")

    def test_case_reserve_adequacy_loess_reproduces_the_resq_current_average_case_reserves(self) -> None:
        latest = [838.36, 454.033, 557.75, 622, 0, 0]
        count = len(latest)
        widths = [count - row_index for row_index in range(count)]
        result = bs.calculate_case_reserve_adequacy({
            "reported_claim_numbers": [[2] * width for width in widths],
            "closed_claim_numbers": [[1] * width for width in widths],
            "paid_claims": [[0] * width for width in widths],
            "incurred_claims": [
                [latest[column] if row_index == count - column - 1 else 1 for column in range(width)]
                for row_index, width in enumerate(widths)
            ],
            "loess_span": 7,
        })
        self.assertEqual(result["latest_average_case_reserves"], latest)
        self.assertEqual(
            [round(value, 3) for value in result["loess_average_case_reserves"]],
            [779.906, 593.765, 546.45, 626.727, 702.698, 776.541],
        )

    def test_annual_triangles_mask_structural_zero_padding_and_honor_the_viewer_mask(self) -> None:
        self.assertEqual(
            bs.normalize_annual_triangle([[100, 200, 300], [400, 0, 0], [0, 0, 0]]),
            [[100, 200, 300], [400, 0], [0]],
        )
        self.assertEqual(
            bs.normalize_annual_triangle(
                [[0, 20, 30], [40, 50, 0], [60, 0, 0]],
                [[True, False, True], [True, True, False], [True, False, False]],
            ),
            [[0, None, 30], [40, 50], [60]],
        )

    def test_whole_method_entry_point_reads_the_stored_selections(self) -> None:
        source = self.fixture["settlementRate"]
        method = {
            "json_format": bs.BS_SR_JSON_FORMAT,
            "details_tab": {"name": "BS Paid", "method_type": bs.BS_METHOD_TYPE_BY_VARIANT["sr"]},
            "method_tab": {
                "paid_claims": "Paid",
                "closed_claim_numbers": "Closed",
                "ultimate_claim_numbers": "Ultimate",
                "development_labels": source["developmentLabels"],
                "selected_proportion_settled": source["input"]["selectedProportionSettled"],
                "selected_proportion_is_default": source["input"]["selectedProportionIsDefault"],
                "selected_adjustment": source["input"]["selectedAdjustment"],
                "loess_span": source["input"]["loessSpan"],
            },
            "method_metadata": {"source_kind": bs.BS_SR_SOURCE_KIND},
        }
        self.assertEqual(bs.berquist_sherman_method_variant(method), "sr")
        self.assertEqual(bs.berquist_sherman_precedent_names(method), ["Paid", "Closed", "Ultimate"])
        values = {
            "paid_claims": source["input"]["paidClaims"],
            "closed_claim_numbers": source["input"]["closedClaimNumbers"],
            "ultimate_claim_numbers": source["input"]["ultimateClaimNumbers"],
        }
        result = bs.calculate_berquist_sherman_output(method, values)
        self.assert_close(result["output"], source["expected"]["adjustedPaidClaims"], "output")
        self.assertEqual(bs.berquist_sherman_development_count(method, values), 10)

    def test_output_csv_text_pads_rows_like_the_page_and_reads_back(self) -> None:
        output = [[47911.862115513606, 174349.20286453672], [53942.0], []]
        text = bs.berquist_sherman_output_csv_text(output, 3)
        self.assertEqual(text, "47911.862115513606,174349.20286453672,\n53942,,\n,,\n")
        parsed = bs.parse_output_csv_text(text)
        self.assertTrue(bs.output_values_equal(parsed, output))
        self.assertFalse(bs.output_values_equal(parsed, [[47911.862115513606, 174349.3], [53942.0], []]))
        self.assertTrue(math.isfinite(parsed[0][0]))


if __name__ == "__main__":
    unittest.main()
