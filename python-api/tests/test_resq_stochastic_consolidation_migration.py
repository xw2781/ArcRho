"""ResQ import of Stochastic Consolidations.

The fake COM consolidation carries the Total consolidation of the step-1
capture (``fixtures/resq_bootstrap_consolidation_total.json.gz``): its five
included bootstraps with their class paths and factors, the correlation
settings, the target matrix and the seed. The segment bootstraps are written
into their own class folders first, built from the same capture, exactly as an
earlier import of each segment class leaves them.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


_PYTHON_API = Path(__file__).resolve().parents[1]
REPO_ROOT = _PYTHON_API.parent
for _path in (_PYTHON_API / "src", _PYTHON_API / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from arcrho_api.bootstrap_contract import (  # noqa: E402
    BST_JSON_FORMAT,
    dfm_snapshot_from_method,
    recalculate_bootstrap_method,
)
from arcrho_api.dfm_contract import normalize_dfm_method  # noqa: E402
from arcrho_api.io import persisted_json_text  # noqa: E402
from arcrho_api.stochastic_consolidation_contract import (  # noqa: E402
    SCON_JSON_FORMAT,
    SCON_METHOD_TYPE,
    SCON_SOURCE_KIND,
    apply_owned_patch,
    build_stochastic_consolidation_output_sidecar,
    consolidate_stochastic_method,
    normalize_stochastic_consolidation_method,
)
from resq_migration import catalog, extractors  # noqa: E402
from resq_migration.catalog import refresh_sidecar_graphs_for_rc  # noqa: E402
from resq_migration.core import _encode_name_part, _encode_rc_folder  # noqa: E402
from resq_migration.number_formats import configure_number_formats_path  # noqa: E402


FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "resq_bootstrap_consolidation_total.json.gz"
with gzip.open(FIXTURE_PATH, "rt", encoding="utf-8") as _handle:
    _CAPTURE = json.load(_handle)
CONSOLIDATION = _CAPTURE["consolidation"]
SETTINGS = CONSOLIDATION["settings"]
HOST_CLASS = CONSOLIDATION["reserving_class"]
GROUP = HOST_CLASS.rsplit("\\", 1)[0]
SEGMENTS = {item["reserving_class"]: item for item in _CAPTURE["segments"]}
PROJECT = "NJ_Annual_Prod_202605_Fake"
DFM_NAME = "F 25 - Incurred DFM Bootstrap"
BASE_TYPE = "Net Loss--Incurred"
MODIFIED = "2026-09-23T13:10:10Z"
# The same instant as every producer persists it.
PERSISTED_MODIFIED = "2026-09-23T13:10:10.000Z"
# The seeds are ResQ's own; the count is cut so the suite stays quick.
SIMULATION_COUNT = 300
CORRELATION_CODES = {"independent": 0, "fully_correlated": 1, "specified": 2, "as_it_comes": 3}
DEPENDENCY_CODES = {"normal": 0, "uniform": 1, "gamma": 2, "students_t": 3}


def segment_path(short_name: str) -> str:
    return f"{GROUP}\\{short_name}"


def included() -> list[dict]:
    """The included bootstraps as Arco keys them: full class path, name, factor."""

    return [
        {
            "reserving_class": segment_path(item["reserving_class"]),
            "method_name": item["method"],
            "factor": item["factor"],
        }
        for item in CONSOLIDATION["included_methods"]
    ]


# -- segment bootstraps, as a segment import leaves them ----------------------


def segment_dfm(segment: dict) -> dict:
    labels = list(segment["origin_labels"])
    ratios = list(segment["selected_ratios"])
    development = [str(12 * (index + 1)) for index in range(len(ratios))]
    return normalize_dfm_method(
        {
            "json_format": "arcrho-dfm-v4",
            "details_tab": {
                "name": DFM_NAME,
                "output_type": "F 00 - Ultimate Net Loss",
                "output_dataset": "F 25 Ultimate",
                "output_category": "F Net Loss",
                "input_triangle": BASE_TYPE,
                "origin_length": 12,
                "development_length": 12,
            },
            "data_tab": {
                "origin_labels": labels,
                "development_labels": development,
                "input_data_triangle_values": segment["observed_triangle"],
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


def segment_bootstrap(segment: dict, dfm: dict) -> dict:
    settings = segment["settings"]
    labels = list(segment["origin_labels"])
    return recalculate_bootstrap_method(
        {
            "json_format": BST_JSON_FORMAT,
            "details_tab": {
                "name": segment["name"],
                "output_type": "F 00 - Ultimate Net Loss",
                "origin_length": 12,
                "development_length": 12,
                "model_type": settings["model_type"],
                "dfm_method": DFM_NAME,
            },
            "simulation_tab": {
                "estimation_variance": settings["estimation_variance"],
                "process_variance": settings["process_variance"],
                "simulation_count": SIMULATION_COUNT,
                "random_seed": settings["random_seed"],
                "prevent_negative_data": settings["prevent_negative_data"],
                "negative_mean_action": "normal",
            },
            "results_tab": {
                "target_ultimate": settings["target_ultimate"].strip(),
                "target_scaling_methods": list(segment["target_scaling_methods"]),
            },
            "method_metadata": {},
        },
        dfm_snapshot=dfm_snapshot_from_method(dfm),
        target_snapshot={
            "name": settings["target_ultimate"].strip(),
            "origin_labels": labels,
            "values": segment["target_ultimates"],
        },
        timestamp=MODIFIED,
    )


def write_segment_bootstraps(data_dir: Path, *, skip: tuple[str, ...] = ()) -> dict[str, dict]:
    """Write each segment's DFM and Bootstrap under its own class folder."""

    written: dict[str, dict] = {}
    for class_path, segment in SEGMENTS.items():
        if class_path in skip:
            continue
        methods = data_dir / _encode_rc_folder(class_path) / "methods"
        methods.mkdir(parents=True, exist_ok=True)
        dfm = segment_dfm(segment)
        bootstrap = segment_bootstrap(segment, dfm)
        (methods / f"DFM@{_encode_name_part(DFM_NAME)}.json").write_text(
            persisted_json_text(dfm), encoding="utf-8", newline="\n"
        )
        (methods / f"BST@{_encode_name_part(segment['name'])}.json").write_text(
            persisted_json_text(bootstrap), encoding="utf-8", newline="\n"
        )
        written[class_path] = bootstrap
    return written


