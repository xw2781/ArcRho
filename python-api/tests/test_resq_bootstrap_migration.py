"""ResQ import of Bootstrap methods.

The fake COM Bootstrap carries the COL segment of the step-1 capture
(``fixtures/resq_bootstrap_consolidation_total.json.gz``): ResQ's settings, its
seed, its target ultimate, and the residuals ResQ itself computed. The DFM the
Bootstrap reads is written as an Arco DFM method JSON first, exactly as the
import's vector loop writes it before the deferred Bootstrap is built.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
REPO_ROOT = _PYTHON_API.parent
for _path in (_PYTHON_API / "src", _PYTHON_API / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from arcrho_api.bootstrap_contract import (  # noqa: E402
    BST_JSON_FORMAT,
    BST_METHOD_TYPE,
    BST_SOURCE_KIND,
    build_bootstrap_output_sidecar,
    dfm_snapshot_from_method,
    normalize_bootstrap_method,
    recalculate_bootstrap_method,
)
from arcrho_api.dfm_contract import normalize_dfm_method  # noqa: E402
from arcrho_api.io import persisted_json_text  # noqa: E402
from resq_migration import extractors  # noqa: E402
from resq_migration.number_formats import configure_number_formats_path  # noqa: E402


FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "resq_bootstrap_consolidation_total.json.gz"
with gzip.open(FIXTURE_PATH, "rt", encoding="utf-8") as _handle:
    _CAPTURE = json.load(_handle)
SEGMENT = next(item for item in _CAPTURE["segments"] if item["reserving_class"].endswith("\\COL"))
SETTINGS = SEGMENT["settings"]
RC_PATH = SEGMENT["reserving_class"]
DFM_NAME = SETTINGS["dfm"]
DFM_OUTPUT_DATASET = "F 25 Ultimate"
MODIFIED = "2026-09-23T13:10:07Z"
# The seed is ResQ's own; the count is cut so the suite stays quick. The
# persisted format and every deterministic value do not depend on it.
SIMULATION_COUNT = 300
RESIDUAL_TYPES = (
    "unscaled",
    "unscaled_bias_adjusted",
    "scaled",
    "scaled_bias_adjusted",
    "scaled_bias_adjusted_zero_average",
)
DISTRIBUTION_CODES = {"none": 0, "resampled": 1, "normal": 2, "log_normal": 3, "gamma": 4, "odp": 5}
MODEL_CODES = {"mack": 0, "odp_varying_scale": 1, "odp_single_scale": 2}
SCALING_CODES = {"unscaled": 0, "additive": 1, "multiplicative": 2, "user_defined": 3, "from_target": 4}


class _Category:
    Name = "F Net Loss"


class _DatasetType:
    # ResQ carries a trailing space on this type name; the import trims it.
    Name = "F 00 - Ultimate Net Loss "
    Category = _Category()


class _Vector:
    def __init__(self, name: str, labels: list[str], values: list, *, method_type: int = 0):
        self.Name = name
        self._labels = list(labels)
        self._values = list(values)
        self.OriginCount = len(self._values)
        self.PeriodLength = 12
        self.DatasetType = _DatasetType()
        self.MethodType = method_type
        self.Modified = MODIFIED
        self.Created = "2023-03-26T15:53:25Z"
        self.User = "Moore, Kelly"
        self.Status = 0
        self.Notes = ""
        self.Formula = ""

    def OriginLabel(self, index: int):
        return self._labels[index - 1]

    def ValuesByIndex(self, index: int):
        return self._values[index - 1]


class _Dfm:
    Name = DFM_NAME


class _Bootstrap:
    """Fake ResQ xBootstrapMethod with the COL capture's settings."""

    Notes = "Created: 3/26/2023 3:53:25 PM by Moore, Kelly"
    OriginLength = SETTINGS["origin_length"]
    DevelopmentLength = SETTINGS["development_length"]
    TotalDevelopmentPeriods = SETTINGS["total_development_periods"]
    ModelType = MODEL_CODES[SETTINGS["model_type"]]
    EstimationVariance = DISTRIBUTION_CODES[SETTINGS["estimation_variance"]]
    ProcessVariance = DISTRIBUTION_CODES[SETTINGS["process_variance"]]
    PreventNegativeData = SETTINGS["prevent_negative_data"]
    UseNormalOnNegMean = SETTINGS["use_normal_on_negative_mean"]
    ODP_NegativeMeanOption = 2
    BiasAdjustment = SETTINGS["bias_adjustment"]
    RandomSeed = SETTINGS["random_seed"]
    ScaleValueSmoother_Residuals = 0.0
    ScaleValueSmoother_Forecasting = 0.0

    def __init__(self, *, user_scale: dict[int, float] | None = None, target: bool = True):
        self.Name = SEGMENT["name"]
        self.SimulationCount = SIMULATION_COUNT
        labels = SEGMENT["origin_labels"]
        self.OriginCount = len(labels)
        self.OutputVector = _Vector(
            SEGMENT["name"], labels, [[None]] * len(labels), method_type=6
        )
        self.DFMMethod = _Dfm()
        self.TargetUltimate = (
            _Vector(SETTINGS["target_ultimate"], labels, SEGMENT["target_ultimates"])
            if target
            else None
        )
        self._user_scale = dict(user_scale or {})

    def OriginLabel(self, index: int):
        return SEGMENT["origin_labels"][index - 1]

    def TargetScalingMethods(self, index: int):
        return SCALING_CODES[SEGMENT["target_scaling_methods"][index - 1]]

    def TargetCVs(self, _index: int):
        return 0.0

    def SelectedScaleValues_Residuals(self, dev_index: int):
        return 2 if dev_index in self._user_scale else 0

    def SelectedScaleValues_Forecasting(self, _dev_index: int):
        return 0

    def ScaleValues_Residuals(self, dev_index: int, value_type: int):
        if value_type == 2 and dev_index in self._user_scale:
            return self._user_scale[dev_index]
        # ResQ answers the unsmoothed value for an entry nobody typed.
        return SEGMENT["scale_values_residuals_unsmoothed"][dev_index - 1]

    def ScaleValues_Forecasting(self, dev_index: int, _value_type: int):
        return SEGMENT["scale_values_residuals_unsmoothed"][dev_index - 1]


