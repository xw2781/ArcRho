"""Cover the ResQ writer the Export and Sync macros share, and the Export macro's client side.

The Bridge loads ``export_reserving_class_to_resq.py`` from its bundle and
the canonical session drives its per-item writers, so these tests load the
macro file the same way and exercise the writers without a ResQ session. The
client side -- the export request and the results window -- runs against a
stub shell and a stub queue, because the macro itself never touches ResQ.
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
_MACRO_PATH = _PYTHON_API_ROOT / "macros" / "export_reserving_class_to_resq.py"
_SRC_DIR = _PYTHON_API_ROOT / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

import arcrho_api  # noqa: E402
from arcrho_api import resq_sync_queue, ui as ui_module  # noqa: E402


def _load_macro():
    spec = importlib.util.spec_from_file_location("export_reserving_class_macro_under_test", _MACRO_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migration(**fields):
    values = {"CONNECTION_NAME": "ResQ", "USER_NAME": "user", "PASSWORD": "secret"}
    values.update(fields)
    return types.SimpleNamespace(**values)


class ExportMacroMethodNotesTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro()

    def _exporter(self):
        exporter = self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(DFMMethods=lambda: [])
        exporter._find_in = Mock()
        exporter._sync_dfm_excluded_ratios = Mock(return_value=0)
        exporter._sync_dfm_user_entry_values = Mock(return_value=0)
        exporter._sync_dfm_selected_ratios = Mock(return_value=0)
        return exporter

    def test_export_dfm_writes_notes_with_resq_line_breaks(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "Old note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "Excluded 2020.\nSelected 3-year."})

        self.assertEqual(dfm.Notes, "Excluded 2020.\r\nSelected 3-year.")
        dfm.Save.assert_called_once()
        self.assertEqual(exporter.counts["dfms_written"], 1)

    def test_export_dfm_clears_notes_for_a_blank_value_and_keeps_them_without_one(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "ResQ note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "  \n"})
        self.assertEqual(dfm.Notes, "")

        dfm.Notes = "ResQ note"
        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}})
        self.assertEqual(dfm.Notes, "ResQ note")

    def test_export_dataset_writes_the_sidecar_notes_before_saving_values(self):
        with tempfile.TemporaryDirectory() as temp:
            server_root = Path(temp)
            cache = server_root / "projects" / "Project" / "data" / "RC" / "cache"
            cache.mkdir(parents=True)
            (cache / "Paid Loss@12.csv").write_text("1\n", encoding="utf-8")
            migration = _migration(DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
            exporter = self.module.ResQReservingClassExporter(
                migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=server_root
            )
            target = Mock()
            target.Calculated = False
            target.Notes = ""
            exporter._find_dataset = Mock(return_value=target)
            exporter._write_vector_values = Mock()
            sidecar = {
                "dataset_name": "Paid Loss",
                "data_format": "Vector",
                "csv_file": "Paid Loss@12.csv",
                "notes": "Loaded from claims.\nReviewed.",
            }

            exporter._export_dataset_values(sidecar, "Paid Loss")

        self.assertEqual(target.Notes, "Loaded from claims.\r\nReviewed.")
        exporter._write_vector_values.assert_called_once()
        self.assertEqual(exporter.counts["datasets_written"], 1)

    def test_a_missing_csv_cache_is_recorded_as_a_skip_with_its_message(self):
        migration = _migration(DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
        exporter = self.module.ResQReservingClassExporter(
            migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=Path("nowhere")
        )

        exporter.export_datasets([{"dataset_name": "Paid Loss", "method_type": "None", "csv_file": "Paid Loss.csv"}])

        self.assertEqual(exporter.skipped, {"missing_csv_cache": 1})
        self.assertEqual(exporter.skip_details[-1]["name"], "Paid Loss")
        self.assertIn("no dataset CSV cache on disk", exporter.skip_details[-1]["message"])
        self.assertEqual(exporter.counts["datasets_written"], 0)


class ExportMacroNeverCreatesTests(unittest.TestCase):
    """An item ResQ does not hold is a warning, never a creation; a DFM ResQ cannot evaluate is skipped before any write."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, server_root=Path("."), **migration_fields):
        exporter = self.module.ResQReservingClassExporter(
            _migration(**migration_fields), arcrho_project_name="Project", rc_path="Line/Class", server_root=server_root
        )
        # Nothing here offers Add or AddMethod: a creation attempt would raise.
        exporter.reserving_class = types.SimpleNamespace(
            DFMMethods=lambda: [], BFMethods=lambda: [], CapeCodMethods=lambda: [], ResultSelections=lambda: []
        )
        return exporter

    def test_a_dataset_resq_does_not_hold_is_a_warning(self):
        with tempfile.TemporaryDirectory() as temp:
            server_root = Path(temp)
            cache = server_root / "projects" / "Project" / "data" / "RC" / "cache"
            cache.mkdir(parents=True)
            (cache / "Accounting Cutoff@12.csv").write_text("1\n", encoding="utf-8")
            exporter = self._exporter(server_root, DATASET_CACHE_DIR="cache", _encode_rc_folder=lambda _path: "RC")
            exporter._find_dataset = Mock(return_value=None)

            exporter.export_datasets([{
                "dataset_name": "Accounting Cutoff",
                "method_type": "None",
                "data_format": "Vector",
                "csv_file": "Accounting Cutoff@12.csv",
            }])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.counts["errors"], 0)
        self.assertIn("the export never creates one", exporter.skip_details[-1]["message"])

    def test_a_dfm_resq_does_not_hold_is_a_warning(self):
        exporter = self._exporter()
        exporter._find_in = Mock(return_value=None)

        exporter.export_dfms([{"name": "D 99", "payload": {"details_tab": {"name": "D 99", "input_triangle": "Paid"}}}])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.skip_details[-1]["kind"], "DFM")
        self.assertEqual(exporter.counts["errors"], 0)

    def test_a_result_selection_resq_does_not_hold_is_a_warning(self):
        exporter = self._exporter()
        exporter._find_method_by_output = Mock(return_value=None)

        exporter.export_result_selections([{"name": "C 91", "payload": {"details_tab": {"name": "C 91"}}}])

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.counts["errors"], 0)

    def test_a_dfm_whose_average_formula_resq_cannot_evaluate_is_skipped_before_any_write(self):
        exporter = self._exporter()
        dfm = Mock()
        labels = {1: "1: Volume - all", 2: "2: Vol + 0.9 - all", 3: "3: User Entry"}

        def formula(index):
            if index in labels:
                return labels[index]
            raise ValueError(index)

        def values(_column, index):
            if index == 2:
                raise RuntimeError("Access violation at address 0000000076084D70 in module 'ResQ3Automation.dll'")
            return 1.5

        dfm.AverageFormula.side_effect = formula
        dfm.AverageRatioValues.side_effect = values
        exporter._find_in = Mock(return_value=dfm)

        exporter.export_dfms([{
            "name": "D 14",
            "payload": {"details_tab": {"name": "D 14"}, "ratios_tab": {"ratio_triangle": {"excluded": [[1]]}}},
        }])

        self.assertEqual(exporter.skipped, {"resq_average_unreadable": 1})
        self.assertIn("average formula 2 (Vol + 0.9 - all)", exporter.skip_details[-1]["message"])
        self.assertEqual(exporter.counts["errors"], 0)
        self.assertEqual(exporter.counts["dfms_written"], 0)
        dfm.SetExcludedRatios.assert_not_called()
        dfm.Save.assert_not_called()


