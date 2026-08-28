"""ResQ origin-period resolution when reading triangles.

ResQ answers ``DevelopmentCount`` for the origin period containing the date it is
given, so a sub-annual origin label must resolve inside its own period.  These
tests pin the quarterly staircase, the empty row for an origin period beyond the
valuation date, and unchanged annual behaviour.
"""
from __future__ import annotations

import calendar
import sys
import unittest
from datetime import datetime
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))

from resq_migration import extractors  # noqa: E402
from resq_migration.dfm import _excluded_ratio_flag  # noqa: E402


# The reserving class this regression came from is valued at 31 May 2026, which
# is why its quarterly development grid starts at 2m rather than 3m.
_VALUATION = datetime(2026, 5, 31)

_QUARTERLY_ORIGINS = (
    "2025 Q1",
    "2025 Q2",
    "2025 Q3",
    "2025 Q4",
    "2026 Q1",
    "2026 Q2",
    "2026 Q3",
    "2026 Q4",
)
# One development period fewer per quarter, then nothing for origin periods that
# have not started by the valuation date.
_EXPECTED_QUARTERLY_COUNTS = [6, 5, 4, 3, 2, 1, 0, 0]

_ANNUAL_ORIGINS = ("2023", "2024", "2025", "2026")
_EXPECTED_ANNUAL_COUNTS = [4, 3, 2, 1]


def _period_start(year: int, month: int, length_months: int, date: datetime) -> tuple[int, int]:
    """Return the (year, month) start of the ``length_months`` period holding ``date``."""
    index = (date.month - 1) // length_months
    del year, month
    return date.year, index * length_months + 1


def _elapsed_months(start_year: int, start_month: int) -> int:
    return (_VALUATION.year - start_year) * 12 + (_VALUATION.month - start_month) + 1


def _development_count(start_year: int, start_month: int, first_dev: int, step: int) -> int:
    elapsed = _elapsed_months(start_year, start_month)
    if elapsed < first_dev:
        return 0
    return (elapsed - first_dev) // step + 1


class _Named:
    def __init__(self, name: str):
        self.Name = name


class _DatasetType:
    Name = "Claim Counts--CWP"
    DataFormat = 0

    def __init__(self):
        self.Category = _Named("Claim Count")


class _ResqTriangle:
    """A triangle whose ``DevelopmentCount`` only accepts an ``OriginDate``.

    Real ResQ types that parameter as a date, so an origin index is not a usable
    substitute.  Rejecting every other call shape keeps this fake honest.
    """

    User = "tester"
    Created = "2026-07-01T10:00:00"
    Modified = "2026-07-24T10:00:00"
    Status = 0

    def __init__(
        self,
        origins: tuple[str, ...],
        *,
        period_months: int,
        first_dev: int,
        expose_origin_date: bool,
    ):
        self.Name = "Claim Counts--CWP"
        self.DatasetType = _DatasetType()
        self.OriginCount = len(origins)
        self.OriginLength = period_months
        self.DevelopmentLength = period_months
        self.Notes = "Counts capped at 2026Q1.\r\nReviewed."
        self._origins = origins
        self._period_months = period_months
        self._first_dev = first_dev
        if expose_origin_date:
            self.GetOriginDate = self._get_origin_date

    def _start_of(self, origin_index: int) -> tuple[int, int]:
        label = self._origins[origin_index - 1]
        year = int(label[:4])
        if self._period_months == 12:
            return year, 1
        quarter = int(label[-1])
        return year, (quarter - 1) * self._period_months + 1

    def _get_origin_date(self, origin_index: int) -> datetime:
        year, month = self._start_of(origin_index)
        return datetime(year, month, 1)

    def OriginLabel(self, origin_index: int) -> str:
        return self._origins[origin_index - 1]

    def DevelopmentLabel(self, dev_index: int) -> str:
        return f"{self._first_dev + self._period_months * (dev_index - 1)}m"

    def DevelopmentCount(self, OriginDate=None):  # noqa: N803 - ResQ's parameter name
        if not isinstance(OriginDate, datetime):
            raise TypeError("DevelopmentCount requires an OriginDate.")
        year, month = _period_start(0, 0, self._period_months, OriginDate)
        return _development_count(year, month, self._first_dev, self._period_months)

    def ValuesByIndex(self, origin_index: int, dev_index: int) -> float:
        year, month = self._start_of(origin_index)
        populated = _development_count(year, month, self._first_dev, self._period_months)
        if dev_index > populated:
            # ResQ pads past the latest diagonal with zero rather than refusing.
            return 0.0
        return 1000.0 * origin_index + dev_index


