from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from fastapi import HTTPException

from app_server.schemas.dataset import DatasetSidecarSaveRequest
from app_server.services import calculated_dataset_service, dataset_service


class DatasetExternalLinkSchemaTests(unittest.TestCase):
    def _request(self, external_links):
        return DatasetSidecarSaveRequest(
            project_name="Project",
            reserving_class="Class",
            dataset_name="Dataset",
            origin_length=12,
            development_length=12,
            external_links=external_links,
        )

    def test_normalizes_reference_source_cell_and_accepts_nonnegative_targets(self) -> None:
        request = self._request([
            {
                "reference": "  ='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$B$2  ",
                "target_cells": [{"row": 0, "column": 0, "source_cell": " $b$2 "}],
            },
        ])

        self.assertEqual(
            request.external_links[0].reference,
            "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$B$2",
        )
        self.assertEqual(request.external_links[0].target_cells[0].source_cell, "B2")

    def test_rejects_blank_reference_negative_coords_and_empty_targets(self) -> None:
        invalid_links = (
            [{"reference": "   ", "target_cells": [{"row": 0, "column": 0}]}],
            [{"reference": "=link", "target_cells": [{"row": -1, "column": 0}]}],
            [{"reference": "=link", "target_cells": []}],
            [
                {
                    "reference": "=link",
                    "target_cells": [{"row": 0, "column": 0, "source_cell": "A0"}],
                },
            ],
        )
        for external_links in invalid_links:
            with self.subTest(external_links=external_links):
                with self.assertRaises(ValidationError):
                    self._request(external_links)


