"""Cover the Sync Reserving Class with ResQ macro as a Bridge queue client.

The macro owns no ResQ session: it publishes logical requests to the shared
queue and renders what a ResQ-connected Bridge worker reports. These tests pin
its embedded protocol adapter to the canonical contract files and prove the
review window's guarantees survive the queue -- above all that an accepted row
travels back with the signature it was reviewed under, and that nothing is
published when the person cancels.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


_MACRO_PATH = (
    Path(__file__).resolve().parents[1]
    / "macros"
    / "sync_reserving_class_with_resq.py"
)
_DATA_ENGINE_BRIDGE_DIR = (
    Path(__file__).resolve().parents[2] / "data-engine" / "src" / "arcrho_bridge"
)
_SYNC_CONTRACT_PATH = _DATA_ENGINE_BRIDGE_DIR / "resq_reserving_class_sync_contract.json"
_IMPORT_CONTRACT_PATH = _DATA_ENGINE_BRIDGE_DIR / "resq_reserving_class_import_contract.json"
_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"


def _load_macro_module():
    spec = importlib.util.spec_from_file_location(
        "sync_reserving_class_with_resq_macro_under_test",
        _MACRO_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the ResQ reserving-class sync macro.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _preview_row(row_id: str, *, action: str = "arcrho_to_resq", disabled: bool = False) -> dict:
    return {
        "id": row_id,
        "signature": {"key": row_id, "action": action, "arcrho": {"modified_timestamp": 100.0}},
        "name": row_id.replace("-", " ").title(),
        "kind": "Dataset",
        "arcrho_timestamp": "2026-08-12T10:00:00+00:00",
        "resq_timestamp": "2026-08-12T11:00:00",
        "status": "ArcRho is newer",
        "action": action,
        "action_label": "ArcRho -> ResQ",
        "detail": "Test detail",
        "selected": True,
        "disabled": disabled,
        "conflict": False,
    }


class _ReviewUI:
    """A shell that accepts two rows through the async review-table protocol."""

    def __init__(self, selected_row_ids=("paid-loss", "ultimate-loss"), accepted=True):
        self.calls = []
        self._statuses = [
            {"result": {"status": "pending"}},
            {
                "result": {
                    "status": "completed",
                    "accepted": accepted,
                    "selectedRowIds": list(selected_row_ids),
                }
            },
        ]

    def send_command(self, command, *, args, timeout_sec):
        self.calls.append((command, args, timeout_sec))
        if command == "ui.reviewTableOpen":
            return {"result": {"dialogId": "review-1"}}
        if command == "ui.reviewTableStatus":
            return self._statuses.pop(0)
        if command == "ui.reviewTableClose":
            return {"result": {"status": "closed"}}
        raise AssertionError(f"Unexpected command: {command}")


class SyncMacroContractAdapterTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()
        self.sync_contract = json.loads(_SYNC_CONTRACT_PATH.read_text(encoding="utf-8"))
        self.import_contract = json.loads(_IMPORT_CONTRACT_PATH.read_text(encoding="utf-8"))

    def test_embedded_adapter_matches_the_canonical_bridge_contract(self):
        contract = self.sync_contract

        self.assertEqual(self.module.REQUEST_FUNCTION, contract["function"])
        self.assertEqual(self.module.CONTRACT_VERSION, contract["contract_version"])
        self.assertEqual(
            tuple(self.module.REQUEST_RELATIVE_DIR.parts),
            tuple(contract["request_relative_dir"]),
        )
        self.assertEqual(
            tuple(self.module.STATUS_RELATIVE_DIR.parts),
            tuple(contract["status_relative_dir"]),
        )
        self.assertEqual(
            self.module.REQUIRED_REQUEST_FIELDS,
            tuple(contract["required_request_fields"]),
        )
        self.assertEqual(self.module.ALLOWED_PHASES, frozenset(contract["allowed_phases"]))
        self.assertEqual(self.module.SELECTION_FIELD, contract["selection_field"])
        self.assertEqual(
            self.module.SELECTION_ROW_FIELDS,
            tuple(contract["selection_row_fields"]),
        )

    def test_worker_and_status_facts_come_from_the_one_contract_that_owns_them(self):
        contract = self.import_contract

        self.assertEqual(
            tuple(self.module.BRIDGE_WORKER_DIR.parts),
            tuple(contract["worker_heartbeat_relative_dir"]),
        )
        self.assertEqual(self.module.BRIDGE_WORKER_ROLE, contract["worker_role"])
        self.assertEqual(
            self.module.BRIDGE_WORKER_MAX_AGE_SEC,
            contract["worker_heartbeat_max_age_seconds"],
        )
        self.assertEqual(self.module.STATUS_VALUES, frozenset(contract["status_values"]))
        self.assertEqual(
            self.module.FORBIDDEN_PATH_FIELDS,
            tuple(contract["forbidden_path_fields"]),
        )
        # The synchronization contract must not restate any of the above.
        for key in (
            "worker_heartbeat_relative_dir",
            "worker_role",
            "worker_heartbeat_max_age_seconds",
            "status_values",
            "forbidden_path_fields",
        ):
            self.assertNotIn(key, self.sync_contract)


class SyncMacroRequestTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()

    def test_a_request_carries_logical_identifiers_only(self):
        _request_id, payload = self.module.create_sync_request(
            project_name="Demo",
            rc_path="Auto/PP",
            phase="preview",
        )

        self.assertEqual(payload["Function"], self.module.REQUEST_FUNCTION)
        self.assertEqual(payload["ContractVersion"], self.module.CONTRACT_VERSION)
        self.assertEqual(payload["ProjectName"], "Demo")
        self.assertEqual(payload["Path"], r"Auto\PP")
        self.assertEqual(payload["Phase"], "preview")
        self.assertNotIn(self.module.SELECTION_FIELD, payload)
        for key in self.module.FORBIDDEN_PATH_FIELDS:
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
                    self.module.create_sync_request(
                        project_name=project_name,
                        rc_path=rc_path,
                        phase="preview",
                    )

    def test_an_apply_request_echoes_the_reviewed_signature_for_every_row(self):
        rows = [_preview_row("paid-loss"), _preview_row("ultimate-loss")]

        _request_id, payload = self.module.create_sync_request(
            project_name="Demo",
            rc_path=r"Auto\PP",
            phase="apply",
            selected_rows=rows,
        )

        selection = payload[self.module.SELECTION_FIELD]
        self.assertEqual([row["Id"] for row in selection], ["paid-loss", "ultimate-loss"])
        self.assertEqual(selection[0]["Signature"], rows[0]["signature"])

    def test_an_apply_request_without_a_reviewed_signature_is_refused(self):
        row = _preview_row("paid-loss")
        row.pop("signature")

        with self.assertRaisesRegex(ValueError, "signature"):
            self.module.create_sync_request(
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="apply",
                selected_rows=[row],
            )

    def test_a_preview_request_never_carries_a_selection(self):
        with self.assertRaises(ValueError):
            self.module.create_sync_request(
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="preview",
                selected_rows=[_preview_row("paid-loss")],
            )

    def test_an_unknown_phase_is_refused(self):
        with self.assertRaises(ValueError):
            self.module.create_sync_request(
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="rollback",
            )


class SyncMacroBridgeAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self._temp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.server_root = Path(self._temp.name) / "ArcRho Server"

    def tearDown(self):
        self._temp.cleanup()

    def _write_worker_heartbeat(self, **fields):
        folder = self.server_root / self.module.BRIDGE_WORKER_DIR
        folder.mkdir(parents=True, exist_ok=True)
        payload = {"Role": self.module.BRIDGE_WORKER_ROLE, "ResQGuiRunning": True}
        payload.update(fields)
        path = folder / "worker.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_a_live_resq_connected_worker_is_required_before_publishing(self):
        with self.assertRaises(self.module.BridgeUnavailableError):
            self.module.require_live_bridge_workers(self.server_root)

        self._write_worker_heartbeat()
        self.assertEqual(len(self.module.require_live_bridge_workers(self.server_root)), 1)

    def test_a_worker_without_resq_is_not_a_usable_worker(self):
        self._write_worker_heartbeat(ResQGuiRunning=False)

        with self.assertRaises(self.module.BridgeUnavailableError):
            self.module.require_live_bridge_workers(self.server_root)

    def test_a_stale_heartbeat_is_not_a_usable_worker(self):
        path = self._write_worker_heartbeat()
        stale = time.time() - (self.module.BRIDGE_WORKER_MAX_AGE_SEC * 10)
        os.utime(path, (stale, stale))

        with self.assertRaises(self.module.BridgeUnavailableError):
            self.module.require_live_bridge_workers(self.server_root)

    def test_no_request_is_published_when_no_worker_is_live(self):
        with self.assertRaises(self.module.BridgeUnavailableError):
            self.module.run_bridge_phase(
                server_root=self.server_root,
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="preview",
                timeout_sec=5.0,
                progress_label="test",
            )

        request_dir = self.server_root / self.module.REQUEST_RELATIVE_DIR
        self.assertFalse(any(request_dir.glob("*.json")) if request_dir.exists() else False)

    def test_a_terminal_error_status_is_reported_with_the_bridge_message(self):
        self._write_worker_heartbeat()
        status_dir = self.server_root / self.module.STATUS_RELATIVE_DIR
        status_dir.mkdir(parents=True, exist_ok=True)

        original_publish = self.module.publish_sync_request

        def publish_and_respond(**kwargs):
            request_path = original_publish(**kwargs)
            (status_dir / f"{kwargs['request_id']}.json").write_text(
                json.dumps({
                    "contract_version": self.module.CONTRACT_VERSION,
                    "request_id": kwargs["request_id"],
                    "status": "error",
                    "message": "ResQ project not found: Demo",
                }),
                encoding="utf-8",
            )
            return request_path

        with patch.object(self.module, "publish_sync_request", side_effect=publish_and_respond):
            with self.assertRaisesRegex(self.module.BridgeRequestError, "ResQ project not found"):
                self.module.run_bridge_phase(
                    server_root=self.server_root,
                    project_name="Demo",
                    rc_path=r"Auto\PP",
                    phase="preview",
                    timeout_sec=5.0,
                    progress_label="test",
                )

    def test_a_successful_phase_returns_the_bridge_result_payload(self):
        self._write_worker_heartbeat()
        status_dir = self.server_root / self.module.STATUS_RELATIVE_DIR
        status_dir.mkdir(parents=True, exist_ok=True)
        preview = [_preview_row("paid-loss")]

        original_publish = self.module.publish_sync_request

        def publish_and_respond(**kwargs):
            request_path = original_publish(**kwargs)
            (status_dir / f"{kwargs['request_id']}.json").write_text(
                json.dumps({
                    "contract_version": self.module.CONTRACT_VERSION,
                    "request_id": kwargs["request_id"],
                    "status": "success",
                    "result": {
                        "status": "review_required",
                        "connection_name": "ResQ Demo",
                        "preview": preview,
                    },
                }),
                encoding="utf-8",
            )
            return request_path

        with patch.object(self.module, "publish_sync_request", side_effect=publish_and_respond):
            result = self.module.run_bridge_phase(
                server_root=self.server_root,
                project_name="Demo",
                rc_path=r"Auto\PP",
                phase="preview",
                timeout_sec=5.0,
                progress_label="test",
            )

        self.assertEqual(result["connection_name"], "ResQ Demo")
        self.assertEqual(result["preview"], preview)


class SyncMacroReviewTableTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()

    def test_review_table_has_both_timestamp_columns_and_cells_for_every_row(self):
        preview = [
            _preview_row("both-present"),
            dict(_preview_row("missing-resq"), resq_timestamp="Not present"),
            dict(_preview_row("unknown"), arcrho_timestamp="Unknown", resq_timestamp="Unknown"),
            dict(
                _preview_row("created-only"),
                arcrho_timestamp="Not present",
                resq_timestamp="Unknown Modified; Created 2026-08-12T09:30:00",
            ),
        ]

        payload = self.module.review_table_payload(preview, "Demo", r"Auto\PP", "ResQ Demo")

        columns = {column["key"]: column["label"] for column in payload["columns"]}
        self.assertEqual(payload["host"], "projectInstance")
        self.assertEqual(columns["arcrho_timestamp"], "ArcRho Timestamp")
        self.assertEqual(columns["resq_timestamp"], "ResQ Timestamp")
        self.assertIn("Both timestamp columns are shown for every row", payload["summary"])
        for row in payload["rows"]:
            with self.subTest(row=row["id"]):
                self.assertIn("arcrho_timestamp", row["cells"])
                self.assertIn("resq_timestamp", row["cells"])

        by_id = {row["id"]: row["cells"] for row in payload["rows"]}
        self.assertEqual(by_id["both-present"]["arcrho_timestamp"], "2026-08-12T10:00:00+00:00")
        self.assertEqual(by_id["both-present"]["resq_timestamp"], "2026-08-12T11:00:00")
        self.assertEqual(by_id["missing-resq"]["resq_timestamp"], "Not present")
        self.assertEqual(by_id["unknown"]["arcrho_timestamp"], "Unknown")
        self.assertEqual(
            by_id["created-only"]["resq_timestamp"],
            "Unknown Modified; Created 2026-08-12T09:30:00",
        )

    def test_async_review_polls_status_key_and_always_closes_dialog(self):
        ui = _ReviewUI()
        preview = [_preview_row("paid-loss"), _preview_row("ultimate-loss")]

        with patch.object(self.module.time, "sleep") as sleep:
            selected = self.module.review_sync_plan(ui, preview, "Demo", r"Auto\PP", "ResQ Demo")

        self.assertEqual(selected, ["paid-loss", "ultimate-loss"])
        self.assertEqual(
            [command for command, _args, _timeout in ui.calls],
            [
                "ui.reviewTableOpen",
                "ui.reviewTableStatus",
                "ui.reviewTableStatus",
                "ui.reviewTableClose",
            ],
        )
        self.assertEqual(ui.calls[-1][1], {"dialogId": "review-1"})
        sleep.assert_called_once_with(self.module.REVIEW_POLL_SECONDS)

    def test_a_cancelled_review_reports_no_selection(self):
        ui = _ReviewUI(accepted=False)

        with patch.object(self.module.time, "sleep"):
            self.assertIsNone(
                self.module.review_sync_plan(ui, [_preview_row("paid-loss")], "Demo", r"Auto\PP", "ResQ Demo")
            )

    def test_only_actionable_reviewed_rows_are_accepted_for_apply(self):
        preview = [
            _preview_row("paid-loss"),
            _preview_row("locked", disabled=True),
            _preview_row("no-action", action=""),
        ]

        rows = self.module.accepted_rows(
            preview,
            ["paid-loss", "locked", "no-action", "paid-loss", "unknown-row"],
        )

        self.assertEqual([row["id"] for row in rows], ["paid-loss"])
        self.assertEqual(rows[0]["signature"], preview[0]["signature"])


class SyncMacroSummaryTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()

    def test_a_stale_result_names_the_changed_items_and_asks_for_a_fresh_review(self):
        message = self.module._sync_summary_message({
            "status": "stale",
            "stale_items": ["Paid Loss"],
        })

        self.assertIn("Paid Loss", message)
        self.assertIn("Run the macro again", message)

    def test_a_completed_result_counts_both_directions(self):
        message = self.module._sync_summary_message({
            "status": "completed",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [
                {"id": "a", "success": True, "action": "arcrho_to_resq"},
                {"id": "b", "success": True, "action": "resq_to_arcrho"},
                {"id": "c", "success": False, "action": "resq_to_arcrho", "name": "C", "message": "failed"},
            ],
        })

        self.assertIn("ArcRho -> ResQ: 1", message)
        self.assertIn("ResQ -> ArcRho: 1", message)
        self.assertIn("Failed or skipped: 1", message)


if __name__ == "__main__":
    unittest.main()
