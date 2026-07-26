from __future__ import annotations

import importlib
import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
_MIGRATION_PATH = Path(__file__).resolve().parents[1] / "migration" / "resq_data_migration.py"


def load_migration_module():
    spec = importlib.util.spec_from_file_location("resq_data_migration_engine_under_test", _MIGRATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load resq_data_migration.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_triangle(name: str, dataset_type: str):
    return types.SimpleNamespace(
        Name=name,
        DatasetType=types.SimpleNamespace(
            Name=dataset_type,
            Category=types.SimpleNamespace(Name="Loss"),
            DataFormat=0,
        ),
    )


class _FakeCollection:
    def __init__(self, items: dict):
        self._items = items

    def Item(self, name):
        return self._items[name]

    def __iter__(self):
        return iter(self._items.values())


class _FakeReservingClass:
    def __init__(self, triangles: dict):
        self._triangles = triangles

    def Triangles(self):
        return _FakeCollection(self._triangles)


class ResqDataMigrationEngineTests(unittest.TestCase):
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
        instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        instances_dir.mkdir(parents=True)
        (instances_dir / "worker.json").write_text("{}", encoding="utf-8")

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
                ["", True, "Paid Loss", False, "Triangle", "Loss", "PaidLoss"],
                ["", True, "Generated Premium", False, "Vector", "Premium", "Prem"],
                ["\"Paid Loss\" * 1.1", False, "Loaded Loss", True, "Triangle", "Loss", ""],
            ],
        }), encoding="utf-8")

        self.provenance = {
            "config_hash": "sha256:deadbeef",
            "algorithm_version": "arcrho-data-processing-v1",
            "rules_format": "arcrho-data-processing-rules-v1",
            "rules_revision": 4,
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # -- gate -----------------------------------------------------------------

    def test_gate_true_for_generated_instance_named_as_type(self) -> None:
        self.assertTrue(
            self.module._is_engine_generated_instance(
                {"name": "Paid Loss", "dataset_type": "Paid Loss"}
            )
        )

    def test_gate_false_when_instance_name_differs_from_type(self) -> None:
        self.assertFalse(
            self.module._is_engine_generated_instance(
                {"name": "Paid Loss AY2020", "dataset_type": "Paid Loss"}
            )
        )

    def test_gate_false_for_non_generated_type(self) -> None:
        self.assertFalse(
            self.module._is_engine_generated_instance(
                {"name": "Loaded Loss", "dataset_type": "Loaded Loss"}
            )
        )

    # -- sidecar writer -------------------------------------------------------

    def test_engine_triangle_sidecar_shape_and_provenance(self) -> None:
        csv_name = "Paid Loss@12@6@cum@dev.csv"
        csv_path = self.datasets_dir / csv_name
        csv_path.write_text("1,2\n3,4\n", encoding="utf-8")
        self.extractors.write_engine_generated_export(
            {
                "name": "Paid Loss",
                "dataset_type": "Paid Loss",
                "category": "Loss",
                "data_format": 0,
                "origin_length": 12,
                "development_length": 6,
                "origin_labels": ["2025", "2026"],
                "user": "tester",
                "created": "2026-01-01T00:00:00",
                "modified": "2026-01-02T00:00:00",
            },
            r"Auto\PP",
            self.rc_dir,
            is_vector=False,
            provenance=self.provenance,
            csv_name=csv_name,
            csv_path=csv_path,
        )
        payload = json.loads((self.sidecars_dir / "Paid Loss.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["source_kind"], "engine")
        self.assertNotIn("source", payload)  # no resq_* marker -> not an imported snapshot
        self.assertFalse(payload["calculated"])
        self.assertEqual(payload["formula"], "")
        self.assertEqual(payload["data_format"], "Triangle")
        self.assertEqual(payload["origin_length"], 12)
        self.assertEqual(payload["development_length"], 6)
        self.assertTrue(payload["cumulative"])
        self.assertFalse(payload["calendar"])
        self.assertEqual(payload["status"], 0)
        self.assertEqual(payload["method_type"], "None")
        self.assertNotIn("origin_labels", payload)  # engine determines shape
        self.assertEqual(payload["csv_file"], csv_name)
        self.assertEqual(payload["processing"], self.provenance)
        self.assertEqual(payload["processing_by_csv"], {csv_name: self.provenance})
        self.assertEqual(payload["audit_log"][0]["action"], "Insert")

    def test_engine_vector_sidecar_uses_period_length(self) -> None:
        csv_name = "Generated Premium@6.csv"
        csv_path = self.datasets_dir / csv_name
        csv_path.write_text("10\n", encoding="utf-8")
        self.extractors.write_engine_generated_export(
            {
                "name": "Generated Premium",
                "dataset_type": "Generated Premium",
                "category": "Premium",
                "data_format": 1,
                "origin_length": 6,
                "development_length": 6,
                "period_length": 6,
                "user": "tester",
            },
            r"Auto\PP",
            self.rc_dir,
            is_vector=True,
            provenance=self.provenance,
            csv_name=csv_name,
            csv_path=csv_path,
        )
        payload = json.loads((self.sidecars_dir / "Generated Premium.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["source_kind"], "engine")
        self.assertEqual(payload["data_format"], "Vector")
        self.assertEqual(payload["period_length"], 6)
        self.assertNotIn("origin_length", payload)
        self.assertNotIn("development_length", payload)
        self.assertNotIn("cumulative", payload)
        self.assertEqual(payload["processing_by_csv"][csv_name]["config_hash"], "sha256:deadbeef")

    # -- orchestration: period preservation + no fallback ---------------------

    def test_generated_dataset_orchestration_preserves_periods(self) -> None:
        payload = {
            "name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "category": "Loss",
            "data_format": 0,
            "origin_length": 24,
            "development_length": 18,
            "user": "tester",
        }
        task = self.module._create_engine_generated_task(
            payload,
            r"Auto\PP",
            self.rc_dir,
            is_vector=False,
        )
        job = task["job"]

        self.assertEqual(job.payload["OriginLength"], 24)
        self.assertEqual(job.payload["DevelopmentLength"], 18)
        self.assertEqual(job.payload["Function"], "ArcRhoTri")
        self.assertEqual(job.target_path.name, "Paid Loss@24@18@cum@dev.csv")

    def test_engine_failure_records_error_without_resq_fallback(self) -> None:
        write_calls = []

        def _boom(_job, **_kwargs):
            raise RuntimeError("engine down")

        self.module.publish_engine_request = _boom
        self.module.write_triangle_export = lambda *a, **k: write_calls.append(a)
        rc = _FakeReservingClass({"Paid Loss": _fake_triangle("Paid Loss", "Paid Loss")})
        self.module.export_triangle = lambda *_args, **_kwargs: self.fail(
            "engine-owned datasets must not extract ResQ cell values"
        )

        progress_state = {"completed": 0, "total": 1}
        written, errors = self.module.export_triangles_for_rc(
            rc,
            r"Auto\PP",
            self.rc_dir,
            progress_state=progress_state,
            triangle_names=["Paid Loss"],
            engine_provenance=self.provenance,
            verbose=False,
        )

        self.assertEqual((written, errors), (0, 1))
        self.assertEqual(write_calls, [])  # no ResQ fallback write
        self.assertFalse(any(self.datasets_dir.glob("Paid Loss@*.csv")))

    def test_generated_requests_are_all_published_before_waiting(self) -> None:
        rc = _FakeReservingClass({
            "Paid Loss": _fake_triangle("Paid Loss", "Paid Loss"),
            "Generated Premium": _fake_triangle("Generated Premium", "Generated Premium"),
        })
        published = []
        waited = []
        preflight_roots = []

        def publish(job, *, check_workers=True):
            self.assertFalse(check_workers)
            published.append(job)
            job.output_path.parent.mkdir(parents=True, exist_ok=True)
            job.output_path.write_text("1,2\n", encoding="utf-8")
            return job.request_path

        def wait(job, **_kwargs):
            self.assertEqual(len(published), 2)
            waited.append(job)
            return job.output_path

        self.module.publish_engine_request = publish
        self.module.wait_for_engine_request = wait
        self.module.require_running_engine_instances = (
            lambda root: preflight_roots.append(Path(root)) or (Path("worker.json"),)
        )
        self.module.export_triangle = lambda *_args, **_kwargs: self.fail(
            "engine-owned datasets must not extract ResQ cell values"
        )

        written, errors = self.module.export_triangles_for_rc(
            rc,
            r"Auto\PP",
            self.rc_dir,
            triangle_names=["Paid Loss", "Generated Premium"],
            engine_provenance=self.provenance,
            verbose=False,
        )

        self.assertEqual((written, errors), (2, 0))
        self.assertEqual(len(published), 2)
        self.assertEqual(len(waited), 2)
        self.assertEqual(preflight_roots, [self.root])
        self.assertTrue((self.datasets_dir / "Paid Loss@12@12@cum@dev.csv").is_file())

    def test_generated_vector_skips_resq_value_extraction(self) -> None:
        vector = types.SimpleNamespace(
            Name="Generated Premium",
            DatasetType=types.SimpleNamespace(
                Name="Generated Premium",
                Category=types.SimpleNamespace(Name="Premium"),
                DataFormat=1,
            ),
            MethodType=0,
            PeriodLength=6,
        )
        reserving_class = types.SimpleNamespace(
            Vectors=lambda: _FakeCollection({"Generated Premium": vector}),
        )

        def publish(job, *, check_workers=True):
            self.assertFalse(check_workers)
            job.output_path.parent.mkdir(parents=True, exist_ok=True)
            job.output_path.write_text("10\n", encoding="utf-8")
            return job.request_path

        self.module.publish_engine_request = publish
        self.module.wait_for_engine_request = lambda job, **_kwargs: job.output_path
        self.module.export_vector = lambda *_args, **_kwargs: self.fail(
            "engine-owned vectors must not extract ResQ values"
        )

        written, errors = self.module.export_vectors_for_rc(
            reserving_class,
            r"Auto\PP",
            self.rc_dir,
            vector_names=["Generated Premium"],
            engine_provenance=self.provenance,
            verbose=False,
        )

        self.assertEqual((written, errors), (1, 0))
        self.assertTrue((self.datasets_dir / "Generated Premium@6.csv").is_file())

    def test_no_engine_worker_stops_before_resq_import(self) -> None:
        error = self.module.EngineUnavailableError("no workers")
        with (
            patch.object(
                self.module,
                "require_running_engine_instances",
                side_effect=error,
            ),
            self.assertRaises(self.module.EngineUnavailableError),
        ):
            self.module.import_reserving_class_from_resq(
                "Demo",
                r"Auto\PP",
                server_root=self.root,
                verbose=False,
            )

    def test_interrupted_import_rebuilds_index_after_mutation_started(self) -> None:
        reserving_class = object()
        project = types.SimpleNamespace(
            ReservingClasses=lambda: types.SimpleNamespace(
                Item=lambda _path: reserving_class
            )
        )
        application = types.SimpleNamespace(
            ConnectByName=Mock(),
            Projects=lambda: types.SimpleNamespace(Item=lambda _name: project),
            Disconnect=Mock(),
        )
        client_module = types.ModuleType("win32com.client")
        client_module.Dispatch = Mock(return_value=application)
        win32com_module = types.ModuleType("win32com")
        win32com_module.client = client_module
        rebuild = Mock()

        with (
            patch.dict(
                "sys.modules",
                {
                    "win32com": win32com_module,
                    "win32com.client": client_module,
                },
            ),
            patch.object(
                self.module,
                "require_running_engine_instances",
                return_value=(Path("worker.json"),),
            ),
            patch.object(
                self.module,
                "get_engine_processing_provenance",
                return_value=self.provenance,
            ),
            patch.object(
                self.module,
                "_selected_exports",
                return_value=(True, False, False),
            ),
            patch.object(
                self.module,
                "resq_export_dataset_counts",
                return_value={
                    "total": 1,
                    "triangles": 1,
                    "vectors": 0,
                    "dfms": 0,
                    "methods": 0,
                    "triangle_names": ["Paid Loss"],
                },
            ),
            patch.object(
                self.module,
                "export_triangles_for_rc",
                side_effect=RuntimeError("export interrupted"),
            ),
            patch.object(
                self.module,
                "rebuild_dataset_instance_index",
                rebuild,
            ),
            self.assertRaisesRegex(RuntimeError, "export interrupted"),
        ):
            self.module.import_reserving_class_from_resq(
                "Demo",
                r"Auto\PP",
                server_root=self.root,
                cleanup_target=False,
                verbose=False,
            )

        rebuild.assert_called_once_with("Demo", r"Auto\PP", self.rc_dir)
        application.Disconnect.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
