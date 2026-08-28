"""Cover the ArcRho-to-ResQ writer the Export and Sync macros share.

The Bridge loads ``export_reserving_class_to_resq.py`` from its bundle and the
sync session drives its per-method writers, so these tests load the macro file
the same way and exercise the writer without a ResQ session.
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock


_MACRO_PATH = Path(__file__).resolve().parents[1] / "macros" / "export_reserving_class_to_resq.py"


def _load_macro():
    spec = importlib.util.spec_from_file_location("export_reserving_class_macro_under_test", _MACRO_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExportMacroMethodNotesTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro()

    def _exporter(self):
        migration = types.SimpleNamespace(CONNECTION_NAME="ResQ", USER_NAME="user", PASSWORD="secret")
        exporter = self.module.ResQReservingClassExporter(
            migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=Path(".")
        )
        exporter.reserving_class = types.SimpleNamespace(DFMMethods=lambda: [])
        exporter._find_in = Mock()
        exporter._sync_dfm_excluded_ratios = Mock(return_value=0)
        exporter._sync_dfm_user_entry_values = Mock(return_value=0)
        exporter._sync_dfm_selected_ratios = Mock(return_value=0)
        return exporter

    def test_collect_rc_artifacts_attaches_output_sidecar_notes_to_method_entries(self):
        with tempfile.TemporaryDirectory() as temp:
            rc_dir = Path(temp)
            (rc_dir / "sidecars").mkdir()
            (rc_dir / "methods").mkdir()
            for method_name, output_name in (("Paid DFM", "Paid CDF"), ("Orphan DFM", "Orphan CDF")):
                method = {"details_tab": {"name": method_name, "output_dataset": output_name}}
                (rc_dir / "methods" / f"DFM@{method_name}.json").write_text(json.dumps(method), encoding="utf-8")
            sidecar = {"dataset_name": "Paid CDF", "method_type": "DFM", "notes": "Excluded 2020."}
            (rc_dir / "sidecars" / "Paid CDF.json").write_text(json.dumps(sidecar), encoding="utf-8")
            migration = types.SimpleNamespace(DATASET_SIDECAR_DIR="sidecars", METHOD_DATA_DIR="methods")

            _sidecars, methods = self.module.collect_rc_artifacts(migration, rc_dir)

        by_name = {entry["name"]: entry for entry in methods["DFM"]}
        self.assertEqual(by_name["Paid DFM"]["notes"], "Excluded 2020.")
        self.assertNotIn("notes", by_name["Orphan DFM"])

    def test_export_dfm_writes_notes_with_resq_line_breaks(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "Old note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "Excluded 2020.\nSelected 3-year."})

        self.assertEqual(dfm.Notes, "Excluded 2020.\r\nSelected 3-year.")
        dfm.Save.assert_called_once()
        self.assertEqual(exporter.counts["dfms_written"], 1)

    def test_export_dfm_clears_notes_for_a_blank_value_and_keeps_them_without_one(self):
        exporter = self._exporter()
        dfm = Mock()
        dfm.Notes = "ResQ note"
        exporter._find_in.return_value = dfm

        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}, "notes": "  \n"})
        self.assertEqual(dfm.Notes, "")

        dfm.Notes = "ResQ note"
        exporter._export_dfm("Paid DFM", {}, {}, {"name": "Paid DFM", "payload": {}})
        self.assertEqual(dfm.Notes, "ResQ note")

    def test_export_dataset_writes_the_sidecar_notes_before_saving_values(self):
        with tempfile.TemporaryDirectory() as temp:
            server_root = Path(temp)
            cache = server_root / "projects" / "Project" / "data" / "RC" / "cache"
            cache.mkdir(parents=True)
            (cache / "Paid Loss@12.csv").write_text("1\n", encoding="utf-8")
            migration = types.SimpleNamespace(
                CONNECTION_NAME="ResQ",
                USER_NAME="user",
                PASSWORD="secret",
                DATASET_CACHE_DIR="cache",
                _encode_rc_folder=lambda _path: "RC",
            )
            exporter = self.module.ResQReservingClassExporter(
                migration, arcrho_project_name="Project", rc_path="Line/Class", server_root=server_root
            )
            target = Mock()
            target.Calculated = False
            target.Notes = ""
            exporter._find_dataset = Mock(return_value=target)
            exporter._write_vector_values = Mock()
            sidecar = {
                "dataset_name": "Paid Loss",
                "data_format": "Vector",
                "csv_file": "Paid Loss@12.csv",
                "notes": "Loaded from claims.\nReviewed.",
            }

            exporter._export_dataset_values(sidecar, "Paid Loss")

        self.assertEqual(target.Notes, "Loaded from claims.\r\nReviewed.")
        exporter._write_vector_values.assert_called_once()
        self.assertEqual(exporter.counts["datasets_written"], 1)


if __name__ == "__main__":
    unittest.main()
