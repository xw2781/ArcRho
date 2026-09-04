from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.bornhuetter_ferguson_contract import (  # noqa: E402
    BF_JSON_FORMAT,
    BornhuetterFergusonContractError,
    apply_owned_patch,
    bornhuetter_ferguson_output_variants,
    bornhuetter_ferguson_precedent_names,
    build_bornhuetter_ferguson_output_sidecar,
    method_revisions,
    normalize_bornhuetter_ferguson_method,
    recalculate_bornhuetter_ferguson_method,
)


def owned_payload(*, origin_length: int = 12) -> dict:
    return {
        "json_format": BF_JSON_FORMAT,
        "details_tab": {
            "name": "BF Ultimate",
            "method_type": "Bornhuetter Ferguson",
            "output_type": "Ultimate Loss",
            "dataset_category": "Loss",
            "origin_length": origin_length,
            "statistic_decimal_places": 1,
        },
        "method_tab": {
            "latest_dataset": "Paid Loss",
            "dfm_dataset": "Paid DFM Ultimate",
            "show_weights": True,
            "show_effective_weights": True,
            "prior_datasets": [
                {"name": "Plan A", "values": [], "weights": [1, 0, 2, 1]},
                {"name": "Plan B", "values": [], "weights": [1, 1, 0, 3]},
            ],
            "origin_labels": ["2020", "2021", "2022", "2023"],
            "latest_values": [],
            "dfm_ultimate_values": [],
            "percentage_developed": [],
            "selected_prior_values": [],
            "new_ultimate": [],
        },
        "chart_tab": {},
        "audit_log_tab": {},
        "method_metadata": {
            "last_modified": "2026-01-01T00:00:00Z",
            "data_refreshed": "2026-01-01T00:00:00Z",
        },
    }


def snapshots(*, latest_values: list[int] | None = None) -> dict:
    labels = ["2020", "2021", "2022", "2023"]
    latest = latest_values or [100, 200, 300, 400]
    return {
        "latest": {
            "name": "Paid Loss",
            "origin_labels": labels,
            "values": [[1, value] for value in latest],
            "mask": [[True, True] for _ in latest],
            "path": r"Z:\producer-local\Paid Loss.csv",
        },
        "dfm": {
            "name": "Paid DFM Ultimate",
            "origin_labels": list(reversed(labels)),
            "values": list(reversed([200, 400, 600, 800])),
            "percentage_developed": list(reversed([0.5, 0.5, 0.5, 0.5])),
        },
        "priors": [
            {"name": "Plan A", "origin_labels": labels, "values": [300, 500, 700, 900]},
            {"name": "Plan B", "origin_labels": labels, "values": [500, 700, 900, 1100]},
        ],
    }


def complete_method(**kwargs) -> dict:
    return recalculate_bornhuetter_ferguson_method(
        owned_payload(), source_snapshots=snapshots(**kwargs), timestamp="2026-01-02T00:00:00Z"
    )


