from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    dataset_instance_index_service,
    project_settings_service,
    runtime_cache_provenance_service,
)


class RuntimeCacheProvenanceCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.rc_dir = self.root / "Example RC"
        self.csv_path = self.rc_dir / config.DATASET_CACHE_DIR / "Paid@12@12@cum@dev.csv"
        self.csv_path.parent.mkdir(parents=True)
        self.csv_path.write_text("1,2\n", encoding="utf-8")
        self.provenance_path = Path(
            runtime_cache_provenance_service.provenance_path(str(self.csv_path))
        )
        self.provenance_path.parent.mkdir(parents=True)
        self.provenance_path.write_text("{}\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_dataset_delete_removes_technical_provenance(self) -> None:
        with (
            patch.object(
                dataset_instance_index_service,
                "_folder_paths",
                return_value={
                    "data": str(self.rc_dir),
                    "datasets": str(self.rc_dir / config.DATASET_CACHE_DIR),
                    "methods": str(self.rc_dir / config.METHOD_DATA_DIR),
                    "sidecars": str(self.rc_dir / config.DATASET_SIDECAR_DIR),
                },
            ),
            patch.object(dataset_instance_index_service, "rebuild_index", return_value={}),
        ):
            result = dataset_instance_index_service.delete_cached_datasets(
                "Example Project",
                "Example RC",
                ["Paid"],
            )

        self.assertEqual(result["deleted_count"], 1)
        self.assertFalse(self.csv_path.exists())
        self.assertFalse(self.provenance_path.exists())

    def test_source_refresh_removes_generated_cache_provenance(self) -> None:
        (self.rc_dir / config.PROJECT_INDEX_FILE).write_text(
            json.dumps({"files": []}),
            encoding="utf-8",
        )
        with (
            patch.object(config, "get_project_data_dir", return_value=str(self.root)),
            patch.object(project_settings_service, "safe_append_project_audit_log"),
        ):
            result = project_settings_service.clear_generated_dataset_csv_caches(
                "project_map",
                "Example Project",
            )

        self.assertEqual(result["cleared_count"], 1)
        self.assertFalse(self.csv_path.exists())
        self.assertFalse(self.provenance_path.exists())

    def test_input_cache_identity_uses_only_canonical_scalar_index_fields(self) -> None:
        index_path = self.rc_dir / config.PROJECT_INDEX_FILE
        index_path.write_text(
            json.dumps(
                {
                    "files": [
                        {
                            "source_kind": "input",
                            "name": "Paid Loss",
                            "dataset_type": "Paid Type",
                            "csv_file": "Obsolete File.csv",
                            "dataset_name": "Obsolete Dataset",
                            "dataset_names": ["Obsolete Array Name"],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        keep = project_settings_service._input_dataset_cache_keys_from_index(
            str(index_path)
        )

        self.assertEqual(keep["files"], set())
        self.assertEqual(keep["base_names"], {"paid loss", "paid type"})

    def test_input_cache_matching_preserves_literal_two_length_suffixes(self) -> None:
        self.assertEqual(
            project_settings_service._csv_stem_base(
                "Legacy Name@12@24.csv"
            ),
            "legacy name@12@24",
        )
        self.assertEqual(
            project_settings_service._csv_stem_base(
                "Paid Loss@12@12@cum@dev.csv"
            ),
            "paid loss",
        )

    def test_source_refresh_rebuilds_only_reserving_class_with_deleted_csvs(self) -> None:
        project_dir = self.root / "Example Project"
        data_dir = project_dir / config.PROJECT_DATA_DIR
        changed_rc_dir = data_dir / "Auto_%5C_PP"
        changed_dataset_dir = changed_rc_dir / config.DATASET_CACHE_DIR
        changed_dataset_dir.mkdir(parents=True)
        changed_csv = changed_dataset_dir / "Generated@12@12@cum@dev.csv"
        changed_csv.write_text("1,2\n", encoding="utf-8")
        (changed_rc_dir / config.PROJECT_INDEX_FILE).write_text(
            json.dumps({"files": []}),
            encoding="utf-8",
        )

        unchanged_rc_dir = data_dir / "Unchanged RC"
        unchanged_dataset_dir = unchanged_rc_dir / config.DATASET_CACHE_DIR
        unchanged_dataset_dir.mkdir(parents=True)
        input_csv = unchanged_dataset_dir / "Paid@12@12@cum@dev.csv"
        input_csv.write_text("1,2\n", encoding="utf-8")
        unchanged_index_path = unchanged_rc_dir / config.PROJECT_INDEX_FILE
        unchanged_index_text = json.dumps(
            {
                "files": [
                    {
                        "source_kind": "input",
                        "name": "Paid",
                        "dataset_type": "Paid",
                    }
                ]
            }
        )
        unchanged_index_path.write_text(unchanged_index_text, encoding="utf-8")

        canonical_builder = project_settings_service.build_dataset_index_payload
        with (
            patch.object(config, "get_project_data_dir", return_value=str(data_dir)),
            patch.object(project_settings_service, "safe_append_project_audit_log"),
            patch.object(
                project_settings_service,
                "build_dataset_index_payload",
                wraps=canonical_builder,
            ) as build_index,
        ):
            result = project_settings_service.clear_generated_dataset_csv_caches(
                "project_map",
                "example project",
            )

        self.assertEqual(result["cleared_count"], 1)
        self.assertEqual(result["preserved_count"], 1)
        self.assertFalse(changed_csv.exists())
        self.assertTrue(input_csv.exists())
        self.assertEqual(build_index.call_count, 1)
        self.assertEqual(build_index.call_args.args[:3], (
            "Example Project",
            r"Auto\PP",
            str(changed_rc_dir),
        ))
        self.assertEqual(
            unchanged_index_path.read_text(encoding="utf-8"),
            unchanged_index_text,
        )

    def test_reserving_class_clear_canonicalizes_lowercase_project_alias(self) -> None:
        data_dir = self.root / "Example Project" / config.PROJECT_DATA_DIR
        rc_dir = data_dir / "Auto_%5C_PP"
        dataset_dir = rc_dir / config.DATASET_CACHE_DIR
        dataset_dir.mkdir(parents=True)
        (dataset_dir / "Generated@12@12@cum@dev.csv").write_text(
            "1,2\n",
            encoding="utf-8",
        )
        (rc_dir / config.PROJECT_INDEX_FILE).write_text(
            json.dumps({"files": []}),
            encoding="utf-8",
        )

        canonical_builder = project_settings_service.build_dataset_index_payload
        with patch.object(
            project_settings_service,
            "build_dataset_index_payload",
            wraps=canonical_builder,
        ) as build_index:
            project_settings_service._clear_reserving_class_generated_dataset_csv_caches(
                project_name="example project",
                reserving_class_dir=str(rc_dir),
                data_dir=str(data_dir),
            )

        self.assertEqual(
            build_index.call_args.args[:2],
            ("Example Project", r"Auto\PP"),
        )

    def test_partial_cache_delete_rebuilds_index_before_reporting_failure(self) -> None:
        data_dir = self.root / "Example Project" / config.PROJECT_DATA_DIR
        rc_dir = data_dir / "Example RC"
        dataset_dir = rc_dir / config.DATASET_CACHE_DIR
        dataset_dir.mkdir(parents=True)
        deleted_csv = dataset_dir / "Delete@12@12@cum@dev.csv"
        blocked_csv = dataset_dir / "Blocked@12@12@cum@dev.csv"
        deleted_csv.write_text("1,2\n", encoding="utf-8")
        blocked_csv.write_text("1,2\n", encoding="utf-8")
        (rc_dir / config.PROJECT_INDEX_FILE).write_text(
            json.dumps({"files": []}),
            encoding="utf-8",
        )

        def remove_csv(path: str) -> None:
            if path == str(blocked_csv):
                raise PermissionError(path)
            Path(path).unlink()

        canonical_builder = project_settings_service.build_dataset_index_payload
        with (
            patch.object(
                project_settings_service,
                "_remove_generated_dataset_csv",
                side_effect=remove_csv,
            ),
            patch.object(
                project_settings_service,
                "build_dataset_index_payload",
                wraps=canonical_builder,
            ) as build_index,
        ):
            with self.assertRaises(PermissionError):
                project_settings_service._clear_reserving_class_generated_dataset_csv_caches(
                    project_name="Example Project",
                    reserving_class_dir=str(rc_dir),
                    data_dir=str(data_dir),
                )

        self.assertFalse(deleted_csv.exists())
        self.assertTrue(blocked_csv.exists())
        self.assertEqual(build_index.call_count, 1)

    def test_source_refresh_processes_reserving_classes_with_bounded_parallelism(
        self,
    ) -> None:
        data_dir = self.root / "Example Project" / config.PROJECT_DATA_DIR
        for index in range(6):
            rc_dir = data_dir / f"RC {index}"
            (rc_dir / config.DATASET_CACHE_DIR).mkdir(parents=True)
            (rc_dir / config.PROJECT_INDEX_FILE).write_text(
                json.dumps({"files": []}),
                encoding="utf-8",
            )

        state_lock = threading.Lock()
        release_workers = threading.Event()
        active_workers = 0
        max_active_workers = 0

        def fake_clear(**_kwargs):
            nonlocal active_workers, max_active_workers
            with state_lock:
                active_workers += 1
                max_active_workers = max(max_active_workers, active_workers)
                if (
                    active_workers
                    == project_settings_service._GENERATED_CACHE_MAX_WORKERS
                ):
                    release_workers.set()
            self.assertTrue(release_workers.wait(timeout=2))
            with state_lock:
                active_workers -= 1
            return {"cleared_files": [], "preserved_files": []}

        with (
            patch.object(config, "get_project_data_dir", return_value=str(data_dir)),
            patch.object(
                project_settings_service,
                "_clear_reserving_class_generated_dataset_csv_caches",
                side_effect=fake_clear,
            ) as clear_rc,
        ):
            result = project_settings_service.clear_generated_dataset_csv_caches(
                "project_map",
                "Example Project",
            )

        self.assertEqual(result["cleared_count"], 0)
        self.assertEqual(clear_rc.call_count, 6)
        self.assertEqual(
            max_active_workers,
            project_settings_service._GENERATED_CACHE_MAX_WORKERS,
        )


if __name__ == "__main__":
    unittest.main()
