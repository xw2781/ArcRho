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
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MODULE_PATH = REPO_ROOT / "tools" / "backfill_stored_period_lengths.py"
SPEC = importlib.util.spec_from_file_location("backfill_stored_period_lengths", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
backfill = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backfill
SPEC.loader.exec_module(backfill)

sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))
from arcrho_api.sidecar_core_contract import validate_sidecar_core  # noqa: E402


def _sidecar(
    name: str,
    *,
    source_kind: str,
    data_format: str = "Triangle",
    origin_length: int | None = 12,
    development_length: int | None = 12,
    period_length: int | None = None,
    csv_file: str = "",
    method_name: str = "",
    calculated: bool = False,
    stored: dict | None = None,
) -> dict:
    """One complete sidecar of the shape the share holds, minus the stored pair."""

    payload: dict = {
        "json_format": "arcrho-dataset-sidecar-v4",
        "dataset_name": name,
        "dataset_type": name,
        "reserving_class": "Class A",
        "project_name": "Scratch",
        "source_kind": source_kind,
        "calculated": calculated,
        "data_format": data_format,
        "method_type": "",
        "status": 0,
        "number_format": "#,##0",
        "decimal_places": 0,
        "show_subtotal": False,
        "csv_file": csv_file or f"{name}@12@12@cum@dev.csv",
    }
    if period_length is not None:
        payload["period_length"] = period_length
    if origin_length is not None:
        payload["origin_length"] = origin_length
    if development_length is not None:
        payload["development_length"] = development_length
    payload.update(stored or {})
    if method_name:
        payload["method_name"] = method_name
    payload.update({
        "created": "2026-01-01T00:00:00.000Z",
        "updated_at": "2026-01-01T00:00:00.000Z",
        "modified_by": "tester",
        "precedents": [],
        "dependents": [],
        "audit_log": [],
    })
    return payload


class BackfillStoredPeriodLengthsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        self.sidecars = self.workspace / "projects" / "Scratch" / "data" / "Class A" / "sidecars"
        self.sidecars.mkdir(parents=True)
        self.written = {
            "hand entered": _sidecar(
                "Paid Loss",
                source_kind="input",
                origin_length=1,
                development_length=1,
                csv_file="Paid Loss@1@1@cum@dev.csv",
            ),
            "hand entered vector": _sidecar(
                "Earned Premium",
                source_kind="input",
                data_format="Vector",
                origin_length=None,
                development_length=None,
                period_length=3,
                csv_file="Earned Premium@3@3@cum@dev.csv",
            ),
            "generated": _sidecar("Reported Loss", source_kind="engine"),
            "calculated vector": _sidecar(
                "Severity",
                source_kind="calculated",
                data_format="Vector",
                calculated=True,
            ),
            "method output": _sidecar(
                "C 12 - CWP DFM",
                source_kind="dfm",
                data_format="Vector",
                origin_length=None,
                development_length=None,
                period_length=12,
                method_name="C 12 - CWP DFM",
                calculated=True,
            ),
        }
        for label, payload in self.written.items():
            self._write(f"{label}.json", payload)
        self.untouched = _sidecar(
            "Already Stored",
            source_kind="engine",
            stored={"stored_origin_length": 1, "stored_development_length": 3},
        )
        self._write("already stored.json", self.untouched)

    def _write(self, name: str, payload: dict) -> None:
        (self.sidecars / name).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _read(self, name: str) -> dict:
        return json.loads((self.sidecars / name).read_text(encoding="utf-8"))

    def _run(self, *args: str) -> tuple[int, dict]:
        report = self.workspace / "report.json"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = backfill.main([
                "--workspace", str(self.workspace), "--report", str(report), *args
            ])
        return code, json.loads(report.read_text(encoding="utf-8"))

    def test_a_dry_run_reports_every_source_kind_and_writes_nothing(self) -> None:
        before = {path.name: path.read_bytes() for path in self.sidecars.glob("*.json")}
        code, report = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "dry-run")
        self.assertEqual(report["sidecars_written"], len(self.written))
        self.assertEqual(report["sidecars_already_stored"], 1)
        self.assertEqual(
            report["written_by_source_kind"],
            {"calculated": 1, "dfm": 1, "engine": 1, "input": 2},
        )
        self.assertEqual(report["engine_sidecars_taking_the_display_shape"], 1)
        self.assertEqual(report["csv_disagreements"], [])
        self.assertEqual(report["failures"], [])
        self.assertEqual(
            {path.name: path.read_bytes() for path in self.sidecars.glob("*.json")}, before
        )

    def test_each_source_kind_takes_the_shape_it_already_records(self) -> None:
        self.assertEqual(self._run("--apply")[0], 0)
        hand_entered = self._read("hand entered.json")
        self.assertEqual(hand_entered["stored_origin_length"], 1)
        self.assertEqual(hand_entered["stored_development_length"], 1)
        self.assertEqual(hand_entered["origin_length"], 1)
        self.assertEqual(self._read("hand entered vector.json")["stored_period_length"], 3)
        self.assertEqual(self._read("generated.json")["stored_origin_length"], 12)
        self.assertEqual(self._read("method output.json")["stored_period_length"], 12)
        # A vector that records its length under the triangle's field states no
        # period length at all, and a missing length reads as annual.
        self.assertEqual(self._read("calculated vector.json")["stored_period_length"], 12)
        for name in self.written:
            validate_sidecar_core(self._read(f"{name}.json"))

    def test_the_stored_fields_land_behind_the_display_ones(self) -> None:
        self.assertEqual(self._run("--apply")[0], 0)
        keys = list(self._read("hand entered.json"))
        self.assertEqual(
            keys[keys.index("origin_length"):keys.index("origin_length") + 4],
            ["origin_length", "development_length", "stored_origin_length", "stored_development_length"],
        )
        self.assertEqual(list(self._read("hand entered.json"))[0], "json_format")
        self.assertEqual(list(self._read("hand entered.json"))[-1], "audit_log")

    def test_a_sidecar_that_already_records_a_stored_shape_is_left_alone(self) -> None:
        self.assertEqual(self._run("--apply")[0], 0)
        self.assertEqual(self._read("already stored.json"), self.untouched)

    def test_running_it_twice_writes_nothing_the_second_time(self) -> None:
        self.assertEqual(self._run("--apply")[0], 0)
        after_first = {path.name: path.read_bytes() for path in self.sidecars.glob("*.json")}
        code, report = self._run("--apply")
        self.assertEqual(code, 0)
        self.assertEqual(report["sidecars_written"], 0)
        self.assertEqual(report["sidecars_already_stored"], len(self.written) + 1)
        self.assertEqual(
            {path.name: path.read_bytes() for path in self.sidecars.glob("*.json")}, after_first
        )

    def test_lengths_that_disagree_with_their_own_csv_name_are_reported(self) -> None:
        self._write(
            "settings only save.json",
            _sidecar(
                "Monthly Paid",
                source_kind="input",
                csv_file="Monthly Paid@1@1@cum@dev.csv",
            ),
        )
        _code, report = self._run()
        self.assertEqual(len(report["csv_disagreements"]), 1)
        entry = report["csv_disagreements"][0]
        self.assertEqual(entry["csv_lengths"], [1, 1])
        self.assertEqual(entry["origin_length"], 12)

    def test_a_file_the_v4_conversion_has_not_reached_is_filled_in_and_counted(self) -> None:
        legacy = _sidecar("Prior Qtr", source_kind="input", data_format="Vector",
                          origin_length=None, development_length=None, period_length=12)
        legacy.pop("status")
        self._write("prior qtr.json", legacy)
        code, report = self._run("--apply")
        self.assertEqual(code, 0)
        self.assertEqual(len(report["pre_v4_core_gaps"]), 1)
        self.assertIn("status", report["pre_v4_core_gaps"][0]["detail"])
        written = self._read("prior qtr.json")
        self.assertEqual(written["stored_period_length"], 12)
        self.assertNotIn("status", written)

    def test_an_unreadable_sidecar_is_reported_and_the_walk_carries_on(self) -> None:
        (self.sidecars / "broken.json").write_text("{ not json", encoding="utf-8")
        code, report = self._run("--apply")
        self.assertEqual(code, 1)
        self.assertEqual(len(report["failures"]), 1)
        self.assertIn("broken.json", report["failures"][0]["path"])
        self.assertEqual(report["sidecars_written"], len(self.written))

    def test_a_staged_import_is_filled_in_but_is_not_a_class_to_index(self) -> None:
        staged = (
            self.workspace / "projects" / "Scratch" / "data"
            / ".arcrho-resq-import-staging" / "session1" / "data" / "Class B" / "sidecars"
        )
        staged.mkdir(parents=True)
        (staged / "staged.json").write_text(
            json.dumps(_sidecar("Staged", source_kind="input"), indent=2), encoding="utf-8"
        )
        _code, report = self._run("--apply")
        self.assertEqual(report["sidecars_written"], len(self.written) + 1)
        self.assertEqual(report["reserving_classes_walked"], 1)
        self.assertEqual(
            json.loads((staged / "staged.json").read_text(encoding="utf-8"))["stored_origin_length"], 12
        )

    def test_one_project_can_be_named(self) -> None:
        other = self.workspace / "projects" / "Other" / "data" / "Class B" / "sidecars"
        other.mkdir(parents=True)
        (other / "one.json").write_text(
            json.dumps(_sidecar("One", source_kind="input"), indent=2), encoding="utf-8"
        )
        _code, report = self._run("--project", "Scratch")
        self.assertEqual(report["projects"], ["Scratch"])
        self.assertEqual(report["sidecars_written"], len(self.written))


if __name__ == "__main__":
    unittest.main()
