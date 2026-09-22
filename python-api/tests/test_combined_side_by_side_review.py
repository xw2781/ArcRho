"""Cover the one entry point the combined Arco/ResQ review offers its callers.

``run_review`` is the whole run: it compares all three halves of a reserving
class -- plain datasets, Result Selections and the Method Notes on every DFM
-- drops the names the skip list hides, writes the workbook, and reports what
needs attention. The command line and the Arco Bridge, which runs this review
for the "Review Reserving Class against ResQ" macro, both call it, so these
tests pin what they both depend on rather than the ResQ reads themselves.
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import openpyxl


_TESTS_DIR = Path(__file__).resolve().parent
_MIGRATION_DIR = _TESTS_DIR.parent / "migration"
_VALIDATION_DIR = _MIGRATION_DIR / "validation"
_REVIEW_PATH = _VALIDATION_DIR / "combined_side_by_side_review.py"
_TMP_ROOT = _TESTS_DIR / "logs" / "tmp"


def load_review_module():
    for import_root in (_MIGRATION_DIR, _VALIDATION_DIR):
        if str(import_root) not in sys.path:
            sys.path.insert(0, str(import_root))
    spec = importlib.util.spec_from_file_location(
        "combined_side_by_side_review_under_test", _REVIEW_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load combined_side_by_side_review.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


REVIEW = load_review_module()
RC_PATH = r"HPPREF\HO+DF\NJ\Legacy\HOL"


def _matrix():
    return [[1.0, 2.0], [3.0, None]]


def _dataset_record(name, *, kind="Triangle", needs_review=False, rc_path=RC_PATH):
    return {
        "rc_path": rc_path,
        "kind": kind,
        "name": name,
        "source_kind": "engine",
        "origin_labels": ["2024", "2025"],
        "dev_labels": ["12", "24"],
        "arcrho_matrix": _matrix(),
        "resq_matrix": _matrix(),
        "diff_matrix": [[0.0, 0.0], [0.0, None]],
        "row_count": 2,
        "column_count": 2,
        "arcrho_shape": (2, 2),
        "resq_shape": (2, 2),
        "max_abs_diff": 0.5 if needs_review else 0.0,
        "max_rel_diff": 0.0,
        "flagged_cells": 1 if needs_review else 0,
        "note": "differs" if needs_review else "",
        "needs_review": needs_review,
    }


def _notes_record(name, *, needs_review=False, rc_path=RC_PATH):
    lines = [
        {"line": 1, "arcrho": "Selected low LDF", "resq": "Selected low LDF", "same": True},
    ]
    if needs_review:
        lines.append({"line": 2, "arcrho": "for 2025", "resq": "for 2024", "same": False})
    return {
        "rc_path": rc_path,
        "name": name,
        "kind": REVIEW.dfmnotes.NOTES_KIND,
        "arcrho_notes": "Selected low LDF",
        "resq_notes": "Selected low LDF",
        "lines": lines,
        "line_count": len(lines),
        "differing_lines": 1 if needs_review else 0,
        "matches": not needs_review,
        "note": "Method Notes differ on 1 line(s)" if needs_review else "",
        "needs_review": needs_review,
    }


def _rs_record(name, *, needs_review=False, rc_path=RC_PATH):
    return {
        "rc_path": rc_path,
        "name": name,
        "origin_labels": ["2024", "2025"],
        "column_names": ["Paid Loss", "Selected Ultimate"],
        "arcrho_matrix": _matrix(),
        "resq_matrix": _matrix(),
        "diff_matrix": [[0.0, 0.0], [0.0, None]],
        "origin_count": 2,
        "column_count": 2,
        "max_abs_diff": 0.5 if needs_review else 0.0,
        "flagged_cells": 1 if needs_review else 0,
        "note": "differs" if needs_review else "",
        "needs_review": needs_review,
    }


class RunReviewTests(unittest.TestCase):
    def setUp(self):
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.output_path = Path(self.temp_dir.name) / "reviews" / "book.xlsx"

    def tearDown(self):
        self.temp_dir.cleanup()

    def _run(
        self,
        dataset_records,
        rs_records,
        notes_records=(),
        *,
        dataset_errors=(),
        rs_errors=(),
        notes_errors=(),
        **kwargs,
    ):
        captured = {}

        def fake_dataset_comparison(**call):
            captured["dataset"] = call
            return list(dataset_records), list(dataset_errors)

        def fake_rs_comparison(**call):
            captured["rs"] = call
            return list(rs_records), list(rs_errors)

        def fake_notes_comparison(**call):
            captured["notes"] = call
            return list(notes_records), list(notes_errors)

        with (
            patch.object(REVIEW.dsbs, "run_comparison", side_effect=fake_dataset_comparison),
            patch.object(REVIEW.rssbs, "run_comparison", side_effect=fake_rs_comparison),
            patch.object(REVIEW.dfmnotes, "run_comparison", side_effect=fake_notes_comparison),
        ):
            result = REVIEW.run_review(
                project_name="Demo",
                rc_paths=[RC_PATH],
                output_path=self.output_path,
                progress=lambda _message: None,
                **kwargs,
            )
        return result, captured

    def test_a_clean_run_writes_the_workbook_and_reports_nothing_to_attend_to(self):
        result, _ = self._run(
            [_dataset_record("Paid Loss")],
            [_rs_record("Ultimate")],
            [_notes_record("F 13 - Paid DFM")],
        )

        self.assertTrue(self.output_path.is_file())
        self.assertFalse(result["needs_attention"])
        self.assertEqual(result["datasets_compared"], 1)
        self.assertEqual(result["datasets_needing_review"], 0)
        self.assertEqual(result["result_selections_compared"], 1)
        self.assertEqual(result["dfm_notes_compared"], 1)
        self.assertEqual(result["dfm_notes_needing_review"], 0)
        self.assertEqual(result["flagged"], [])
        self.assertEqual(result["workbook_path"], str(self.output_path))
        self.assertEqual(result["workbook_name"], "book.xlsx")
        self.assertEqual(result["review_api_version"], REVIEW.REVIEW_API_VERSION)

    def test_every_summary_row_is_reported_beside_the_workbook(self):
        result, _ = self._run(
            [_dataset_record("Paid Loss", needs_review=True), _dataset_record("Incurred Loss")],
            [_rs_record("Ultimate", needs_review=True)],
            [_notes_record("F 13 - Paid DFM", needs_review=True), _notes_record("F 23 - Incurred DFM")],
        )

        self.assertTrue(result["needs_attention"])
        self.assertEqual(
            [(row["type"], row["name"]) for row in result["flagged"]],
            [
                ("Dataset", "Paid Loss"),
                ("Result Selection", "Ultimate"),
                ("DFM Notes", "F 13 - Paid DFM"),
            ],
        )
        self.assertEqual(result["flagged"][0]["flagged_cells"], 1)
        self.assertEqual(result["flagged"][0]["rc_path"], RC_PATH)
        self.assertEqual(result["flagged"][2]["flagged_cells"], 1)
        self.assertIsNone(result["flagged"][2]["max_abs_diff"])

        workbook = openpyxl.load_workbook(self.output_path)
        self.assertEqual(workbook["Summary"].cell(row=4, column=4).value, "Paid Loss")
        self.assertEqual(workbook["Summary"].cell(row=5, column=4).value, "Ultimate")
        self.assertEqual(workbook["Summary"].cell(row=6, column=1).value, "DFM Notes")
        self.assertEqual(workbook["Summary"].cell(row=6, column=4).value, "F 13 - Paid DFM")

    def test_a_disagreeing_note_is_laid_out_line_by_line_on_its_own_sheet(self):
        self._run([], [], [_notes_record("F 13 - Paid DFM", needs_review=True)])

        workbook = openpyxl.load_workbook(self.output_path)
        sheet = workbook[[title for title in workbook.sheetnames if title.endswith("Notes")][0]]
        self.assertEqual(sheet.cell(row=3, column=1).value, "F 13 - Paid DFM")
        self.assertEqual(
            [sheet.cell(row=4, column=column).value for column in range(1, 5)],
            ["Line", "Arco", "ResQ", "Same?"],
        )
        self.assertEqual(sheet.cell(row=5, column=4).value, REVIEW.dfmnotes.SAME_LABEL)
        self.assertEqual(sheet.cell(row=6, column=2).value, "for 2025")
        self.assertEqual(sheet.cell(row=6, column=3).value, "for 2024")
        self.assertEqual(sheet.cell(row=6, column=4).value, REVIEW.dfmnotes.DIFFERS_LABEL)

    def test_a_reserving_class_resq_refused_for_notes_needs_attention(self):
        result, _ = self._run(
            [], [], [], notes_errors=[(RC_PATH, "could not read ResQ reserving class")]
        )

        self.assertTrue(result["needs_attention"])
        self.assertEqual(result["reserving_class_errors"][0]["type"], "DFM Notes")

    def test_a_reserving_class_resq_refused_needs_attention(self):
        result, _ = self._run(
            [_dataset_record("Paid Loss")],
            [],
            dataset_errors=[(RC_PATH, "could not read ResQ reserving class")],
        )

        self.assertTrue(result["needs_attention"])
        self.assertEqual(result["reserving_class_errors"][0]["rc_path"], RC_PATH)
        self.assertEqual(result["reserving_class_errors"][0]["type"], "Dataset")

    def test_skipped_names_are_left_out_and_counted(self):
        result, _ = self._run(
            [_dataset_record("Paid Loss - May 2026", needs_review=True), _dataset_record("Paid Loss")],
            [_rs_record("Ultimate Growth Adjustment")],
            [_notes_record("F 13 - Paid DFM Accounting Cutoff", needs_review=True)],
        )

        self.assertEqual(result["skipped_datasets"], 1)
        self.assertEqual(result["skipped_result_selections"], 1)
        self.assertEqual(result["skipped_dfm_notes"], 1)
        self.assertEqual(result["datasets_compared"], 1)
        self.assertEqual(result["result_selections_compared"], 0)
        self.assertEqual(result["dfm_notes_compared"], 0)
        self.assertFalse(result["needs_attention"])

    def test_an_empty_skip_list_keeps_every_name(self):
        result, _ = self._run(
            [_dataset_record("Paid Loss - May 2026")],
            [],
            skip_substrings=set(),
        )

        self.assertEqual(result["skipped_datasets"], 0)
        self.assertEqual(result["datasets_compared"], 1)

    def test_both_halves_are_asked_for_the_same_class_and_account(self):
        credentials = {"connection_name": "SRV", "user_name": "svc", "password": "secret"}
        _, captured = self._run([], [], credentials=credentials)

        self.assertEqual(captured["dataset"]["rc_paths"], [RC_PATH])
        self.assertEqual(captured["rs"]["rc_paths"], [RC_PATH])
        self.assertEqual(captured["notes"]["rc_paths"], [RC_PATH])
        self.assertEqual(captured["dataset"]["credentials"], credentials)
        self.assertEqual(captured["rs"]["credentials"], credentials)
        self.assertEqual(captured["notes"]["credentials"], credentials)
        self.assertEqual(captured["dataset"]["source_kinds"], REVIEW.dsbs.SOURCE_KINDS)

    def test_a_run_with_no_reserving_class_is_refused(self):
        with self.assertRaisesRegex(ValueError, "reserving-class path is required"):
            REVIEW.run_review(project_name="Demo", rc_paths=["  "])


class ResQCredentialTests(unittest.TestCase):
    """Both halves connect with the account the caller names, or the module's own."""

    def test_a_named_account_wins(self):
        account = {"connection_name": "SRV", "user_name": "svc", "password": "secret"}
        self.assertEqual(REVIEW.dsbs.resq_credentials(account), account)
        self.assertEqual(REVIEW.rssbs.resq_credentials(account), account)

    def test_the_migration_constants_are_the_default(self):
        migration = REVIEW.dsbs.migration
        self.assertEqual(
            REVIEW.dsbs.resq_credentials(),
            {
                "connection_name": migration.CONNECTION_NAME,
                "user_name": migration.USER_NAME,
                "password": migration.PASSWORD,
            },
        )
        self.assertIs(REVIEW.rssbs.resq_credentials, REVIEW.dsbs.resq_credentials)


if __name__ == "__main__":
    unittest.main()
