from __future__ import annotations

import sys
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))

from resq_migration import extractors  # noqa: E402


class _Category:
    Name = "Loss"


class _DatasetType:
    Name = "Ultimate Loss"
    DataFormat = 1
    Category = _Category()


class _Vector:
    MethodType = 0
    PeriodLength = 12
    User = "migration-user"
    Created = "2025-01-01T00:00:00Z"
    Modified = "2026-01-02T00:00:00Z"
    Formula = ""
    Status = 0

    def __init__(
        self,
        name: str,
        values: list[float],
        *,
        fail_origin: int | None = None,
        output: bool = False,
    ):
        self.Name = name
        self._values = values
        self._fail_origin = fail_origin
        self.OriginCount = len(values)
        self.DatasetType = _DatasetType()
        if output:
            self.MethodType = 2
            self.Status = 2

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)

    def ValuesByIndex(self, origin_index: int):
        if origin_index == self._fail_origin:
            raise RuntimeError("simulated vector cell failure")
        return self._values[origin_index - 1]


class _Triangle:
    Name = "Paid Loss"
    MethodType = 0
    OriginLength = 12
    DevelopmentLength = 12
    User = "migration-user"
    Created = "2025-01-01T00:00:00Z"
    Modified = "2026-01-02T00:00:00Z"
    Status = 0

    def __init__(self, *, fail_cell: tuple[int, int] | None = None):
        self.DatasetType = _DatasetType()
        self.DatasetType.DataFormat = 0
        self.OriginCount = 2
        self._fail_cell = fail_cell

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)

    def DevelopmentLabel(self, development_index: int):
        return f"{development_index * 12}m"

    def DevelopmentCount(self, *args, **kwargs):
        del args, kwargs
        return 1

    def ValuesByIndex(self, origin_index: int, development_index: int):
        if (origin_index, development_index) == self._fail_cell:
            raise RuntimeError("simulated triangle cell failure")
        return origin_index * 100 + development_index


class _ResultSelection:
    OriginLength = 12
    OriginCount = 2
    DatasetCount = 1
    Notes = "RS note"

    def __init__(self, *, fail_weight_origin: int | None = None):
        self.OutputVector = _Vector("Selected Ultimate", [100, 200], output=True)
        self._source = _Vector("Paid Loss", [10, 20])
        self._ratio_basis = _Vector("Earned Premium", [1000, 2000])
        self._fail_weight_origin = fail_weight_origin

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)

    def Dataset(self, dataset_index: int):
        assert dataset_index == 1
        return self._source

    def DatasetValues(self, dataset_index: int, origin_index: int, origin_length: int):
        del dataset_index, origin_length
        return origin_index * 10

    def Weights(self, dataset_index: int, origin_index: int):
        del dataset_index
        if origin_index == self._fail_weight_origin:
            raise RuntimeError("simulated Result Selection weight failure")
        return 1

    def RatioBasisDataset(self, dataset_index: int):
        assert dataset_index == 1
        return self._ratio_basis

    def RatioBasisValues(self, origin_index: int, origin_length: int):
        del origin_length
        return origin_index * 1000

    def UltimateOverridden(self, origin_index: int):
        del origin_index
        return False


class _LatestTriangle:
    Name = "Paid Loss"

    def __init__(self):
        self._values = [100, 200]

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)

    def DevelopmentCount(self, *args, **kwargs):
        del args, kwargs
        return 1

    def ValuesByIndex(self, origin_index: int, development_index: int):
        assert development_index == 1
        return self._values[origin_index - 1]


class _BornhuetterFerguson:
    OriginLength = 12
    OriginCount = 2
    Notes = "BF note"

    def __init__(self, *, fail_dfm_origin: int | None = None):
        self.OutputVector = _Vector("BF Ultimate", [150, 300], output=True)
        self.Latest = _LatestTriangle()
        self.PercentageDeveloped = _Vector(
            "DFM Ultimate",
            [200, 400],
            fail_origin=fail_dfm_origin,
        )
        self.Prior = _Vector("Plan Ultimate", [300, 600])

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)


