import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import arcrho_runtime_service, calculated_dataset_service, dataset_number_format_service


class DatasetNumberFormatDefaultsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.preferences_path = self.root / "config" / "dataset_number_formats.json"
        self.path_patch = patch.object(
            config,
            "get_dataset_number_formats_path",
            return_value=str(self.preferences_path),
        )
        self.path_patch.start()

    def tearDown(self) -> None:
        self.path_patch.stop()
        self.temp_dir.cleanup()

    def test_missing_config_uses_the_global_fallback(self) -> None:
        payload = dataset_number_format_service.get_preferences()
        self.assertEqual(payload["default_number_format"], "0,000")
        self.assertEqual(payload["overrides"], [])
        self.assertEqual(dataset_number_format_service.dataset_type_number_format("Any RC", "Any Dataset Type"), "0,000")

    def test_save_and_lookup_use_case_insensitive_reserving_class_and_dataset_type_keys(self) -> None:
        saved = dataset_number_format_service.save_preferences(
            expected_revision=0,
            default_number_format="0,000.00",
            overrides=[{
                "reserving_class": "Example RC",
                "dataset_type_name": "Frequency Type",
                "number_format": "0.000",
            }],
        )

        self.assertEqual(saved["revision"], 1)
        self.assertEqual(dataset_number_format_service.dataset_type_number_format(" example rc ", "FREQUENCY TYPE"), "0.000")
        self.assertEqual(dataset_number_format_service.dataset_type_number_format("Other", "Dataset Type"), "0,000.00")
        self.assertEqual(
            dataset_number_format_service.dataset_type_number_format_settings("Example RC", "Frequency Type"),
            {"number_format": "0.000", "decimal_places": 3},
        )
        on_disk = json.loads(self.preferences_path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["json_format"], dataset_number_format_service.JSON_FORMAT)

    def test_revision_conflict_does_not_overwrite_the_file(self) -> None:
        dataset_number_format_service.save_preferences(
            expected_revision=0,
            default_number_format="0,000",
            overrides=[],
        )
        with self.assertRaises(HTTPException) as raised:
            dataset_number_format_service.save_preferences(
                expected_revision=0,
                default_number_format="0.0%",
                overrides=[],
            )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(dataset_number_format_service.get_preferences()["default_number_format"], "0,000")

    def test_new_engine_sidecar_receives_matching_default_format(self) -> None:
        dataset_number_format_service.save_preferences(
            expected_revision=0,
            default_number_format="0,000",
            overrides=[{
                "reserving_class": "Example RC",
                "dataset_type_name": "Frequency Type",
                "number_format": "0.000",
            }],
        )
        data_path = self.root / "data" / "datasets" / "Frequency Instance@12@12@cum@dev.csv"
        sidecar_path = self.root / "data" / "sidecars" / "Frequency Instance.json"
        data_path.parent.mkdir(parents=True)
        data_path.write_text("1\n", encoding="utf-8")
        pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Frequency Type"),
            ("InstanceName", "Frequency Instance"),
            ("ProjectName", "Example Project"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]
        with (
            patch.object(arcrho_runtime_service, "_dataset_sidecar_path", return_value=str(sidecar_path)),
            patch.object(arcrho_runtime_service, "_set_processing_provenance"),
            patch("app_server.services.calculated_dataset_service.apply_sidecar_graph_fields"),
            patch.object(arcrho_runtime_service.dataset_sidecar_status_service, "refresh_method_statuses_for_dependents"),
        ):
            arcrho_runtime_service._write_dataset_sidecar(str(data_path), pairs)

        payload = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["dataset_name"], "Frequency Instance")
        self.assertEqual(payload["dataset_type"], "Frequency Type")
        self.assertEqual(payload["number_format"], "0.000")
        self.assertEqual(payload["decimal_places"], 3)

    def test_new_calculated_sidecar_receives_matching_default_format(self) -> None:
        dataset_number_format_service.save_preferences(
            expected_revision=0,
            default_number_format="0,000",
            overrides=[{
                "reserving_class": "Example RC",
                "dataset_type_name": "Calculated Ratio",
                "number_format": "0.0%",
            }],
        )
        csv_path = self.root / "data" / "datasets" / "Calculated Ratio@12@12@cum@dev.csv"
        sidecar_path = self.root / "data" / "sidecars" / "Calculated Ratio.json"
        row = {
            "name": "Calculated Ratio",
            "data_format": "Triangle",
            "formula": "Source",
            "calculated": True,
        }
        source_row = {"name": "Source", "data_format": "Triangle", "formula": "", "calculated": False}
        with (
            patch.object(calculated_dataset_service, "_calculated_rows_by_key", return_value={"calculated ratio": row}),
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[source_row, row]),
            patch.object(calculated_dataset_service, "_load_components", return_value=({"_d0": [[0.25]]}, ["Source"], [])),
            patch.object(calculated_dataset_service, "_target_paths", return_value=(str(csv_path), str(sidecar_path))),
            patch.object(calculated_dataset_service, "_existing_target_settings", return_value={}),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields"),
            patch.object(calculated_dataset_service.dataset_sidecar_status_service, "refresh_method_statuses_for_dependents", return_value=[]),
            patch.dict(config.DATASETS, {}, clear=True),
        ):
            result = calculated_dataset_service.recalculate_dataset(
                "Example Project",
                "Example RC",
                "Calculated Ratio",
            )

        self.assertTrue(result["ok"], result)
        payload = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["number_format"], "0.0%")
        self.assertEqual(payload["decimal_places"], 1)


if __name__ == "__main__":
    unittest.main()
