from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MODULE_PATH = REPO_ROOT / "tools" / "drop_eex_formula_column.py"
SPEC = importlib.util.spec_from_file_location("drop_eex_formula_column", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
dropper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dropper
SPEC.loader.exec_module(dropper)


def _legacy_payload() -> dict:
    return {
        "columns": ["Name", "Level", "Formula", "EEX Formula", "Source"],
        "rows": [
            ["BI", "5", "", "", '"BI"'],
            ["TOTAL PA", "5", "BI + PD", "PD", '"BI" + "PD"'],
        ],
        "updated_at": "2026-01-01T00:00:00Z",
    }


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


class DropEexFormulaColumnTests(unittest.TestCase):
    def test_transform_removes_column_and_matching_cells(self) -> None:
        output, changed, row_count = dropper.drop_eex_formula_column(_legacy_payload())

        self.assertTrue(changed)
        self.assertEqual(2, row_count)
        self.assertEqual(
            ["Name", "Level", "Formula", "Source"],
            output["columns"],
        )
        self.assertEqual(
            ["TOTAL PA", "5", "BI + PD", '"BI" + "PD"'],
            output["rows"][1],
        )
        self.assertEqual("2026-01-01T00:00:00Z", output["updated_at"])

    def test_transform_is_a_no_op_when_column_is_absent(self) -> None:
        payload = {
            "columns": ["Name", "Level", "Formula", "Source"],
            "rows": [["BI", "5", "", '"BI"']],
        }

        output, changed, row_count = dropper.drop_eex_formula_column(payload)

        self.assertFalse(changed)
        self.assertEqual(1, row_count)
        self.assertEqual(payload, output)

    def test_transform_rejects_duplicate_eex_columns(self) -> None:
        payload = _legacy_payload()
        payload["columns"].append("EEX Formula")
        payload["rows"] = [row + [""] for row in payload["rows"]]

        with self.assertRaisesRegex(dropper.DropEexColumnError, "duplicate"):
            dropper.drop_eex_formula_column(payload)

    def test_transform_rejects_misaligned_rows(self) -> None:
        payload = _legacy_payload()
        payload["rows"][1].pop()

        with self.assertRaisesRegex(dropper.DropEexColumnError, "expected 5"):
            dropper.drop_eex_formula_column(payload)

    def test_dry_run_reports_without_writing(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            path = Path(temp_dir) / "reserving_class_types.json"
            _write_json(path, _legacy_payload())
            original = path.read_bytes()
            output = io.StringIO()

            with redirect_stdout(output):
                exit_code = dropper.main(["--file", str(path), "--dry-run"])

            self.assertEqual(0, exit_code)
            self.assertEqual(original, path.read_bytes())
            report = json.loads(output.getvalue())
            self.assertFalse(report["changed"])
            self.assertTrue(report["would_change"])
            self.assertEqual(
                ["Name", "Level", "Formula", "Source"],
                report["columns_after"],
            )

    def test_dry_run_resolves_configured_project_name(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            projects_root = Path(temp_dir)
            project_dir = projects_root / "Selected Project"
            project_dir.mkdir()
            path = project_dir / dropper.RESERVING_CLASS_FILENAME
            _write_json(path, _legacy_payload())
            output = io.StringIO()

            with (
                patch.object(dropper, "PROJECTS_ROOT", projects_root),
                patch.object(dropper, "PROJECT_NAME", "Selected Project"),
                redirect_stdout(output),
            ):
                exit_code = dropper.main(["--dry-run"])

            self.assertEqual(0, exit_code)
            self.assertEqual(str(path.resolve()), json.loads(output.getvalue())["path"])

    def test_project_name_argument_overrides_configured_project(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            projects_root = Path(temp_dir)
            project_dir = projects_root / "Runtime Project"
            project_dir.mkdir()
            path = project_dir / dropper.RESERVING_CLASS_FILENAME
            _write_json(path, _legacy_payload())
            output = io.StringIO()

            with (
                patch.object(dropper, "PROJECTS_ROOT", projects_root),
                patch.object(dropper, "PROJECT_NAME", "Configured Project"),
                redirect_stdout(output),
            ):
                exit_code = dropper.main(
                    ["--project-name", "Runtime Project", "--dry-run"]
                )

            self.assertEqual(0, exit_code)
            self.assertEqual(str(path.resolve()), json.loads(output.getvalue())["path"])

    def test_no_arguments_uses_configured_dry_run_mode(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            projects_root = Path(temp_dir)
            project_dir = projects_root / "Direct Run Project"
            project_dir.mkdir()
            path = project_dir / dropper.RESERVING_CLASS_FILENAME
            _write_json(path, _legacy_payload())
            original = path.read_bytes()
            output = io.StringIO()

            with (
                patch.object(dropper, "PROJECTS_ROOT", projects_root),
                patch.object(dropper, "PROJECT_NAME", "Direct Run Project"),
                patch.object(dropper, "APPLY_CHANGES", False),
                redirect_stdout(output),
            ):
                exit_code = dropper.main([])

            self.assertEqual(0, exit_code)
            report = json.loads(output.getvalue())
            self.assertEqual("dry-run", report["mode"])
            self.assertFalse(report["changed"])
            self.assertTrue(report["would_change"])
            self.assertEqual(original, path.read_bytes())

    def test_no_arguments_can_use_configured_apply_mode(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            projects_root = Path(temp_dir)
            project_dir = projects_root / "Direct Apply Project"
            project_dir.mkdir()
            path = project_dir / dropper.RESERVING_CLASS_FILENAME
            _write_json(path, _legacy_payload())
            output = io.StringIO()

            with (
                patch.object(dropper, "PROJECTS_ROOT", projects_root),
                patch.object(dropper, "PROJECT_NAME", "Direct Apply Project"),
                patch.object(dropper, "APPLY_CHANGES", True),
                redirect_stdout(output),
            ):
                exit_code = dropper.main([])

            report = json.loads(output.getvalue())
            self.assertEqual(0, exit_code)
            self.assertEqual("applied", report["mode"])
            self.assertTrue(Path(report["backup_path"]).exists())
            self.assertNotIn(
                dropper.EEX_COLUMN,
                json.loads(path.read_text(encoding="utf-8"))["columns"],
            )

    def test_project_name_rejects_path_traversal(self) -> None:
        with self.assertRaisesRegex(dropper.DropEexColumnError, "directory name"):
            dropper._project_file_path("../Another Project")

    def test_apply_creates_backup_and_updates_json(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            path = Path(temp_dir) / "reserving_class_types.json"
            payload = _legacy_payload()
            _write_json(path, payload)

            report = dropper.apply_drop(path)

            backup_path = Path(report["backup_path"])
            self.assertTrue(backup_path.exists())
            self.assertEqual(payload, json.loads(backup_path.read_text(encoding="utf-8")))
            migrated = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(
                ["Name", "Level", "Formula", "Source"],
                migrated["columns"],
            )
            self.assertNotIn("PD", migrated["rows"][1][3:])

    def test_apply_refuses_existing_backup(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp_dir:
            path = Path(temp_dir) / "reserving_class_types.json"
            _write_json(path, _legacy_payload())
            backup_path = path.with_name(path.name + dropper.BACKUP_SUFFIX)
            backup_path.write_text("existing", encoding="utf-8")

            with self.assertRaisesRegex(dropper.DropEexColumnError, "Backup already exists"):
                dropper.apply_drop(path)

            self.assertEqual(_legacy_payload(), json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
