from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MODULE_PATH = REPO_ROOT / "tools" / "repair_calculated_vector_sidecars.py"
SPEC = importlib.util.spec_from_file_location("repair_calculated_vector_sidecars", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
repair_tool = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = repair_tool
SPEC.loader.exec_module(repair_tool)

TRIANGLE_LAYOUT_VECTOR = {
    "dataset_name": "F 63",
    "source_kind": "calculated",
    "data_format": "Vector",
    "origin_length": 12,
    "development_length": 12,
    "stored_period_length": 3,
    "cumulative": True,
    "calendar": False,
    "csv_file": "F 63@3.csv",
    "audit_log": [],
}
VECTOR_LAYOUT = {
    "dataset_name": "F 64",
    "source_kind": "calculated",
    "data_format": "Vector",
    "period_length": 12,
    "stored_period_length": 3,
    "csv_file": "F 64@3.csv",
    "audit_log": [],
}
CALCULATED_TRIANGLE = {
    "dataset_name": "F 65",
    "source_kind": "calculated",
    "data_format": "Triangle",
    "origin_length": 12,
    "development_length": 12,
    "stored_origin_length": 12,
    "stored_development_length": 12,
    "cumulative": True,
    "calendar": False,
    "audit_log": [],
}


class RepairCalculatedVectorSidecarsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        sidecars = self.workspace / "projects" / "Scratch" / "data" / "Class A" / "sidecars"
        sidecars.mkdir(parents=True)
        self.files = {}
        for payload in (TRIANGLE_LAYOUT_VECTOR, VECTOR_LAYOUT, CALCULATED_TRIANGLE):
            path = sidecars / f"{payload['dataset_name']}.json"
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            self.files[payload["dataset_name"]] = path

    def run_tool(self, *extra: str) -> str:
        out = io.StringIO()
        with redirect_stdout(out):
            code = repair_tool.main(["--workspace", str(self.workspace), *extra])
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_a_dry_run_writes_nothing(self) -> None:
        before = {name: path.read_text(encoding="utf-8") for name, path in self.files.items()}
        report = self.run_tool()

        self.assertIn("Sidecars repaired: 1", report)
        self.assertEqual(before, {name: path.read_text(encoding="utf-8") for name, path in self.files.items()})

    def test_a_triangle_layout_vector_is_repaired_and_nothing_else_is(self) -> None:
        untouched = {
            name: self.files[name].read_text(encoding="utf-8") for name in ("F 64", "F 65")
        }
        self.run_tool("--apply")

        repaired = json.loads(self.files["F 63"].read_text(encoding="utf-8"))
        self.assertEqual(
            list(repaired),
            ["dataset_name", "source_kind", "data_format", "period_length", "stored_period_length", "csv_file", "audit_log"],
        )
        self.assertEqual(repaired["period_length"], 12)
        self.assertEqual(repaired["stored_period_length"], 3)
        for name, text in untouched.items():
            self.assertEqual(self.files[name].read_text(encoding="utf-8"), text)

    def test_a_second_run_changes_nothing(self) -> None:
        self.run_tool("--apply")
        report = self.run_tool("--apply")

        self.assertIn("Sidecars repaired: 0", report)


if __name__ == "__main__":
    unittest.main()
