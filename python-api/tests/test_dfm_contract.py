from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.dfm_contract import (  # noqa: E402
    DFM_JSON_FORMAT,
    DfmContractError,
    apply_owned_patch,
    build_dfm_output_sidecar,
    canonical_number,
    dataset_reference_tokens,
    dfm_dataset_reference_tokens,
    dfm_precedent_names,
    dfm_output_variants,
    method_revisions,
    normalize_dfm_method,
    owned_projection,
    preview_dfm_method,
    recalculate_dfm_method,
    source_snapshot_revision,
)


def owned_payload() -> dict:
    return {
        "json format": DFM_JSON_FORMAT,
        "details tab": {
            "name": "Paid DFM",
            "output type": "Paid Ultimate",
            "output dataset": "Paid Selected",
            "input triangle": "Paid Loss",
            "origin length": 12,
            "development length": 12,
            "decimal places": 4,
        },
        "data tab": {},
        "ratios tab": {
            "ratio triangle": {"excluded": [[1, 0], [0], []]},
            "average formulas": {
                "label": ["Volume - all", "Simple - all", "User A", "User B", "Excel Entry"],
                "custom average formula settings": {
                    "averageType": ["custom", "custom", "user_entry", "user_entry", "user_entry"],
                    "base": ["volume", "simple", "simple", "simple", "simple"],
                    "periods": ["all", "all", "all", "all", "all"],
                    "exclude": [0, 0, 0, 0, 0],
                },
                "selected": [
                    [1, 0, 1],
                    [0, 0, 0],
                    [0, 1, 0],
                    [0, 0, 0],
                    [0, 0, 0],
                ],
                "values": [
                    [1, 1, 1],
                    [1, 1, 1],
                    [9, 9, 1],
                    [8, 8, 1],
                    [1.25, 1.3, 1],
                ],
                "inputs": [
                    ["", "", ""],
                    ["", "", ""],
                    ['="User B" * 2', '="User B" * 2', ""],
                    ['="Simple - all" * 1.1', '="Simple - all" * 1.1', ""],
                    ["='[Book.xlsx]Sheet1'!$A$1", "=1.3", ""],
                ],
                "display inputs": [
                    ["", "", ""],
                    ["", "", ""],
                    ["", "", ""],
                    ["", "", ""],
                    ["=[Premium][2025 Q4]", "", ""],
                ],
            },
            "cell notes": {
                "ratio main table": {"2020": {"(1) 12-24": "Keep"}},
                "ratio summary table": {},
            },
        },
        "results tab": {
            "ratio basis dataset": "Earned Premium",
            "ultimate ratio decimal places": 2,
        },
        "method metadata": {
            "last modified": "2026-01-01T00:00:00Z",
            "data refreshed": "2026-01-01T00:00:00Z",
        },
    }


def input_snapshot(*, values: list[list[float | None]] | None = None) -> dict:
    values = values or [[100, 150, 180], [200, 300, None], [400, None, None]]
    return {
        "name": "Paid Loss",
        "origin_labels": ["2020", "2021", "2022"],
        "development_labels": ["12m", "24m", "36m"],
        "values": values,
        "mask": [[item is not None for item in row] for row in values],
        "data_format": "Triangle",
        "number_format": "#,##0",
        "decimal_places": 0,
        "revision": "input:r1",
    }


def basis_snapshot() -> dict:
    return {
        "name": "Earned Premium",
        "origin_labels": ["2022", "2020", "2021"],
        "values": [3000, 1000, 2000],
        "data_format": "Vector",
        "number_format": "$#,##0",
        "decimal_places": 0,
        "revision": "basis:r1",
    }


