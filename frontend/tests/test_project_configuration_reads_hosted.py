"""Project configuration reads run on the server host.

Every route below reads project or workspace configuration. A Client PC asks
the Gateway for the route's whole answer and refuses when it cannot; a server
process runs the same service locally. Each route answers the same through
either transport, and the parts that belong to this PC (whether it has a SQL
Server driver, the stat of an external CSV) stay on the client.
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
from arcrho_api.source_table_contract import csv_identity, source_import_path  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.data_processing_rules import DataProcessingRulesValidateRequest  # noqa: E402
from app_server.services import (  # noqa: E402
    source_table_service,
    user_identity_service,
    workspace_read_client,
)

arcrho_router = importlib.import_module("app_server.api.arcrho_router")
dataset_router = importlib.import_module("app_server.api.dataset_router")
dataset_types_router = importlib.import_module("app_server.api.dataset_types_router")
field_mapping_router = importlib.import_module("app_server.api.field_mapping_router")
project_settings_router = importlib.import_module("app_server.api.project_settings_router")
rules_router = importlib.import_module("app_server.api.data_processing_rules_router")
source_table_router = importlib.import_module("app_server.api.source_table_router")
user_identity_router = importlib.import_module("app_server.api.user_identity_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROJECT = "Demo Project"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
KINDS = (
    "project_settings_sources",
    "project_folders",
    "project_registry",
    "project_names",
    "general_settings",
    "dataset_types_table",
    "field_mapping",
    "source_table_settings",
    "mssql_connections",
    "dataset_number_format_defaults",
    "user_identity",
    "data_processing_rules",
    "data_processing_rules_validate",
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


class ProjectConfigurationReadsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        projects = self.root / "projects"
        project = projects / PROJECT
        self.external_csv = self.root / "external" / "claims.csv"
        self.external_csv.parent.mkdir(parents=True)
        self.external_csv.write_text("STATE,Paid\nNJ,10\n", encoding="utf-8")
        _write_json(projects / "index.json", {
            "version": 1,
            "projects": [{"name": PROJECT, "folder": "Personal\\Q2"}],
            "folders": ["Shared"],
        })
        _write_json(project / "general_settings.json", {
            "project_name": PROJECT,
            "origin_start_date": "202001",
            "origin_end_date": "202512",
            "development_end_date": "202512",
            "auto_generated": False,
            "updated_at": "2026-09-01T00:00:00Z",
        })
        _write_json(project / "dataset_types.json", {
            "columns": ["Name", "Data Format", "Category", "Calculated", "Formula", "Source", "Generated"],
            "rows": [["Paid Loss", "Triangle", "Loss", False, "", "Paid", True]],
        })
        _write_json(project / "field_mapping.json", {
            "project_name": PROJECT,
            "table_path": str(self.external_csv),
            "rows": [
                {"field_name": "STATE", "significance": "Reserving Class", "dataset_type": None, "level": 1},
                {"field_name": "Paid", "significance": "Dataset", "dataset_type": "Paid Loss", "level": None},
            ],
        })
        _write_json(Path(source_import_path(str(project))), {
            "project_name": PROJECT,
            "source_type": "csv",
            "last_import": {"source_type": "csv", **csv_identity(str(self.external_csv))},
        })
        _write_json(self.root / "config" / "dataset_number_formats.json", {
            "json_format": "arcrho-dataset-number-formats-v4",
            "revision": 3,
            "default_number_format": "0,000.00",
            "overrides": [{"dataset_type_name": "Paid Loss", "number_format": "0.0000"}],
        })
        _write_json(self.root / "config" / "username_index.json", {
            "users": [{"login_name": "alice", "full_name": "Alice Smith"}],
        })
        _write_json(self.root / "config" / "mssql_connections.json", {
            "connections": [{"server": "sql01", "database": "claims", "last_used_at": "2026-09-01T00:00:00Z"}],
        })

        env = {
            key: value
            for key, value in os.environ.items()
            if key not in (api_config.RUNTIME_SERVER_ROOT_ENV, config.DATASET_NUMBER_FORMATS_PATH_ENV)
        }
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.kinds: list[str] = []
        self.answers: list[dict] = []
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(projects)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={"workspace_read_kinds": list(KINDS)},
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
            patch.object(source_table_service.mssql_odbc, "driver_available", return_value=True),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)
        user_identity_service.clear_display_name_cache()
        self.addCleanup(user_identity_service.clear_display_name_cache)

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)})

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the read as the Gateway does: the registered service, as the signed user."""

        request = json.loads(json.dumps(request_payload))
        self.kinds.append(request["ReadKind"])
        spec = WORKSPACE_READ_KINDS[request["ReadKind"]]
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        user_identity_service.clear_display_name_cache()
        with self._server_process(), user_identity_service.acting_identity(
            request["UserName"], request["UserDisplayName"]
        ):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        self.answers.append(answer)
        return answer, str(self.root), 0

    def _routes(self):
        return [
            ("project_settings_sources", project_settings_router.list_project_settings_sources),
            ("project_folders", lambda: project_settings_router.get_project_folders("project_map")),
            ("project_registry", lambda: project_settings_router.get_project_settings("project_map")),
            ("project_names", arcrho_router.arcrho_projects),
            ("general_settings", lambda: project_settings_router.get_general_settings(PROJECT)),
            ("dataset_types_table", lambda: dataset_types_router.get_dataset_types(PROJECT)),
            ("field_mapping", lambda: field_mapping_router.get_field_mapping(PROJECT)),
            ("source_table_settings", lambda: source_table_router.get_source_table(PROJECT)),
            ("source_table_settings", lambda: source_table_router.get_source_table_file_status(PROJECT)),
            ("mssql_connections", source_table_router.get_source_table_connections),
            (
                "dataset_number_format_defaults",
                lambda: dataset_router.get_dataset_number_format_defaults("Paid Loss"),
            ),
            ("user_identity", user_identity_router.get_user_identity),
            ("data_processing_rules", lambda: rules_router.get_data_processing_rules(PROJECT)),
            (
                "data_processing_rules_validate",
                lambda: rules_router.validate_data_processing_rules(
                    DataProcessingRulesValidateRequest(project_name=PROJECT, data={"rules": []})
                ),
            ),
        ]

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kind in KINDS:
            with self.subTest(kind):
                spec = WORKSPACE_READ_KINDS[kind]
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})

    def test_each_route_answers_the_same_through_the_gateway_as_on_the_server(self) -> None:
        for kind, route in self._routes():
            with self.subTest(route=kind):
                with self._server_process():
                    local = jsonable_encoder(route())
                self.kinds.clear()
                user_identity_service.clear_display_name_cache()
                hosted = route()

                self.assertEqual(self.kinds, [kind])
                self.assertEqual(hosted, local)

    def test_the_driver_and_the_external_csv_are_this_pcs_own(self) -> None:
        settings = source_table_router.get_source_table(PROJECT)
        status = source_table_router.get_source_table_file_status(PROJECT)

        self.assertNotIn("driver_available", self.answers[0])
        self.assertTrue(settings["driver_available"])
        self.assertEqual(self.kinds, ["source_table_settings", "source_table_settings"])
        self.assertEqual(status["csv_path"], str(self.external_csv))
        self.assertTrue(status["exists"])
        self.assertTrue(status["matches_import"])

    def test_the_identity_is_the_signed_users(self) -> None:
        self.assertEqual(
            user_identity_router.get_user_identity(),
            {"login_name": "alice", "display_name": "Alice Smith"},
        )

    def test_a_client_refuses_without_the_gateway(self) -> None:
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            for kind, route in self._routes():
                with self.subTest(route=kind):
                    with self.assertRaises(HTTPException) as refused:
                        route()
                    self.assertEqual(refused.exception.status_code, 503)
        self.assertEqual(self.kinds, [])

    def test_a_missing_project_name_is_refused_before_the_gateway(self) -> None:
        for route in (
            lambda: project_settings_router.get_general_settings(" "),
            lambda: dataset_types_router.get_dataset_types(""),
            lambda: field_mapping_router.get_field_mapping(""),
            lambda: source_table_router.get_source_table(""),
            lambda: rules_router.get_data_processing_rules(""),
        ):
            with self.assertRaises(HTTPException) as refused:
                route()
            self.assertEqual(refused.exception.status_code, 400)
        self.assertEqual(self.kinds, [])


if __name__ == "__main__":
    unittest.main()
