"""Canonical sidecar audit vocabulary and attribution projection."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from arcrho_api.sidecar_audit_contract import (  # noqa: E402
    AUDIT_ACTION_AUTO_REFRESH,
    AUDIT_ACTION_INSERT,
    AUDIT_ACTION_UPDATE,
    is_automatic_audit_action,
    latest_audit_entry,
    normalize_audit_action,
    sidecar_attribution,
)


class SidecarAuditContractTests(unittest.TestCase):
    def test_action_names_are_the_ones_producers_write(self) -> None:
        self.assertEqual(AUDIT_ACTION_INSERT, "Insert")
        self.assertEqual(AUDIT_ACTION_UPDATE, "Update")
        self.assertEqual(AUDIT_ACTION_AUTO_REFRESH, "Auto Refresh")

    def test_only_an_unattended_rewrite_counts_as_automatic(self) -> None:
        self.assertTrue(is_automatic_audit_action("Auto Refresh"))
        self.assertTrue(is_automatic_audit_action("auto refresh"))
        self.assertFalse(is_automatic_audit_action("Update"))
        self.assertFalse(is_automatic_audit_action(""))
        self.assertFalse(is_automatic_audit_action("Imported"))

    def test_normalization_restores_canonical_casing_and_keeps_the_unknown(self) -> None:
        self.assertEqual(normalize_audit_action("  auto REFRESH "), "Auto Refresh")
        self.assertEqual(normalize_audit_action("insert"), "Insert")
        self.assertEqual(normalize_audit_action("Imported"), "Imported")
        self.assertEqual(normalize_audit_action(None), "")

    def test_the_last_entry_naming_an_action_describes_the_file_as_it_stands(self) -> None:
        entry = latest_audit_entry({
            "audit_log": [
                {"event_date": "2026-08-19T09:00:00Z", "action": "Insert", "user": "Dana Reid"},
                {"event_date": "2026-08-20T14:24:11Z", "action": "Auto Refresh", "user": "Sam Okafor"},
                {"event_date": "2026-08-20T15:00:00Z", "user": "no action recorded"},
            ],
        })
        self.assertEqual(entry["action"], "Auto Refresh")
        self.assertEqual(entry["user"], "Sam Okafor")
        self.assertEqual(entry["at"], "2026-08-20T14:24:11Z")
        self.assertEqual(latest_audit_entry({}), {})
        self.assertEqual(latest_audit_entry({"audit_log": "not a list"}), {})
        self.assertEqual(latest_audit_entry(None), {})

    def test_attribution_prefers_the_audit_entry_and_fills_gaps_from_the_payload(self) -> None:
        self.assertEqual(
            sidecar_attribution({
                "updated_at": "2026-08-20T14:20:00Z",
                "modified_by": "Dana Reid",
                "audit_log": [
                    {"event_date": "2026-08-20T14:24:11Z", "action": "Update", "user": "Sam Okafor"},
                ],
            }),
            {
                "user": "Sam Okafor",
                "action": "Update",
                "at": "2026-08-20T14:24:11Z",
                "automatic": False,
            },
        )
        # A no-op automatic refresh appends no entry and keeps the prior stamp.
        self.assertEqual(
            sidecar_attribution({"updated_at": "2026-08-20T14:20:00Z", "user": "Dana Reid"}),
            {"user": "Dana Reid", "action": "", "at": "2026-08-20T14:20:00Z", "automatic": False},
        )
        self.assertEqual(
            sidecar_attribution({}),
            {"user": "", "action": "", "at": "", "automatic": False},
        )


if __name__ == "__main__":
    unittest.main()