class ExportMacroAverageFormulaTests(unittest.TestCase):
    """ResQ's average formula list ends where ResQ says it does, not where it stops answering.

    A ResQ DFM carries three identical ``User Entry`` rows, of which ArcRho
    keeps one, and a reserving class of its own can follow them. Past the last
    real row ResQ keeps naming phantom ``User Entry`` rows and crashes when one
    is evaluated, so the row count is the only end of the list.
    """

    # The 13 rows every DFM of the fake project carries, exactly as ResQ names them.
    RESQ_FORMULAS = [
        "1: Volume - all", "2: Simple - 8", "3: Volume - 8", "4: Simple - 8 Ex hi/lo",
        "5: Simple - 5", "6: Simple - 3", "7: Simple - 5 Ex hi/lo", "8: Benchmark",
        "9: Simple - 2", "10: User Entry", "11: User Entry", "12: User Entry", "13: Aug 2024",
    ]

    def setUp(self):
        self.module = _load_macro()

    def _resq_dfm(self, count=len(RESQ_FORMULAS)):
        dfm = Mock()
        dfm.RatioAverageCount = count

        def formula(index):
            if 1 <= index <= len(self.RESQ_FORMULAS):
                return self.RESQ_FORMULAS[index - 1]
            return f"{index}: User Entry"  # phantom: ResQ reads past its own list

        def values(_column, index):
            if index > len(self.RESQ_FORMULAS):
                raise RuntimeError(
                    "Access violation at address 00000000753DF2AB in module 'ResQ3Automation.dll'"
                )
            return 1.5

        dfm.AverageFormula.side_effect = formula
        dfm.AverageRatioValues.side_effect = values
        return dfm

    def _exporter(self):
        return self.module.ResQReservingClassExporter(
            _migration(), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )

    def test_a_phantom_user_entry_row_past_the_count_is_never_evaluated(self):
        self._exporter()._probe_dfm_averages(self._resq_dfm())

    def test_the_repeated_user_entry_rows_collapse_onto_the_first(self):
        indexes = self._exporter()._average_formula_display_indexes(self._resq_dfm())

        self.assertEqual(indexes["User Entry"], 10)
        self.assertEqual(indexes["Aug 2024"], 13)
        self.assertEqual(indexes["Volume - all"], 1)
        self.assertEqual(len(indexes), 11)

    def test_a_label_after_the_user_entry_rows_can_still_be_selected(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        dfm.OriginCount = 2
        dfm.DevelopmentCount.side_effect = lambda _origin: 2
        payload = {"ratios_tab": {"average_formulas": {
            "label": ["Volume - all", "User Entry", "Aug 2024"],
            "selected": [[0, 0], [1, 0], [0, 1]],
        }}}

        self.assertEqual(exporter._sync_dfm_selected_ratios(dfm, payload), 2)
        dfm.SetSelectedRatios.assert_any_call(DevIndex=1, arg1=10)
        dfm.SetSelectedRatios.assert_any_call(DevIndex=2, arg1=13)

    def test_a_dfm_whose_count_resq_will_not_give_stops_at_the_first_user_entry(self):
        exporter = self._exporter()
        dfm = self._resq_dfm()
        del dfm.RatioAverageCount  # an older ResQ that does not answer

        exporter._probe_dfm_averages(dfm)
        indexes = exporter._average_formula_display_indexes(dfm)

        self.assertEqual(indexes["User Entry"], 10)
        self.assertNotIn("Aug 2024", indexes)


class ExportMacroSaveOnlyTests(unittest.TestCase):
    """BF, Cape Cod, and Berquist Sherman methods are saved in ResQ, never rewritten."""

    def setUp(self):
        self.module = _load_macro()

    def _exporter(self, **migration_fields):
        exporter = self.module.ResQReservingClassExporter(
            _migration(**migration_fields), arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(BFMethods=lambda: "bfs", CapeCodMethods=lambda: "ccs")
        return exporter

    def test_an_existing_bf_is_saved_without_a_field_written(self):
        exporter = self._exporter()
        bf = Mock()
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BF, "D 41 - BF Incurred")

        exporter._find_method_by_output.assert_called_once_with("bfs", "D 41 - BF Incurred")
        bf.Save.assert_called_once_with()
        self.assertEqual(exporter.counts["methods_saved"], 1)
        self.assertEqual(exporter.counts["bfs_written"], 0)

    def test_a_cape_cod_method_is_looked_up_in_its_own_collection(self):
        exporter = self._exporter()
        exporter._find_method_by_output = Mock(return_value=Mock())

        exporter.save_method(self.module.RESQ_METHOD_TYPE_CAPE_COD, "D 53 - Cape Cod")

        exporter._find_method_by_output.assert_called_once_with("ccs", "D 53 - Cape Cod")

    def test_a_berquist_sherman_method_is_found_through_the_migration_by_its_output_triangle(self):
        bs = Mock()
        finder = Mock(return_value=("sr", bs))
        exporter = self._exporter(_find_berquist_sherman_for_triangle=finder)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BS_SR, "Gross Loss--Paid - B&S Settlement Rate Adjustment")

        finder.assert_called_once_with(
            exporter.reserving_class, "Gross Loss--Paid - B&S Settlement Rate Adjustment", self.module.RESQ_METHOD_TYPE_BS_SR
        )
        bs.Save.assert_called_once_with()
        self.assertEqual(exporter.counts["methods_saved"], 1)

    def test_a_method_resq_does_not_hold_is_a_skip(self):
        exporter = self._exporter(_find_berquist_sherman_for_triangle=Mock(return_value=None))

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BS_CRA, "Missing")

        self.assertEqual(exporter.skipped, {"missing_in_resq": 1})
        self.assertEqual(exporter.skip_details[-1]["kind"], "B&S Case Reserve Adequacy")
        self.assertEqual(exporter.counts["methods_saved"], 0)

    def test_a_failed_save_is_recorded_as_an_error(self):
        exporter = self._exporter()
        bf = Mock()
        bf.Save.side_effect = RuntimeError("part of the template implementation")
        exporter._find_method_by_output = Mock(return_value=bf)

        exporter.save_method(self.module.RESQ_METHOD_TYPE_BF, "D 41 - BF Incurred")

        self.assertEqual(exporter.counts["errors"], 1)
        self.assertEqual(exporter.error_details[-1]["message"], "part of the template implementation")
        self.assertEqual(exporter.counts["methods_saved"], 0)


class ExportMacroResultsTableTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro()

    def test_results_become_a_read_only_table_in_write_order_with_counts(self):
        payload = self.module.export_result_table_payload({
            "status": "completed_with_errors",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [
                {"id": "paid loss", "name": "Paid Loss", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."},
                {"id": "paid ldf", "name": "Paid LDF", "kind": "DFM", "outcome": "exported", "message": "Written to ResQ."},
                {"id": "bf ult", "name": "BF Ult", "kind": "Bornhuetter Ferguson", "outcome": "saved", "message": "Written to ResQ."},
                {"id": "orphan", "name": "Orphan", "kind": "Dataset", "outcome": "skipped", "message": "The ArcRho dataset CSV cache is missing."},
                {"id": "sel", "name": "Selected Ult", "kind": "Result Selection", "outcome": "failed", "message": "COM error"},
            ],
        })

        self.assertEqual(payload["title"], "ResQ Export Results")
        self.assertEqual(payload["host"], "projectInstance")
        self.assertFalse(payload["selectable"])
        self.assertEqual(payload["acceptLabel"], "Close")
        self.assertIn("Export to ResQ completed with errors.", payload["summary"])
        self.assertIn("Project: Demo | Reserving class: Auto\\PP | ResQ: ResQ Demo", payload["summary"])
        self.assertIn("Exported 2 dataset/method item(s); saved 1 method(s); skipped 1; failed 1.", payload["summary"])
        self.assertEqual([row["id"] for row in payload["rows"]], [f"result-{index}" for index in range(1, 6)])
        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["name"] for cell in cells], ["Paid Loss", "Paid LDF", "BF Ult", "Orphan", "Selected Ult"])
        self.assertEqual(
            [cell["outcome"] for cell in cells],
            [
                {"text": "Exported", "tone": "ok"},
                {"text": "Exported", "tone": "ok"},
                {"text": "Saved", "tone": "ok"},
                {"text": "Skipped", "tone": "warn"},
                {"text": "Failed", "tone": "error"},
            ],
        )
        self.assertEqual(cells[3]["detail"], "The ArcRho dataset CSV cache is missing.")

    def test_the_results_say_what_was_saved_for_the_next_review_to_compare_against(self):
        def summary(baseline):
            return self.module.export_result_table_payload({
                "status": "completed",
                "baseline": baseline,
                "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": ""}],
            })["summary"]

        self.assertIn(
            "Saved the ArcRho and ResQ timestamps of 3 written item(s)",
            summary({"recorded": 3, "absorbed": 0, "error": ""}),
        )
        self.assertIn(
            "2 further item(s) ResQ recalculated from those writes were saved with them.",
            summary({"recorded": 3, "absorbed": 2, "error": ""}),
        )
        self.assertIn(
            "The ArcRho and ResQ timestamps were not saved",
            summary({"recorded": 0, "absorbed": 0, "error": "The share went away."}),
        )
        self.assertIn("because nothing was written", summary({}))

    def test_a_clean_export_reports_completion_without_errors(self):
        payload = self.module.export_result_table_payload({
            "status": "completed",
            "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."}],
        })

        self.assertTrue(payload["summary"].startswith("Export to ResQ completed.\n"))
        self.assertIn("Exported 1 dataset/method item(s); saved 0 method(s); skipped 0; failed 0.", payload["summary"])


