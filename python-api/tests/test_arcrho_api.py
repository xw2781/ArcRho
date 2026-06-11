from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import arcrho_api.config as api_config
from arcrho_api.agent import main as agent_main
from arcrho_api import ArcRhoClient, DfmDataError, ReadOnlyError, get_config_path, get_server_root, set_server_root
from arcrho_api.paths import dfm_filename
from arcrho_api.migration import ArcRhoSession


_LOG_DIR = Path(__file__).resolve().parent / "logs"
_TMP_ROOT = _LOG_DIR / "tmp"
_LOG_PATH = _LOG_DIR / f"{Path(__file__).stem}_{time.strftime('%Y%m%d_%H%M%S')}_{os.getpid()}.log"
_LOG_READY = False


def _prune_logs() -> None:
    logs = sorted(
        _LOG_DIR.glob(f"{Path(__file__).stem}_*.log"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )
    for old_log in logs[3:]:
        try:
            old_log.unlink()
        except OSError:
            pass


def test_log(message: str) -> None:
    global _LOG_READY
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        if not _LOG_READY:
            _prune_logs()
            _LOG_READY = True
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with _LOG_PATH.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(f"{timestamp} | {message}\n")
    except OSError:
        pass


def sample_payload() -> dict:
    return {
        "json format": "arcrho-dfm-method-by-tab-v1",
        "details tab": {
            "name": "Paid DFM",
            "output type": "Paid Ultimate",
            "input triangle": "Paid Loss",
            "origin length": 12,
            "development length": 12,
            "decimal places": 4,
        },
        "data tab": {
            "origin labels": ["2019", "2020", "2021"],
            "development labels": ["12m", "24m", "36m"],
            "input data triangle csv path": "",
        },
        "ratios tab": {
            "ratio triangle": {
                "origin labels": ["2019", "2020", "2021"],
                "development labels": ["(1) 12-24", "(2) 24-36"],
                "ratio values": [[1.1, 1.2], [1.5, 1.1], [0.9, 1.4]],
                "excluded": [[0, 0], [0, 0], [0, 0]],
            },
            "average formulas": {
                "label": ["Volume - all", "Simple - 3", "User Entry"],
                "custom average formula settings": {
                    "averageType": ["custom", "custom", "user_entry"],
                    "base": ["volume", "simple", ""],
                    "periods": ["all", 3, "all"],
                    "exclude": [0, 0, 0],
                },
                "selected": [[0, 0], [0, 0], [0, 0]],
                "values": [[1.0, 1.0], [1.2, 1.3], [None, None]],
            },
        },
        "results tab": {
            "ratio basis dataset": "",
            "ultimate ratio decimal places": 2,
            "ultimate vector csv path": "",
        },
        "notes tab": {"notes": "original"},
        "method metadata": {"last modified": "2026-01-01T00:00:00"},
        "unknown section": {"preserve": True},
    }


class ArcRhoApiTests(unittest.TestCase):
    def setUp(self) -> None:
        test_log(f"START {self.id()}")
        test_log(f"SETUP_STEP ensure_tmp_root={_TMP_ROOT}")
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        test_log("SETUP_STEP create_temporary_directory")
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        test_log(f"SETUP_STEP temporary_directory_created={self.tmp.name}")
        self.root = Path(self.tmp.name) / "ArcRho Server"
        self.project_dir = self.root / "projects" / "Demo"
        self.data_dir = self.project_dir / "data"
        self.rc_data_dir = self.data_dir / "Auto_%5C_PP"
        self.datasets_dir = self.rc_data_dir / "datasets"
        self.methods_dir = self.rc_data_dir / "methods"
        self.sidecars_dir = self.rc_data_dir / "sidecars"
        test_log(f"SETUP_STEP mkdir_datasets={self.datasets_dir}")
        self.datasets_dir.mkdir(parents=True)
        test_log(f"SETUP_STEP mkdir_methods={self.methods_dir}")
        self.methods_dir.mkdir(parents=True)
        test_log(f"SETUP_STEP mkdir_sidecars={self.sidecars_dir}")
        self.sidecars_dir.mkdir(parents=True)
        self.method_path = self.methods_dir / dfm_filename("Paid DFM")
        self.input_csv = self.datasets_dir / "input.csv"
        test_log(f"SETUP_STEP write_input_csv={self.input_csv}")
        self.input_csv.write_text("10,20,30\n11,22,\n12,,\n", encoding="utf-8")
        self.ultimate_csv = self.datasets_dir / "ultimate.csv"
        test_log(f"SETUP_STEP write_ultimate_csv={self.ultimate_csv}")
        self.ultimate_csv.write_text("100\n200\n300\n", encoding="utf-8")
        test_log("SETUP_STEP build_payload")
        payload = sample_payload()
        payload["data tab"]["input data triangle csv path"] = str(self.input_csv)
        payload["results tab"]["ultimate vector csv path"] = str(self.ultimate_csv)
        test_log(f"SETUP_STEP write_method={self.method_path}")
        self.method_path.write_text(json.dumps(payload), encoding="utf-8")
        test_log(
            "SETUP "
            f"root={self.root} rc_data_dir={self.rc_data_dir} "
            f"method_path={self.method_path} input_csv={self.input_csv} ultimate_csv={self.ultimate_csv}"
        )

    def tearDown(self) -> None:
        test_log(f"TEARDOWN {self.id()} root={getattr(self, 'root', '')}")
        try:
            self.tmp.cleanup()
            test_log(f"END {self.id()}")
        except Exception as err:
            test_log(f"TEARDOWN_ERROR {self.id()} {err!r}")
            raise

    def test_client_project_and_index(self) -> None:
        client = ArcRhoClient(self.root)
        self.assertEqual(client.list_projects(), ["Demo"])
        project = client.project("demo")
        refs = project.rebuild_dfm_index()
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0].name, "Paid DFM")
        index = json.loads((self.rc_data_dir / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["files"], [{
            "dataset_name": "Paid Ultimate",
            "dataset_type_name": "Paid Ultimate",
            "method_type": "DFM",
        }])

    def test_default_server_root_uses_host_workspace_config(self) -> None:
        original_root = api_config._server_root
        with tempfile.TemporaryDirectory(dir=r"C:\tmp") as appdata, patch.dict(os.environ, {"APPDATA": appdata}, clear=False):
            try:
                config_path = Path(appdata) / "ArcRho" / "workspace_paths.json"
                config_path.parent.mkdir(parents=True)
                config_path.write_text(json.dumps({"workspace_root": str(self.root)}), encoding="utf-8")
                api_config._server_root = None
                self.assertEqual(get_server_root(), self.root.resolve())
                self.assertEqual(ArcRhoClient().server_root, self.root.resolve())
                self.assertEqual(get_config_path(), config_path)
            finally:
                api_config._server_root = original_root

    def test_set_server_root_writes_host_workspace_config(self) -> None:
        original_root = api_config._server_root
        with tempfile.TemporaryDirectory(dir=r"C:\tmp") as appdata, patch.dict(os.environ, {"APPDATA": appdata}, clear=False):
            try:
                api_config._server_root = None
                config_path = Path(appdata) / "ArcRho" / "workspace_paths.json"
                configured = set_server_root(self.root)
                self.assertEqual(configured, self.root.resolve())
                saved = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(saved["workspace_root"], str(self.root.resolve()))
                self.assertEqual(saved["paths"], {"projects_dir": "projects", "requests_dir": "requests"})
            finally:
                api_config._server_root = original_root

    def test_dfm_helpers_preserve_unknown_fields(self) -> None:
        payload = json.loads(self.method_path.read_text(encoding="utf-8"))
        payload["ratios tab"]["percent developed curve"] = {"x-axis label": "Development Month", "selected curves": []}
        self.method_path.write_text(json.dumps(payload), encoding="utf-8")
        dfm = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP").dfm("Paid DFM")
        dfm.clear()
        dfm.ex_COVID_AY()
        dfm.ex_AY(2020, "exclude accident year")
        dfm.ex_hi(1, 1, "high ratio")
        dfm.select_low(2, 1)
        dfm.set_selected_estimate("Simple - 3", "all")
        dfm.set_user_formula('="Simple - 3" * 0.961538', 1.25, 2)
        dfm.add_notes("reviewed")
        dfm.save()
        saved_text = self.method_path.read_text(encoding="utf-8")
        saved = json.loads(saved_text)
        self.assertEqual(saved["unknown section"], {"preserve": True})
        self.assertNotIn("input data triangle values", saved["data tab"])
        self.assertNotIn("percent developed curve", saved["ratios tab"])
        self.assertNotIn("ultimate vector", saved["results tab"])
        self.assertEqual(saved["ratios tab"]["ratio triangle"]["excluded"][1], [1, 0])
        self.assertIn("[1, 1]", saved_text)
        self.assertEqual(saved["ratios tab"]["average formulas"]["selected"][1][0], 1)
        self.assertEqual(saved["ratios tab"]["average formulas"]["selected"][2][1], 1)
        self.assertEqual(saved["ratios tab"]["average formulas"]["inputs"][2][1], '="Simple - 3" * 0.961538')
        self.assertEqual(saved["ratios tab"]["average formulas"]["values"][2][1], 1.25)
        self.assertIn("reviewed", saved["notes tab"]["notes"])
        self.assertNotEqual(saved["method metadata"]["last modified"], "2026-01-01T00:00:00")

    def test_read_only_blocks_save(self) -> None:
        dfm = ArcRhoClient(self.root, read_only=True).project("Demo").reserving_class(r"Auto\PP").dfm("Paid DFM")
        dfm.add_notes("blocked")
        with self.assertRaises(ReadOnlyError):
            dfm.save()

    def test_new_dfm_minimum_payload(self) -> None:
        rc = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP")
        dfm = rc.new_dfm(
            "New DFM",
            output_vector="New Ultimate",
            input_triangle="Paid Loss",
            origin_length=12,
            development_length=12,
        )
        dfm.save()
        self.assertTrue((self.methods_dir / dfm_filename("New DFM")).exists())

    def test_project_reads_dataset_type_category(self) -> None:
        (self.project_dir / "dataset_types.json").write_text(json.dumps({
            "columns": ["Name", "Data Format", "Category", "Calculated", "Formula", "Source"],
            "rows": [["Odd Output", "Vector", "C Claim Count", False, "", ""]],
        }), encoding="utf-8")
        project = ArcRhoClient(self.root).project("Demo")
        info = project.dataset_type("Odd Output")
        self.assertIsNotNone(info)
        self.assertEqual(info.category, "C Claim Count")
        self.assertEqual(project.dataset_type_category("Odd Output"), "C Claim Count")

    def test_migration_session(self) -> None:
        session = ArcRhoSession(self.root)
        session.set_project("Demo")
        session.set_reserving_class(r"Auto\PP")
        dfm = session.DFM("Paid DFM")
        self.assertEqual(dfm.name, "Paid DFM")

    def test_csv_backed_components_and_agent_edits(self) -> None:
        rc = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP")
        self.assertEqual(rc.list_datasets(), ["input", "ultimate"])
        self.assertEqual(rc.dataset_path("input"), self.input_csv)
        self.assertEqual(rc.read_triangle("input")[0], [10.0, 20.0, 30.0])
        dfm = rc.dfm("Paid DFM")
        self.assertEqual(dfm.input_data_triangle()[0], [10.0, 20.0, 30.0])
        self.assertEqual(dfm.ultimate_vector(), [100.0, 200.0, 300.0])
        summary = dfm.agent_summary()
        self.assertEqual(summary["api method"], "DfmMethod.agent_summary")
        dfm.exclude_ratio("2020", "(1) 12-24").set_selected_average_by_label("Simple - 3", "(2) 24-36").save()
        saved = json.loads(self.method_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["ratios tab"]["ratio triangle"]["excluded"][1][0], 1)
        self.assertEqual(saved["ratios tab"]["average formulas"]["selected"][1][1], 1)

    def test_add_triangle_reuses_existing_generated_cache(self) -> None:
        rc = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP")
        cache_path = rc.triangle_cache_path("Paid/Loss", origin_length=12, development_length=12)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text("1,2\n3,\n", encoding="utf-8")

        result = rc.add_triangle("Paid/Loss", origin_length=12, development_length=12)

        self.assertTrue(result.from_cache)
        self.assertEqual(result.file_path, cache_path)
        self.assertIsNone(result.request_path)
        sidecar = self.sidecars_dir / "Paid_%2F_Loss.json"
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(payload["dataset_name"], "Paid/Loss")
        self.assertEqual(payload["csv_file"], "Paid_%2F_Loss@12@12@cum@dev.csv")

    def test_add_triangle_requests_missing_generated_cache(self) -> None:
        rc = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP")
        requests_dir = self.root / "requests"
        test_log(f"ARC_TRI_REQUEST_TEST requests_dir={requests_dir}")

        def write_requested_csv() -> None:
            test_log("ARC_TRI_WRITER start")
            deadline = time.time() + 5
            while time.time() < deadline:
                request_files = sorted(requests_dir.glob("request-*.json")) if requests_dir.exists() else []
                if request_files:
                    test_log(f"ARC_TRI_WRITER found_request={request_files[0]}")
                    payload = json.loads(request_files[0].read_text(encoding="utf-8"))
                    data_path = Path(payload["DataPath"])
                    data_path.parent.mkdir(parents=True, exist_ok=True)
                    data_path.write_text("4,5\n6,\n", encoding="utf-8")
                    test_log(f"ARC_TRI_WRITER wrote_csv={data_path}")
                    return
                time.sleep(0.05)
            test_log("ARC_TRI_WRITER timeout_waiting_for_request")

        writer = threading.Thread(target=write_requested_csv)
        writer.start()
        test_log("ARC_TRI_MAIN calling_add_triangle")
        result = rc.add_triangle("Missing Triangle", timeout_sec=3)
        test_log(f"ARC_TRI_MAIN add_triangle_returned file_path={result.file_path} from_cache={result.from_cache}")
        writer.join(timeout=1)
        test_log(f"ARC_TRI_MAIN writer_alive_after_join={writer.is_alive()}")

        self.assertFalse(result.from_cache)
        self.assertIsNotNone(result.request_path)
        self.assertEqual(result.file_path.read_text(encoding="utf-8"), "4,5\n6,\n")
        request_payload = json.loads(result.request_path.read_text(encoding="utf-8"))
        self.assertEqual(request_payload["Function"], "ArcRhoTri")
        self.assertEqual(request_payload["Path"], r"Auto\PP")
        self.assertEqual(request_payload["DatasetName"], "Missing Triangle")
        self.assertEqual(request_payload["ProjectName"], "Demo")
        self.assertEqual(request_payload["DataPath"], str(result.file_path))

    def test_dfm_cell_note_helpers_use_display_labels_and_clear_summary_column(self) -> None:
        payload = sample_payload()
        payload["ratios tab"]["cell notes"] = {
            "ratio main table": {"2019": {"(1) 12-24": "keep"}},
            "ratio summary table": {
                "Old Average": {"(1) 12-24": "stale"},
                "(1) 12-24": {"Legacy Old Average": "legacy stale"},
            },
        }
        self.method_path.write_text(json.dumps(payload), encoding="utf-8")
        dfm = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP").dfm("Paid DFM")
        dfm.set_selected_average("Simple - 3", 1)
        dfm.set_selected_average_cell_note(1, "Selected before adjustments.", clear_column=True)
        dfm.set_cell_note("1: Volume - all", "(2) 24-36", "other note")
        saved = dfm.to_dict()
        self.assertEqual(saved["ratios tab"]["cell notes"]["ratio main table"]["2019"], {"(1) 12-24": "keep"})
        self.assertNotIn("Old Average", saved["ratios tab"]["cell notes"]["ratio summary table"])
        self.assertNotIn("(1) 12-24", saved["ratios tab"]["cell notes"]["ratio summary table"])
        self.assertEqual(
            saved["ratios tab"]["cell notes"]["ratio summary table"]["Simple - 3"],
            {"(1) 12-24": "Selected before adjustments."},
        )
        self.assertEqual(
            saved["ratios tab"]["cell notes"]["ratio summary table"]["Volume - all"],
            {"(2) 24-36": "other note"},
        )
        dfm.clear_cell_notes_for_development("(2) 24-36")
        self.assertNotIn("Volume - all", dfm.to_dict()["ratios tab"]["cell notes"]["ratio summary table"])

    def test_agent_inspect_bundles_summary_components_and_ratio_rows(self) -> None:
        output = StringIO()
        with redirect_stdout(output):
            exit_code = agent_main([
                "--file",
                str(self.method_path),
                "inspect",
                "--include",
                "summary,average-formulas,ratio-triangle",
                "--origin",
                "2020",
            ])
        self.assertEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["api method"], "DfmMethod.agent_inspect")
        self.assertEqual(payload["included"], ["summary", "average-formulas", "ratio-triangle"])
        self.assertEqual(payload["components"]["summary"]["api method"], "DfmMethod.agent_summary")
        self.assertEqual(payload["components"]["average formulas"]["api method"], "DfmMethod.average_formula_summary")
        self.assertEqual(payload["components"]["ratio triangle"]["values"][0], [1.1, 1.2])
        self.assertEqual(payload["ratio rows"][0]["origin label"], "2020")

    def test_missing_ratio_data_raises(self) -> None:
        rc = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP")
        dfm = rc.new_dfm(
            "Empty",
            output_vector="Output",
            input_triangle="Input",
            origin_length=12,
            development_length=12,
        )
        with self.assertRaises(DfmDataError):
            dfm.ex_hi(1)

    def test_save_uses_row_compact_json_and_trims_triangle_rows(self) -> None:
        payload = sample_payload()
        payload["ratios tab"]["ratio triangle"]["ratio values"] = [[1.2, None, None]]
        payload["ratios tab"]["ratio triangle"]["excluded"] = [[1, 0, 2, 2]]
        payload["ratios tab"]["average formulas"]["values"] = [[1.2, None], [None, None], [1.3, None]]
        self.method_path.write_text(json.dumps(payload), encoding="utf-8")
        dfm = ArcRhoClient(self.root).project("Demo").reserving_class(r"Auto\PP").dfm("Paid DFM")
        dfm.save()
        saved_text = self.method_path.read_text(encoding="utf-8")
        saved = json.loads(saved_text)
        self.assertEqual(saved["ratios tab"]["ratio triangle"]["ratio values"], [[1.2]])
        self.assertEqual(saved["ratios tab"]["ratio triangle"]["excluded"], [[1]])
        self.assertEqual(saved["ratios tab"]["average formulas"]["values"], [[1.2], [], [1.3]])
        self.assertIn("[1.2]", saved_text)
        self.assertIn("[1]", saved_text)


if __name__ == "__main__":
    unittest.main()
