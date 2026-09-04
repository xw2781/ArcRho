"""The DFM Curves tab reproduces ResQ's curve fits, tails, and selected factors."""

from __future__ import annotations

import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.dfm_contract import (  # noqa: E402
    DFM_JSON_FORMAT,
    apply_owned_patch,
    derived_projection,
    normalize_dfm_method,
    owned_projection,
    recalculate_dfm_method,
    selected_development_factors,
)
from arcrho_api.dfm_curves import (  # noqa: E402
    CURVE_KINDS,
    FIT_OK,
    curves_tab_is_default,
    curves_table,
    default_curves_tab,
    fit_curves,
    normalize_curves_tab,
)

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "dfm_curves_resq_c12.json").read_text("utf-8"))


def _tab(**overrides) -> dict:
    tab = default_curves_tab(len(FIXTURE["initial_selection"]), FIXTURE["initial_selection"])
    tab["included"] = list(FIXTURE["all_included"]["included"])
    tab.update(overrides)
    return tab


class ResqCurveFitParityTests(unittest.TestCase):
    def test_log_regression_fits_match_resq_parameters_and_r_squared(self) -> None:
        fits = fit_curves(FIXTURE["initial_selection"], FIXTURE["all_included"]["included"])
        for kind in CURVE_KINDS:
            expected = FIXTURE["all_included"]["fits"][kind]
            self.assertEqual(fits[kind]["result"], FIT_OK)
            for key in ("a", "b", "c", "r_squared"):
                self.assertAlmostEqual(fits[kind][key], expected[key], places=9, msg=f"{kind}.{key}")

    def test_fitted_values_cover_observed_and_future_periods(self) -> None:
        table = curves_table(FIXTURE["initial_selection"], FIXTURE["initial_tail"], _tab(future_development_periods=3))
        for column in table["columns"]:
            if column["column_type"] != "curve":
                continue
            expected = FIXTURE["all_included"]["values"][column["key"]]
            for got, want in zip([*column["values"], *column["future"]], expected):
                self.assertAlmostEqual(got, want, places=9, msg=column["key"])

    def test_tail_is_the_product_of_the_future_periods(self) -> None:
        for periods, key in ((1, "tail_one_future_period"), (3, "tail_three_future_periods")):
            table = curves_table(
                FIXTURE["initial_selection"], FIXTURE["initial_tail"], _tab(future_development_periods=periods)
            )
            for column in table["columns"]:
                if column["column_type"] == "curve":
                    self.assertAlmostEqual(column["tail"], FIXTURE["all_included"][key][column["key"]], places=6)
        initial = table["columns"][0]
        self.assertEqual(initial["tail"], FIXTURE["initial_tail"])
        self.assertEqual(initial["future"], [FIXTURE["initial_tail"], 1.0, 1.0])
        # Running the tail off along the inverse power curve: the first future
        # row still holds the whole tail, the last only its own factor.
        table = curves_table(
            FIXTURE["initial_selection"],
            FIXTURE["initial_tail"],
            _tab(future_development_periods=3, selected_tail_factor=3, selected_tail_curve=3),
        )
        inverse = FIXTURE["all_included"]["values"]["inverse_power"][9:12]
        self.assertAlmostEqual(table["tail_rows"][0]["cumulative_value"], inverse[0] * inverse[1] * inverse[2], places=9)
        self.assertAlmostEqual(table["tail_rows"][1]["cumulative_value"], inverse[1] * inverse[2], places=9)
        self.assertAlmostEqual(table["tail_rows"][2]["cumulative_value"], inverse[2], places=9)
        self.assertGreater(table["tail_rows"][0]["incremental_percentage"], 0)

    def test_excluded_periods_refit_the_curves(self) -> None:
        case = FIXTURE["periods_5_and_7_excluded"]
        fits = fit_curves(FIXTURE["initial_selection"], case["included"])
        for kind in CURVE_KINDS:
            for key in ("a", "b", "r_squared"):
                self.assertAlmostEqual(fits[kind][key], case["fits"][kind][key], places=9, msg=f"{kind}.{key}")
        table = curves_table(FIXTURE["initial_selection"], FIXTURE["initial_tail"], _tab(included=case["included"]))
        exponential = table["columns"][1]
        for got, want in zip([*exponential["values"], *exponential["future"]], case["exponential_decay_values"]):
            self.assertAlmostEqual(got, want, places=9)

    def test_free_fit_c_searches_the_inverse_power_offset(self) -> None:
        case = FIXTURE["periods_5_and_7_excluded_free_fit_c"]
        fits = fit_curves(FIXTURE["initial_selection"], case["included"], free_fit_c=True)
        for key in ("a", "b", "c", "r_squared"):
            self.assertAlmostEqual(fits["inverse_power"][key], case["inverse_power"][key], places=6, msg=key)
        table = curves_table(
            FIXTURE["initial_selection"],
            FIXTURE["initial_tail"],
            _tab(included=case["included"], free_fit_c=True),
        )
        inverse = table["columns"][2]
        for got, want in zip([*inverse["values"], *inverse["future"]], case["inverse_power_values"]):
            self.assertAlmostEqual(got, want, places=6)

    def test_selected_values_chain_into_cumulative_and_percentages(self) -> None:
        table = curves_table(FIXTURE["initial_selection"], FIXTURE["initial_tail"], _tab())
        self.assertEqual(table["selected_tail"], FIXTURE["initial_tail"])
        for got, want in zip(table["cumulative"], FIXTURE["all_included"]["cumulative"]):
            self.assertAlmostEqual(got, want, places=9)
        for got, want in zip(table["cumulative_percentage"], FIXTURE["all_included"]["cumulative_percentage"]):
            self.assertAlmostEqual(got, want, places=9)
        # The tail row's increment is everything still to come after the last observed period.
        self.assertAlmostEqual(table["incremental_percentage"][-1], 1 - FIXTURE["all_included"]["cumulative_percentage"][-2])
        self.assertAlmostEqual(table["incremental_percentage"][1], 0.5124670805604947 - 0.0222588333029783)

    def test_a_curve_selection_and_a_user_column_feed_the_selected_values(self) -> None:
        tab = _tab(
            selected_estimates=[1, 1, 2, 1, 1, 1, 1, 1, 6],
            selected_tail_factor=3,
            user_columns=[{"label": "Aug 2024", "column_type": "prior_analysis", "values": [1.5] * 9, "tail": 1.0017}],
        )
        table = curves_table(FIXTURE["initial_selection"], FIXTURE["initial_tail"], tab)
        self.assertAlmostEqual(table["selected_values"][2], FIXTURE["all_included"]["values"]["exponential_decay"][2])
        self.assertEqual(table["selected_values"][8], 1.5)
        self.assertAlmostEqual(table["selected_tail"], FIXTURE["all_included"]["tail_one_future_period"]["inverse_power"])
        self.assertEqual(table["selected_tail_column"], 3)
        self.assertEqual(table["columns"][5]["label"], "Aug 2024")

    def test_ratios_outside_the_thresholds_start_excluded(self) -> None:
        tab = default_curves_tab(4, [2.5, 1.2, 1.0, 1.00001])
        self.assertEqual(tab["included"], [0, 1, 0, 1])
        # A stored flag wins; a period the stored flags do not reach starts on the default.
        normalized = normalize_curves_tab({"included": [1, 0]}, 4, [2.5, 1.2, 1.0, 1.00001])
        self.assertEqual(normalized["included"], [1, 0, 0, 1])
        self.assertTrue(curves_tab_is_default({}, [2.5, 1.2]))
        self.assertFalse(curves_tab_is_default({"future_development_periods": 3}, [2.5, 1.2]))


