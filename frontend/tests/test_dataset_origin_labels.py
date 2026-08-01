from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import mock_open, patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from fastapi import HTTPException

from app_server.services import arcrho_runtime_service, dataset_service


class DatasetOriginLabelValidationTests(unittest.TestCase):
    def test_accepts_supported_consecutive_formats(self) -> None:
        cases = (
            (12, ["2016", "2017"]),
            (6, ["2017 H1", "2017H2", "2018 H1"]),
            (3, ["2017 Q4", "2018Q1"]),
            (1, ["201712", "201801", "Feb 2018"]),
        )
        for origin_length, labels in cases:
            with self.subTest(origin_length=origin_length):
                actual, reason = dataset_service._validate_origin_labels(
                    labels,
                    len(labels),
                )
                self.assertEqual(actual, labels)
                self.assertEqual(reason, "")

    def test_rejects_invalid_or_inconsistent_labels(self) -> None:
        cases = (
            (["1", "2"], 2),
            (["2017", "2018 H1"], 2),
            (["2017", "2019"], 2),
            (["2017", "2018"], 3),
        )
        for labels, count in cases:
            with self.subTest(labels=labels, count=count):
                actual, reason = dataset_service._validate_origin_labels(labels, count)
                self.assertEqual(actual, [])
                self.assertTrue(reason)

        actual, reason = dataset_service._validate_origin_labels(["2020", "2021"], 2, 3)
        self.assertEqual(actual, [])
        self.assertIn("3-month", reason)


class DatasetOriginLabelResolutionTests(unittest.TestCase):
    project_data_dir = str(FRONTEND_ROOT / "test-project-data")
    dataset_path = str(Path(project_data_dir) / "datasets" / "dataset.csv")

    def _resolver_patches(self, headers: dict):
        return (
            patch.object(dataset_service.config, "get_project_data_dir", return_value=self.project_data_dir),
            patch.object(arcrho_runtime_service, "get_project_headers", return_value=headers),
        )

    def test_current_project_headers_are_authoritative(self) -> None:
        patches = self._resolver_patches({"ok": True, "labels": ["2020", "2021"]})
        with patches[0], patches[1] as get_headers:
            labels = dataset_service._resolve_origin_labels(
                "dataset-1",
                self.dataset_path,
                "Example Project",
                12,
                2,
            )
        self.assertEqual(labels, ["2020", "2021"])
        get_headers.assert_called_once_with(
            "Example Project",
            12,
            timeout_sec=dataset_service.config.ENGINE_REQUEST_TIMEOUT_SEC,
        )

    def test_uses_valid_project_headers_not_a_scalar_year(self) -> None:
        headers = {"ok": True, "labels": ["2017 Q4", "2018 Q1"]}
        patches = self._resolver_patches(headers)
        with patches[0], patches[1] as get_headers:
            labels = dataset_service._resolve_origin_labels(
                "dataset-2",
                self.dataset_path,
                "Example Project",
                3,
                2,
            )
        self.assertEqual(labels, ["2017 Q4", "2018 Q1"])
        get_headers.assert_called_once_with(
            "Example Project",
            3,
            timeout_sec=dataset_service.config.ENGINE_REQUEST_TIMEOUT_SEC,
        )

    def test_development_labels_use_the_transposed_project_header_contract(self) -> None:
        patches = self._resolver_patches({"ok": True, "labels": ["5m", "17m"]})
        with patches[0], patches[1] as get_headers:
            labels = dataset_service._resolve_development_labels(
                "dataset-dev",
                self.dataset_path,
                "Example Project",
                12,
                2,
                calendar=False,
            )
        self.assertEqual(labels, ["5m", "17m"])
        get_headers.assert_called_once_with(
            "Example Project",
            12,
            timeout_sec=dataset_service.config.ENGINE_REQUEST_TIMEOUT_SEC,
            period_type=1,
            transposed=True,
            calendar=False,
        )

    def test_rejects_a_registered_dataset_outside_the_requested_project(self) -> None:
        patches = self._resolver_patches({"ok": True, "labels": ["2020", "2021"]})
        outside_path = str(FRONTEND_ROOT / "different-project" / "datasets" / "dataset.csv")
        with patches[0], patches[1] as get_headers:
            with self.assertRaises(HTTPException) as raised:
                dataset_service._resolve_origin_labels(
                    "dataset-3",
                    outside_path,
                    "Example Project",
                    12,
                    2,
                )
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("different project", str(raised.exception.detail))
        get_headers.assert_not_called()

    def test_returns_504_when_project_headers_time_out(self) -> None:
        patches = self._resolver_patches(
            {"ok": False, "status": "timeout", "message": "Header generation timed out. Try again."},
        )
        with patches[0], patches[1]:
            with self.assertRaises(HTTPException) as raised:
                dataset_service._resolve_origin_labels(
                    "dataset-4",
                    self.dataset_path,
                    "Example Project",
                    12,
                    2,
                )
        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("timed out", str(raised.exception.detail))

    def test_returns_actionable_422_for_invalid_header_labels(self) -> None:
        patches = self._resolver_patches({"ok": True, "labels": ["1", "2"]})
        with patches[0], patches[1]:
            with self.assertRaises(HTTPException) as raised:
                dataset_service._resolve_origin_labels(
                    "dataset-5",
                    self.dataset_path,
                    "Example Project",
                    12,
                    2,
                )
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Origin Start Date", str(raised.exception.detail))


