"""Reserving-class reads and per-user preferences run on the server host.

A Client PC asks the Gateway for each route's whole answer and refuses when
it cannot; a server process runs the same service locally. No GET writes a
file, the preference writes land in the signed user's own file, and the
hidden paths, filter spec and tree preferences are whole-value writes.
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
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.schemas.project_user_preferences import ProjectUserPreferencesUpdateRequest  # noqa: E402
from app_server.schemas.reserving_class import (  # noqa: E402
    ReservingClassFilterSpecSaveRequest,
    ReservingClassHiddenPathsSaveRequest,
)
from app_server.services import user_identity_service, workspace_read_client  # noqa: E402

rc_router = importlib.import_module("app_server.api.reserving_class_router")
prefs_router = importlib.import_module("app_server.api.project_user_preferences_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROJECT = "Demo Project"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
READ_KINDS = (
    "reserving_class_combinations",
    "reserving_class_path_tree",
    "reserving_class_path_tree_children",
    "reserving_class_types",
    "reserving_class_hidden_paths",
    "reserving_class_filter_spec",
    "project_user_preferences",
    "reserving_classes_with_data",
)
MUTATION_KINDS = (
    "reserving_class_hidden_paths_save",
    "reserving_class_filter_spec_save",
    "project_user_preferences_update",
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


class ReservingClassHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        projects = self.root / "projects"
        self.project = projects / PROJECT
        fields = [{"field_name": "STATE", "level": 1}, {"field_name": "LOB", "level": 2}]
        _write_json(self.project / "reserving_class_combinations_cache.json", {
            "fields": fields,
            "combinations": ["NJ\\Auto", "NJ\\Home", "NY\\Auto"],
            "field_signature": "sig",
            "table_path": "",
        })
        _write_json(self.project / "reserving_class_values.json", {"fields": [
            {"field_name": "STATE", "level": 1, "distinct_values": ["NJ", "NY"]},
            {"field_name": "LOB", "level": 2, "distinct_values": ["Auto", "Home"]},
        ]})
        _write_json(self.project / "reserving_class_types.json", {
            "columns": ["Name", "Level", "Formula", "Source"],
            "rows": [["NJ", "1", "", "NJ"], ["NY", "1", "", "NY"], ["East", "1", "NJ + NY", "NJ + NY"]],
        })
        _write_json(self.project / "reserving_class_path_tree_cache.json", {
            "mode": "lazy", "levels": [], "paths": ["NJ"], "tree": {"name": "All", "children": []},
        })

        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.kinds: list[str] = []
        self.requests: list[dict] = []
        self.gateway_user = "alice"
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(projects)),
            patch.object(config, "load_gateway_config", side_effect=lambda: dict(GATEWAY, user=self.gateway_user)),
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
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)})

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the request as the Gateway does: the registered service, as the signed user."""

        request = json.loads(json.dumps(request_payload))
        kind = request.get("ReadKind") or request.get("MutationKind")
        self.kinds.append(kind)
        self.requests.append(request)
        spec = WORKSPACE_READ_KINDS.get(request.get("ReadKind")) or WORKSPACE_MUTATION_KINDS[kind]
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with self._server_process(), user_identity_service.acting_identity(request["UserName"]):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _reads(self):
        return [
            ("reserving_class_combinations", lambda: rc_router.get_reserving_class_combinations(PROJECT)),
            ("reserving_class_path_tree", lambda: rc_router.get_reserving_class_path_tree(PROJECT)),
            ("reserving_class_path_tree_children", lambda: rc_router.get_reserving_class_path_tree_children(PROJECT)),
            (
                "reserving_class_path_tree_children",
                lambda: rc_router.get_reserving_class_path_tree_children(PROJECT, prefix="East", force=True),
            ),
            ("reserving_class_types", lambda: rc_router.get_reserving_class_types(PROJECT)),
            ("reserving_class_hidden_paths", lambda: rc_router.get_reserving_class_hidden_paths(PROJECT)),
            ("reserving_class_filter_spec", lambda: rc_router.get_reserving_class_filter_spec(PROJECT)),
            ("project_user_preferences", lambda: prefs_router.get_project_user_preferences(PROJECT)),
            ("reserving_classes_with_data", lambda: rc_router.get_reserving_class_paths_with_data(PROJECT)),
        ]

    def _writes(self):
        return [
            ("reserving_class_hidden_paths_save", lambda: rc_router.save_reserving_class_hidden_paths(
                ReservingClassHiddenPathsSaveRequest(project_name=PROJECT, hidden_paths=["NJ\\Home"])
            )),
            ("reserving_class_filter_spec_save", lambda: rc_router.save_reserving_class_filter_spec(
                ReservingClassFilterSpecSaveRequest(project_name=PROJECT, filter_spec={"1": ["NJ"]})
            )),
            ("project_user_preferences_update", lambda: prefs_router.update_project_user_preferences(
                ProjectUserPreferencesUpdateRequest(project_name=PROJECT, data={"datasetViewer": {"datasetName": "Paid"}})
            )),
        ]

    def _files(self) -> dict[str, tuple[bytes, int]]:
        return {
            str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in self.root.rglob("*")
            if path.is_file()
        }

    def _prefs(self, user: str = "alice") -> dict:
        return json.loads((self.project / "users" / user / "preferences.json").read_text(encoding="utf-8"))

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kind in READ_KINDS + MUTATION_KINDS:
            with self.subTest(kind):
                spec = WORKSPACE_READ_KINDS.get(kind) or WORKSPACE_MUTATION_KINDS[kind]
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})

    def test_each_read_answers_the_same_through_the_gateway_as_on_the_server(self) -> None:
        for kind, route in self._reads():
            with self.subTest(route=kind):
                with self._server_process():
                    local = jsonable_encoder(route())
                self.kinds.clear()
                hosted = route()

                self.assertEqual(self.kinds, [kind])
                self.assertEqual(hosted, local)

    def test_no_read_writes_a_file(self) -> None:
        # A missing types file was written by the old read; it stays missing.
        (self.project / "reserving_class_types.json").unlink()
        before = self._files()
        for kind, route in self._reads():
            with self.subTest(route=kind):
                with self._server_process():
                    route()
        self.assertEqual(self._files(), before)

    def test_children_come_from_the_combinations_and_types_as_they_stand(self) -> None:
        with self._server_process():
            root = rc_router.get_reserving_class_path_tree_children(PROJECT)
            east = rc_router.get_reserving_class_path_tree_children(PROJECT, prefix="East")

        self.assertEqual([child["name"] for child in root["children"]], ["East", "NJ", "NY"])
        self.assertEqual([child["path"] for child in east["children"]], ["East\\Auto", "East\\Home"])
        self.assertFalse(east["children"][0]["has_children"])

    def test_the_types_read_shows_the_merge_without_writing_it(self) -> None:
        with self._server_process():
            out = rc_router.get_reserving_class_types(PROJECT)
        self.assertEqual(sorted(row[0] for row in out["data"]["rows"]), ["Auto", "East", "Home", "NJ", "NY"])
        stored = json.loads((self.project / "reserving_class_types.json").read_text(encoding="utf-8"))
        self.assertEqual([row[0] for row in stored["rows"]], ["NJ", "NY", "East"])
        self.assertFalse((self.project / "reserving_class_types.xlsx").exists())

    def test_each_write_answers_the_same_through_the_gateway_as_on_the_server(self) -> None:
        for kind, route in self._writes():
            with self.subTest(route=kind):
                with self._server_process():
                    local = jsonable_encoder(route())
                self.kinds.clear()
                hosted = route()

                self.assertEqual(self.kinds, [kind])
                local.get("data", {}).pop("updated_at", None)
                hosted.get("data", {}).pop("updated_at", None)
                self.assertEqual(hosted, local)

    def test_the_login_is_the_signed_users_never_a_payload_field(self) -> None:
        self.gateway_user = "bob"
        for _kind, route in self._writes():
            route()
        self.assertEqual({request["UserName"] for request in self.requests}, {"bob"})
        self.assertNotIn("bob", json.dumps([request["Kwargs"] for request in self.requests]))
        self.assertEqual(self._prefs("bob")["reservingClassTree"]["hiddenPaths"], ["NJ\\Home"])
        self.assertFalse((self.project / "users" / "alice").exists())

    def test_filter_spec_and_tree_preferences_are_whole_values(self) -> None:
        rc_router.save_reserving_class_filter_spec(ReservingClassFilterSpecSaveRequest(
            project_name=PROJECT,
            filter_spec={"1": ["NJ"], "2": ["Auto"]},
            preferences={"favorite_paths": ["NJ\\Auto"]},
        ))
        out = rc_router.save_reserving_class_filter_spec(ReservingClassFilterSpecSaveRequest(
            project_name=PROJECT, filter_spec={"1": ["NJ"]}, preferences={},
        ))

        tree = self._prefs()["reservingClassTree"]
        self.assertEqual(tree["filterSpec"], {"1": ["nj"]})
        self.assertNotIn("favorite_paths", tree["preferences"])
        self.assertEqual(out["filter_spec"], {"1": ["nj"]})
        self.assertNotIn("favorite_paths", out["preferences"])

    def test_omitted_tree_preferences_keep_the_stored_ones(self) -> None:
        rc_router.save_reserving_class_filter_spec(ReservingClassFilterSpecSaveRequest(
            project_name=PROJECT, filter_spec={}, preferences={"favorite_paths": ["NJ"]},
        ))
        out = rc_router.save_reserving_class_filter_spec(ReservingClassFilterSpecSaveRequest(
            project_name=PROJECT, filter_spec={"2": ["Auto"]},
        ))
        self.assertEqual(out["preferences"]["favorite_paths"], ["NJ"])
        self.assertEqual(self._prefs()["reservingClassTree"]["preferences"]["favorite_paths"], ["NJ"])

    def test_a_repeated_write_lands_the_same_state(self) -> None:
        for kind, route in self._writes():
            with self.subTest(route=kind):
                route()
                first = self._prefs()
                route()
                second = self._prefs()
                for data in (first, second):
                    data.pop("updated_at")
                    data.get("reservingClassTree", {}).pop("updated_at", None)
                self.assertEqual(second, first)

    def test_a_client_refuses_without_the_gateway(self) -> None:
        before = self._files()
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            for kind, route in self._reads() + self._writes():
                with self.subTest(route=kind):
                    with self.assertRaises(HTTPException) as refused:
                        route()
                    self.assertEqual(refused.exception.status_code, 401)
        self.assertEqual(self.kinds, [])
        self.assertEqual(self._files(), before)

    def test_a_missing_project_name_is_refused_before_the_gateway(self) -> None:
        for route in (
            lambda: rc_router.get_reserving_class_combinations(" "),
            lambda: rc_router.get_reserving_class_path_tree_children(""),
            lambda: rc_router.get_reserving_class_types(""),
            lambda: rc_router.get_reserving_class_filter_spec(""),
            lambda: rc_router.save_reserving_class_hidden_paths(
                ReservingClassHiddenPathsSaveRequest(project_name=" ", hidden_paths=[])
            ),
        ):
            with self.assertRaises(HTTPException) as refused:
                route()
            self.assertEqual(refused.exception.status_code, 400)
        self.assertEqual(self.kinds, [])


if __name__ == "__main__":
    unittest.main()
