"""Saving a dataset whose figures are produced elsewhere.

An Engine output, a formula result and a method's output all share one rule:
the Data tab may change how they are shown -- the display lengths, cumulative,
the development/calendar mode, the number format, the subtotal row, the
orientation and the notes -- and nothing else, because the grid and the link
tabs are read-only there. Such a save writes no CSV and publishes none, so
nothing a dependent reads has moved and the dependent walk is skipped.

A hand-entered dataset is deliberately the opposite case: saving one that
nobody changed is how a user forces its dependents to recalculate.
"""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

from app_server.services import calculated_dataset_service, dataset_service
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace


MONTHLY_CSV = "Dataset@1@1@cum@dev.csv"


class ReformatOnlyDatasetSaveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = self.temp.name
        self.sidecar_path = os.path.join(self.data_dir, "Dataset.json")
        self.csv_path = os.path.join(self.data_dir, MONTHLY_CSV)
        pd.DataFrame([[100.0, 110.0], [120.0, 130.0]]).to_csv(
            self.csv_path, header=False, index=False
        )
        self.existing = {
            "dataset_name": "Dataset",
            "dataset_type": "Engine Type",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "engine",
            "data_format": "Triangle",
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 1,
            "stored_development_length": 1,
            "cumulative": True,
            "calendar": False,
            "csv_file": MONTHLY_CSV,
            "number_format": "0,000",
            "decimal_places": 0,
            "notes": "Old notes.",
            "created": "2026-09-01T10:00:00Z",
            "updated_at": "2026-09-15T12:00:00Z",
            "modified_by": "Engine Author",
            "audit_log": [{"event_date": "2026-09-15T12:00:00Z", "action": "Update", "user": "Engine Author"}],
            "precedents": [{"name": "Paid Loss"}],
            "origin_labels": ["2020", "2021"],
        }

    def tearDown(self) -> None:
        self.temp.cleanup()
        self.propagation_workspace.stop()

    def _save(self, *, app_calculated: bool = False, **kwargs):
        written: dict = {}
        enqueued: list = []

        def capture_write(path, payload):
            written["path"] = path
            written["payload"] = copy.deepcopy(payload)

        def capture_enqueue(project_name, reserving_class, changed_roots):
            enqueued.append((project_name, reserving_class, list(changed_roots)))
            return {"ok": True, "status": "queued", "job_id": "test"}

        with (
            patch.object(dataset_service, "_current_user_name", return_value="Format Editor"),
            patch.object(dataset_service, "_now_utc_iso", return_value="2026-09-16T12:00:00Z"),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value=self.sidecar_path),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=copy.deepcopy(self.existing)),
            patch.object(dataset_service, "_write_dataset_sidecar_payload", side_effect=capture_write),
            patch.object(
                dataset_service,
                "_is_app_calculated_dataset_type",
                return_value=(app_calculated, '"Premium" * "Loss Ratio"' if app_calculated else ""),
            ),
            patch.object(
                dataset_service.config,
                "get_project_dataset_cache_dir",
                return_value=self.data_dir,
            ),
            patch.object(dataset_service.dataset_instance_index_service, "rebuild_index"),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields"),
            patch.object(
                dataset_service.dependent_propagation_service,
                "enqueue_save_propagation",
                side_effect=capture_enqueue,
            ),
        ):
            defaults = {
                "dataset_type": "Engine Type",
                "origin_length": 12,
                "development_length": 12,
                "number_format": "0,000",
                "decimal_places": 0,
            }
            defaults.update(kwargs)
            result = dataset_service.save_dataset_sidecar(
                "Project", "Class", "Dataset", **defaults
            )

        return result, written.get("payload"), enqueued

    def test_number_format_preserves_modification_metadata(self) -> None:
        for source_kind in ("engine", "calculated", "dfm"):
            with self.subTest(source_kind=source_kind):
                self.existing["source_kind"] = source_kind
                result, payload, _enqueued = self._save(number_format="0,000.00", decimal_places=2)

                self.assertEqual(payload["number_format"], "0,000.00")
                self.assertEqual(payload["decimal_places"], 2)
                for field in ("created", "updated_at", "modified_by", "audit_log"):
                    self.assertEqual(payload[field], self.existing[field])
                self.assertEqual(result["updated_at"], self.existing["updated_at"])
                self.assertEqual(result["audit_log"], self.existing["audit_log"])

    def test_notes_edit_still_records_the_editor(self) -> None:
        _result, payload, _enqueued = self._save(notes="New notes.")

        self.assertEqual(payload["updated_at"], "2026-09-16T12:00:00Z")
        self.assertEqual(payload["modified_by"], "Format Editor")
        self.assertEqual(len(payload["audit_log"]), 2)

    def test_the_display_settings_and_notes_are_saved(self) -> None:
        result, payload, _enqueued = self._save(
            origin_length=6,
            development_length=6,
            cumulative=False,
            calendar=True,
            transposed=True,
            show_subtotal=False,
            number_format="0,000.00",
            decimal_places=2,
            notes="New notes.",
        )

        self.assertEqual(payload["origin_length"], 6)
        self.assertEqual(payload["development_length"], 6)
        self.assertFalse(payload["cumulative"])
        self.assertTrue(payload["calendar"])
        self.assertTrue(payload["transposed"])
        self.assertFalse(payload["show_subtotal"])
        self.assertEqual(payload["number_format"], "0,000.00")
        self.assertEqual(payload["decimal_places"], 2)
        self.assertEqual(payload["notes"], "New notes.")
        self.assertEqual(result["origin_length"], 6)

    def test_the_stored_csv_is_not_touched_at_all(self) -> None:
        # The bytes, the modification time and the folder listing are all
        # exactly what they were, so no file was rewritten, renamed or added
        # beside the one the dataset already had.
        before_bytes = Path(self.csv_path).read_bytes()
        old_time = os.stat(self.csv_path).st_mtime - 3600
        os.utime(self.csv_path, (old_time, old_time))
        before_listing = sorted(os.listdir(self.data_dir))

        result, payload, _enqueued = self._save(origin_length=6, development_length=6)

        self.assertEqual(Path(self.csv_path).read_bytes(), before_bytes)
        self.assertAlmostEqual(os.stat(self.csv_path).st_mtime, old_time, places=3)
        self.assertEqual(sorted(os.listdir(self.data_dir)), before_listing)
        self.assertEqual(payload["csv_file"], MONTHLY_CSV)
        # No file was named, so the save has no CSV to hand back.
        self.assertEqual(result["csv_path"], "")
        self.assertEqual(result["ds_id"], "")
        self.assertIsNone(result["file_mtime"])

    def test_the_stored_period_stays_where_the_file_is(self) -> None:
        # The display moves and the store does not follow it, and `Stored at`
        # -- the one control that moves a store -- cannot be reached from here.
        _result, payload, _enqueued = self._save(
            origin_length=12,
            development_length=12,
            stored_development_length=6,
        )

        self.assertEqual(payload["stored_origin_length"], 1)
        self.assertEqual(payload["stored_development_length"], 1)

    def test_the_graph_and_the_source_are_left_alone(self) -> None:
        _result, payload, _enqueued = self._save(origin_length=6)

        self.assertEqual(payload["source_kind"], "engine")
        self.assertEqual(payload["data_format"], "Triangle")
        self.assertEqual(payload["precedents"], [{"name": "Paid Loss"}])
        self.assertEqual(payload["origin_labels"], ["2020", "2021"])

    def test_no_dependent_is_refreshed(self) -> None:
        result, _payload, enqueued = self._save(origin_length=6)

        self.assertEqual(enqueued, [])
        self.assertEqual(result["calculated_updates"], {"ok": True, "status": "unchanged"})
        self.assertTrue(result["propagation_ok"])

    def test_a_formula_output_is_the_same_case(self) -> None:
        # A Dataset Type formula makes a sidecar's grid read-only whatever its
        # source kind says, so its Data tab can only reformat it either.
        self.existing["source_kind"] = "input"
        _result, _payload, enqueued = self._save(origin_length=6, app_calculated=True)

        self.assertEqual(enqueued, [])

    def test_a_hand_entered_dataset_still_refreshes_its_dependents(self) -> None:
        # Saving one unchanged is how a user forces the recalculation, so this
        # is the case that must keep propagating.
        self.existing["source_kind"] = "input"
        _result, payload, enqueued = self._save(origin_length=12)

        self.assertEqual(len(enqueued), 1)
        self.assertEqual(payload["updated_at"], "2026-09-16T12:00:00Z")
        self.assertEqual(payload["modified_by"], "Format Editor")

    def test_a_published_file_still_refreshes_its_dependents(self) -> None:
        # A method republishing its own output names the CSV it wrote, so the
        # figures did move and the walk has work to do.
        _result, payload, enqueued = self._save(csv_file=MONTHLY_CSV)

        self.assertEqual(len(enqueued), 1)
        self.assertEqual(payload["updated_at"], "2026-09-16T12:00:00Z")
        self.assertEqual(payload["modified_by"], "Format Editor")

    def test_a_vector_keeps_its_stored_period(self) -> None:
        vector_csv = "Dataset@1.csv"
        self.csv_path = os.path.join(self.data_dir, vector_csv)
        pd.DataFrame([[100.0], [120.0]]).to_csv(self.csv_path, header=False, index=False)
        self.existing = {
            "dataset_name": "Dataset",
            "dataset_type": "Engine Type",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "engine",
            "data_format": "Vector",
            "period_length": 1,
            "stored_period_length": 1,
            "csv_file": vector_csv,
            "number_format": "0,000",
            "decimal_places": 0,
            "created": self.existing["created"],
            "updated_at": self.existing["updated_at"],
            "modified_by": self.existing["modified_by"],
            "audit_log": self.existing["audit_log"],
        }
        before_bytes = Path(self.csv_path).read_bytes()

        _result, payload, enqueued = self._save(origin_length=12, development_length=12)

        self.assertEqual(payload["period_length"], 12)
        self.assertEqual(payload["stored_period_length"], 1)
        self.assertEqual(payload["csv_file"], vector_csv)
        self.assertEqual(Path(self.csv_path).read_bytes(), before_bytes)
        self.assertEqual(enqueued, [])

    def test_the_plan_names_no_root_for_a_reformat(self) -> None:
        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value=self.sidecar_path),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=copy.deepcopy(self.existing)),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
        ):
            reformat = dataset_service.save_propagation_roots(
                "Project", "Class", "Dataset", dataset_type="Engine Type"
            )
            with_values = dataset_service.save_propagation_roots(
                "Project", "Class", "Dataset", dataset_type="Engine Type", values=[[1.0]]
            )

        self.assertEqual(reformat, [])
        self.assertEqual(with_values, [("Dataset", "Engine Type")])


if __name__ == "__main__":
    unittest.main()