class _Collection(list):
    def Item(self, key):
        for item in self:
            if item.Name == key:
                return item
        raise KeyError(key)


class _ReservingClass:
    def __init__(self, bootstraps: list):
        self._bootstraps = _Collection(bootstraps)

    def BootstrapMethods(self):
        return self._bootstraps

    def GetBootStrapMethod(self, name: str):
        return self._bootstraps.Item(name)


def dfm_payload() -> dict:
    """An Arco DFM whose snapshot carries the capture's triangle and ratios."""

    labels = list(SEGMENT["origin_labels"])
    ratios = list(SEGMENT["selected_ratios"])
    development = [str(12 * (index + 1)) for index in range(len(ratios))]
    return normalize_dfm_method(
        {
            "json_format": "arcrho-dfm-v4",
            "details_tab": {
                "name": DFM_NAME,
                "output_type": "F 00 - Ultimate Net Loss",
                "output_dataset": DFM_OUTPUT_DATASET,
                "output_category": "F Net Loss",
                "input_triangle": "Net Loss--Incurred",
                "origin_length": 12,
                "development_length": 12,
            },
            "data_tab": {
                "origin_labels": labels,
                "development_labels": development,
                "input_data_triangle_values": SEGMENT["observed_triangle"],
            },
            "ratios_tab": {
                "ratio_triangle": {"development_labels": development},
                "average_formulas": {
                    "values": [ratios],
                    "selected": [[1] * len(ratios)],
                    "custom_average_formula_settings": {
                        "average_type": ["user_entry"],
                        "base": ["volume"],
                        "periods": ["all"],
                        "exclude": [0],
                    },
                },
            },
            "results_tab": {},
            "method_metadata": {},
        },
        require_complete=False,
    )


