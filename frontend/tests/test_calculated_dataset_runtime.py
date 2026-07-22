from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import arcrho_runtime_service, calculated_dataset_service


class CalculatedDatasetRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Calculated Output"),
            ("InstanceName", "Calculated Output"),
            ("ProjectName", "Example Project"),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def test_dependency_errors_include_structured_missing_names(self) -> None:
        row = {
            "name": "Calculated Output",
            "data_format": "Triangle",
            "formula": '"Generated Input" * 2',
            "calculated": True,
            "generated": False,
        }
        with (
            patch.object(calculated_dataset_service, "_calculated_rows_by_key", return_value={"calculated output": row}),
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[row]),
            patch.object(calculated_dataset_service, "_existing_target_settings", return_value={}),
            patch.object(
                calculated_dataset_service,
                "_load_components",
                return_value=({}, [], ["Missing dependency: Generated Input"]),
            ),
        ):
            result = calculated_dataset_service.recalculate_dataset(
                "Example Project",
                "Example RC",
                "Calculated Output",
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_dependencies"], ["Generated Input"])

    def test_missing_app_calculated_cache_is_rebuilt_before_engine_request(self) -> None:
        calculated_path = r"E:\cache\Calculated Output@12@12@cum@dev.csv"
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={"ok": False, "status": "cache_missing"},
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value={"ok": True, "path": calculated_path},
            ) as recalculate,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value={"ok": True, "steps": []},
            ),
            patch.object(
                arcrho_runtime_service,
                "_register_arcrho_dataset",
                return_value="arcrhotri_calculated",
            ),
            patch.object(
                arcrho_runtime_service.dataset_instance_index_service,
                "rebuild_index",
            ),
            patch.object(
                arcrho_runtime_service,
                "send_request_like_vba",
                side_effect=AssertionError("app-calculated datasets must not be sent to the data engine"),
            ),
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                calculated_path,
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["local_cache_status"], "calculated")
        self.assertEqual(result["ds_id"], "arcrhotri_calculated")
        self.assertTrue(result["sidecar_written"])
        recalculate.assert_called_once_with("Example Project", "Example RC", "Calculated Output")

    def test_new_engine_cache_recalculates_dependents_without_sidecar_write(self) -> None:
        dependency_report = {"ok": True, "steps": [{"ok": True, "dataset_type_name": "Calculated Output"}]}
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={
                    "ok": False,
                    "status": "cache_missing",
                    "manual_source_found": False,
                    "generated_source_found": True,
                },
            ),
            patch.object(arcrho_runtime_service, "_recalculate_requested_app_dataset", return_value=None),
            patch.object(arcrho_runtime_service, "arcrho_tri_cache_matches", return_value=False),
            patch.object(arcrho_runtime_service.os, "makedirs"),
            patch.object(arcrho_runtime_service, "send_request_like_vba", return_value="request.txt"),
            patch.object(arcrho_runtime_service, "wait_for_file", return_value=True),
            patch.object(arcrho_runtime_service, "_refresh_dataset_instance_index_after_cache_write"),
            patch.object(arcrho_runtime_service, "_register_arcrho_dataset", return_value="arcrhotri_generated"),
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value=dependency_report,
            ) as recalculate_dependents,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                r"E:\cache\Generated Input@12@12@cum@dev.csv",
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["need_request"])
        self.assertFalse(result["sidecar_written"])
        self.assertEqual(result["calculated_updates"], dependency_report)
        recalculate_dependents.assert_called_once_with(self.pairs)

    def test_missing_generated_dependency_is_materialized_then_calculation_retries(self) -> None:
        calculated_path = r"E:\cache\Calculated Output@12@12@cum@dev.csv"
        first_result = {
            "ok": False,
            "reason": "dependency_error",
            "errors": ["Missing dependency: Generated Input"],
            "missing_dependencies": ["Generated Input"],
        }
        second_result = {"ok": True, "path": calculated_path}
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={"ok": False, "status": "cache_missing"},
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                side_effect=[first_result, second_result],
            ) as recalculate,
            patch.object(
                arcrho_runtime_service,
                "_materialize_calculated_dependencies",
                return_value=[{"ok": True, "dataset_type_name": "Generated Input"}],
            ) as materialize,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value={"ok": True, "steps": []},
            ),
            patch.object(
                arcrho_runtime_service,
                "_register_arcrho_dataset",
                return_value="arcrhotri_calculated",
            ),
            patch.object(
                arcrho_runtime_service.dataset_instance_index_service,
                "rebuild_index",
            ),
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                calculated_path,
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(recalculate.call_count, 2)
        materialize.assert_called_once()


if __name__ == "__main__":
    unittest.main()
