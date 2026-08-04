"""On-disk text layout of persisted ArcRho JSON.

``arcrho_api.io`` owns the layout: two-dimensional arrays render one row per
line, everything else keeps the two-space form.  These tests pin that shape, pin
the property that makes it safe to adopt everywhere -- a payload with no 2D array
is byte-identical to the ``json.dumps(indent=2)`` text it replaces -- and prove
every producer emits the same bytes for the same payload.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_PYTHON_API = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_API.parent
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))
sys.path.insert(0, str(_REPO_ROOT / "frontend"))

from arcrho_api.io import format_json_for_save, persisted_json_text  # noqa: E402


_TRIANGLE = {
    "ratios tab": {
        "ratio triangle": {
            "origin labels": ["2020", "2021"],
            "ratio values": [[1.5, 1.25], [1.4]],
            "excluded": [[False, True], [False]],
        }
    }
}


class LayoutTests(unittest.TestCase):
    def test_two_dimensional_arrays_render_one_row_per_line(self) -> None:
        text = persisted_json_text(_TRIANGLE)
        self.assertIn('      "ratio values": [\n        [1.5, 1.25],\n        [1.4]\n      ],', text)

    def test_one_dimensional_arrays_keep_one_value_per_line(self) -> None:
        # Only the 2D case is compacted; a plain vector stays in the familiar form.
        text = persisted_json_text({"origin labels": ["2020", "2021"]})
        self.assertEqual(text, '{\n  "origin labels": [\n    "2020",\n    "2021"\n  ]\n}\n')

    def test_empty_containers_render_inline(self) -> None:
        self.assertEqual(persisted_json_text({"a": [], "b": {}}), '{\n  "a": [],\n  "b": {}\n}\n')

    def test_a_row_of_rows_nested_under_a_list_is_still_compacted(self) -> None:
        text = persisted_json_text([{"values": [[1, 2]]}])
        self.assertIn('"values": [\n      [1, 2]\n    ]', text)

    def test_document_ends_with_exactly_one_newline(self) -> None:
        self.assertEqual(persisted_json_text(_TRIANGLE)[-2:], "}\n")

    def test_text_parses_back_to_the_same_payload(self) -> None:
        self.assertEqual(json.loads(persisted_json_text(_TRIANGLE)), _TRIANGLE)

    def test_non_ascii_is_written_raw(self) -> None:
        self.assertIn("Ratio é", persisted_json_text({"name": "Ratio é"}))


class DropInEquivalenceTests(unittest.TestCase):
    """A payload with no 2D array must land on disk exactly as before.

    This is what makes the canonical writer safe to adopt for every persisted
    file at once: only files that actually hold a triangle change on disk.
    """

    PAYLOADS = (
        {"version": 3, "rows": None, "labels": ["a", "b"], "nested": {"x": [1, 2, 3]}},
        {"a": [], "b": {}, "c": "", "d": None, "e": 1.5, "f": True},
        {"list of objects": [{"n": 1}, {"n": 2}]},
    )

    def test_matches_the_previous_indent_two_text(self) -> None:
        for payload in self.PAYLOADS:
            with self.subTest(payload=payload):
                self.assertEqual(
                    persisted_json_text(payload),
                    json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                )

    def test_a_payload_with_a_triangle_is_the_only_kind_that_changes(self) -> None:
        self.assertNotEqual(
            persisted_json_text(_TRIANGLE),
            json.dumps(_TRIANGLE, indent=2, ensure_ascii=False) + "\n",
        )


class ProducerParityTests(unittest.TestCase):
    """Every producer of persisted ArcRho JSON emits the canonical bytes."""

    def _temp_path(self) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Path(directory.name) / "method.json"

    def test_app_server_method_writers_delegate_to_the_canonical_text(self) -> None:
        from app_server.services import bornhuetter_ferguson_service, dfm_service
        from app_server.services import result_selection_service

        expected = persisted_json_text(_TRIANGLE)
        for service in (dfm_service, bornhuetter_ferguson_service, result_selection_service):
            with self.subTest(service=service.__name__):
                self.assertEqual(service._json_text(_TRIANGLE), expected)

    def test_migration_writes_the_canonical_text(self) -> None:
        from resq_migration import core

        path = self._temp_path()
        core._write_json(path, _TRIANGLE)
        self.assertEqual(path.read_text(encoding="utf-8"), persisted_json_text(_TRIANGLE))

    def test_public_api_atomic_write_uses_the_canonical_text(self) -> None:
        from arcrho_api.io import write_json_atomic

        path = self._temp_path()
        write_json_atomic(path, _TRIANGLE)
        self.assertEqual(path.read_text(encoding="utf-8"), persisted_json_text(_TRIANGLE))

    def test_format_and_document_text_differ_only_by_the_trailing_newline(self) -> None:
        self.assertEqual(persisted_json_text(_TRIANGLE), format_json_for_save(_TRIANGLE) + "\n")


if __name__ == "__main__":
    unittest.main()