def expected_owned() -> dict:
    """The owned inputs the app server would be handed for the same method."""

    labels = SEGMENT["origin_labels"]
    return {
        "json_format": BST_JSON_FORMAT,
        "details_tab": {
            "name": SEGMENT["name"],
            "method_type": BST_METHOD_TYPE,
            "output_type": "F 00 - Ultimate Net Loss",
            "dataset_category": "F Net Loss",
            "origin_length": 12,
            "development_length": 12,
            "model_type": SETTINGS["model_type"],
            "dfm_method": DFM_NAME,
        },
        "residuals_tab": {
            "residual_scale_smoothing": 0.0,
            "forecast_scale_smoothing": 0.0,
            "user_scale_values_residuals": [None] * SETTINGS["total_development_periods"],
            "user_scale_values_forecasting": [None] * SETTINGS["total_development_periods"],
        },
        "simulation_tab": {
            "estimation_variance": SETTINGS["estimation_variance"],
            "process_variance": SETTINGS["process_variance"],
            "simulation_count": SIMULATION_COUNT,
            "random_seed": SETTINGS["random_seed"],
            "prevent_negative_data": SETTINGS["prevent_negative_data"],
            "negative_mean_action": "normal",
            "odp_negative_mean_action": "negative_mean",
        },
        "results_tab": {
            "target_ultimate": SETTINGS["target_ultimate"].strip(),
            "target_scaling_methods": list(SEGMENT["target_scaling_methods"]),
            "target_cvs": [0.0] * len(labels),
        },
        "method_metadata": {
            "method_type": BST_METHOD_TYPE,
            "source_kind": BST_SOURCE_KIND,
            "last_modified": MODIFIED,
            "data_refreshed": MODIFIED,
        },
    }


class ResQBootstrapMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = REPO_ROOT / "test"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.rc_dir = self.root / "data" / "COL"
        (self.rc_dir / "methods").mkdir(parents=True)
        configure_number_formats_path(self.root)
        extractors.configure_extractors(
            project_name="NJ_Annual_Prod_202605_Fake",
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )
        self.dfm = dfm_payload()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _export(self, bootstrap=None, *, strict: bool = False) -> dict:
        return extractors.export_bootstrap(
            bootstrap or _Bootstrap(), dfm_payload=self.dfm, strict=strict
        )

    def test_payload_equals_the_shared_contract_for_the_same_inputs(self) -> None:
        payload = self._export()
        self.assertEqual(payload.pop("_sidecar_notes"), _Bootstrap.Notes)
        self.assertEqual(payload.pop("_sidecar_status"), 0)
        self.assertEqual(payload.pop("_sidecar_user"), "Moore, Kelly")
        target = SEGMENT["target_ultimates"]
        expected = recalculate_bootstrap_method(
            expected_owned(),
            dfm_snapshot=dfm_snapshot_from_method(self.dfm),
            target_snapshot={
                "name": SETTINGS["target_ultimate"].strip(),
                "origin_labels": SEGMENT["origin_labels"],
                "values": target,
            },
            timestamp=MODIFIED,
        )
        self.assertEqual(payload, expected)
        self.assertEqual(payload, normalize_bootstrap_method(payload))

    def test_settings_and_seed_round_trip_from_resq(self) -> None:
        payload = self._export(strict=True)
        details = payload["details_tab"]
        simulation = payload["simulation_tab"]
        results = payload["results_tab"]
        self.assertEqual(details["name"], "F 72 A - Bootstrap Net incurred with PV")
        self.assertEqual(details["output_type"], "F 00 - Ultimate Net Loss")
        self.assertEqual(details["dataset_category"], "F Net Loss")
        self.assertEqual(details["model_type"], "odp_single_scale")
        self.assertEqual(details["dfm_method"], DFM_NAME)
        self.assertEqual(simulation["random_seed"], 735889630)
        self.assertEqual(simulation["simulation_count"], SIMULATION_COUNT)
        self.assertEqual(simulation["estimation_variance"], "gamma")
        self.assertEqual(simulation["process_variance"], "gamma")
        self.assertTrue(simulation["prevent_negative_data"])
        self.assertEqual(simulation["negative_mean_action"], "normal")
        self.assertEqual(simulation["odp_negative_mean_action"], "negative_mean")
        self.assertEqual(results["target_ultimate"], "F 92 - Current Qtr Selected")
        self.assertEqual(results["target_scaling_methods"], ["additive"] * 10)
        self.assertEqual(results["origin_labels"], SEGMENT["origin_labels"])
        # Simulated once on import, so the method opens with results.
        self.assertTrue(all(value is not None for value in results["bootstrap_ultimate"]))
        self.assertEqual(
            payload["method_metadata"]["last_modified"], MODIFIED
        )

    def test_residuals_match_resq(self) -> None:
        payload = self._export()
        residuals = payload["residuals_tab"]
        compared = 0
        for index, key in enumerate(RESIDUAL_TYPES):
            expected_grid = SEGMENT["residuals_by_type"][str(index)]
            actual_grid = residuals["residual_values"][key]
            for origin, row in enumerate(expected_grid):
                for column, expected in enumerate(row):
                    actual = actual_grid[origin][column] if column < len(actual_grid[origin]) else None
                    if expected is None or expected == 0:
                        continue
                    self.assertIsNotNone(actual, f"{key} ({origin},{column})")
                    # Persisted statistics carry six decimals.
                    self.assertLessEqual(abs(actual - expected), 1e-6, f"{key} ({origin},{column})")
                    compared += 1
        self.assertGreater(compared, 200)
        self.assertLessEqual(
            abs(residuals["residual_adjustment"] - SEGMENT["residual_adjustment"]), 1e-6
        )
        for actual, expected in zip(
            residuals["scale_values_residuals"]["unsmoothed"],
            SEGMENT["scale_values_residuals_unsmoothed"],
        ):
            self.assertLessEqual(abs(actual - expected), 1e-6)

    def test_only_selected_user_entry_scale_values_import(self) -> None:
        payload = self._export(_Bootstrap(user_scale={3: 25.5}))
        user = payload["residuals_tab"]["user_scale_values_residuals"]
        self.assertEqual(user[2], 25.5)
        self.assertEqual([value for index, value in enumerate(user) if index != 2], [None] * 10)
        self.assertEqual(payload["residuals_tab"]["scale_values_residuals"]["selected"][2], 25.5)
        self.assertEqual(
            payload["residuals_tab"]["user_scale_values_forecasting"], [None] * 11
        )

    def test_per_origin_scaling_methods_survive_the_first_calculation(self) -> None:
        bootstrap = _Bootstrap()
        bootstrap.TargetScalingMethods = lambda index: 2 if index % 2 else 1
        payload = self._export(bootstrap)
        self.assertEqual(
            payload["results_tab"]["target_scaling_methods"],
            ["multiplicative", "additive"] * 5,
        )

    def test_a_bootstrap_without_a_target_imports_unscaled(self) -> None:
        payload = self._export(_Bootstrap(target=False))
        self.assertEqual(payload["results_tab"]["target_ultimate"], "")
        self.assertEqual(payload["results_tab"]["target_ultimate_values"], [None] * 10)

    def test_a_dfm_of_another_name_is_refused(self) -> None:
        other = json.loads(json.dumps(self.dfm))
        other["details_tab"]["name"] = "Some Other DFM"
        with self.assertRaises(ValueError):
            extractors.export_bootstrap(_Bootstrap(), dfm_payload=other)

    def test_unknown_enumeration_codes_are_refused(self) -> None:
        bootstrap = _Bootstrap()
        bootstrap.ModelType = 7
        with self.assertRaises(ValueError):
            self._export(bootstrap)

    def test_written_files_match_the_canonical_builders(self) -> None:
        payload = self._export()
        path = extractors.write_bootstrap_export(
            payload, RC_PATH, self.rc_dir, dfm_payload=self.dfm
        )
        name = SEGMENT["name"]
        self.assertEqual(path.name, f"BST@{name}.json")
        written = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn("_sidecar_notes", written)
        self.assertEqual(written, normalize_bootstrap_method(written))
        csv_text = (self.rc_dir / "datasets" / f"{name}@12.csv").read_text(encoding="utf-8")
        self.assertEqual(
            csv_text,
            "".join(f"{value}\n" for value in written["results_tab"]["bootstrap_ultimate"]),
        )
        sidecar = json.loads((self.rc_dir / "sidecars" / f"{name}.json").read_text(encoding="utf-8"))
        expected_sidecar = build_bootstrap_output_sidecar(
            written,
            project_name="NJ_Annual_Prod_202605_Fake",
            reserving_class=RC_PATH,
            csv_file=f"{name}@12.csv",
            precedents=[DFM_OUTPUT_DATASET, "F 92 - Current Qtr Selected"],
            existing={},
            notes=_Bootstrap.Notes,
            timestamp=MODIFIED,
            user="Moore, Kelly",
            status=0,
        )
        self.assertEqual(sidecar, json.loads(persisted_json_text(expected_sidecar)))
        self.assertEqual(sidecar["source_kind"], BST_SOURCE_KIND)
        self.assertEqual(
            sidecar["publication_revision"], written["method_metadata"]["publication_revision"]
        )

    def test_finder_goes_through_the_class_and_checks_the_output(self) -> None:
        bootstrap = _Bootstrap()
        rc = _ReservingClass([bootstrap])
        self.assertIs(extractors._find_bootstrap_for_vector(rc, SEGMENT["name"]), bootstrap)
        self.assertIsNone(extractors._find_bootstrap_for_vector(rc, "F 72B - Other"))


