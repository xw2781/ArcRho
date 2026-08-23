"""Step one of the two-step save: what a save would refresh, before it writes.

These tests pin the three promises the confirmation dialog rests on: the plan
names what a real walk can reach (both graphs, not just one), it resolves its
roots through the module that owns the save so the plan and the save can never
disagree, and its fingerprint changes exactly when the graph the user reviewed
has moved on.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app_server import config
from app_server.services import calculated_dataset_service
from app_server.services import dataset_sidecar_status_service as status_service
from app_server.services import save_plan_service

PROJECT = "Project"
RESERVING = "Class"


class SavePlanGraphTests(unittest.TestCase):
    """The closure and the fingerprint, against real sidecars on disk."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.sidecars = Path(self.temp_dir.name) / "sidecars"
        self.sidecars.mkdir()
        self.patchers = [
            patch.object(
                config,
                "get_project_dataset_sidecar_dir",
                return_value=str(self.sidecars),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp_dir.cleanup()

    def write_sidecar(
        self,
        name: str,
        *,
        method_type: str = status_service.METHOD_TYPE_NONE,
        source_kind: str = "input",
        dependents: tuple[str, ...] = (),
        precedents: tuple[str, ...] = (),
        updated_at: str = "2026-08-14T00:00:00Z",
    ) -> None:
        status_service.write_sidecar(
            status_service.sidecar_path(PROJECT, RESERVING, name),
            {
                "dataset_name": name,
                "dataset_type": name,
                "project_name": PROJECT,
                "reserving_class": RESERVING,
                "method_type": method_type,
                "source_kind": source_kind,
                "status": status_service.STATUS_CURRENT,
                "updated_at": updated_at,
                "precedents": status_service.name_entries(precedents),
                "dependents": status_service.name_entries(dependents),
            },
        )

    def build_chain(self) -> None:
        # Paid -> Paid Vector -> Paid DFM -> Ultimate RS
        self.write_sidecar("Paid", dependents=("Paid Vector",))
        self.write_sidecar(
            "Paid Vector", source_kind="calculated", dependents=("Paid DFM",)
        )
        self.write_sidecar(
            "Paid DFM",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            precedents=("Paid Vector",),
            dependents=("Ultimate RS",),
        )
        self.write_sidecar(
            "Ultimate RS",
            method_type=status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
            precedents=("Paid DFM",),
        )

    def test_closure_reaches_every_tier_and_labels_each_object(self) -> None:
        self.build_chain()
        closure = status_service.dependent_closure(PROJECT, RESERVING, ["Paid"])
        self.assertEqual(
            [(item["dataset_name"], item["method_type"]) for item in closure],
            [
                ("Paid Vector", status_service.METHOD_TYPE_NONE),
                ("Paid DFM", status_service.METHOD_TYPE_DFM),
                ("Ultimate RS", status_service.METHOD_TYPE_RESULT_SELECTION),
            ],
        )

    def test_closure_writes_nothing(self) -> None:
        self.build_chain()
        before = {
            path.name: path.read_bytes() for path in self.sidecars.iterdir()
        }
        status_service.dependent_closure(PROJECT, RESERVING, ["Paid"])
        after = {path.name: path.read_bytes() for path in self.sidecars.iterdir()}
        self.assertEqual(before, after, "a plan must leave every sidecar untouched")

    def test_a_dependency_cycle_terminates(self) -> None:
        self.write_sidecar("A", dependents=("B",))
        self.write_sidecar("B", dependents=("A",))
        closure = status_service.dependent_closure(PROJECT, RESERVING, ["A"])
        self.assertEqual([item["dataset_name"] for item in closure], ["B"])

    def test_graph_signature_moves_when_a_precedent_is_rewired(self) -> None:
        self.build_chain()
        names = ["Paid", "Paid Vector", "Paid DFM", "Ultimate RS"]
        before = status_service.graph_signature(PROJECT, RESERVING, names)
        self.write_sidecar(
            "Paid DFM",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            precedents=("Paid",),
            dependents=("Ultimate RS",),
        )
        self.assertNotEqual(before, status_service.graph_signature(PROJECT, RESERVING, names))

    def test_graph_signature_moves_when_a_dependent_is_saved(self) -> None:
        self.build_chain()
        names = ["Paid", "Paid Vector", "Paid DFM", "Ultimate RS"]
        before = status_service.graph_signature(PROJECT, RESERVING, names)
        self.write_sidecar(
            "Ultimate RS",
            method_type=status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
            precedents=("Paid DFM",),
            updated_at="2026-08-14T09:30:00Z",
        )
        self.assertNotEqual(before, status_service.graph_signature(PROJECT, RESERVING, names))


class SavePlanBuildTests(unittest.TestCase):
    """The plan payload, over stubbed graphs."""

    def setUp(self) -> None:
        self.patchers = [
            patch.object(
                status_service,
                "dependent_closure",
                return_value=[
                    {
                        "dataset_name": "Paid DFM",
                        "method_type": status_service.METHOD_TYPE_DFM,
                        "source_kind": "dfm",
                    },
                    {
                        "dataset_name": "Paid Vector",
                        "method_type": status_service.METHOD_TYPE_NONE,
                        "source_kind": "calculated",
                    },
                ],
            ),
            patch.object(
                status_service, "graph_signature", return_value=[["paid", "t0"]]
            ),
            patch.object(
                calculated_dataset_service,
                "existing_downstream_dataset_types",
                return_value=[
                    # Already named by the sidecar closure: must not be listed twice.
                    {"dataset_name": "Paid Vector"},
                    {"dataset_name": "Ultimate Loss"},
                ],
            ),
            patch.object(
                calculated_dataset_service,
                "dataset_type_graph_signature",
                return_value=[["paid", True, False, "A + B"]],
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()

    def build(self, **overrides):
        return save_plan_service.build_save_plan(
            overrides.get("save_kind", "dataset_sidecar"),
            PROJECT,
            RESERVING,
            [PROJECT, RESERVING, "Paid"],
            {"dataset_type": "Paid"},
        )

    def test_plan_unions_both_graphs_and_never_lists_a_root(self) -> None:
        with patch.object(
            save_plan_service,
            "resolve_save_roots",
            return_value=[{"dataset_name": "Paid", "dataset_type": "Paid"}],
        ):
            plan = self.build()
        self.assertEqual(
            [(item["dataset_name"], item["kind"]) for item in plan["dependents"]],
            [
                ("Paid DFM", status_service.METHOD_TYPE_DFM),
                ("Paid Vector", save_plan_service.CALCULATED_DATASET_KIND),
                ("Ultimate Loss", save_plan_service.CALCULATED_DATASET_KIND),
            ],
        )
        self.assertEqual(plan["dependent_count"], 3)
        self.assertTrue(plan["fingerprint"])

    def test_the_same_graph_fingerprints_the_same_way_twice(self) -> None:
        with patch.object(
            save_plan_service,
            "resolve_save_roots",
            return_value=[{"dataset_name": "Paid", "dataset_type": "Paid"}],
        ):
            self.assertEqual(self.build()["fingerprint"], self.build()["fingerprint"])

    def test_a_moved_graph_changes_the_fingerprint(self) -> None:
        with patch.object(
            save_plan_service,
            "resolve_save_roots",
            return_value=[{"dataset_name": "Paid", "dataset_type": "Paid"}],
        ):
            before = self.build()["fingerprint"]
            with patch.object(
                status_service, "graph_signature", return_value=[["paid", "t1"]]
            ):
                after = self.build()["fingerprint"]
        self.assertNotEqual(before, after)

    def test_matching_a_reviewed_fingerprint(self) -> None:
        with patch.object(
            save_plan_service,
            "resolve_save_roots",
            return_value=[{"dataset_name": "Paid", "dataset_type": "Paid"}],
        ):
            reviewed = self.build()["fingerprint"]
            matches, current = save_plan_service.plan_fingerprint_matches(
                "dataset_sidecar",
                PROJECT,
                RESERVING,
                [PROJECT, RESERVING, "Paid"],
                {"dataset_type": "Paid"},
                reviewed,
            )
            self.assertTrue(matches)
            self.assertEqual(current, reviewed)

            with patch.object(
                status_service, "graph_signature", return_value=[["paid", "t1"]]
            ):
                stale, moved = save_plan_service.plan_fingerprint_matches(
                    "dataset_sidecar",
                    PROJECT,
                    RESERVING,
                    [PROJECT, RESERVING, "Paid"],
                    {"dataset_type": "Paid"},
                    reviewed,
                )
        self.assertFalse(stale)
        self.assertNotEqual(moved, reviewed)

    def test_a_commit_with_no_reviewed_plan_is_never_refused(self) -> None:
        matches, current = save_plan_service.plan_fingerprint_matches(
            "dataset_sidecar", PROJECT, RESERVING, [], {}, ""
        )
        self.assertTrue(matches)
        self.assertEqual(current, "")


class SavePlanRootTests(unittest.TestCase):
    """Roots come from the module that owns the save, never from a copy."""

    def test_every_hosted_save_kind_can_report_its_roots(self) -> None:
        import importlib

        from arcrho_engine_save_contract import (
            SAVE_JOB_KINDS,
            SAVE_JOB_PLAN_ROOT_FUNCTION,
        )

        for kind, (module_name, _save_function) in SAVE_JOB_KINDS.items():
            module = importlib.import_module(f"app_server.services.{module_name}")
            self.assertTrue(
                callable(getattr(module, SAVE_JOB_PLAN_ROOT_FUNCTION, None)),
                f"{kind} cannot report the roots its save propagates from",
            )

    def test_a_method_save_plans_from_its_output_dataset(self) -> None:
        from arcrho_api.cape_cod_contract import CC_JSON_FORMAT
        from app_server.services import cape_cod_service

        method = {
            "json_format": CC_JSON_FORMAT,
            "details_tab": {"name": "CC Ultimate"},
        }
        roots = save_plan_service.resolve_save_roots(
            "cape_cod_method", [PROJECT, RESERVING, method], {}
        )
        self.assertEqual(roots, [{"dataset_name": "CC Ultimate", "dataset_type": "CC Ultimate"}])
        # The plan reaches the identity through the very function the save
        # uses, so the two cannot drift apart.
        self.assertEqual(
            cape_cod_service.save_propagation_roots(PROJECT, RESERVING, method),
            [("CC Ultimate", "CC Ultimate")],
        )

    def test_an_invalid_method_payload_refuses_the_plan_the_way_the_save_would(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            save_plan_service.resolve_save_roots(
                "cape_cod_method", [PROJECT, RESERVING, {"details_tab": {}}], {}
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_an_unknown_kind_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            save_plan_service.resolve_save_roots("not_a_kind", [], {})
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
