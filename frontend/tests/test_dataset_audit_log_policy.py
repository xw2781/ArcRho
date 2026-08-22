"""The dataset-service audit log follows the one shared policy."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = FRONTEND_ROOT.parent / "python-api" / "src"
for path in (FRONTEND_ROOT, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.sidecar_audit_contract import DATASET_AUDIT_LOG_MAX_ENTRIES, PROJECT_AUDIT_LOG_MAX_ENTRIES  # noqa: E402
from arcrho_api.sidecar_core_contract import with_audit_log_last  # noqa: E402

from app_server import config  # noqa: E402
from app_server.services import dataset_service  # noqa: E402


class DatasetAuditLogPolicyTests(unittest.TestCase):
    def test_auto_refresh_entries_survive_a_dataset_save(self) -> None:
        # The Engine's propagation walk records `Auto Refresh`; a later
        # interactive save must not erase that history.
        stored = [
            {"event_date": "2026-08-20T14:01:00Z", "action": "Insert", "change_info": "", "user": "Dana"},
            {"event_date": "2026-08-20T14:02:00Z", "action": "Auto Refresh", "change_info": "", "user": "Engine"},
        ]
        payload = {"audit_log": stored}
        dataset_service._append_dataset_audit_entry(
            payload, "update", event_date="2026-08-20T14:03:00Z", user_name="Dana"
        )
        self.assertEqual(
            [item["action"] for item in payload["audit_log"]],
            ["Insert", "Auto Refresh", "Update"],
        )
        self.assertEqual(payload["audit_log"][-1]["change_info"], "Values")

    def test_the_normalizer_keeps_every_action_and_applies_the_shared_cap(self) -> None:
        entries = [
            {"event_date": f"2026-08-20T{index % 24:02d}:00:00Z", "action": "Update", "user": "Dana"}
            for index in range(DATASET_AUDIT_LOG_MAX_ENTRIES + 25)
        ]
        entries.insert(1, {"event_date": "2026-08-21T00:00:00Z", "action": "Imported", "user": "Dana"})
        normalized = dataset_service._normalize_dataset_audit_log(entries)
        self.assertEqual(len(normalized), DATASET_AUDIT_LOG_MAX_ENTRIES)
        self.assertFalse(hasattr(dataset_service, "DATASET_AUDIT_LOG_MAX_ENTRIES"))

    def test_the_project_log_cap_is_the_shared_constant(self) -> None:
        self.assertEqual(config.AUDIT_LOG_MAX_ENTRIES, PROJECT_AUDIT_LOG_MAX_ENTRIES)

    def test_a_merged_older_sidecar_still_writes_its_audit_log_last(self) -> None:
        # A save merges over the file it read, so the log would otherwise keep
        # whatever position the old file gave it.
        merged = {
            "audit_log": [{"event_date": "2026-08-20T14:01:00Z", "action": "Insert", "user": "Dana"}],
            "dataset_name": "Paid",
            "Precedents": [],
        }
        ordered = with_audit_log_last(merged)
        self.assertEqual(list(ordered), ["dataset_name", "Precedents", "audit_log"])
        self.assertEqual(ordered["audit_log"][0]["change_info"], "")


if __name__ == "__main__":
    unittest.main()
