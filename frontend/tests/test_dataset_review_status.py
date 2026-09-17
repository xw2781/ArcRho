from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

TEST_TEMP_ROOT = FRONTEND_ROOT.parent / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

from app_server import config
from app_server.services import dataset_service
from app_server.services import dataset_sidecar_status_service as status_service


class DatasetReviewStatusTests(unittest.TestCase):
    """The Project Instance Mark For Review / Set Reviewed actions."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.sidecars = Path(self.temp_dir.name) / "sidecars"
        self.sidecars.mkdir()
        self.patches = [
            patch.object(
                config,
                "get_project_dataset_sidecar_dir",
                return_value=str(self.sidecars),
            ),
            patch.object(
                dataset_service.user_identity_service,
                "get_current_display_name",
                return_value="Reviewer Name",
            ),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def write_sidecar(
        self,
        name: str,
        *,
        method_type: str,
        source_kind: str,
        status: int,
    ) -> None:
        status_service.write_sidecar(
            status_service.sidecar_path("Project", "Class", name),
            {
                "dataset_name": name,
                "dataset_type": name,
                "project_name": "Project",
                "reserving_class": "Class",
                "method_type": method_type,
                "source_kind": source_kind,
                "status": status,
                "updated_at": "2026-01-01T00:00:00Z",
                "modified_by": "Original Author",
                "precedents": [],
                "dependents": [],
            },
        )

    def read_sidecar(self, name: str) -> dict:
        path = status_service.sidecar_path("Project", "Class", name)
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def set_status(self, names: list[str], status: int) -> dict:
        return dataset_service.set_dataset_review_status("Project", "Class", names, status=status)

    def test_marking_for_review_stamps_the_reviewer_and_the_moment(self) -> None:
        self.write_sidecar(
            "G 41 - BF Paid",
            method_type=status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON,
            source_kind="bornhuetter_ferguson",
            status=status_service.STATUS_CURRENT,
        )
        result = self.set_status(["G 41 - BF Paid"], status_service.STATUS_REVIEW_NEEDED)
        self.assertEqual(result["updated"], ["G 41 - BF Paid"])
        payload = self.read_sidecar("G 41 - BF Paid")
        self.assertEqual(payload["status"], status_service.STATUS_REVIEW_NEEDED)
        self.assertEqual(payload["modified_by"], "Reviewer Name")
        self.assertNotEqual(payload["updated_at"], "2026-01-01T00:00:00Z")

    def test_one_call_settles_a_mixed_selection_on_reviewed(self) -> None:
        self.write_sidecar(
            "Flagged DFM",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            status=status_service.STATUS_REVIEW_NEEDED,
        )
        self.write_sidecar(
            "Current DFM",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            status=status_service.STATUS_CURRENT,
        )
        result = self.set_status(["Flagged DFM", "Current DFM"], status_service.STATUS_CURRENT)
        self.assertEqual(result["updated"], ["Flagged DFM"])
        self.assertEqual(result["unchanged"], ["Current DFM"])
        self.assertEqual(
            self.read_sidecar("Flagged DFM")["status"], status_service.STATUS_CURRENT
        )
        # An object already at the requested status keeps the stamp it had, so
        # the mutation stays idempotent for the hosted transport.
        self.assertEqual(self.read_sidecar("Current DFM")["modified_by"], "Original Author")
        self.assertEqual(self.read_sidecar("Current DFM")["updated_at"], "2026-01-01T00:00:00Z")

    def test_a_dataset_no_method_wrote_is_skipped(self) -> None:
        self.write_sidecar(
            "Net Loss--Paid",
            method_type=status_service.METHOD_TYPE_NONE,
            source_kind="input",
            status=status_service.STATUS_CURRENT,
        )
        result = self.set_status(["Net Loss--Paid", "Missing"], status_service.STATUS_REVIEW_NEEDED)
        self.assertEqual(result["updated"], [])
        self.assertEqual(result["skipped"], ["Net Loss--Paid", "Missing"])
        self.assertEqual(
            self.read_sidecar("Net Loss--Paid")["status"], status_service.STATUS_CURRENT
        )

    def test_the_audit_log_names_the_review_decision(self) -> None:
        """Set Reviewed and Mark For Review each leave their own audit record."""

        self.write_sidecar(
            "G 41 - BF Paid",
            method_type=status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON,
            source_kind="bornhuetter_ferguson",
            status=status_service.STATUS_CURRENT,
        )
        self.set_status(["G 41 - BF Paid"], status_service.STATUS_REVIEW_NEEDED)
        self.set_status(["G 41 - BF Paid"], status_service.STATUS_CURRENT)
        payload = self.read_sidecar("G 41 - BF Paid")
        entries = payload["audit_log"]
        self.assertEqual(
            [item["change_info"] for item in entries],
            ["Marked For Review", "Set Reviewed"],
        )
        for entry in entries:
            # The review decision is a person's, so it keeps the interactive
            # action; an automatic one would collapse with its neighbours.
            self.assertEqual(entry["action"], "Update")
            self.assertEqual(entry["user"], "Reviewer Name")
        # The record carries the moment of the write that produced the file.
        self.assertEqual(entries[-1]["event_date"], payload["updated_at"])

    def test_an_unchanged_object_writes_no_audit_record(self) -> None:
        self.write_sidecar(
            "Current DFM",
            method_type=status_service.METHOD_TYPE_DFM,
            source_kind="dfm",
            status=status_service.STATUS_CURRENT,
        )
        self.set_status(["Current DFM"], status_service.STATUS_CURRENT)
        self.assertEqual(self.read_sidecar("Current DFM").get("audit_log"), [])

    def test_the_flag_change_propagates_to_nothing(self) -> None:
        """A sign-off changes no values, so no dependent is marked or walked."""

        self.write_sidecar(
            "Selected Ultimate",
            method_type=status_service.METHOD_TYPE_RESULT_SELECTION,
            source_kind="result_selection",
            status=status_service.STATUS_CURRENT,
        )
        with patch.object(
            status_service, "refresh_method_statuses_for_dependents"
        ) as refresh, patch.object(
            dataset_service.dependent_propagation_service, "enqueue_save_propagation"
        ) as enqueue:
            self.set_status(["Selected Ultimate"], status_service.STATUS_REVIEW_NEEDED)
        refresh.assert_not_called()
        enqueue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
