from __future__ import annotations

import importlib.util
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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
        self.catalog = importlib.import_module("resq_migration.catalog")
        self.catalog.configure_catalog(
            server_root=self.root,
            project_name="Demo",
            rs_json_format=self.module.RS_JSON_FORMAT,
            method_data_dir=self.module.METHOD_DATA_DIR,
        )
        self.extractors = importlib.import_module("resq_migration.extractors")
        self.extractors.configure_extractors(
            project_name="Demo",
            rs_json_format=self.module.RS_JSON_FORMAT,
            method_data_dir=self.module.METHOD_DATA_DIR,
        )

        (self.project_dir / "dataset_types.json").write_text(json.dumps({
            "columns": ["Formula", "Generated", "Name", "Calculated", "Data Format", "Category", "Source"],
            "rows": [
                ["", True, "Paid Loss", False, "Triangle", "Loss", ""],
                ["", True, "DFM Ultimate", False, "Vector", "Loss", ""],
                ["", True, "Generated Premium", False, "Vector", "Premium", "Generated_Premium"],
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
        (self.sidecars_dir / "Loaded Ultimate.json").write_text(json.dumps({
            "dataset_name": "Loaded Ultimate",
            "dataset_type": "Loaded Ultimate",
            "source_kind": "calculated",
            "formula": "\"Net Ultimate\" * 1.1",
        }), encoding="utf-8")

        graph = self.catalog._dataset_type_graph_fields("Net Ultimate", self.rc_dir)

        precedents = {item["dataset_type_name"]: item for item in graph["Precedents"]}
        self.assertEqual(set(precedents), {"Paid Loss", "DFM Ultimate"})
        self.assertEqual(precedents["Paid Loss"]["source_kind"], "engine")
        self.assertTrue(precedents["Paid Loss"]["path"].endswith("Paid Loss@12@12@cum@dev.csv"))
        self.assertEqual(precedents["DFM Ultimate"]["source_kind"], "dfm_method")
        self.assertEqual(precedents["DFM Ultimate"]["method_type"], "DFM")
        self.assertEqual(precedents["DFM Ultimate"]["input_path"], dfm_input)

        self.assertEqual(graph["Dependents"][0]["dataset_type_name"], "Loaded Ultimate")
        self.assertEqual(graph["Dependents"][0]["formula"], "\"Net Ultimate\" * 1.1")

    def test_formula_graph_omits_absent_rc_dependents(self) -> None:
        (self.sidecars_dir / "Net Ultimate.json").write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "calculated",
            "formula": "\"Paid Loss\" + \"DFM Ultimate\"",
        }), encoding="utf-8")

        graph = self.catalog._dataset_type_graph_fields("Net Ultimate", self.rc_dir)

        self.assertEqual(graph["Dependents"], [])

    def test_bulk_graph_refresh_scans_physical_inventory_once(self) -> None:
        (self.datasets_dir / "Paid Loss@12@12@cum@dev.csv").write_text(
            "1,2\n",
            encoding="utf-8",
        )
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
        }), encoding="utf-8")
        net_path = self.sidecars_dir / "Net Ultimate.json"
        net_path.write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "calculated",
            "formula": "\"Paid Loss\" + \"DFM Ultimate\"",
        }), encoding="utf-8")
        (self.sidecars_dir / "Loaded Ultimate.json").write_text(json.dumps({
            "dataset_name": "Loaded Ultimate",
            "dataset_type": "Loaded Ultimate",
            "source_kind": "calculated",
            "formula": "\"Net Ultimate\" * 1.1",
        }), encoding="utf-8")

        original_scan = self.catalog._scan_physical_dataset_files
        with mock.patch.object(
            self.catalog,
            "_scan_physical_dataset_files",
            wraps=original_scan,
        ) as scan:
            self.catalog.refresh_sidecar_graphs_for_rc(self.rc_dir)

        self.assertEqual(scan.call_count, 1)
        payload = json.loads(net_path.read_text(encoding="utf-8"))
        self.assertEqual(
            [item["dataset_type_name"] for item in payload["Precedents"]],
            ["Paid Loss", "DFM Ultimate"],
        )
        self.assertEqual(
            [item["dataset_type_name"] for item in payload["Dependents"]],
            ["Loaded Ultimate"],
        )

    def test_deferred_graph_enrichment_is_completed_by_bulk_refresh(self) -> None:
        payload = {
            "name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "category": "Loss",
            "data_format": 1,
            "method_type": "None",
            "method_type_code": 0,
            "origin_length": 12,
            "development_length": 12,
            "origin_count": 1,
            "development_count": 1,
            "origin_labels": ["2026"],
            "development_labels": ["Value"],
            "values": [[123.0]],
            "formula": "\"Paid Loss\" + \"DFM Ultimate\"",
            "user": "tester",
            "created": "2026-01-01T00:00:00",
            "modified": "2026-01-02T00:00:00",
        }

        with self.extractors.defer_sidecar_graph_enrichment():
            self.extractors.write_vector_export(payload, r"Auto\PP", self.rc_dir)

        sidecar_path = self.sidecars_dir / "Net Ultimate.json"
        deferred = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertNotIn("Precedents", deferred)
        self.assertNotIn("Dependents", deferred)

        self.catalog.refresh_sidecar_graphs_for_rc(self.rc_dir)

        refreshed = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(
            [item["dataset_type_name"] for item in refreshed["Precedents"]],
            ["Paid Loss", "DFM Ultimate"],
        )
        self.assertEqual(refreshed["Dependents"], [])

    def test_deferred_graph_enrichment_scope_restores_after_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "stop"):
            with self.extractors.defer_sidecar_graph_enrichment():
                raise RuntimeError("stop")

        with mock.patch.object(
            self.extractors,
            "_apply_sidecar_graph_meta",
            wraps=self.extractors._apply_sidecar_graph_meta,
        ) as apply_graph:
            self.extractors._apply_graph_meta_best_effort(
                {},
                "Paid Loss",
                self.rc_dir,
            )

        self.assertEqual(apply_graph.call_count, 1)

    def test_generated_vector_ignores_resq_formula_metadata(self) -> None:
        self.extractors.write_vector_export({
            "name": "Generated Premium",
            "dataset_type": "Generated Premium",
            "category": "Premium",
            "data_format": 1,
            "method_type": "None",
            "method_type_code": 0,
            "origin_length": 12,
            "development_length": 12,
            "origin_count": 1,
            "development_count": 1,
            "origin_labels": ["2026"],
            "development_labels": ["Value"],
            "values": [[123.0]],
            "formula": '"Some ResQ Source" + 1',
            "user": "tester",
            "created": "2026-01-01T00:00:00",
            "modified": "2026-01-02T00:00:00",
        }, r"Auto\PP", self.rc_dir)

        payload = json.loads((self.sidecars_dir / "Generated Premium.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["source_kind"], "engine")
        self.assertFalse(payload["calculated"])
        self.assertEqual(payload["formula"], "")
        self.assertEqual(payload["period_length"], 12)
        self.assertNotIn("origin_length", payload)
        self.assertNotIn("development_length", payload)
        self.assertNotIn("development_count", payload)
        self.assertNotIn("cumulative", payload)
        self.assertNotIn("calendar", payload)

    def test_result_selection_output_vector_status_is_persisted(self) -> None:
        class OutputVector:
            Name = "Current Selection"
            OriginCount = 1
            PeriodLength = 12
            MethodType = 4
            Status = 2
            User = "tester"
            Created = "2026-01-01T00:00:00"
            Modified = "2026-01-02T00:00:00"
            Formula = ""
            DatasetType = type(
                "DatasetType",
                (),
                {
                    "Name": "Net Ultimate",
                    "DataFormat": 1,
                    "Category": type("Category", (), {"Name": "Loss"})(),
                },
            )()

            def OriginLabel(self, _index):
                return "2026"

            def ValuesByIndex(self, _index):
                return 123.0

        payload = self.extractors.export_vector(OutputVector())
        payload["precedents"] = ["DFM Ultimate"]
        self.extractors.write_vector_export(payload, r"Auto\PP", self.rc_dir)

        sidecar = json.loads(
            (self.sidecars_dir / "Current Selection.json").read_text(encoding="utf-8")
        )
        self.assertEqual(payload["status"], 2)
        self.assertEqual(sidecar["status"], 2)

        index_path = self.catalog.rebuild_dataset_instance_index(
            "Demo", r"Auto\PP", self.rc_dir
        )
        index = json.loads(index_path.read_text(encoding="utf-8"))
        item = next(row for row in index["files"] if row["name"] == "Current Selection")
        self.assertEqual(item["status"], 2)

    def test_dataset_instance_index_uses_only_reserving_class_metadata(self) -> None:
        config_dir = self.root / "config"
        config_dir.mkdir()
        (config_dir / "username_index.json").write_text(json.dumps({
            "users": [
                {"login_name": "xwei", "full_name": "Wei, Xiao"},
            ],
        }), encoding="utf-8")
        csv_path = self.datasets_dir / "Net Ultimate@12.csv"
        csv_path.write_text("1\n", encoding="utf-8")
        (self.sidecars_dir / "Net Ultimate.json").write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "engine",
            "data_format": "Vector",
            "formula": "",
            "user": "xwei",
        }), encoding="utf-8")

        index_path = self.catalog.rebuild_dataset_instance_index("Demo", r"Auto\PP", self.rc_dir)
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        rows = {item["name"]: item for item in payload["files"]}

        self.assertEqual(payload["version"], self.module.INDEX_VERSION)
        self.assertNotIn("formula", rows["Net Ultimate"])
        self.assertNotIn("dataset_category", rows["Net Ultimate"])
        self.assertEqual(rows["Net Ultimate"]["user"], "xwei")

    def test_dfm_ultimate_vector_sidecar_uses_period_length(self) -> None:
        contract = importlib.import_module("arcrho_api.dfm_contract")
        method_payload = contract.recalculate_dfm_method({
            "json format": contract.DFM_JSON_FORMAT,
            "details tab": {
                "name": "Paid DFM",
                "output type": "DFM Ultimate",
                "output dataset": "Ultimate",
                "input triangle": "Paid Loss",
                "origin length": 6,
                "development length": 6,
                "decimal places": 4,
            },
            "data tab": {},
            "ratios tab": {
                "ratio triangle": {"excluded": [[0]]},
                "average formulas": {
                    "label": ["Simple - all"],
                    "custom average formula settings": {
                        "averageType": ["custom"],
                        "base": ["simple"],
                        "periods": ["all"],
                        "exclude": [0],
                    },
                    "selected": [[1]],
                    "values": [[1]],
                    "inputs": [[""]],
                },
                "cell notes": {"ratio main table": {}, "ratio summary table": {}},
            },
            "results tab": {},
            "method metadata": {
                "last modified": "2026-01-02T00:00:00",
                "data refreshed": "2026-01-02T00:00:00",
            },
        }, input_snapshot={
            "name": "Paid Loss",
            "origin_labels": ["2026"],
            "development_labels": ["6m", "12m"],
            "values": [[100.0, 123.0]],
            "mask": [[True, True]],
            "data_format": "Triangle",
            "number_format": "#,##0",
            "decimal_places": 0,
        })
        self.extractors.write_dfm_ultimate_vector_export({
            "name": "Ultimate",
            "dataset_type": "DFM Ultimate",
            "category": "Loss",
            "data_format": 1,
            "method_type": "DFM",
            "method_type_code": 7,
            "origin_length": 6,
            "development_length": 6,
            "origin_count": 1,
            "development_count": 1,
            "origin_labels": ["2026"],
            "development_labels": ["Ultimate"],
            "values": [[123.0]],
            "method_name": "Paid DFM",
            "user": "tester",
            "created": "2026-01-01T00:00:00",
            "modified": "2026-01-02T00:00:00",
        }, r"Auto\PP", self.rc_dir, method_payload=method_payload)

        payload = json.loads((self.sidecars_dir / "Ultimate.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["source_kind"], "dfm")
        self.assertEqual(payload["period_length"], 6)
        self.assertNotIn("origin_length", payload)
        self.assertNotIn("development_length", payload)
        self.assertNotIn("development_count", payload)
        self.assertNotIn("cumulative", payload)
        self.assertNotIn("calendar", payload)

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
        (self.sidecars_dir / "Loaded Ultimate.json").write_text(json.dumps({
            "dataset_name": "Loaded Ultimate",
            "dataset_type": "Loaded Ultimate",
            "source_kind": "calculated",
            "formula": "\"Net Ultimate\" * 1.1",
        }), encoding="utf-8")

        updated = self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(updated, 1)
        self.assertEqual(payload["Precedents"], ["Paid Loss"])
        self.assertEqual(payload["Dependents"][0]["dataset_type_name"], "Loaded Ultimate")

    def test_refresh_preserves_bf_precedents_and_refreshes_method_status(self) -> None:
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
            "updated_at": "2026-07-02T00:00:00Z",
        }), encoding="utf-8")
        path = self.sidecars_dir / "Net Ultimate.json"
        precedents = [
            {"dataset_type_name": "Paid Loss"},
            {"dataset_type_name": "Selected DFM"},
            {"dataset_type_name": "Prior Ultimate"},
        ]
        path.write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "bornhuetter_ferguson",
            "method_type": "Bornhuetter Ferguson",
            "updated_at": "2026-07-01T00:00:00Z",
            "status": 0,
            "Precedents": precedents,
            "Dependents": [],
        }), encoding="utf-8")
        (self.sidecars_dir / "Loaded Ultimate.json").write_text(json.dumps({
            "dataset_name": "Loaded Ultimate",
            "dataset_type": "Loaded Ultimate",
            "source_kind": "calculated",
            "formula": "\"Net Ultimate\" * 1.1",
        }), encoding="utf-8")

        updated = self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(updated, 1)
        self.assertEqual(payload["Precedents"], precedents)
        self.assertEqual(payload["Dependents"][0]["dataset_type_name"], "Loaded Ultimate")
        self.assertEqual(payload["status"], 2)

    def test_fresh_engine_cache_of_unchanged_data_keeps_method_status_ok(self) -> None:
        # An import rewrites every engine cache at import time, so updated_at is
        # always newer than the imported method's ResQ timestamp. Only
        # source_modified (when the data changed in ResQ) may flip an OK method.
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
            "source_modified": "2026-06-15T00:00:00Z",
            "updated_at": "2026-08-03T20:52:00Z",
        }), encoding="utf-8")
        path = self.sidecars_dir / "Net Ultimate.json"
        path.write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "bornhuetter_ferguson",
            "method_type": "Bornhuetter Ferguson",
            "updated_at": "2026-07-01T00:00:00Z",
            "status": 0,
            "Precedents": [{"dataset_type_name": "Paid Loss"}],
            "Dependents": [],
        }), encoding="utf-8")

        self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], 0)

    def test_engine_cache_with_newer_source_data_flips_method_status(self) -> None:
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
            "source_modified": "2026-07-02T00:00:00Z",
            "updated_at": "2026-08-03T20:52:00Z",
        }), encoding="utf-8")
        path = self.sidecars_dir / "Net Ultimate.json"
        path.write_text(json.dumps({
            "dataset_name": "Net Ultimate",
            "dataset_type": "Net Ultimate",
            "source_kind": "bornhuetter_ferguson",
            "method_type": "Bornhuetter Ferguson",
            "updated_at": "2026-07-01T00:00:00Z",
            "status": 0,
            "Precedents": [{"dataset_type_name": "Paid Loss"}],
            "Dependents": [],
        }), encoding="utf-8")

        self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], 2)

    def test_refresh_preserves_imported_needs_review_status_when_precedents_are_current(self) -> None:
        (self.sidecars_dir / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "source_kind": "engine",
            "updated_at": "2026-07-01T00:00:00Z",
        }), encoding="utf-8")
        path = self.sidecars_dir / "Current Selection.json"
        path.write_text(json.dumps({
            "dataset_name": "Current Selection",
            "dataset_type": "Net Ultimate",
            "source_kind": "result_selection",
            "method_type": "Result Selection",
            "updated_at": "2026-07-02T00:00:00Z",
            "status": 2,
            "Precedents": ["Paid Loss"],
            "Dependents": [],
        }), encoding="utf-8")

        self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], 2)

    def test_refresh_adds_result_selection_to_precedent_dependents(self) -> None:
        source_path = self.sidecars_dir / "DFM Ultimate.json"
        source_path.write_text(json.dumps({
            "dataset_name": "DFM Ultimate",
            "dataset_type": "DFM Ultimate",
            "source_kind": "dfm",
            "method_type": "DFM",
            "updated_at": "2026-07-01T14:51:31Z",
            "Precedents": [{"dataset_type_name": "Paid Loss"}],
            "Dependents": [],
        }), encoding="utf-8")
        dependent_path = self.sidecars_dir / "Current Selection.json"
        dependent_path.write_text(json.dumps({
            "dataset_name": "Current Selection",
            "dataset_type": "Loaded Ultimate",
            "source_kind": "result_selection",
            "method_type": "Result Selection",
            "updated_at": "2026-06-18T17:11:12Z",
            "status": 0,
            "Precedents": ["DFM Ultimate"],
            "Dependents": [],
        }), encoding="utf-8")

        updated = self.module.refresh_sidecar_graphs_for_rc(self.rc_dir)

        source_payload = json.loads(source_path.read_text(encoding="utf-8"))
        dependent_payload = json.loads(dependent_path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(updated, 1)
        self.assertEqual(
            [item["dataset_type_name"] for item in source_payload["Dependents"]],
            ["Current Selection"],
        )
        self.assertEqual(dependent_payload["status"], 2)

    def test_result_selection_vector_metadata_uses_method_tab_origin_labels(self) -> None:
        payload = {
            "origin_labels": ["1", "2"],
            "origin_count": 2,
            "precedents": [],
        }
        result_selection_payload = {
            "_sidecar_notes": "selection note",
            "details_tab": {
                "ratio_basis_datasets": ["Earned Premium"],
            },
            "method_tab": {
                "origin_labels": ["2016", "2017", "2018"],
                "loaded_datasets": [
                    {"name": "Paid Loss"},
                    {"name": "Reported Loss"},
                ],
            },
        }

        self.module._apply_result_selection_vector_metadata(payload, result_selection_payload)

        self.assertEqual(payload["origin_labels"], ["2016", "2017", "2018"])
        self.assertEqual(payload["origin_count"], 3)
        self.assertEqual(payload["precedents"], ["Paid Loss", "Reported Loss", "Earned Premium"])
        self.assertEqual(payload["notes"], "selection note")
        self.assertNotIn("_sidecar_notes", result_selection_payload)

    def test_bornhuetter_ferguson_notes_move_to_output_sidecar_metadata(self) -> None:
        payload = {}
        method_payload = {
            "_sidecar_notes": "BF note",
            "method_tab": {
                "latest_dataset": "Paid Loss",
                "dfm_dataset": "Paid Ultimate",
                "prior_datasets": [{"name": "Prior Ultimate"}],
            },
        }

        self.module._apply_bornhuetter_ferguson_vector_metadata(payload, method_payload)

        self.assertEqual(payload["notes"], "BF note")
        self.assertNotIn("_sidecar_notes", method_payload)
        self.assertEqual(payload["precedents"], ["Paid Loss", "Paid Ultimate", "Prior Ultimate"])

    def test_cape_cod_notes_move_to_output_sidecar_metadata(self) -> None:
        payload = {}
        method_payload = {
            "_sidecar_notes": "Cape Cod note",
            "method_tab": {
                "latest_dataset": "Paid Loss",
                "exposure_dataset": "Earned Premium",
                "prior_ultimate_dataset": "Prior Ultimate",
            },
        }

        self.module._apply_cape_cod_vector_metadata(payload, method_payload)

        self.assertEqual(payload["notes"], "Cape Cod note")
        self.assertNotIn("_sidecar_notes", method_payload)
        self.assertEqual(payload["source_kind"], "cape_cod")
        self.assertEqual(payload["method_type"], "Cape Cod")
        self.assertEqual(payload["method_type_code"], self.module.METHOD_TYPE_CAPE_COD_CODE)
        self.assertEqual(payload["precedents"], ["Paid Loss", "Earned Premium", "Prior Ultimate"])

    def test_result_selection_source_payload_includes_native_origin_length(self) -> None:
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
        self.assertEqual(payload["origin_length"], 12)
        self.assertEqual(payload["source_kind"], "input")
        self.assertEqual(payload["weights"], [1, 0])

    def test_export_result_selection_matches_frontend_method_shape(self) -> None:
        class OutputDatasetType:
            Name = "Selected Ultimate"

        class OutputVector:
            Name = "Selected Ultimate"
            Modified = "2026-01-01T00:00:00"
            Status = 2

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
                return origin_index * 10.123456789

            def Weights(self, _dataset_index, _origin_index):
                return 1.987654321

            def Ultimates(self, origin_index, _origin_length):
                return origin_index * 100.123456789

            def UltimateOverridden(self, *, OriginIndex):
                return OriginIndex == 2

            def RatioBasisDataset(self, dataset_index):
                if dataset_index != 1:
                    raise IndexError(dataset_index)
                return type("RatioBasisDataset", (), {"Name": "Earned Premium"})()

            def RatioBasisValues(self, origin_index, _origin_length):
                return origin_index * 1000.123456789

        ResultSelection.OutputVector = OutputVector()

        payload = self.module.export_result_selection(ResultSelection())

        self.assertEqual(payload["_sidecar_status"], 2)
        self.assertEqual(payload["details_tab"]["ratio_basis_datasets"], ["Earned Premium"])
        self.assertEqual(payload["details_tab"]["active_ratio_basis_dataset"], "Earned Premium")
        self.assertNotIn("ratio_basis_dataset", payload["details_tab"])
        self.assertNotIn("ratio_basis", payload["details_tab"])
        self.assertNotIn("dataset_category", payload["details_tab"])
        self.assertNotIn("output_category", payload["details_tab"])
        self.assertNotIn("sources", payload["method_tab"])
        self.assertEqual(payload["method_tab"]["loaded_datasets"][0]["source_kind"], "input")
        self.assertEqual(payload["method_tab"]["loaded_datasets"][0]["origin_length"], 12)
        self.assertEqual(payload["method_tab"]["loaded_datasets"][0]["values"], [10.123457, 20.246914])
        self.assertEqual(payload["method_tab"]["loaded_datasets"][0]["weights"], [1.987654, 1.987654])
        self.assertEqual(payload["method_tab"]["calculated_ultimate"], [10.123457, 20.246914])
        self.assertEqual(payload["method_tab"]["selected_ultimate"], [10.123457, 200.246914])
        self.assertEqual(payload["method_tab"]["ratio_basis_values"], [{
            "name": "Earned Premium",
            "values": [1000.123457, 2000.246914],
        }])
        self.assertEqual(payload["method_tab"]["ultimate_overrides"], [None, 200.246914])

    def test_write_result_selection_export_uses_simplified_method_filename(self) -> None:
        payload = {
            "json_format": self.module.RS_JSON_FORMAT,
            "details_tab": {"name": "C 91 - Current Qtr Indicated"},
            "method_tab": {},
            "_sidecar_notes": "not method JSON",
        }

        path = self.module.write_result_selection_export(
            payload,
            r"PRNJ - PA\PA\All States\Direct Group\COL",
            self.rc_dir,
        )

        self.assertEqual(path.name, "RS@C 91 - Current Qtr Indicated.json")
        self.assertTrue(path.exists())
        self.assertEqual(path.parent, self.methods_dir)
        self.assertNotIn("_sidecar_notes", json.loads(path.read_text(encoding="utf-8")))

    def test_cleanup_target_reserving_class_dir_removes_existing_target_files(self) -> None:
        nested = self.datasets_dir / "nested"
        nested.mkdir()
        (self.datasets_dir / "old.csv").write_text("1\n", encoding="utf-8")
        (self.methods_dir / "old.json").write_text("{}", encoding="utf-8")
        (nested / "old-sidecar.json").write_text("{}", encoding="utf-8")
        lock_path = self.rc_dir / f".{self.module.INDEX_FILE_NAME}.lock"
        lock_path.write_bytes(b"\0")

        files, dirs = self.module.cleanup_target_reserving_class_dir(self.rc_dir)

        self.assertGreaterEqual(files, 3)
        self.assertGreaterEqual(dirs, 4)
        self.assertTrue(self.rc_dir.exists())
        self.assertEqual(list(self.rc_dir.iterdir()), [lock_path])

    def test_cleanup_target_reserving_class_dir_rejects_project_data_dir(self) -> None:
        with self.assertRaises(ValueError):
            self.module.cleanup_target_reserving_class_dir(self.project_dir / "data")

    def test_cleanup_target_dataset_artifacts_removes_selected_dataset_files(self) -> None:
        files = [
            self.datasets_dir / "Selected@12@12@cum@dev.csv",
            self.datasets_dir / "Selected@3.csv",
            self.sidecars_dir / "Selected.json",
            self.methods_dir / "DFM@Selected Method.json",
            self.methods_dir / "RS@Selected.json",
        ]
        for path in files:
            path.write_text("{}", encoding="utf-8")
        (self.methods_dir / "DFM@Output Lookup.json").write_text(json.dumps({
            "details tab": {"name": "Output Lookup", "output dataset": "Selected"},
        }), encoding="utf-8")
        kept = [
            self.datasets_dir / "Other@12@12@cum@dev.csv",
            self.sidecars_dir / "Other.json",
            self.methods_dir / "DFM@Other Method.json",
        ]
        for path in kept:
            path.write_text("{}", encoding="utf-8")

        removed, dirs = self.module.cleanup_target_dataset_artifacts(
            self.rc_dir,
            dataset_names=["Selected"],
            method_names=["Selected Method"],
        )

        self.assertEqual(dirs, 0)
        self.assertEqual(removed, 6)
        for path in files:
            self.assertFalse(path.exists(), path.name)
        self.assertFalse((self.methods_dir / "DFM@Output Lookup.json").exists())
        for path in kept:
            self.assertTrue(path.exists(), path.name)

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

    def test_resq_triangle_inventory_reuses_com_items_and_method_types(self) -> None:
        self_module = self.module

        class ResQItem:
            def __init__(self, name, method_type):
                self.Name = name
                self.MethodType = method_type

        class TriangleCollection:
            def __init__(self):
                self.items = [
                    ResQItem("Paid Loss", self_module.METHOD_TYPE_NONE_CODE),
                    ResQItem("Adjusted Loss", self_module.METHOD_TYPE_BS_SR_CODE),
                ]
                self.item_calls = 0

            def __iter__(self):
                return iter(self.items)

            def Item(self, _name):
                self.item_calls += 1
                raise AssertionError("cached triangle COM objects should be reused")

        class ReservingClass:
            def __init__(self):
                self.triangles = TriangleCollection()

            def Triangles(self):
                return self.triangles

            def Vectors(self):
                return []

            def DFMMethods(self):
                return []

        reserving_class = ReservingClass()
        events = []
        counts = self.module.resq_export_dataset_counts(
            reserving_class,
            run_triangles=True,
            run_vectors=False,
            run_dfms=False,
            progress_callback=events.append,
        )

        self.assertEqual(counts["triangle_names"], ["Paid Loss", "Adjusted Loss"])
        self.assertEqual(counts["bssr_names"], ["Adjusted Loss"])
        self.assertEqual(reserving_class.triangles.item_calls, 0)
        self.assertEqual([event["event"] for event in events], ["activity", "activity"])
        self.assertIs(
            counts["triangle_items"]["paid loss"],
            reserving_class.triangles.items[0],
        )

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
        self.assertTrue((self.datasets_dir / "BF Output@12.csv").exists())

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
        self.assertTrue((self.datasets_dir / "Ultimate@12.csv").exists())
        self.assertTrue((self.methods_dir / "DFM@Paid DFM.json").exists())
        sidecar = json.loads((self.sidecars_dir / "Ultimate.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["source_kind"], "dfm")
        self.assertEqual(sidecar["method_name"], "Paid DFM")
        self.assertEqual(sidecar["period_length"], 12)
        self.assertNotIn("origin_length", sidecar)
        self.assertNotIn("development_length", sidecar)
        self.assertNotIn("development_count", sidecar)
        self.assertNotIn("cumulative", sidecar)
        self.assertNotIn("calendar", sidecar)
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
            return self.datasets_dir / "Ultimate@12.csv"

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
