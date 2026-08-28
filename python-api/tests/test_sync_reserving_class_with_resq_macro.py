"""Cover the Sync Reserving Class with ResQ macro's client side.

The macro owns no ResQ session: it publishes logical requests through the
shared queue client (``arcrho_api.resq_sync_queue``, covered by
``test_resq_sync_queue``) and renders what a ResQ-connected Bridge worker
reports. These tests cover what is the macro's own: the review table it opens
before writing, which rows it hands back as accepted, and the results it
shows afterwards.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


_MACRO_PATH = (
    Path(__file__).resolve().parents[1]
    / "macros"
    / "sync_reserving_class_with_resq.py"
)
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from arcrho_api import ui as ui_module  # noqa: E402


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


def _preview_row(
    row_id: str, *, action: str = "arcrho_to_resq", disabled: bool = False, review: bool = False
) -> dict:
    return {
        "id": row_id,
        "signature": {"key": row_id, "action": action, "arcrho": {"modified_timestamp": 100.0}},
        "name": row_id.replace("-", " ").title(),
        "kind": "Dataset",
        "arcrho_timestamp": "2026-08-12T10:00:00+00:00",
        "resq_timestamp": "2026-08-12T11:00:00",
        "status": "ArcRho is newer",
        "action": action,
        "detail": "Test detail",
        "selected": True,
        "disabled": disabled,
        "review": review,
    }


def _direction(action: str = "arcrho_to_resq") -> dict:
    return {
        "action": action,
        "label": "ArcRho -> ResQ" if action == "arcrho_to_resq" else "ResQ -> ArcRho",
        "arcrho_timestamp": "8/12/2026 6:00:00 AM",
        "resq_timestamp": "8/12/2026 7:00:00 AM",
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


class SyncMacroReviewTableTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()

    def test_review_table_has_both_timestamp_columns_and_cells_for_every_row(self):
        preview = [
            _preview_row("both-present"),
            dict(_preview_row("unknown"), arcrho_timestamp="Unknown", resq_timestamp="Unknown"),
            dict(
                _preview_row("created-only"),
                resq_timestamp="Unknown Modified; Created 2026-08-12T09:30:00",
            ),
        ]

        payload = self.module.review_table_payload(preview, "Demo", r"Auto\PP", "ResQ Demo", _direction())

        columns = {column["key"]: column["label"] for column in payload["columns"]}
        self.assertEqual(payload["host"], "projectInstance")
        self.assertEqual(columns["arcrho_timestamp"], "ArcRho Timestamp")
        self.assertEqual(columns["resq_timestamp"], "ResQ Timestamp")
        for row in payload["rows"]:
            with self.subTest(row=row["id"]):
                self.assertIn("arcrho_timestamp", row["cells"])
                self.assertIn("resq_timestamp", row["cells"])

        by_id = {row["id"]: row["cells"] for row in payload["rows"]}
        self.assertEqual(by_id["both-present"]["arcrho_timestamp"], "2026-08-12T10:00:00+00:00")
        self.assertEqual(by_id["both-present"]["resq_timestamp"], "2026-08-12T11:00:00")
        self.assertEqual(by_id["unknown"]["arcrho_timestamp"], "Unknown")
        self.assertEqual(
            by_id["created-only"]["resq_timestamp"],
            "Unknown Modified; Created 2026-08-12T09:30:00",
        )

    def test_review_table_names_one_direction_and_marks_review_rows_without_unticking_them(self):
        preview = [_preview_row("paid-loss"), _preview_row("incurred-loss", review=True)]

        payload = self.module.review_table_payload(preview, "Demo", r"Auto\PP", "ResQ Demo", _direction())

        columns = [column["key"] for column in payload["columns"]]
        self.assertNotIn("action", columns)
        self.assertIn("review", columns)
        self.assertIn("Latest ArcRho change: 8/12/2026 6:00:00 AM", payload["summary"])
        self.assertIn("Latest ResQ change: 8/12/2026 7:00:00 AM", payload["summary"])
        self.assertIn("Direction: ArcRho to ResQ", payload["summary"])
        self.assertIn("2 can be pushed; 2 are selected; 1 marked for review.", payload["summary"])
        self.assertEqual(payload["acceptLabel"], "Sync to ResQ")
        by_id = {row["id"]: row for row in payload["rows"]}
        self.assertEqual(by_id["paid-loss"]["cells"]["review"], {"text": "", "tone": "warn"})
        self.assertEqual(by_id["incurred-loss"]["cells"]["review"], {"text": "Review", "tone": "warn"})
        self.assertEqual(by_id["incurred-loss"]["cells"]["status"]["tone"], "warn")
        self.assertTrue(by_id["incurred-loss"]["selected"])
        self.assertFalse(by_id["incurred-loss"]["disabled"])

        undecided = self.module.review_table_payload(
            [_preview_row("paid-loss", action="", disabled=True)],
            "Demo",
            r"Auto\PP",
            "ResQ Demo",
            {"action": "", "label": "", "arcrho_timestamp": "Unknown", "resq_timestamp": "Unknown"},
        )
        self.assertIn("Direction: none, neither side is newer", undecided["summary"])
        self.assertEqual(undecided["acceptLabel"], "Apply Selected")

    def test_async_review_polls_status_key_and_always_closes_dialog(self):
        ui = _ReviewUI()
        preview = [_preview_row("paid-loss"), _preview_row("ultimate-loss")]

        with patch("time.sleep") as sleep:
            selected = self.module.review_sync_plan(ui, preview, "Demo", r"Auto\PP", "ResQ Demo", _direction())

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
        sleep.assert_called_once_with(ui_module.REVIEW_TABLE_POLL_SECONDS)

    def test_a_cancelled_review_reports_no_selection(self):
        ui = _ReviewUI(accepted=False)

        with patch("time.sleep"):
            self.assertIsNone(
                self.module.review_sync_plan(
                    ui, [_preview_row("paid-loss")], "Demo", r"Auto\PP", "ResQ Demo", _direction()
                )
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

    def test_an_empty_selection_reports_that_nothing_changed(self):
        message = self.module._sync_summary_message({"status": "no_changes"})

        self.assertIn("Nothing was changed", message)

    def test_a_completed_result_becomes_a_read_only_table_with_one_row_per_item(self):
        payload = self.module.sync_result_table_payload({
            "status": "completed_with_errors",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "direction": _direction("resq_to_arcrho"),
            "preview": [
                _preview_row("a", action="resq_to_arcrho"),
                _preview_row("b", action="resq_to_arcrho"),
                _preview_row("c", action="resq_to_arcrho"),
            ],
            "results": [
                {"id": "a", "name": "A", "kind": "Dataset", "success": True, "action": "resq_to_arcrho", "message": "Imported"},
                {"id": "b", "name": "B", "kind": "DFM", "success": True, "action": "resq_to_arcrho", "message": "Imported"},
                {"id": "c", "name": "C", "kind": "Dataset", "success": False, "action": "resq_to_arcrho", "message": "failed"},
                {"id": "", "name": "Dependent refresh", "kind": "Warning", "success": False, "action": "", "message": "stale DFM"},
            ],
        })

        self.assertEqual(payload["host"], "projectInstance")
        self.assertFalse(payload["selectable"])
        self.assertEqual(payload["acceptLabel"], "Close")
        self.assertIn("completed with errors", payload["summary"])
        self.assertIn("Direction: ResQ to ArcRho. Applied 2 of 3 accepted action(s); 1 failed", payload["summary"])
        self.assertIn("1 dependent-refresh warning(s)", payload["summary"])
        self.assertEqual([row["id"] for row in payload["rows"]], ["result-1", "result-2", "result-3", "result-4"])
        cells = [row["cells"] for row in payload["rows"]]
        self.assertNotIn("direction", cells[0])
        self.assertEqual(
            [cell["outcome"] for cell in cells],
            [
                {"text": "Applied", "tone": "ok"},
                {"text": "Applied", "tone": "ok"},
                {"text": "Failed", "tone": "error"},
                {"text": "Warning", "tone": "warn"},
            ],
        )
        self.assertEqual(cells[2]["detail"], "failed")
        self.assertEqual(cells[3]["name"], "Dependent refresh")

    def test_a_recalculated_downstream_item_is_reported_without_counting_as_applied(self):
        payload = self.module.sync_result_table_payload({
            "status": "completed",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "direction": _direction(),
            "preview": [_preview_row("a"), _preview_row("d", action="", disabled=True)],
            "results": [
                {"id": "a", "name": "A", "kind": "DFM", "success": True, "action": "arcrho_to_resq", "message": "Written"},
                {
                    "id": "d",
                    "name": "D",
                    "kind": "Result Selection",
                    "success": True,
                    "absorbed": True,
                    "action": "",
                    "message": "Recalculated on the ResQ side by this run's writes.",
                },
            ],
        })

        self.assertIn(
            "Direction: ArcRho to ResQ. Applied 1 of 1 accepted action(s); 0 failed; "
            "1 recalculated item(s) re-baselined.",
            payload["summary"],
        )
        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual(cells[1]["outcome"], {"text": "Recalculated", "tone": "info"})
        self.assertEqual(cells[1]["kind"], "Result Selection")

    def test_the_results_table_stays_open_until_the_user_closes_it(self):
        ui = _ReviewUI(selected_row_ids=(), accepted=True)
        payload = self.module.sync_result_table_payload({"status": "completed", "results": []})

        with patch("time.sleep"):
            completion = self.module._await_review_table(ui, payload)

        self.assertEqual(completion["status"], "completed")
        self.assertEqual(
            [command for command, _args, _timeout in ui.calls],
            ["ui.reviewTableOpen", "ui.reviewTableStatus", "ui.reviewTableStatus", "ui.reviewTableClose"],
        )
        self.assertFalse(ui.calls[0][1]["selectable"])


if __name__ == "__main__":
    unittest.main()