class ResQBootstrapVectorLoopTests(unittest.TestCase):
    """The vector loop defers a Bootstrap until its DFM has been written."""

    def setUp(self) -> None:
        tmp_root = REPO_ROOT / "test"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.rc_dir = self.root / "data" / "COL"
        for folder in ("methods", "datasets", "sidecars"):
            (self.rc_dir / folder).mkdir(parents=True)
        configure_number_formats_path(self.root)
        import resq_data_migration

        self.migration = resq_data_migration
        extractors.configure_extractors(
            project_name="NJ_Annual_Prod_202605_Fake",
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, *, write_dfm: bool) -> tuple[tuple[int, int], dict, dict]:
        if write_dfm:
            (self.rc_dir / "methods" / f"DFM@{DFM_NAME}.json").write_text(
                persisted_json_text(dfm_payload()), encoding="utf-8"
            )
        counts: dict = {}
        state = {"completed": 0, "total": 1}
        result = self.migration._export_bootstrap_tasks(
            [(SEGMENT["name"], _Bootstrap())],
            RC_PATH,
            self.rc_dir,
            progress_callback=None,
            progress_state=state,
            method_counts=counts,
            strict_extraction=False,
            verbose=False,
        )
        return result, counts, state

    def test_deferred_bootstrap_is_built_from_the_written_dfm(self) -> None:
        result, counts, state = self._run(write_dfm=True)
        self.assertEqual(result, (1, 0))
        self.assertEqual(counts["bootstraps_written"], 1)
        self.assertEqual(state["completed"], 1)
        self.assertTrue((self.rc_dir / "methods" / f"BST@{SEGMENT['name']}.json").is_file())

    def test_missing_dfm_is_reported_as_an_error(self) -> None:
        result, counts, state = self._run(write_dfm=False)
        self.assertEqual(result, (0, 1))
        self.assertNotIn("bootstraps_written", counts)
        self.assertIn(DFM_NAME, state["error_details"][0]["message"])

    def test_a_bootstrap_coded_vector_without_its_method_imports_as_a_plain_dataset(self) -> None:
        vector = _Vector("Orphan", ["2025", "2026"], [1.0, 2.0], method_type=6)
        payload = extractors.export_vector(vector)
        extractors.write_vector_export(payload, RC_PATH, self.rc_dir)
        sidecar = json.loads((self.rc_dir / "sidecars" / "Orphan.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["method_type"], "None")
        self.assertEqual(sidecar["source_kind"], "input")


if __name__ == "__main__":
    unittest.main()
