from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

_MACRO_PATH = Path(__file__).resolve().parents[1] / "macros" / "link_notes_to_method_values.py"


def load_macro_module():
    spec = importlib.util.spec_from_file_location(
        "link_notes_to_method_values_under_test", _MACRO_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the notes-linking macro.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MACRO = load_macro_module()

PAYLOAD = {
    "details_tab": {
        "name": "C 12 - Paid LDF",
        "output_type": "Paid Ultimate",
        "output_dataset": "C 12 - Paid Ultimate",
        "output_category": "Ultimates",
        "input_triangle": "A 01 - Net Loss--Paid",
        "origin_length": 12,
        "development_length": 12,
    },
    "data_tab": {
        "origin_labels": ["2023", "2024", "2025"],
        "development_labels": ["8m", "20m", "32m", "44m"],
    },
    "ratios_tab": {
        "ratio_triangle": {
            "development_labels": ["(1) 8-20", "(2) 20-32", "(3) 32-44", "44 - Ult"],
        },
        "average_formulas": {"label": ["Simple - 2", "Volume Weighted - 5"]},
    },
    "results_tab": {"ratio_basis_dataset": "B 07 - Earned Premium"},
}


def link(notes, payload=PAYLOAD):
    return MACRO.link_notes_to_method_values(notes, payload)[0]


class LinkNotesToMethodValuesTests(unittest.TestCase):
    def test_ratio_column_label_becomes_its_placeholder(self):
        self.assertEqual(
            link("Selected the (3) 32-44 factor by hand."),
            "Selected the {ratio_development_label(3)} factor by hand.",
        )

    def test_decorated_origin_label_keeps_its_decoration(self):
        self.assertEqual(
            link("AY 2025 is thin; 2023 is mature."),
            "AY {origin_label(3)} is thin; {origin_label(1)} is mature.",
        )

    def test_development_label_and_month_phrase(self):
        self.assertEqual(
            link("At 8m the triangle holds 12 months of origin period."),
            "At {development_label(1)} the triangle holds {origin_length} months of origin period.",
        )

    def test_month_phrase_without_an_origin_word_reads_the_development_length(self):
        self.assertEqual(link("Factors sit on 12-month steps."), "Factors sit on {development_length}-month steps.")

    def test_names_and_average_row_labels(self):
        self.assertEqual(
            link("C 12 - Paid LDF selects Simple - 2 off A 01 - Net Loss--Paid."),
            "{name} selects {average_formula_label(1)} off {input_triangle}.",
        )

    def test_longest_label_wins_over_a_shorter_one_inside_it(self):
        payload = {"data_tab": {"origin_labels": ["2025", "2025 Q3"]}}
        self.assertEqual(
            MACRO.link_notes_to_method_values("Written for 2025 Q3.", payload)[0],
            "Written for {origin_label(2)}.",
        )

    def test_a_label_inside_a_longer_token_is_left_alone(self):
        self.assertEqual(link("Valued 2025-06-30, ref 2025A."), "Valued 2025-06-30, ref 2025A.")

    def test_existing_placeholders_and_stray_braces_are_untouched(self):
        notes = "{origin_label(3)} and {ratio_development_label(3)} stay."
        self.assertEqual(link(notes), notes)
        self.assertEqual(link("Cost {approx 2025 by hand"), "Cost {approx 2025 by hand")

    def test_running_twice_changes_nothing(self):
        once = link("The (3) 32-44 ratio for AY 2025.")
        self.assertEqual(link(once), once)

    def test_a_short_bare_number_is_never_linked(self):
        payload = {"data_tab": {"development_labels": ["12", "24"]}}
        self.assertEqual(
            MACRO.link_notes_to_method_values("We kept 12 of 24 points.", payload)[0],
            "We kept 12 of 24 points.",
        )


class SelectedTextTests(unittest.TestCase):
    NOTES = "Kept (1) 8-20 as is; reset (2) 20-32 and (3) 32-44."

    def linked(self, selection):
        return MACRO.link_notes_to_method_values(self.NOTES, PAYLOAD, selection)[0]

    def test_only_the_selected_stretch_is_rewritten(self):
        start = self.NOTES.index("(2) 20-32")
        self.assertEqual(
            self.linked({"start": start, "end": len(self.NOTES)}),
            "Kept (1) 8-20 as is; reset {ratio_development_label(2)} and {ratio_development_label(3)}.",
        )

    def test_an_empty_selection_means_the_whole_note(self):
        self.assertEqual(self.linked({"start": 9, "end": 9}), self.linked(None))

    def test_a_phrase_running_past_the_selection_is_left_alone(self):
        start = self.NOTES.index("(2) 20-32")
        self.assertEqual(self.linked({"start": start, "end": start + 4}), self.NOTES)

    def test_a_stray_brace_outside_the_selection_still_protects_its_line(self):
        notes = "Cost {approx 2025 and 2024 too"
        start = notes.index("2024")
        self.assertEqual(
            MACRO.link_notes_to_method_values(notes, PAYLOAD, {"start": start, "end": len(notes)})[0],
            notes,
        )

    def test_an_unusable_selection_falls_back_to_the_whole_note(self):
        self.assertEqual(self.linked({"start": "x", "end": None}), self.linked(None))


class RunMacroTests(unittest.TestCase):
    class FakeDfm:
        def __init__(self, notes):
            self._notes = notes
            self.updated = None

        @property
        def notes(self):
            return self._notes

        def update_notes(self, text):
            self.updated = text
            self._notes = text
            return self

        def to_dict(self):
            return dict(PAYLOAD)

    def test_run_macro_reports_and_applies_the_linked_note(self):
        dfm = self.FakeDfm("Selected the (3) 32-44 factor.")
        result = MACRO.run_macro(dfm)
        self.assertTrue(result["success"])
        self.assertTrue(result["preview"]["has_changes"])
        self.assertEqual(dfm.updated, "Selected the {ratio_development_label(3)} factor.")

    def test_run_macro_leaves_a_note_with_nothing_to_link(self):
        dfm = self.FakeDfm("Nothing here matches the method.")
        result = MACRO.run_macro(dfm)
        self.assertTrue(result["success"])
        self.assertFalse(result["preview"]["has_changes"])
        self.assertIsNone(dfm.updated)

    def test_run_macro_without_an_active_dfm(self):
        self.assertFalse(MACRO.run_macro(None)["success"])

    def test_run_macro_honours_the_notes_selection_from_the_page(self):
        notes = "Kept (1) 8-20 as is; reset (3) 32-44."
        dfm = self.FakeDfm(notes)
        start = notes.index("(3) 32-44")
        result = MACRO.run_macro(
            dfm, {"notesSelection": {"start": start, "end": len(notes)}}
        )
        self.assertEqual(
            dfm.updated, "Kept (1) 8-20 as is; reset {ratio_development_label(3)}."
        )
        self.assertIn("the selected text", result["message"])


if __name__ == "__main__":
    unittest.main()
