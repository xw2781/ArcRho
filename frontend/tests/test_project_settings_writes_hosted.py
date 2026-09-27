"""Project Settings writes run on the server host.

Creating, renaming and deleting a project folder, saving the project registry
and General Settings, and clearing the generated CSV caches go to the Gateway
from a Client PC and refuse when it cannot answer; a server process runs the
same service locally. The registry is guarded by a revision the server owns.
Every write here lands in a temporary root.
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
from app_server import config  # noqa: E402
from app_server.schemas.project_settings import (  # noqa: E402
    CreateProjectFolderRequest,
    DeleteProjectFolderRequest,
    GeneralSettingsUpdateRequest,
    GeneratedDatasetCacheClearRequest,
    ProjectSettingsUpdateRequest,
    RenameProjectFolderRequest,
)
from app_server.services import user_identity_service, workspace_read_client  # noqa: E402

router = importlib.import_module("app_server.api.project_settings_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
SOURCE = "project_map"
PROJECT = "Demo Project"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
KINDS = (
    "project_folder_create",
    "project_folder_rename",
    "project_folder_delete",
    "project_registry_save",
    "general_settings_save",
    "generated_dataset_cache_clear",
)
RECEIPT_KINDS = KINDS[:5]


class ProjectSettingsWritesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        (self.projects / PROJECT / "data").mkdir(parents=True)
        (self.projects / "index.json").write_text(
            json.dumps({"version": 1, "projects": [{"name": PROJECT, "folder": "Shared"}], "folders": []}),
            encoding="utf-8",
        )
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.requests: list[dict] = []
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "PROJECT_SETTINGS_DIR", str(self.projects)),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={
                    "workspace_read_kinds": ["project_registry"],
                    "workspace_mutation_kinds": list(KINDS),
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
        self.requests.append(request)
        if "ReadKind" in request:
            function = router.project_settings_service.get_project_settings
        else:
            spec = WORKSPACE_MUTATION_KINDS[request["MutationKind"]]
            function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with self._server_process(), user_identity_service.acting_identity(request["UserName"]):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _kinds(self) -> list[str]:
        return [request.get("MutationKind") or request.get("ReadKind") for request in self.requests]

    def _files(self) -> dict[str, bytes]:
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def _registry(self) -> dict:
        return json.loads((self.projects / "index.json").read_text(encoding="utf-8-sig"))

    def test_every_kind_names_a_service_that_takes_its_arguments(self) -> None:
        for kind in KINDS:
            with self.subTest(kind):
                spec = WORKSPACE_MUTATION_KINDS[kind]
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})
                self.assertEqual(spec.receipt, kind in RECEIPT_KINDS)

    def test_each_write_runs_on_the_gateway(self) -> None:
        router.create_project_folder(SOURCE, CreateProjectFolderRequest(name="Scratch"))
        self.assertTrue((self.projects / "Scratch" / "data").is_dir())
        router.rename_project_folder(SOURCE, RenameProjectFolderRequest(old_name="Scratch", new_name="Scratch 2"))
        self.assertTrue((self.projects / "Scratch 2").is_dir())
        saved = router.update_general_settings(
            GeneralSettingsUpdateRequest(project_name="Scratch 2", origin_start_date="2020,01", auto_generated=True)
        )
        self.assertEqual(saved["data"]["origin_start_date"], "202001")
        cleared = router.clear_generated_dataset_csv_caches(
            SOURCE, GeneratedDatasetCacheClearRequest(project_name="Scratch 2")
        )
        self.assertEqual(cleared["cleared_count"], 0)
        registry = router.update_project_settings(
            SOURCE, ProjectSettingsUpdateRequest(project_paths=["Shared\\Demo Project", "Scratch 2"])
        )
        self.assertEqual(registry["revision"], 1)
        router.delete_project_folder(SOURCE, DeleteProjectFolderRequest(name="Scratch 2"))
        self.assertFalse((self.projects / "Scratch 2").exists())

        self.assertEqual(
            self._kinds(),
            [
                "project_folder_create",
                "project_folder_rename",
                "general_settings_save",
                "generated_dataset_cache_clear",
                "project_registry_save",
                "project_folder_delete",
            ],
        )
        self.assertEqual({request["UserName"] for request in self.requests}, {"alice"})

    def test_a_caller_request_id_travels_as_the_request_id(self) -> None:
        router.create_project_folder(SOURCE, CreateProjectFolderRequest(name="Scratch", request_id="create-1"))
        self.assertEqual(self.requests[-1]["RequestId"], "create-1")

    def test_the_registry_save_names_the_revision_it_read(self) -> None:
        read = router.get_project_settings(SOURCE)
        self.assertEqual(read["revision"], 0)
        self.assertNotIn("mtime", read)

        first = router.update_project_settings(
            SOURCE, ProjectSettingsUpdateRequest(project_paths=["Demo Project"], expected_revision=0)
        )
        self.assertEqual(first["revision"], 1)
        self.assertEqual(self._registry()["revision"], 1)
        self.assertEqual(router.get_project_settings(SOURCE)["revision"], 1)

        before = self._files()
        with self.assertRaises(HTTPException) as stale:
            router.update_project_settings(
                SOURCE, ProjectSettingsUpdateRequest(project_paths=["Other"], expected_revision=0)
            )
        self.assertEqual(stale.exception.status_code, 409)
        self.assertEqual(self._files(), before)

        second = router.update_project_settings(
            SOURCE, ProjectSettingsUpdateRequest(project_paths=["Other"], expected_revision=1)
        )
        self.assertEqual(second["revision"], 2)
        self.assertEqual([p["name"] for p in self._registry()["projects"]], ["Other"])

    def test_a_client_refuses_without_the_gateway(self) -> None:
        before = self._files()
        routes = (
            lambda: router.create_project_folder(SOURCE, CreateProjectFolderRequest(name="Scratch")),
            lambda: router.rename_project_folder(
                SOURCE, RenameProjectFolderRequest(old_name=PROJECT, new_name="Renamed")
            ),
            lambda: router.delete_project_folder(SOURCE, DeleteProjectFolderRequest(name=PROJECT)),
            lambda: router.update_project_settings(SOURCE, ProjectSettingsUpdateRequest(project_paths=[])),
            lambda: router.update_general_settings(GeneralSettingsUpdateRequest(project_name=PROJECT)),
            lambda: router.clear_generated_dataset_csv_caches(
                SOURCE, GeneratedDatasetCacheClearRequest(project_name=PROJECT)
            ),
        )
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            for route in routes:
                with self.assertRaises(HTTPException) as refused:
                    route()
                self.assertEqual(refused.exception.status_code, 503)
        self.assertEqual(self.requests, [])
        self.assertEqual(self._files(), before)


if __name__ == "__main__":
    unittest.main()
