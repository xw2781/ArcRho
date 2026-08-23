"""Recording ResQ's save time on a DFM this workspace just uploaded.

An upload writes ArcRho's settings into the RPC server, ResQ saves them and
stamps its own ``Modified``, and the two copies then hold identical content
under different times. The next sync review called the remote newer and offered
to pull back what had just been pushed. These tests pin the reproduction and
the fix: the Bridge reports the time it caused, and the local method records
that same instant without touching anything a revision covers.
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

from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    method_revisions,
    stamp_last_modified,
)
from arcrho_api.timestamps import persisted_timestamp

from app_server.helpers import parse_method_last_modified_timestamp
from app_server.services import (
    dependent_propagation_service,
    dfm_rpc_bridge_service,
    dfm_service,
)

ARCRHO_SAVED_AT = "2026-08-19T14:00:00.000Z"
# ResQ writes a timezone-less wall-clock value in the machine's own timezone.
RESQ_SAVED_AT = "2026-08-19T10:05:30.500000"
# The same instant once the method file holds it: every persisted ArcRho
# timestamp is UTC at millisecond precision with a ``Z``, and a bare value is
# read as this machine's local time, so the expectation is computed rather
# than pinned to one timezone.
RESQ_SAVED_AT_PERSISTED = persisted_timestamp(RESQ_SAVED_AT)


def method_payload(last_modified: str = ARCRHO_SAVED_AT) -> dict:
    return {
        "json_format": DFM_JSON_FORMAT,
        "details_tab": {"name": "M", "output_dataset": "Out"},
        "data_tab": {},
        "ratios_tab": {
            "ratio_triangle": {"excluded": [[0, 1]], "origin_labels": ["a"], "development_labels": ["x", "y"]},
            "average_formulas": {"label": ["Straight"]},
        },
        "results_tab": {},
        "method_metadata": {"last_modified": last_modified, "refreshed": "keep me"},
    }


class StampContractTests(unittest.TestCase):
    def test_the_stamp_touches_only_the_timestamp(self) -> None:
        base = method_payload()
        stamped = stamp_last_modified(base, RESQ_SAVED_AT)
        self.assertEqual(stamped["method_metadata"]["last_modified"], RESQ_SAVED_AT_PERSISTED)
        self.assertEqual(stamped["method_metadata"]["refreshed"], "keep me")
        self.assertEqual(base["method_metadata"]["last_modified"], ARCRHO_SAVED_AT)
        for tab in ("details_tab", "ratios_tab", "results_tab"):
            self.assertEqual(stamped[tab], base[tab])

    def test_the_stamp_cannot_shift_a_revision(self) -> None:
        # This is what lets the record run outside a save: an editor open on
        # this method keeps its optimistic-concurrency token.
        base = method_payload()
        self.assertEqual(method_revisions(base), method_revisions(stamp_last_modified(base, RESQ_SAVED_AT)))

    def test_an_empty_value_is_refused_rather_than_stamped_as_now(self) -> None:
        with self.assertRaises(Exception):
            dfm_service.record_rpc_sync_last_modified("Demo", "COL", "M", "   ")


class RecordOnDiskTests(unittest.TestCase):
    def _run(self, payload: dict | None, value: str = RESQ_SAVED_AT, *, busy: bool = False) -> tuple[dict, dict | None]:
        with tempfile.TemporaryDirectory() as folder:
            method_path = os.path.join(folder, "DFM@M.json")
            if payload is not None:
                with open(method_path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)
            with (
                patch.object(dfm_service, "_method_path", return_value=method_path),
                patch.object(
                    dependent_propagation_service,
                    "get_reserving_class_busy",
                    return_value={"ok": True, "busy": busy, "reason": "walk" if busy else None},
                ),
            ):
                result = dfm_service.record_rpc_sync_last_modified("Demo", "COL", "M", value)
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
        self.assertEqual(written["ratios_tab"]["ratio_triangle"]["excluded"], [[0, 1]])

    def test_recording_the_same_value_twice_rewrites_nothing(self) -> None:
        result, _ = self._run(method_payload(RESQ_SAVED_AT_PERSISTED))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "unchanged")

    def test_a_propagation_walk_owning_the_class_stands_the_record_down(self) -> None:
        # The walk rewrites whole method files from another process; reverting
        # what it wrote would be worse than leaving the timestamp stale.
        result, written = self._run(method_payload(), busy=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "class_busy")
        self.assertEqual(written["method_metadata"]["last_modified"], ARCRHO_SAVED_AT)

    def test_a_missing_or_legacy_method_is_reported_not_created(self) -> None:
        result, written = self._run(None)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "missing")
        self.assertIsNone(written)

        legacy = method_payload()
        legacy["json_format"] = "arcrho-dfm-method-by-tab-v1"
        result, written = self._run(legacy)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "not_v2")
        self.assertEqual(written["method_metadata"]["last_modified"], ARCRHO_SAVED_AT)


class ComparisonAfterUploadTests(unittest.TestCase):
    """The reported symptom, and that the recorded time removes it."""

    def _compare_state(self, local_time: str, remote_time: str) -> str:
        local = {"exists": True, "last_modified_timestamp": parse_method_last_modified_timestamp(local_time)}
        remote = {"exists": True, "last_modified_timestamp": parse_method_last_modified_timestamp(remote_time)}
        return dfm_rpc_bridge_service._compare_state(local, remote)

    def test_without_the_record_the_next_sync_calls_the_remote_newer(self) -> None:
        # ResQ saved after ArcRho did, so its Modified is later even though the
        # settings are the ones ArcRho just sent.
        self.assertEqual(self._compare_state("2026-08-19T10:00:00", "2026-08-19T10:05:30.500000"), "remote_latest")

    def test_with_the_record_the_two_copies_compare_equal(self) -> None:
        # The file holds the persisted (UTC) form and ResQ reports its local
        # wall-clock reading; both parse to the same instant.
        self.assertEqual(self._compare_state(RESQ_SAVED_AT_PERSISTED, RESQ_SAVED_AT), "same_time")

    def test_stamping_this_machine_s_clock_would_not_have_fixed_it(self) -> None:
        # Why the fix copies ResQ's value: a local "now" is a different instant,
        # and on a client whose clock trails the server the remote still wins.
        client_now = "2026-08-19T10:05:29.000000"
        self.assertEqual(self._compare_state(client_now, RESQ_SAVED_AT), "remote_latest")


class UpdateRemoteWiringTests(unittest.TestCase):
    def _status(self, **extra) -> dict:
        return {"ok": True, "status": "passed", "message": "Remote database updated", **extra}

    def test_a_successful_upload_records_the_reported_time(self) -> None:
        request = _request()
        with patch.object(dfm_service, "record_rpc_sync_last_modified", return_value={"ok": True, "status": "stamped"}) as record:
            outcome = dfm_rpc_bridge_service._record_remote_sync_time(
                request, self._status(**{"last_modified": RESQ_SAVED_AT})
            )
        record.assert_called_once_with("Demo", "COL", "M", RESQ_SAVED_AT)
        self.assertTrue(outcome["ok"])

    def test_a_bridge_that_does_not_report_it_leaves_the_local_value_alone(self) -> None:
        with patch.object(dfm_service, "record_rpc_sync_last_modified") as record:
            outcome = dfm_rpc_bridge_service._record_remote_sync_time(_request(), self._status())
        record.assert_not_called()
        self.assertEqual(outcome["status"], "not_reported")

    def test_a_failed_record_does_not_turn_a_successful_upload_into_a_failure(self) -> None:
        from fastapi import HTTPException

        with patch.object(dfm_service, "record_rpc_sync_last_modified", side_effect=HTTPException(423, "locked")):
            outcome = dfm_rpc_bridge_service._record_remote_sync_time(
                _request(), self._status(**{"last_modified": RESQ_SAVED_AT})
            )
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["status"], "failed")
        self.assertEqual(outcome["error"], "locked")

    def test_a_failed_upload_is_never_recorded(self) -> None:
        request = _request()
        paths = {
            "rpc_methods_dir": "", "remote_path": "", "sync_status_path": "",
            "request_dir": "", "local_path": "", "project_dir": "", "data_dir": "", "method_dir": "",
        }
        with (
            patch.object(dfm_rpc_bridge_service, "build_paths", return_value=paths),
            patch.object(dfm_rpc_bridge_service.os, "makedirs"),
            patch.object(dfm_rpc_bridge_service, "_try_remove", return_value=False),
            patch.object(dfm_rpc_bridge_service, "_local_method_notes", return_value={"exists": False, "text": ""}),
            patch.object(dfm_rpc_bridge_service, "_write_request_file", return_value="request.json"),
            patch.object(dfm_rpc_bridge_service, "wait_for_file", return_value=True),
            patch.object(dfm_rpc_bridge_service, "_read_json", return_value={"ok": False, "status": "failed", "message": "no"}),
            patch.object(dfm_rpc_bridge_service, "_record_remote_sync_time") as record,
        ):
            response = dfm_rpc_bridge_service.update_remote(request)
        record.assert_not_called()
        self.assertFalse(response["ok"])
        self.assertEqual(response["last_modified_record"]["status"], "not_attempted")


def _request():
    from app_server.schemas.dfm_rpc_bridge import DfmRpcBridgeUpdateRemoteRequest

    return DfmRpcBridgeUpdateRemoteRequest(
        project_name="Demo",
        reserving_class="COL",
        method_name="M",
        output_vector="Out",
        input_triangle="Paid",
        origin_length=12,
        development_length=12,
        rpc_server_write_confirmed=True,
    )


if __name__ == "__main__":
    unittest.main()
