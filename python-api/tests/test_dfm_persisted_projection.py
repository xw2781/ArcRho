"""On-disk projection of a DFM method.

The persisted file omits ``input data triangle mask`` and trims trailing nulls
from each input row.  Both are recoverable on read, so these tests pin the exact
round trip, prove the canonical payload and all three revisions are unchanged,
and check both producers persist the same parsed payload.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_API.parent
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))
sys.path.insert(0, str(_REPO_ROOT / "frontend"))

from arcrho_api.dfm_contract import (  # noqa: E402
    DFM_JSON_FORMAT,
    method_revisions,
    normalize_dfm_method,
    persisted_projection,
    recalculate_dfm_method,
)
from arcrho_api.io import persisted_json_text  # noqa: E402
from app_server.services import dfm_service as app_dfm_service  # noqa: E402


_ORIGINS = ["2020", "2021", "2022", "2023"]
_DEVS = ["12m", "24m", "36m", "48m"]
# Row 2 carries an interior null: a value missing *inside* the triangle, which
# must survive trimming, unlike the trailing nulls that sit outside it.
_VALUES = [
    [100, 150, 180, 195],
    [200, 300, 330, None],
    [400, None, 460, None],
    [800, None, None, None],
]
_EXPECTED_TRIMMED = [
    [100, 150, 180, 195],
    [200, 300, 330],
    [400, None, 460],
    [800],
]


def _owned() -> dict:
    return {
        "json_format": DFM_JSON_FORMAT,
        "details_tab": {
            "name": "Paid DFM",
            "output_type": "Paid Ultimate",
            "output_dataset": "Paid Selected",
            "output_category": "Loss",
            "input_triangle": "Paid Loss",
            "origin_length": 12,
            "development_length": 12,
            "decimal_places": 2,
        },
        "ratios_tab": {"ratio_triangle": {"excluded": [[1, 0, 0], [0, 0], [0], []]}},
        "results_tab": {"ratio_basis_dataset": "Premium", "ultimate_ratio_decimal_places": 2},
        "method_metadata": {"last_modified": "t0", "data_refreshed": "t0"},
    }


def _input_snapshot(values=None) -> dict:
    values = _VALUES if values is None else values
    return {
        "name": "Paid Loss",
        "origin_labels": list(_ORIGINS),
        "development_labels": list(_DEVS),
        "values": [list(row) for row in values],
        "mask": [[value is not None for value in row] for row in values],
        "data_format": "Triangle",
        "number_format": "#,##0",
        "decimal_places": 0,
    }


def _basis() -> dict:
    return {
        "name": "Premium",
        "origin_labels": list(_ORIGINS),
        "values": [1000, 2000, 3000, 4000],
        "data_format": "Vector",
        "number_format": "$#,##0",
        "decimal_places": 0,
    }


def _canonical() -> dict:
    return recalculate_dfm_method(
        _owned(),
        input_snapshot=_input_snapshot(),
        ratio_basis_snapshot=_basis(),
        timestamp="t0",
    )


class PersistedProjectionTests(unittest.TestCase):
    def test_persisted_form_omits_mask_and_trims_trailing_nulls(self) -> None:
        persisted = persisted_projection(_canonical())
        data = persisted["data_tab"]
        self.assertNotIn("input_data_triangle_mask", data)
        self.assertEqual(data["input_data_triangle_values"], _EXPECTED_TRIMMED)

    def test_interior_null_survives_trimming(self) -> None:
        row = persisted_projection(_canonical())["data_tab"]["input_data_triangle_values"][2]
        # Missing inside the triangle stays explicit; only the trailing null goes.
        self.assertEqual(row, [400, None, 460])

    def test_round_trip_restores_the_exact_canonical_payload(self) -> None:
        canonical = _canonical()
        reloaded = normalize_dfm_method(json.loads(json.dumps(persisted_projection(canonical))))
        self.assertEqual(reloaded, canonical)

    def test_projection_is_idempotent(self) -> None:
        once = persisted_projection(_canonical())
        self.assertEqual(persisted_projection(once), once)

    def test_projection_does_not_mutate_its_input(self) -> None:
        canonical = _canonical()
        before = json.loads(json.dumps(canonical))
        persisted_projection(canonical)
        self.assertEqual(canonical, before)

    def test_all_three_revisions_are_unchanged(self) -> None:
        canonical = _canonical()
        reloaded = normalize_dfm_method(json.loads(json.dumps(persisted_projection(canonical))))
        self.assertEqual(method_revisions(reloaded), method_revisions(canonical))

    def test_legacy_rectangular_file_normalizes_identically(self) -> None:
        # A file written before this change carries the mask and full-width rows.
        canonical = _canonical()
        legacy = json.loads(json.dumps(canonical))
        self.assertIn("input_data_triangle_mask", legacy["data_tab"])
        self.assertTrue(
            all(len(row) == len(_DEVS) for row in legacy["data_tab"]["input_data_triangle_values"])
        )
        new_form = json.loads(json.dumps(persisted_projection(canonical)))
        self.assertEqual(normalize_dfm_method(legacy), normalize_dfm_method(new_form))


class CrossProducerParityTests(unittest.TestCase):
    def test_app_server_and_migration_persist_the_same_bytes(self) -> None:
        canonical = _canonical()
        app_text = app_dfm_service._method_json_text(canonical)
        migration_text = persisted_json_text(persisted_projection(canonical))
        # Not just the same payload: the same file. A GUI save must not reshape
        # a migrated file, and a migration must not reshape a saved one.
        self.assertEqual(app_text, migration_text)

    def test_the_triangles_are_stored_one_row_per_line(self) -> None:
        lines = app_dfm_service._method_json_text(_canonical()).splitlines()
        for key in ("input_data_triangle_values", "ratio_values", "excluded"):
            with self.subTest(key=key):
                opened = next(i for i, line in enumerate(lines) if line.strip() == f'"{key}": [')
                # The line after the key is a whole row, not the row's first cell.
                self.assertTrue(lines[opened + 1].strip().startswith("["))

    def test_both_producers_drop_the_mask_and_trim(self) -> None:
        canonical = _canonical()
        for text in (
            app_dfm_service._method_json_text(canonical),
            persisted_json_text(persisted_projection(canonical)),
        ):
            data = json.loads(text)["data_tab"]
            self.assertNotIn("input_data_triangle_mask", data)
            self.assertEqual(data["input_data_triangle_values"], _EXPECTED_TRIMMED)

    def test_unchanged_method_is_not_rewritten(self) -> None:
        # An already-persisted file must compare equal to its own re-projection,
        # otherwise every refresh would rewrite an unchanged file over the network.
        canonical = _canonical()
        on_disk = json.loads(json.dumps(persisted_projection(canonical)))
        self.assertEqual(
            app_dfm_service._method_json_text(on_disk),
            app_dfm_service._method_json_text(canonical),
        )


if __name__ == "__main__":
    unittest.main()