class DfmContractTests(unittest.TestCase):
    def test_canonical_number_rounds_half_away_from_zero(self) -> None:
        self.assertEqual(canonical_number("1.0000005"), 1.000001)
        self.assertEqual(canonical_number("-1.0000005"), -1.000001)
        self.assertIsNone(canonical_number(float("nan")))

    def test_output_variants_share_canonical_period_aggregation(self) -> None:
        variants = dfm_output_variants({
            "details tab": {"origin length": 3},
            "data tab": {"origin labels": ["2020 Q1", "2020 Q2", "2020 Q3", "2020 Q4"]},
            "results tab": {"ultimate vector": [1, 2, 3, 4]},
        })
        self.assertEqual(variants, {3: [1, 2, 3, 4], 6: [3, 7], 12: [10]})

    def test_recalculation_builds_complete_self_contained_v2(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(),
            input_snapshot=input_snapshot(),
            ratio_basis_snapshot=basis_snapshot(),
            timestamp="2026-01-02T00:00:00Z",
        )

        self.assertEqual(method["ratios tab"]["ratio triangle"]["development labels"], [
            "(1) 12-24", "(2) 24-36", "36 - Ult",
        ])
        self.assertEqual(method["results tab"]["ratio basis values"], [1000, 2000, 3000])
        self.assertEqual(method["data tab"]["data format"], "Triangle")
        self.assertEqual(method["results tab"]["ratio basis data format"], "Vector")
        self.assertNotIn("input data triangle csv path", method["data tab"])
        self.assertNotIn("ultimate vector csv path", method["results tab"])
        self.assertEqual(method["ratios tab"]["average formulas"]["values"][4][0], 1.25)
        self.assertEqual(method["ratios tab"]["average formulas"]["values"][4][1], 1.3)
        self.assertEqual(
            method["ratios tab"]["average formulas"]["display inputs"][4][0],
            "=[Premium][2025 Q4]",
        )
        self.assertEqual(method["method metadata"]["data refreshed"], "2026-01-02T00:00:00Z")
        self.assertEqual(normalize_dfm_method(method), method)

    def test_source_revisions_and_payload_ignore_producer_timestamps(self) -> None:
        first_input = input_snapshot()
        second_input = deepcopy(first_input)
        first_input["revision"] = "frontend:2026-01-01"
        second_input["revision"] = "migration:2026-07-01"
        first_basis = basis_snapshot()
        second_basis = deepcopy(first_basis)
        first_basis["revision"] = "frontend:basis"
        second_basis["revision"] = "migration:basis"

        first = recalculate_dfm_method(
            owned_payload(),
            input_snapshot=first_input,
            ratio_basis_snapshot=first_basis,
            timestamp="same",
        )
        second = recalculate_dfm_method(
            owned_payload(),
            input_snapshot=second_input,
            ratio_basis_snapshot=second_basis,
            timestamp="same",
        )

        self.assertEqual(first, second)
        self.assertEqual(source_snapshot_revision(first_input), source_snapshot_revision(second_input))

    def test_display_inputs_are_backward_compatible_display_metadata(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot(), timestamp="same"
        )
        legacy = deepcopy(method)
        legacy["ratios tab"]["average formulas"].pop("display inputs")

        normalized_legacy = normalize_dfm_method(legacy)

        self.assertEqual(
            normalized_legacy["method metadata"]["owned revision"],
            method["method metadata"]["owned revision"],
        )
        self.assertEqual(
            normalized_legacy["ratios tab"]["average formulas"]["display inputs"],
            [["", "", ""] for _ in method["ratios tab"]["average formulas"]["label"]],
        )
        display_patch = deepcopy(method)
        display_patch["ratios tab"]["average formulas"]["display inputs"][4][0] = "=[Premium][2026 Q1]"
        patched = apply_owned_patch(method, display_patch)
        self.assertEqual(
            patched["ratios tab"]["average formulas"]["display inputs"][4][0],
            "=[Premium][2026 Q1]",
        )
        self.assertEqual(
            patched["method metadata"]["owned revision"],
            method["method metadata"]["owned revision"],
        )

    def test_output_sidecar_projection_is_canonical_and_preserves_owned_sidecar_state(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot(), timestamp="same"
        )
        existing = {
            "notes": "Method note",
            "audit_log": [{"event_date": "old", "action": "Insert", "change_info": "", "user": "a"}],
            "Dependents": ["Selected Ultimate", {"dataset_type_name": "Report"}],
            "created": "old",
            "number_format": "$#,##0",
            "show_subtotal": False,
            "producer_only": "must be removed",
        }
        first = build_dfm_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="Paid Selected@12.csv",
            existing=existing,
            timestamp="new",
            user="tester",
        )
        second = build_dfm_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="Paid Selected@12.csv",
            existing=deepcopy(existing),
            timestamp="new",
            user="tester",
        )
        self.assertEqual(first, second)
        self.assertNotIn("producer_only", first)
        self.assertEqual(
            first["Precedents"],
            [{"dataset_type_name": "Paid Loss"}, {"dataset_type_name": "Earned Premium"}],
        )
        self.assertEqual(first["notes"], "Method note")
        self.assertIs(first["show_subtotal"], False)
        self.assertEqual(first["publication_revision"], method["method metadata"]["publication revision"])

    def test_dataset_formula_inputs_are_owned_precedents_and_preserve_stored_values(self) -> None:
        payload = owned_payload()
        formulas = payload["ratios tab"]["average formulas"]
        formulas["inputs"][2][0] = '=[Accounting Cutoff][-1] * [Growth Adjustment]["2024", "12m"]'
        formulas["inputs"][2][1] = '=[accounting cutoff][1]'
        formulas["display inputs"][2][0] = "=[Display Metadata Only][2024]"

        method = recalculate_dfm_method(
            payload,
            input_snapshot=input_snapshot(),
            ratio_basis_snapshot=basis_snapshot(),
            timestamp="same",
        )

        self.assertEqual(
            dfm_precedent_names(method),
            ["Paid Loss", "Earned Premium", "Accounting Cutoff", "Growth Adjustment"],
        )
        self.assertEqual(method["ratios tab"]["average formulas"]["values"][2][:2], [9, 9])
        owned_values = owned_projection(method)["average_formulas"]["owned_values"]
        user_a = next(item for item in owned_values if item["label"] == "User A")
        self.assertEqual(user_a, {"label": "User A", "columns": [0, 1, 2], "values": [9, 9, 1.0]})
        sidecar = build_dfm_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="Paid Selected@12.csv",
            timestamp="same",
        )
        self.assertEqual(
            sidecar["Precedents"],
            [
                {"dataset_type_name": "Paid Loss"},
                {"dataset_type_name": "Earned Premium"},
                {"dataset_type_name": "Accounting Cutoff"},
                {"dataset_type_name": "Growth Adjustment"},
            ],
        )

    def test_dataset_reference_values_re_evaluate_referenced_formulas(self) -> None:
        payload = owned_payload()
        formulas = payload["ratios tab"]["average formulas"]
        formulas["inputs"][2][0] = '="User B" * [Accounting Cutoff][-1]'
        formulas["inputs"][2][1] = "=[Accounting Cutoff][1]"
        method = recalculate_dfm_method(
            payload,
            input_snapshot=input_snapshot(),
            ratio_basis_snapshot=basis_snapshot(),
            timestamp="same",
        )
        # Without resolved reference values, the stored evaluations survive.
        self.assertEqual(method["ratios tab"]["average formulas"]["values"][2][:2], [9, 9])

        tokens = dfm_dataset_reference_tokens(method)
        self.assertEqual(
            [(token["match"], token["dataset_name"], token["row_idx"], token["col_idx"]) for token in tokens],
            [
                ("[Accounting Cutoff][-1]", "Accounting Cutoff", "-1", None),
                ("[Accounting Cutoff][1]", "Accounting Cutoff", "1", None),
            ],
        )
        self.assertEqual(
            dataset_reference_tokens('=[Quoted]["2024 Q1", \'12, months\']')[0]["col_idx"],
            "'12, months'",
        )

        refreshed = recalculate_dfm_method(
            method,
            dataset_reference_values={
                "[Accounting Cutoff][-1]": 1.02,
                "[Accounting Cutoff][1]": 1.5,
            },
            timestamp="later",
        )
        values = refreshed["ratios tab"]["average formulas"]["values"]
        # "User B" col 0 = Simple-all (1.5) * 1.1 = 1.65; User A = 1.65 * 1.02.
        self.assertEqual(values[2][0], 1.683)
        self.assertEqual(values[2][1], 1.5)

        # A partial mapping keeps the stored evaluation for the missing reference.
        partial = recalculate_dfm_method(
            method,
            dataset_reference_values={"[Accounting Cutoff][1]": 1.5},
            timestamp="later",
        )
        partial_values = partial["ratios tab"]["average formulas"]["values"]
        self.assertEqual(partial_values[2][0], 9)
        self.assertEqual(partial_values[2][1], 1.5)

    def test_formulas_with_whitespace_after_equals_still_re_evaluate(self) -> None:
        # The UI stores user-entry formulas as "= expr" with a space after the
        # equals sign; stripping the "=" must not leave leading whitespace that
        # makes ast.parse fail and silently keep the stored evaluation.
        payload = owned_payload()
        formulas = payload["ratios tab"]["average formulas"]
        formulas["inputs"][2][0] = '= "User B" * [Accounting Cutoff][-1]'
        formulas["inputs"][3][0] = '= "Simple - all" * 1.1'
        method = recalculate_dfm_method(
            payload,
            input_snapshot=input_snapshot(),
            ratio_basis_snapshot=basis_snapshot(),
            timestamp="same",
        )
        # The internal formula re-evaluates even without reference values.
        self.assertEqual(method["ratios tab"]["average formulas"]["values"][3][0], 1.65)

        refreshed = recalculate_dfm_method(
            method,
            dataset_reference_values={"[Accounting Cutoff][-1]": 1.02},
            timestamp="later",
        )
        values = refreshed["ratios tab"]["average formulas"]["values"]
        # User A col 0 = User B (1.65) * resolved cutoff 1.02.
        self.assertEqual(values[2][0], 1.683)

    def test_upstream_refresh_preserves_owned_projection_and_recalculates_internal_formulas(self) -> None:
        initial = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        refreshed_snapshot = input_snapshot(values=[[100, 200, 260], [200, 400, None], [400, None, None]])
        refreshed_snapshot["revision"] = "input:r2"
        refreshed = recalculate_dfm_method(initial, input_snapshot=refreshed_snapshot)

        self.assertEqual(owned_projection(refreshed), owned_projection(initial))
        self.assertEqual(
            refreshed["method metadata"]["owned revision"],
            initial["method metadata"]["owned revision"],
        )
        formulas = refreshed["ratios tab"]["average formulas"]["values"]
        self.assertEqual(formulas[3][0], 2.2)
        self.assertEqual(formulas[2][0], 4.4)
        self.assertEqual(formulas[4][0], 1.25)
        self.assertNotEqual(
            refreshed["method metadata"]["derived revision"],
            initial["method metadata"]["derived revision"],
        )

    def test_unsupported_benchmark_rows_are_frozen_instead_of_recomputed_as_simple(self) -> None:
        payload = owned_payload()
        formulas = payload["ratios tab"]["average formulas"]
        formulas["label"].insert(2, "Benchmark")
        settings = formulas["custom average formula settings"]
        settings["averageType"].insert(2, "custom")
        settings["base"].insert(2, "benchmark")
        settings["periods"].insert(2, "all")
        settings["exclude"].insert(2, 0)
        formulas["selected"].insert(2, [0, 0, 0])
        formulas["values"].insert(2, [1.7, 1.6, 1.0])
        formulas["inputs"].insert(2, ["", "", ""])
        initial = recalculate_dfm_method(
            payload, input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        refreshed = recalculate_dfm_method(
            initial,
            input_snapshot=input_snapshot(values=[[100, 300, 600], [200, 500, None], [400, None, None]]),
        )
        benchmark_row = refreshed["ratios tab"]["average formulas"]["label"].index("Benchmark")
        self.assertEqual(
            refreshed["ratios tab"]["average formulas"]["values"][benchmark_row],
            [1.7, 1.6, 1.0],
        )
        self.assertEqual(
            refreshed["ratios tab"]["average formulas"]["custom average formula settings"]["base"][benchmark_row],
            "benchmark",
        )

    def test_preview_preserves_refresh_timestamp(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot(), timestamp="old"
        )
        preview_snapshot = input_snapshot(values=[[100, 160, 180], [200, 300, None], [400, None, None]])
        preview = preview_dfm_method(
            method,
            input_snapshot=preview_snapshot,
            ratio_basis_snapshot=basis_snapshot(),
            timestamp="new",
        )
        self.assertEqual(preview["method metadata"]["data refreshed"], "old")

    def test_rejects_geometry_and_ambiguous_or_missing_basis_labels(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        changed = input_snapshot()
        changed["development_labels"] = ["12m", "36m"]
        changed["values"] = [[100, 180], [200, None], [400, None]]
        changed["mask"] = [[True, True], [True, False], [True, False]]
        with self.assertRaisesRegex(DfmContractError, "geometry changed"):
            recalculate_dfm_method(method, input_snapshot=changed)

        duplicate = basis_snapshot()
        duplicate["origin_labels"] = ["2020", "2020", "2022"]
        with self.assertRaisesRegex(DfmContractError, "duplicate origin"):
            recalculate_dfm_method(method, ratio_basis_snapshot=duplicate)

        missing = basis_snapshot()
        missing["origin_labels"] = ["2020", "2022"]
        missing["values"] = [1000, 3000]
        with self.assertRaisesRegex(DfmContractError, "missing exact origin"):
            recalculate_dfm_method(method, ratio_basis_snapshot=missing)

    def test_complete_normalization_rejects_stale_revision_metadata(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        edited = deepcopy(method)
        edited["results tab"]["ultimate vector"][0] = 999
        with self.assertRaisesRegex(DfmContractError, "revision"):
            normalize_dfm_method(edited)
        self.assertEqual(method_revisions(method)["publication revision"], method["method metadata"]["publication revision"])

    def test_publication_revision_includes_period_and_sidecar_formatting(self) -> None:
        method = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        patch_payload = deepcopy(method)
        patch_payload["details tab"]["origin length"] = 6
        changed_period = apply_owned_patch(method, patch_payload)
        self.assertNotEqual(
            changed_period["method metadata"]["publication revision"],
            method["method metadata"]["publication revision"],
        )

        patch_payload = deepcopy(method)
        patch_payload["details tab"]["decimal places"] = 3
        changed_format = apply_owned_patch(method, patch_payload)
        self.assertNotEqual(
            changed_format["method metadata"]["publication revision"],
            method["method metadata"]["publication revision"],
        )

    def test_owned_exclusion_patch_rebases_by_exact_labels(self) -> None:
        initial = recalculate_dfm_method(
            owned_payload(), input_snapshot=input_snapshot(), ratio_basis_snapshot=basis_snapshot()
        )
        upstream = input_snapshot(values=[[50, 75, 90], [200, 300, None], [100, 150, 180], [400, None, None]])
        upstream["origin_labels"] = ["2019", "2021", "2020", "2022"]
        upstream["revision"] = "input:r2"
        upstream_basis = {
            **basis_snapshot(),
            "origin_labels": ["2019", "2021", "2020", "2022"],
            "values": [500, 2000, 1000, 3000],
            "revision": "basis:r2",
        }
        refreshed = recalculate_dfm_method(
            initial,
            input_snapshot=upstream,
            ratio_basis_snapshot=upstream_basis,
        )
        stale_patch = deepcopy(initial)
        stale_patch["ratios tab"]["ratio triangle"]["excluded"][0][0] = 0
        stale_patch["ratios tab"]["ratio triangle"]["excluded"][1][0] = 1

        rebased = apply_owned_patch(refreshed, stale_patch, timestamp="save")
        ratio = rebased["ratios tab"]["ratio triangle"]
        rows = dict(zip(ratio["origin labels"], ratio["excluded"]))
        self.assertEqual(rows["2019"], [0, 0])
        self.assertEqual(rows["2020"][0], 0)
        self.assertEqual(rows["2021"][0], 1)

        case_mismatch = basis_snapshot()
        case_mismatch["origin_labels"] = ["2020", "2021", "2022 "]
        with self.assertRaisesRegex(DfmContractError, "missing exact origin"):
            recalculate_dfm_method(initial, ratio_basis_snapshot=case_mismatch)


if __name__ == "__main__":
    unittest.main()
