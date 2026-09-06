"""The Engine prefers the project's recorded source granularity.

`field_mapping.json` records how fine a project's origin and development dates
are, and a generated dataset's stored shape is written from that record. The
Engine must therefore agree with it rather than re-deciding from whichever
source table happens to be on disk — and when the two disagree, say so in the
request log instead of quietly following one of them.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
ENGINE_SOURCE = REPOSITORY_ROOT / "server-components" / "src"
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
for path in (ENGINE_SOURCE, API_SOURCE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import pandas as pd

from arcrho_api import field_mapping_contract
from arcrho_engine import data_processing
from arcrho_engine.runtime_log import ENGINE_REQUEST_LOG_FILENAME

PROJECT_NAME = "GranularityProject"
ORIGIN_COLUMN = "acc_yrmo"


class MirrorParityTests(unittest.TestCase):
    """The Engine's copy of the granularity rule against its canonical owner."""

    def test_names_match_the_canonical_contract(self) -> None:
        self.assertEqual(
            data_processing.SOURCE_PERIOD_MONTHS_FIELD,
            field_mapping_contract.SOURCE_PERIOD_MONTHS_FIELD,
        )
        self.assertEqual(
            data_processing.DATE_ROLE_ORIGIN,
            field_mapping_contract.DATE_ROLE_ORIGIN,
        )
        self.assertEqual(
            data_processing.ANNUAL_PERIOD_MONTHS,
            field_mapping_contract.ANNUAL_PERIOD_MONTHS,
        )
        self.assertEqual(
            data_processing.MONTHLY_PERIOD_MONTHS,
            field_mapping_contract.MONTHLY_PERIOD_MONTHS,
        )

    def test_the_rule_reads_every_value_the_same_way(self) -> None:
        for value in (2024, "2024", 202401, "202412", 0, "", None, "not a date"):
            with self.subTest(value=value):
                self.assertEqual(
                    data_processing._period_months_from_date_value(value),
                    field_mapping_contract.period_months_from_date_value(value),
                )


class ResolveDateGranularityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.server_root = Path(self.temp_dir.name)
        self.project_dir = self.server_root / "projects" / PROJECT_NAME
        self.project_dir.mkdir(parents=True)
        self.mapping_path = self.project_dir / "field_mapping.json"
        self.log_path = (
            self.server_root / "runtime" / "logs" / ENGINE_REQUEST_LOG_FILENAME
        )
        self.patcher = patch.object(
            data_processing, "get_project_root", lambda: self.server_root
        )
        self.patcher.start()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.temp_dir.cleanup()

    def _write_mapping(self, months: dict | None) -> None:
        payload: dict = {"project_name": PROJECT_NAME, "rows": []}
        if months is not None:
            payload[field_mapping_contract.SOURCE_PERIOD_MONTHS_FIELD] = months
        self.mapping_path.write_text(json.dumps(payload), encoding="utf-8")

    @staticmethod
    def _frame(value: str) -> pd.DataFrame:
        return pd.DataFrame({ORIGIN_COLUMN: [value]})

    def _log_text(self) -> str:
        return self.log_path.read_text(encoding="utf-8") if self.log_path.exists() else ""

    def test_recorded_annual_wins_over_a_monthly_looking_column(self) -> None:
        self._write_mapping({"Origin Date": 12})
        granularity = data_processing._resolve_date_granularity(
            PROJECT_NAME, self._frame("202401"), [ORIGIN_COLUMN, ""]
        )
        self.assertEqual(granularity, "annual")
        self.assertIn("records 12-month origin periods", self._log_text())
        self.assertIn("reads as 1-month", self._log_text())

    def test_agreement_writes_no_log_line(self) -> None:
        self._write_mapping({"Origin Date": 1})
        granularity = data_processing._resolve_date_granularity(
            PROJECT_NAME, self._frame("202401"), [ORIGIN_COLUMN, ""]
        )
        self.assertEqual(granularity, "monthly")
        self.assertEqual(self._log_text(), "")

    def test_an_unrecorded_project_falls_back_to_its_own_reading(self) -> None:
        self._write_mapping(None)
        self.assertEqual(
            data_processing._resolve_date_granularity(
                PROJECT_NAME, self._frame("2024"), [ORIGIN_COLUMN, ""]
            ),
            "annual",
        )
        self.assertEqual(self._log_text(), "")

    def test_no_mapping_and_no_frame_reads_as_monthly(self) -> None:
        self.assertEqual(
            data_processing._resolve_date_granularity(PROJECT_NAME, None, None),
            "monthly",
        )

    def test_the_record_is_used_when_no_frame_is_supplied(self) -> None:
        self._write_mapping({"Origin Date": 12})
        self.assertEqual(
            data_processing._resolve_date_granularity(PROJECT_NAME, None, None),
            "annual",
        )
        self.assertEqual(self._log_text(), "")


if __name__ == "__main__":
    unittest.main()
