"""The class-wide graph the Dependency Graph window draws.

Nodes come from the index, edges from the sidecars, and an edge is never lost
because one side of it is missing: a precedent the index no longer lists
still appears, flagged as absent from the index.
"""

from __future__ import annotations

import sys
import importlib
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
from app_server.services import dataset_dependency_graph_service as graph_service
from app_server.services import dataset_instance_index_service
from app_server.services import dataset_sidecar_status_service as status_service
from app_server.services import workspace_read_client

dataset_router = importlib.import_module("app_server.api.dataset_router")

TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

PROJECT = "Project"
RESERVING = "Class"


def _index_row(name: str, **fields: object) -> dict:
    row = {
        "name": name,
        "dataset_type": name,
        "source_kind": "input",
        "method_type": None,
        "method_name": "",
        "status": 0,
        "formula": "",
    }
    row.update(fields)
    return row


class DependencyGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.sidecars = Path(self.temp_dir.name) / "sidecars"
        self.sidecars.mkdir()
        self.index_rows: list = []
        self.patchers = [
            patch.object(config, "get_project_dataset_sidecar_dir", return_value=str(self.sidecars)),
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[]),
            patch.object(
                dataset_instance_index_service,
                "get_index",
                side_effect=lambda project, rc, refresh=False: {"ok": True, "files": list(self.index_rows)},
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp_dir.cleanup()

    def write_sidecar(self, name: str, *, precedents=(), dependents=()) -> None:
        status_service.write_sidecar(
            status_service.sidecar_path(PROJECT, RESERVING, name),
            {
                "dataset_name": name,
                "dataset_type": name,
                "project_name": PROJECT,
                "reserving_class": RESERVING,
                "precedents": status_service.name_entries(precedents),
                "dependents": status_service.name_entries(dependents),
            },
        )

    def test_nodes_follow_the_index_and_edges_follow_the_sidecars(self) -> None:
        self.index_rows = [
            _index_row("Paid"),
            _index_row("Paid Vector", source_kind="calculated", formula="Paid / 2"),
            _index_row("Paid DFM", source_kind="dfm", method_name="Paid DFM Method", status=2),
            _index_row("Ultimate", source_kind="result_selection", method_type="Result Selection"),
        ]
        self.write_sidecar("Paid", dependents=("Paid Vector",))
        self.write_sidecar("Paid Vector", precedents=("Paid",), dependents=("Paid DFM",))
        self.write_sidecar("Paid DFM", precedents=("Paid Vector",), dependents=("Ultimate",))
        self.write_sidecar("Ultimate", precedents=("Paid DFM",))

        graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

        self.assertTrue(graph["ok"])
        self.assertEqual([node["name"] for node in graph["nodes"]], ["Paid", "Paid Vector", "Paid DFM", "Ultimate"])
        by_name = {node["name"]: node for node in graph["nodes"]}
        self.assertEqual(by_name["Paid DFM"]["method_type"], "DFM")
        self.assertEqual(by_name["Paid DFM"]["method_name"], "Paid DFM Method")
        self.assertEqual(by_name["Paid DFM"]["status"], 2)
        self.assertEqual(by_name["Paid"]["method_type"], "None")
        self.assertEqual(by_name["Paid Vector"]["formula"], "Paid / 2")
        self.assertTrue(all(node["in_index"] for node in graph["nodes"]))
        self.assertEqual(
            graph["edges"],
            [
                {"source": "Paid", "target": "Paid Vector"},
                {"source": "Paid DFM", "target": "Ultimate"},
                {"source": "Paid Vector", "target": "Paid DFM"},
            ],
        )

    def test_a_precedent_missing_from_the_index_keeps_its_edge(self) -> None:
        self.index_rows = [_index_row("Paid DFM", source_kind="dfm")]
        self.write_sidecar("Paid DFM", precedents=("Deleted Vector",))

        graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

        self.assertEqual(
            [(node["name"], node["in_index"]) for node in graph["nodes"]],
            [("Paid DFM", True), ("Deleted Vector", False)],
        )
        self.assertEqual(graph["edges"], [{"source": "Deleted Vector", "target": "Paid DFM"}])

    def test_the_reciprocal_side_and_case_differences_do_not_duplicate_an_edge(self) -> None:
        self.index_rows = [_index_row("Paid"), _index_row("Paid Vector")]
        self.write_sidecar("Paid", dependents=("paid vector",))
        self.write_sidecar("Paid Vector", precedents=("PAID",), dependents=("Paid Vector",))

        graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

        self.assertEqual(len(graph["nodes"]), 2)
        self.assertEqual(graph["edges"], [{"source": "Paid", "target": "Paid Vector"}])

    def test_a_generated_formula_joins_its_inputs_to_the_method_that_reads_it(self) -> None:
        """The fake project's ``Earned Premium`` / ``Remaining Budget Premium`` -> ``Total Earned Premium`` chain.

        The two inputs are Engine-built from one source column each and have no
        formula; the type the Engine evaluates over them carries the formula the
        box is drawn with, and the Dataset Types are read once for the graph.
        """

        self.index_rows = [
            _index_row("Earned Premium", source_kind="engine"),
            _index_row("Remaining Budget Premium", source_kind="engine"),
            _index_row("Total Earned Premium", source_kind="engine"),
            _index_row("D 13 - Paid DFM w/ Selected LDFs", source_kind="dfm", method_name="D 13"),
        ]
        self.write_sidecar("Earned Premium", dependents=("Total Earned Premium",))
        self.write_sidecar("Remaining Budget Premium", dependents=("Total Earned Premium",))
        self.write_sidecar(
            "Total Earned Premium",
            precedents=("Earned Premium", "Remaining Budget Premium"),
            dependents=("D 13 - Paid DFM w/ Selected LDFs",),
        )
        self.write_sidecar("D 13 - Paid DFM w/ Selected LDFs", precedents=("Total Earned Premium",))
        rows = [
            {"name": "Earned Premium", "calculated": False, "formula": "", "generated": True},
            {"name": "Remaining Budget Premium", "calculated": False, "formula": "", "generated": True},
            {
                "name": "Total Earned Premium",
                "calculated": True,
                "formula": '"Earned Premium" + "Remaining Budget Premium"',
                "generated": True,
            },
        ]

        with patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows) as read_types:
            graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

        self.assertEqual(read_types.call_count, 1)
        by_name = {node["name"]: node for node in graph["nodes"]}
        self.assertEqual(by_name["Total Earned Premium"]["formula"], '"Earned Premium" + "Remaining Budget Premium"')
        self.assertEqual(by_name["Earned Premium"]["formula"], "")
        self.assertEqual(by_name["Remaining Budget Premium"]["formula"], "")
        self.assertEqual(by_name["D 13 - Paid DFM w/ Selected LDFs"]["method_type"], "DFM")
        self.assertEqual(
            graph["edges"],
            [
                {"source": "Earned Premium", "target": "Total Earned Premium"},
                {"source": "Remaining Budget Premium", "target": "Total Earned Premium"},
                {"source": "Total Earned Premium", "target": "D 13 - Paid DFM w/ Selected LDFs"},
            ],
        )

    def test_a_class_without_engine_datasets_reads_type_categories_once(self) -> None:
        self.index_rows = [_index_row("Paid"), _index_row("Paid Vector", source_kind="calculated")]
        self.write_sidecar("Paid", dependents=("Paid Vector",))
        self.write_sidecar("Paid Vector", precedents=("Paid",))

        with patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[
            {"name": "paid", "category": "Loss"},
        ]) as read_types:
            graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

        self.assertEqual(read_types.call_count, 1)
        self.assertEqual(graph["nodes"][0]["dataset_type_category"], "Loss")
        self.assertEqual(graph["edges"], [{"source": "Paid", "target": "Paid Vector"}])

    def test_stored_and_type_categories_are_projected_without_changing_the_index(self) -> None:
        row = _index_row("Paid DFM", dataset_type="Paid Ultimate", dataset_category="Stored Category", source_kind="dfm")
        self.index_rows = [dict(row)]
        with patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[
            {"name": "Paid Ultimate", "category": "Type Category"},
        ]):
            graph = graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)
        self.assertEqual(graph["nodes"][0]["dataset_category"], "Stored Category")
        self.assertEqual(graph["nodes"][0]["dataset_type_category"], "Type Category")
        self.assertEqual(self.index_rows, [row])

    def test_a_type_read_failure_does_not_return_a_graph_with_incomplete_categories(self) -> None:
        self.index_rows = [_index_row("Paid")]
        with patch.object(calculated_dataset_service, "_dataset_type_rows", side_effect=PermissionError("unavailable")):
            with self.assertRaises(PermissionError):
                graph_service.build_reserving_class_dependency_graph(PROJECT, RESERVING)

    def test_blank_identifiers_are_refused(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            graph_service.build_reserving_class_dependency_graph(" ", RESERVING)
        self.assertEqual(caught.exception.status_code, 400)


class DependencyGraphTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.log_patch = patch.object(workspace_read_client, "_log")
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)

    def test_client_without_gateway_never_reads_the_share(self) -> None:
        with (
            patch.object(workspace_read_client, "_is_server_process", return_value=False),
            patch.object(config, "load_gateway_config", return_value={"enabled": False}),
            patch.object(graph_service, "build_reserving_class_dependency_graph") as local,
        ):
            with self.assertRaises(HTTPException) as caught:
                dataset_router.get_dataset_dependency_graph(PROJECT, RESERVING)
        self.assertEqual(caught.exception.status_code, 503)
        local.assert_not_called()

    def test_gateway_transport_failure_never_falls_back_to_the_share(self) -> None:
        with (
            patch.object(workspace_read_client, "_is_server_process", return_value=False),
            patch.object(config, "load_gateway_config", return_value={"enabled": True, "user": "tester"}),
            patch.object(workspace_read_client, "cached_gateway_capabilities", return_value={"workspace_read_kinds": ["dataset_dependency_graph"]}),
            patch.object(workspace_read_client, "post_signed_json", side_effect=workspace_read_client.GatewayTransportFailure("offline")),
            patch.object(graph_service, "build_reserving_class_dependency_graph") as local,
        ):
            with self.assertRaises(HTTPException) as caught:
                dataset_router.get_dataset_dependency_graph(PROJECT, RESERVING)
        self.assertEqual(caught.exception.status_code, 503)
        local.assert_not_called()

    def test_server_executes_the_canonical_graph_service_locally(self) -> None:
        with (
            patch.object(workspace_read_client, "_is_server_process", return_value=True),
            patch.object(graph_service, "build_reserving_class_dependency_graph", return_value={"ok": True, "nodes": []}) as local,
        ):
            self.assertEqual(dataset_router.get_dataset_dependency_graph(PROJECT, RESERVING), {"ok": True, "nodes": []})
        local.assert_called_once_with(PROJECT, RESERVING)


if __name__ == "__main__":
    unittest.main()
