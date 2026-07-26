import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_ROOT = PYTHON_API_ROOT / "migration"
if str(MIGRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(MIGRATION_ROOT))

number_formats = importlib.import_module("resq_migration.number_formats")
extractors = importlib.import_module("resq_migration.extractors")


class ResqNumberFormatPreferencesTests(unittest.TestCase):
    def test_migration_reads_the_shared_type_mapping_for_every_reserving_class(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(PYTHON_API_ROOT)) as temp_dir:
            path = Path(temp_dir) / "dataset_number_formats.json"
            path.write_text(json.dumps({
                "json_format": "arcrho.dataset-number-formats.v1",
                "default_number_format": "0,000.00",
                "overrides": [{
                    "dataset_type_name": "Percent Dataset Type",
                    "number_format": "0.0%",
                }],
            }), encoding="utf-8")
            with patch.dict(os.environ, {number_formats.NUMBER_FORMATS_PATH_ENV: str(path)}):
                self.assertEqual(
                    number_formats.dataset_type_number_format(" example rc ", "PERCENT DATASET TYPE"),
                    "0.0%",
                )
                self.assertEqual(
                    number_formats.dataset_type_number_format("another rc", "Percent Dataset Type"),
                    "0.0%",
                )
                self.assertEqual(number_formats.dataset_type_decimal_places("Example RC", "Percent Dataset Type"), 1)
                self.assertEqual(number_formats.dataset_type_number_format("Other", "Dataset Type"), "0,000.00")

    def test_missing_shared_json_uses_the_safe_default(self) -> None:
        missing = PYTHON_API_ROOT / "missing-number-formats.json"
        with patch.dict(os.environ, {number_formats.NUMBER_FORMATS_PATH_ENV: str(missing)}):
            self.assertEqual(number_formats.dataset_type_number_format("Any", "Dataset Type"), "0,000")
            self.assertEqual(number_formats.dataset_type_decimal_places("Any", "Dataset Type"), 0)

    def test_runtime_server_root_refreshes_the_shared_mapping(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(PYTHON_API_ROOT)) as temp_dir:
            root = Path(temp_dir)
            path = root / "config" / "dataset_number_formats.json"
            path.parent.mkdir()
            path.write_text(json.dumps({
                "default_number_format": "0,000",
                "overrides": [{
                    "dataset_type_name": "Frequency Type",
                    "number_format": "0.0%",
                }],
            }), encoding="utf-8")
            with patch.dict(os.environ, {number_formats.NUMBER_FORMATS_PATH_ENV: ""}):
                try:
                    number_formats.configure_number_formats_path(root)
                    self.assertEqual(number_formats.dataset_type_number_format("Any RC", "Frequency Type"), "0.0%")

                    path.write_text(json.dumps({
                        "default_number_format": "0,000.00",
                        "overrides": [],
                    }), encoding="utf-8")
                    number_formats.configure_number_formats_path(root)
                    self.assertEqual(number_formats.dataset_type_number_format("Any RC", "Frequency Type"), "0,000.00")
                finally:
                    number_formats.configure_number_formats_path()

    def test_triangle_export_looks_up_format_by_dataset_type_not_instance_name(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(PYTHON_API_ROOT)) as temp_dir:
            root = Path(temp_dir)
            path = root / "dataset_number_formats.json"
            path.write_text(json.dumps({
                "default_number_format": "0,000",
                "overrides": [{
                    "dataset_type_name": "Shared Dataset Type",
                    "number_format": "0.0%",
                }],
            }), encoding="utf-8")
            payload = {
                "name": "Custom Instance Name",
                "dataset_type": "Shared Dataset Type",
                "origin_length": 1,
                "development_length": 1,
                "values": [[0.25]],
                "data_format": 0,
            }
            with patch.dict(os.environ, {number_formats.NUMBER_FORMATS_PATH_ENV: str(path)}):
                extractors.write_triangle_export(payload, "Example RC", root)

            sidecar = json.loads((root / "sidecars" / "Custom Instance Name.json").read_text(encoding="utf-8"))
            self.assertEqual(sidecar["dataset_name"], "Custom Instance Name")
            self.assertEqual(sidecar["dataset_type"], "Shared Dataset Type")
            self.assertEqual(sidecar["number_format"], "0.0%")
            self.assertEqual(sidecar["decimal_places"], 1)


if __name__ == "__main__":
    unittest.main()
