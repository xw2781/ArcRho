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
from app_server.services import dataset_internal_link_service
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace


def _vector_dataset(name="C 82 - Prior Qtr Selected"):
    return {
        "dataset_name": name,
        "data_format": "Vector",
        "origin_labels": ["2017", "2018", "2019", "2020", "2021", "2022"],
        "dev_labels": ["Value"],
        "values": [[14802.0], [15434.0], [14777.0], [12837.0], [15926.0], [None]],
    }


def _triangle_dataset(name="Paid Claims"):
    return {
        "dataset_name": name,
        "data_format": "Triangle",
        "origin_labels": ["2023", "2024"],
        "dev_labels": ["12", "24"],
        "values": [[10.0, 20.0], [30.0, None]],
    }


class InternalReferenceParseTests(unittest.TestCase):
    def test_parses_single_range_and_triangle_forms(self) -> None:
        single = dataset_internal_link_service.parse_internal_reference("=[C 82][4]")
        self.assertEqual(single["dataset_name"], "C 82")
        self.assertEqual(single["row"], {"start": "4", "end": None})
        self.assertIsNone(single["col"])

        ranged = dataset_internal_link_service.parse_internal_reference("[C 82][1:6]")
        self.assertEqual(ranged["row"], {"start": "1", "end": "6"})

        triangle = dataset_internal_link_service.parse_internal_reference(
            '=[Paid Claims]["2024", 1:2]'
        )
        self.assertEqual(triangle["row"], {"start": '"2024"', "end": None})
        self.assertEqual(triangle["col"], {"start": "1", "end": "2"})

    def test_canonical_text_normalizes_spacing_and_keeps_tokens(self) -> None:
        self.assertEqual(
            dataset_internal_link_service.canonical_internal_reference("  [ C 82 ][ 1 : 6 ]  "),
            "=[C 82][1:6]",
        )
        self.assertEqual(
            dataset_internal_link_service.canonical_internal_reference("=[Paid Claims][2 , 1:2]"),
            "=[Paid Claims][2, 1:2]",
        )

    def test_rejects_non_standalone_or_malformed_references(self) -> None:
        invalid = (
            "=[C 82][1] + 1",
            "=[C 82]",
            "=[C 82][]",
            "=[][1]",
            "=[C 82][1, 2, 3]",
            "=[C 82][1:2:3]",
            '=[C 82]["2017]',
            "=1.5",
        )
        for text in invalid:
            with self.subTest(text=text):
                with self.assertRaises(HTTPException) as raised:
                    dataset_internal_link_service.parse_internal_reference(text)
                self.assertEqual(raised.exception.status_code, 422)


