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


class _ShellUI:
    """A shell that confirms the export and hosts the results window."""

    def __init__(self, button="Export", dirty=False, check_button="Export Anyway"):
        self.button = button
        self.check_button = check_button
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
        return _Button(self.check_button if "links" in kwargs else self.button)

    def progress_bar(self, **kwargs):
        return self.progress

    def link_message(self):
        return next((message for message in self.messages if "links" in message[1]), None)


def _preview_row(name, *, kind="Dataset", newer_side="resq", export_supported=True, **fields):
    row = {"id": name.casefold(), "name": name, "kind": kind, "newer_side": newer_side, "export_supported": export_supported}
    row.update(fields)
    return row


class ExportMacroRunTests(unittest.TestCase):
    """The client checks ResQ timestamps, publishes one export request, and shows what the Bridge reports."""

    def setUp(self):
        self.module = _load_macro()

    def _run(self, ui, *, phase_result=None, phase_error=None, preview_rows=None, preview_error=None):
        def run_phase(**kwargs):
            if kwargs["phase"] == "preview":
                if preview_error:
                    raise preview_error
                return {"preview": list(preview_rows or [])}
            if phase_error:
                raise phase_error
            return dict(phase_result or {})

        run_phase = Mock(side_effect=run_phase)
        review = Mock(return_value={"status": "completed"})
        with (
            patch.object(arcrho_api, "ArcRhoUI", lambda: ui),
            patch.object(arcrho_api, "get_server_root", lambda required: Path("server")),
            patch.object(resq_sync_queue, "run_bridge_phase", run_phase),
            patch.object(ui_module, "await_review_table", review),
        ):
            result = self.module.run_macro()
        return result, run_phase, review

    def test_a_confirmed_export_publishes_the_export_phase_and_shows_the_results_window(self):
        ui = _ShellUI()
        bridge_result = {
            "status": "completed",
            "project_name": "Demo",
            "rc_path": r"Auto\PP",
            "connection_name": "ResQ Demo",
            "results": [{"id": "a", "name": "A", "kind": "Dataset", "outcome": "exported", "message": "Written to ResQ."}],
        }

        result, run_phase, review = self._run(ui, phase_result=bridge_result)

        kwargs = run_phase.call_args.kwargs
        self.assertEqual((kwargs["project_name"], kwargs["rc_path"], kwargs["phase"]), ("Demo", r"Auto\PP", "export"))
        self.assertEqual(kwargs["timeout_sec"], resq_sync_queue.WRITE_TIMEOUT_SEC)
        self.assertIs(kwargs["on_poll"], self.module._report_activity)
        payload = review.call_args.args[1]
        self.assertEqual(payload["title"], "ResQ Export Results")
        self.assertEqual(payload["rows"][0]["cells"]["name"], "A")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["message"], payload["summary"])
        self.assertEqual(ui.messages[0][1]["buttons"], ["Export", "Cancel"])
        # The timestamp check ran the preview phase first, and found nothing to warn about.
        phases = [call.kwargs["phase"] for call in run_phase.call_args_list]
        self.assertEqual(phases, ["preview", "export"])
        self.assertEqual(run_phase.call_args_list[0].kwargs["timeout_sec"], resq_sync_queue.PREVIEW_TIMEOUT_SEC)
        self.assertIsNone(ui.link_message())
        self.assertEqual(result["timestamp_check"], {"status": "checked", "resq_newer": []})

    def test_items_resq_changed_more_recently_are_listed_as_links_before_the_export(self):
        ui = _ShellUI()
        rows = [
            _preview_row("Paid Loss", dataset_type="Paid Loss"),
            _preview_row("Paid LDF", kind="DFM", dataset_type="Paid LDF", method_name="Paid DFM"),
            _preview_row("Older in ResQ", newer_side="arcrho"),
            _preview_row("Same time", newer_side=""),
            _preview_row("Not exported", export_supported=False),
        ]

        result, run_phase, _review = self._run(ui, preview_rows=rows, phase_result={"status": "completed", "results": []})

        text, kwargs = ui.link_message()
        self.assertIn("ResQ changed 2 item(s) more recently than ArcRho.", text)
        self.assertEqual(kwargs["buttons"], ["Export Anyway", "Cancel"])
        self.assertEqual(kwargs["presentation"], "floating")
        self.assertEqual(kwargs["kind"], "warning")
        self.assertEqual(
            kwargs["links"],
            [
                {"label": "Paid Loss", "kind": "Dataset", "args": {"datasetName": "Paid Loss", "datasetTypeName": "Paid Loss"}},
                {
                    "label": "Paid LDF",
                    "kind": "DFM",
                    "args": {
                        "datasetName": "Paid LDF",
                        "datasetTypeName": "Paid LDF",
                        "methodType": "DFM",
                        "openMethod": True,
                        "methodName": "Paid DFM",
                    },
                },
            ],
        )
        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview", "export"])
        self.assertEqual(result["timestamp_check"]["resq_newer"], ["Paid Loss", "Paid LDF"])

    def test_cancelling_the_timestamp_warning_publishes_no_export(self):
        ui = _ShellUI(check_button="Cancel")

        result, run_phase, review = self._run(ui, preview_rows=[_preview_row("Paid Loss")])

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview"])
        review.assert_not_called()
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["reason"], "resq_newer")

    def test_a_failed_timestamp_check_does_not_block_the_export(self):
        ui = _ShellUI()

        result, run_phase, _review = self._run(
            ui,
            preview_error=resq_sync_queue.BridgeRequestError("preview failed"),
            phase_result={"status": "completed", "results": []},
        )

        self.assertEqual([call.kwargs["phase"] for call in run_phase.call_args_list], ["preview", "export"])
        self.assertIsNone(ui.link_message())
        self.assertEqual(result["timestamp_check"], {"status": "failed", "error": "preview failed"})

    def test_a_method_output_link_opens_its_method_window(self):
        link = self.module.open_link({"name": "BF Ult", "kind": "Bornhuetter Ferguson", "dataset_type": "BF Ult"})

        self.assertEqual(
            link["args"],
            {"datasetName": "BF Ult", "datasetTypeName": "BF Ult", "methodType": "Bornhuetter Ferguson", "openMethod": True},
        )

    def test_a_cancelled_confirmation_publishes_nothing(self):
        result, run_phase, review = self._run(_ShellUI(button="Cancel"))

        run_phase.assert_not_called()
        review.assert_not_called()
        self.assertTrue(result["cancelled"])

    def test_an_unsaved_window_stops_the_export_before_confirmation(self):
        ui = _ShellUI(dirty=True)

        result, run_phase, _review = self._run(ui)

        run_phase.assert_not_called()
        self.assertEqual(result["reason"], "active_window_dirty")
        self.assertEqual(len(ui.messages), 1)

    def test_a_missing_bridge_is_a_warning_rather_than_a_crash(self):
        ui = _ShellUI()

        result, _run_phase, review = self._run(
            ui, phase_error=resq_sync_queue.BridgeUnavailableError("No active ArcRho Bridge worker")
        )

        review.assert_not_called()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(ui.messages[-1][1]["kind"], "warning")
        self.assertIn("No active ArcRho Bridge worker", ui.messages[-1][0])


if __name__ == "__main__":
    unittest.main()
