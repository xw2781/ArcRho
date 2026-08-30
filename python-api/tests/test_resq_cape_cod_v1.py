from __future__ import annotations

import json
import tempfile
import sys
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))

from arcrho_api.cape_cod_contract import (  # noqa: E402
    CC_JSON_FORMAT,
    CC_METHOD_TYPE,
    CC_METHOD_TYPE_CODE,
    CC_SOURCE_KIND,
    build_cape_cod_output_sidecar,
    normalize_cape_cod_method,
    recalculate_cape_cod_method,
)
from resq_migration import extractors  # noqa: E402
from resq_migration.number_formats import configure_number_formats_path  # noqa: E402


FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "resq_cape_cod_d53.json").read_text(
        encoding="utf-8"
    )
)
# Raw ResQ COM values are full float precision; persisted numbers pass through
# the ArcRho-wide canonicalization, so raw-fixture parity is bounded by that
# rounding cascade exactly as in test_cape_cod_contract.py.
CANONICAL_TOL = 2e-6
MODIFIED = "2026-01-02T00:00:00Z"


class _DatasetType:
    Name = "Ultimate Loss"
    DataFormat = 1
    Category = type("Category", (), {"Name": "Loss"})()


class _Vector:
    def __init__(self, name: str, values: list, labels: list[str], *, output: bool = False):
        self.Name = name
        self._values = values
        self._labels = labels
        self.OriginCount = len(values)
        self.PeriodLength = 12
        self.DatasetType = _DatasetType()
        self.Modified = MODIFIED
        self.Created = "2025-01-01T00:00:00Z"
        self.User = "migration-user"
        self.MethodType = 3 if output else 0
        self.Status = 2 if output else 0
        self.Formula = ""

    def OriginLabel(self, index: int):
        return self._labels[index - 1]

    def ValuesByIndex(self, index: int):
        return self._values[index - 1]


class _Triangle:
    def __init__(self, name: str, rows: list[list], labels: list[str]):
        self.Name = name
        self._rows = rows
        self._labels = labels

    def OriginLabel(self, index: int):
        return self._labels[index - 1]

    def DevelopmentCount(self, *args, **kwargs):
        if args:
            index = int(args[0])
        elif "OriginIndex" in kwargs:
            index = int(kwargs["OriginIndex"])
        elif "OriginDate" in kwargs:
            index = self._labels.index(str(kwargs["OriginDate"].year)) + 1
        else:
            raise TypeError("an origin index or date is required")
        return len(self._rows[index - 1])

    def ValuesByIndex(self, origin_index: int, dev_index: int):
        return self._rows[origin_index - 1][dev_index - 1]


class _CcMethod:
    """Fake ResQ xCapeCodMethod carrying the live D 53 COM capture."""

    OriginLength = 12
    Notes = "Migrated Cape Cod note"
    TrendRate = FIXTURE["method"]["trend_rate"]
    AutoTrendFit = True
    DecayFactor = FIXTURE["method"]["decay_factor"]
    AltUltimateCalc = False
    ScalingType = 0
    DecimalPlaces = FIXTURE["method"]["decimal_places"]
    PercentageDevelopedType = 0

    def __init__(self):
        labels = list(FIXTURE["origin_labels"])
        self._labels = labels
        self.OriginCount = len(labels)
        self.Latest = _Triangle(
            FIXTURE["method"]["latest_dataset"], FIXTURE["latest_triangle"], labels
        )
        self.Exposure = _Vector(
            FIXTURE["method"]["exposure_dataset"], FIXTURE["exposure_values"], labels
        )
        self.PercentageDeveloped = _Vector(
            FIXTURE["method"]["prior_ultimate_dataset"],
            FIXTURE["prior_ultimate_values"],
            labels,
        )
        self.OutputVector = _Vector(
            FIXTURE["method"]["name"],
            FIXTURE["expected"]["cape_cod_ultimate"],
            labels,
            output=True,
        )

    def OriginLabel(self, *args, **kwargs):
        index = kwargs.get("OriginIndex") if kwargs else args[0]
        return self._labels[index - 1]

    def ManualTrendFactor(self, _index: int):
        return False

    def TrendFactorValues(self, _index: int):
        raise AssertionError("TrendFactorValues must only be read for flagged origins.")


