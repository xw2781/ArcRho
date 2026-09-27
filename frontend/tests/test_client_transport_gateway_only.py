"""A Client PC reaches the server only through the Gateway; every failure is an error.

Each failure class — no credential, an unreadable credential, a Gateway that
does not answer, one that does not offer the operation, a refused signature,
a lost connection — is checked for the three transports (reads, mutations,
Engine calculations) on a Client PC, where the operation must never run in
this process, and in a server process, where it always does.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_api import config as api_config
from arcrho_hosted_save_http_contract import HostedSaveHttpContractError
from app_server import config
from app_server.services import (
    engine_calculation_service,
    hosted_save_http_client,
    workspace_mutation_client,
    workspace_read_client,
)
from app_server.services.workspace_read_client import GatewayTransportFailure

GATEWAY = {"enabled": True, "url": "http://gateway.test:28767", "user": "alice", "secret": "s"}
CAPABILITIES = {
    "workspace_read_kinds": ["dataset_index"],
    "workspace_mutation_kinds": ["dataset_index_rebuild"],
    "engine_calculation_functions": ["ArcRhoTri"],
    "engine_calculation_operations": ["exchange"],
}
PAIRS = [
    ("Function", "ArcRhoTri"),
    ("Path", "Class"),
    ("DatasetName", "Paid"),
    ("InstanceName", "Paid"),
    ("ProjectName", "Demo"),
    ("OriginLength", "12"),
    ("DevelopmentLength", "12"),
]


def _unreadable_credential():
    raise HostedSaveHttpContractError("Gateway configuration could not be read.")


class _Ran(Exception):
    """The operation ran in this process."""


def _local():
    raise _Ran()


class ClientTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(workspace_read_client, "_log"),
            patch.object(engine_calculation_service.client_save_latency_log_service, "append_client_read_latency"),
            patch.object(engine_calculation_service, "publish_and_wait", side_effect=_Ran),
            patch.object(engine_calculation_service, "calculate_in_process", side_effect=_Ran),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _operations(self):
        return {
            "read": lambda: workspace_read_client.run_workspace_read(
                "dataset_index", {"project_name": "Demo", "reserving_class": "Class"}, local=_local
            ),
            "mutation": lambda: workspace_mutation_client.run_workspace_mutation(
                "dataset_index_rebuild", {"project_name": "Demo", "reserving_class": "Class"}, local=_local
            ),
            "calculation": lambda: engine_calculation_service.run_engine_calculation(
                PAIRS, str(FRONTEND_ROOT / "never.csv"), 15.0
            ),
        }

    def _assert_refused(self, status: int, message: str) -> None:
        for name, operation in self._operations().items():
            with self.subTest(transport=name):
                with self.assertRaises(HTTPException) as refused:
                    operation()
                self.assertEqual(refused.exception.status_code, status)
                self.assertEqual(refused.exception.detail, message)

    def test_no_credential_asks_the_user_to_sign_in(self) -> None:
        with patch.object(config, "load_gateway_config", return_value={"enabled": False}):
            self._assert_refused(401, hosted_save_http_client.NOT_SIGNED_IN_MESSAGE)

    def test_an_unreadable_credential_asks_the_user_to_sign_in(self) -> None:
        with patch.object(config, "load_gateway_config", side_effect=_unreadable_credential):
            self._assert_refused(401, hosted_save_http_client.NOT_SIGNED_IN_MESSAGE)

    def test_a_silent_gateway_says_the_server_cannot_be_reached(self) -> None:
        with patch.object(config, "load_gateway_config", return_value=GATEWAY), patch.object(
            hosted_save_http_client, "probe_gateway", side_effect=HTTPException(503, "offline")
        ):
            self._assert_refused(503, hosted_save_http_client.SERVER_UNREACHABLE_MESSAGE)

    def test_a_gateway_without_the_operation_needs_updating(self) -> None:
        with patch.object(config, "load_gateway_config", return_value=GATEWAY), patch.object(
            workspace_read_client, "cached_gateway_capabilities", return_value={}
        ):
            self._assert_refused(503, hosted_save_http_client.SERVER_UPDATE_MESSAGE)

    def _sent(self, failure: GatewayTransportFailure):
        return (
            patch.object(config, "load_gateway_config", return_value=GATEWAY),
            patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=CAPABILITIES),
            patch.object(workspace_read_client, "post_signed_json", side_effect=failure),
            patch.object(engine_calculation_service, "post_signed_json", side_effect=failure),
        )

    def test_a_refused_signature_asks_the_user_to_sign_in_again(self) -> None:
        for code in (401, 403):
            patches = self._sent(GatewayTransportFailure(f"gateway_rejected:{code}"))
            with patches[0], patches[1], patches[2], patches[3], self.subTest(code=code):
                self._assert_refused(401, hosted_save_http_client.SIGN_IN_MESSAGE)

    def test_a_gateway_without_the_route_needs_updating(self) -> None:
        patches = self._sent(GatewayTransportFailure("gateway_rejected:404"))
        with patches[0], patches[1], patches[2], patches[3]:
            self._assert_refused(503, hosted_save_http_client.SERVER_UPDATE_MESSAGE)

    def test_a_connection_that_never_reached_the_server_is_unreachable(self) -> None:
        patches = self._sent(GatewayTransportFailure("gateway_unreachable"))
        with patches[0], patches[1], patches[2], patches[3]:
            self._assert_refused(503, hosted_save_http_client.SERVER_UNREACHABLE_MESSAGE)

    def test_an_answer_lost_after_sending_is_unconfirmed_not_rerun(self) -> None:
        patches = self._sent(GatewayTransportFailure("gateway_connection_lost", accepted=True))
        with patches[0], patches[1], patches[2], patches[3]:
            operations = self._operations()
            with self.assertRaises(HTTPException) as read:
                operations["read"]()
            with self.assertRaises(HTTPException) as mutation:
                operations["mutation"]()
            calculation = operations["calculation"]()
        # A read changes nothing, so the user may simply ask again.
        self.assertEqual(read.exception.status_code, 503)
        self.assertEqual(mutation.exception.status_code, 504)
        self.assertEqual((calculation["ok"], calculation["status"]), (False, "gateway_error"))

    def test_a_polled_read_is_unknown_whatever_the_gateway_failure(self) -> None:
        for gateway in ({"enabled": False}, GATEWAY):
            with self.subTest(enabled=gateway["enabled"]), patch.object(
                config, "load_gateway_config", return_value=gateway
            ), patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None):
                answer = workspace_read_client.run_polled_workspace_read(
                    "dataset_index", {"project_name": "Demo"}, local=_local, unknown={"ok": True}
                )
                self.assertEqual(answer, {"ok": True, "unknown": True})


class ServerProcessTransportTests(unittest.TestCase):
    """A server process runs every operation itself and never asks a Gateway."""

    def test_a_server_process_runs_in_place_without_a_credential(self) -> None:
        with patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(FRONTEND_ROOT)}), patch.object(
            config, "load_gateway_config", side_effect=AssertionError("asked for a credential")
        ), patch.object(workspace_read_client, "_log"), patch.object(
            engine_calculation_service.client_save_latency_log_service, "append_client_read_latency"
        ), patch.object(engine_calculation_service, "calculate_in_process", return_value=None), patch.object(
            engine_calculation_service,
            "publish_and_wait",
            return_value={"ok": True, "status": "completed", "request_file": "r.json", "wait_ms": 1.0},
        ):
            read = workspace_read_client.run_workspace_read("dataset_index", {}, local=lambda: {"ran": "read"})
            mutation = workspace_mutation_client.run_workspace_mutation(
                "dataset_index_rebuild", {}, local=lambda: {"ran": "mutation"}
            )
            calculation = engine_calculation_service.run_engine_calculation(PAIRS, "unused.csv", 15.0)
        self.assertEqual((read, mutation), ({"ran": "read"}, {"ran": "mutation"}))
        self.assertEqual((calculation["ok"], calculation["transport"]), (True, "smb"))


if __name__ == "__main__":
    unittest.main()