class DatasetExternalLinkNormalizationTests(unittest.TestCase):
    def test_preserves_separate_consumers_and_deduplicates_exact_links(self) -> None:
        normalized = dataset_service._normalize_dataset_external_links([
            {
                "reference": "  ='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1  ",
                "target_cells": [
                    {"row": 1, "column": 2},
                    {"row": 1, "column": 2},
                    {"row": 0, "column": 0},
                ],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!C1",
                "target_cells": [{"row": 3, "column": 4}],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
                "target_cells": [
                    {"row": 2, "column": 1},
                    {"row": 2, "column": 2},
                ],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!C1",
                "target_cells": [{"row": 3, "column": 4}],
            },
        ], strict=True)

        self.assertEqual(normalized, [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
                "target_cells": [
                    {"row": 1, "column": 2, "source_cell": "A1"},
                    {"row": 0, "column": 0, "source_cell": "B1"},
                ],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!C1",
                "target_cells": [{"row": 3, "column": 4, "source_cell": "C1"}],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
                "target_cells": [
                    {"row": 2, "column": 1, "source_cell": "A1"},
                    {"row": 2, "column": 2, "source_cell": "B1"},
                ],
            },
        ])

    def test_accepts_an_explicit_clipped_subset_of_the_source_range(self) -> None:
        normalized = dataset_service._normalize_dataset_external_links([
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$C$3",
                "target_cells": [
                    {"row": 0, "column": 0, "source_cell": "$A$1"},
                    {"row": 0, "column": 1, "source_cell": "B1"},
                    {"row": 1, "column": 0, "source_cell": "a2"},
                ],
            },
        ], strict=True)

        self.assertEqual(normalized, [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$C$3",
                "target_cells": [
                    {"row": 0, "column": 0, "source_cell": "A1"},
                    {"row": 0, "column": 1, "source_cell": "B1"},
                    {"row": 1, "column": 0, "source_cell": "A2"},
                ],
            },
        ])

    def test_invalid_direct_service_input_raises_http_400(self) -> None:
        invalid_values = (
            "not-a-list",
            [{"reference": "", "target_cells": [{"row": 0, "column": 0}]}],
            [{"reference": "=not-an-excel-reference", "target_cells": [{"row": 0, "column": 0}]}],
            [{"reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", "target_cells": []}],
            [{"reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", "target_cells": [{"row": True, "column": 0}]}],
            [
                {"reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", "target_cells": [{"row": 0, "column": 0}]},
                {"reference": "='C:\\Data\\[Other.xlsx]Sheet 1'!A1", "target_cells": [{"row": 0, "column": 0}]},
            ],
            [
                {
                    "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
                    "target_cells": [{"row": 0, "column": 0}],
                },
            ],
            [
                {
                    "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2",
                    "target_cells": [
                        {"row": 0, "column": 0, "source_cell": "A1"},
                        {"row": 0, "column": 1},
                    ],
                },
            ],
            [
                {
                    "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2",
                    "target_cells": [
                        {"row": 0, "column": 0, "source_cell": "C1"},
                    ],
                },
            ],
            [
                {
                    "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2",
                    "target_cells": [
                        {"row": 0, "column": 0, "source_cell": "A1"},
                        {"row": 0, "column": 1, "source_cell": "$A$1"},
                    ],
                },
            ],
        )
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaises(HTTPException) as raised:
                    dataset_service._normalize_dataset_external_links(value, strict=True)
                self.assertEqual(raised.exception.status_code, 400)

    def test_save_rejects_invalid_direct_service_input_before_side_effects(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            dataset_service.save_dataset_sidecar(
                "Project",
                "Class",
                "Dataset",
                origin_length=12,
                development_length=12,
                external_links=[
                    {
                        "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
                        "target_cells": [{"row": 0, "column": -1}],
                    },
                ],
            )

        self.assertEqual(raised.exception.status_code, 400)


class DatasetExternalLinkSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.existing_links = [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$A$2",
                "target_cells": [
                    {"row": 0, "column": 0},
                    {"row": 1, "column": 0},
                ],
            },
        ]
        self.existing = {
            "dataset_name": "Dataset",
            "dataset_type": "Input Type",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "input",
            "data_format": "Triangle",
            "origin_length": 12,
            "development_length": 12,
            "cumulative": True,
            "calendar": False,
            "external_links": copy.deepcopy(self.existing_links),
            "unknown_extension_field": {"preserve": True},
        }

    def _save(self, external_links=None, *, show_subtotal=None):
        written = {}

        def capture_write(path, payload):
            written["path"] = path
            written["payload"] = copy.deepcopy(payload)

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=copy.deepcopy(self.existing)),
            patch.object(dataset_service, "_write_dataset_sidecar_payload", side_effect=capture_write),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
            patch.object(dataset_service.dataset_instance_index_service, "rebuild_index"),
            patch.object(
                dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields"),
            patch.object(
                calculated_dataset_service,
                "recalculate_dependents",
                return_value={"ok": True, "steps": []},
            ),
        ):
            result = dataset_service.save_dataset_sidecar(
                "Project",
                "Class",
                "Dataset",
                dataset_type="Input Type",
                source_kind="input",
                data_format="Triangle",
                origin_length=12,
                development_length=12,
                show_subtotal=show_subtotal,
                external_links=external_links,
            )

        return result, written["payload"]

    def test_show_subtotal_defaults_on_and_persists_an_explicit_false_value(self) -> None:
        default_result, default_payload = self._save()
        hidden_result, hidden_payload = self._save(show_subtotal=False)

        self.assertIs(default_payload["show_subtotal"], True)
        self.assertIs(default_result["show_subtotal"], True)
        self.assertIs(hidden_payload["show_subtotal"], False)
        self.assertIs(hidden_result["show_subtotal"], False)

    def test_omitted_external_links_preserves_existing_and_unknown_fields(self) -> None:
        result, payload = self._save()

        self.assertEqual(payload["external_links"], self.existing_links)
        self.assertEqual(payload["unknown_extension_field"], {"preserve": True})
        self.assertEqual(result["external_links"], [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$A$2",
                "target_cells": [
                    {"row": 0, "column": 0, "source_cell": "A1"},
                    {"row": 1, "column": 0, "source_cell": "A2"},
                ],
            },
        ])

    def test_empty_external_links_clears_existing_links(self) -> None:
        result, payload = self._save([])

        self.assertEqual(payload["external_links"], [])
        self.assertEqual(result["external_links"], [])

    def test_save_persists_an_explicit_clipped_source_mapping(self) -> None:
        links = [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:C3",
                "target_cells": [
                    {"row": 0, "column": 0, "source_cell": "A1"},
                    {"row": 0, "column": 1, "source_cell": "B1"},
                    {"row": 1, "column": 0, "source_cell": "A2"},
                ],
            },
        ]

        result, payload = self._save(links)

        self.assertEqual(payload["external_links"], links)
        self.assertEqual(result["external_links"], links)

    def test_load_returns_normalized_external_links(self) -> None:
        stored = copy.deepcopy(self.existing)
        stored["external_links"] = [
            {
                "reference": "  ='C:\\Data\\[Book.xlsx]Sheet 1'!A1  ",
                "target_cells": [
                    {"row": 1, "column": 1},
                    {"row": 1, "column": 1},
                ],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
                "target_cells": [{"row": 2, "column": 2}],
            },
            {
                "reference": "='C:\\Data\\[Other.xlsx]Sheet 1'!A1",
                "target_cells": [{"row": 1, "column": 1}],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
                "target_cells": [{"row": 3, "column": 3}],
            },
            {"reference": "", "target_cells": [{"row": 9, "column": 9}]},
        ]

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=stored),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Class", "Dataset")

        self.assertEqual(result["external_links"], [
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
                "target_cells": [{"row": 1, "column": 1, "source_cell": "A1"}],
            },
            {
                "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
                "target_cells": [{"row": 2, "column": 2, "source_cell": "A1"}],
            },
        ])

    def test_sidecar_failure_restores_the_previous_dataset_csv(self) -> None:
        dataframe = dataset_service.pd.DataFrame([[1.0]])
        with (
            patch.object(dataset_service.os.path, "exists", return_value=True),
            patch.object(dataset_service.shutil, "copy2") as copy_csv,
            patch.object(dataset_service, "atomic_write_csv") as write_csv,
            patch.object(
                dataset_service,
                "_write_dataset_sidecar_payload",
                side_effect=HTTPException(423, "sidecar locked"),
            ),
            patch.object(dataset_service.os, "replace") as restore_csv,
            patch.object(dataset_service.os, "remove"),
        ):
            with self.assertRaises(HTTPException) as raised:
                dataset_service._write_dataset_csv_and_sidecar(
                    dataframe,
                    "dataset.csv",
                    "dataset.json",
                    {"external_links": []},
                )

        self.assertEqual(raised.exception.status_code, 423)
        copy_csv.assert_called_once()
        write_csv.assert_called_once_with(dataframe, "dataset.csv")
        restore_csv.assert_called_once()

    def test_failed_csv_restore_retains_the_recovery_copy(self) -> None:
        dataframe = dataset_service.pd.DataFrame([[1.0]])
        with (
            patch.object(dataset_service.os.path, "exists", return_value=True),
            patch.object(dataset_service.shutil, "copy2"),
            patch.object(dataset_service, "atomic_write_csv"),
            patch.object(
                dataset_service,
                "_write_dataset_sidecar_payload",
                side_effect=HTTPException(423, "sidecar locked"),
            ),
            patch.object(
                dataset_service.os,
                "replace",
                side_effect=PermissionError("dataset CSV is locked"),
            ),
            patch.object(dataset_service.os, "remove") as remove_file,
        ):
            with self.assertRaises(HTTPException) as raised:
                dataset_service._write_dataset_csv_and_sidecar(
                    dataframe,
                    "dataset.csv",
                    "dataset.json",
                    {"external_links": []},
                )

        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("Recovery copy retained at", raised.exception.detail)
        remove_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