class InternalReferenceResolveTests(unittest.TestCase):
    def _resolve(self, references, datasets=None):
        loaded = []
        by_name = {}
        for dataset in datasets or [_vector_dataset()]:
            by_name[dataset["dataset_name"].casefold()] = dataset

        def load(project, reserving_class, name):
            loaded.append((project, reserving_class, name))
            return by_name[str(name).casefold()]

        with patch.object(
            dataset_service, "load_cached_dataset_values", side_effect=load
        ):
            result = dataset_internal_link_service.resolve_dataset_internal_links(
                "Project", "Class", references
            )
        return result, loaded

    def test_resolves_a_row_range_with_labels_values_and_one_read(self) -> None:
        result, loaded = self._resolve([
            "=[C 82 - Prior Qtr Selected][1:3]",
            "=[c 82 - prior qtr selected][\"2020\"]",
        ])

        self.assertEqual(len(loaded), 1)
        first = result["results"][0]
        self.assertEqual(first["row_start"], 0)
        self.assertEqual(first["row_count"], 3)
        self.assertEqual(first["column_count"], 1)
        self.assertEqual(
            [cell["value"] for cell in first["cells"]],
            [14802.0, 15434.0, 14777.0],
        )
        self.assertEqual(first["cells"][0]["row_label"], "2017")
        second = result["results"][1]
        self.assertEqual(second["cells"][0]["value"], 12837.0)
        self.assertEqual(second["cells"][0]["row"], 3)

    def test_numeric_label_negative_index_and_blank_values(self) -> None:
        result, _loaded = self._resolve([
            "=[C 82 - Prior Qtr Selected][2018]",
            "=[C 82 - Prior Qtr Selected][-1]",
            "=[C 82 - Prior Qtr Selected][6]",
        ])

        by_reference = result["results"]
        # 2018 is outside 1..6? No: 2018 > 6 so it resolves as a label.
        self.assertEqual(by_reference[0]["cells"][0]["row_label"], "2018")
        # -1 counts back from the last non-empty row (2021).
        self.assertEqual(by_reference[1]["cells"][0]["row_label"], "2021")
        # Row 6 exists but is blank; a blank source cell resolves to None.
        self.assertIsNone(by_reference[2]["cells"][0]["value"])

    def test_triangle_requires_column_and_rejects_reversed_ranges(self) -> None:
        with self.assertRaises(HTTPException) as missing_column:
            self._resolve(["=[Paid Claims][1]"], datasets=[_triangle_dataset()])
        self.assertEqual(missing_column.exception.status_code, 422)

        with self.assertRaises(HTTPException) as reversed_range:
            self._resolve(["=[C 82 - Prior Qtr Selected][3:1]"])
        self.assertEqual(reversed_range.exception.status_code, 422)

    def test_triangle_rectangle_resolves_row_major(self) -> None:
        result, _loaded = self._resolve(
            ["=[Paid Claims][1:2, 1:2]"], datasets=[_triangle_dataset()]
        )
        cells = result["results"][0]["cells"]
        self.assertEqual(
            [(cell["row"], cell["column"], cell["value"]) for cell in cells],
            [(0, 0, 10.0), (0, 1, 20.0), (1, 0, 30.0), (1, 1, None)],
        )


class InternalLinkSchemaTests(unittest.TestCase):
    def _request(self, internal_links):
        return DatasetSidecarSaveRequest(
            project_name="Project",
            reserving_class="Class",
            dataset_name="Dataset",
            origin_length=12,
            development_length=12,
            internal_links=internal_links,
        )

    def test_accepts_nonnegative_coordinates(self) -> None:
        request = self._request([
            {
                "reference": " =[C 82][1:2] ",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                ],
            },
        ])
        self.assertEqual(request.internal_links[0].reference, "=[C 82][1:2]")

    def test_rejects_blank_reference_negative_coords_and_empty_targets(self) -> None:
        invalid_links = (
            [{"reference": "  ", "target_cells": [{"row": 0, "column": 0, "source_row": 0, "source_column": 0}]}],
            [{"reference": "=[C 82][1]", "target_cells": [{"row": -1, "column": 0, "source_row": 0, "source_column": 0}]}],
            [{"reference": "=[C 82][1]", "target_cells": [{"row": 0, "column": 0, "source_row": 0}]}],
            [{"reference": "=[C 82][1]", "target_cells": []}],
        )
        for internal_links in invalid_links:
            with self.subTest(internal_links=internal_links):
                with self.assertRaises(ValidationError):
                    self._request(internal_links)


class InternalLinkNormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def test_normalizes_reference_text_and_deduplicates_exact_links(self) -> None:
        normalized = dataset_service._normalize_dataset_internal_links([
            {
                "reference": " [ C 82 ][ 1 : 2 ] ",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
            {
                "reference": "=[C 82][1:2]",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
        ], strict=True)

        self.assertEqual(normalized, [
            {
                "reference": "=[C 82][1:2]",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
        ])

    def test_invalid_direct_service_input_raises_http_400(self) -> None:
        invalid_values = (
            "not-a-list",
            [{"reference": "=[C 82][1] + 1", "target_cells": [{"row": 0, "column": 0, "source_row": 0, "source_column": 0}]}],
            [{"reference": "=[C 82][1]", "target_cells": []}],
            [{"reference": "=[C 82][1]", "target_cells": [{"row": True, "column": 0, "source_row": 0, "source_column": 0}]}],
            [{"reference": "=[C 82][1]", "target_cells": [{"row": 0, "column": 0, "source_row": 0}]}],
            [
                {
                    "reference": "=[C 82][1:2]",
                    "target_cells": [
                        {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                        {"row": 0, "column": 0, "source_row": 1, "source_column": 0},
                    ],
                },
            ],
            [
                {"reference": "=[C 82][1]", "target_cells": [{"row": 0, "column": 0, "source_row": 0, "source_column": 0}]},
                {"reference": "=[C 84][1]", "target_cells": [{"row": 0, "column": 0, "source_row": 0, "source_column": 0}]},
            ],
        )
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaises(HTTPException) as raised:
                    dataset_service._normalize_dataset_internal_links(value, strict=True)
                self.assertEqual(raised.exception.status_code, 400)


class InternalLinkSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()
        self.existing_links = [
            {
                "reference": "=[C 82 - Prior Qtr Selected][1:2]",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
        ]
        self.existing = {
            "dataset_name": "Dataset",
            "dataset_type": "Input Type",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "input",
            "data_format": "Vector",
            "period_length": 12,
            "internal_links": copy.deepcopy(self.existing_links),
            "unknown_extension_field": {"preserve": True},
        }

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def _save(self, internal_links=None, *, external_links=None):
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
                data_format="Vector",
                origin_length=12,
                development_length=12,
                internal_links=internal_links,
                external_links=external_links,
            )

        return result, written["payload"]

    def test_omitted_internal_links_preserves_existing_and_unknown_fields(self) -> None:
        result, payload = self._save()

        self.assertEqual(payload["internal_links"], self.existing_links)
        self.assertEqual(payload["unknown_extension_field"], {"preserve": True})
        self.assertEqual(result["internal_links"], self.existing_links)

    def test_empty_internal_links_clears_existing_links(self) -> None:
        result, payload = self._save([])

        self.assertEqual(payload["internal_links"], [])
        self.assertEqual(result["internal_links"], [])

    def test_save_persists_explicit_internal_links(self) -> None:
        links = [
            {
                "reference": "=[C 82 - Prior Qtr Selected][4]",
                "target_cells": [
                    {"row": 3, "column": 0, "source_row": 3, "source_column": 0},
                ],
            },
        ]

        result, payload = self._save(links)

        self.assertEqual(payload["internal_links"], links)
        self.assertEqual(result["internal_links"], links)

    def test_save_rejects_a_cell_linked_to_both_excel_and_a_dataset(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._save(
                [
                    {
                        "reference": "=[C 82 - Prior Qtr Selected][1]",
                        "target_cells": [
                            {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                        ],
                    },
                ],
                external_links=[
                    {
                        "reference": "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
                        "target_cells": [{"row": 0, "column": 0, "source_cell": "A1"}],
                    },
                ],
            )

        self.assertEqual(raised.exception.status_code, 400)

    def test_load_returns_normalized_internal_links(self) -> None:
        stored = copy.deepcopy(self.existing)
        stored["internal_links"] = [
            {
                "reference": " [C 82 - Prior Qtr Selected][ 1:2 ] ",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
            # A second link claiming an owned cell is dropped on load.
            {
                "reference": "=[C 84][1]",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                ],
            },
            {"reference": "", "target_cells": [{"row": 9, "column": 0, "source_row": 0, "source_column": 0}]},
        ]

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=stored),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Class", "Dataset")

        self.assertEqual(result["internal_links"], [
            {
                "reference": "=[C 82 - Prior Qtr Selected][1:2]",
                "target_cells": [
                    {"row": 0, "column": 0, "source_row": 0, "source_column": 0},
                    {"row": 1, "column": 0, "source_row": 1, "source_column": 0},
                ],
            },
        ])


class InternalLinkReadContractTests(unittest.TestCase):
    def test_resolve_read_kind_is_registered(self) -> None:
        import arcrho_workspace_read_contract as contract

        spec = contract.WORKSPACE_READ_KINDS["dataset_internal_links_resolve"]
        self.assertEqual(spec.module, "dataset_internal_link_service")
        self.assertEqual(spec.function, "resolve_dataset_internal_links")
        self.assertEqual(
            set(spec.required), {"project_name", "reserving_class", "references"}
        )


if __name__ == "__main__":
    unittest.main()
