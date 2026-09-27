from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_engine_save_contract import SAVE_JOB_KINDS
from arcrho_hosted_save_http_contract import HTTP_SAVE_KINDS
from app_server.services import (
    client_save_latency_log_service,
    dependent_propagation_service,
    engine_hosted_save_service,
    workspace_read_client,
)
from app_server.services.hosted_save_http_client import (
    NOT_SIGNED_IN_MESSAGE,
    SERVER_UNREACHABLE_MESSAGE,
    SERVER_UPDATE_MESSAGE,
)


GATEWAY_CONFIG = {
    "enabled": True,
    "url": "http://gateway.test:28767",
    "user": "xwei",
    "secret": "pilot-secret",
    "allow_insecure_http": True,
}


class EngineHostedSaveClientTests(unittest.TestCase):
    """The client half: send the save to the Gateway and map its outcome.

    A Client PC has no request-file route to the Engine: every save goes
    through the Gateway, and a Gateway that cannot take it is the error.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.latency_log_path = self.root / "local_appdata" / "client_save_latency.jsonl"
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)
        self.gateway_config = dict(GATEWAY_CONFIG)
        self.capabilities = self._capabilities()
        for target, name, kwargs in (
            (workspace_read_client, "_is_server_process", {"return_value": False}),
            (
                client_save_latency_log_service.config,
                "get_client_save_latency_log_path",
                {"return_value": str(self.latency_log_path)},
            ),
            (
                engine_hosted_save_service.config,
                "load_gateway_config",
                {"side_effect": lambda: self.gateway_config},
            ),
            (
                engine_hosted_save_service.hosted_save_http_client,
                "probe_gateway",
                {"side_effect": lambda _config: self.capabilities},
            ),
            (
                engine_hosted_save_service.user_identity_service,
                "get_windows_login_name",
                {"return_value": "xwei"},
            ),
            (
                dependent_propagation_service,
                "require_reserving_class_writable",
                {"side_effect": AssertionError("a client save must not preflight the share")},
            ),
        ):
            patcher = patch.object(target, name, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _latency_records(self) -> list[dict]:
        if not self.latency_log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.latency_log_path.read_text(encoding="utf-8").splitlines()
        ]

    def _capabilities(self, save_kinds=None) -> dict:
        """What ``/api/capabilities`` returns for a reachable gateway."""

        return {
            "ok": True,
            "hosted_save_http": True,
            "contract_version": 1,
            "allowed_save_kinds": list(
                HTTP_SAVE_KINDS if save_kinds is None else save_kinds
            ),
            "insecure_http_pilot": True,
        }

    def _submit(self, **kwargs):
        return patch.object(
            engine_hosted_save_service.hosted_save_http_client,
            "submit_hosted_save",
            **kwargs,
        )

    def _assert_refused(self, status: int, message: str, reason: str) -> None:
        with self._submit(
            side_effect=AssertionError("a refused save must never be posted")
        ):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "cape_cod_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, status)
        self.assertEqual(raised.exception.detail, message)
        round_trip = self._latency_records()[-1]
        self.assertEqual(round_trip["event"], "hosted_save_round_trip")
        self.assertEqual(round_trip["outcome"], "error")
        self.assertEqual(round_trip["http_status"], status)
        self.assertEqual(round_trip["reason"], reason)
        self.assertEqual(round_trip["failure_stage"], "gateway_capability")
        self.assertEqual(list(self.root.iterdir()), [self.latency_log_path.parent])

    def test_dataset_save_uses_the_http_gateway(self) -> None:
        with self._submit(
            return_value=(
                {"ok": True, "source_kind": "input"},
                {
                    "gateway_round_trip_ms": 25.0,
                    "gateway_attempts": 1,
                    "request_bytes": 512,
                },
            ),
        ) as submit:
            result = engine_hosted_save_service.run_hosted_save(
                "dataset_sidecar",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", "Paid Input"],
                kwargs={"values": [[1.0]]},
            )

        self.assertTrue(result["ok"])
        request = submit.call_args.args[1]
        self.assertEqual(request["SaveKind"], "dataset_sidecar")
        self.assertEqual(request["UserName"], "xwei")
        self.assertEqual(request["UserDisplayName"], "")
        self.assertEqual(request["Kwargs"]["values"], [[1.0]])
        round_trip = self._latency_records()[-1]
        self.assertEqual(round_trip["transport"], "http_gateway")
        self.assertEqual(round_trip["result_source"], "http_gateway")
        self.assertEqual(round_trip["outcome"], "success")
        self.assertEqual(round_trip["request_bytes"], 512)
        for phase in (
            "gateway_capability_ms",
            "identity_lookup_ms",
            "request_encode_ms",
            "gateway_round_trip_ms",
            "remote_round_trip_ms",
        ):
            self.assertGreaterEqual(round_trip["phase_ms"][phase], 0, phase)

    def test_dfm_plan_and_save_use_the_exact_http_gateway_request(self) -> None:
        method = {
            "json_format": "arcrho-dfm-v4",
            "details_tab": {
                "name": "C 22 - CWOP DFM w/ Selected LDFs",
                "output_dataset": "CWOP Ultimate",
            },
            "data_tab": {"values": [[100.0, 120.0], [90.0]]},
            "ratios_tab": {"selected": [[True], []]},
        }
        kwargs = {
            "notes": "transport parity",
            "expected_owned_revision": "owned-123",
            "expected_derived_revision": "derived-123",
        }
        responses = [
            {"ok": True, "plan_fingerprint": "plan-123", "dependents": []},
            {"ok": True, "method": method, "propagation": {"status": "unchanged"}},
        ]
        submitted: list[dict] = []

        def submit(_config, request, **_kwargs):
            submitted.append(request)
            return responses[len(submitted) - 1], {
                "gateway_round_trip_ms": 25.0,
                "gateway_attempts": 1,
                "request_bytes": 1024,
            }

        with self._submit(side_effect=submit):
            plan = engine_hosted_save_service.run_hosted_save_plan(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", method],
                kwargs=kwargs,
            )
            saved = engine_hosted_save_service.run_hosted_save(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", method],
                kwargs=kwargs,
                plan_fingerprint=plan["plan_fingerprint"],
                client_request_id="a" * 32,
            )

        self.assertEqual(saved["method"], method)
        self.assertEqual([request["Mode"] for request in submitted], ["plan", "commit"])
        for request in submitted:
            self.assertEqual(request["SaveKind"], "dfm_method")
            self.assertEqual(request["Args"], ["Demo Project", "HPPREF\\HO+DF\\NJ", method])
            self.assertEqual(request["Kwargs"], kwargs)
            self.assertEqual(request["UserName"], "xwei")
        self.assertEqual(submitted[0]["PlanFingerprint"], "")
        self.assertEqual(submitted[1]["PlanFingerprint"], "plan-123")
        self.assertEqual(submitted[1]["RequestId"], "a" * 32)
        round_trips = [
            record
            for record in self._latency_records()
            if record["event"] == "hosted_save_round_trip"
        ]
        self.assertEqual(
            [record["transport"] for record in round_trips],
            ["http_gateway", "http_gateway"],
        )
        self.assertEqual(
            round_trips[0]["object_name"], "C 22 - CWOP DFM w/ Selected LDFs"
        )

    def test_every_save_kind_uses_the_http_gateway(self) -> None:
        """Every dataset and method save procedure travels over HTTP."""

        submitted: list[dict] = []

        def submit(_config, request, **_kwargs):
            submitted.append(request)
            return {"ok": True}, {
                "gateway_round_trip_ms": 5.0,
                "gateway_attempts": 1,
                "request_bytes": 128,
            }

        with self._submit(side_effect=submit):
            for save_kind in sorted(SAVE_JOB_KINDS):
                engine_hosted_save_service.run_hosted_save(
                    save_kind,
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )

        self.assertEqual(
            [request["SaveKind"] for request in submitted],
            sorted(SAVE_JOB_KINDS),
        )

    def test_a_gateway_without_the_save_kind_says_the_server_needs_updating(self) -> None:
        self.capabilities = self._capabilities(["dataset_sidecar"])
        self._assert_refused(503, SERVER_UPDATE_MESSAGE, "kind_not_advertised")

    def test_a_pc_with_no_credential_is_asked_to_sign_in(self) -> None:
        self.gateway_config = {"enabled": False}
        self._assert_refused(401, NOT_SIGNED_IN_MESSAGE, "gateway_disabled")

    def test_a_silent_gateway_is_reported_not_worked_around(self) -> None:
        def unreachable(_config):
            raise HTTPException(503, SERVER_UNREACHABLE_MESSAGE)

        with patch.object(
            engine_hosted_save_service.hosted_save_http_client,
            "probe_gateway",
            side_effect=unreachable,
        ):
            self._assert_refused(503, SERVER_UNREACHABLE_MESSAGE, "gateway_unreachable")

    def test_service_errors_keep_their_status_codes(self) -> None:
        with self._submit(
            side_effect=HTTPException(
                409, "Output dataset is already owned by another method."
            )
        ):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "cape_cod_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("already owned", str(raised.exception.detail))
        round_trip = self._latency_records()[-1]
        self.assertEqual(round_trip["http_status"], 409)
        self.assertEqual(round_trip["failure_stage"], "gateway_round_trip")

    def test_a_credential_of_another_windows_user_is_refused(self) -> None:
        self.gateway_config = {**GATEWAY_CONFIG, "user": "someone.else"}
        with self._submit(side_effect=AssertionError("must not be posted")):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "dfm_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, 403)

    def test_a_server_process_never_sends_a_save(self) -> None:
        with (
            patch.object(workspace_read_client, "_is_server_process", return_value=True),
            self._submit(side_effect=AssertionError("must not be posted")),
        ):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "dfm_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(list(self.root.iterdir()), [self.latency_log_path.parent])


class ClientSaveLatencyLogTests(unittest.TestCase):
    def test_a_log_write_failure_is_best_effort(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            blocked_parent = Path(temp_dir) / "not-a-folder"
            blocked_parent.write_text("occupied", encoding="utf-8")
            with patch.object(
                client_save_latency_log_service.config,
                "get_client_save_latency_log_path",
                return_value=str(blocked_parent / "client_save_latency.jsonl"),
            ):
                written = client_save_latency_log_service.append_client_save_latency(
                    {"event": "test"}
                )
        self.assertFalse(written)

    def test_log_rotates_locally_and_each_line_is_valid_json(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            log_path = Path(temp_dir) / "logs" / "client_save_latency.jsonl"
            with (
                patch.object(
                    client_save_latency_log_service.config,
                    "get_client_save_latency_log_path",
                    return_value=str(log_path),
                ),
                patch.object(
                    client_save_latency_log_service,
                    "CLIENT_SAVE_LATENCY_LOG_MAX_BYTES",
                    180,
                ),
                patch.object(
                    client_save_latency_log_service,
                    "CLIENT_SAVE_LATENCY_LOG_BACKUP_COUNT",
                    2,
                ),
            ):
                for index in range(6):
                    self.assertTrue(
                        client_save_latency_log_service.append_client_save_latency(
                            {"event": "test", "index": index, "padding": "x" * 80}
                        )
                    )

            self.assertTrue(log_path.exists())
            self.assertTrue(Path(f"{log_path}.1").exists())
            self.assertLessEqual(
                len(list(log_path.parent.glob("client_save_latency.jsonl.*"))),
                2,
            )
            for file_path in log_path.parent.iterdir():
                for line in file_path.read_text(encoding="utf-8").splitlines():
                    self.assertEqual(json.loads(line)["event"], "test")


class ProtocolPathValidationCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        dependent_propagation_service._clear_protocol_path_validation_cache()

    def tearDown(self) -> None:
        dependent_propagation_service._clear_protocol_path_validation_cache()

    def test_successful_protocol_validation_is_reused_for_thirty_seconds(self) -> None:
        root = FRONTEND_ROOT / "test-workspace"
        first_timings: dict[str, float] = {}
        second_timings: dict[str, float] = {}
        with patch.object(
            dependent_propagation_service,
            "_reject_linked_path",
        ) as reject:
            dependent_propagation_service._validate_protocol_paths(
                root,
                timings=first_timings,
                timing_prefix="first",
            )
            dependent_propagation_service._validate_protocol_paths(
                root,
                timings=second_timings,
                timing_prefix="second",
            )

        self.assertEqual(reject.call_count, 5)
        self.assertIn("first_protocol_requests_root_ms", first_timings)
        self.assertIn("second_protocol_cached_validation_ms", second_timings)
        self.assertNotIn("second_protocol_requests_root_ms", second_timings)

    def test_expired_protocol_validation_runs_each_path_again(self) -> None:
        root = FRONTEND_ROOT / "test-workspace"
        with (
            patch.object(
                dependent_propagation_service,
                "_reject_linked_path",
            ) as reject,
            patch.object(
                dependent_propagation_service.time,
                "monotonic",
                side_effect=[0.0, 0.0, 31.0, 31.0],
            ),
        ):
            dependent_propagation_service._validate_protocol_paths(root)
            dependent_propagation_service._validate_protocol_paths(root)

        self.assertEqual(reject.call_count, 10)


class InlineEnginePropagationTests(unittest.TestCase):
    """The Engine-side inline walk that replaces save-time job enqueueing."""

    def test_inline_mode_runs_the_walk_and_collects_refreshed_names(self) -> None:
        walk_result = {
            "ok": True,
            "updated": [
                {"ok": True, "dataset_type_name": "C 61 Reported - CWOP"},
            ],
            "dfm_updates": {
                "ok": True,
                "updated": [{"dataset_name": "C 22 - CWOP DFM", "output_changed": True}],
            },
            "result_selection_updates": {
                "ok": True,
                "updated": [{"dataset_name": "C 91 - Current Qtr Indicated"}],
            },
            # Only C 91 changed meaningfully; C 22 was rewritten but stays OK.
            "review_flagged": ["C 91 - Current Qtr Indicated"],
            "reachable_count": 4,
        }
        with patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            return_value=walk_result,
        ) as walk:
            with dependent_propagation_service.inline_engine_propagation():
                payload = dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    "Paid Output",
                    "Selected Ultimate",
                )
        walk.assert_called_once()
        self.assertEqual(payload["status"], "completed")
        self.assertTrue(payload["ok"])
        self.assertEqual(
            payload["refreshed_datasets"],
            [
                "C 61 Reported - CWOP",
                "C 22 - CWOP DFM",
                "C 91 - Current Qtr Indicated",
            ],
        )
        # The saving window lists only the outputs that changed and need review.
        self.assertEqual(payload["review_flagged_datasets"], ["C 91 - Current Qtr Indicated"])
        # The hosted-save log reports both numbers, so a walk that stopped on a
        # failed branch is not mistaken for a save with almost no dependents.
        self.assertEqual(payload["reachable_dataset_count"], 4)

    def test_every_save_path_runs_the_walk_inline_not_only_the_marked_one(self) -> None:
        """The dataset-sidecar save must not queue a job inside a hosted save.

        A queued job forces the client to poll a status file it reaches over
        SMB, where the Windows redirector caches the file for its default 10 s
        and hides a terminal status the Engine already wrote. Berquist Sherman
        saves through this path, which is why its saves waited ~15 s after the
        walk itself had finished in under a second.
        """

        walk_result = {"ok": True, "updated": [{"dataset_name": "D 91"}]}
        with (
            patch(
                "app_server.services.calculated_dataset_service.recalculate_dependents",
                return_value=walk_result,
            ) as walk,
            patch.object(
                dependent_propagation_service, "submit_dependent_propagation_job"
            ) as submit,
        ):
            with dependent_propagation_service.inline_engine_propagation():
                payload = dependent_propagation_service.enqueue_save_propagation(
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    [dependent_propagation_service.changed_root("Paid Output", "Gross Loss")],
                )
        walk.assert_called_once()
        submit.assert_not_called()
        # "completed" is what lets the client skip polling entirely.
        self.assertEqual(payload["status"], "completed")
        self.assertTrue(payload["ok"])

    def test_outside_a_hosted_save_the_walk_is_still_queued(self) -> None:
        # A Client PC has no lease and no local workspace: it must keep
        # enqueueing the durable job.
        with (
            patch.object(
                dependent_propagation_service,
                "submit_dependent_propagation_job",
                return_value={"job_id": "abc", "status": "queued"},
            ) as submit,
            patch(
                "app_server.services.calculated_dataset_service.recalculate_dependents"
            ) as walk,
        ):
            payload = dependent_propagation_service.enqueue_save_propagation(
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                [dependent_propagation_service.changed_root("Paid Output", "Gross Loss")],
            )
        submit.assert_called_once()
        walk.assert_not_called()
        self.assertEqual(payload["status"], "queued")
        self.assertEqual(payload["job_id"], "abc")

    def test_enqueue_preserves_review_until_recalculation_inline_or_queued(self) -> None:
        with (
            patch(
                "app_server.services.dataset_sidecar_status_service"
                ".refresh_method_statuses_for_dependents"
            ) as marking,
            patch(
                "app_server.services.calculated_dataset_service.recalculate_dependents",
                return_value={"ok": True},
            ),
        ):
            with dependent_propagation_service.inline_engine_propagation():
                dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NJ", "Paid Output"
                )
            marking.assert_not_called()

            with patch.object(
                dependent_propagation_service,
                "submit_dependent_propagation_job",
                return_value={"job_id": "abc", "status": "queued"},
            ):
                dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NJ", "Paid Output"
                )
            marking.assert_not_called()

    def test_a_failed_inline_walk_reports_in_the_payload_not_an_error(self) -> None:
        with patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            side_effect=OSError("disk trouble"),
        ):
            with dependent_propagation_service.inline_engine_propagation():
                payload = dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NJ", "Paid Output"
                )
        self.assertEqual(payload["status"], "completed")
        self.assertFalse(payload["ok"])
        self.assertIn("disk trouble", payload["message"])


if __name__ == "__main__":
    unittest.main()