# -- fake ResQ COM --------------------------------------------------------------


class _Named:
    def __init__(self, name: str, **fields):
        self.Name = name
        for key, value in fields.items():
            setattr(self, key, value)


class _OutputVector:
    Modified = MODIFIED
    User = "Robot Worker"
    Status = 0

    def __init__(self, name: str):
        self.Name = name
        self.DatasetType = _Named("F 00 - Ultimate Net Loss ", Category=_Named("F Net Loss"))


class _IncludedVector:
    """``IncludedMethods(i)`` answers the bootstrap's output vector."""

    MethodType = 6

    def __init__(self, class_path: str, name: str):
        self.Name = name
        self.ReservingClass = _Named(class_path.rsplit("\\", 1)[-1], Path=class_path)


class _Consolidation:
    """Fake ResQ xStochasticConsolidation with the Total capture's settings."""

    Notes = "Created: 3/26/2023 4:26:47 PM by Moore, Kelly"
    OriginLength = 12
    DevelopmentLength = 12
    ConsolidateBasedOnScaled = True
    ConsolidateReserveCashflows = False

    def __init__(self):
        self.Name = CONSOLIDATION["name"]
        self.OutputVector = _OutputVector(CONSOLIDATION["name"])
        self.BaseTriangleType = _Named(SETTINGS["base_triangle_type"])
        self.CorrelationType = CORRELATION_CODES[SETTINGS["correlation_type"]]
        self.DependencyType = DEPENDENCY_CODES[SETTINGS["dependency_type"]]
        self.DegreesOfFreedom = SETTINGS["degrees_of_freedom"]
        self.RandomSeed = SETTINGS["random_seed"]
        self.SimulationCount = SETTINGS["simulation_count"]
        self.OriginCount = len(CONSOLIDATION["origin_labels"])
        self.IncludedMethodCount = len(CONSOLIDATION["included_methods"])
        self._included = [
            _IncludedVector(item["reserving_class"], item["method_name"]) for item in included()
        ]
        self._factors = [item["factor"] for item in included()]
        self._target = [list(row) for row in CONSOLIDATION["target_correlations"]]

    def IncludedMethods(self, index: int):
        return self._included[index - 1]

    def Factors(self, index: int):
        return self._factors[index - 1]

    def MethodCorrelations(self, row: int, column: int):
        return self._target[row - 1][column - 1]

    def OriginLabel(self, index: int):
        return CONSOLIDATION["origin_labels"][index - 1]


