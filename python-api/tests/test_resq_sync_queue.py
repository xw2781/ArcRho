"""Cover the Bridge queue client the Sync and Export macros share.

Neither macro owns a ResQ session: each publishes a logical request to the
shared queue through ``arcrho_api.resq_sync_queue`` and renders what a
ResQ-connected Bridge worker reports. These tests pin the client to the
canonical contract files and prove the guarantees that survive the queue --
above all that an accepted row travels back with the signature it was
reviewed under, that an export is a request of its own with no selection, and
that nothing is published when no worker is live.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
_SRC_DIR = _PYTHON_API_ROOT / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))
_SERVER_COMPONENTS_BRIDGE_DIR = _PYTHON_API_ROOT.parent / "server-components" / "src" / "arcrho_bridge"
_SYNC_CONTRACT_PATH = _SERVER_COMPONENTS_BRIDGE_DIR / "resq_reserving_class_sync_contract.json"
_IMPORT_CONTRACT_PATH = _SERVER_COMPONENTS_BRIDGE_DIR / "resq_reserving_class_import_contract.json"
_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"

from arcrho_api import resq_sync_queue as queue  # noqa: E402


def _preview_row(row_id: str, *, action: str = "arcrho_to_resq") -> dict:
    return {
        "id": row_id,
        "signature": {"key": row_id, "action": action, "arcrho": {"modified_timestamp": 100.0}},
        "name": row_id.replace("-", " ").title(),
        "kind": "Dataset",
        "action": action,
        "selected": True,
        "disabled": False,
    }


class QueueContractAdapterTests(unittest.TestCase):
    def setUp(self):
        self.sync_contract = json.loads(_SYNC_CONTRACT_PATH.read_text(encoding="utf-8"))
        self.import_contract = json.loads(_IMPORT_CONTRACT_PATH.read_text(encoding="utf-8"))

    def test_the_client_matches_the_canonical_bridge_contract(self):
        contract = self.sync_contract

        self.assertEqual(queue.REQUEST_FUNCTION, contract["function"])
        self.assertEqual(queue.CONTRACT_VERSION, contract["contract_version"])
        self.assertEqual(tuple(queue.REQUEST_RELATIVE_DIR.parts), tuple(contract["request_relative_dir"]))
        self.assertEqual(tuple(queue.STATUS_RELATIVE_DIR.parts), tuple(contract["status_relative_dir"]))
        self.assertEqual(queue.REQUIRED_REQUEST_FIELDS, tuple(contract["required_request_fields"]))
        self.assertEqual(queue.ALLOWED_PHASES, frozenset(contract["allowed_phases"]))
        self.assertEqual(queue.SELECTION_FIELD, contract["selection_field"])
        self.assertEqual(queue.SELECTION_ROW_FIELDS, tuple(contract["selection_row_fields"]))

    def test_worker_and_status_facts_come_from_the_one_contract_that_owns_them(self):
        contract = self.import_contract

        self.assertEqual(tuple(queue.BRIDGE_WORKER_DIR.parts), tuple(contract["worker_heartbeat_relative_dir"]))
        self.assertEqual(queue.BRIDGE_WORKER_ROLE, contract["worker_role"])
        self.assertEqual(queue.BRIDGE_WORKER_MAX_AGE_SEC, contract["worker_heartbeat_max_age_seconds"])
        self.assertEqual(queue.STATUS_VALUES, frozenset(contract["status_values"]))
        self.assertEqual(queue.FORBIDDEN_PATH_FIELDS, tuple(contract["forbidden_path_fields"]))
        # The synchronization contract must not restate any of the above.
        for key in (
            "worker_heartbeat_relative_dir",
            "worker_role",
            "worker_heartbeat_max_age_seconds",
            "status_values",
            "forbidden_path_fields",
        ):
            self.assertNotIn(key, self.sync_contract)


class QueueRequestTests(unittest.TestCase):
    def test_a_request_carries_logical_identifiers_only(self):
        _request_id, payload = queue.create_sync_request(
            project_name="Demo",
            rc_path="Auto/PP",
            phase="preview",
        )

        self.assertEqual(payload["Function"], queue.REQUEST_FUNCTION)
        self.assertEqual(payload["ContractVersion"], queue.CONTRACT_VERSION)
        self.assertEqual(payload["ProjectName"], "Demo")
        self.assertEqual(payload["Path"], r"Auto\PP")
        self.assertEqual(payload["Phase"], "preview")
        self.assertNotIn(queue.SELECTION_FIELD, payload)
        for key in queue.FORBIDDEN_PATH_FIELDS:
            self.assertNotIn(key, payload)

    def test_logical_identifiers_are_rejected_before_publication(self):
        for project_name, rc_path in (
            ("", r"Auto\PP"),
            ("..", r"Auto\PP"),
            ("De:mo", r"Auto\PP"),
            ("Demo", ""),
            ("Demo", r"C:\ArcRho Server\projects\Demo"),
            ("Demo", r"Auto\..\PP"),
            ("Demo", r"\Auto\PP"),
        ):
            with self.subTest(project_name=project_name, rc_path=rc_path):
                with self.assertRaises(ValueError):
                    queue.create_sync_request(project_name=project_name, rc_path=rc_path, phase="preview")

    def test_an_apply_request_echoes_the_reviewed_signature_for_every_row(self):
        rows = [_preview_row("paid-loss"), _preview_row("ultimate-loss")]

        _request_id, payload = queue.create_sync_request(
            project_name="Demo",
            rc_path=r"Auto\PP",
            phase="apply",
            selected_rows=rows,
        )

        selection = payload[queue.SELECTION_FIELD]
        self.assertEqual([row["Id"] for row in selection], ["paid-loss", "ultimate-loss"])
        self.assertEqual(selection[0]["Signature"], rows[0]["signature"])

    def test_an_apply_request_without_a_reviewed_signature_is_refused(self):
        row = _preview_row("paid-loss")
        row.pop("signature")

        with self.assertRaisesRegex(ValueError, "signature"):
            queue.create_sync_request(project_name="Demo", rc_path=r"Auto\PP", phase="apply", selected_rows=[row])

    def test_a_preview_or_export_request_never_carries_a_selection(self):
        for phase in ("preview", "export"):
            with self.subTest(phase=phase):
                with self.assertRaisesRegex(ValueError, f"{phase} request must not carry a selection"):
                    queue.create_sync_request(
                        project_name="Demo",
                        rc_path=r"Auto\PP",
                        phase=phase,
                        selected_rows=[_preview_row("paid-loss")],
                    )

    def test_an_export_request_names_its_phase_and_nothing_to_select(self):
        _request_id, payload = queue.create_sync_request(project_name="Demo", rc_path=r"Auto\PP", phase="Export")

        self.assertEqual(payload["Phase"], "export")
        self.assertNotIn(queue.SELECTION_FIELD, payload)

    def test_an_unknown_phase_is_refused(self):
        with self.assertRaises(ValueError):
            queue.create_sync_request(project_name="Demo", rc_path=r"Auto\PP", phase="rollback")


class QueueBridgeAvailabilityTests(unittest.TestCase):
    def setUp(self):
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self._temp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.server_root = Path(self._temp.name) / "ArcRho Server"
        # A missing Bridge is judged after a silence, not a look; keep it short here.
        self._patches = [
            patch.object(queue, "BRIDGE_SILENCE_LIMIT_SEC", 0.05),
            patch.object(queue, "POLL_INTERVAL_SEC", 0.01),
        ]
        for item in self._patches:
            item.start()

    def tearDown(self):
        for item in self._patches:
            item.stop()
        self._temp.cleanup()

    def _write_worker_heartbeat(self, **fields):
        folder = self.server_root / queue.BRIDGE_WORKER_DIR
        folder.mkdir(parents=True, exist_ok=True)
        payload = {"Role": queue.BRIDGE_WORKER_ROLE, "ResQGuiRunning": True}
        payload.update(fields)
        path = folder / "worker.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def _respond(self, status: dict):
        """Wrap publication so the Bridge's terminal status lands right after the request."""

        status_dir = self.server_root / queue.STATUS_RELATIVE_DIR
        status_dir.mkdir(parents=True, exist_ok=True)
        original_publish = queue.publish_sync_request

        def publish_and_respond(**kwargs):
            request_path = original_publish(**kwargs)
            document = {"contract_version": queue.CONTRACT_VERSION, "request_id": kwargs["request_id"], **status}
            (status_dir / f"{kwargs['request_id']}.json").write_text(json.dumps(document), encoding="utf-8")
            return request_path

        return patch.object(queue, "publish_sync_request", side_effect=publish_and_respond)

    def test_a_live_resq_connected_worker_is_required_before_publishing(self):
        with self.assertRaises(queue.BridgeUnavailableError):
            queue.require_live_bridge_workers(self.server_root)

        self._write_worker_heartbeat()
        self.assertEqual(len(queue.require_live_bridge_workers(self.server_root)), 1)

    def test_a_worker_without_resq_is_not_a_usable_worker(self):
        self._write_worker_heartbeat(ResQGuiRunning=False)

        with self.assertRaises(queue.BridgeUnavailableError):
            queue.require_live_bridge_workers(self.server_root)

    def test_a_stale_heartbeat_is_not_a_usable_worker(self):
        path = self._write_worker_heartbeat()
        stale = time.time() - (queue.BRIDGE_WORKER_MAX_AGE_SEC * 10)
        os.utime(path, (stale, stale))

        with self.assertRaises(queue.BridgeUnavailableError):
            queue.require_live_bridge_workers(self.server_root)

    def test_no_request_is_published_when_no_worker_is_live(self):
        with self.assertRaises(queue.BridgeUnavailableError):
            queue.run_bridge_phase(
                server_root=self.server_root,
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="export",
                timeout_sec=5.0,
                progress_label="test",
            )

        request_dir = self.server_root / queue.REQUEST_RELATIVE_DIR
        self.assertFalse(any(request_dir.glob("*.json")) if request_dir.exists() else False)

    def test_a_terminal_error_status_is_reported_with_the_bridge_message(self):
        self._write_worker_heartbeat()

        with self._respond({"status": "error", "message": "ResQ project not found: Demo"}):
            with self.assertRaisesRegex(queue.BridgeRequestError, "ResQ project not found"):
                queue.run_bridge_phase(
                    server_root=self.server_root,
                    project_name="Demo",
                    rc_path=r"Auto\PP",
                    phase="preview",
                    timeout_sec=5.0,
                    progress_label="test",
                )

    def test_a_successful_phase_returns_the_bridge_result_and_polls_the_caller(self):
        self._write_worker_heartbeat()
        polls = []
        result_payload = {"status": "completed", "connection_name": "ResQ Demo", "results": [{"id": "paid-loss"}]}

        with self._respond({"status": "success", "result": result_payload}):
            result = queue.run_bridge_phase(
                server_root=self.server_root,
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="export",
                timeout_sec=5.0,
                progress_label="test",
                on_poll=lambda: polls.append(1),
            )

        self.assertEqual(result, result_payload)
        self.assertTrue(polls)
        request_dir = self.server_root / queue.REQUEST_RELATIVE_DIR
        published = json.loads(next(request_dir.glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(published["Phase"], "export")

    def test_a_status_from_another_contract_version_is_refused(self):
        self._write_worker_heartbeat()
        status_dir = self.server_root / queue.STATUS_RELATIVE_DIR
        status_dir.mkdir(parents=True, exist_ok=True)
        original_publish = queue.publish_sync_request

        def publish_and_respond(**kwargs):
            request_path = original_publish(**kwargs)
            (status_dir / f"{kwargs['request_id']}.json").write_text(
                json.dumps({"contract_version": queue.CONTRACT_VERSION - 1, "request_id": kwargs["request_id"], "status": "error"}),
                encoding="utf-8",
            )
            return request_path

        with patch.object(queue, "publish_sync_request", side_effect=publish_and_respond):
            with self.assertRaisesRegex(queue.BridgeRequestError, "unsupported status contract version"):
                queue.run_bridge_phase(
                    server_root=self.server_root,
                    project_name="Demo",
                    rc_path=r"Auto\PP",
                    phase="preview",
                    timeout_sec=5.0,
                    progress_label="test",
                )


if __name__ == "__main__":
    unittest.main()
