from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_ROOT = FRONTEND_ROOT.parent / "python-api" / "migration"
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))
if str(MIGRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(MIGRATION_ROOT))

from app_server.services import dataset_instance_index_service, dataset_sidecar_status_service
from arcrho_api.dataset_index_contract import canonicalize_index_row
from resq_migration.core import DATASET_INDEX_VERSION


class BerquistShermanIndexContractTests(unittest.TestCase):
    def test_method_json_formats_build_canonical_triangle_entries(self) -> None:
        cases = (
            (
                "arcrho-berquist-sherman-sr-v4",
                "B&S Settlement Rate Adjustment",
                "berquist_sherman_sr",
            ),
            (
                "arcrho-berquist-sherman-cra-v4",
                "B&S Case Reserve Adequacy Adjustment",
                "berquist_sherman_cra",
            ),
        )
        for json_format, method_type, source_kind in cases:
            with self.subTest(json_format=json_format):
                payload = {
                    "json_format": json_format,
                    "details_tab": {
                        "name": "Gross Loss - adjusted",
                        "output_type": "D Gross Loss",
                        "origin_length": 12,
                        "development_length": 12,
                    },
                }
                self.assertEqual(
                    dataset_instance_index_service._cached_dataset_names_from_payload(payload),
                    {"Gross Loss - adjusted"},
                )
                self.assertEqual(
                    dataset_instance_index_service._method_entry_from_payload(payload),
                    {
                        "dataset_name": "Gross Loss - adjusted",
                        "dataset_type": "D Gross Loss",
                        "dataset_category": "",
                        "method_type": method_type,
                        "data_format": "Triangle",
                        "source_kind": source_kind,
                        "origin_length": 12,
                        "development_length": 12,
                        "status": dataset_sidecar_status_service.STATUS_CURRENT,
                    },
                )

    def test_method_prefixes_participate_in_filename_identity_and_deletion_matching(self) -> None:
        self.assertEqual(
            dataset_instance_index_service._cached_dataset_names_from_file("BSSR@Gross Loss - SR.json"),
            {"Gross Loss - SR"},
        )
        self.assertEqual(
            dataset_instance_index_service._cached_dataset_names_from_file("BSCRA@Gross Loss - CRA.json"),
            {"Gross Loss - CRA"},
        )
        self.assertIn("BSSR@", dataset_instance_index_service.METHOD_JSON_FILENAME_PREFIXES)
        self.assertIn("BSCRA@", dataset_instance_index_service.METHOD_JSON_FILENAME_PREFIXES)
        self.assertEqual(dataset_instance_index_service.INDEX_VERSION, DATASET_INDEX_VERSION)

    def test_source_kinds_normalize_to_canonical_method_labels(self) -> None:
        self.assertEqual(
            dataset_sidecar_status_service.normalize_method_type("", "berquist_sherman_sr"),
            "B&S Settlement Rate Adjustment",
        )
        self.assertEqual(
            dataset_sidecar_status_service.normalize_method_type("", "berquist_sherman_cra"),
            "B&S Case Reserve Adequacy Adjustment",
        )

    def test_cached_delete_removes_the_b_and_s_csv_sidecar_and_method_json(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            root = Path(temp_dir)
            dataset_dir = root / "datasets"
            sidecar_dir = root / "sidecars"
            method_dir = root / "methods"
            dataset_dir.mkdir()
            sidecar_dir.mkdir()
            method_dir.mkdir()

            csv_path = dataset_dir / "Adjusted SR@12@12@cum@dev.csv"
            csv_path.write_text("Origin,12\n2017,1\n", encoding="utf-8")
            sidecar_path = sidecar_dir / "Adjusted SR.json"
            sidecar_path.write_text(
                json.dumps(
                    {
                        "dataset_name": "Adjusted SR",
                        "source_kind": "berquist_sherman_sr",
                        "method_type": "B&S Settlement Rate Adjustment",
                        "data_format": "Triangle",
                        "origin_length": 12,
                        "development_length": 12,
                    }
                ),
                encoding="utf-8",
            )
            method_path = method_dir / "BSSR@Adjusted SR.json"
            method_path.write_text(
                json.dumps(
                    {
                        "json_format": "arcrho-berquist-sherman-sr-v4",
                        "details_tab": {
                            "name": "Adjusted SR",
                            "output_type": "D Gross Loss",
                            "origin_length": 12,
                            "development_length": 12,
                        },
                    }
                ),
                encoding="utf-8",
            )

            folder_paths = {
                "data": str(root),
                "datasets": str(dataset_dir),
                "methods": str(method_dir),
                "sidecars": str(sidecar_dir),
            }
            with (
                patch.object(dataset_instance_index_service, "_folder_paths", return_value=folder_paths),
                patch.object(dataset_instance_index_service, "rebuild_index", return_value={"ok": True}),
            ):
                result = dataset_instance_index_service.delete_cached_datasets(
                    "Example",
                    "Annual",
                    ["Adjusted SR"],
                )

            self.assertEqual(result["deleted_count"], 3)
            self.assertFalse(csv_path.exists())
            self.assertFalse(sidecar_path.exists())
            self.assertFalse(method_path.exists())

    def test_logical_index_keeps_scalar_period_lengths_without_origin_labels(self) -> None:
        target = canonicalize_index_row(
            {
                "name": "Adjusted Loss",
                "dataset_type": "Adjusted Loss",
                "origin_length": 12,
                "development_length": 12,
                "origin_labels": ["2017", "2018"],
            },
        )
        self.assertEqual(target["origin_length"], 12)
        self.assertEqual(target["development_length"], 12)
        self.assertNotIn("origin_labels", target)


if __name__ == "__main__":
    unittest.main()
