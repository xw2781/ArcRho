from __future__ import annotations

import importlib
import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path


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
            index_file_name=self.module.INDEX_FILE_NAME,
            index_version=self.module.INDEX_VERSION,
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
        calls = {}

        def _fake_generate(**kwargs):
            Path(kwargs["data_path"]).write_text("1,2\n", encoding="utf-8")
            calls.update(kwargs)

        self.module.generate_engine_csv = _fake_generate
        self.module.get_engine_processing_provenance = lambda project: self.provenance

        payload = {
            "name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "category": "Loss",
            "data_format": 0,
            "origin_length": 24,
            "development_length": 18,
            "user": "tester",
        }
        self.module._write_engine_generated_dataset(payload, r"Auto\PP", self.rc_dir, is_vector=False)

        # ResQ period configuration is passed through to the engine unchanged.
        self.assertEqual(calls["origin_length"], 24)
        self.assertEqual(calls["development_length"], 18)
        self.assertEqual(calls["is_vector"], False)
        self.assertTrue((self.datasets_dir / "Paid Loss@24@18@cum@dev.csv").is_file())
        self.assertTrue((self.sidecars_dir / "Paid Loss.json").is_file())

    def test_engine_failure_records_error_without_resq_fallback(self) -> None:
        write_calls = []

        def _boom(*_args, **_kwargs):
            raise self.module.EngineGenerationError("engine down")

        self.module._write_engine_generated_dataset = _boom
        self.module.write_triangle_export = lambda *a, **k: write_calls.append(a)

        rc = _FakeReservingClass({"Paid Loss": _fake_triangle("Paid Loss", "Paid Loss")})
        self.module.export_triangle = lambda _triangle: {
            "name": "Paid Loss",
            "dataset_type": "Paid Loss",
            "origin_length": 12,
            "development_length": 12,
            "values": [[1]],
            "user": "tester",
        }

        progress_state = {"completed": 0, "total": 1}
        written, errors = self.module.export_triangles_for_rc(
            rc,
            r"Auto\PP",
            self.rc_dir,
            progress_state=progress_state,
            triangle_names=["Paid Loss"],
            verbose=False,
        )

        self.assertEqual((written, errors), (0, 1))
        self.assertEqual(write_calls, [])  # no ResQ fallback write
        self.assertFalse(any(self.datasets_dir.glob("Paid Loss@*.csv")))


if __name__ == "__main__":
    unittest.main()