class _Collection(list):
    def Item(self, key):
        for item in self:
            if item.Name == key:
                return item
        raise KeyError(key)


class _ReservingClass:
    def __init__(self, consolidations: list):
        self._consolidations = _Collection(consolidations)

    def BootstrapConsolidations(self):
        return self._consolidations

    def GetBootStrapConsolidation(self, name: str):
        return self._consolidations.Item(name)


def expected_owned() -> dict:
    """The owned inputs the app server would be handed for the same consolidation."""

    return {
        "json_format": SCON_JSON_FORMAT,
        "details_tab": {
            "name": CONSOLIDATION["name"],
            "output_type": "F 00 - Ultimate Net Loss",
            "dataset_category": "F Net Loss",
            "base_triangle_type": BASE_TYPE,
            "origin_length": 12,
            "development_length": 12,
            "random_seed": SETTINGS["random_seed"],
        },
        "segments_tab": {"segments": included()},
        "correlation_tab": {
            "correlation_option": "specified",
            "dependency_type": "normal",
            "degrees_of_freedom": SETTINGS["degrees_of_freedom"],
            "target_correlations": CONSOLIDATION["target_correlations"],
        },
    }


class ResQStochasticConsolidationMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = REPO_ROOT / "test"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.rc_dir = self.data_dir / _encode_rc_folder(HOST_CLASS)
        for folder in ("methods", "datasets", "sidecars"):
            (self.rc_dir / folder).mkdir(parents=True)
        configure_number_formats_path(self.root)
        extractors.configure_extractors(
            project_name=PROJECT,
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _export(self, consolidation=None, *, strict: bool = False) -> dict:
        return extractors.export_stochastic_consolidation(
            consolidation or _Consolidation(), project_data_dir=self.data_dir, strict=strict
        )

    def test_payload_equals_the_shared_contract_for_the_same_inputs(self) -> None:
        bootstraps = write_segment_bootstraps(self.data_dir)
        payload = self._export(strict=True)
        self.assertEqual(payload.pop("_sidecar_notes"), _Consolidation.Notes)
        self.assertEqual(payload.pop("_sidecar_status"), 0)
        self.assertEqual(payload.pop("_sidecar_user"), "Robot Worker")
        self.assertEqual(payload.pop("_import_problem"), "")
        merged = apply_owned_patch({"json_format": SCON_JSON_FORMAT}, expected_owned(), timestamp=MODIFIED)
        expected = consolidate_stochastic_method(
            merged,
            [
                {"bootstrap": bootstraps[item["reserving_class"]], "base_triangle_type": BASE_TYPE}
                for item in included()
            ],
            timestamp=MODIFIED,
        )
        self.assertEqual(payload, expected)
        self.assertEqual(payload, normalize_stochastic_consolidation_method(payload))

    def test_settings_and_seed_round_trip_from_resq(self) -> None:
        write_segment_bootstraps(self.data_dir)
        payload = self._export(strict=True)
        details = payload["details_tab"]
        correlation = payload["correlation_tab"]
        self.assertEqual(details["name"], "F 72 A - Bootstrap Consolidation Net Incurred with PV")
        self.assertEqual(details["output_type"], "F 00 - Ultimate Net Loss")
        self.assertEqual(details["dataset_category"], "F Net Loss")
        self.assertEqual(details["base_triangle_type"], BASE_TYPE)
        self.assertEqual(details["random_seed"], 1514684455)
        self.assertEqual(
            [(item["reserving_class"], item["method_name"], item["factor"])
             for item in payload["segments_tab"]["segments"]],
            [(item["reserving_class"], item["method_name"], 1) for item in included()],
        )
        self.assertEqual(
            payload["segments_tab"]["segments"][2]["method_name"],
            "F 72 A - Bootstrap Net incurred with PV",
        )
        self.assertEqual(correlation["correlation_option"], "specified")
        self.assertEqual(correlation["dependency_type"], "normal")
        self.assertEqual(correlation["degrees_of_freedom"], 20)
        self.assertEqual(correlation["target_correlations"], CONSOLIDATION["target_correlations"])
        self.assertEqual(payload["method_metadata"]["last_modified"], PERSISTED_MODIFIED)

    def test_consolidated_once_on_import_with_resqs_adjusted_matrix(self) -> None:
        write_segment_bootstraps(self.data_dir)
        payload = self._export()
        self.assertEqual(payload["details_tab"]["simulation_count"], SIMULATION_COUNT)
        self.assertTrue(all(segment["bootstrap_revision"] for segment in payload["segments_tab"]["segments"]))
        results = payload["results_tab"]
        self.assertEqual(results["origin_labels"], CONSOLIDATION["origin_labels"])
        self.assertTrue(results["input_revision"])
        self.assertTrue(all(value is not None for value in results["consolidation_ultimate"]))
        for row, expected_row in zip(
            payload["correlation_tab"]["adjusted_correlations"], CONSOLIDATION["adjusted_correlations"]
        ):
            for actual, expected in zip(row, expected_row):
                # ResQ's adjustment 2*sin(pi*rho/6), stored at six decimals.
                self.assertLessEqual(abs(actual - expected), 5e-7)

    def test_missing_segments_are_named_and_the_method_is_written_unrun(self) -> None:
        missing = (segment_path("MP+PIP"), segment_path("BI Total"))
        write_segment_bootstraps(self.data_dir, skip=missing)
        payload = self._export()
        problem = payload["_import_problem"]
        for class_path in missing:
            self.assertIn(f"{class_path} / F 72 A - Bootstrap Net Incurred with PV", problem)
        self.assertNotIn("COL", problem)
        results = payload["results_tab"]
        self.assertEqual(results["input_revision"], "")
        self.assertEqual(results["origin_labels"], CONSOLIDATION["origin_labels"])
        self.assertEqual(results["consolidation_ultimate"], [None] * 10)
        self.assertEqual(payload["details_tab"]["simulation_count"], 0)
        self.assertEqual(payload["segments_tab"]["segments"][0]["bootstrap_revision"], "")

        path = extractors.write_stochastic_consolidation_export(payload, HOST_CLASS, self.rc_dir)
        written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written, normalize_stochastic_consolidation_method(written))
        name = CONSOLIDATION["name"]
        self.assertEqual((self.rc_dir / "datasets" / f"{name}@12.csv").read_text(encoding="utf-8"), '""\n' * 10)

    def test_a_segment_on_another_base_type_leaves_the_method_unrun(self) -> None:
        write_segment_bootstraps(self.data_dir)
        consolidation = _Consolidation()
        consolidation.BaseTriangleType = _Named("Net Loss--Paid")
        payload = self._export(consolidation)
        self.assertIn("Net Loss--Paid", payload["_import_problem"])
        self.assertEqual(payload["results_tab"]["input_revision"], "")

    def test_unknown_enumeration_codes_are_refused(self) -> None:
        consolidation = _Consolidation()
        consolidation.DependencyType = 9
        with self.assertRaises(ValueError):
            self._export(consolidation)

    def test_written_files_match_the_canonical_builders(self) -> None:
        write_segment_bootstraps(self.data_dir)
        payload = self._export()
        path = extractors.write_stochastic_consolidation_export(payload, HOST_CLASS, self.rc_dir)
        name = CONSOLIDATION["name"]
        self.assertEqual(path.name, f"SCON@{name}.json")
        written = json.loads(path.read_text(encoding="utf-8"))
        for field in ("_sidecar_notes", "_sidecar_status", "_sidecar_user", "_import_problem"):
            self.assertNotIn(field, written)
        self.assertEqual(written, normalize_stochastic_consolidation_method(written))
        csv_text = (self.rc_dir / "datasets" / f"{name}@12.csv").read_text(encoding="utf-8")
        self.assertEqual(
            csv_text,
            "".join(f"{value}\n" for value in written["results_tab"]["consolidation_ultimate"]),
        )
        sidecar = json.loads((self.rc_dir / "sidecars" / f"{name}.json").read_text(encoding="utf-8"))
        expected_sidecar = build_stochastic_consolidation_output_sidecar(
            written,
            project_name=PROJECT,
            reserving_class=HOST_CLASS,
            csv_file=f"{name}@12.csv",
            existing={},
            notes=_Consolidation.Notes,
            timestamp=MODIFIED,
            user="Robot Worker",
            status=0,
        )
        self.assertEqual(sidecar, json.loads(persisted_json_text(expected_sidecar)))
        self.assertEqual(sidecar["source_kind"], SCON_SOURCE_KIND)
        self.assertEqual(sidecar["method_type"], SCON_METHOD_TYPE)
        self.assertEqual(
            [(entry["dataset_name"], entry.get("reserving_class")) for entry in sidecar["precedents"]],
            [(item["method_name"], item["reserving_class"]) for item in included()],
        )

    def test_the_graph_refresh_keeps_cross_class_precedents_and_links_nothing_locally(self) -> None:
        write_segment_bootstraps(self.data_dir)
        payload = self._export()
        extractors.write_stochastic_consolidation_export(payload, HOST_CLASS, self.rc_dir)
        # A same-named dataset in the host class must not gain the consolidation as a dependent.
        local_name = "F 72 A - Bootstrap Net Incurred with PV"
        (self.rc_dir / "sidecars" / f"{local_name}.json").write_text(
            persisted_json_text({
                "dataset_name": local_name,
                "dataset_type": "F 00 - Ultimate Net Loss",
                "reserving_class": HOST_CLASS,
                "project_name": PROJECT,
                "source_kind": "input",
                "data_format": "Vector",
                "period_length": 12,
                "csv_file": f"{local_name}@12.csv",
                "precedents": [],
                "dependents": [],
            }),
            encoding="utf-8",
        )
        refresh_sidecar_graphs_for_rc(self.rc_dir)
        name = CONSOLIDATION["name"]
        sidecar = json.loads((self.rc_dir / "sidecars" / f"{name}.json").read_text(encoding="utf-8"))
        self.assertEqual(
            [(entry["dataset_name"], entry.get("reserving_class")) for entry in sidecar["precedents"]],
            [(item["method_name"], item["reserving_class"]) for item in included()],
        )
        local = json.loads((self.rc_dir / "sidecars" / f"{local_name}.json").read_text(encoding="utf-8"))
        self.assertEqual(local.get("dependents") or [], [])

    def test_finder_goes_through_the_class_and_checks_the_output(self) -> None:
        consolidation = _Consolidation()
        rc = _ReservingClass([consolidation])
        self.assertIs(
            extractors._find_stochastic_consolidation_for_vector(rc, CONSOLIDATION["name"]), consolidation
        )
        self.assertIsNone(extractors._find_stochastic_consolidation_for_vector(rc, "F 72B - Other"))