class _ManualCcMethod:
    """Small manual-trend variant: one flagged trend-factor override."""

    OriginLength = 12
    OriginCount = 3
    Notes = ""
    TrendRate = 0.05
    AutoTrendFit = False
    DecayFactor = 1.0
    AltUltimateCalc = False
    ScalingType = 1
    DecimalPlaces = 3
    PercentageDevelopedType = 0

    def __init__(self):
        labels = ["2020", "2021", "2022"]
        self._labels = labels
        self.Latest = _Triangle("Paid Loss", [[50, 80, 100], [60, 90], [70]], labels)
        self.Exposure = _Vector("Earned Premium", [200, 220, 240], labels)
        self.PercentageDeveloped = _Vector("Prior Ultimate", [100, 120, 140], labels)
        self.OutputVector = _Vector("CC Ultimate", [0, 0, 0], labels, output=True)

    def OriginLabel(self, *args, **kwargs):
        index = kwargs.get("OriginIndex") if kwargs else args[0]
        return self._labels[index - 1]

    def ManualTrendFactor(self, index: int):
        return index == 2

    def TrendFactorValues(self, index: int):
        assert index == 2
        return 1.25


class _EmptyDfmCcMethod(_ManualCcMethod):
    """DFM-factor variant whose referenced DFM vector holds no stored values.

    ResQ still reports percentage developed from the DFM's cumulative dev
    factors, so the effective prior ultimate is latest / PercentageDevelopedValues.
    """

    PercentageDevelopedType = 3

    def __init__(self):
        super().__init__()
        self.PercentageDeveloped = _Vector("Prior Ultimate", [0, 0, 0], self._labels)

    def PercentageDevelopedValues(self, index: int):
        return [1.0, 0.75, 0.5][index - 1]


def _expected_canonical_payload() -> dict:
    """The canonical payload the app-server save path would produce for D 53."""

    labels = list(FIXTURE["origin_labels"])
    method = FIXTURE["method"]
    owned = {
        "json_format": CC_JSON_FORMAT,
        "details_tab": {
            "name": method["name"],
            "method_type": CC_METHOD_TYPE,
            "output_type": "Ultimate Loss",
            "dataset_category": "Loss",
            "origin_length": method["origin_length"],
            "statistic_decimal_places": method["decimal_places"],
        },
        "method_tab": {
            "latest_dataset": method["latest_dataset"],
            "exposure_dataset": method["exposure_dataset"],
            "prior_ultimate_dataset": method["prior_ultimate_dataset"],
            "prior_ultimate_mode": "latest_ultimates",
            "trend_rate": method["trend_rate"],
            "auto_trend_fit": True,
            "decay_factor": method["decay_factor"],
            "scaling_type": "percentage",
            "alternative_ultimate_calculation": False,
            "trend_factor_overrides": [None] * len(labels),
            "origin_labels": labels,
        },
        "ultimates_tab": {},
        "ratios_tab": {},
        "audit_log_tab": {},
        "method_metadata": {
            "method_type": CC_METHOD_TYPE,
            "source_kind": CC_SOURCE_KIND,
            "last_modified": MODIFIED,
            "data_refreshed": MODIFIED,
        },
    }
    return recalculate_cape_cod_method(
        owned,
        source_snapshots={
            "latest": {
                "name": method["latest_dataset"],
                "origin_labels": labels,
                "values": FIXTURE["latest_triangle"],
            },
            "exposure": {
                "name": method["exposure_dataset"],
                "origin_labels": labels,
                "values": FIXTURE["exposure_values"],
            },
            "prior_ultimate": {
                "name": method["prior_ultimate_dataset"],
                "origin_labels": labels,
                "values": FIXTURE["prior_ultimate_values"],
            },
        },
        timestamp=MODIFIED,
    )


