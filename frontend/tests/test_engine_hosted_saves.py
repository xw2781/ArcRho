from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_engine_save_contract import (
    SAVE_JOB_KINDS,
    read_save_job_status,
    save_job_request_path,
    validate_save_job_request,
    write_save_job_result,
    write_save_job_status,
)
from arcrho_hosted_save_http_contract import HTTP_SAVE_KINDS
from app_server.services import (
    client_save_latency_log_service,
    dependent_propagation_service,
    engine_hosted_save_service,
)


class EngineHostedSaveClientTests(unittest.TestCase):
    """The client half: submit, poll, and map the Engine's outcome."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        (self.root / "projects").mkdir()
        self.instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        self.instances_dir.mkdir(parents=True)
        (self.instances_dir / "engine.json").write_text(
            json.dumps({"Server": "engine", "Last seen": "2026-08-13 12:00:00"}),
            encoding="utf-8",
        )
        self.path_patch = patch.object(
            dependent_propagation_service.config,
            "load_workspace_paths",
            return_value={
                "workspace_root": str(self.root),
                "paths": {"projects_dir": "projects", "requests_dir": "requests"},
            },
        )
        self.path_patch.start()
        dependent_propagation_service._clear_protocol_path_validation_cache()
        self.latency_log_path = self.root / "local_appdata" / "client_save_latency.jsonl"
        self.log_path_patch = patch.object(
            client_save_latency_log_service.config,
            "get_client_save_latency_log_path",
            return_value=str(self.latency_log_path),
        )
        self.log_path_patch.start()
        self.gateway_config_patch = patch.object(
            engine_hosted_save_service.config,
            "load_gateway_config",
            return_value={"enabled": False},
        )
        self.gateway_config_patch.start()

    def tearDown(self) -> None:
        for thread in threading.enumerate():
            if thread.name.startswith("hosted-save-cleanup-"):
                thread.join(timeout=5)
        self.log_path_patch.stop()
        self.gateway_config_patch.stop()
        self.path_patch.stop()
        dependent_propagation_service._clear_protocol_path_validation_cache()
        self.temp_dir.cleanup()

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

    def _engine_stub(self, respond) -> threading.Thread:
        """Wait for the request file, then publish what `respond` returns."""

        requests_dir = self.root / "requests"

        def run() -> None:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    candidates = [
                        item
                        for item in requests_dir.iterdir()
                        if item.name.startswith("arcrho_hosted_save_")
                    ]
                except FileNotFoundError:
                    candidates = []
                if candidates:
                    request = validate_save_job_request(
                        json.loads(candidates[0].read_text(encoding="utf-8"))
                    )
                    candidates[0].unlink()
                    respond(request)
                    return
                time.sleep(0.05)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread

    def test_a_successful_hosted_save_returns_the_engine_result(self) -> None:
        statuses_before_engine_response: list[dict | None] = []

        def respond(request):
            statuses_before_engine_response.append(
                read_save_job_status(self.root, request["RequestId"])
            )
            response = {
                "ok": True,
                "echo_args": request["Args"],
                "propagation": {
                    "ok": True,
                    "status": "completed",
                    "refreshed_datasets": ["C 61", "C 91"],
                },
            }
            write_save_job_result(
                self.root,
                request["RequestId"],
                response,
            )
            write_save_job_status(
                self.root,
                request["RequestId"],
                "success",
                response=response,
            )

        thread = self._engine_stub(respond)
        with patch.object(
            engine_hosted_save_service,
            "read_save_job_result",
            side_effect=AssertionError("an inline response must avoid the legacy read"),
        ):
            result = engine_hosted_save_service.run_hosted_save(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=[
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    {
                        "json_format": "dfm",
                        "details_tab": {
                            "name": "C 22 - CWOP DFM w/ Selected LDFs"
                        },
                    },
                ],
                kwargs={"notes": None},
            )
        thread.join(timeout=5)
        self.assertEqual(
            statuses_before_engine_response,
            [None],
            "the request file itself must be the queued state",
        )
        self.assertEqual(result["propagation"]["refreshed_datasets"], ["C 61", "C 91"])
        self.assertEqual(result["echo_args"][2]["json_format"], "dfm")
        # Terminal artifacts are consumed so the queue folders stay clean —
        # in the background, off the response's critical path, so wait for it.
        save_jobs = self.root / "requests" / "save_jobs"
        deadline = time.monotonic() + 5
        def leftovers():
            return [
                item.name
                for folder in ("statuses", "results")
                for item in (save_jobs / folder).iterdir()
            ]
        while leftovers() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(leftovers(), [])
        records = self._latency_records()
        while (
            not any(record["event"] == "hosted_save_cleanup" for record in records)
            and time.monotonic() < deadline
        ):
            time.sleep(0.05)
            records = self._latency_records()
        round_trip = next(
            record
            for record in records
            if record["event"] == "hosted_save_round_trip"
        )
        cleanup = next(
            record for record in records if record["event"] == "hosted_save_cleanup"
        )
        self.assertEqual(round_trip["request_id"], cleanup["request_id"])
        self.assertEqual(round_trip["outcome"], "success")
        self.assertEqual(round_trip["http_status"], 200)
        self.assertEqual(round_trip["result_source"], "terminal_status")
        self.assertEqual(round_trip["project_name"], "Demo Project")
        self.assertEqual(round_trip["reserving_class"], "HPPREF\\HO+DF\\NJ")
        self.assertEqual(
            round_trip["object_name"],
            "C 22 - CWOP DFM w/ Selected LDFs",
        )
        self.assertGreaterEqual(round_trip["total_ms"], 0)
        self.assertEqual(
            round_trip["status_poll_count"],
            len(round_trip["status_reads_ms"]),
        )
        self.assertIn("success", round_trip["status_observations"])
        for phase in (
            "preflight_workspace_config_load_ms",
            "preflight_workspace_root_access_ms",
            "preflight_workspace_protocol_validation_ms",
            "preflight_engine_heartbeat_ms",
            "preflight_class_hold_ms",
            "preflight_total_ms",
            "identity_lookup_ms",
            "request_encode_ms",
            "request_publish_ms",
            "request_serialize_ms",
            "request_directory_ms",
            "request_temp_write_ms",
            "request_atomic_publish_ms",
            "initial_poll_delay_ms",
            "remote_round_trip_ms",
            "cleanup_schedule_ms",
            "status_read_total_ms",
            "poll_sleep_total_ms",
        ):
            self.assertGreaterEqual(round_trip["phase_ms"][phase], 0, phase)
        self.assertGreater(round_trip["request_bytes"], 0)
        self.assertNotIn("queued_status_publish_ms", round_trip["phase_ms"])
        self.assertNotIn("submission_workspace_total_ms", round_trip["phase_ms"])
        self.assertNotIn("legacy_result_read_ms", round_trip["phase_ms"])
        self.assertGreaterEqual(cleanup["cleanup_ms"], 0)

    def test_the_request_carries_the_user_who_is_saving(self) -> None:
        # The Engine instance that claims this runs as its own service
        # account, so the requesting user has to travel with the request or
        # the sidecar ends up naming a random instance.
        received: list = []

        def respond(request):
            received.append(request)
            write_save_job_result(self.root, request["RequestId"], {"ok": True})
            write_save_job_status(self.root, request["RequestId"], "success")

        thread = self._engine_stub(respond)
        with patch.object(
            engine_hosted_save_service.user_identity_service,
            "get_current_identity",
            return_value={"login_name": "xwei", "display_name": "Wei, Xiao"},
        ):
            engine_hosted_save_service.run_hosted_save(
                "dataset_sidecar",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        thread.join(timeout=5)
        self.assertEqual(received[0]["UserName"], "xwei")
        self.assertEqual(received[0]["UserDisplayName"], "Wei, Xiao")
        round_trip = next(
            record
            for record in reversed(self._latency_records())
            if record["event"] == "hosted_save_round_trip"
        )
        self.assertEqual(round_trip["result_source"], "legacy_result_file")
        self.assertIn("legacy_result_read_ms", round_trip["phase_ms"])

    def test_dataset_save_can_use_the_http_gateway_without_smb_preflight(self) -> None:
        gateway_config = {
            "enabled": True,
            "url": "http://gateway.test:28767",
            "user": "xwei",
            "secret": "pilot-secret",
            "allow_insecure_http": True,
        }
        with (
            patch.object(
                engine_hosted_save_service.config,
                "load_gateway_config",
                return_value=gateway_config,
            ),
            patch.object(
                engine_hosted_save_service.user_identity_service,
                "get_current_identity",
                return_value={"login_name": "xwei", "display_name": "Wei, Xiao"},
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "probe_gateway",
                return_value=self._capabilities(),
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "submit_hosted_save",
                return_value=(
                    {"ok": True, "source_kind": "input"},
                    {
                        "gateway_round_trip_ms": 25.0,
                        "gateway_attempts": 1,
                        "request_bytes": 512,
                    },
                ),
            ) as submit,
            patch.object(
                dependent_propagation_service,
                "require_reserving_class_writable",
                side_effect=AssertionError("HTTP transport must not touch SMB preflight"),
            ),
        ):
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
        self.assertEqual(request["Kwargs"]["values"], [[1.0]])
        round_trip = self._latency_records()[-1]
        self.assertEqual(round_trip["transport"], "http_gateway")
        self.assertEqual(round_trip["result_source"], "http_gateway")
        self.assertEqual(round_trip["status_poll_count"], 0)

    def test_dfm_plan_and_save_use_the_exact_http_gateway_request(self) -> None:
        gateway_config = {
            "enabled": True,
            "url": "http://gateway.test:28767",
            "user": "xwei",
            "secret": "pilot-secret",
            "allow_insecure_http": True,
        }
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

        with (
            patch.object(
                engine_hosted_save_service.config,
                "load_gateway_config",
                return_value=gateway_config,
            ),
            patch.object(
                engine_hosted_save_service.user_identity_service,
                "get_current_identity",
                return_value={"login_name": "xwei", "display_name": "Wei, Xiao"},
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "probe_gateway",
                return_value=self._capabilities(),
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "submit_hosted_save",
                side_effect=submit,
            ),
            patch.object(
                dependent_propagation_service,
                "require_reserving_class_writable",
                side_effect=AssertionError("HTTP transport must not touch SMB preflight"),
            ),
        ):
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
        round_trips = [
            record
            for record in self._latency_records()
            if record["event"] == "hosted_save_round_trip"
        ]
        self.assertEqual([record["transport"] for record in round_trips], [
            "http_gateway",
            "http_gateway",
        ])
        self.assertTrue(all(record["status_poll_count"] == 0 for record in round_trips))

    def test_every_save_kind_uses_the_http_gateway(self) -> None:
        """Every dataset and method save procedure travels over HTTP."""

        gateway_config = {
            "enabled": True,
            "url": "http://gateway.test:28767",
            "user": "xwei",
            "secret": "pilot-secret",
            "allow_insecure_http": True,
        }
        submitted: list[dict] = []

        def submit(_config, request, **_kwargs):
            submitted.append(request)
            return {"ok": True}, {
                "gateway_round_trip_ms": 5.0,
                "gateway_attempts": 1,
                "request_bytes": 128,
            }

        with (
            patch.object(
                engine_hosted_save_service.config,
                "load_gateway_config",
                return_value=gateway_config,
            ),
            patch.object(
                engine_hosted_save_service.user_identity_service,
                "get_current_identity",
                return_value={"login_name": "xwei", "display_name": "Wei, Xiao"},
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "probe_gateway",
                return_value=self._capabilities(),
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "submit_hosted_save",
                side_effect=submit,
            ),
            patch.object(
                dependent_propagation_service,
                "require_reserving_class_writable",
                side_effect=AssertionError("HTTP transport must not touch SMB preflight"),
            ),
        ):
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
        round_trips = [
            record
            for record in self._latency_records()
            if record["event"] == "hosted_save_round_trip"
        ]
        self.assertEqual(
            [record["transport"] for record in round_trips],
            ["http_gateway"] * len(SAVE_JOB_KINDS),
        )

    def test_a_gateway_without_the_save_kind_stays_on_smb(self) -> None:
        """A gateway older than a save kind degrades instead of refusing it.

        The kind gate lives on the gateway, so posting a kind it never
        advertised would be rejected outright and lose the save. Until it is
        upgraded, that kind keeps the SMB transport.
        """

        gateway_config = {
            "enabled": True,
            "url": "http://gateway.test:28767",
            "user": "xwei",
            "secret": "pilot-secret",
            "allow_insecure_http": True,
        }

        def respond(request):
            write_save_job_result(self.root, request["RequestId"], {"ok": True})
            write_save_job_status(self.root, request["RequestId"], "success")

        thread = self._engine_stub(respond)
        with (
            patch.object(
                engine_hosted_save_service.config,
                "load_gateway_config",
                return_value=gateway_config,
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "probe_gateway",
                return_value=self._capabilities(["dataset_sidecar"]),
            ),
            patch.object(
                engine_hosted_save_service.hosted_save_http_client,
                "submit_hosted_save",
                side_effect=AssertionError(
                    "an unadvertised save kind must never be posted"
                ),
            ),
        ):
            result = engine_hosted_save_service.run_hosted_save(
                "cape_cod_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        thread.join(timeout=5)

        self.assertTrue(result["ok"])
        round_trip = next(
            record
            for record in reversed(self._latency_records())
            if record["event"] == "hosted_save_round_trip"
        )
        self.assertEqual(round_trip["transport"], "smb")
        self.assertEqual(round_trip["outcome"], "success")
        # The probe still happened, and its cost is attributed honestly.
        self.assertGreaterEqual(round_trip["phase_ms"]["gateway_capability_ms"], 0)

    def test_service_errors_keep_their_status_codes(self) -> None:
        def respond(request):
            write_save_job_status(
                self.root,
                request["RequestId"],
                "error",
                message="Output dataset is already owned by another method.",
                status_code=409,
            )

        thread = self._engine_stub(respond)
        with self.assertRaises(HTTPException) as raised:
            engine_hosted_save_service.run_hosted_save(
                "cape_cod_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        thread.join(timeout=5)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("already owned", str(raised.exception.detail))

    def test_an_unclaimed_save_fails_fast_and_retracts_the_request(self) -> None:
        with patch.object(
            engine_hosted_save_service, "SAVE_JOB_QUEUED_TIMEOUT_SECONDS", 0.5
        ):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "dfm_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, 503)
        requests_dir = self.root / "requests"
        leftovers = [
            item.name
            for item in requests_dir.iterdir()
            if item.name.startswith("arcrho_hosted_save_")
        ]
        self.assertEqual(leftovers, [], "an unclaimed request must be retracted")

    def test_a_claimed_request_without_a_status_gets_the_processing_timeout(self) -> None:
        def respond(request):
            time.sleep(0.7)
            write_save_job_status(
                self.root,
                request["RequestId"],
                "success",
                response={"ok": True},
            )

        thread = self._engine_stub(respond)
        with patch.object(
            engine_hosted_save_service,
            "SAVE_JOB_QUEUED_TIMEOUT_SECONDS",
            0.2,
        ):
            result = engine_hosted_save_service.run_hosted_save(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        thread.join(timeout=5)
        self.assertTrue(result["ok"])

    def test_no_live_engine_refuses_before_writing_anything(self) -> None:
        for item in self.instances_dir.iterdir():
            item.unlink()
        with self.assertRaises(HTTPException) as raised:
            engine_hosted_save_service.run_hosted_save(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse((self.root / "requests").exists())
        round_trip = self._latency_records()[-1]
        self.assertEqual(round_trip["event"], "hosted_save_round_trip")
        self.assertEqual(round_trip["outcome"], "error")
        self.assertEqual(round_trip["http_status"], 503)
        self.assertEqual(round_trip["failure_stage"], "preflight")
        self.assertIn("preflight_engine_heartbeat_ms", round_trip["phase_ms"])


class ClientSaveLatencyLogTests(unittest.TestCase):
    def test_a_log_write_failure_is_best_effort(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
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
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
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

    def test_the_marked_variant_skips_marking_only_when_inline(self) -> None:
        # The inline decision lives in enqueue_save_propagation; this function
        # only declines to pay for marking the inline walk would redo.
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
            marking.assert_called_once()

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