class _CapeCod:
    OriginLength = 12
    OriginCount = 2
    Notes = "CC note"
    PercentageDevelopedType = 0
    ScalingType = 0
    DecimalPlaces = 2
    AutoTrendFit = False
    DecayFactor = 1
    AltUltimateCalc = False

    def __init__(self, *, fail_trend_rate: bool = False):
        self.OutputVector = _Vector("CC Ultimate", [150, 300], output=True)
        self.Latest = _LatestTriangle()
        self.Exposure = _Vector("Earned Premium", [1000, 1200])
        self.PercentageDeveloped = _Vector("Prior Ultimate", [200, 400])
        self._fail_trend_rate = fail_trend_rate

    @property
    def TrendRate(self):
        if self._fail_trend_rate:
            raise RuntimeError("simulated Cape Cod property failure")
        return 0.05

    def OriginLabel(self, origin_index: int):
        return str(2019 + origin_index)

    def ManualTrendFactor(self, origin_index: int):
        del origin_index
        return False


class StrictResQExtractionTests(unittest.TestCase):
    def test_complete_objects_are_supported_by_every_strict_public_extractor(self):
        payloads = (
            extractors.export_triangle(_Triangle(), strict=True),
            extractors.export_vector(_Vector("Paid Ultimate", [100, 200]), strict=True),
            extractors.export_result_selection(_ResultSelection(), strict=True),
            extractors.export_bornhuetter_ferguson(_BornhuetterFerguson(), strict=True),
            extractors.export_cape_cod(_CapeCod(), strict=True),
        )

        self.assertTrue(all(isinstance(payload, dict) for payload in payloads))

    def test_triangle_partial_cell_failure_is_tolerated_by_default_but_strict_raises(self):
        triangle = _Triangle(fail_cell=(2, 1))

        payload = extractors.export_triangle(triangle)
        self.assertEqual(payload["values"], [[101], [None]])
        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            r"triangle 'Paid Loss' value at cell \(2, 1\)",
        ):
            extractors.export_triangle(triangle, strict=True)

        # A failed strict read must not leak strict mode into later bulk reads.
        self.assertEqual(extractors.export_triangle(triangle)["values"], [[101], [None]])

    def test_vector_partial_cell_failure_is_tolerated_by_default_but_strict_raises(self):
        vector = _Vector("Paid Ultimate", [100, 200], fail_origin=2)

        self.assertEqual(extractors.export_vector(vector)["values"], [[100], [None]])
        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            r"vector 'Paid Ultimate' value at origin index 2",
        ):
            extractors.export_vector(vector, strict=True)

    def test_result_selection_failed_weight_does_not_become_zero_in_strict_mode(self):
        method = _ResultSelection(fail_weight_origin=2)

        tolerant = extractors.export_result_selection(method)
        self.assertEqual(tolerant["method_tab"]["loaded_datasets"][0]["weights"], [1, 0])
        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            "Result Selection source 1 weight for origin index 2",
        ):
            extractors.export_result_selection(method, strict=True)

    def test_bf_failed_source_cell_does_not_become_none_in_strict_mode(self):
        method = _BornhuetterFerguson(fail_dfm_origin=2)

        tolerant = extractors.export_bornhuetter_ferguson(method)
        self.assertIsNone(tolerant["method_tab"]["dfm_ultimate_values"][1])
        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            "BF source 'DFM Ultimate' for origin index 2",
        ):
            extractors.export_bornhuetter_ferguson(method, strict=True)

    def test_cape_cod_failed_property_does_not_become_default_in_strict_mode(self):
        method = _CapeCod(fail_trend_rate=True)

        tolerant = extractors.export_cape_cod(method)
        self.assertEqual(tolerant["method_tab"]["trend_rate"], 0)
        with self.assertRaisesRegex(
            extractors.StrictResQExtractionError,
            r"Cape Cod 'CC Ultimate'\.TrendRate",
        ):
            extractors.export_cape_cod(method, strict=True)


if __name__ == "__main__":
    unittest.main()
