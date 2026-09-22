"""Cover the DFM Method Notes half of the combined Arco/ResQ review.

The ResQ reads themselves need ResQ, so what is pinned here is everything
around them: where Arco's notes are read from, how two notes that differ only
in line endings or trailing blank lines are judged the same, and what the
record a disagreement produces says.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


_TESTS_DIR = Path(__file__).resolve().parent
_MIGRATION_DIR = _TESTS_DIR.parent / "migration"
_VALIDATION_DIR = _MIGRATION_DIR / "validation"
_MODULE_PATH = _VALIDATION_DIR / "dfm_notes_side_by_side_review.py"
_TMP_ROOT = _TESTS_DIR / "logs" / "tmp"


def load_notes_module():
    for import_root in (_MIGRATION_DIR, _VALIDATION_DIR):
        if str(import_root) not in sys.path:
            sys.path.insert(0, str(import_root))
    spec = importlib.util.spec_from_file_location(
        "dfm_notes_side_by_side_review_under_test", _MODULE_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load dfm_notes_side_by_side_review.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


NOTES = load_notes_module()
RC_PATH = r"HPPREF\HO+DF\NJ\Legacy\HOL"


def _arcrho(notes, *, has_output=True, name="F 13 - Paid DFM"):
    return {"name": name, "notes": notes, "has_output": has_output}


class NormalisedLineTests(unittest.TestCase):
    def test_line_endings_do_not_make_two_notes_differ(self):
        self.assertEqual(
            NOTES._normalized_lines("first\r\nsecond"),
            NOTES._normalized_lines("first\nsecond"),
        )

    def test_trailing_blank_lines_are_dropped(self):
        self.assertEqual(NOTES._normalized_lines("only line\n\n\n"), ["only line"])

    def test_an_empty_note_has_no_lines(self):
        self.assertEqual(NOTES._normalized_lines(None), [])
        self.assertEqual(NOTES._normalized_lines("   \n  "), [])


class RecordTests(unittest.TestCase):
    def test_the_same_note_written_with_resq_line_endings_agrees(self):
        record = NOTES._build_notes_record(
            RC_PATH, "F 13 - Paid DFM", _arcrho("first\nsecond\n\n"), "first\r\nsecond"
        )

        self.assertTrue(record["matches"])
        self.assertFalse(record["needs_review"])
        self.assertEqual(record["note"], "")
        self.assertEqual(record["differing_lines"], 0)
        self.assertEqual([row["same"] for row in record["lines"]], [True, True])

    def test_a_reworded_line_is_named_and_counted(self):
        record = NOTES._build_notes_record(
            RC_PATH, "F 13 - Paid DFM", _arcrho("first\nfor 2025"), "first\r\nfor 2024"
        )

        self.assertTrue(record["needs_review"])
        self.assertEqual(record["differing_lines"], 1)
        self.assertEqual(record["note"], "Method Notes differ on 1 line(s)")
        self.assertEqual(record["lines"][1]["arcrho"], "for 2025")
        self.assertEqual(record["lines"][1]["resq"], "for 2024")
        self.assertFalse(record["lines"][1]["same"])

    def test_a_note_on_one_side_only_is_reported_as_such(self):
        arcrho_only = NOTES._build_notes_record(RC_PATH, "A", _arcrho("written here"), "")
        resq_only = NOTES._build_notes_record(RC_PATH, "A", _arcrho(""), "written there")

        self.assertEqual(arcrho_only["note"], "Arco has Method Notes where ResQ has none")
        self.assertEqual(resq_only["note"], "ResQ has Method Notes where Arco has none")

    def test_a_dfm_that_has_published_nothing_explains_its_empty_notes(self):
        record = NOTES._build_notes_record(
            RC_PATH, "A", _arcrho("", has_output=False), "written there"
        )

        self.assertIn("published no output", record["note"])

    def test_a_dfm_missing_from_one_side_needs_review_even_with_no_notes(self):
        missing_in_resq = NOTES._build_notes_record(RC_PATH, "A", _arcrho(""), None)
        missing_in_arcrho = NOTES._build_notes_record(RC_PATH, "A", None, "")

        self.assertTrue(missing_in_resq["needs_review"])
        self.assertEqual(missing_in_resq["note"], "DFM exists in Arco only")
        self.assertTrue(missing_in_arcrho["needs_review"])
        self.assertEqual(missing_in_arcrho["note"], "DFM exists in ResQ only")


class ArcRhoSideTests(unittest.TestCase):
    def setUp(self):
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.rc_dir = Path(self.temp_dir.name)
        (self.rc_dir / "methods").mkdir()
        (self.rc_dir / "sidecars").mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write_method(self, file_stem, name):
        (self.rc_dir / "methods" / f"DFM@{file_stem}.json").write_text(
            json.dumps({"details_tab": {"name": name}}), encoding="utf-8"
        )

    def _write_sidecar(self, file_stem, method_type, method_name, notes):
        (self.rc_dir / "sidecars" / f"{file_stem}.json").write_text(
            json.dumps(
                {
                    "method_type": method_type,
                    "method_name": method_name,
                    "dataset_name": method_name,
                    "notes": notes,
                }
            ),
            encoding="utf-8",
        )

    def test_notes_come_from_the_dfm_output_sidecar(self):
        self._write_method("F 13", "F 13 - Paid DFM")
        self._write_sidecar("F 13", "DFM", "F 13 - Paid DFM", "the note")

        found = NOTES._read_arcrho_dfm_notes(self.rc_dir)

        self.assertEqual(list(found), ["F 13 - Paid DFM"])
        self.assertEqual(found["F 13 - Paid DFM"]["notes"], "the note")
        self.assertTrue(found["F 13 - Paid DFM"]["has_output"])

    def test_another_method_kind_is_not_mistaken_for_a_dfm(self):
        self._write_sidecar("BF 13", "BF", "BF 13 - Incurred BF", "not a DFM note")

        self.assertEqual(NOTES._read_arcrho_dfm_notes(self.rc_dir), {})

    def test_a_dfm_that_has_published_no_output_is_still_listed(self):
        self._write_method("F 13", "F 13 - Paid DFM")

        found = NOTES._read_arcrho_dfm_notes(self.rc_dir)

        self.assertEqual(found["F 13 - Paid DFM"]["notes"], "")
        self.assertFalse(found["F 13 - Paid DFM"]["has_output"])

    def test_an_output_whose_method_json_is_gone_is_still_compared(self):
        self._write_sidecar("F 13", "DFM", "F 13 - Paid DFM", "the note")

        found = NOTES._read_arcrho_dfm_notes(self.rc_dir)

        self.assertEqual(found["F 13 - Paid DFM"]["notes"], "the note")

    def test_a_doubled_space_in_a_name_matches_the_single_spaced_one(self):
        self._write_method("F 13", "F 13  -  Paid DFM")
        self._write_sidecar("F 13", "DFM", "F 13 - Paid DFM", "the note")

        found = NOTES._read_arcrho_dfm_notes(self.rc_dir)

        self.assertEqual(list(found), ["F 13 - Paid DFM"])
        self.assertEqual(found["F 13 - Paid DFM"]["notes"], "the note")
        self.assertEqual(found["F 13 - Paid DFM"]["name"], "F 13  -  Paid DFM")


if __name__ == "__main__":
    unittest.main()
