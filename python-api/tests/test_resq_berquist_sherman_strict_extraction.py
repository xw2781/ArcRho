from __future__ import annotations

import sys
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))

from resq_migration import extractors  # noqa: E402


class _Named:
    def __init__(self, name: str):
        self.Name = name


class _OutputTriangle:
    Status = 2


class _SettlementRateMethod:
    Name = "Paid Loss - B&S Settlement Rate Adjustment"
    OriginLength = 12
    DevelopmentLength = 12
    Notes = "B&S note"

    def __init__(self, *, fail_source: bool = False, fail_loess_span: bool = False):
        self._fail_source = fail_source
        self._fail_loess_span = fail_loess_span
        self.OutputTriangle = _OutputTriangle()
        self.ClosedClaimNos = _Named("Closed Claim Counts")
        self.UltimateClaimNos = _Named("Selected Ultimate Claim Counts")

    @property
    def PaidClaims(self):
        if self._fail_source:
            raise RuntimeError("simulated PaidClaims COM read failure")
        return _Named("Paid Loss")

    @property
    def LoessSpan(self):
        if self._fail_loess_span:
            raise RuntimeError("simulated LoessSpan COM read failure")
        return 5

    def SelectedProportionSettled(self, dev_index: int):
        return [0.5, 1.0][dev_index - 1]

    def IsDefaultProportionSettled(self, dev_index: int):
        return dev_index == 1

    def SelectedAdjustment(self, origin_index: int, dev_index: int):
        del origin_index, dev_index
        return 1


def _output_payload() -> dict:
    return {
        "name": "Paid Loss - B&S Settlement Rate Adjustment",
        "dataset_type": "Adjusted Paid Loss",
        "origin_length": 12,
        "development_length": 12,
        "origin_labels": ["2024", "2025"],
        "development_labels": ["12", "24"],
        "modified": "2026-08-12T10:00:00-04:00",
    }


class ResqBerquistShermanStrictExtractionTests(unittest.TestCase):
    def test_failed_source_read_is_tolerated_by_default_but_strict_raises(self):
        method = _SettlementRateMethod(fail_source=True)

        tolerant = extractors.export_berquist_sherman(method, "sr", _output_payload())
        self.assertEqual(tolerant["method_tab"]["paid_claims"], "")

        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            r"Berquist Sherman method\.PaidClaims",
        ):
            extractors.export_berquist_sherman(
                method,
                "sr",
                _output_payload(),
                strict=True,
            )

        # A strict failure must not leak into the established bulk-import mode.
        self.assertEqual(
            extractors.export_berquist_sherman(method, "sr", _output_payload())["method_tab"][
                "paid_claims"
            ],
            "",
        )

    def test_failed_loess_span_read_does_not_become_default_in_strict_mode(self):
        method = _SettlementRateMethod(fail_loess_span=True)

        tolerant = extractors.export_berquist_sherman(method, "sr", _output_payload())
        self.assertEqual(tolerant["method_tab"]["loess_span"], extractors.BS_DEFAULT_LOESS_SPAN)

        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            r"Berquist Sherman method\.LoessSpan",
        ):
            extractors.export_berquist_sherman(
                method,
                "sr",
                _output_payload(),
                strict=True,
            )


if __name__ == "__main__":
    unittest.main()
