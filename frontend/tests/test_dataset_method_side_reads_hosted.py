"""Dataset and method side reads run on the server host.

The dataset sidecar panel, the unsaved dependents preview, the DFM's dataset
references, the % Developed curve and the development pattern are Gateway
reads, and the method-index refresh is a Gateway mutation. A Client PC asks
the Gateway for each route's whole answer and refuses when it cannot; a
server process runs the same service locally.
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import config as api_config  # noqa: E402
from arcrho_hosted_save_http_contract import MAX_REQUEST_BYTES  # noqa: E402
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402
from arcrho_workspace_read_contract import MAX_WORKSPACE_READ_REQUEST_BYTES, WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.dataset import DatasetCalculatedPreviewRequest, DatasetSidecarLoadRequest  # noqa: E402
from app_server.schemas.dfm_method import DfmDatasetReferencesResolveRequest  # noqa: E402
from app_server.schemas.dfm_method_index import DfmMethodIndexRefreshRequest  # noqa: E402
from app_server.services import (  # noqa: E402
    calculated_dataset_service,
    dataset_instance_index_service,
    dataset_service,
    user_identity_service,
    workspace_read_client,
)

dataset_router = importlib.import_module("app_server.api.dataset_router")
dfm_method_router = importlib.import_module("app_server.api.dfm_method_router")
dfm_index_router = importlib.import_module("app_server.api.dfm_method_index_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROJECT = "Demo Project"
RC = "NJ\\Auto"
METHOD = "Paid DFM"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
READ_KINDS = (
    "dataset_sidecar_load",
    "dataset_calculated_preview",
    "dfm_dataset_references_resolve",
    "dfm_percent_developed_curve",
    "dfm_development_pattern",
)
MUTATION_KINDS = ("dataset_index_rebuild",)
TYPE_ROWS = [
    {"name": "Paid", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Paid", "generated": True},
    {"name": "Double Paid", "data_format": "Triangle", "calculated": True, "formula": '"Paid" * 2', "source": "", "generated": False},
]
CACHED = {
    "paid": {
        "dataset_name": "Paid",
        "data_format": "Triangle",
        "origin_labels": ["2023", "2024"],
        "dev_labels": ["12", "24"],
        "values": [[100, 150], [200, None]],
    },
}


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


class DatasetMethodSideReadsHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        projects = self.root / "projects"
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.kinds: list[str] = []
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(projects)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={
                    "workspace_read_kinds": list(READ_KINDS),
                    "workspace_mutation_kinds": list(MUTATION_KINDS),
                },
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
            # The two inputs whose real producers need a whole project: the
            # dataset types table and a cached dataset's values.
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[dict(row) for row in TYPE_ROWS]),
            patch.object(
                dataset_service,
                "load_cached_dataset_values",
                side_effect=lambda _p, _rc, name, **_kw: dict(CACHED[name.casefold()]),
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

        (projects / PROJECT).mkdir(parents=True)
        folders = dataset_instance_index_service._folder_paths(PROJECT, RC)
        for name in ("datasets", "methods", "sidecars"):
            Path(folders[name]).mkdir(parents=True, exist_ok=True)
        sidecars = Path(folders["sidecars"])
        _write_json(sidecars / "Paid.json", {
            "dataset_name": "Paid", "dataset_type": "Paid", "project_name": PROJECT, "reserving_class": RC,
            "source_kind": "input", "method_type": "None", "data_format": "Triangle",
            "origin_length": 12, "development_length": 12, "precedents": [], "dependents": [],
        })
        _write_json(sidecars / "Paid Ultimate.json", {
            "dataset_name": "Paid Ultimate", "dataset_type": "Paid Ultimate", "project_name": PROJECT,
            "reserving_class": RC, "source_kind": "method", "method_type": "DFM", "method_name": METHOD,
            "data_format": "Vector", "period_length": 12, "origin_labels": ["2023", "2024"],
        })
        _write_json(Path(folders["methods"]) / f"DFM@{METHOD}.json", {
            "data_tab": {"development_labels": ["12", "24", "36"]},
            "ratios_tab": {
                "ratio_triangle": {"development_labels": ["12-24", "24-36", "36-Ult"]},
                "average_formulas": {
                    "label": ["All-year"],
                    "selected": [[True, True, True]],
                    "values": [[1.5, 1.2, 1.0]],
                },
            },
        })

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)})

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the request as the Gateway does: the registered service, as the signed user."""

        request = json.loads(json.dumps(request_payload))
        kind = request.get("ReadKind") or request.get("MutationKind")
        self.kinds.append(kind)
        spec = WORKSPACE_READ_KINDS.get(request.get("ReadKind")) or WORKSPACE_MUTATION_KINDS[kind]
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with self._server_process(), user_identity_service.acting_identity(request["UserName"]):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _reads(self):
        return [
            ("dataset_sidecar_load", lambda: dataset_router.load_dataset_sidecar(
                DatasetSidecarLoadRequest(project_name=PROJECT, reserving_class=RC, dataset_name="Paid")
            )),
            ("dataset_calculated_preview", lambda: dataset_router.preview_calculated_dataset_dependents(
                DatasetCalculatedPreviewRequest(
                    project_name=PROJECT,
                    reserving_class=RC,
                    changed_dataset_name="Paid",
                    changed_dataset_type_name="Paid",
                    values=[[100.0, 150.0], [200.0, None]],
                    mask=[[True, True], [True, False]],
                    origin_labels=["2023", "2024"],
                    development_labels=["12", "24"],
                )
            )),
            ("dfm_dataset_references_resolve", lambda: dfm_method_router.resolve_dfm_dataset_references(
                DfmDatasetReferencesResolveRequest(
                    project_name=PROJECT,
                    reserving_class=RC,
                    references=[{"dataset_name": "Paid", "row_idx": "2024", "col_idx": "12"}],
                )
            )),
            ("dfm_percent_developed_curve", lambda: dfm_index_router.get_dfm_percent_developed_curve(PROJECT, RC, METHOD)),
            ("dfm_development_pattern", lambda: dfm_index_router.get_dfm_development_pattern(PROJECT, RC, "Paid Ultimate")),
        ]

    def _refresh(self):
        return dfm_index_router.refresh_dfm_method_index(
            DfmMethodIndexRefreshRequest(project_name=PROJECT, reserving_class=RC)
        )

    def _files(self) -> dict[str, tuple[bytes, int]]:
        return {
            str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in self.root.rglob("*")
            if path.is_file()
        }

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kind in READ_KINDS + MUTATION_KINDS:
            with self.subTest(kind):
                spec = WORKSPACE_READ_KINDS.get(kind) or WORKSPACE_MUTATION_KINDS[kind]
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})

    def test_each_read_answers_the_same_through_the_gateway_as_on_the_server(self) -> None:
        with patch.object(dataset_instance_index_service, "development_pattern_values", return_value=[0.5, 0.8]):
            for kind, route in self._reads():
                with self.subTest(route=kind):
                    with self._server_process():
                        local = jsonable_encoder(route())
                    self.kinds.clear()
                    hosted = route()

                    self.assertEqual(self.kinds, [kind])
                    self.assertEqual(hosted, local)
                    self.assertNotEqual(hosted.get("ok"), False)

    def test_no_read_writes_a_file(self) -> None:
        before = self._files()
        with patch.object(dataset_instance_index_service, "development_pattern_values", return_value=[0.5, 0.8]):
            for kind, route in self._reads():
                with self.subTest(route=kind), self._server_process():
                    route()
        self.assertEqual(self._files(), before)

    def test_the_index_refresh_answers_the_same_through_the_gateway_and_repeats_to_the_same_file(self) -> None:
        with self._server_process():
            local = jsonable_encoder(self._refresh())
        index_path = Path(local["folder_paths"]["data"]) / "index.json"
        written = (index_path.read_bytes(), index_path.stat().st_mtime_ns)

        self.kinds.clear()
        hosted = self._refresh()

        self.assertEqual(self.kinds, ["dataset_index_rebuild"])
        for answer in (local, hosted):
            answer.pop("index_elapsed_ms")
        self.assertEqual(hosted, local)
        self.assertTrue(hosted["index_persisted"])
        self.assertEqual((index_path.read_bytes(), index_path.stat().st_mtime_ns), written)

    def test_a_client_refuses_without_the_gateway(self) -> None:
        before = self._files()
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            for kind, route in self._reads() + [("dataset_index_rebuild", self._refresh)]:
                with self.subTest(route=kind):
                    with self.assertRaises(HTTPException) as refused:
                        route()
                    self.assertEqual(refused.exception.status_code, 401)
        self.assertEqual(self.kinds, [])
        self.assertEqual(self._files(), before)

    def test_a_read_carries_as_large_a_grid_as_a_dataset_save(self) -> None:
        self.assertEqual(MAX_WORKSPACE_READ_REQUEST_BYTES, MAX_REQUEST_BYTES)


if __name__ == "__main__":
    unittest.main()
