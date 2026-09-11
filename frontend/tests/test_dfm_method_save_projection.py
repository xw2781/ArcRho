"""The DFM save route hands the Engine exactly the arguments the service takes."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app_server.api.dfm_method_router import _dfm_method_save_call  # noqa: E402
from app_server.schemas.dfm_method import DfmMethodSaveRequest  # noqa: E402


class DfmMethodSaveProjectionTests(unittest.TestCase):
    def request(self, **fields) -> DfmMethodSaveRequest:
        return DfmMethodSaveRequest(
            project_name="Project",
            reserving_class="Class",
            method={"json_format": "arcrho-dfm-v4"},
            **fields,
        )

    def test_placeholder_source_travels_with_the_rendered_notes(self) -> None:
        call = _dfm_method_save_call(
            self.request(notes="Latest origin 2025.", notes_source="Latest origin {origin_label(-1)}.")
        )
        self.assertEqual(call["args"], ["Project", "Class", {"json_format": "arcrho-dfm-v4"}])
        self.assertEqual(call["kwargs"]["notes"], "Latest origin 2025.")
        self.assertEqual(call["kwargs"]["notes_source"], "Latest origin {origin_label(-1)}.")

    def test_a_note_without_placeholders_keeps_the_old_argument_shape(self) -> None:
        # An Engine built before the field exists refuses an unknown keyword,
        # so a plain save must not carry one.
        for fields in ({"notes": "plain"}, {"notes": "plain", "notes_source": ""}, {}):
            with self.subTest(fields=fields):
                call = _dfm_method_save_call(self.request(**fields))
                self.assertNotIn("notes_source", call["kwargs"])
                self.assertEqual(
                    sorted(call["kwargs"]),
                    ["expected_derived_revision", "expected_owned_revision", "notes"],
                )


if __name__ == "__main__":
    unittest.main()
