from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import openpyxl


_TESTS_DIR = Path(__file__).resolve().parent
_PYTHON_API_DIR = _TESTS_DIR.parent
_MIGRATION_DIR = _PYTHON_API_DIR / "migration"
_VALIDATOR_PATH = _MIGRATION_DIR / "validation" / "validate_engine_resq_parity.py"
_TMP_ROOT = _TESTS_DIR / "logs" / "tmp"


def load_validator_module():
    if str(_MIGRATION_DIR) not in sys.path:
        sys.path.insert(0, str(_MIGRATION_DIR))
    spec = importlib.util.spec_from_file_location("validate_engine_resq_parity_under_test", _VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load validate_engine_resq_parity.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _FakeCollection:
    def __init__(self, values):
        self.values = values

    def Item(self, name):
        return self.values[name]

    def __iter__(self):
        return iter(self.values.values()) if isinstance(self.values, dict) else iter(self.values)


class _FakeReservingClass:
    def __init__(self, triangle, vector):
        self.triangle = triangle
        self.vector = vector

    def Triangles(self):
        return _FakeCollection([self.triangle])

    def Vectors(self):
        return _FakeCollection([self.vector])


class _FakeApp:
    def __init__(self, reserving_class, project_name):
        self.reserving_class = reserving_class
        self.project_name = project_name
        self.connected = False
        self.disconnected = False

    def ConnectByName(self, *_args):
        self.connected = True

    def Disconnect(self):
        self.disconnected = True

    def Projects(self):
        return _FakeCollection({self.project_name: self})

    def ReservingClasses(self):
        return _FakeCollection({r"Auto\PP": self.reserving_class})


class ValidateEngineResqParityTests(unittest.TestCase):
    def setUp(self) -> None:
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.root = Path(self.tmp.name)
        self.module = load_validator_module()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_eligibility_excludes_method_outputs_before_generated_gate(self) -> None:
        dataset = types.SimpleNamespace(Name="Paid", DatasetType=types.SimpleNamespace(Name="Paid"), MethodType=1)
        with patch.object(self.module.migration, "_is_engine_generated_instance", return_value=True) as gate:
            self.assertEqual(self.module._eligible_dataset(dataset), (False, "method_output"))
        gate.assert_not_called()

    def test_eligibility_uses_migration_generated_instance_gate(self) -> None:
        dataset = types.SimpleNamespace(Name="Paid", DatasetType=types.SimpleNamespace(Name="Paid"), MethodType=0)
        with patch.object(self.module.migration, "_is_engine_generated_instance", return_value=True) as gate:
            self.assertEqual(self.module._eligible_dataset(dataset), (True, ""))
        gate.assert_called_once_with({"name": "Paid", "dataset_type": "Paid"})

    def test_read_engine_csv_preserves_blank_cells(self) -> None:
        path = self.root / "engine.csv"
        path.write_text("1,,3\n4,5,\n", encoding="utf-8")
        self.assertEqual(self.module.read_engine_csv(path), [[1.0, None, 3.0], [4.0, 5.0, None]])

    def test_compare_matrices_reports_shape_and_missingness_without_zero_coercion(self) -> None:
        comparison = self.module.compare_matrices([[1.0, None], [2.0, 3.0]], [[1.0, 0.0]])
        self.assertFalse(comparison["matches"])
        self.assertEqual(comparison["categories"], ("shape", "missingness"))
        self.assertEqual(comparison["resq_shape"], (2, 2))
        self.assertEqual(comparison["engine_shape"], (1, 2))
        self.assertEqual(comparison["mismatch_count"], 2)
        self.assertEqual(comparison["first_mismatch_cell"], "shape")

    def test_compare_matrices_honors_tight_tolerance(self) -> None:
        match = self.module.compare_matrices([[1.0]], [[1.0 + 5e-10]])
        mismatch = self.module.compare_matrices([[1.0]], [[1.0 + 2e-9]])
        self.assertTrue(match["matches"])
        self.assertFalse(mismatch["matches"])
        self.assertEqual(mismatch["categories"], ("numeric",))
        self.assertEqual(mismatch["first_mismatch_cell"], "origin 1, development 1")

    def test_validate_payload_uses_isolated_engine_output_and_reports_mismatch(self) -> None:
        calls = {}

        def generate(**kwargs):
            calls.update(kwargs)
            Path(kwargs["data_path"]).write_text("1,2\n", encoding="utf-8")

        payload = {
            "name": "Paid",
            "dataset_type": "Paid",
            "origin_length": 12,
            "development_length": 12,
            "values": [[1.0, 3.0]],
        }
        result = self.module.validate_payload(
            rc_path=r"Auto\PP",
            kind="triangle",
            payload=payload,
            temp_dir=self.root,
            engine_generator=generate,
        )
        self.assertEqual(calls["project_name"], self.module.TARGET_PROJECT_NAME)
        self.assertTrue(calls["cumulative"])
        self.assertFalse(calls["calendar"])
        self.assertEqual(result.status, "mismatch")
        self.assertEqual(result.categories, ("numeric",))
        self.assertEqual(result.mismatch_count, 1)

    def test_replace_generated_findings_preserves_template_content(self) -> None:
        document = "before\n<!-- BEGIN GENERATED FINDINGS -->\nold\n<!-- END GENERATED FINDINGS -->\nafter\n"
        updated = self.module.replace_generated_findings(document, "new findings")
        self.assertEqual(
            updated,
            "before\n<!-- BEGIN GENERATED FINDINGS -->\n\nnew findings\n\n<!-- END GENERATED FINDINGS -->\nafter\n",
        )

    def test_ensure_markdown_report_creates_project_result_template(self) -> None:
        path = self.root / "result" / self.module.TARGET_PROJECT_NAME / "final_validation.md"
        self.module.ensure_markdown_report(path)
        document = path.read_text(encoding="utf-8")
        self.assertIn(f"Project: `{self.module.TARGET_PROJECT_NAME}`", document)
        self.assertIn(self.module.MARKDOWN_START_MARKER, document)
        self.assertIn(self.module.MARKDOWN_END_MARKER, document)

    def test_default_report_directory_is_project_scoped(self) -> None:
        self.assertEqual(
            self.module.DEFAULT_REPORT_DIR,
            _MIGRATION_DIR / "validation" / "result" / self.module.TARGET_PROJECT_NAME,
        )

    def test_progress_window_is_enabled_by_default_and_can_be_disabled(self) -> None:
        self.assertTrue(self.module._parse_args([]).progress_window)
        self.assertFalse(self.module._parse_args(["--no-progress-window"]).progress_window)

    def test_open_progress_window_tails_the_project_log(self) -> None:
        progress_path = self.root / "validation_progress.tmp.log"
        progress_path.touch()
        with (
            patch.object(self.module.os, "name", "nt"),
            patch.object(self.module.subprocess, "Popen") as popen,
        ):
            self.assertTrue(self.module.open_progress_window(progress_path))

        command = popen.call_args.args[0]
        self.assertEqual(command[:3], ["powershell.exe", "-NoProfile", "-NoExit"])
        self.assertIn("Get-Content -LiteralPath", command[-1])
        self.assertIn(str(progress_path), command[-1])

    def test_excel_report_contains_only_issue_rows(self) -> None:
        summary = self.module.ValidationSummary(started_at=self.module._utc_now(), rc_paths=[r"Auto\PP"])
        summary.finished_at = self.module._utc_now()
        summary.results.extend(
            [
                self.module.ComparisonResult(rc_path=r"Auto\PP", kind="triangle", dataset_name="Paid"),
                self.module.ComparisonResult(
                    rc_path=r"Auto\PP",
                    kind="vector",
                    resq_formula="=SUM(A1:A2)",
                    dataset_name="Earned Premium",
                    status="mismatch",
                    categories=("numeric",),
                    mismatch_count=1,
                    first_mismatch_cell="origin 1, development 1",
                ),
            ]
        )
        output = self.root / "final_validation_issues.xlsx"
        self.module.write_issues_workbook(output, summary)

        workbook = openpyxl.load_workbook(output, data_only=True)
        try:
            issues = workbook["Issues"]
            self.assertEqual(issues.max_row, 2)
            self.assertEqual(issues["B1"].value, "Dataset")
            self.assertEqual(issues["C1"].value, "ResQ Formula")
            self.assertEqual(issues["D1"].value, "Data Format")
            self.assertEqual(issues["B2"].value, "Earned Premium")
            self.assertEqual(issues["C2"].value, "=SUM(A1:A2)")
            self.assertEqual(issues["F2"].value, "mismatch")
        finally:
            workbook.close()

    def test_issues_workbook_path_includes_project_name(self) -> None:
        self.assertEqual(
            self.module.issues_workbook_path(self.root),
            self.root / f"final_validation_issues_{self.module.TARGET_PROJECT_NAME}.xlsx",
        )

    def test_run_validation_uses_one_mocked_resq_session_and_engine_generator(self) -> None:
        triangle = types.SimpleNamespace(
            Name="Paid", DatasetType=types.SimpleNamespace(Name="Paid"), Formula="Paid formula"
        )
        vector = types.SimpleNamespace(
            Name="Earned Premium",
            DatasetType=types.SimpleNamespace(Name="Earned Premium"),
            Formula="Earned premium formula",
        )
        app = _FakeApp(
            _FakeReservingClass(triangle, vector),
            self.module.TARGET_PROJECT_NAME,
        )

        def export_triangle(_dataset):
            return {
                "name": "Paid",
                "dataset_type": "Paid",
                "origin_length": 12,
                "development_length": 12,
                "values": [[1.0]],
            }

        def export_vector(_dataset):
            return {
                "name": "Earned Premium",
                "dataset_type": "Earned Premium",
                "origin_length": 12,
                "development_length": 12,
                "values": [[2.0]],
            }

        def generate(**kwargs):
            expected = "2\n" if kwargs["is_vector"] else "1\n"
            Path(kwargs["data_path"]).write_text(expected, encoding="utf-8")

        progress_messages = []
        with (
            patch.object(self.module.migration, "RC_PATH", [r"Auto\PP"]),
            patch.object(self.module.migration, "_apply_runtime_scope", return_value=(None, "", Path("."))),
            patch.object(self.module.migration, "_restore_runtime_scope"),
            patch.object(self.module, "_eligible_dataset", return_value=(True, "")),
            patch.object(self.module, "export_triangle", side_effect=export_triangle),
            patch.object(self.module, "export_vector", side_effect=export_vector),
        ):
            progress = io.StringIO()
            with redirect_stdout(progress):
                summary = self.module.run_validation(
                    app_factory=lambda: app,
                    engine_generator=generate,
                    temp_root=self.root,
                    progress_callback=progress_messages.append,
                )

        self.assertTrue(app.connected)
        self.assertTrue(app.disconnected)
        self.assertIn("RC 1/1: Auto\\PP", progress.getvalue())
        self.assertIn("RC START 1/1 | Auto\\PP", progress_messages)
        self.assertIn("ENGINE START triangle | Paid | 12x12", progress_messages)
        self.assertIn("MATCH vector | Earned Premium | ok", progress_messages)
        self.assertEqual(summary.eligible_count, 2)
        self.assertEqual(summary.match_count, 2)
        self.assertEqual(summary.issue_count, 0)
        self.assertEqual(summary.results[0].resq_formula, "Paid formula")
        self.assertEqual(summary.results[1].resq_formula, "Earned premium formula")

    def test_run_validation_records_connection_failure_for_reports(self) -> None:
        with (
            patch.object(self.module.migration, "RC_PATH", [r"Auto\PP"]),
            patch.object(self.module.migration, "_apply_runtime_scope", return_value=(None, "", Path("."))),
            patch.object(self.module.migration, "_restore_runtime_scope"),
        ):
            summary = self.module.run_validation(
                app_factory=lambda: (_ for _ in ()).throw(RuntimeError("Windows authentication unavailable")),
                temp_root=self.root,
            )

        self.assertEqual(summary.issue_count, 1)
        result = summary.issue_results[0]
        self.assertEqual(result.kind, "connection")
        self.assertEqual(result.status, "resq_connection_error")
        self.assertIn("Windows authentication unavailable", result.error)
        self.assertIsNotNone(summary.finished_at)


if __name__ == "__main__":
    unittest.main()