class _Button:
    def __init__(self, button):
        self.button = button


def _preview_row(name, *, kind="Dataset", newer_side="resq", export_supported=True, **fields):
    row = {
        "id": name.casefold(),
        "name": name,
        "kind": kind,
        "arcrho_timestamp": "2026-08-28 10:00:00",
        "resq_timestamp": "2026-08-28 11:00:00",
        "newer_side": newer_side,
        "export_supported": export_supported,
    }
    row.update(fields)
    return row


def _review(changed, *, overwrites_edit=False, detail="", supported=True):
    """The baseline verdict the Bridge sends with a comparable preview row."""

    return {
        "changed": changed,
        "status": changed,
        "detail": detail,
        "supported": supported,
        "overwrites_edit": overwrites_edit,
    }


class ExportPreviewTableTests(unittest.TestCase):
    """The timestamp table shown before the export writes anything."""

    def setUp(self):
        self.module = _load_macro()

    def _payload(self, rows):
        return self.module.export_preview_table_payload(
            rows,
            "Demo",
            r"Auto\PP",
            "ResQ Demo",
            {"arcrho_timestamp": "2026-08-28 10:00:00", "resq_timestamp": "2026-08-28 11:00:00"},
        )

    def test_each_row_shows_the_timestamp_pair_the_newer_side_and_what_the_export_would_do(self):
        payload = self._payload([
            _preview_row("Paid Loss"),
            _preview_row("Reported Loss", newer_side="arcrho"),
            _preview_row("Case Reserves", newer_side=""),
            _preview_row("Bootstrap Ult", newer_side="", export_supported=False, resq_timestamp=""),
        ])

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual(
            [(cell["arcrho_timestamp"], cell["resq_timestamp"]) for cell in cells[:1]],
            [("2026-08-28 10:00:00", "2026-08-28 11:00:00")],
        )
        self.assertEqual([cell["newer"]["text"] for cell in cells], ["ResQ", "ArcRho", "Same", "Unknown"])
        self.assertEqual(
            [cell["plan"]["text"] for cell in cells],
            [
                "Overwrites newer ResQ copy",
                "Overwrites ResQ copy",
                "Overwrites ResQ copy",
                "Not exported",
            ],
        )
        self.assertEqual([cell["plan"]["tone"] for cell in cells], ["warn", "info", "info", "muted"])

    def test_the_baseline_decides_the_warning_not_the_newer_timestamp(self):
        """The case the export itself creates: ResQ newer, but nothing edited there."""

        payload = self._payload([
            _preview_row(
                "Paid Loss",
                export_review=_review("none", detail="Neither side changed since the last export."),
            ),
            _preview_row("Reported Loss", export_review=_review("arcrho")),
            _preview_row("Case Reserves", export_review=_review("resq", overwrites_edit=True)),
            _preview_row("Claim Counts", export_review=_review("both", overwrites_edit=True)),
        ])

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual(
            [cell["changed"]["text"] for cell in cells], ["None", "ArcRho", "ResQ", "Both"]
        )
        self.assertEqual(
            [cell["changed"]["tone"] for cell in cells], ["muted", "ok", "warn", "warn"]
        )
        self.assertEqual(
            [cell["plan"]["text"] for cell in cells],
            [
                "Overwrites ResQ copy",
                "Overwrites ResQ copy",
                "Overwrites newer ResQ copy",
                "Overwrites newer ResQ copy",
            ],
        )
        # Every row still carries the plain fact about its two timestamps.
        self.assertEqual({cell["newer"]["text"] for cell in cells}, {"ResQ"})
        self.assertEqual(cells[0]["detail"], "Neither side changed since the last export.")

    def test_a_row_with_no_saved_pair_says_so_and_falls_back_to_the_timestamps(self):
        payload = self._payload([
            _preview_row("Paid Loss"),
            _preview_row("Reported Loss", newer_side="arcrho"),
        ])

        cells = [row["cells"] for row in payload["rows"]]
        self.assertEqual([cell["changed"]["text"] for cell in cells], ["No baseline yet", "No baseline yet"])
        self.assertEqual(
            [cell["plan"]["text"] for cell in cells],
            ["Overwrites newer ResQ copy", "Overwrites ResQ copy"],
        )

    def test_the_header_counts_what_is_overwritten_and_what_resq_changed_since_the_export(self):
        payload = self._payload([
            _preview_row("Paid Loss", export_review=_review("resq", overwrites_edit=True)),
            _preview_row("Reported Loss", export_review=_review("none")),
            _preview_row("Bootstrap Ult", export_supported=False),
        ])

        self.assertIn("Project: Demo | Reserving class: Auto\\PP | ResQ: ResQ Demo", payload["summary"])
        self.assertIn("the export overwrites 2 of them in ResQ", payload["summary"])
        self.assertIn("1 of them were edited in ResQ since the last export", payload["summary"])
        self.assertNotIn("no saved timestamp pair yet", payload["summary"])

    def test_the_header_says_how_many_items_have_no_saved_pair_yet(self):
        payload = self._payload([
            _preview_row("Paid Loss"),
            _preview_row("Reported Loss", newer_side="arcrho", export_review=_review("none")),
        ])

        self.assertIn("1 of them were edited in ResQ since the last export", payload["summary"])
        self.assertIn("1 have no saved timestamp pair yet", payload["summary"])

    def test_the_table_is_read_only_because_the_export_is_all_or_nothing(self):
        payload = self._payload([_preview_row("Paid Loss")])

        self.assertFalse(payload["selectable"])
        self.assertEqual(payload["acceptLabel"], "Export to ResQ")
        self.assertEqual(payload["cancelLabel"], "Cancel")
        self.assertEqual(payload["host"], "projectInstance")
        self.assertEqual(
            [column["key"] for column in payload["columns"]],
            ["kind", "name", "arcrho_timestamp", "resq_timestamp", "newer", "changed", "plan", "detail"],
        )

    def test_a_class_with_nothing_in_common_says_so(self):
        payload = self._payload([])

        self.assertEqual(payload["rows"], [])
        self.assertIn("Compared 0 item(s)", payload["summary"])
        self.assertIn("None of them were edited in ResQ since the last export.", payload["summary"])
        self.assertIn("would write nothing", payload["emptyMessage"])


