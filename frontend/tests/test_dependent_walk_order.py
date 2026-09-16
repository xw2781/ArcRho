"""The ordered closure a dependent walk refreshes.

Every case builds a synthetic sidecar folder, so the shapes that made a
production save rewrite 26 objects 54 times can be replayed without a
project on disk.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    calculated_dataset_service,
    dataset_sidecar_status_service,
    dependent_walk_service,
    result_selection_service,
)

PROJECT = "Example Project"
RESERVING_CLASS = "Example RC"


class DependentWalkOrderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.sidecar_dir = Path(self.temp_dir.name) / "sidecars"
        self.sidecar_dir.mkdir(parents=True)
        sidecar_patch = patch.object(
            config, "get_project_dataset_sidecar_dir", return_value=str(self.sidecar_dir)
        )
        sidecar_patch.start()
        self.addCleanup(sidecar_patch.stop)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    # -- helpers ---------------------------------------------------------

    def write_sidecar(
        self,
        name: str,
        *,
        dependents: tuple = (),
        method_type: str = "",
        source_kind: str = "input",
        linked: bool = False,
    ) -> None:
        payload = {
            "dataset_name": name,
            "source_kind": source_kind,
            "dependents": dataset_sidecar_status_service.name_entries(list(dependents)),
        }
        if method_type:
            payload["method_type"] = method_type
        if linked:
            payload["internal_links"] = [{"reference": f"{name} source"}]
        path = Path(dataset_sidecar_status_service.sidecar_path(PROJECT, RESERVING_CLASS, name))
        path.write_text(json.dumps(payload), encoding="utf-8")

    def closure(self, *roots: str, dataset_type_rows: list | None = None):
        return dependent_walk_service.ordered_closure(
            PROJECT,
            RESERVING_CLASS,
            list(roots),
            dataset_type_rows=[] if dataset_type_rows is None else dataset_type_rows,
        )

    def order(self, *roots: str, dataset_type_rows: list | None = None) -> list:
        return [node.name for node in self.closure(*roots, dataset_type_rows=dataset_type_rows).nodes]

    # -- cases -----------------------------------------------------------

    def test_a_chain_is_ordered_from_the_root_down(self) -> None:
        self.write_sidecar("Paid", dependents=("D 10 - Paid DFM",))
        self.write_sidecar(
            "D 10 - Paid DFM",
            dependents=("D 20 - Paid Selected",),
            method_type=dataset_sidecar_status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
        )
        self.write_sidecar(
            "D 20 - Paid Selected",
            method_type=dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
        )

        closure = self.closure("Paid")
        self.assertEqual(
            [node.name for node in closure.nodes],
            ["Paid", "D 10 - Paid DFM", "D 20 - Paid Selected"],
        )
        self.assertEqual(
            [node.kind for node in closure.nodes],
            [
                dependent_walk_service.KIND_INPUT,
                dependent_walk_service.KIND_DFM,
                dependent_walk_service.KIND_RESULT_SELECTION,
            ],
        )
        # The saved root is crossed, never refreshed.
        self.assertEqual(
            [node.name for node in closure.refresh_order],
            ["D 10 - Paid DFM", "D 20 - Paid Selected"],
        )
        selected = closure.nodes[-1]
        self.assertEqual([closure.name_of(key) for key in selected.precedents], ["D 10 - Paid DFM"])

    def test_a_diamond_puts_the_shared_output_after_both_arms(self) -> None:
        self.write_sidecar("Paid", dependents=("Left", "Right"))
        self.write_sidecar("Left", dependents=("Ultimate",))
        self.write_sidecar("Right", dependents=("Ultimate",))
        self.write_sidecar("Ultimate")

        closure = self.closure("Paid")
        self.assertEqual(
            [node.name for node in closure.nodes], ["Paid", "Left", "Right", "Ultimate"]
        )
        ultimate = closure.nodes[-1]
        self.assertEqual(
            sorted(closure.name_of(key) for key in ultimate.precedents), ["Left", "Right"]
        )

    def test_the_traced_shape_orders_the_long_arm_before_the_short_one(self) -> None:
        """The shape that cost three passes over ``D 91`` and its descendants.

        ``D 91`` reads the saved vector directly *and* through the
        Berquist-Sherman adjustment and ``D 18``, so a walk that follows
        first-seen order rebuilds it before ``D 18`` exists.
        """
        self.write_sidecar(
            "C 92 - Paid Loss",
            dependents=("C 41 - BS Paid Adjustment", "D 91 - Current Qtr Indicated"),
        )
        self.write_sidecar(
            "C 41 - BS Paid Adjustment",
            dependents=("D 18 - BS Paid DFM",),
            method_type=dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR,
            source_kind=dataset_sidecar_status_service.SOURCE_KIND_BERQUIST_SHERMAN_SR,
        )
        self.write_sidecar(
            "D 18 - BS Paid DFM",
            dependents=("D 91 - Current Qtr Indicated",),
            method_type=dataset_sidecar_status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
        )
        self.write_sidecar(
            "D 91 - Current Qtr Indicated",
            method_type=dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
        )

        names = self.order("C 92 - Paid Loss")
        self.assertEqual(len(names), len(set(names)))
        self.assertLess(names.index("D 18 - BS Paid DFM"), names.index("D 91 - Current Qtr Indicated"))
        self.assertLess(names.index("C 41 - BS Paid Adjustment"), names.index("D 18 - BS Paid DFM"))
        self.assertLess(names.index("C 92 - Paid Loss"), names.index("C 41 - BS Paid Adjustment"))
        self.assertEqual(
            self.closure("C 92 - Paid Loss").nodes[1].kind,
            dependent_walk_service.KIND_BERQUIST_SHERMAN,
        )

    def test_a_link_cycle_visits_each_side_once(self) -> None:
        """A candidate ultimate reading the Result Selection it feeds converges."""
        self.write_sidecar("Paid", dependents=("D 91 - Selected Ultimate",))
        self.write_sidecar(
            "D 91 - Selected Ultimate",
            dependents=("C 60 - Candidate Ultimate",),
            method_type=dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
        )
        self.write_sidecar(
            "C 60 - Candidate Ultimate",
            dependents=("D 91 - Selected Ultimate",),
            linked=True,
        )

        closure = self.closure("Paid")
        names = [node.name for node in closure.nodes]
        self.assertEqual(names, ["Paid", "D 91 - Selected Ultimate", "C 60 - Candidate Ultimate"])
        self.assertEqual(
            closure.nodes[2].kind, dependent_walk_service.KIND_LINKED_INPUT
        )
        # Both directions of the ring are recorded; the pass refreshes the
        # first-seen node with what is final by then.
        self.assertEqual(
            sorted(closure.name_of(key) for key in closure.nodes[1].precedents),
            ["C 60 - Candidate Ultimate", "Paid"],
        )

    def test_a_root_with_no_dependents_is_the_whole_closure(self) -> None:
        self.write_sidecar("Paid")

        closure = self.closure("Paid")
        self.assertEqual([node.name for node in closure.nodes], ["Paid"])
        self.assertEqual(closure.refresh_order, ())

    def test_a_missing_sidecar_on_a_non_root_node_is_an_error(self) -> None:
        self.write_sidecar("Paid", dependents=("D 10 - Paid DFM",))

        with self.assertRaises(RuntimeError) as caught:
            self.closure("Paid")
        self.assertEqual(
            str(caught.exception), "Dependency graph sidecar is missing for 'D 10 - Paid DFM'."
        )

    def test_a_missing_sidecar_on_a_root_is_an_empty_closure(self) -> None:
        closure = self.closure("Paid")
        self.assertEqual([node.name for node in closure.nodes], ["Paid"])
        self.assertEqual(closure.refresh_order, ())

    def test_a_calculated_dependent_is_found_through_the_formula_graph(self) -> None:
        """The second edge source: a formula reading the saved type."""
        rows = [
            {"name": "Paid", "calculated": False, "generated": False, "formula": ""},
            {"name": "Reported", "calculated": False, "generated": False, "formula": ""},
            {
                "name": "Paid Ratio",
                "calculated": True,
                "generated": False,
                "formula": '"Paid" / "Reported"',
            },
        ]
        self.write_sidecar("Paid")
        self.write_sidecar("Paid Ratio", dependents=("D 10 - Ratio DFM",), source_kind="calculated")
        self.write_sidecar(
            "D 10 - Ratio DFM",
            method_type=dataset_sidecar_status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
        )

        with patch.object(
            calculated_dataset_service,
            "_existing_dataset_keys",
            return_value={"paid", "reported", "paid ratio"},
        ):
            closure = self.closure("Paid", dataset_type_rows=rows)
        self.assertEqual(
            [node.name for node in closure.nodes], ["Paid", "Paid Ratio", "D 10 - Ratio DFM"]
        )
        self.assertEqual(closure.nodes[1].kind, dependent_walk_service.KIND_CALCULATED)

    def test_a_calculated_type_with_no_instance_here_is_not_reached(self) -> None:
        rows = [
            {"name": "Paid", "calculated": False, "generated": False, "formula": ""},
            {"name": "Paid Ratio", "calculated": True, "generated": False, "formula": '"Paid" * 2'},
        ]
        self.write_sidecar("Paid")

        with patch.object(
            calculated_dataset_service, "_existing_dataset_keys", return_value={"paid"}
        ):
            closure = self.closure("Paid", dataset_type_rows=rows)
        self.assertEqual([node.name for node in closure.nodes], ["Paid"])

    def test_a_graph_over_the_node_cap_is_refused(self) -> None:
        self.write_sidecar("Paid", dependents=("Left", "Right"))
        self.write_sidecar("Left")
        self.write_sidecar("Right")

        with patch.object(result_selection_service, "MAX_REFRESH_GRAPH_NODES", 1):
            with self.assertRaises(RuntimeError) as caught:
                self.closure("Paid")
        self.assertEqual(str(caught.exception), dependent_walk_service.GRAPH_LIMIT_MESSAGE)


if __name__ == "__main__":
    unittest.main()
