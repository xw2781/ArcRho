from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api import bootstrap_contract, bornhuetter_ferguson_contract, cape_cod_contract, dfm_contract  # noqa: E402
from arcrho_api.revision_contract import (  # noqa: E402
    FINGERPRINT_HEX_LENGTH,
    FINGERPRINT_PREFIX,
    canonical_projection_text,
    fingerprint,
    is_fingerprint,
)
from test_dfm_contract import basis_snapshot, input_snapshot, owned_payload  # noqa: E402


_SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")


def _field_keys(value, *, skip_under: tuple[str, ...] = ()):
    """Every dict key in *value*, except inside the subtrees named in *skip_under*."""

    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            if key in skip_under:
                continue
            yield from _field_keys(child, skip_under=skip_under)
    elif isinstance(value, list):
        for child in value:
            yield from _field_keys(child, skip_under=skip_under)


class FingerprintProducerTests(unittest.TestCase):
    def test_fingerprint_is_prefixed_and_truncated(self):
        value = fingerprint({"b": 1, "a": [1, 2]})
        self.assertTrue(value.startswith(FINGERPRINT_PREFIX))
        self.assertEqual(len(value), len(FINGERPRINT_PREFIX) + FINGERPRINT_HEX_LENGTH)
        self.assertTrue(is_fingerprint(value))
        self.assertFalse(is_fingerprint(value + "0"))
        self.assertFalse(is_fingerprint("sha256:" + "0" * 64))
        self.assertFalse(is_fingerprint(None))

    def test_fingerprint_ignores_key_order_and_layout(self):
        self.assertEqual(fingerprint({"a": 1, "b": 2}), fingerprint({"b": 2, "a": 1}))
        self.assertEqual(canonical_projection_text({"b": [1, 2], "a": "x"}), '{"a":"x","b":[1,2]}')

    def test_fingerprint_refuses_nan(self):
        with self.assertRaises(ValueError):
            fingerprint({"a": float("nan")})


class MethodContractFingerprintTests(unittest.TestCase):
    def _dfm_method(self):
        return dfm_contract.recalculate_dfm_method(
            owned_payload(),
            input_snapshot=input_snapshot(),
            ratio_basis_snapshot=basis_snapshot(),
        )

    def test_dfm_revisions_and_source_revisions_use_the_shared_form(self):
        method = self._dfm_method()
        for value in dfm_contract.method_revisions(method).values():
            self.assertTrue(is_fingerprint(value), value)
        self.assertTrue(is_fingerprint(method["data_tab"]["source_revision"]))

    def test_dfm_hashed_vocabulary_is_snake_case_whatever_the_persisted_spelling(self):
        method = self._dfm_method()
        for projection in (
            dfm_contract.owned_projection(method),
            dfm_contract.derived_projection(method),
            dfm_contract.publication_projection(method),
        ):
            for key in _field_keys(projection, skip_under=("ratio_main_table", "ratio_summary_table")):
                self.assertRegex(key, _SNAKE_CASE)

    def test_dfm_source_revision_is_independent_of_snapshot_key_spelling(self):
        spaced = {
            "name": "Paid Loss",
            "origin_labels": ["2023", "2024"],
            "development_labels": ["12", "24"],
            "values": [[10, 20], [30, None]],
            "mask": [[True, True], [True, False]],
            "data_format": "Triangle",
            "number_format": "#,##0",
            "decimal_places": 0,
        }
        snake = {
            "name": "Paid Loss",
            "origin_labels": ["2023", "2024"],
            "development_labels": ["12", "24"],
            "values": [[10, 20], [30, None]],
            "mask": [[True, True], [True, False]],
            "data_format": "Triangle",
            "number_format": "#,##0",
            "decimal_places": 0,
        }
        self.assertEqual(
            dfm_contract.source_snapshot_revision(spaced),
            dfm_contract.source_snapshot_revision(snake),
        )

    def test_dfm_hashed_vocabulary_is_fixed(self):
        # The digest covers exactly these keys. A persisted field may be
        # renamed freely; the vocabulary here may not change without moving
        # every stored revision, which is a deliberate breaking change.
        method = self._dfm_method()
        self.assertEqual(
            set(dfm_contract.owned_projection(method)),
            {"details", "excluded_cells", "average_formulas", "cell_notes",
             "ratio_basis_dataset", "ultimate_ratio_decimal_places"},
        )
        self.assertEqual(
            set(dfm_contract.derived_projection(method)),
            {"input", "ratio_triangle", "average_formula_values", "ratio_basis", "ultimate_vector"},
        )
        self.assertEqual(
            set(dfm_contract.publication_projection(method)),
            {"output_dataset", "output_type", "output_category", "origin_length",
             "decimal_places", "origin_labels", "ultimate_vector"},
        )

    def test_every_method_family_stores_the_shared_form(self):
        for module in (bornhuetter_ferguson_contract, cape_cod_contract, bootstrap_contract):
            for value in module.method_revisions({}).values():
                self.assertTrue(is_fingerprint(value), (module.__name__, value))
        self.assertTrue(is_fingerprint(bornhuetter_ferguson_contract._snapshot_revision("a", ["x"], [1])))
        self.assertTrue(is_fingerprint(cape_cod_contract._snapshot_revision("a", ["x"], [1])))
        self.assertTrue(is_fingerprint(bootstrap_contract._snapshot_revision("a", ["x"], [1])))


if __name__ == "__main__":
    unittest.main()
