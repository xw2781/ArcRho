from __future__ import annotations

import json
import math
import sys
import unittest
from copy import deepcopy
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.cape_cod_contract import (  # noqa: E402
    CC_DERIVED_COLUMNS,
    CC_JSON_FORMAT,
    CapeCodContractError,
    apply_owned_patch,
    build_cape_cod_output_sidecar,
    cape_cod_output_variants,
    cape_cod_precedent_names,
    cape_cod_ultimates_triangle,
    fit_cape_cod_trend_rate,
    method_revisions,
    normalize_cape_cod_method,
    recalculate_cape_cod_method,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "resq_cape_cod_d53.json").read_text(
        encoding="utf-8"
    )
)

# The fixture captures raw ResQ COM output at full float precision.  The
# contract re-derives every column from raw inputs but canonicalizes persisted
# numbers with the ArcRho-wide six-decimal ``canonical_number`` policy (rates
# keep eight decimals), so parity against raw ResQ values is bounded by that
# rounding and its cascade — not by the formulas, which were verified to
# ~1e-15 before canonicalization (see docs/plans/cape_cod_method_plan.md).
CANONICAL_TOL = 2e-6


def within_canonical(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= CANONICAL_TOL * max(1.0, abs(expected))


def owned_payload() -> dict:
    method = FIXTURE["method"]
    return {
        "json_format": CC_JSON_FORMAT,
        "details_tab": {
            "name": method["name"],
            "method_type": "Cape Cod",
            "output_type": method["name"],
            "dataset_category": "D Gross Loss",
            "origin_length": method["origin_length"],
            "statistic_decimal_places": method["decimal_places"],
        },
        "method_tab": {
            "latest_dataset": method["latest_dataset"],
            "exposure_dataset": method["exposure_dataset"],
            "prior_ultimate_dataset": method["prior_ultimate_dataset"],
            "prior_ultimate_mode": "latest_ultimates",
            "trend_rate": 0,
            "auto_trend_fit": method["auto_trend_fit"],
            "decay_factor": method["decay_factor"],
            "scaling_type": "percentage",
            "alternative_ultimate_calculation": method["alternative_ultimate_calculation"],
            "trend_factor_overrides": [],
            "origin_labels": list(FIXTURE["origin_labels"]),
        },
        "ultimates_tab": {},
        "ratios_tab": {},
        "audit_log_tab": {},
        "method_metadata": {
            "last_modified": "2026-01-01T00:00:00Z",
            "data_refreshed": "2026-01-01T00:00:00Z",
        },
    }


def snapshots() -> dict:
    labels = list(FIXTURE["origin_labels"])
    return {
        "latest": {
            "name": FIXTURE["method"]["latest_dataset"],
            "origin_labels": labels,
            "values": deepcopy(FIXTURE["latest_triangle"]),
        },
        "exposure": {
            "name": FIXTURE["method"]["exposure_dataset"],
            "origin_labels": labels,
            "values": list(FIXTURE["exposure_values"]),
        },
        "prior_ultimate": {
            "name": FIXTURE["method"]["prior_ultimate_dataset"],
            "origin_labels": labels,
            "values": list(FIXTURE["prior_ultimate_values"]),
        },
    }


def complete_method() -> dict:
    return recalculate_cape_cod_method(
        owned_payload(), source_snapshots=snapshots(), timestamp="2026-01-02T00:00:00Z"
    )


def assert_close(
    test: unittest.TestCase,
    actual: list,
    expected: list,
    label: str,
    scales: list | None = None,
) -> None:
    test.assertEqual(len(actual), len(expected), label)
    for index, (left, right) in enumerate(zip(actual, expected)):
        if right is None:
            test.assertIsNone(left, f"{label}[{index}]")
            continue
        test.assertIsNotNone(left, f"{label}[{index}]")
        scale = abs(float(scales[index])) if scales is not None else abs(float(right))
        test.assertLessEqual(
            abs(float(left) - float(right)),
            CANONICAL_TOL * max(1.0, scale),
            f"{label}[{index}]: {left!r} != {right!r}",
        )


class CapeCodResqParityTests(unittest.TestCase):
    """Every derived value must reproduce the ResQ COM output for D 53."""

    def test_recalculate_reproduces_every_resq_method_tab_column(self) -> None:
        method = complete_method()
        tab = method["method_tab"]

        assert_close(self, tab["latest_values"], FIXTURE["latest_values"], "latest_values")
        assert_close(self, tab["exposure_values"], FIXTURE["exposure_values"], "exposure_values")
        expected = FIXTURE["expected"]
        for key in (
            "trend_factors",
            "trended_latest_values",
            "percentage_developed",
            "developed_exposure_values",
            "trended_developed_ratios",
            "expected_ultimate_ratios",
            "detrended_expected_ratios",
            "cape_cod_ultimate",
            "cape_cod_ultimate_ratios",
        ):
            assert_close(self, tab[key], expected[key], key)
        # Future exposure/latest are differences of exposure-scale values, so
        # the six-decimal percentage canonicalization bounds their absolute
        # error at CANONICAL_TOL of the exposure scale, not of the difference.
        for key in ("future_exposure_values", "future_latest_values"):
            assert_close(self, tab[key], expected[key], key, scales=FIXTURE["exposure_values"])
        for index, factor in enumerate(tab["development_factors"]):
            inverse = 1.0 / float(FIXTURE["expected"]["percentage_developed"][index])
            self.assertTrue(within_canonical(float(factor), inverse))

    def test_auto_fit_reproduces_resq_fitted_trend_rate(self) -> None:
        method = complete_method()
        fitted = float(method["method_tab"]["trend_rate"])
        expected = float(FIXTURE["method"]["trend_rate"])
        # Displayed as a percentage with six decimals, so require agreement
        # to the stored eight-decimal rate within one quantum plus the
        # six-decimal input-canonicalization cascade.
        self.assertLessEqual(abs(fitted - expected), 1e-7)

    def test_fit_trend_rate_matches_resq_fit(self) -> None:
        developed = [
            float(FIXTURE["exposure_values"][i]) * float(FIXTURE["expected"]["percentage_developed"][i])
            for i in range(len(FIXTURE["origin_labels"]))
        ]
        fitted = float(fit_cape_cod_trend_rate(FIXTURE["latest_values"], developed))
        expected = float(FIXTURE["method"]["trend_rate"])
        # Full-precision inputs: only the eight-decimal rate quantum applies.
        self.assertLessEqual(abs(fitted - expected), 5.1e-9)

    def test_ultimates_triangle_matches_resq_at_every_stored_cell(self) -> None:
        method = complete_method()
        triangle = cape_cod_ultimates_triangle(method, FIXTURE["latest_triangle"])
        expected = FIXTURE["expected_ultimates_triangle"]
        self.assertEqual([len(row) for row in triangle], [len(row) for row in expected])
        for row_index, (row, expected_row) in enumerate(zip(triangle, expected)):
            assert_close(self, row, expected_row, f"ultimates_triangle[{row_index}]")


class CapeCodContractTests(unittest.TestCase):
    def test_normalized_method_carries_identity_and_revisions(self) -> None:
        method = complete_method()

        self.assertEqual(method["json_format"], CC_JSON_FORMAT)
        self.assertEqual(method["details_tab"]["method_type"], "Cape Cod")
        self.assertEqual(method["method_metadata"]["source_kind"], "cape_cod")
        self.assertEqual(method_revisions(method), {
            key: method["method_metadata"][key]
            for key in ("owned_revision", "derived_revision", "publication_revision")
        })
        self.assertEqual(
            cape_cod_precedent_names(method),
            [
                FIXTURE["method"]["latest_dataset"],
                FIXTURE["method"]["exposure_dataset"],
                FIXTURE["method"]["prior_ultimate_dataset"],
            ],
        )

    def test_revisions_ignore_timestamps(self) -> None:
        first = complete_method()
        second = recalculate_cape_cod_method(
            owned_payload(), source_snapshots=snapshots(), timestamp="2030-12-31T00:00:00Z"
        )

        self.assertNotEqual(
            first["method_metadata"]["data_refreshed"],
            second["method_metadata"]["data_refreshed"],
        )
        self.assertEqual(method_revisions(first), method_revisions(second))

    def test_normalize_rejects_unsupported_and_tampered_payloads(self) -> None:
        method = complete_method()
        for marker in (None, "arcrho-cape-cod-method-by-tab-v0"):
            candidate = deepcopy(method)
            if marker is None:
                candidate.pop("json_format")
            else:
                candidate["json_format"] = marker
            with self.subTest(marker=marker):
                with self.assertRaises(CapeCodContractError):
                    normalize_cape_cod_method(candidate)

        for key in ("latest_values", "cape_cod_ultimate", "expected_ultimate_ratios"):
            candidate = deepcopy(method)
            candidate["method_tab"][key] = candidate["method_tab"][key][:-1]
            with self.subTest(key=key):
                with self.assertRaises(CapeCodContractError):
                    normalize_cape_cod_method(candidate)

        tampered = deepcopy(method)
        tampered["method_tab"]["cape_cod_ultimate"][0] = 1.0
        with self.assertRaises(CapeCodContractError):
            normalize_cape_cod_method(tampered)

    def test_manual_trend_rate_and_overrides(self) -> None:
        payload = owned_payload()
        payload["method_tab"]["auto_trend_fit"] = False
        payload["method_tab"]["trend_rate"] = 0.05
        method = recalculate_cape_cod_method(payload, source_snapshots=snapshots())
        tab = method["method_tab"]
        self.assertEqual(tab["trend_rate"], 0.05)
        count = len(tab["origin_labels"])
        for index, factor in enumerate(tab["trend_factors"]):
            self.assertTrue(within_canonical(float(factor), 1.05 ** (count - 1 - index)))

        overridden = deepcopy(method)
        overridden["method_tab"]["trend_factor_overrides"][0] = 2.0
        recalculated = recalculate_cape_cod_method(overridden)
        self.assertEqual(recalculated["method_tab"]["trend_factors"][0], 2)
        self.assertEqual(
            recalculated["method_tab"]["trended_latest_values"][0],
            recalculated["method_tab"]["latest_values"][0] * 2,
        )

    def test_auto_fit_clears_trend_factor_overrides(self) -> None:
        method = complete_method()
        tampered = deepcopy(method)
        tampered["method_tab"]["trend_factor_overrides"] = [2.0] + [None] * (
            len(method["method_tab"]["origin_labels"]) - 1
        )
        recalculated = recalculate_cape_cod_method(tampered)
        self.assertEqual(
            recalculated["method_tab"]["trend_factor_overrides"],
            [None] * len(method["method_tab"]["origin_labels"]),
        )

    def test_alternative_ultimate_calculation_rule(self) -> None:
        payload = owned_payload()
        payload["method_tab"]["auto_trend_fit"] = False
        payload["method_tab"]["trend_rate"] = 0
        payload["method_tab"]["origin_labels"] = ["2024", "2025"]
        payload["method_tab"]["alternative_ultimate_calculation"] = True
        payload["method_tab"]["prior_ultimate_mode"] = "pattern"
        source_data = {
            "latest": {
                "name": FIXTURE["method"]["latest_dataset"],
                "origin_labels": ["2024", "2025"],
                "values": [[100, 200], [50]],
            },
            "exposure": {
                "name": FIXTURE["method"]["exposure_dataset"],
                "origin_labels": ["2024", "2025"],
                "values": [1000, 1000],
            },
            "prior_ultimate": {
                "name": FIXTURE["method"]["prior_ultimate_dataset"],
                "origin_labels": ["2024", "2025"],
                "values": [0.5, 0.0],
            },
        }
        method = recalculate_cape_cod_method(payload, source_snapshots=source_data)
        tab = method["method_tab"]
        # 2024: TDR = 200 / 500 = 0.4; EUR = 0.4 for both origins (only usable row).
        self.assertEqual(tab["percentage_developed"], [0.5, 0])
        self.assertEqual(tab["expected_ultimate_ratios"], [0.4, 0.4])
        # 2025 has latest 50, pct 0 => alternative ultimate = EUR * exposure.
        self.assertEqual(tab["cape_cod_ultimate"], [400, 400])

        payload["method_tab"]["alternative_ultimate_calculation"] = False
        method = recalculate_cape_cod_method(payload, source_snapshots=source_data)
        # Standard rule: latest + future exposure * detrended ratio.
        self.assertEqual(method["method_tab"]["cape_cod_ultimate"], [400, 450])

    def test_owned_patch_preserves_newest_snapshots(self) -> None:
        remote = complete_method()
        local = complete_method()
        local["details_tab"]["statistic_decimal_places"] = 4
        local["method_tab"]["decay_factor"] = 0.8
        remote_snapshots = snapshots()
        remote_snapshots["exposure"]["values"] = [
            value * 2 for value in FIXTURE["exposure_values"]
        ]
        remote = recalculate_cape_cod_method(remote, source_snapshots=remote_snapshots)

        rebased = apply_owned_patch(remote, local, timestamp="2026-01-03T00:00:00Z")

        self.assertEqual(rebased["details_tab"]["statistic_decimal_places"], 4)
        self.assertEqual(rebased["method_tab"]["decay_factor"], 0.8)
        assert_close(
            self,
            rebased["method_tab"]["exposure_values"],
            [value * 2 for value in FIXTURE["exposure_values"]],
            "exposure_values",
        )
        recalculated = recalculate_cape_cod_method(rebased)
        self.assertEqual(
            recalculated["method_tab"]["cape_cod_ultimate"],
            rebased["method_tab"]["cape_cod_ultimate"],
        )

    def test_output_variants_and_sidecar_use_canonical_publication(self) -> None:
        method = complete_method()
        variants = cape_cod_output_variants(method)
        self.assertEqual(list(variants), [12])
        assert_close(self, variants[12], FIXTURE["expected"]["cape_cod_ultimate"], "variant 12")

        sidecar = build_cape_cod_output_sidecar(
            method,
            project_name="NJ_Annual_Prod_202605_Fake",
            reserving_class=r"PRNJ - PA\PA\All States\Direct Group\COL",
            csv_file="D 53 - Cape Cod Gross Loss Incurred@12.csv",
            existing={"Dependents": ["Downstream"]},
            notes="CC note",
            timestamp="2026-01-02T00:00:00Z",
            user="tester",
        )
        self.assertEqual(sidecar["source_kind"], "cape_cod")
        self.assertEqual(sidecar["method_type"], "Cape Cod")
        self.assertEqual(sidecar["method_type_code"], 3)
        self.assertEqual(sidecar["data_format"], "Vector")
        self.assertEqual(sidecar["publication_revision"], method["method_metadata"]["publication_revision"])
        self.assertEqual(
            sidecar["Precedents"],
            [{"dataset_type_name": name} for name in cape_cod_precedent_names(method)],
        )
        self.assertEqual(sidecar["Dependents"], [{"dataset_type_name": "Downstream"}])

    def test_ultimates_triangle_rejects_irregular_rows(self) -> None:
        method = complete_method()
        rows = deepcopy(FIXTURE["latest_triangle"])
        rows[0] = rows[0][:-1]
        with self.assertRaises(CapeCodContractError):
            cape_cod_ultimates_triangle(method, rows)


if __name__ == "__main__":
    unittest.main()