class BornhuetterFergusonContractTests(unittest.TestCase):
    def test_recalculate_embeds_sources_calculations_display_mode_and_revisions(self) -> None:
        method = complete_method()

        self.assertEqual(method["json_format"], BF_JSON_FORMAT)
        self.assertTrue(method["method_tab"]["show_effective_weights"])
        self.assertEqual(method["method_tab"]["latest_values"], [100, 200, 300, 400])
        self.assertEqual(method["method_tab"]["dfm_ultimate_values"], [200, 400, 600, 800])
        self.assertEqual(method["method_tab"]["percentage_developed"], [0.5] * 4)
        self.assertEqual(method["method_tab"]["selected_prior_values"], [400, 700, 700, 1050])
        self.assertEqual(method["method_tab"]["new_ultimate"], [300, 550, 650, 925])
        self.assertEqual(method_revisions(method), {
            key: method["method_metadata"][key]
            for key in ("owned_revision", "derived_revision", "publication_revision")
        })
        self.assertEqual(
            bornhuetter_ferguson_precedent_names(method),
            ["Paid Loss", "Paid DFM Ultimate", "Plan A", "Plan B"],
        )

    def test_revisions_ignore_timestamps_and_producer_local_paths(self) -> None:
        first = complete_method()
        second_snapshots = snapshots()
        second_snapshots["latest"]["path"] = r"\\server\share\Paid Loss.csv"
        second = recalculate_bornhuetter_ferguson_method(
            owned_payload(),
            source_snapshots=second_snapshots,
            timestamp="2030-12-31T00:00:00Z",
        )

        self.assertNotEqual(
            first["method_metadata"]["data_refreshed"],
            second["method_metadata"]["data_refreshed"],
        )
        self.assertEqual(method_revisions(first), method_revisions(second))

    def test_normalize_rejects_unmarked_unsupported_and_incomplete_current_payloads(self) -> None:
        method = complete_method()
        for marker in (None, "arcrho-bornhuetter-ferguson-method-by-tab-v2"):
            candidate = deepcopy(method)
            if marker is None:
                candidate.pop("json_format")
            else:
                candidate["json_format"] = marker
            with self.subTest(marker=marker):
                with self.assertRaises(BornhuetterFergusonContractError):
                    normalize_bornhuetter_ferguson_method(candidate)

        for key, value in (
            ("latest_values", []),
            ("dfm_ultimate_values", [[200], [400], [600], [800]]),
            ("new_ultimate", [300, 550]),
        ):
            candidate = deepcopy(method)
            candidate["method_tab"][key] = value
            with self.subTest(key=key):
                with self.assertRaises(BornhuetterFergusonContractError):
                    normalize_bornhuetter_ferguson_method(candidate)

    def test_negative_new_ultimate_keeps_its_fraction(self) -> None:
        payload = owned_payload()
        payload["method_tab"]["origin_labels"] = ["2020"]
        payload["method_tab"]["prior_datasets"] = [
            {"name": "Plan A", "values": [], "weights": [1]}
        ]
        source_data = {
            "latest": {"name": "Paid Loss", "origin_labels": ["2020"], "values": [1]},
            "dfm": {
                "name": "Paid DFM Ultimate",
                "origin_labels": ["2020"],
                "values": [2],
                "percentage_developed": [0.5],
            },
            "priors": [{"name": "Plan A", "origin_labels": ["2020"], "values": [-5]}],
        }

        method = recalculate_bornhuetter_ferguson_method(payload, source_snapshots=source_data)

        self.assertEqual(method["method_tab"]["new_ultimate"], [-1.5])

    def test_new_ultimate_is_not_rounded_to_a_whole_number(self) -> None:
        """A BF ultimate keeps six decimals like every other BF vector.

        ResQ never rounds it. A claim-count BF in NJ_Annual_Prod_2026 Q3-Aug
        stored 63 and 58 for 63.014729 and 57.894588, and the Berquist-Sherman
        settlement-rate adjustment dividing closed claims by those ultimates
        moved its adjusted triangle's earliest ages by up to 2% from ResQ.
        """

        payload = owned_payload()
        payload["method_tab"]["origin_labels"] = ["2025", "2026"]
        payload["method_tab"]["prior_datasets"] = [
            {"name": "Plan A", "values": [], "weights": [1, 1]}
        ]
        source_data = {
            "latest": {"name": "Paid Loss", "origin_labels": ["2025", "2026"], "values": [55, 23]},
            "dfm": {
                "name": "Paid DFM Ultimate",
                "origin_labels": ["2025", "2026"],
                "values": [57, 45],
                "percentage_developed": [0.966342, 0.505991],
            },
            "priors": [{"name": "Plan A", "origin_labels": ["2025", "2026"], "values": [86, 81]}],
        }

        method = recalculate_bornhuetter_ferguson_method(payload, source_snapshots=source_data)

        self.assertEqual(method["method_tab"]["new_ultimate"], [57.894588, 63.014729])

    def test_percentage_developed_comes_from_the_pattern_not_the_ultimate(self) -> None:
        """A zero latest still develops: the pattern is a property of the DFM alone.

        Dividing Latest by the DFM ultimate cannot describe the newest origin,
        whose ultimate is zero whenever its latest observation is. Reading the
        percentage from the DFM's own selected factors keeps that origin usable.
        """

        payload = owned_payload()
        payload["method_tab"]["origin_labels"] = ["2020", "2021"]
        payload["method_tab"]["prior_datasets"] = [
            {"name": "Plan A", "values": [], "weights": [1, 1]}
        ]
        source_data = {
            "latest": {
                "name": "Paid Loss",
                "origin_labels": ["2020", "2021"],
                "values": [[100], [0]],
            },
            "dfm": {
                "name": "Paid DFM Ultimate",
                # Reversed so an aligned read is the only one that passes.
                "origin_labels": ["2021", "2020"],
                "values": [0, 125],
                "percentage_developed": [0.25, 0.8],
            },
            "priors": [
                {"name": "Plan A", "origin_labels": ["2020", "2021"], "values": [200, 400]}
            ],
        }

        method = recalculate_bornhuetter_ferguson_method(payload, source_snapshots=source_data)

        self.assertEqual(method["method_tab"]["percentage_developed"], [0.8, 0.25])
        self.assertEqual(method["method_tab"]["new_ultimate"], [140, 300])

    def test_dfm_revision_moves_when_only_the_pattern_changes(self) -> None:
        first = complete_method()
        moved = snapshots()
        moved["dfm"]["percentage_developed"] = [0.25, 0.25, 0.25, 0.25]
        second = recalculate_bornhuetter_ferguson_method(
            owned_payload(), source_snapshots=moved, timestamp="2026-01-02T00:00:00Z"
        )

        self.assertEqual(
            first["method_tab"]["dfm_ultimate_values"],
            second["method_tab"]["dfm_ultimate_values"],
        )
        self.assertNotEqual(
            first["method_tab"]["dfm_source_revision"],
            second["method_tab"]["dfm_source_revision"],
        )

    def test_null_submitted_weight_uses_ui_default_of_one(self) -> None:
        method = complete_method()
        method["method_tab"]["prior_datasets"][0]["weights"][0] = None

        normalized = normalize_bornhuetter_ferguson_method(method, require_complete=False)

        self.assertEqual(normalized["method_tab"]["prior_datasets"][0]["weights"][0], 1)

    def test_owned_patch_preserves_newest_snapshots_and_recalculates_weights(self) -> None:
        local = complete_method()
        remote = complete_method(latest_values=[110, 220, 330, 440])
        local["method_tab"]["prior_datasets"][0]["weights"] = [0, 0, 0, 0]

        rebased = apply_owned_patch(remote, local, timestamp="2026-01-03T00:00:00Z")

        self.assertEqual(rebased["method_tab"]["latest_values"], [110, 220, 330, 440])
        self.assertEqual(rebased["method_tab"]["prior_datasets"][0]["weights"], [0, 0, 0, 0])
        self.assertEqual(rebased["method_tab"]["selected_prior_values"], [500, 700, None, 1100])
        self.assertNotEqual(
            rebased["method_metadata"]["derived_revision"],
            local["method_metadata"]["derived_revision"],
        )

    def test_output_variants_and_sidecar_use_canonical_publication(self) -> None:
        payload = owned_payload(origin_length=3)
        payload["method_tab"]["origin_labels"] = ["2024 Q1", "2024 Q2", "2024 Q3", "2024 Q4"]
        source_data = snapshots()
        for source in [source_data["latest"], source_data["dfm"], *source_data["priors"]]:
            source["origin_labels"] = list(payload["method_tab"]["origin_labels"])
        source_data["dfm"]["values"] = [200, 400, 600, 800]
        method = recalculate_bornhuetter_ferguson_method(payload, source_snapshots=source_data)

        self.assertEqual(
            bornhuetter_ferguson_output_variants(method),
            {3: [300, 550, 650, 925], 6: [850, 1575], 12: [2425]},
        )
        sidecar = build_bornhuetter_ferguson_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="BF Ultimate@3.csv",
            existing={"dataset_category": "Old Category", "dependents": ["Downstream"]},
            notes="BF note",
            timestamp="2026-01-02T00:00:00Z",
            user="tester",
        )
        self.assertEqual(sidecar["dataset_category"], "Loss")
        self.assertEqual(sidecar["publication_revision"], method["method_metadata"]["publication_revision"])
        self.assertEqual(
            sidecar["precedents"],
            [{"dataset_name": name} for name in bornhuetter_ferguson_precedent_names(method)],
        )
        self.assertEqual(sidecar["dependents"], [{"dataset_name": "Downstream"}])


if __name__ == "__main__":
    unittest.main()