def _payload(curves_tab: dict | None = None) -> dict:
    payload = {
        "json_format": DFM_JSON_FORMAT,
        "details_tab": {
            "name": "Paid DFM",
            "output_type": "Paid Ultimate",
            "output_dataset": "Paid Selected",
            "input_triangle": "Paid Loss",
            "origin_length": 12,
            "development_length": 12,
            "decimal_places": 4,
        },
        "ratios_tab": {
            "ratio_triangle": {"excluded": [[0, 0], [0], []]},
            "average_formulas": {
                "label": ["Volume - all", "User Entry"],
                "custom_average_formula_settings": {
                    "average_type": ["custom", "user_entry"],
                    "base": ["volume", "simple"],
                    "periods": ["all", "all"],
                    "exclude": [0, 0],
                },
                "selected": [[1, 1, 0], [0, 0, 1]],
                "values": [[1, 1, 1], [1.2, 1.1, 1.0005]],
                "inputs": [["", "", ""], ["=1.2", "=1.1", ""]],
                "display_inputs": [["", "", ""], ["", "", ""]],
            },
            "cell_notes": {"ratio_main_table": {}, "ratio_summary_table": {}},
        },
        "results_tab": {"ratio_basis_dataset": "", "ultimate_ratio_decimal_places": 2},
        "method_metadata": {"last_modified": "owned", "data_refreshed": "old"},
    }
    if curves_tab is not None:
        payload["curves_tab"] = curves_tab
    return payload


