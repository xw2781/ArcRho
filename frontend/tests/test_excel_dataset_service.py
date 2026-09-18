"""Excel refreshes publications without becoming a dataset publisher."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
for path in (REPO_ROOT / "frontend", REPO_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.io import persisted_json_text
from app_server import config
from app_server.services import (
    arcrho_runtime_service as runtime,
    calculated_dataset_service as calculated,
    dependent_propagation_service as propagation,
    engine_calculation_service as engine,
    excel_dataset_service as excel,
    file_read_cache,
    dataset_service,
)


class ExcelDatasetPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / config.DATASET_CACHE_DIR
        self.cache.mkdir()
        self.sidecars = self.root / config.DATASET_SIDECAR_DIR
        self.sidecars.mkdir()
        self.rows = [
            {"name": "Paid", "data_format": "Triangle", "generated": True},
            {"name": "Double", "data_format": "Triangle", "calculated": True, "formula": '"Paid" * 2', "generated": False},
            {"name": "Quadruple", "data_format": "Triangle", "calculated": True, "formula": '"Double" * 2', "generated": False},
        ]
        self.signature = "inputs-v1"
        for target, name, options in (
            (config, "get_project_dataset_cache_dir", {"return_value": str(self.cache)}),
            (calculated, "_dataset_type_rows", {"side_effect": lambda project: self.rows}),
            (propagation, "get_reserving_class_busy", {"return_value": {"busy": False}}),
            (dataset_service, "valuation_months", {"return_value": 36}),
            (runtime, "get_processing_config_hash", {"side_effect": lambda project: self.signature}),
            (runtime, "get_processing_provenance", {"side_effect": lambda project, config_hash: {"config_hash": config_hash}}),
            (runtime, "run_arcrho_tri", {"side_effect": AssertionError("Excel must not use the publishing runtime")}),
        ):
            mock = patch.object(target, name, **options)
            mock.start()
            self.addCleanup(mock.stop)
        self.addCleanup(file_read_cache.clear_file_read_cache)

    def pairs(self, name="Paid", period=12, cumulative=True):
        return [("Function", "ArcRhoTri"), ("ProjectName", "Example"), ("Path", "Class"),
                ("DatasetName", name), ("InstanceName", name), ("OriginLength", str(period)),
                ("DevelopmentLength", str(period)), ("Cumulative", str(cumulative)), ("Calendar", "False")]

    def csv_path(self, name="Paid", period=12):
        return self.cache / f"{name}@{period}@{period}@cum@dev.csv"

    def publish(self, name="Paid", source_kind="engine", text="10,20,30\n40,50,\n60,,\n", period=12, dataset_type=None):
        path = self.csv_path(name, period)
        path.write_text(text, encoding="utf-8")
        (self.sidecars / f"{name}.json").write_text(persisted_json_text({
            "dataset_name": name, "dataset_type": dataset_type or name, "data_format": "Triangle",
            "source_kind": source_kind, "csv_file": path.name,
            "stored_origin_length": period, "stored_development_length": period,
            "origin_length": period, "development_length": period, "cumulative": True, "calendar": False,
        }), encoding="utf-8")

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in self.root.rglob("*") if path.is_file()}

    def test_every_permanent_kind_reads_only_the_publication(self):
        for kind in ("engine", "calculated", "input", "result_selection"):
            with self.subTest(kind=kind):
                self.publish(source_kind=kind)
                before = self.snapshot()
                with patch.object(runtime, "get_processing_config_hash", side_effect=AssertionError("No input check")), \
                     patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
                    result = excel.read_dataset_csv(self.pairs(), 1)
                self.assertEqual(result["csv_text"], self.csv_path().read_bytes().decode("utf-8"))
                self.assertEqual(self.snapshot(), before)

    def test_stale_sibling_is_not_used_to_serve_another_shape(self):
        self.publish()
        self.csv_path(period=24).write_text("999\n", encoding="utf-8")
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("Published data must roll up in memory")):
            result = excel.read_dataset_csv(self.pairs(period=24), 1)
        self.assertTrue(result["ok"])
        self.assertFalse(result["need_request"])
        self.assertEqual(result["local_cache_status"], "cache_derived")
        pd.testing.assert_frame_equal(
            pd.read_csv(io.StringIO(result["csv_text"]), header=None),
            pd.DataFrame([[10, 80], [60, float("nan")]], dtype="float64"),
        )
        self.assertEqual(self.snapshot(), before)

    def test_manual_coarser_view_is_derived_without_writing(self):
        self.publish(source_kind="input")
        before = self.snapshot()
        result = excel.read_dataset_csv(self.pairs(period=24), 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["local_cache_status"], "cache_derived")
        self.assertEqual(self.snapshot(), before)

    def test_nonadditive_calculated_output_is_not_rolled_up(self):
        for kind in ("calculated", "result_selection", "dfm"):
            with self.subTest(kind=kind):
                self.publish(source_kind=kind, text="0.1,0.2,0.3\n0.4,0.5,\n0.6,,\n")
                before = self.snapshot()
                result = excel.read_dataset_csv(self.pairs(period=24), 1)
                self.assertFalse(result["ok"])
                self.assertEqual(self.snapshot(), before)

    def test_engine_mode_change_is_built_beside_the_publication(self):
        self.publish()
        before = self.snapshot()
        def calculate(pairs, path, timeout):
            self.assertEqual(runtime._pair_value(pairs, "Cumulative"), "False")
            Path(path).write_text("1,2\n3,\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute:
            result = excel.read_dataset_csv(self.pairs(cumulative=False), 1)
            self.assertTrue(result["ok"])
            self.assertTrue(result["need_request"])
            self.assertEqual(Path(result["data_path"]), self.cache / "Paid@12@12@inc@dev.csv")
            self.assertFalse(excel.read_dataset_csv(self.pairs(cumulative=False), 1)["need_request"])
        self.assertEqual(compute.call_count, 1)
        after = self.snapshot()
        self.assertEqual({key: after[key] for key in before}, before)
        self.assertEqual([path.name for path in self.sidecars.iterdir()], ["Paid.json"])

    def test_manual_mode_change_and_missing_publication_do_not_regenerate(self):
        self.publish(source_kind="input")
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            refused = excel.read_dataset_csv(self.pairs(cumulative=False), 1)
            self.assertFalse(refused["ok"])
            self.assertIn("cumulative or calendar mode differs", refused["message"])
            self.csv_path().unlink()
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertIn("no published CSV", result["message"])

    def test_corrupt_and_unreadable_sidecars_are_not_temporary_datasets(self):
        path = self.sidecars / "Paid.json"
        for body in ("broken", "[]", "{}"):
            path.write_text(body, encoding="utf-8")
            with self.assertRaises(HTTPException), patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
                excel.read_dataset_csv(self.pairs(), 1)
        with patch.object(file_read_cache, "read_json_file_cached", side_effect=PermissionError("Denied")), self.assertRaises(HTTPException):
            excel.read_dataset_csv(self.pairs(), 1)

    def test_temporary_generation_reuses_provenance_until_inputs_change(self):
        def calculate(pairs, path, timeout):
            Path(path).write_text("1,2\n3,\n", encoding="utf-8")
            self.assertNotEqual(Path(path), self.csv_path())
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute:
            self.assertTrue(excel.read_dataset_csv(self.pairs(), 1)["need_request"])
            self.assertFalse(excel.read_dataset_csv(self.pairs(), 1)["need_request"])
            self.signature = "inputs-v2"
            self.assertTrue(excel.read_dataset_csv(self.pairs(), 1)["need_request"])
        self.assertEqual(compute.call_count, 2)
        self.assertEqual(list(self.sidecars.iterdir()), [])
        self.assertEqual(list(self.cache.glob(".excel-*")), [])

    def test_concurrent_temporary_requests_share_one_generation(self):
        started, finish = threading.Event(), threading.Event()
        def calculate(pairs, path, timeout):
            started.set()
            self.assertTrue(finish.wait(3))
            Path(path).write_text("10\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute, ThreadPoolExecutor(2) as pool:
            first = pool.submit(excel.read_dataset_csv, self.pairs(), 1)
            self.assertTrue(started.wait(3))
            second = pool.submit(excel.read_dataset_csv, self.pairs(), 1)
            finish.set()
            self.assertTrue(first.result()["ok"])
            self.assertTrue(second.result()["ok"])
        self.assertEqual(compute.call_count, 1)

    def test_timeout_preserves_old_cache_and_uses_isolated_output(self):
        self.csv_path().write_text("old\n", encoding="utf-8")
        with patch.object(engine, "run_engine_calculation", return_value={"ok": False, "status": "timeout"}) as compute:
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertFalse(result["ok"])
        self.assertNotEqual(Path(compute.call_args.args[1]), self.csv_path())
        self.assertEqual(self.csv_path().read_text(), "old\n")

    def test_changed_inputs_during_calculation_do_not_replace_cache(self):
        self.csv_path().write_text("old\n", encoding="utf-8")
        def calculate(pairs, path, timeout):
            Path(path).write_text("10\n", encoding="utf-8")
            self.signature = "new-inputs"
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate):
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertEqual(result["status"], "inputs_changed")
        self.assertEqual(self.csv_path().read_text(), "old\n")

    def test_recursive_temporary_formulas_only_read_permanent_dependencies(self):
        self.publish()
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("Published input")):
            result = excel.read_dataset_csv(self.pairs("Quadruple"), 1)
        values = pd.read_csv(io.StringIO(result["csv_text"]), header=None).to_numpy()
        self.assertEqual(values[0, 0], 40)
        self.assertEqual(values[0, 2], 120)
        self.assertEqual(self.snapshot(), before)
        self.publish(text="20\n")
        self.assertEqual(excel.read_dataset_csv(self.pairs("Double"), 1)["csv_text"].strip(), "40.0")

    def test_engine_error_csv_does_not_replace_the_last_valid_temporary_cache(self):
        self.csv_path().write_text("10\n", encoding="utf-8")
        def calculate(pairs, path, timeout):
            Path(path).write_text("(data processing configuration error: missing field)\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate):
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "engine_error")
        self.assertEqual(self.csv_path().read_text(), "10\n")

    def test_invalid_permanent_csv_reports_frontend_refresh_without_engine(self):
        self.publish(text="(data processing configuration error: missing field)\n")
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertFalse(result["ok"])
        self.assertIn("valid numeric", result["message"])
        self.assertEqual(self.snapshot(), before)

    def test_cycles_and_busy_propagation_fail_without_publication(self):
        self.rows[1]["formula"] = '"Quadruple" * 2'
        result = excel.read_dataset_csv(self.pairs("Double"), 1)
        self.assertIn("cycle", result["message"])
        with patch.object(propagation, "get_reserving_class_busy", return_value={"busy": True}), self.assertRaises(HTTPException) as caught:
            excel.read_dataset_csv(self.pairs(), 1)
        self.assertEqual(caught.exception.status_code, 423)
        self.assertEqual(self.snapshot(), {})

    def test_temporary_formula_resolves_a_named_permanent_instance(self):
        self.publish(name="Reviewed paid", source_kind="result_selection", text="17\n", dataset_type="Paid")
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("Published instance")):
            result = excel.read_dataset_csv(self.pairs("Double"), 1)
        self.assertEqual(result["csv_text"].strip(), "34.0")
        self.assertEqual(self.snapshot(), before)

    def test_frontend_publication_during_generation_wins(self):
        def calculate(pairs, path, timeout):
            Path(path).write_text("10\n", encoding="utf-8")
            self.publish(text="99\n")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate):
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertEqual(result["csv_text"].strip(), "99")
        self.assertEqual(self.csv_path().read_text().strip(), "99")

    def test_engine_publication_period_is_not_its_finer_source_granularity(self):
        self.publish()
        sidecar = self.sidecars / "Paid.json"
        payload = json.loads(sidecar.read_text())
        payload.update(stored_origin_length=1, stored_development_length=1)
        sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
        result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["local_cache_status"], "cache_exact")
        self.assertFalse(excel.read_dataset_csv(self.pairs(period=1), 1)["ok"])
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            coarser = excel.read_dataset_csv(self.pairs(period=24), 1)
        self.assertTrue(coarser["ok"])
        pd.testing.assert_frame_equal(
            pd.read_csv(io.StringIO(coarser["csv_text"]), header=None),
            pd.DataFrame([[10, 80], [60, float("nan")]], dtype="float64"),
        )
        self.assertEqual(self.snapshot(), before)

    def test_engine_vector_publication_uses_csv_period(self):
        self.publish()
        sidecar = self.sidecars / "Paid.json"
        payload = json.loads(sidecar.read_text())
        payload.update(data_format="Vector", period_length=12, stored_period_length=1, csv_file="Paid@12.csv")
        sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
        (self.cache / "Paid@12.csv").write_text("10\n20\n", encoding="utf-8")
        pairs = [(key, "ArcRhoVec" if key == "Function" else value) for key, value in self.pairs()]
        result = excel.read_dataset_csv(pairs, 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["csv_text"].splitlines(), ["10", "20"])

    def test_engine_vector_rollup_sums_origins_using_published_period(self):
        self.publish()
        sidecar = self.sidecars / "Paid.json"
        payload = json.loads(sidecar.read_text())
        payload.update(data_format="Vector", period_length=12, stored_period_length=1, csv_file="Paid@12.csv")
        sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
        (self.cache / "Paid@12.csv").write_text("10\n20\n30\n40\n50\n", encoding="utf-8")
        (self.cache / "Paid@24.csv").write_text("999\n", encoding="utf-8")
        pairs = [(key, "ArcRhoVec" if key == "Function" else value) for key, value in self.pairs(period=24)]
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            result = excel.read_dataset_csv(pairs, 1)
        self.assertTrue(result["ok"])
        self.assertFalse(result["need_request"])
        self.assertEqual(result["local_cache_status"], "cache_derived")
        self.assertEqual(pd.read_csv(io.StringIO(result["csv_text"]), header=None)[0].tolist(), [30, 70, 50])
        self.assertEqual(self.snapshot(), before)

    def test_generated_publication_at_another_period_is_built_by_the_engine(self):
        self.publish()
        before = self.snapshot()
        def calculate(pairs, path, timeout):
            Path(path).write_text(f"{runtime._pair_value(pairs, 'OriginLength')}\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute:
            for period in (6, 18):
                with self.subTest(period=period):
                    result = excel.read_dataset_csv(self.pairs(period=period), 1)
                    self.assertTrue(result["ok"])
                    self.assertTrue(result["need_request"])
                    self.assertEqual(result["csv_text"].strip(), str(period))
                    self.assertEqual(Path(result["data_path"]), self.csv_path(period=period))
                    self.assertFalse(excel.read_dataset_csv(self.pairs(period=period), 1)["need_request"])
        self.assertEqual(compute.call_count, 2)
        after = self.snapshot()
        self.assertEqual({key: after[key] for key in before}, before)
        self.assertEqual([path.name for path in self.sidecars.iterdir()], ["Paid.json"])

    def test_disabled_derived_views_refuse_without_the_engine(self):
        self.publish()
        before = self.snapshot()
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            for period in (6, 24):
                with self.subTest(period=period):
                    result = excel.read_dataset_csv(self.pairs(period=period), 1, allow_derived=False)
                    self.assertFalse(result["ok"])
                    self.assertIn("derived views are disabled", result["message"])
        self.assertEqual(self.snapshot(), before)

    def test_engine_vector_finer_than_its_publication_is_built_from_the_source(self):
        self.publish()
        sidecar = self.sidecars / "Paid.json"
        payload = json.loads(sidecar.read_text())
        payload.update(data_format="Vector", period_length=12, stored_period_length=1, csv_file="Paid@12.csv")
        sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
        (self.cache / "Paid@12.csv").write_text("10\n20\n", encoding="utf-8")
        pairs = [(key, "ArcRhoVec" if key == "Function" else value) for key, value in self.pairs(period=3)]
        before = self.snapshot()
        def calculate(request, path, timeout):
            self.assertEqual(runtime._pair_value(request, "OriginLength"), "3")
            Path(path).write_text("1\n2\n3\n4\n5\n6\n7\n8\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute:
            result = excel.read_dataset_csv(pairs, 1)
            self.assertTrue(result["ok"])
            self.assertEqual(Path(result["data_path"]), self.cache / "Paid@3.csv")
            self.assertEqual(result["csv_text"].split(), [str(n) for n in range(1, 9)])
            self.assertFalse(excel.read_dataset_csv(pairs, 1)["need_request"])
            annual = excel.read_dataset_csv([(key, "12" if key in ("OriginLength", "DevelopmentLength") else value)
                                             for key, value in pairs], 1)
        self.assertEqual(compute.call_count, 1)
        self.assertEqual(annual["csv_text"].split(), ["10", "20"])
        self.assertEqual(annual["local_cache_status"], "cache_exact")
        after = self.snapshot()
        self.assertEqual({key: after[key] for key in before}, before)

    def test_refusal_names_the_published_and_requested_periods(self):
        self.publish(source_kind="input")
        with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
            result = excel.read_dataset_csv(self.pairs(period=6), 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], excel.PUBLICATION_SHAPE_STATUS)
        self.assertIn("published at 12-month origin and 12-month development periods", result["message"])
        self.assertIn("cannot be read at 6-month origin and 6-month development periods", result["message"])
        self.assertIn("finer to coarser", result["message"])

    def test_generated_triangle_rollup_retains_published_incremental_and_calendar_modes(self):
        cases = (
            (False, False, "1,2,3\n4,5,\n6,,\n", [[1, 14], [6, float("nan")]]),
            (True, True, "1,2,3\n,4,5\n,,6\n", [[6, 8], [float("nan"), 6]]),
            (False, True, "1,2,3\n,4,5\n,,6\n", [[7, 8], [float("nan"), 6]]),
        )
        for cumulative, calendar, text, expected in cases:
            with self.subTest(cumulative=cumulative, calendar=calendar):
                self.publish()
                sidecar = self.sidecars / "Paid.json"
                payload = json.loads(sidecar.read_text())
                payload["csv_file"] = f"Paid@12@12@{'cum' if cumulative else 'inc'}@{'cal' if calendar else 'dev'}.csv"
                sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
                (self.cache / payload["csv_file"]).write_text(text, encoding="utf-8")
                pairs = [(key, str(calendar) if key == "Calendar" else value)
                         for key, value in self.pairs(period=24, cumulative=cumulative)]
                before = self.snapshot()
                with patch.object(engine, "run_engine_calculation", side_effect=AssertionError("No Engine")):
                    result = excel.read_dataset_csv(pairs, 1)
                self.assertTrue(result["ok"])
                pd.testing.assert_frame_equal(
                    pd.read_csv(io.StringIO(result["csv_text"]), header=None),
                    pd.DataFrame(expected, dtype="float64"),
                )
                self.assertEqual(self.snapshot(), before)

    def test_saved_display_mode_does_not_relabel_published_csv_values(self):
        self.publish()
        sidecar = self.sidecars / "Paid.json"
        payload = json.loads(sidecar.read_text())
        payload.update(cumulative=False, calendar=True)
        sidecar.write_text(persisted_json_text(payload), encoding="utf-8")
        self.assertTrue(excel.read_dataset_csv(self.pairs(), 1)["ok"])
        self.assertFalse(excel.read_dataset_csv(self.pairs(cumulative=False), 1)["ok"])

    def test_invalid_generated_cache_is_repaired_even_when_provenance_matches(self):
        self.csv_path().write_text("(Engine error)\n", encoding="utf-8")
        runtime._require_runtime_cache_provenance(str(self.csv_path()), self.pairs(), lambda: self.signature)
        def calculate(pairs, path, timeout):
            Path(path).write_text("12\n", encoding="utf-8")
            return {"ok": True}
        with patch.object(engine, "run_engine_calculation", side_effect=calculate) as compute:
            result = excel.read_dataset_csv(self.pairs(), 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["csv_text"].strip(), "12")
        self.assertEqual(compute.call_count, 1)


if __name__ == "__main__":
    unittest.main()