class ArcRhoHeaderSettingsTests(unittest.TestCase):
    def test_rejects_missing_origin_start_date_even_when_a_cache_could_exist(self) -> None:
        settings = {
            "ok": True,
            "exists": True,
            "path": "general_settings.json",
            "data": {"origin_start_date": ""},
        }
        with patch.object(arcrho_runtime_service.project_settings_service, "get_general_settings", return_value=settings):
            with self.assertRaises(HTTPException) as raised:
                arcrho_runtime_service._require_valid_header_project_settings([
                    ("ProjectName", "Example Project"),
                ])
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Origin Start Date", str(raised.exception.detail))

    def test_accepts_valid_settings_after_a_project_copy_or_rename(self) -> None:
        settings = {
            "ok": True,
            "exists": True,
            "path": "general_settings.json",
            "data": {
                "origin_start_date": "202001",
                "project_name": "Former Project Name",
                "project_name_mismatch": True,
            },
        }
        with patch.object(arcrho_runtime_service.project_settings_service, "get_general_settings", return_value=settings):
            actual = arcrho_runtime_service._require_valid_header_project_settings([
                ("ProjectName", "Renamed Project"),
            ])
        self.assertIs(actual, settings)

    def test_invalidates_a_header_cache_older_than_general_settings(self) -> None:
        cache_path = "headers.csv"
        settings_path = "general_settings.json"
        cache_exists = {"value": True}

        def exists(path: str) -> bool:
            if path == cache_path:
                return cache_exists["value"]
            return path == settings_path

        def remove(path: str) -> None:
            self.assertEqual(path, cache_path)
            cache_exists["value"] = False

        settings = {
            "ok": True,
            "exists": True,
            "path": settings_path,
            "data": {"origin_start_date": "202001", "project_name_mismatch": False},
        }
        with (
            patch.object(arcrho_runtime_service.project_settings_service, "get_general_settings", return_value=settings),
            patch.object(arcrho_runtime_service, "set_data_path_like_vba", return_value=cache_path),
            patch.object(arcrho_runtime_service.os.path, "exists", side_effect=exists),
            patch.object(arcrho_runtime_service.os.path, "getmtime", side_effect=lambda path: 1 if path == cache_path else 2),
            patch.object(arcrho_runtime_service.os, "remove", side_effect=remove) as remove_cache,
            patch.object(arcrho_runtime_service.os, "makedirs"),
            patch.object(arcrho_runtime_service, "send_request_like_vba", return_value="request.txt"),
            patch.object(arcrho_runtime_service, "wait_for_file", return_value=False),
        ):
            result = arcrho_runtime_service.get_project_headers("Example Project", 12, timeout_sec=0.1)
        self.assertEqual(result["status"], "timeout")
        self.assertIn("data engine", result["message"])
        remove_cache.assert_called_once_with(cache_path)


