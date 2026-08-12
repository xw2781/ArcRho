from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch


MACRO_PATH = Path(__file__).resolve().parents[1] / "macros" / "show_diagnostic_triangle.py"
SPEC = importlib.util.spec_from_file_location("show_diagnostic_triangle_macro", MACRO_PATH)
assert SPEC and SPEC.loader
MACRO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MACRO)


class ShowDiagnosticTriangleMacroTests(TestCase):
    def test_matching_ignores_dfm_prefix_case_and_repeated_whitespace(self) -> None:
        with (
            patch.object(MACRO, "MAPPING_WORKBOOK", Path(__file__)),
            patch.object(
                MACRO,
                "_iter_mapping_rows",
                return_value=iter(
                    [
                        {1: "Methods", 2: "Triangles"},
                        {1: " DFM: Selected   Method ", 2: "Diagnostic Triangle"},
                    ]
                ),
            ),
        ):
            self.assertEqual(
                MACRO._find_diagnostic_dataset("selected method"),
                "Diagnostic Triangle",
            )

    def test_run_opens_dataset_without_returning_a_dfm_payload(self) -> None:
        project_instance = SimpleNamespace(
            active_window=Mock(
                return_value=SimpleNamespace(
                    properties=SimpleNamespace(
                        kind="dfm",
                        item_name="Selected Method",
                        name="",
                        dataset_name="",
                    )
                )
            ),
            open_dataset=Mock(return_value=SimpleNamespace(id="diagnostic-window")),
        )

        with (
            patch.object(
                MACRO,
                "ArcRhoUI",
                return_value=SimpleNamespace(project_instance=project_instance),
            ),
            patch.object(
                MACRO,
                "_find_diagnostic_dataset",
                return_value="Diagnostic Triangle",
            ),
        ):
            result = MACRO.run_macro()

        project_instance.open_dataset.assert_called_once_with("Diagnostic Triangle")
        self.assertNotIn("payload", result)
        self.assertEqual(
            result["details"],
            {
                "methodName": "Selected Method",
                "diagnosticDataset": "Diagnostic Triangle",
                "windowId": "diagnostic-window",
            },
        )