class ResqCapeCodV1Tests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        tmp_root = Path(__file__).resolve().parent / "logs" / "tmp"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.rc_dir = self.root / "data" / "Auto_%5C_PP"
        self.rc_dir.mkdir(parents=True)
        configure_number_formats_path(self.root)
        extractors.configure_extractors(
            project_name="Demo",
            rs_json_format="arcrho-result-selection-v4",
            cc_json_format=CC_JSON_FORMAT,
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_resq_export_is_complete_exact_canonical_v1(self) -> None:
        payload = extractors.export_cape_cod(_CcMethod())
        notes = payload.pop("_sidecar_notes")
        status = payload.pop("_sidecar_status")

        self.assertEqual(notes, "Migrated Cape Cod note")
        self.assertEqual(status, 2)
        self.assertEqual(payload["json_format"], CC_JSON_FORMAT)
        self.assertEqual(payload, normalize_cape_cod_method(payload))
        # Exact producer parity: the migration payload matches what the shared
        # contract produces for the same logical inputs, byte for byte.
        self.assertEqual(payload, _expected_canonical_payload())

        method = payload["method_tab"]
        self.assertEqual(method["prior_ultimate_mode"], "latest_ultimates")
        self.assertEqual(method["scaling_type"], "percentage")
        self.assertTrue(method["auto_trend_fit"])
        self.assertEqual(method["origin_labels"], FIXTURE["origin_labels"])
        self.assertEqual(method["trend_factor_overrides"], [None] * len(FIXTURE["origin_labels"]))
        self.assertLess(
            abs(method["trend_rate"] - FIXTURE["method"]["trend_rate"]), 1e-6
        )
        for actual, expected in zip(
            method["cape_cod_ultimate"], FIXTURE["expected"]["cape_cod_ultimate"]
        ):
            self.assertLess(abs(actual - expected), CANONICAL_TOL * max(1.0, abs(expected)))
        details = payload["details_tab"]
        self.assertEqual(details["method_type"], CC_METHOD_TYPE)
        self.assertEqual(details["name"], FIXTURE["method"]["name"])
        self.assertEqual(details["origin_length"], 12)
        self.assertEqual(details["statistic_decimal_places"], 2)
        for key in ("owned_revision", "derived_revision", "publication_revision"):
            self.assertTrue(payload["method_metadata"][key].startswith("sha256:"))

    def test_manual_trend_factor_overrides_capture_only_flagged_origins(self) -> None:
        payload = extractors.export_cape_cod(_ManualCcMethod())
        payload.pop("_sidecar_notes")
        payload.pop("_sidecar_status")

        self.assertEqual(payload, normalize_cape_cod_method(payload))
        method = payload["method_tab"]
        self.assertFalse(method["auto_trend_fit"])
        self.assertEqual(method["trend_rate"], 0.05)
        self.assertEqual(method["scaling_type"], "unscaled")
        self.assertEqual(method["trend_factor_overrides"], [None, 1.25, None])
        self.assertEqual(method["trend_factors"], [1.1025, 1.25, 1])
        self.assertEqual(method["latest_values"], [100, 90, 70])
        self.assertEqual(method["percentage_developed"], [1, 0.75, 0.5])
        self.assertEqual(payload["details_tab"]["statistic_decimal_places"], 3)

    def test_dfm_factor_percentage_developed_types_import_as_latest_ultimates(self) -> None:
        # ResQ codes 2 (pdCumDevFactors) and 3 (pdCumDevFactorsAdjusted) point the
        # method at a DFM vector whose latest/ultimate ratio reproduces ResQ's
        # percentage developed exactly, so both import as latest_ultimates.
        baseline = extractors.export_cape_cod(_ManualCcMethod())
        for code in (2, 3):
            method = _ManualCcMethod()
            method.PercentageDevelopedType = code
            payload = extractors.export_cape_cod(method)
            self.assertEqual(
                payload["method_tab"]["prior_ultimate_mode"], "latest_ultimates"
            )
            self.assertEqual(payload, baseline)

    def test_empty_dfm_vector_derives_prior_ultimates_from_percentage_developed(self) -> None:
        # The stored vector is all zeros, but latest / PercentageDevelopedValues
        # recovers the same effective prior ultimates the baseline reads directly.
        baseline = extractors.export_cape_cod(_ManualCcMethod())
        payload = extractors.export_cape_cod(_EmptyDfmCcMethod())
        for item in (baseline, payload):
            item.pop("_sidecar_notes")
            item.pop("_sidecar_status")
        self.assertEqual(
            payload["method_tab"]["prior_ultimate_values"], [100, 120, 140]
        )
        self.assertEqual(payload["method_tab"]["percentage_developed"], [1, 0.75, 0.5])
        # ResQ's PercentageDevelopedValues also land as the pattern behind the
        # prior ultimate, which the manual method (no such property) lacks.
        self.assertEqual(
            payload["method_tab"]["prior_ultimate_percentage_developed"], [1, 0.75, 0.5]
        )
        self.assertEqual(baseline["method_tab"]["prior_ultimate_percentage_developed"], [None, None, None])
        expected = normalize_cape_cod_method(
            {
                **baseline,
                "method_tab": {
                    **baseline["method_tab"],
                    "prior_ultimate_percentage_developed": [1, 0.75, 0.5],
                },
            }
        )
        self.assertEqual(payload, expected)

    def test_unknown_percentage_developed_type_is_rejected(self) -> None:
        method = _ManualCcMethod()
        method.PercentageDevelopedType = 4
        with self.assertRaises(ValueError):
            extractors.export_cape_cod(method)

    def test_migration_method_and_sidecar_match_canonical_builders_exactly(self) -> None:
        cc_source = _CcMethod()
        method_payload = extractors.export_cape_cod(cc_source)
        vector_payload = extractors.export_vector(cc_source.OutputVector)
        extractors._apply_cape_cod_vector_metadata(vector_payload, method_payload)

        self.assertEqual(vector_payload["source_kind"], CC_SOURCE_KIND)
        self.assertEqual(vector_payload["method_type"], CC_METHOD_TYPE)
        self.assertEqual(vector_payload["method_type_code"], CC_METHOD_TYPE_CODE)
        self.assertEqual(vector_payload["notes"], "Migrated Cape Cod note")
        self.assertEqual(
            vector_payload["precedents"],
            [
                FIXTURE["method"]["latest_dataset"],
                FIXTURE["method"]["exposure_dataset"],
                FIXTURE["method"]["prior_ultimate_dataset"],
            ],
        )
        self.assertEqual(
            vector_payload["values"],
            [[value] for value in method_payload["method_tab"]["cape_cod_ultimate"]],
        )

        extractors.write_vector_export(
            vector_payload,
            r"Auto\PP",
            self.rc_dir,
            cc_method_payload=method_payload,
        )
        method_path = extractors.write_cape_cod_export(
            method_payload, r"Auto\PP", self.rc_dir
        )

        method_name = FIXTURE["method"]["name"]
        self.assertEqual(method_path.name, f"CC@{method_name}.json")
        self.assertTrue((self.rc_dir / "datasets" / f"{method_name}@12.csv").is_file())
        sidecar_path = self.rc_dir / "sidecars" / f"{method_name}.json"
        written_method = json.loads(method_path.read_text(encoding="utf-8"))
        written_sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        expected_sidecar = build_cape_cod_output_sidecar(
            method_payload,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file=f"{method_name}@12.csv",
            existing={},
            notes="Migrated Cape Cod note",
            timestamp=MODIFIED,
            user="migration-user",
            output_changed=True,
            append_audit=True,
            status=2,
        )

        self.assertEqual(written_method, normalize_cape_cod_method(method_payload))
        self.assertEqual(written_sidecar, expected_sidecar)
        self.assertEqual(written_sidecar["source_kind"], CC_SOURCE_KIND)
        self.assertEqual(written_sidecar["method_type"], CC_METHOD_TYPE)
        self.assertNotIn("method_type_code", written_sidecar)
        self.assertEqual(
            written_sidecar["publication_revision"],
            written_method["method_metadata"]["publication_revision"],
        )
        self.assertEqual(written_sidecar["dataset_category"], "Loss")
        self.assertEqual(written_sidecar["status"], 2)


if __name__ == "__main__":
    unittest.main()