class ResQStochasticConsolidationVectorLoopTests(unittest.TestCase):
    """The vector loop defers a consolidation and reports one it could not run."""

    def setUp(self) -> None:
        tmp_root = REPO_ROOT / "test"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.rc_dir = self.data_dir / _encode_rc_folder(HOST_CLASS)
        for folder in ("methods", "datasets", "sidecars"):
            (self.rc_dir / folder).mkdir(parents=True)
        configure_number_formats_path(self.root)
        import resq_data_migration

        self.migration = resq_data_migration
        self._previous_data_dir = resq_data_migration.PROJECT_DATA_DIR
        resq_data_migration.PROJECT_DATA_DIR = self.data_dir
        extractors.configure_extractors(
            project_name=PROJECT,
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.migration.PROJECT_DATA_DIR = self._previous_data_dir
        self.tmp.cleanup()

    def _run(self) -> tuple[tuple[int, int], dict, dict]:
        counts: dict = {}
        state = {"completed": 0, "total": 1}
        result = self.migration._export_stochastic_consolidation_tasks(
            [(CONSOLIDATION["name"], _Consolidation())],
            HOST_CLASS,
            self.rc_dir,
            progress_callback=None,
            progress_state=state,
            method_counts=counts,
            strict_extraction=False,
            verbose=False,
        )
        return result, counts, state

    def test_a_consolidation_over_imported_segments_is_written_consolidated(self) -> None:
        write_segment_bootstraps(self.data_dir)
        result, counts, state = self._run()
        self.assertEqual(result, (1, 0))
        self.assertEqual(counts["scons_written"], 1)
        self.assertNotIn("consolidation_warnings", state)
        written = json.loads(
            (self.rc_dir / "methods" / f"SCON@{CONSOLIDATION['name']}.json").read_text(encoding="utf-8")
        )
        self.assertTrue(written["results_tab"]["input_revision"])

    def test_missing_segments_are_a_warning_not_an_error(self) -> None:
        write_segment_bootstraps(self.data_dir, skip=(segment_path("COL"),))
        result, counts, state = self._run()
        self.assertEqual(result, (1, 0))
        self.assertEqual(counts["scons_written"], 1)
        self.assertNotIn("error_details", state)
        message = state["consolidation_warnings"][0]["message"]
        self.assertIn(f"{segment_path('COL')} / F 72 A - Bootstrap Net incurred with PV", message)

    def test_a_consolidation_coded_vector_without_its_method_imports_as_a_plain_dataset(self) -> None:
        from test_resq_bootstrap_migration import _Vector

        vector = _Vector("Orphan", ["2025", "2026"], [1.0, 2.0], method_type=7)
        payload = extractors.export_vector(vector)
        extractors.write_vector_export(payload, HOST_CLASS, self.rc_dir)
        sidecar = json.loads((self.rc_dir / "sidecars" / "Orphan.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["method_type"], "None")
        self.assertEqual(sidecar["source_kind"], "input")


class ResQCalculatedClassTests(unittest.TestCase):
    """A ResQ calculated class (the Total) imports as an ordinary class with ResQ's values."""

    def setUp(self) -> None:
        tmp_root = REPO_ROOT / "test"
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(tmp_root))
        self.rc_dir = Path(self.tmp.name) / "data" / "Total"
        for folder in ("methods", "datasets", "sidecars"):
            (self.rc_dir / folder).mkdir(parents=True)
        configure_number_formats_path(Path(self.tmp.name))
        extractors.configure_extractors(
            project_name=PROJECT,
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )
        # Treat every type as one the Engine generates, and none as calculated.
        self.patchers = [
            mock.patch.object(catalog, "_is_generated_dataset_type", return_value=True),
            mock.patch.object(extractors, "_is_generated_dataset_type", return_value=True),
            mock.patch.object(catalog, "_is_calculated_dataset_type", return_value=False),
            mock.patch.object(extractors, "_is_calculated_dataset_type", return_value=False),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.tmp.cleanup()

    def test_nothing_is_handed_to_the_engine_inside_a_calculated_class(self) -> None:
        payload = {"name": "Net Loss--Incurred", "dataset_type": "Net Loss--Incurred"}
        self.assertTrue(catalog._is_engine_generated_instance(payload))
        self.assertEqual(catalog._triangle_source_kind(payload["name"], payload["dataset_type"]), "engine")
        with catalog.resq_class_scope(calculated=True):
            self.assertFalse(catalog._is_engine_generated_instance(payload))
            self.assertEqual(catalog._triangle_source_kind(payload["name"], payload["dataset_type"]), "input")
        with catalog.resq_class_scope(calculated=False):
            self.assertTrue(catalog._is_engine_generated_instance(payload))
        self.assertTrue(catalog._is_engine_generated_instance(payload))

    def test_a_calculated_class_vector_keeps_resqs_values_as_input(self) -> None:
        from test_resq_bootstrap_migration import _Vector

        vector = _Vector("Earned Premium", ["2025", "2026"], [10.0, 20.0])
        vector.Formula = '"A\\Earned Premium" + "B\\Earned Premium"'
        with catalog.resq_class_scope(calculated=True):
            payload = extractors.export_vector(vector)
            extractors.write_vector_export(payload, HOST_CLASS, self.rc_dir)
        sidecar = json.loads((self.rc_dir / "sidecars" / "Earned Premium.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["source_kind"], "input")
        self.assertFalse(sidecar["calculated"])
        self.assertEqual(sidecar["precedents"], [])

    def test_the_import_reads_resqs_calculated_flag(self) -> None:
        import resq_data_migration

        self.assertTrue(resq_data_migration._resq_class_is_calculated(_Named("Total", Calculated=True)))
        self.assertFalse(resq_data_migration._resq_class_is_calculated(_Named("COL", Calculated=False)))
        self.assertFalse(resq_data_migration._resq_class_is_calculated(_Named("COL")))


if __name__ == "__main__":
    unittest.main()
