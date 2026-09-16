"""The one ordered pass a save makes over everything it reaches.

The shapes here are the production save that started the ordered-walk plan
(``docs/plans/ordered_dependent_walk.md``): 26 objects downstream of one
Bornhuetter-Ferguson prior vector, which the old wave orchestration rewrote 54
times because three different triggers reached ``D 91`` and its 13
descendants. Every case builds a synthetic sidecar folder and traces the
per-object refreshers, so the count and the order are pinned without a
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
    berquist_sherman_service,
    bootstrap_service,
    bornhuetter_ferguson_service,
    calculated_dataset_service,
    cape_cod_service,
    dataset_instance_index_service,
    dataset_link_refresh_service,
    dataset_sidecar_status_service,
    dependent_walk_service,
    dfm_service,
)

PROJECT = "Example Project"
RESERVING_CLASS = "Example RC"

ROOT = "C 42a - Prior for BF Reported ex CWOP"
STATUSES = dataset_sidecar_status_service

# The traced shape. Each entry is one object: its kind, and what it feeds.
# ``C 92`` reaches ``D 91`` twice -- straight down, and the long way through
# the Berquist-Sherman adjustment and ``D 18`` -- which is the fan-in that
# used to cost three passes over the whole ``D 91`` subtree.
TRACED_GRAPH: dict[str, tuple[str, tuple[str, ...]]] = {
    ROOT: ("input", ("F 42 - BF Reported ex CWOP", "F 43 - BF Paid")),
    "F 42 - BF Reported ex CWOP": ("bornhuetter_ferguson", ("C 92 - Current Qtr Selected",)),
    "C 92 - Current Qtr Selected": (
        "result_selection",
        ("C 41 - BS Paid Adjustment", "D 91 - Current Qtr Indicated"),
    ),
    "C 41 - BS Paid Adjustment": ("berquist_sherman", ("D 18 - BS Paid DFM",)),
    "D 18 - BS Paid DFM": ("dfm", ("D 91 - Current Qtr Indicated",)),
    "D 91 - Current Qtr Indicated": (
        "result_selection",
        ("P 1 - Net Loss", "P 2 - Net DCC", "P 3 - Gross Loss", "P 4 - Gross DCC"),
    ),
    "P 1 - Net Loss": ("dfm", ("Q 1 - Net Loss Selected", "Q 2 - Net Loss Ratio")),
    "P 2 - Net DCC": ("dfm", ("Q 3 - Net DCC Selected", "Q 4 - Net DCC Ratio")),
    "P 3 - Gross Loss": ("dfm", ("Q 5 - Gross Loss Selected", "Q 6 - Gross Loss Ratio")),
    "P 4 - Gross DCC": ("dfm", ("Q 7 - Gross DCC Selected", "Q 8 - Gross DCC Ratio")),
    "Q 1 - Net Loss Selected": ("result_selection", ("R 1 - Net Loss Indicated",)),
    "Q 2 - Net Loss Ratio": ("result_selection", ()),
    "Q 3 - Net DCC Selected": ("result_selection", ()),
    "Q 4 - Net DCC Ratio": ("result_selection", ()),
    "Q 5 - Gross Loss Selected": ("result_selection", ()),
    "Q 6 - Gross Loss Ratio": ("result_selection", ()),
    "Q 7 - Gross DCC Selected": ("result_selection", ()),
    "Q 8 - Gross DCC Ratio": ("result_selection", ()),
    "R 1 - Net Loss Indicated": ("result_selection", ()),
    # The independent branch: nothing on it reads anything under D 18.
    "F 43 - BF Paid": ("bornhuetter_ferguson", ("D 43 - Paid DFM", "C 60 - Candidate Ultimate")),
    "D 43 - Paid DFM": ("dfm", ("D 44 - Paid Selected", "F 44 - CC Paid")),
    "D 44 - Paid Selected": ("result_selection", ()),
    "F 44 - CC Paid": ("cape_cod", ("F 45 - Bootstrap Paid",)),
    "F 45 - Bootstrap Paid": ("bootstrap", ()),
    "C 60 - Candidate Ultimate": ("linked_input", ()),
    "C 50 - Paid Ratio": ("calculated", ("D 50 - Ratio DFM",)),
    "D 50 - Ratio DFM": ("dfm", ()),
}

# ``C 50`` is reached through the dataset-type formula graph rather than a
# sidecar edge, the walk's second edge source.
DATASET_TYPE_ROWS = [
    {"name": ROOT, "calculated": False, "generated": False, "formula": ""},
    {
        "name": "C 50 - Paid Ratio",
        "calculated": True,
        "generated": False,
        "formula": f'"{ROOT}" * 2',
    },
]

BELOW_D_18 = (
    "D 91 - Current Qtr Indicated",
    "P 1 - Net Loss",
    "P 2 - Net DCC",
    "P 3 - Gross Loss",
    "P 4 - Gross DCC",
    "Q 1 - Net Loss Selected",
    "Q 2 - Net Loss Ratio",
    "Q 3 - Net DCC Selected",
    "Q 4 - Net DCC Ratio",
    "Q 5 - Gross Loss Selected",
    "Q 6 - Gross Loss Ratio",
    "Q 7 - Gross DCC Selected",
    "Q 8 - Gross DCC Ratio",
    "R 1 - Net Loss Indicated",
)

_SIDECAR_FIELDS = {
    "dfm": (STATUSES.METHOD_TYPE_DFM, "dfm"),
    "result_selection": (STATUSES.METHOD_TYPE_RESULT_SELECTION, "result_selection"),
    "berquist_sherman": (
        STATUSES.METHOD_TYPE_BERQUIST_SHERMAN_SR,
        STATUSES.SOURCE_KIND_BERQUIST_SHERMAN_SR,
    ),
    "bornhuetter_ferguson": (
        STATUSES.METHOD_TYPE_BORN_HUETTER_FERGUSON,
        "bornhuetter_ferguson",
    ),
    "cape_cod": (STATUSES.METHOD_TYPE_CAPE_COD, "cape_cod"),
    "bootstrap": (STATUSES.METHOD_TYPE_BOOTSTRAP, "bootstrap"),
    "calculated": ("", "calculated"),
    "linked_input": ("", "input"),
    "input": ("", "input"),
}

_MODULE_BY_KIND = {
    dependent_walk_service.KIND_DFM: dfm_service,
    dependent_walk_service.KIND_RESULT_SELECTION: "result_selection",
    dependent_walk_service.KIND_BERQUIST_SHERMAN: berquist_sherman_service,
    dependent_walk_service.KIND_BORNHUETTER_FERGUSON: bornhuetter_ferguson_service,
    dependent_walk_service.KIND_CAPE_COD: cape_cod_service,
    dependent_walk_service.KIND_BOOTSTRAP: bootstrap_service,
    dependent_walk_service.KIND_CALCULATED: calculated_dataset_service,
    dependent_walk_service.KIND_LINKED_INPUT: dataset_link_refresh_service,
}


class DependentWalkPassTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.sidecar_dir = Path(self.temp_dir.name) / "sidecars"
        self.sidecar_dir.mkdir(parents=True)
        for patcher in (
            patch.object(
                config, "get_project_dataset_sidecar_dir", return_value=str(self.sidecar_dir)
            ),
            patch.object(dataset_instance_index_service, "rebuild_index", return_value={}),
            patch.object(
                dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch.object(
                calculated_dataset_service,
                "_dataset_type_rows",
                return_value=[dict(row) for row in DATASET_TYPE_ROWS],
            ),
            patch.object(
                calculated_dataset_service,
                "_existing_dataset_keys",
                return_value={"c 42a - prior for bf reported ex cwop", "c 50 - paid ratio"},
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        # What every refresher was asked to do, in the order the pass asked.
        self.calls: list[tuple[str, str, tuple[str, ...]]] = []
        self.failures: set[str] = set()
        # What a refresher should answer for one object, when the default
        # "republished, values unchanged" is not the point of the case.
        self.results: dict[str, dict] = {}

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    # -- fixtures --------------------------------------------------------

    def write_graph(self, graph: dict[str, tuple[str, tuple[str, ...]]]) -> None:
        for name, (kind, dependents) in graph.items():
            method_type, source_kind = _SIDECAR_FIELDS[kind]
            payload = {
                "dataset_name": name,
                "dataset_type": name,
                "source_kind": source_kind,
                "dependents": dataset_sidecar_status_service.name_entries(list(dependents)),
            }
            if method_type:
                payload["method_type"] = method_type
            if kind == "linked_input":
                payload["internal_links"] = [{"reference": f"{name} source"}]
            path = Path(
                dataset_sidecar_status_service.sidecar_path(PROJECT, RESERVING_CLASS, name)
            )
            path.write_text(json.dumps(payload), encoding="utf-8")

    def trace_refreshers(self) -> None:
        """Replace every domain's one-object refresher with a recorder."""

        for kind, module in _MODULE_BY_KIND.items():
            if module == "result_selection":
                from app_server.services import result_selection_service

                module = result_selection_service
            patcher = patch.object(
                module,
                "refresh_output",
                side_effect=self._recorder(kind),
            )
            patcher.start()
            self.addCleanup(patcher.stop)

    def _recorder(self, kind: str):
        def refresh_output(
            _project, _reserving, dataset_name, _sidecar=None, changed_precedents=(), _caches=None
        ):
            self.calls.append((kind, dataset_name, tuple(changed_precedents)))
            if dataset_name in self.results:
                return self.results[dataset_name]
            if dataset_name in self.failures:
                return {"ok": False, "dataset_name": dataset_name, "reason": "refresh failed"}
            if kind == dependent_walk_service.KIND_CALCULATED:
                return {"ok": True, "dataset_type_name": dataset_name}
            if kind == dependent_walk_service.KIND_LINKED_INPUT:
                return {"ok": True, "dataset_name": dataset_name, "refreshed": True}
            return {
                "ok": True,
                "dataset_name": dataset_name,
                "dataset_type": dataset_name,
                "updated": True,
                # A method whose published values did not move is still fresh,
                # and must still reach what reads it.
                "output_changed": False,
            }

        return refresh_output

    def walk(self, *, root: str = ROOT, **options) -> dict:
        return calculated_dataset_service.recalculate_dependents(
            PROJECT, RESERVING_CLASS, root, root, **options
        )

    def refreshed_names(self) -> list[str]:
        return [name for _kind, name, _changed in self.calls]

    # -- cases -----------------------------------------------------------

    def test_every_reachable_object_is_refreshed_once_after_its_precedents(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()

        result = self.walk()

        names = self.refreshed_names()
        self.assertTrue(result["ok"], result)
        # 26 objects downstream of the save, one refresh each -- the trace that
        # started this plan did the same 26 objects 54 times.
        self.assertEqual(len(names), 26)
        self.assertEqual(len(set(names)), 26)
        self.assertNotIn(ROOT, names)
        for name, (_kind, dependents) in TRACED_GRAPH.items():
            for dependent in dependents:
                if name == ROOT:
                    continue
                self.assertLess(
                    names.index(name),
                    names.index(dependent),
                    f"{name} must be refreshed before {dependent}",
                )
        # The fan-in that cost the repeat passes: D 91 reads C 92 directly and
        # through the B&S adjustment and D 18, and waits for the long arm.
        self.assertLess(
            names.index("D 18 - BS Paid DFM"), names.index("D 91 - Current Qtr Indicated")
        )
        self.assertEqual(
            sorted(dict(
                (name, changed) for _kind, name, changed in self.calls
            )["D 91 - Current Qtr Indicated"]),
            ["C 92 - Current Qtr Selected", "D 18 - BS Paid DFM"],
        )

    def test_each_object_is_handed_to_its_own_domain(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()

        self.walk()

        by_name = {name: kind for kind, name, _changed in self.calls}
        self.assertEqual(by_name["D 18 - BS Paid DFM"], dependent_walk_service.KIND_DFM)
        self.assertEqual(
            by_name["C 41 - BS Paid Adjustment"], dependent_walk_service.KIND_BERQUIST_SHERMAN
        )
        self.assertEqual(
            by_name["F 42 - BF Reported ex CWOP"],
            dependent_walk_service.KIND_BORNHUETTER_FERGUSON,
        )
        self.assertEqual(by_name["F 44 - CC Paid"], dependent_walk_service.KIND_CAPE_COD)
        self.assertEqual(by_name["F 45 - Bootstrap Paid"], dependent_walk_service.KIND_BOOTSTRAP)
        self.assertEqual(by_name["C 50 - Paid Ratio"], dependent_walk_service.KIND_CALCULATED)
        self.assertEqual(
            by_name["C 60 - Candidate Ultimate"], dependent_walk_service.KIND_LINKED_INPUT
        )

    def test_a_failure_blocks_what_is_below_it_and_nothing_else(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()
        self.failures = {"D 18 - BS Paid DFM"}

        result = self.walk()

        names = self.refreshed_names()
        self.assertFalse(result["ok"])
        self.assertIn("D 18 - BS Paid DFM", names)
        for name in BELOW_D_18:
            self.assertNotIn(name, names)
        # 26 reachable, 14 under the failure, so 12 refreshers still ran: the
        # failed one and the 11 objects on branches it does not feed.
        self.assertEqual(len(names), 12)
        for name in (
            "F 42 - BF Reported ex CWOP",
            "C 92 - Current Qtr Selected",
            "C 41 - BS Paid Adjustment",
            "F 43 - BF Paid",
            "D 43 - Paid DFM",
            "D 44 - Paid Selected",
            "F 44 - CC Paid",
            "F 45 - Bootstrap Paid",
            "C 50 - Paid Ratio",
        ):
            self.assertIn(name, names)
        blocked = {
            error["dataset_name"]: error["reason"]
            for bucket in (
                "dfm_updates",
                "result_selection_updates",
                "berquist_sherman_updates",
            )
            for error in result[bucket]["errors"]
        }
        self.assertEqual(
            blocked["D 91 - Current Qtr Indicated"],
            "Precedent refresh failed: D 18 - BS Paid DFM",
        )
        self.assertEqual(
            blocked["R 1 - Net Loss Indicated"],
            "Precedent refresh failed: Q 1 - Net Loss Selected",
        )
        self.assertEqual(len(blocked), 15)

    def test_a_kind_left_out_is_crossed_rather_than_refreshed(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()

        result = self.walk(include_cape_cod=False)

        names = self.refreshed_names()
        self.assertNotIn("F 44 - CC Paid", names)
        self.assertIsNone(result["cape_cod_updates"])
        # The walk still reaches what lies below the kind it left alone.
        self.assertIn("F 45 - Bootstrap Paid", names)

    def test_a_link_cycle_refreshes_each_side_once(self) -> None:
        self.write_graph({
            "Paid": ("input", ("D 91 - Selected Ultimate",)),
            "D 91 - Selected Ultimate": (
                "result_selection",
                ("C 60 - Candidate Ultimate",),
            ),
            "C 60 - Candidate Ultimate": ("linked_input", ("D 91 - Selected Ultimate",)),
        })
        self.trace_refreshers()

        result = self.walk(root="Paid")

        self.assertEqual(
            self.refreshed_names(), ["D 91 - Selected Ultimate", "C 60 - Candidate Ultimate"]
        )
        self.assertEqual(result["link_updates"]["refreshed"], ["C 60 - Candidate Ultimate"])

    def test_the_report_keeps_the_shape_every_caller_reads(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()

        result = self.walk()

        for field in (
            "ok",
            "updated",
            "skipped",
            "steps",
            "targets",
            "dfm_updates",
            "result_selection_updates",
            "berquist_sherman_updates",
            "bornhuetter_ferguson_updates",
            "cape_cod_updates",
            "bootstrap_updates",
            "link_updates",
            "review_flagged",
            "index_ok",
            "index_error",
        ):
            self.assertIn(field, result)
        self.assertEqual(
            [item["dataset_name"] for item in result["bornhuetter_ferguson_updates"]["updated"]],
            ["F 42 - BF Reported ex CWOP", "F 43 - BF Paid"],
        )
        self.assertEqual(result["targets"], ["C 50 - Paid Ratio"])
        self.assertEqual(
            [item["dataset_type_name"] for item in result["updated"]], ["C 50 - Paid Ratio"]
        )

    def test_the_progress_callback_names_every_object_and_its_domain(self) -> None:
        self.write_graph(TRACED_GRAPH)
        self.trace_refreshers()
        seen: list[tuple[str, str]] = []

        self.walk(progress_callback=lambda stage, _done, _total, label: seen.append((stage, label)))

        objects = [entry for entry in seen if entry[0] not in ("finalize", "index")]
        self.assertEqual(len(objects), 26)
        self.assertEqual(
            objects[0], ("bornhuetter_ferguson", "F 42 - BF Reported ex CWOP")
        )
        self.assertIn(("dfm", "D 18 - BS Paid DFM"), objects)
        self.assertIn(("calculated_datasets", "C 50 - Paid Ratio"), objects)

    def test_link_failures_and_warnings_accumulate_without_stopping(self) -> None:
        """One link-driven input declining does not stop the other."""

        self.write_graph({
            "Root": ("input", ("Broken", "Warned")),
            "Broken": ("linked_input", ()),
            "Warned": ("linked_input", ()),
            "Plain": ("input", ()),
        })
        self.trace_refreshers()
        self.results = {
            "Broken": {
                "ok": False,
                "dataset_name": "Broken",
                "reason": "link_error",
                "errors": ["Missing dependency: Gone"],
            },
            "Warned": {
                "ok": True,
                "dataset_name": "Warned",
                "refreshed": True,
                "warnings": [
                    {"reference": "='C:...'!A1", "reason": "Excel value could not be read"}
                ],
            },
        }

        result = self.walk(root="Root")

        link_updates = result["link_updates"]
        self.assertFalse(result["ok"])
        self.assertEqual(link_updates["refreshed"], ["Warned"])
        self.assertEqual(link_updates["failed"], ["Broken"])
        self.assertEqual(
            link_updates["errors"],
            [{
                "dataset_name": "Broken",
                "reason": "link_error",
                "errors": ["Missing dependency: Gone"],
            }],
        )
        self.assertEqual(len(link_updates["warnings"]), 1)
        self.assertEqual(link_updates["warnings"][0]["dataset_name"], "Warned")

    def test_a_plain_input_dependent_is_crossed_not_rewritten(self) -> None:
        """A dataset nothing calculates is a node the walk crosses."""

        self.write_graph({
            "Root": ("input", ("Plain",)),
            "Plain": ("input", ("D 10 - Plain DFM",)),
            "D 10 - Plain DFM": ("dfm", ()),
        })
        self.trace_refreshers()

        self.walk(root="Root")

        self.assertEqual(self.refreshed_names(), ["D 10 - Plain DFM"])


if __name__ == "__main__":
    unittest.main()