class EmptyDatasetSettingsTests(unittest.TestCase):
    def test_missing_general_settings_returns_an_actionable_error(self) -> None:
        with (
            patch.object(dataset_service.config, "get_general_settings_path", return_value="general_settings.json"),
            patch.object(dataset_service.os.path, "exists", return_value=False),
        ):
            with self.assertRaises(HTTPException) as raised:
                dataset_service._empty_dataset_geometry_from_general_settings("Example Project", 12, 12)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Origin Start Date", str(raised.exception.detail))

    def test_invalid_origin_start_date_is_not_replaced_with_a_default_shape(self) -> None:
        settings_json = (
            '{"origin_start_date":"","origin_end_date":"202112",'
            '"development_end_date":"202112"}'
        )
        with (
            patch.object(dataset_service.config, "get_general_settings_path", return_value="general_settings.json"),
            patch.object(dataset_service.os.path, "exists", return_value=True),
            patch("builtins.open", mock_open(read_data=settings_json)),
        ):
            with self.assertRaises(HTTPException) as raised:
                dataset_service._empty_dataset_geometry_from_general_settings("Example Project", 12, 12)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Origin Start Date", str(raised.exception.detail))

    def test_patch_mask_preserves_project_settings_errors(self) -> None:
        settings_error = HTTPException(422, "Origin Start Date is invalid.")
        with (
            patch.object(
                dataset_service.dataset_instance_index_service,
                "_dataset_sidecar_path_for_cached_csv",
                return_value="dataset.json",
            ),
            patch.object(
                dataset_service,
                "_read_dataset_sidecar",
                return_value={"project_name": "Example Project", "origin_length": 12, "development_length": 12},
            ),
            patch.object(
                dataset_service,
                "_empty_dataset_geometry_from_general_settings",
                side_effect=settings_error,
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                dataset_service._dataset_patch_mask("dataset.csv", 2, 2)
        self.assertIs(raised.exception, settings_error)

    def test_patch_mask_uses_the_containing_project_after_copy_or_rename(self) -> None:
        projects_root = FRONTEND_ROOT / "test-projects"
        dataset_path = projects_root / "Renamed Project" / "data" / "class" / "datasets" / "dataset.csv"
        expected_mask = dataset_service.np.ones((2, 2), dtype=bool)
        with (
            patch.object(dataset_service.config, "PROJECT_SETTINGS_DIR", str(projects_root)),
            patch.object(
                dataset_service.dataset_instance_index_service,
                "_dataset_sidecar_path_for_cached_csv",
                return_value="dataset.json",
            ),
            patch.object(
                dataset_service,
                "_read_dataset_sidecar",
                return_value={"project_name": "Former Project", "origin_length": 12, "development_length": 12},
            ),
            patch.object(
                dataset_service,
                "_empty_dataset_geometry_from_general_settings",
                return_value=(2, 2, expected_mask),
            ) as geometry,
        ):
            actual = dataset_service._dataset_patch_mask(str(dataset_path), 2, 2)
        self.assertIs(actual, expected_mask)
        geometry.assert_called_once_with("Renamed Project", 12, 12)


class DatasetPublicReadTests(unittest.TestCase):
    def test_get_dataset_uses_resolved_labels(self) -> None:
        frame = dataset_service.pd.DataFrame([[1.0, 2.0], [3.0, float("nan")]])
        with (
            patch.dict(dataset_service.config.DATASETS, {"dataset-6": "dataset.csv"}, clear=True),
            patch.object(dataset_service.os.path, "exists", return_value=True),
            patch.object(dataset_service.pd, "read_csv", return_value=frame),
            patch.object(dataset_service, "_resolve_origin_labels", return_value=["2020", "2021"]) as resolver,
            patch.object(dataset_service.os, "stat", return_value=SimpleNamespace(st_mtime=10.0)),
        ):
            result = dataset_service.get_dataset("dataset-6", "Example Project", 12)
        self.assertEqual(result["origin_labels"], ["2020", "2021"])
        self.assertEqual(result["values"], [[1.0, 2.0], [3.0, None]])
        resolver.assert_called_once_with("dataset-6", "dataset.csv", "Example Project", 12, 2)

    def test_get_diagonal_uses_resolved_labels(self) -> None:
        frame = dataset_service.pd.DataFrame([[1.0, 2.0], [3.0, float("nan")]])
        with (
            patch.dict(dataset_service.config.DATASETS, {"dataset-7": "dataset.csv"}, clear=True),
            patch.object(dataset_service.os.path, "exists", return_value=True),
            patch.object(dataset_service, "load_triangle_values", return_value=frame),
            patch.object(dataset_service, "_resolve_origin_labels", return_value=["2020", "2021"]),
        ):
            result = dataset_service.get_diagonal("dataset-7", "Example Project", 12)
        self.assertEqual([item["origin"] for item in result["items"]], ["2020", "2021"])


if __name__ == "__main__":
    unittest.main()
