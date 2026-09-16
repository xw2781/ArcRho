from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
for path in (ROOT / "frontend", ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException
from arcrho_workspace_read_contract import HTTP_WORKSPACE_READ_KINDS
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS
from app_server.services import (
    dependent_propagation_service as service,
    engine_hosted_save_service,
    propagation_gateway_client as client,
    workspace_read_client as reads,
)


class PropagationGatewayTests(unittest.TestCase):
    request_id = "a" * 32

    def setUp(self):
        patches = (
            patch.object(reads, "_is_server_process", return_value=False),
            patch.object(reads.config, "load_gateway_config", return_value={
                "enabled": True, "url": "http://gateway", "user": "tester", "secret": "secret",
            }),
            patch.object(reads, "cached_gateway_capabilities", return_value={
                "workspace_read_kinds": list(HTTP_WORKSPACE_READ_KINDS),
                "workspace_mutation_kinds": list(WORKSPACE_MUTATION_KINDS),
            }),
            patch.object(reads, "_client_workspace_root", return_value="Z:/not-mounted"),
            patch.object(reads.config, "get_root_path", return_value="Z:/not-mounted"),
            patch.object(reads, "_log"),
            patch.object(service, "_workspace_server_root", side_effect=AssertionError("client filesystem access")),
            patch.object(reads.user_identity_service, "get_current_identity",
                         side_effect=AssertionError("client display-name share read")),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_all_client_operations_use_signed_gateway_requests_without_file_access(self):
        operations = (
            (lambda: service.require_engine_available(), "propagation_preflight"),
            (lambda: service.require_reserving_class_writable("Demo", "Class"), "propagation_preflight"),
            (lambda: service.require_project_scope_writable("Demo"), "propagation_preflight"),
            (lambda: service.get_reserving_class_busy("Demo", "Class"), "propagation_busy"),
            (lambda: service.get_dependent_propagation_status(self.request_id), "propagation_status"),
            (lambda: service.submit_dependent_propagation_job(
                "Demo", "Class", [{"dataset_name": "Paid"}], request_id=self.request_id,
            ), "propagation_submit"),
        )
        for operation, kind in operations:
            with self.subTest(kind=kind), patch.object(
                reads, "post_signed_json", return_value=({"ok": True}, "E:/server", 10),
            ) as post:
                operation()
                payload = post.call_args.args[2]
                self.assertEqual(payload.get("ReadKind") or payload.get("MutationKind"), kind)
                self.assertEqual(payload["UserName"], "tester")
                self.assertNotIn("Z:", str(payload))

    def test_disabled_unreachable_and_old_gateways_never_fall_back(self):
        for capabilities in (None, {}):
            with self.subTest(capabilities=capabilities), patch.object(
                reads, "cached_gateway_capabilities", return_value=capabilities,
            ):
                for operation in (
                    lambda: service.get_reserving_class_busy("Demo", "Class"),
                    lambda: service.submit_dependent_propagation_job("Demo", "Class", [{"dataset_name": "Paid"}]),
                ):
                    with self.assertRaises(HTTPException) as raised:
                        operation()
                    self.assertEqual(raised.exception.status_code, 503)
        with patch.object(reads.config, "load_gateway_config", return_value={"enabled": False}):
            with self.assertRaises(HTTPException) as raised:
                service.require_engine_available()
            self.assertEqual(raised.exception.status_code, 503)

    def test_lost_mutation_response_is_not_retried_locally(self):
        with patch.object(
            reads, "post_signed_json",
            side_effect=reads.GatewayTransportFailure("connection_lost", accepted=True),
        ) as post:
            with self.assertRaises(HTTPException) as raised:
                service.submit_dependent_propagation_job(
                    "Demo", "Class", [{"dataset_name": "Paid"}], request_id=self.request_id,
                )
        self.assertEqual(raised.exception.status_code, 504)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args[2]["Kwargs"]["request_id"], self.request_id)

    def test_invalid_arguments_return_bad_request_without_share_access(self):
        for operation in (
            lambda: client.read("propagation_status", {}),
            lambda: client.submit({}),
        ):
            with self.assertRaises(HTTPException) as raised:
                operation()
            self.assertEqual(raised.exception.status_code, 400)

    def test_transport_failures_do_not_read_the_share(self):
        for timed_out, expected in ((False, 503), (True, 504)):
            with self.subTest(timed_out=timed_out), patch.object(
                reads, "post_signed_json",
                side_effect=reads.GatewayTransportFailure("unreachable", timed_out=timed_out),
            ):
                with self.assertRaises(HTTPException) as raised:
                    service.get_dependent_propagation_status(self.request_id)
                self.assertEqual(raised.exception.status_code, expected)

    def test_remote_refusals_keep_their_status_codes(self):
        for status in (400, 404, 409, 423, 503):
            with self.subTest(status=status), patch.object(
                reads, "post_signed_json", side_effect=HTTPException(status, "refused"),
            ):
                with self.assertRaises(HTTPException) as raised:
                    service.require_reserving_class_writable("Demo", "Class")
                self.assertEqual(raised.exception.status_code, status)

    def test_progress_failure_returns_unknown_without_reading_share(self):
        with patch.object(
            engine_hosted_save_service.hosted_save_http_client,
            "fetch_hosted_save_progress", return_value=None,
        ), patch.object(engine_hosted_save_service, "read_save_job_status") as disk:
            result = engine_hosted_save_service.get_hosted_save_progress(self.request_id)
        self.assertEqual(result["status"], "unknown")
        disk.assert_not_called()

    def test_server_preflight_executes_locally_without_recursion(self):
        with patch.object(client, "is_server_process", return_value=True), patch.object(
            service, "_workspace_server_root", return_value=Path("server"),
        ), patch.object(service, "require_live_engine") as heartbeat, patch.object(client, "read") as remote:
            self.assertEqual(service.check_propagation_preflight("engine"), {"ok": True})
        heartbeat.assert_called_once_with(Path("server"))
        remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
