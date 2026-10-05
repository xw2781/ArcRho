"""Exercise the host's fixed Python Gateway adapter against the real registry."""
import contextlib
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-api" / "src"))
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS

SOURCE = (ROOT / "frontend/electron/arcbot_project_read.js").read_text(encoding="utf-8")
SCRIPT = SOURCE.split("const PROJECT_READ_SCRIPT = `", 1)[1].split("`;", 1)[0]


class ProjectReadTests(unittest.TestCase):
    def invoke(self, kind, arguments=None, reserving_class=""):
        calls = []
        class Gateway:
            def read(self, kind, **arguments):
                calls.append((kind, arguments))
                return {"method": "fake", "arguments": arguments}
        module = types.ModuleType("arcrho_api.gateway")
        module.GatewayClient = Gateway
        request = {"project": "Fake Project", "reserving_class": reserving_class, "kind": kind, "arguments": arguments or {}}
        output = io.StringIO()
        with patch.dict(sys.modules, {"arcrho_api.gateway": module}), patch("sys.stdin", io.StringIO(json.dumps(request))), contextlib.redirect_stdout(output):
            exec(SCRIPT, {})
        return json.loads(output.getvalue()), calls

    def test_catalog_contains_every_registered_method_load(self):
        result, calls = self.invoke("catalog")
        expected = {kind for kind, spec in WORKSPACE_READ_KINDS.items()
                    if spec.function.startswith("load_") and "method_name" in spec.required}
        self.assertTrue(expected)
        self.assertTrue(expected.issubset(result))
        self.assertEqual(calls, [])

    def test_load_pins_active_project(self):
        _, calls = self.invoke("dfm_method_load", {"method_name": "Paid", "reserving_class": "Auto"})
        self.assertEqual(calls, [("dfm_method_load", {"project_name": "Fake Project", "method_name": "Paid", "reserving_class": "Auto"})])

    def test_reads_default_to_active_reserving_class(self):
        _, calls = self.invoke("dfm_method_load", {"method_name": "D13"}, reserving_class="Auto")
        self.assertEqual(calls[0][1]["reserving_class"], "Auto")
        _, calls = self.invoke("dfm_method_load", {"method_name": "D13", "reserving_class": "Home"}, reserving_class="Auto")
        self.assertEqual(calls[0][1]["reserving_class"], "Home")
        _, calls = self.invoke("reserving_class_combinations", {}, reserving_class="Auto")
        self.assertNotIn("reserving_class", calls[0][1])

    def test_other_project_is_readable_without_active_class_default(self):
        _, calls = self.invoke("dfm_method_load", {"project_name": "Other", "method_name": "D13"}, reserving_class="Auto")
        self.assertEqual(calls, [("dfm_method_load", {"project_name": "Other", "method_name": "D13"})])

    def test_datasets_and_project_names_are_readable(self):
        _, calls = self.invoke("dataset_cache_load", {"project_name": "Other", "reserving_class": "Auto", "dataset_name": "Paid"})
        self.assertEqual(calls[0][1]["project_name"], "Other")
        _, calls = self.invoke("dataset_sidecar_load", {"reserving_class": "Auto", "dataset_name": "Paid"})
        self.assertEqual(calls[0][1]["project_name"], "Fake Project")
        _, calls = self.invoke("project_names")
        self.assertEqual(calls, [("project_names", {})])

    def test_simulations_and_saves_are_rejected(self):
        for kind in ("bootstrap_simulate", "stochastic_consolidation_consolidate", "dfm_method_save"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "method loads, dataset loads and discovery"):
                self.invoke(kind)


if __name__ == "__main__":
    unittest.main()
