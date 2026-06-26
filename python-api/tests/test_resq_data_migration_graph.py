from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
_MIGRATION_PATH = Path(__file__).resolve().parents[1] / "migration" / "resq_data_migration.py"


def load_migration_module():
    spec = importlib.util.spec_from_file_location("resq_data_migration_under_test", _MIGRATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load resq_data_migration.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResqDataMigrationGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.root = Path(self.tmp.name) / "ArcRho Server"
        self.project_dir = self.root / "projects" / "Demo"
        self.rc_dir = self.project_dir / "data" / "Auto_%5C_PP"
        self.datasets_dir = self.rc_dir / "datasets"
        self.methods_dir = self.rc_dir / "methods"
        self.sidecars_dir = self.rc_dir / "sidecars"
        self.datasets_dir.mkdir(parents=True)
        self.methods_dir.mkdir()
        self.sidecars_dir.mkdir()

        self.module = load_migration_module()
        self.module.SERVER_ROOT = self.root
        self.module.PROJECT_NAME = "Demo"
        self.module.PROJECT_DATA_DIR = self.project_dir / "data"

        (self.project_dir / "dataset_types.json").write_text(json.dumps({
            "columns": ["Formula", "Generated", "Name", "Calculated", "Data Format", "Category", "Source"],
            "rows": [
                ["", True, "Paid Loss", False, "Triangle", "Loss", ""],
                ["", True, "DFM Ultimate", False, "Vector", "Loss", ""],
                ["\"Paid Loss\" + \"DFM Ultimate\"", False, "Net Ultimate", True, "Vector", "Loss", ""],
                ["\"Net Ultimate\" * 1.1", False, "Loaded Ultimate", True, "Vector", "Loss", ""],
            ],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_formula_graph_fields_include_resolved_dependency_info(self) -> None:
        paid_csv = self.datasets_dir / "Paid Loss@12@12@cum@dev.csv"
        paid_csv.write_text("1,2\n", encoding="utf-8")
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
            "formula": "",
        }), encoding="utf-8")
        dfm_path = self.methods_dir / "DFM@Selected DFM.json"
        dfm_input = str(self.datasets_dir / "Paid Loss@12@12@cum@dev.csv")
        dfm_path.write_text(json.dumps({
            "json format": self.module.DFM_JSON_FORMAT,
            "details tab": {"name": "Selected DFM", "output type": "DFM Ultimate"},
            "data tab": {"input data triangle csv path": dfm_input},
        }), encoding="utf-8")

        graph = self.module._dataset_type_graph_fields("Net Ultimate", self.rc_dir)

        precedents = {item["dataset_type_name"]: item for item in graph["Precedents"]}
        self.assertEqual(set(precedents), {"Paid Loss", "DFM Ultimate"})
        self.assertEqual(precedents["Paid Loss"]["source_kind"], "engine")
        self.assertTrue(precedents["Paid Loss"]["path"].endswith("Paid Loss@12@12@cum@dev.csv"))
        self.assertEqual(precedents["DFM Ultimate"]["source_kind"], "dfm_method")
        self.assertEqual(precedents["DFM Ultimate"]["method_type"], "DFM")
        self.assertEqual(precedents["DFM Ultimate"]["input_path"], dfm_input)

        self.assertEqual(graph["Dependents"][0]["dataset_type_name"], "Loaded Ultimate")
        self.assertEqual(graph["Dependents"][0]["formula"], "\"Net Ultimate\" * 1.1")

    def test_refresh_preserves_result_selection_precedent_strings(self) -> None:
        path = self.sidecars_dir / "Net Ultimate.json"
        path.write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "result_selection",
            "method_type": "Result Selection",
            "Precedents": ["Paid Loss"],
            "Dependents": [],
        }), encoding="utf-8")

        updated = self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(updated, 1)
        self.assertEqual(payload["Precedents"], ["Paid Loss"])
        self.assertEqual(payload["Dependents"][0]["dataset_type_name"], "Loaded Ultimate")

    def test_result_selection_vector_metadata_uses_method_tab_origin_labels(self) -> None:
        payload = {
            "origin_labels": ["1", "2"],
            "origin_count": 2,
            "precedents": [],
        }
        result_selection_payload = {
            "method_tab": {
                "origin_labels": ["2016", "2017", "2018"],
                "sources": [
                    {"name": "Paid Loss"},
                    {"name": "Reported Loss"},
                ],
            },
        }

        self.module._apply_result_selection_vector_metadata(payload, result_selection_payload)

        self.assertEqual(payload["origin_labels"], ["2016", "2017", "2018"])
        self.assertEqual(payload["origin_count"], 3)
        self.assertEqual(payload["precedents"], ["Paid Loss", "Reported Loss"])

    def test_result_selection_source_payload_omits_redundant_source_metadata(self) -> None:
        class DatasetType:
            Name = "Paid Loss"
            DataFormat = 1
            Category = type("Category", (), {"Name": "Loss"})()

        class Dataset:
            Name = "Paid Loss"
            MethodType = 0

        Dataset.DatasetType = DatasetType()

        class ResultSelection:
            def Dataset(self, _dataset_index):
                return Dataset()

            def DatasetValues(self, _dataset_index, origin_index, _origin_length):
                return origin_index * 10

            def Weights(self, _dataset_index, origin_index):
                return 1 if origin_index == 1 else 0

        payload = self.module._result_selection_source_payload(ResultSelection(), 1, 2, 12)

        self.assertNotIn("selected", payload)
        self.assertNotIn("value_source", payload)
        self.assertEqual(payload["weights"], [1, 0])

    def test_export_result_selection_includes_ratio_basis_dataset(self) -> None:
        class OutputDatasetType:
            Name = "Selected Ultimate"

        class OutputVector:
            Name = "Selected Ultimate"
            Modified = "2026-01-01T00:00:00"

        OutputVector.DatasetType = OutputDatasetType()

        class SourceDatasetType:
            Name = "Paid Loss"
            DataFormat = 1
            Category = type("Category", (), {"Name": "Loss"})()

        class SourceDataset:
            Name = "Paid Loss"
            MethodType = 0

        SourceDataset.DatasetType = SourceDatasetType()

        class ResultSelection:
            OriginLength = 12
            OriginCount = 2
            DatasetCount = 1
            Notes = ""

            def OriginLabel(self, origin_index):
                return str(2015 + origin_index)

            def Dataset(self, _dataset_index):
                return SourceDataset()

            def DatasetValues(self, _dataset_index, origin_index, _origin_length):
                return origin_index * 10

            def Weights(self, _dataset_index, _origin_index):
                return 1

            def Ultimates(self, origin_index, _origin_length):
                return origin_index * 100

            def RatioBasisDataset(self, dataset_index):
                if dataset_index != 1:
                    raise IndexError(dataset_index)
                return type("RatioBasisDataset", (), {"Name": "Earned Premium"})()

        ResultSelection.OutputVector = OutputVector()

        payload = self.module.export_result_selection(ResultSelection())

        self.assertEqual(payload["details_tab"]["ratio_basis_dataset"], "Earned Premium")
        self.assertEqual(payload["details_tab"]["ratio_basis"], "Earned Premium")
        self.assertEqual(payload["method_tab"]["ratio_basis_values"], [])

    def test_write_result_selection_export_uses_simplified_method_filename(self) -> None:
        payload = {
            "json_format": self.module.RS_JSON_FORMAT,
            "details_tab": {"name": "C 91 - Current Qtr Indicated"},
            "method_tab": {},
        }

        path = self.module.write_result_selection_export(
            payload,
            r"PRNJ - PA\PA\All States\Direct Group\COL",
            self.rc_dir,
        )

        self.assertEqual(path.name, "RS@C 91 - Current Qtr Indicated.json")
        self.assertTrue(path.exists())
        self.assertEqual(path.parent, self.methods_dir)

    def test_cleanup_target_reserving_class_dir_removes_existing_target_files(self) -> None:
        nested = self.datasets_dir / "nested"
        nested.mkdir()
        (self.datasets_dir / "old.csv").write_text("1\n", encoding="utf-8")
        (self.methods_dir / "old.json").write_text("{}", encoding="utf-8")
        (nested / "old-sidecar.json").write_text("{}", encoding="utf-8")

        files, dirs = self.module.cleanup_target_reserving_class_dir(self.rc_dir)

        self.assertGreaterEqual(files, 3)
        self.assertGreaterEqual(dirs, 4)
        self.assertFalse(self.rc_dir.exists())

    def test_cleanup_target_reserving_class_dir_rejects_project_data_dir(self) -> None:
        with self.assertRaises(ValueError):
            self.module.cleanup_target_reserving_class_dir(self.project_dir / "data")

    def test_cleanup_target_flag_defaults_on_and_can_be_disabled(self) -> None:
        self.assertTrue(self.module._parse_args([]).cleanup_target)
        self.assertFalse(self.module._parse_args(["--no-cleanup-target"]).cleanup_target)
        self.assertTrue(self.module._parse_args(["--cleanup-target"]).cleanup_target)

    def test_default_rc_path_list_is_hardcoded_from_resq_path_workbook(self) -> None:
        self.assertEqual(len(self.module.RC_PATH), 12)
        self.assertEqual(self.module.RC_PATH[0], r"PRNJ - PA\PA\NY\Direct Group\BI Total")
        self.assertEqual(self.module.RC_PATH[-1], r"HPPREF\HO+DF\NJ\Legacy\HOPxCAT")

    def test_configured_rc_paths_accepts_string_or_list(self) -> None:
        self.assertEqual(self.module._configured_rc_paths(r"Auto\PP"), [r"Auto\PP"])
        self.assertEqual(
            self.module._configured_rc_paths(["", r"Auto\PP", r"Auto\COL", r"auto\pp"]),
            [r"Auto\PP", r"Auto\COL"],
        )

    def test_resq_export_counts_use_triangle_and_vector_total(self) -> None:
        self_module = self.module

        class ResQItem:
            def __init__(self, name, method_type=0):
                self.Name = name
                self.MethodType = method_type

        class ReservingClass:
            def Triangles(self):
                return [ResQItem("Paid Loss"), ResQItem("Reported Loss")]

            def Vectors(self):
                return [
                    ResQItem("Selected Ultimate", self_module.METHOD_TYPE_RESULT_SELECTION_CODE),
                    ResQItem("Manual Ultimate", self_module.METHOD_TYPE_NONE_CODE),
                    ResQItem("DFM Output", self_module.METHOD_TYPE_DFM_CODE),
                ]

            def DFMMethods(self):
                return [ResQItem("Paid DFM"), ResQItem("Reported DFM")]

        original_dfm_names = list(self.module.DFM_NAMES)
        try:
            self.module.DFM_NAMES = []
            counts = self.module.resq_export_dataset_counts(
                ReservingClass(),
                run_triangles=True,
                run_vectors=True,
                run_dfms=True,
            )
        finally:
            self.module.DFM_NAMES = original_dfm_names

        self.assertEqual(counts["triangles"], 2)
        self.assertEqual(counts["vectors"], 3)
        self.assertEqual(counts["dfms"], 2)
        self.assertEqual(counts["methods"], 2)
        self.assertEqual(counts["total"], 5)
        self.assertEqual(counts["dfm_names"], ["Paid DFM", "Reported DFM"])

    def test_export_unsupported_method_vector_as_dataset(self) -> None:
        self_module = self.module

        class DatasetType:
            Name = "BF Output"
            DataFormat = 1

        class Vector:
            Name = "BF Output"
            MethodType = 2
            OriginLength = 12
            DevelopmentLength = 12
            OriginCount = 1
            User = ""
            Created = ""
            Modified = ""
            Formula = ""

            def __init__(self):
                self.DatasetType = DatasetType()

            def Value(self, _index):
                return 123.0

            def OriginLabel(self, _index):
                return "2025"

        class VectorCollection:
            def __init__(self):
                self.items = {"BF Output": Vector()}

            def __iter__(self):
                return iter(self.items.values())

            def Item(self, name):
                return self.items[name]

        class ReservingClass:
            def __init__(self):
                self.collection = VectorCollection()

            def Vectors(self):
                return self.collection

        progress_state = {"completed": 0, "total": 1}
        events = []
        written, errors = self_module.export_vectors_for_rc(
            ReservingClass(),
            r"Auto\PP",
            self.rc_dir,
            progress_callback=events.append,
            progress_state=progress_state,
            vector_names=["BF Output"],
            verbose=False,
        )

        self.assertEqual((written, errors), (1, 0))
        self.assertEqual(progress_state, {"completed": 1, "total": 1})
        sidecar = self.sidecars_dir / "BF Output.json"
        self.assertTrue(sidecar.exists())
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(payload["source_kind"], "input")
        self.assertEqual(payload["method_type"], "BF")
        self.assertEqual(payload["method_type_code"], 2)
        self.assertTrue((self.datasets_dir / "BF Output@12@12@cum@dev.csv").exists())

    def test_export_dfm_method_with_matching_vector_progress_tick(self) -> None:
        self_module = self.module

        class DatasetType:
            Name = "DFM Ultimate"
            DataFormat = 1

        class Vector:
            Name = "Ultimate"
            MethodType = self_module.METHOD_TYPE_DFM_CODE
            OriginLength = 12
            DevelopmentLength = 12
            OriginCount = 1

            def __init__(self):
                self.DatasetType = DatasetType()

        class VectorCollection:
            def __init__(self):
                self.items = {"Ultimate": Vector()}

            def __iter__(self):
                return iter(self.items.values())

            def Item(self, name):
                return self.items[name]

        class Dfm:
            Name = "Paid DFM"

            def __init__(self):
                self.OutputVector = Vector()

        class DfmCollection:
            def __init__(self):
                self.items = {"Paid DFM": Dfm()}

            def __iter__(self):
                return iter(self.items.values())

            def Item(self, name):
                return self.items[name]

        class ReservingClass:
            def __init__(self):
                self.vectors = VectorCollection()
                self.dfms = DfmCollection()

            def Vectors(self):
                return self.vectors

            def DFMMethods(self):
                return self.dfms

        def fake_export_dfm(dfm, _rc_path):
            return {
                "json format": self_module.DFM_JSON_FORMAT,
                "details tab": {
                    "name": dfm.Name,
                    "input triangle": "Paid Loss",
                    "origin length": 12,
                    "development length": 12,
                    "output type": "Ultimate",
                },
                "data tab": {
                    "origin labels": ["2020"],
                    "input data triangle csv path": "",
                },
                "results tab": {},
                "notes tab": {},
                "method metadata": {},
            }

        def fake_export_dfm_ultimate_vector(*_args, **_kwargs):
            return {
                "name": "Ultimate",
                "dataset_type": "DFM Ultimate",
                "data_format": 1,
                "method_type": "DFM",
                "method_type_code": self_module.METHOD_TYPE_DFM_CODE,
                "origin_length": 12,
                "development_length": 12,
                "origin_count": 1,
                "development_count": 1,
                "origin_labels": ["2020"],
                "development_labels": ["Ultimate"],
                "values": [[123.0]],
                "method_name": "Paid DFM",
            }

        original_export_dfm = self.module.export_dfm
        original_export_dfm_ultimate_vector = self.module.export_dfm_ultimate_vector
        try:
            self.module.export_dfm = fake_export_dfm
            self.module.export_dfm_ultimate_vector = fake_export_dfm_ultimate_vector
            progress_state = {"completed": 0, "total": 1}
            method_counts = {"dfms_written": 0}
            events = []

            written, errors = self_module.export_vectors_for_rc(
                ReservingClass(),
                r"Auto\PP",
                self.rc_dir,
                progress_callback=events.append,
                progress_state=progress_state,
                vector_names=["Ultimate"],
                include_dfm_methods=True,
                dfm_names=["Paid DFM"],
                method_counts=method_counts,
                verbose=False,
            )
        finally:
            self.module.export_dfm = original_export_dfm
            self.module.export_dfm_ultimate_vector = original_export_dfm_ultimate_vector

        self.assertEqual((written, errors), (1, 0))
        self.assertEqual(progress_state, {"completed": 1, "total": 1})
        self.assertEqual(method_counts["dfms_written"], 1)
        self.assertTrue((self.datasets_dir / "Ultimate@12@12@cum@dev.csv").exists())
        self.assertTrue((self.methods_dir / "DFM@Paid DFM.json").exists())
        sidecar = json.loads((self.sidecars_dir / "Ultimate.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["source_kind"], "dfm")
        self.assertEqual(sidecar["method_name"], "Paid DFM")
        self.assertFalse([event for event in events if event.get("event") == "method"])
        finished = [event for event in events if event.get("event") == "finish"]
        self.assertEqual(finished[-1]["name"], "Ultimate")
        self.assertEqual(finished[-1]["completed"], 1)

    def test_export_dfms_do_not_advance_shared_dataset_progress(self) -> None:
        class Dfm:
            def __init__(self, name):
                self.Name = name

        class DfmCollection:
            def __init__(self):
                self.items = {name: Dfm(name) for name in ("Paid DFM", "Reported DFM")}

            def __iter__(self):
                return iter(self.items.values())

            def Item(self, name):
                return self.items[name]

        class ReservingClass:
            def __init__(self):
                self.collection = DfmCollection()

            def DFMMethods(self):
                return self.collection

        def fake_export_dfm(dfm, _rc_path):
            return {
                "details tab": {
                    "name": dfm.Name,
                    "input triangle": "Paid Loss",
                    "origin length": 12,
                    "development length": 12,
                    "output type": "Ultimate",
                },
                "data tab": {
                    "origin labels": ["2020"],
                    "input data triangle csv path": "",
                },
                "results tab": {},
            }

        def fake_export_dfm_ultimate_vector(*_args, **_kwargs):
            return {"name": "Ultimate"}

        def fake_write_dfm_ultimate_vector_export(*_args, **_kwargs):
            return self.datasets_dir / "Ultimate@12@12@cum@dev.csv"

        original_export_dfm = self.module.export_dfm
        original_export_dfm_ultimate_vector = self.module.export_dfm_ultimate_vector
        original_write_dfm_ultimate_vector_export = self.module.write_dfm_ultimate_vector_export
        try:
            self.module.export_dfm = fake_export_dfm
            self.module.export_dfm_ultimate_vector = fake_export_dfm_ultimate_vector
            self.module.write_dfm_ultimate_vector_export = fake_write_dfm_ultimate_vector_export
            progress_state = {"completed": 4, "total": 4, "count_methods": False}
            events = []

            written, errors = self.module.export_dfms_for_rc(
                ReservingClass(),
                r"Auto\PP",
                self.rc_dir,
                progress_callback=events.append,
                progress_state=progress_state,
                dfm_names=["Paid DFM", "Reported DFM"],
                verbose=False,
            )
        finally:
            self.module.export_dfm = original_export_dfm
            self.module.export_dfm_ultimate_vector = original_export_dfm_ultimate_vector
            self.module.write_dfm_ultimate_vector_export = original_write_dfm_ultimate_vector_export

        self.assertEqual((written, errors), (2, 0))
        self.assertEqual(progress_state, {"completed": 4, "total": 4, "count_methods": False})
        finished = [event for event in events if event.get("event") == "method" and event.get("status") == "success"]
        self.assertEqual([event["completed"] for event in finished], [4, 4])
        self.assertEqual([event["total"] for event in finished], [4, 4])
        self.assertEqual([event["dataset_name"] for event in finished], ["Ultimate", "Ultimate"])


if __name__ == "__main__":
    unittest.main()