def _input() -> dict:
    values = [[100, 150, 180], [200, 300, None], [400, None, None]]
    return {
        "name": "Paid Loss",
        "origin_labels": ["2020", "2021", "2022"],
        "development_labels": ["12m", "24m", "36m"],
        "values": values,
        "mask": [[value is not None for value in row] for row in values],
        "data_format": "Triangle",
        "number_format": "#,##0",
        "decimal_places": 0,
        "revision": "sha256:input",
    }


class DfmContractCurvesTests(unittest.TestCase):
    def test_a_user_entry_tail_factor_survives_recalculation_and_reaches_the_ultimate(self) -> None:
        method = recalculate_dfm_method(_payload(), input_snapshot=_input())
        values = method["ratios_tab"]["average_formulas"]["values"]
        self.assertEqual(values[0][2], 1.0)
        self.assertEqual(values[1][2], 1.0005)
        self.assertEqual(method["curves_tab"]["selected_values"], [1.5, 1.2, 1.0005])
        self.assertEqual(selected_development_factors(method), [1.5, 1.2, 1.0005])
        # 2022 sits at 12m: 400 * 1.5 * 1.2 * 1.0005.
        self.assertAlmostEqual(method["results_tab"]["ultimate_vector"][2], 400 * 1.5 * 1.2 * 1.0005, places=4)
        self.assertAlmostEqual(method["results_tab"]["ultimate_vector"][0], 180 * 1.0005, places=4)

    def test_a_method_without_a_curves_tab_normalizes_to_the_default_tab_and_keeps_its_fingerprints(self) -> None:
        method = recalculate_dfm_method(_payload(), input_snapshot=_input())
        self.assertEqual(method["curves_tab"]["selected_estimates"], [1, 1])
        self.assertEqual(method["curves_tab"]["included"], [1, 1])
        self.assertNotIn("curves", owned_projection(method))
        self.assertNotIn("curves_selected_values", derived_projection(method))
        stored = deepcopy(method)
        stored.pop("curves_tab")
        reopened = normalize_dfm_method(stored, require_complete=True)
        self.assertEqual(reopened["method_metadata"]["owned_revision"], method["method_metadata"]["owned_revision"])
        self.assertEqual(reopened["method_metadata"]["derived_revision"], method["method_metadata"]["derived_revision"])

    def test_a_curve_selection_changes_the_chain_the_ultimate_uses(self) -> None:
        base = recalculate_dfm_method(_payload(), input_snapshot=_input())
        patched = apply_owned_patch(
            base,
            {"curves_tab": {"selected_estimates": [1, 2], "selected_tail_factor": 2, "future_development_periods": 2}},
        )
        self.assertNotEqual(patched["method_metadata"]["owned_revision"], base["method_metadata"]["owned_revision"])
        self.assertIn("curves", owned_projection(patched))
        chain = patched["curves_tab"]["selected_values"]
        self.assertEqual(chain[0], 1.5)
        # Two included points are fitted exactly, so the curve reproduces the
        # second factor; the tail is now the curve's two-period run-off.
        table = curves_table([1.5, 1.2], 1.0005, patched["curves_tab"])
        self.assertAlmostEqual(chain[1], table["columns"][1]["values"][1], places=6)
        self.assertAlmostEqual(chain[2], table["columns"][1]["tail"], places=6)
        self.assertNotEqual(chain[2], 1.0005)
        self.assertAlmostEqual(
            patched["results_tab"]["ultimate_vector"][2], 400 * chain[0] * chain[1] * chain[2], places=2
        )
        # The stored tab round-trips through a strict reopen with the fingerprints it was saved with.
        reopened = normalize_dfm_method(deepcopy(patched), require_complete=True)
        self.assertEqual(reopened["curves_tab"], patched["curves_tab"])

    def test_a_user_column_is_stored_and_refitted_to_the_period_count(self) -> None:
        tab = {
            "user_columns": [{"label": "Prior", "column_type": "prior_analysis", "values": [1.4, 1.1, 1.0], "tail": 1.02}],
            "selected_estimates": [6, 6, 6],
            "selected_tail_factor": 6,
        }
        method = recalculate_dfm_method(_payload(tab), input_snapshot=_input())
        column = method["curves_tab"]["user_columns"][0]
        self.assertEqual(column["values"], [1.4, 1.1])
        self.assertEqual(method["curves_tab"]["selected_values"], [1.4, 1.1, 1.02])


if __name__ == "__main__":
    unittest.main()
