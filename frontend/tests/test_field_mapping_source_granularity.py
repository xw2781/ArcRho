"""How fine a project's source data is, recorded in its field mapping.

The granularity of the `Origin Date` and `Development Date` columns is what an
Engine-generated dataset's stored shape is written from, so it has to be a
recorded fact rather than something each reader measures for itself.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.field_mapping_contract import (
    SOURCE_PERIOD_MONTHS_FIELD,
    period_months_from_date_value,
)
from app_server import config
from app_server.services import arcrho_runtime_service, field_mapping_service

PROJECT_NAME = "GranularityProject"
ORIGIN_COLUMN = "acc_yrmo"
DEVELOPMENT_COLUMN = "val_yrmo"


class SourcePeriodMonthsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.projects_dir = Path(self.temp_dir.name)
        self.project_dir = self.projects_dir / PROJECT_NAME
        (self.project_dir / "source").mkdir(parents=True)
        self.master_path = self.project_dir / "source" / "master_table.csv"
        self.mapping_path = self.project_dir / "field_mapping.json"
        self.patcher = patch.object(
            config, "PROJECT_SETTINGS_DIR", str(self.projects_dir)
        )
        self.patcher.start()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.temp_dir.cleanup()

    def _write_table(self, origin: str, development: str) -> None:
        self.master_path.write_text(
            f"{ORIGIN_COLUMN},{DEVELOPMENT_COLUMN}\n{origin},{development}\n",
            encoding="utf-8",
        )

    def _write_mapping(self, **extra) -> None:
        payload = {
            "project_name": PROJECT_NAME,
            "table_path": "",
            "rows": [
                {"field_name": ORIGIN_COLUMN, "significance": "Origin Date"},
                {"field_name": DEVELOPMENT_COLUMN, "significance": "Development Date"},
            ],
        }
        payload.update(extra)
        self.mapping_path.write_text(json.dumps(payload), encoding="utf-8")

    def test_period_months_reads_a_year_and_a_month_apart(self) -> None:
        self.assertEqual(period_months_from_date_value(2024), 12)
        self.assertEqual(period_months_from_date_value("2024"), 12)
        self.assertEqual(period_months_from_date_value(202401), 1)
        self.assertEqual(period_months_from_date_value("not a date"), 0)

    def test_detects_each_date_role_from_the_imported_table(self) -> None:
        self._write_table("202401", "2024")
        self._write_mapping()
        self.assertEqual(
            field_mapping_service.detect_source_period_months(PROJECT_NAME),
            {"Origin Date": 1, "Development Date": 12},
        )

    def test_recorded_value_is_returned_without_reading_the_table(self) -> None:
        self._write_table("202401", "202403")
        self._write_mapping(**{SOURCE_PERIOD_MONTHS_FIELD: {"Origin Date": 12}})
        with patch.object(
            field_mapping_service, "detect_source_period_months"
        ) as detect:
            months = field_mapping_service.load_source_period_months(PROJECT_NAME)
        detect.assert_not_called()
        self.assertEqual(months, {"Origin Date": 12})

    def test_a_mapping_without_the_field_is_backfilled_once(self) -> None:
        self._write_table("202401", "202403")
        self._write_mapping()

        self.assertEqual(
            field_mapping_service.load_source_period_months(PROJECT_NAME),
            {"Origin Date": 1, "Development Date": 1},
        )
        stored = json.loads(self.mapping_path.read_text(encoding="utf-8"))
        self.assertEqual(
            stored[SOURCE_PERIOD_MONTHS_FIELD],
            {"Origin Date": 1, "Development Date": 1},
        )
        # The rows the mapping already held survive the write.
        self.assertEqual(len(stored["rows"]), 2)

        with patch.object(
            field_mapping_service, "detect_source_period_months"
        ) as detect:
            field_mapping_service.load_source_period_months(PROJECT_NAME)
        detect.assert_not_called()

    def test_an_unmeasurable_role_is_left_out(self) -> None:
        self.master_path.write_text(
            f"{ORIGIN_COLUMN},{DEVELOPMENT_COLUMN}\n202401,\n", encoding="utf-8"
        )
        self._write_mapping()
        self.assertEqual(
            field_mapping_service.load_source_period_months(PROJECT_NAME),
            {"Origin Date": 1},
        )


class GeneratedSidecarStoredShapeTests(unittest.TestCase):
    """A generated dataset's stored shape is its source table's granularity."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.root = Path(self.temp_dir.name)
        self.data_path = self.root / "datasets" / "Paid@12@12@cum@dev.csv"
        self.sidecar_path = self.root / "sidecars" / "Paid.json"
        self.data_path.parent.mkdir(parents=True)
        self.sidecar_path.parent.mkdir(parents=True)
        self.data_path.write_text("1\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_sidecar(self, months) -> dict:
        pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Paid Type"),
            ("InstanceName", "Paid"),
            ("ProjectName", PROJECT_NAME),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]
        with (
            patch.object(
                arcrho_runtime_service,
                "_dataset_sidecar_path",
                return_value=str(self.sidecar_path),
            ),
            patch.object(arcrho_runtime_service, "_set_processing_provenance"),
            patch.object(
                arcrho_runtime_service, "get_processing_provenance", return_value={}
            ),
            patch(
                "app_server.services.calculated_dataset_service."
                "apply_sidecar_graph_fields"
            ),
            patch.object(
                arcrho_runtime_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
            ),
            patch.object(
                field_mapping_service, "load_source_period_months", return_value=months
            ),
        ):
            arcrho_runtime_service._write_dataset_sidecar(str(self.data_path), pairs)
        return json.loads(self.sidecar_path.read_text(encoding="utf-8"))

    def test_a_monthly_source_gives_stored_one_at_an_annual_request(self) -> None:
        payload = self._write_sidecar({"Origin Date": 1, "Development Date": 1})
        self.assertEqual(payload["origin_length"], 12)
        self.assertEqual(payload["development_length"], 12)
        self.assertEqual(payload["stored_origin_length"], 1)
        self.assertEqual(payload["stored_development_length"], 1)

        # Regenerating the same dataset keeps the source's granularity.
        payload = self._write_sidecar({"Origin Date": 1, "Development Date": 1})
        self.assertEqual(payload["stored_origin_length"], 1)
        self.assertEqual(payload["stored_development_length"], 1)

    def test_axes_take_their_own_role(self) -> None:
        payload = self._write_sidecar({"Origin Date": 12, "Development Date": 1})
        self.assertEqual(payload["stored_origin_length"], 12)
        self.assertEqual(payload["stored_development_length"], 1)

    def test_a_project_recording_nothing_keeps_the_requested_shape(self) -> None:
        payload = self._write_sidecar({})
        self.assertEqual(payload["stored_origin_length"], 12)
        self.assertEqual(payload["stored_development_length"], 12)

    def test_a_dataset_the_engine_does_not_rebuild_keeps_its_own_shape(self) -> None:
        self._write_sidecar({"Origin Date": 1, "Development Date": 1})
        existing = json.loads(self.sidecar_path.read_text(encoding="utf-8"))
        existing["source_kind"] = "calculated"
        self.sidecar_path.write_text(json.dumps(existing), encoding="utf-8")

        payload = self._write_sidecar({"Origin Date": 1, "Development Date": 1})
        self.assertEqual(payload["stored_origin_length"], 12)
        self.assertEqual(payload["stored_development_length"], 12)


if __name__ == "__main__":
    unittest.main()
