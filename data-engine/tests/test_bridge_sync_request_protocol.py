"""Cover the Bridge's ResQ reserving-class synchronization queue.

A synchronization is served by the same ResQ-connected worker as an import,
from a sibling queue folder, through the same claim/status/heartbeat protocol.
These tests pin that: the worker reads its function, folders, and phases from
the versioned contract; it claims a request before reporting anything; and it
refuses a request that is malformed, mis-versioned, or tries to name a path.
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENGINE_SRC = REPOSITORY_ROOT / "data-engine" / "src"
CANONICAL_SRC = REPOSITORY_ROOT / "python-api" / "src"
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
for source_root in (ENGINE_SRC, CANONICAL_SRC):
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))

from arcrho_bridge import main as bridge_main  # noqa: E402
from arcrho_bridge.resq_import_contract import (  # noqa: E402
    load_resq_reserving_class_import_contract,
)
from arcrho_bridge.resq_sync_contract import (  # noqa: E402
    ResQSyncContractError,
    load_resq_reserving_class_sync_contract,
)


_REQUEST_ID = "sync-request-123"


def _reviewed_row(row_id: str = "paid-loss") -> dict:
    return {
        "Id": row_id,
        "Name": row_id,
        "Signature": {"key": row_id, "action": "arcrho_to_resq"},
    }


def _sync_request(**overrides):
    payload = {
        "Function": bridge_main.RESQ_SYNC_FUNCTION,
        "ContractVersion": bridge_main.RESQ_SYNC_CONTRACT_VERSION,
        "RequestId": _REQUEST_ID,
        "ProjectName": "Demo",
        "Path": r"Auto\PP",
        "UserName": "tester",
        "Phase": "preview",
    }
    payload.update(overrides)
    return payload


class BridgeSyncContractTests(unittest.TestCase):
    def test_bridge_uses_the_versioned_json_contract(self):
        contract = load_resq_reserving_class_sync_contract()

        self.assertEqual(bridge_main.RESQ_SYNC_FUNCTION, contract["function"])
        self.assertEqual(
            bridge_main.RESQ_SYNC_CONTRACT_VERSION,
            contract["contract_version"],
        )
        self.assertEqual(
            bridge_main._RESQ_SYNC_ALLOWED_PHASES,
            frozenset(contract["allowed_phases"]),
        )
        self.assertEqual(
            bridge_main._RESQ_SYNC_SELECTION_FIELD,
            contract["selection_field"],
        )

    def test_worker_and_status_facts_are_taken_from_the_import_contract(self):
        sync_contract = load_resq_reserving_class_sync_contract()
        import_contract = load_resq_reserving_class_import_contract()

        for key in (
            "worker_role",
            "worker_heartbeat_relative_dir",
            "worker_heartbeat_max_age_seconds",
            "status_values",
            "forbidden_path_fields",
        ):
            with self.subTest(field=key):
                self.assertEqual(sync_contract[key], import_contract[key])

        raw = json.loads(
            (ENGINE_SRC / "arcrho_bridge" / "resq_reserving_class_sync_contract.json").read_text(
                encoding="utf-8"
            )
        )
        for key in (
            "worker_role",
            "worker_heartbeat_relative_dir",
            "worker_heartbeat_max_age_seconds",
            "status_values",
            "forbidden_path_fields",
        ):
            self.assertNotIn(key, raw)

    def test_a_contract_that_restates_worker_facts_is_rejected(self):
        from arcrho_bridge import resq_sync_contract

        payload = json.loads(
            (ENGINE_SRC / "arcrho_bridge" / "resq_reserving_class_sync_contract.json").read_text(
                encoding="utf-8"
            )
        )
        payload["worker_role"] = "bridge_worker"

        with self.assertRaisesRegex(ResQSyncContractError, "import contract"):
            resq_sync_contract._validated_contract(payload)

    def test_the_sync_queue_is_a_distinct_sibling_of_the_import_queue(self):
        sync_contract = load_resq_reserving_class_sync_contract()
        import_contract = load_resq_reserving_class_import_contract()

        self.assertEqual(
            tuple(sync_contract["request_relative_dir"])[:2],
            tuple(import_contract["request_relative_dir"])[:2],
        )
        self.assertNotEqual(
            tuple(sync_contract["request_relative_dir"])[2],
            tuple(import_contract["request_relative_dir"])[2],
        )


class BridgeSyncQueuePathTests(unittest.TestCase):
    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT))
        self.server_root = Path(self.temp_dir.name) / "ArcRho Server"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_queue_and_status_paths_are_deterministic_and_server_relative(self):
        request_dir = bridge_main.resq_sync_request_dir(self.server_root)
        status_path = bridge_main.resq_sync_status_path(_REQUEST_ID, self.server_root)

        self.assertEqual(
            request_dir,
            self.server_root
            / "requests"
            / "RPC bridge"
            / "resq_reserving_class_sync"
            / "requests",
        )
        self.assertEqual(status_path, request_dir.with_name("statuses") / f"{_REQUEST_ID}.json")

    def test_an_unsafe_request_id_never_resolves_a_status_path(self):
        for request_id in ("", "..", r"..\escape", "a/b"):
            with self.subTest(request_id=request_id):
                with self.assertRaises(ValueError):
                    bridge_main.resq_sync_status_path(request_id, self.server_root)

    def test_an_orphaned_processing_status_is_closed_out(self):
        status_path = bridge_main.resq_sync_status_path(_REQUEST_ID, self.server_root)
        status_path.write_text(
            json.dumps({
                "contract_version": bridge_main.RESQ_SYNC_CONTRACT_VERSION,
                "request_id": _REQUEST_ID,
                "status": "processing",
            }),
            encoding="utf-8",
        )

        reconciled = bridge_main.reconcile_orphaned_resq_sync_statuses(
            self.server_root,
            now=time.time() + bridge_main.RESQ_IMPORT_STATUS_STALE_SECONDS + 60,
        )

        self.assertEqual(reconciled, (_REQUEST_ID,))
        payload = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["contract_version"], bridge_main.RESQ_SYNC_CONTRACT_VERSION)
        self.assertIn("stopped before this synchronization finished", payload["message"])

    def test_a_fresh_processing_status_is_left_alone(self):
        status_path = bridge_main.resq_sync_status_path(_REQUEST_ID, self.server_root)
        status_path.write_text(
            json.dumps({
                "contract_version": bridge_main.RESQ_SYNC_CONTRACT_VERSION,
                "request_id": _REQUEST_ID,
                "status": "processing",
            }),
            encoding="utf-8",
        )

        self.assertEqual(bridge_main.reconcile_orphaned_resq_sync_statuses(self.server_root), ())
        payload = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], "processing")


class BridgeSyncRequestHandlingTests(unittest.TestCase):
    def test_sync_request_is_claimed_before_status_and_validation(self):
        client = Mock()
        handler = bridge_main.BridgeRequestHandler(client)
        events = []

        def record_status(_request, status, **_kwargs):
            events.append(status)
            return True

        with (
            patch.object(bridge_main, "read_json", return_value=_sync_request(ProjectName="")),
            patch.object(
                bridge_main,
                "safe_remove",
                side_effect=lambda _path: events.append("claim") or True,
            ),
            patch.object(bridge_main, "_write_resq_sync_status", side_effect=record_status),
        ):
            self.assertTrue(handler.process_file(Path("request.json")))

        self.assertEqual(events, ["claim", "processing", "error"])
        client.write_resq_reserving_class_sync.assert_not_called()

    def test_a_sync_request_is_never_handled_by_the_import_path(self):
        client = Mock()
        handler = bridge_main.BridgeRequestHandler(client)

        with (
            patch.object(bridge_main, "read_json", return_value=_sync_request()),
            patch.object(bridge_main, "safe_remove", return_value=True),
            patch.object(bridge_main, "_write_resq_sync_status", return_value=True),
            patch.object(bridge_main, "_write_resq_import_status") as import_status,
        ):
            handler.process_file(Path("request.json"))

        import_status.assert_not_called()
        client.write_resq_reserving_class_import.assert_not_called()
        client.write_resq_reserving_class_sync.assert_called_once()

    def test_sync_success_publishes_progress_and_terminal_result(self):
        client = Mock()
        handler = bridge_main.BridgeRequestHandler(client)
        statuses = []

        def record_status(_request, status, **kwargs):
            statuses.append((status, kwargs))
            return True

        def write_sync(_request, *, progress_callback=None):
            self.assertIsNotNone(progress_callback)
            progress_callback({"event": "scan", "completed": 0, "total": 0})
            return {"status": "review_required", "preview": []}

        client.write_resq_reserving_class_sync.side_effect = write_sync
        with (
            patch.object(bridge_main, "read_json", return_value=_sync_request()),
            patch.object(bridge_main, "safe_remove", return_value=True),
            patch.object(bridge_main, "_write_resq_sync_status", side_effect=record_status),
        ):
            handler.process_file(Path("request.json"))

        self.assertEqual(
            statuses,
            [
                ("processing", {}),
                ("processing", {"progress": {"event": "scan", "completed": 0, "total": 0}}),
                ("success", {"result": {"status": "review_required", "preview": []}}),
            ],
        )

    def test_a_failed_sync_reports_the_error_without_a_success_status(self):
        client = Mock()
        handler = bridge_main.BridgeRequestHandler(client)
        statuses = []
        client.write_resq_reserving_class_sync.side_effect = RuntimeError("ResQ is unavailable")

        with (
            patch.object(bridge_main, "read_json", return_value=_sync_request()),
            patch.object(bridge_main, "safe_remove", return_value=True),
            patch.object(
                bridge_main,
                "_write_resq_sync_status",
                side_effect=lambda _request, status, **kwargs: statuses.append((status, kwargs)) or True,
            ),
        ):
            handler.process_file(Path("request.json"))

        self.assertEqual([status for status, _kwargs in statuses], ["processing", "error"])
        self.assertIn("ResQ is unavailable", str(statuses[-1][1]["message"]))


class BridgeSyncRequestValidationTests(unittest.TestCase):
    def setUp(self):
        self.handler = bridge_main.BridgeRequestHandler(Mock())

    def _assert_rejected(self, request, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            self.handler._validate_resq_sync_request(request)

    def test_a_valid_preview_request_is_normalized(self):
        request = _sync_request(ProjectName=" Demo ", Path="Auto/PP", Phase="PREVIEW")

        self.handler._validate_resq_sync_request(request)

        self.assertEqual(request["ProjectName"], "Demo")
        self.assertEqual(request["Path"], r"Auto\PP")
        self.assertEqual(request["Phase"], "preview")

    def test_a_valid_apply_request_keeps_its_reviewed_rows(self):
        request = _sync_request(Phase="apply", SelectedRows=[_reviewed_row()])

        self.handler._validate_resq_sync_request(request)

        self.assertEqual(request["SelectedRows"], [_reviewed_row()])

    def test_a_mis_versioned_or_misnamed_request_is_refused(self):
        self._assert_rejected(_sync_request(Function="ImportResQReservingClass"), "Function must be")
        self._assert_rejected(_sync_request(ContractVersion="1"), "ContractVersion must be")
        self._assert_rejected(_sync_request(ContractVersion=99), "Unsupported ContractVersion")

    def test_missing_logical_fields_are_refused(self):
        self._assert_rejected(_sync_request(UserName=""), "Missing request field")
        self._assert_rejected(_sync_request(Phase=""), "Missing request field")
        self._assert_rejected(_sync_request(ProjectName=".."), "one logical path segment")
        self._assert_rejected(_sync_request(Path=r"..\escape"), "relative Windows ArcRho")

    def test_an_unknown_phase_is_refused(self):
        self._assert_rejected(_sync_request(Phase="rollback"), "Phase must be one of")

    def test_an_apply_request_must_carry_reviewed_rows(self):
        self._assert_rejected(_sync_request(Phase="apply"), "SelectedRows must list")
        self._assert_rejected(_sync_request(Phase="apply", SelectedRows=[]), "SelectedRows must list")

    def test_a_preview_request_must_not_carry_reviewed_rows(self):
        self._assert_rejected(
            _sync_request(SelectedRows=[_reviewed_row()]),
            "preview request must not supply",
        )

    def test_a_request_may_never_name_a_path(self):
        for field in bridge_main._RESQ_IMPORT_FORBIDDEN_PATH_FIELDS:
            with self.subTest(field=field):
                self._assert_rejected(
                    _sync_request(**{field: r"E:\ArcRho Server"}),
                    "must not supply path field",
                )


if __name__ == "__main__":
    unittest.main()
