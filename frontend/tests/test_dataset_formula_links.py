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
from app_server.services import dataset_formula_link_service
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace


FORMULA = "=[C 82 - Prior Qtr Selected][1:2] * 2"
TARGETS = [
    {"row": 0, "column": 0, "result_row": 0, "result_column": 0},
    {"row": 1, "column": 0, "result_row": 1, "result_column": 0},
]


class FormulaCanonicalTextTests(unittest.TestCase):
    def test_canonical_text_matches_the_client_grammar(self) -> None:
        cases = {
            "[ C 82 - Prior Qtr Selected ][ 1 : 2 ]*2": FORMULA,
            "=('c:\\data\\[book.xlsx]sheet 1'!a1:a3 + [C 82][1:3])/1000": (
                "=('c:\\data\\[book.xlsx]sheet 1'!A1:A3 + [C 82][1:3]) / 1000"
            ),
            "=-[A][1]^2+3*(2-1)": "=-[A][1] ^ 2 + 3 * (2 - 1)",
            "='C:\\It''s\\[Book.xlsx]Sheet'!$B$2:$B$2 * 1.50": "='C:\\It''s\\[Book.xlsx]Sheet'!B2 * 1.50",
            "=[Paid Claims][2 , 1:2] - 1": "=[Paid Claims][2, 1:2] - 1",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(dataset_formula_link_service.canonical_dataset_formula(raw), expected)

    def test_rejects_formulas_outside_the_grammar(self) -> None:
        invalid = (
            "",
            "=2 * 3",
            "=[C 82][1:7] *",
            "=[C 82]",
            "=[C 82][1:7] $ 2",
            "=([C 82][1:7] * 2",
            "='C:\\Data\\Book.xlsx'!A1 * 2",
            "=[C 82][1:2:3] * 2",
        )
        for text in invalid:
            with self.subTest(text=text):
                with self.assertRaises(HTTPException) as raised:
                    dataset_formula_link_service.canonical_dataset_formula(text)
                self.assertEqual(raised.exception.status_code, 422)


class FormulaLinkSchemaTests(unittest.TestCase):
    def _request(self, formula_links):
        return DatasetSidecarSaveRequest(
            project_name="Project",
            reserving_class="Class",
            dataset_name="Dataset",
            origin_length=12,
            development_length=12,
            formula_links=formula_links,
        )

    def test_accepts_nonnegative_coordinates(self) -> None:
        request = self._request([{"formula": f" {FORMULA} ", "target_cells": TARGETS}])
        self.assertEqual(request.formula_links[0].formula, FORMULA)

    def test_rejects_blank_formula_negative_coords_and_empty_targets(self) -> None:
        invalid_links = (
            [{"formula": "  ", "target_cells": TARGETS}],
            [{"formula": FORMULA, "target_cells": [{"row": -1, "column": 0, "result_row": 0, "result_column": 0}]}],
            [{"formula": FORMULA, "target_cells": [{"row": 0, "column": 0, "result_row": 0}]}],
            [{"formula": FORMULA, "target_cells": []}],
        )
        for formula_links in invalid_links:
            with self.subTest(formula_links=formula_links):
                with self.assertRaises(ValidationError):
                    self._request(formula_links)


class FormulaLinkNormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def test_normalizes_formula_text_and_deduplicates_exact_links(self) -> None:
        normalized = dataset_service._normalize_dataset_formula_links([
            {"formula": " [ C 82 - Prior Qtr Selected ][ 1:2 ]*2 ", "target_cells": TARGETS},
            {"formula": FORMULA, "target_cells": TARGETS},
        ], strict=True)

        self.assertEqual(normalized, [{"formula": FORMULA, "target_cells": TARGETS}])

    def test_invalid_direct_service_input_raises_http_400(self) -> None:
        invalid_values = (
            "not-a-list",
            [{"formula": "=2 * 3", "target_cells": TARGETS}],
            [{"formula": FORMULA, "target_cells": []}],
            [{"formula": FORMULA, "target_cells": [{"row": True, "column": 0, "result_row": 0, "result_column": 0}]}],
            [{"formula": FORMULA, "target_cells": [{"row": 0, "column": 0, "result_row": 0}]}],
            [
                {
                    "formula": FORMULA,
                    "target_cells": [
                        {"row": 0, "column": 0, "result_row": 0, "result_column": 0},
                        {"row": 0, "column": 0, "result_row": 1, "result_column": 0},
                    ],
                },
            ],
            [
                {"formula": FORMULA, "target_cells": TARGETS[:1]},
                {"formula": "=[C 84][1] + 1", "target_cells": TARGETS[:1]},
            ],
        )
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaises(HTTPException) as raised:
                    dataset_service._normalize_dataset_formula_links(value, strict=True)
                self.assertEqual(raised.exception.status_code, 400)


class FormulaLinkSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()
        self.existing_links = [{"formula": FORMULA, "target_cells": copy.deepcopy(TARGETS)}]
        self.existing = {
            "dataset_name": "Dataset",
            "dataset_type": "Input Type",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "input",
            "data_format": "Vector",
            "period_length": 12,
            "formula_links": copy.deepcopy(self.existing_links),
        }

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def _save(self, formula_links=None, *, internal_links=None, external_links=None):
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
                formula_links=formula_links,
                internal_links=internal_links,
                external_links=external_links,
            )

        return result, written["payload"]

    def test_omitted_formula_links_preserves_existing_and_empty_clears(self) -> None:
        result, payload = self._save()
        self.assertEqual(payload["formula_links"], self.existing_links)
        self.assertEqual(result["formula_links"], self.existing_links)

        result, payload = self._save([])
        self.assertEqual(payload["formula_links"], [])
        self.assertEqual(result["formula_links"], [])

    def test_save_persists_canonical_formula_links(self) -> None:
        links = [{"formula": "=[C 82 - Prior Qtr Selected][4]*1.5", "target_cells": [
            {"row": 3, "column": 0, "result_row": 0, "result_column": 0},
        ]}]
        expected = [{"formula": "=[C 82 - Prior Qtr Selected][4] * 1.5", "target_cells": links[0]["target_cells"]}]

        result, payload = self._save(links)

        self.assertEqual(payload["formula_links"], expected)
        self.assertEqual(result["formula_links"], expected)

    def test_save_rejects_a_cell_owned_by_two_kinds_of_link(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._save(
                [{"formula": FORMULA, "target_cells": TARGETS[:1]}],
                internal_links=[{
                    "reference": "=[C 82 - Prior Qtr Selected][1]",
                    "target_cells": [{"row": 0, "column": 0, "source_row": 0, "source_column": 0}],
                }],
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_load_returns_normalized_formula_links(self) -> None:
        stored = copy.deepcopy(self.existing)
        stored["formula_links"] = [
            {"formula": " [C 82 - Prior Qtr Selected][ 1:2 ]*2 ", "target_cells": TARGETS},
            # A second link claiming an owned cell is dropped on load.
            {"formula": "=[C 84][1] + 1", "target_cells": TARGETS[:1]},
            {"formula": "", "target_cells": [{"row": 9, "column": 0, "result_row": 0, "result_column": 0}]},
        ]

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value=stored),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Class", "Dataset")

        self.assertEqual(result["formula_links"], [{"formula": FORMULA, "target_cells": TARGETS}])


if __name__ == "__main__":
    unittest.main()
