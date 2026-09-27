"""The period headings and their cache clear run on the server host.

``POST /arcrho/headers`` is the ``arcrho_headers`` workspace read: the
settings check, the cache lookup and any Engine run happen where the workspace
is local disk, and the Client PC gets the labels in the reply. The cache clear
is the idempotent ``arcrho_headers_cache_clear`` mutation. Both are
Gateway-required: a Client PC never falls back to its mapped drive.
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
from arcrho_engine_calculation_contract import ENGINE_CALCULATION_CSV_FIELD  # noqa: E402
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402
from app_server import config  # noqa: E402
from app_server.helpers import set_data_path_like_vba  # noqa: E402
from app_server.schemas.arcrho import ArcRhoHeadersCacheClearRequest, ArcRhoHeadersRequest  # noqa: E402
from app_server.services import (  # noqa: E402
    arcrho_runtime_service,
    engine_calculation_service,
    file_read_cache,
    project_settings_service,
    user_identity_service,
    workspace_read_client,
)

arcrho_router = importlib.import_module("app_server.api.arcrho_router")

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROJECT = "Demo Project"
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}
HEADER_TEXT = "2020,2021,2022\r\n"


class ArcRhoHeadersHostedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data_dir = self.root / "projects" / PROJECT / "data"
        self.data_dir.mkdir(parents=True)
        settings_path = self.root / "projects" / PROJECT / "general_settings.json"
        settings_path.write_text("{}", encoding="utf-8")
        os.utime(settings_path, (0, 0))
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        env.update({api_config.SERVER_ROOT_ENV: str(self.root), "USERNAME": "alice"})
        self.requests: list[tuple[str, str]] = []
        self.gateway_failure: Exception | None = None
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "get_project_data_dir", return_value=str(self.data_dir)),
            patch.object(
                project_settings_service,
                "get_general_settings",
                return_value={
                    "ok": True,
                    "exists": True,
                    "path": str(settings_path),
                    "data": {"origin_start_date": "202001"},
                },
            ),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={
                    "workspace_read_kinds": ["arcrho_headers"],
                    "workspace_mutation_kinds": ["arcrho_headers_cache_clear"],
                },
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)
        self.addCleanup(file_read_cache.clear_file_read_cache)

    def _server_process(self):
        return patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(self.root)})

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the request as the Gateway does: the registered service, as the signed user."""

        if self.gateway_failure is not None:
            raise self.gateway_failure
        request = json.loads(json.dumps(request_payload))
        if "ReadKind" in request:
            kind, spec = request["ReadKind"], WORKSPACE_READ_KINDS[request["ReadKind"]]
        else:
            kind, spec = request["MutationKind"], WORKSPACE_MUTATION_KINDS[request["MutationKind"]]
        self.requests.append((kind, request["UserDisplayName"]))
        function = getattr(importlib.import_module(f"app_server.services.{spec.module}"), spec.function)
        with self._server_process(), user_identity_service.acting_identity(request["UserName"]):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.root), 0

    def _header_path(self, length: int = 12) -> Path:
        return Path(set_data_path_like_vba(arcrho_runtime_service._header_cache_pairs(PROJECT, 0, False, length)))

    def _write_headers(self, length: int = 12) -> Path:
        path = self._header_path(length)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(HEADER_TEXT)
        return path

    def test_both_kinds_name_a_service_that_takes_their_arguments(self) -> None:
        for spec in (WORKSPACE_READ_KINDS["arcrho_headers"], WORKSPACE_MUTATION_KINDS["arcrho_headers_cache_clear"]):
            with self.subTest(spec.function):
                module = importlib.import_module(f"app_server.services.{spec.module}")
                signature = inspect.signature(getattr(module, spec.function))
                signature.bind(**{name: "x" for name in spec.required})
                signature.bind(**{name: "x" for name in spec.allowed})

    def test_the_headings_come_from_the_server_as_the_server_reads_them(self) -> None:
        self._write_headers()
        request = ArcRhoHeadersRequest(ProjectName=PROJECT, PeriodLength=12)
        with self._server_process():
            local = jsonable_encoder(arcrho_router.arcrho_headers(request))
        self.requests.clear()

        hosted = arcrho_router.arcrho_headers(request)

        self.assertEqual(self.requests, [("arcrho_headers", "")])
        self.assertEqual(hosted, local)
        self.assertEqual(hosted["labels"], ["2020", "2021", "2022"])

    def test_the_request_keeps_the_route_pairs_and_their_order(self) -> None:
        seen = []

        def fake_headers(pairs, timeout_sec):
            seen.append((list(pairs), timeout_sec))
            return {"ok": True, "labels": []}

        request = ArcRhoHeadersRequest(
            ProjectName=PROJECT, PeriodLength=3, periodType=1, Transposed=True, Calendar=True,
            StoredPeriodLength=12, timeout_sec=7.5,
        )
        with patch.object(arcrho_runtime_service, "arcrho_headers", fake_headers):
            arcrho_router.arcrho_headers(request)
        self.assertEqual(
            seen,
            [(
                [
                    ("Function", "ArcRhoHeaders"),
                    ("periodType", "1"),
                    ("Transposed", "True"),
                    ("Calendar", "True"),
                    ("PeriodLength", "3"),
                    ("ProjectName", PROJECT),
                    ("StoredPeriodLength", "12"),
                ],
                7.5,
            )],
        )

    def test_without_the_gateway_the_headings_are_refused_not_read_from_the_drive(self) -> None:
        self._write_headers()
        cases = {
            "disabled": (401, patch.object(config, "load_gateway_config", return_value={"enabled": False})),
            "unreachable": (503, patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None)),
        }
        for label, (status, gateway_patch) in cases.items():
            with self.subTest(gateway=label), gateway_patch, patch.object(
                arcrho_runtime_service, "arcrho_headers", side_effect=AssertionError("ran on a Client PC")
            ):
                with self.assertRaises(HTTPException) as refused:
                    arcrho_router.arcrho_headers(ArcRhoHeadersRequest(ProjectName=PROJECT, PeriodLength=12))
                self.assertEqual(refused.exception.status_code, status)
        self.assertEqual(self.requests, [])

    def test_the_cache_clear_runs_on_the_server_and_a_repeat_changes_nothing(self) -> None:
        path = self._write_headers()
        request = ArcRhoHeadersCacheClearRequest(ProjectName=PROJECT, OriginLength=12, DevelopmentLength=12)

        first = arcrho_router.clear_arcrho_headers_cache(request)
        second = arcrho_router.clear_arcrho_headers_cache(request)

        self.assertEqual(self.requests, [("arcrho_headers_cache_clear", "")] * 2)
        self.assertFalse(path.exists())
        self.assertEqual(first["cleared_files"], [path.name])
        self.assertEqual(second["cleared_count"], 0)

    def test_the_cache_clear_is_refused_without_the_gateway(self) -> None:
        path = self._write_headers()
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            with self.assertRaises(HTTPException) as refused:
                arcrho_router.clear_arcrho_headers_cache(ArcRhoHeadersCacheClearRequest(ProjectName=PROJECT))
        self.assertEqual(refused.exception.status_code, 401)
        self.assertTrue(path.exists())

    def test_a_hosted_exchange_answer_is_read_from_the_reply_not_the_drive(self) -> None:
        # Wherever the headings still run beside a hosted exchange, the labels
        # come from the reply; the drive never has the file.
        def hosted_exchange(pairs, data_path, timeout_sec, **kwargs):
            return {"ok": True, "status": "completed", "request_file": "r.json",
                    "transport": "http_gateway", ENGINE_CALCULATION_CSV_FIELD: HEADER_TEXT}

        with patch.object(engine_calculation_service, "run_engine_calculation", hosted_exchange), \
                patch.object(file_read_cache, "read_text_file_cached", side_effect=AssertionError("drive read")):
            answer = arcrho_runtime_service.get_project_headers(PROJECT, 12, 15.0)

        self.assertEqual(answer["labels"], ["2020", "2021", "2022"])
        self.assertFalse(self._header_path().exists())


if __name__ == "__main__":
    unittest.main()
