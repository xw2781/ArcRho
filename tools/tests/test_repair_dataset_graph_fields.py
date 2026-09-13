"""The one-off script that repairs an existing project's dataset links.

The app server owns the repair itself (``frontend/tests/test_dataset_graph_repair.py``);
what is checked here is the script around it: the ``--apply`` gate, the counted
report, and the reserving-class lease that keeps it out of a running job's way.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MODULE_PATH = REPO_ROOT / "tools" / "repair_dataset_graph_fields.py"
SPEC = importlib.util.spec_from_file_location("repair_dataset_graph_fields", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
repair_tool = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = repair_tool
SPEC.loader.exec_module(repair_tool)

from arcrho_dependent_propagation_contract import (  # noqa: E402
    acquire_reserving_class_lease,
    release_reserving_class_lease,
)
from app_server import config  # noqa: E402
from app_server.services import (  # noqa: E402
    calculated_dataset_service,
    dataset_sidecar_status_service,
)


PROJECT = "Demo"
CLASS = "Auto"
FORMULA_OUTPUT = "Total Earned Premium"
INPUTS = ("Earned Premium", "Remaining Budget Premium")
ROWS = [
    {"name": "Earned Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Earned_Premium", "generated": True},
    {"name": "Remaining Budget Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Remaining_Budget_Premium", "generated": True},
    {"name": FORMULA_OUTPUT, "data_format": "Triangle", "calculated": True, "formula": '"Earned Premium" + "Remaining Budget Premium"', "source": "Earned_Premium + Remaining_Budget_Premium", "generated": True},
]
EXISTING = {"earned premium", "remaining budget premium", "total earned premium"}


def _sidecar(name: str) -> dict:
    """One Engine sidecar whose two link lists are still empty."""

    return {
        "json_format": "arcrho-dataset-sidecar-v4",
        "dataset_name": name,
        "dataset_type": name,
        "reserving_class": CLASS,
        "project_name": PROJECT,
        "source_kind": "engine",
        "calculated": False,
        "data_format": "Triangle",
        "method_type": "None",
        "status": 0,
        "number_format": "#,##0",
        "decimal_places": 0,
        "show_subtotal": False,
        "csv_file": f"{name}@12@12@cum@dev.csv",
        "origin_length": 12,
        "development_length": 12,
        "stored_origin_length": 12,
        "stored_development_length": 12,
        "cumulative": True,
        "calendar": False,
        "created": "2026-01-01T00:00:00.000Z",
        "modified_by": "Tester",
        "updated_at": "2026-01-02T00:00:00.000Z",
        "precedents": [],
        "dependents": [],
        "audit_log": [],
    }


class RepairScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects_root = self.root / "projects"
        self.sidecars = self.projects_root / PROJECT / "data" / CLASS / "sidecars"
        self.sidecars.mkdir(parents=True)
        for name in (*INPUTS, FORMULA_OUTPUT):
            dataset_sidecar_status_service.write_sidecar(
                str(self.sidecars / f"{name}.json"), _sidecar(name)
            )
        self.before = {
            path.name: path.read_bytes() for path in self.sidecars.glob("*.json")
        }

        for target, name, value in (
            (config, "refresh_runtime_paths", lambda: None),
            (config, "PROJECT_SETTINGS_DIR", str(self.projects_root)),
            (config, "get_root_path", lambda: str(self.root)),
            (config, "get_project_data_dir", lambda project: str(self.projects_root / project / "data")),
            (
                config,
                "get_project_dataset_sidecar_dir",
                lambda project, reserving_class: str(
                    self.projects_root / project / "data" / reserving_class / "sidecars"
                ),
            ),
            (calculated_dataset_service, "_dataset_type_rows", lambda _project: [dict(row) for row in ROWS]),
            (
                calculated_dataset_service,
                "_existing_dataset_keys",
                lambda _project, _reserving_class: set(EXISTING),
            ),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, *args: str) -> tuple[int, str, dict]:
        report_path = self.root / "report.json"
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = repair_tool.main([*args, "--report", str(report_path)])
        return code, out.getvalue(), json.loads(report_path.read_text(encoding="utf-8"))

    def _links(self, name: str) -> tuple[list, list]:
        payload = json.loads((self.sidecars / f"{name}.json").read_text(encoding="utf-8"))
        return (
            dataset_sidecar_status_service.entry_names(payload.get("precedents")),
            dataset_sidecar_status_service.entry_names(payload.get("dependents")),
        )

    def test_a_report_only_run_writes_nothing_and_counts_the_work(self) -> None:
        code, printed, report = self._run("--project", PROJECT)

        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "dry-run")
        self.assertEqual(report["projects"], [PROJECT])
        self.assertEqual(report["reserving_classes_walked"], 1)
        self.assertEqual(report["sidecars_read"], 3)
        self.assertEqual(report["sidecars_written"], 3)
        self.assertEqual(report["failures"], [])
        self.assertIn("Sidecars to write", printed)
        for path in self.sidecars.glob("*.json"):
            self.assertEqual(path.read_bytes(), self.before[path.name], path.name)

    def test_apply_repairs_the_class(self) -> None:
        code, printed, report = self._run("--project", PROJECT, "--apply")

        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "applied")
        self.assertEqual(report["sidecars_written"], 3)
        self.assertEqual(
            sorted(report["datasets_repaired"]),
            sorted(f"{PROJECT} / {CLASS} / {name}" for name in (*INPUTS, FORMULA_OUTPUT)),
        )
        self.assertIn("Sidecars written", printed)
        self.assertEqual(self._links(FORMULA_OUTPUT), ([*INPUTS], []))
        for name in INPUTS:
            self.assertEqual(self._links(name), ([], [FORMULA_OUTPUT]))

    def test_every_project_is_walked_when_none_is_named(self) -> None:
        code, _printed, report = self._run("--apply")

        self.assertEqual(code, 0)
        self.assertEqual(report["projects"], [PROJECT])
        self.assertEqual(report["sidecars_written"], 3)

    def test_a_class_another_job_holds_is_skipped_and_reported(self) -> None:
        lease = acquire_reserving_class_lease(str(self.root), PROJECT, CLASS)
        self.assertIsNotNone(lease)
        self.addCleanup(release_reserving_class_lease, lease)

        code, printed, report = self._run("--project", PROJECT, "--apply")

        self.assertEqual(code, 1)
        self.assertEqual(report["reserving_classes_walked"], 0)
        self.assertEqual(
            [entry["reserving_class"] for entry in report["reserving_classes_skipped"]], [CLASS]
        )
        self.assertIn("ANOTHER JOB HOLDS THE CLASS", printed)
        for path in self.sidecars.glob("*.json"):
            self.assertEqual(path.read_bytes(), self.before[path.name], path.name)

    def test_a_project_that_is_not_there_is_a_usage_error(self) -> None:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(repair_tool.main(["--project", "Absent"]), 2)


if __name__ == "__main__":
    unittest.main()