class _ShellUI:
    """A shell that hosts the preview table, the results window, and any message box."""

    def __init__(self, button="Export Anyway", dirty=False):
        self.button = button
        self.messages = []
        self.progress = Mock()
        window = Mock()
        window.get_properties.return_value = types.SimpleNamespace(dirty=dirty)
        self.project_instance = types.SimpleNamespace(
            context=lambda timeout_sec: {"projectName": "Demo", "selectedPath": r"Auto\PP"},
            active_window=lambda timeout_sec: window,
        )

    def message_box(self, text, **kwargs):
        self.messages.append((text, kwargs))
        return _Button(self.button)

    def progress_bar(self, **kwargs):
        return self.progress


class ExportMacroRunTests(unittest.TestCase):
    """The client reviews the comparison, publishes one export request, and shows what the Bridge reports."""

    def setUp(self):
        self.module = _load_macro()

    def _run(
        self,
        ui,
        *,
        phase_result=None,
        phase_error=None,
        preview_rows=None,
        preview_error=None,
        accepted=True,
    ):
        def run_phase(**kwargs):
            if kwargs["phase"] == "preview":
                if preview_error:
                    raise preview_error
                return {
                    "preview": list(preview_rows or []),
                    "connection_name": "ResQ Demo",
                    "direction": {
                        "arcrho_timestamp": "2026-08-28 10:00:00",
                        "resq_timestamp": "2026-08-28 11:00:00",
                    },
                }
            if phase_error:
                raise phase_error
            return dict(phase_result or {})

        def review_table(_ui, payload, **_kwargs):
            if payload.get("title") == self.module.TITLE:
                return {"status": "completed", "accepted": accepted}
            return {"status": "completed", "accepted": True}

        run_phase = Mock(side_effect=run_phase)
        review = Mock(side_effect=review_table)
        with (
            patch.object(arcrho_api, "ArcRhoUI", lambda: ui),
            patch.object(arcrho_api, "get_server_root", lambda required: Path("server")),
            patch.object(resq_sync_queue, "run_bridge_phase", run_phase),
            patch.object(ui_module, "await_review_table", review),
        ):
            result = self.module.run_macro()
        return result, run_phase, review

    def test_an_accepted_preview_publishes_the_export_phase_and_shows_the_results_window(self):
        ui = _ShellUI()
        rows = [_preview_row("Paid Loss")]
        bridge_result = {
            "status": "completed",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."}],
        }

        result, run_phase, review = self._run(ui, preview_rows=rows, phase_result=bridge_result)

        # The comparison is reviewed first, and only then is the export published.
        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview", "export"])
        self.assertEqual(run_phase.call_args_list[0].kwargs["timeout_sec"], resq_sync_queue.PREVIEW_TIMEOUT_SEC)
        kwargs = run_phase.call_args.kwargs
        self.assertEqual((kwargs["project_name"], kwargs["rc_path"], kwargs["phase"]), ("Demo", r"Auto\PP", "export"))
        self.assertEqual(kwargs["timeout_sec"], resq_sync_queue.WRITE_TIMEOUT_SEC)
        self.assertIs(kwargs["on_poll"], self.module._report_activity)
        preview_payload = review.call_args_list[0].args[1]
        self.assertEqual(preview_payload["title"], self.module.TITLE)
        self.assertEqual(preview_payload["rows"][0]["cells"]["name"], "Paid Loss")
        self.assertEqual(preview_payload["rows"][0]["cells"]["newer"]["text"], "ResQ")
        payload = review.call_args.args[1]
        self.assertEqual(payload["title"], "ResQ Export Results")
        self.assertEqual(payload["rows"][0]["cells"]["name"], "A")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["message"], payload["summary"])
        self.assertEqual(result["preview"], rows)
        # The preview table is the only confirmation; no message box is shown.
        self.assertEqual(ui.messages, [])

    def test_a_cancelled_preview_publishes_no_export(self):
        ui = _ShellUI()

        result, run_phase, review = self._run(ui, preview_rows=[_preview_row("Paid Loss")], accepted=False)

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview"])
        self.assertEqual(review.call_count, 1)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["reason"], "review_cancelled")

    def test_a_failed_comparison_asks_before_exporting_rather_than_blocking(self):
        ui = _ShellUI()

        result, run_phase, review = self._run(
            ui,
            preview_error=resq_sync_queue.BridgeRequestError("preview failed"),
            phase_result={"status": "completed", "results": []},
        )

        text, kwargs = ui.messages[0]
        self.assertIn("preview failed", text)
        self.assertEqual(kwargs["buttons"], ["Export Anyway", "Cancel"])
        self.assertEqual(kwargs["kind"], "warning")
        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview", "export"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(review.call_count, 1)

    def test_cancelling_a_failed_comparison_publishes_no_export(self):
        ui = _ShellUI(button="Cancel")

        result, run_phase, review = self._run(
            ui, preview_error=resq_sync_queue.BridgeRequestError("preview failed")
        )

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview"])
        review.assert_not_called()
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["review"]["status"], "failed")

    def test_an_unsaved_window_stops_the_export_before_the_comparison(self):
        ui = _ShellUI(dirty=True)

        result, run_phase, _review = self._run(ui)

        run_phase.assert_not_called()
        self.assertEqual(result["reason"], "active_window_dirty")
        self.assertEqual(len(ui.messages), 1)

    def test_a_missing_bridge_is_a_warning_rather_than_a_crash(self):
        ui = _ShellUI()

        result, _run_phase, review = self._run(
            ui, preview_error=resq_sync_queue.BridgeUnavailableError("No active ArcRho Bridge worker")
        )

        # An unreachable Bridge is a precondition, not a comparison the person can skip.
        review.assert_not_called()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(ui.messages[-1][1]["kind"], "warning")
        self.assertNotIn("buttons", {key: value for key, value in ui.messages[-1][1].items() if value})
        self.assertIn("No active ArcRho Bridge worker", ui.messages[-1][0])

    def test_a_bridge_that_disappears_after_the_review_is_reported_the_same_way(self):
        ui = _ShellUI()

        result, run_phase, _review = self._run(
            ui,
            preview_rows=[_preview_row("Paid Loss")],
            phase_error=resq_sync_queue.BridgeUnavailableError("No active ArcRho Bridge worker"),
        )

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview", "export"])
        self.assertEqual(result["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