def _quarterly_triangle(*, expose_origin_date: bool) -> _ResqTriangle:
    return _ResqTriangle(
        _QUARTERLY_ORIGINS,
        period_months=3,
        first_dev=2,
        expose_origin_date=expose_origin_date,
    )


def _populated_counts(payload: dict) -> list[int]:
    return [sum(1 for value in row if value is not None) for row in payload["values"]]


class OriginDateFromLabelTests(unittest.TestCase):
    def test_annual_label_still_resolves_to_year_end(self) -> None:
        self.assertEqual(extractors._origin_date_from_label("2024"), datetime(2024, 12, 31))

    def test_each_quarter_resolves_inside_its_own_period(self) -> None:
        self.assertEqual(extractors._origin_date_from_label("2025 Q1"), datetime(2025, 3, 31))
        self.assertEqual(extractors._origin_date_from_label("2025 Q2"), datetime(2025, 6, 30))
        self.assertEqual(extractors._origin_date_from_label("2025 Q3"), datetime(2025, 9, 30))
        self.assertEqual(extractors._origin_date_from_label("2025 Q4"), datetime(2025, 12, 31))

    def test_half_year_and_month_labels_resolve_inside_their_period(self) -> None:
        self.assertEqual(extractors._origin_date_from_label("2025 H1"), datetime(2025, 6, 30))
        self.assertEqual(extractors._origin_date_from_label("Feb 2024"), datetime(2024, 2, 29))
        self.assertEqual(extractors._origin_date_from_label("2025 M3"), datetime(2025, 3, 31))

    def test_bare_index_labels_are_not_treated_as_years(self) -> None:
        # ResQ falls back to "1", "2", ... when a vector exposes no origin label.
        self.assertIsNone(extractors._origin_date_from_label("1"))
        self.assertIsNone(extractors._origin_date_from_label("12"))


class QuarterlyTriangleTruncationTests(unittest.TestCase):
    def test_each_quarter_keeps_its_own_diagonal(self) -> None:
        for expose_origin_date in (True, False):
            with self.subTest(expose_origin_date=expose_origin_date):
                payload = extractors.export_triangle(
                    _quarterly_triangle(expose_origin_date=expose_origin_date)
                )
                self.assertEqual(_populated_counts(payload), _EXPECTED_QUARTERLY_COUNTS)

    def test_origin_period_beyond_the_valuation_date_stays_empty(self) -> None:
        payload = extractors.export_triangle(_quarterly_triangle(expose_origin_date=True))
        for label in ("2026 Q3", "2026 Q4"):
            row = payload["values"][payload["origin_labels"].index(label)]
            # Not zero padding: ResQ's 0.0 past the diagonal must never persist.
            self.assertTrue(all(value is None for value in row), row)

    def test_column_count_follows_the_oldest_quarter(self) -> None:
        payload = extractors.export_triangle(_quarterly_triangle(expose_origin_date=True))
        self.assertEqual(payload["development_count"], max(_EXPECTED_QUARTERLY_COUNTS))
        self.assertEqual(payload["development_labels"][-1], "17m")

    def test_resq_notes_ride_along_with_the_triangle(self) -> None:
        payload = extractors.export_triangle(_quarterly_triangle(expose_origin_date=True))
        self.assertEqual(payload["notes"], "Counts capped at 2026Q1.\r\nReviewed.")

    def test_latest_diagonal_values_survive(self) -> None:
        payload = extractors.export_triangle(_quarterly_triangle(expose_origin_date=True))
        for row_index, expected_count in enumerate(_EXPECTED_QUARTERLY_COUNTS):
            if not expected_count:
                continue
            row = payload["values"][row_index]
            self.assertEqual(row[expected_count - 1], 1000.0 * (row_index + 1) + expected_count)


class AnnualTriangleParityTests(unittest.TestCase):
    def test_annual_staircase_is_unchanged(self) -> None:
        for expose_origin_date in (True, False):
            with self.subTest(expose_origin_date=expose_origin_date):
                payload = extractors.export_triangle(
                    _ResqTriangle(
                        _ANNUAL_ORIGINS,
                        period_months=12,
                        first_dev=5,
                        expose_origin_date=expose_origin_date,
                    )
                )
                self.assertEqual(_populated_counts(payload), _EXPECTED_ANNUAL_COUNTS)


class ExcludedRatioFlagTests(unittest.TestCase):
    def test_only_an_explicit_exclusion_imports_as_excluded(self) -> None:
        self.assertEqual(_excluded_ratio_flag(0), 0)
        self.assertEqual(_excluded_ratio_flag(1), 1)
        # 2 means "empty cell" in ResQ, which carries no actuarial judgement.
        self.assertEqual(_excluded_ratio_flag(2), 0)


if __name__ == "__main__":
    unittest.main()
