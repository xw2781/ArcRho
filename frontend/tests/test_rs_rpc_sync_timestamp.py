"""Recording ResQ's save time on a Result Selection this workspace just uploaded.

The DFM bridge already does this; Result Selection needed one thing first. Its
``method_revision`` hashed the whole method file, timestamp included, so writing
ResQ's save time against the local copy would have moved the token an open
editor saves with. The revision now covers content only, as every other method
family's already does.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_api.timestamps import persisted_timestamp
from app_server.helpers import parse_method_last_modified_timestamp
from app_server.services import (
    dependent_propagation_service,
    result_selection_rpc_bridge_service,
    result_selection_service,
)
from app_server.schemas.result_selection_rpc_bridge import (
    ResultSelectionRpcBridgeUpdateRemoteRequest,
)

ARCRHO_SAVED_AT = "2026-08-19T14:00:00.000Z"
# ResQ writes a timezone-less wall-clock value in the machine's own timezone.
RESQ_SAVED_AT = "2026-08-19T10:05:30.500000"
# The same instant in the one persisted form (UTC, milliseconds, ``Z``); a
# bare value is read as local time, so this is computed, not pinned.
RESQ_SAVED_AT_PERSISTED = persisted_timestamp(RESQ_SAVED_AT)


def method_payload(last_modified: str = ARCRHO_SAVED_AT) -> dict:
    return {
        "json_format": result_selection_service.RESULT_SELECTION_JSON_FORMAT,
        "details_tab": {"name": "M", "output_type": "Ultimate", "origin_length": 12},
        "method_tab": {"origin_labels": ["2020"], "loaded_datasets": []},
        "method_metadata": {"last_modified": last_modified, "updated_by": "keep me"},
    }


def request() -> ResultSelectionRpcBridgeUpdateRemoteRequest:
    return ResultSelectionRpcBridgeUpdateRemoteRequest(
        project_name="Demo",
        reserving_class="COL",
        method_name="M",
        output_type="Ultimate",
        origin_length=12,
        rpc_server_write_confirmed=True,
    )


class RevisionTests(unittest.TestCase):
    def test_the_revision_ignores_the_timestamp(self) -> None:
        # This is what lets the record run outside a save.
        self.assertEqual(
            result_selection_service._method_revision(method_payload()),
            result_selection_service._method_revision(method_payload(RESQ_SAVED_AT)),
        )

    def test_the_revision_still_covers_the_content(self) -> None:
        edited = method_payload()
        edited["method_tab"]["origin_labels"] = ["2021"]
        self.assertNotEqual(
            result_selection_service._method_revision(method_payload()),
            result_selection_service._method_revision(edited),
        )


class RecordOnDiskTests(unittest.TestCase):
    def _run(self, payload: dict | None, value: str = RESQ_SAVED_AT, *, busy: bool = False):
        with tempfile.TemporaryDirectory() as folder:
            method_path = os.path.join(folder, "RS@M.json")
            if payload is not None:
                with open(method_path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)
            with (
                patch.object(result_selection_service, "_method_path", return_value=method_path),
                patch.object(
                    dependent_propagation_service,
                    "get_reserving_class_busy",
                    return_value={"ok": True, "busy": busy, "reason": "walk" if busy else None},
                ),
            ):
                result = result_selection_service.record_rpc_sync_last_modified("Demo", "COL", "M", value)
            written = None
            if os.path.exists(method_path):
                with open(method_path, "r", encoding="utf-8") as handle:
                    written = json.load(handle)
        return result, written

    def test_the_local_method_records_the_time_resq_reported(self) -> None:
        result, written = self._run(method_payload())
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "stamped")
        self.assertEqual(result["previous_last_modified"], ARCRHO_SAVED_AT)
        self.assertEqual(written["method_metadata"]["last_modified"], RESQ_SAVED_AT_PERSISTED)
        self.assertEqual(written["method_metadata"]["updated_by"], "keep me")
        self.assertEqual(written["method_tab"], method_payload()["method_tab"])

    def test_the_record_leaves_an_open_editor_able_to_save(self) -> None:
        before = result_selection_service._method_revision(method_payload())
        _result, written = self._run(method_payload())
        self.assertEqual(result_selection_service._method_revision(written), before)

    def test_recording_the_same_value_twice_rewrites_nothing(self) -> None:
        result, _ = self._run(method_payload(RESQ_SAVED_AT_PERSISTED))
        self.assertEqual(result["status"], "unchanged")

    def test_a_propagation_walk_owning_the_class_stands_the_record_down(self) -> None:
        result, written = self._run(method_payload(), busy=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "class_busy")
        self.assertEqual(written["method_metadata"]["last_modified"], ARCRHO_SAVED_AT)

    def test_a_missing_or_unrecognised_method_is_reported_not_created(self) -> None:
        result, written = self._run(None)
        self.assertEqual(result["status"], "missing")
        self.assertIsNone(written)

        # Only the current stamp is read; any other is left exactly as found.
        foreign = method_payload()
        foreign["json_format"] = "not-a-result-selection"
        result, written = self._run(foreign)
        self.assertEqual(result["status"], "not_v2")
        self.assertEqual(written["method_metadata"]["last_modified"], ARCRHO_SAVED_AT)

    def test_an_empty_value_is_refused_rather_than_stamped_as_now(self) -> None:
        with self.assertRaises(HTTPException):
            result_selection_service.record_rpc_sync_last_modified("Demo", "COL", "M", "  ")


class ComparisonAfterUploadTests(unittest.TestCase):
    def _compare_state(self, local_time: str, remote_time: str) -> str:
        local = {"exists": True, "last_modified_timestamp": parse_method_last_modified_timestamp(local_time)}
        remote = {"exists": True, "last_modified_timestamp": parse_method_last_modified_timestamp(remote_time)}
        return result_selection_rpc_bridge_service._compare_state(local, remote)

    def test_without_the_record_the_next_sync_calls_the_remote_newer(self) -> None:
        self.assertEqual(self._compare_state("2026-08-19T10:00:00", RESQ_SAVED_AT), "remote_latest")

    def test_with_the_record_the_two_copies_compare_equal(self) -> None:
        # The file holds the persisted (UTC) form and ResQ reports its local
        # wall-clock reading; both parse to the same instant.
        self.assertEqual(self._compare_state(RESQ_SAVED_AT_PERSISTED, RESQ_SAVED_AT), "same_time")


class UpdateRemoteWiringTests(unittest.TestCase):
    def _status(self, **extra) -> dict:
        return {"ok": True, "status": "passed", "message": "Remote Result Selection updated", **extra}

    def test_a_successful_upload_records_the_reported_time(self) -> None:
        with patch.object(result_selection_service, "record_rpc_sync_last_modified", return_value={"ok": True, "status": "stamped"}) as record:
            outcome = result_selection_rpc_bridge_service._record_remote_sync_time(
                request(), self._status(**{"last_modified": RESQ_SAVED_AT})
            )
        record.assert_called_once_with("Demo", "COL", "M", RESQ_SAVED_AT)
        self.assertTrue(outcome["ok"])

    def test_a_bridge_that_does_not_report_it_leaves_the_local_value_alone(self) -> None:
        with patch.object(result_selection_service, "record_rpc_sync_last_modified") as record:
            outcome = result_selection_rpc_bridge_service._record_remote_sync_time(request(), self._status())
        record.assert_not_called()
        self.assertEqual(outcome["status"], "not_reported")

    def test_a_failed_record_does_not_turn_a_successful_upload_into_a_failure(self) -> None:
        with patch.object(result_selection_service, "record_rpc_sync_last_modified", side_effect=HTTPException(423, "locked")):
            outcome = result_selection_rpc_bridge_service._record_remote_sync_time(
                request(), self._status(**{"last_modified": RESQ_SAVED_AT})
            )
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["error"], "locked")


if __name__ == "__main__":
    unittest.main()
