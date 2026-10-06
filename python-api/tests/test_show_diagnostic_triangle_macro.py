from __future__ import annotations

import importlib.util
import json
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
        rows = [{"method": " DFM: Selected   Method ", "diagnostic_dataset": "Diagnostic Triangle"}]
        with patch.object(MACRO, "_load_mappings", return_value=rows):
            self.assertEqual(
                MACRO._find_diagnostic_dataset("selected method"),
                "Diagnostic Triangle",
            )
            self.assertEqual(MACRO._find_diagnostic_dataset("Another Method"), "")

    def test_mapping_is_read_from_the_skill_folder_through_the_gateway(self) -> None:
        mapping = {"mappings": [{"method": "M", "diagnostic_dataset": "D"}]}
        skills = {"skills": [{"id": "dfm-diagnostics", "references": [
            {"name": "notes.md", "text": "ignored"},
            {"name": "diagnostic_mapping.json", "text": json.dumps(mapping)},
        ]}]}
        gateway = Mock()
        gateway.read.return_value = skills
        with patch.object(MACRO, "GatewayClient", return_value=gateway):
            self.assertEqual(MACRO._load_mappings(), mapping["mappings"])
        gateway.read.assert_called_once_with("agent_skills", skill_id="dfm-diagnostics")

    def test_a_missing_skill_or_mapping_file_is_reported(self) -> None:
        gateway = Mock()
        for answer in ({"skills": []}, {"skills": [{"id": "dfm-diagnostics", "references": []}]}):
            gateway.read.return_value = answer
            with patch.object(MACRO, "GatewayClient", return_value=gateway):
                with self.assertRaises(FileNotFoundError):
                    MACRO._load_mappings()

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
