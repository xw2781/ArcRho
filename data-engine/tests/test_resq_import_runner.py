from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from arcrho_bridge import resq_import_runner as runner  # noqa: E402


class ResQImportRunnerTests(unittest.TestCase):
    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT))
        self.root = Path(self.temp_dir.name)
        self.runtime_environment_before = {
            key: os.environ.get(key)
            for key in ("ARCRHO_RUNTIME_SERVER_ROOT", "ARCRHO_FRONTEND_ROOT")
        }
        self.sys_path_before = list(sys.path)

    def tearDown(self):
        for key, value in self.runtime_environment_before.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        sys.path[:] = self.sys_path_before
        self.temp_dir.cleanup()

    def test_frozen_bundle_resolution_uses_only_the_deployed_bundle(self):
        bundle_root = self.root / "resq_importer"
        migration_dir = bundle_root / "python-api" / "migration"
        api_src = bundle_root / "python-api" / "src"
        (migration_dir / "resq_migration").mkdir(parents=True)
        (api_src / "arcrho_api").mkdir(parents=True)
        (migration_dir / "resq_data_migration.py").write_text("", encoding="utf-8")
        (migration_dir / "resq_migration" / "core.py").write_text("", encoding="utf-8")
        (migration_dir / "resq_migration" / "catalog.py").write_text("", encoding="utf-8")
        (api_src / "arcrho_api" / "dataset_index_contract.py").write_text("", encoding="utf-8")

        bundle = runner.locate_resq_migration_bundle(
            frozen=True,
            frozen_bundle_root=bundle_root,
        )

        self.assertEqual(bundle.source, "frozen")
        self.assertEqual(bundle.migration_dir, migration_dir)
        self.assertEqual(bundle.python_api_src, api_src)

    def test_runtime_configuration_precedes_migration_load_paths(self):
        server_root = self.root / "server"

        bundle = runner.configure_canonical_runtime(server_root)

        self.assertEqual(os.environ["ARCRHO_RUNTIME_SERVER_ROOT"], str(server_root.resolve()))
        self.assertEqual(
            os.environ["ARCRHO_FRONTEND_ROOT"],
            str((bundle.migration_dir.parents[1] / "frontend").resolve()),
        )
        self.assertIn(os.environ["ARCRHO_FRONTEND_ROOT"], sys.path)

    def test_engine_failure_restores_the_prior_engine_component_before_commit(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        self._write_dataset(live_rc, "old-engine", source_kind="engine", value="old-engine")

        events = []
        refresh_calls = []
        rebuild_calls = []

        def importer(project_name, rc_path, **kwargs):
            self.assertEqual(project_name, "Demo")
            self.assertEqual(rc_path, r"Business\Auto")
            self.assertTrue(kwargs["cleanup_target"])
            self.assertTrue(kwargs["skip_unavailable_engine"])
            self.assertEqual(Path(kwargs["server_root"]), server_root)
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "new-resq", source_kind="input", value="new")
            # This represents a partial fresh engine output. It must not reach
            # the committed RC when the engine stage was unavailable.
            self._write_dataset(stage_rc, "new-engine", source_kind="engine", value="new-engine")
            return {
                "errors": 0,
                "engine_errors": 0,
                "engine_available": False,
                "total_written": 1,
            }

        module = SimpleNamespace(
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            refresh_sidecar_graphs_for_rc=lambda path: refresh_calls.append(Path(path)),
            rebuild_dataset_instance_index=lambda project, rc, path: rebuild_calls.append(
                (project, rc, Path(path))
            ),
        )
        request = {
            "RequestId": "run-123",
            "ProjectName": "Demo",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
            "UserName": "tester",
        }

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            result = runner.run_reserving_class_import(request, events.append)

        self.assertTrue(result["committed"])
        self.assertTrue(result["engine_component_preserved"])
        self.assertEqual(result["engine_artifacts_restored"], 1)
        self.assertTrue((live_rc / "sidecars" / "new-resq.json").is_file())
        self.assertTrue((live_rc / "datasets" / "new-resq.csv").is_file())
        self.assertTrue((live_rc / "sidecars" / "old-engine.json").is_file())
        self.assertTrue((live_rc / "datasets" / "old-engine.csv").is_file())
        self.assertFalse((live_rc / "sidecars" / "new-engine.json").exists())
        self.assertFalse((live_rc / "datasets" / "new-engine.csv").exists())
        self.assertFalse((live_rc / "sidecars" / "old-resq.json").exists())
        self.assertEqual(refresh_calls, [server_root / "r" / "run-123" / "d" / "rc"])
        self.assertEqual(
            rebuild_calls,
            [("Demo", r"Business\Auto", refresh_calls[0])],
        )
        self.assertTrue(any(event.get("event") == "commit" for event in events))
        self.assertFalse((server_root / "r" / "run-123").exists())

    def test_non_engine_errors_leave_the_live_rc_untouched(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "partial", source_kind="input", value="partial")
            return {
                "errors": 1,
                "engine_errors": 0,
                "engine_available": True,
                "error_details": [{
                    "kind": "dfm",
                    "name": "Broken DFM",
                    "message": r"Input is unavailable at E:\ArcRho Server\projects\Demo\data\missing.csv",
                }],
            }

        module = SimpleNamespace(
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
        )
        request = {
            "RequestId": "run-456",
            "ProjectName": "Demo",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
            "UserName": "tester",
        }

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            self.assertRaises(runner.ResQImportCommitError) as raised,
        ):
            runner.run_reserving_class_import(request)

        self.assertTrue((live_rc / "sidecars" / "old-resq.json").is_file())
        self.assertFalse((live_rc / "sidecars" / "partial.json").exists())
        self.assertEqual(raised.exception.status_result["errors"], 1)
        self.assertEqual(raised.exception.status_result["error_details"][0]["name"], "Broken DFM")
        self.assertNotIn("E:\\", raised.exception.status_result["error_details"][0]["message"])

    def test_backup_cleanup_failure_keeps_the_committed_import_and_old_backup(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "new-resq", source_kind="input", value="new")
            return {"errors": 0, "engine_errors": 0, "engine_available": True}

        module = SimpleNamespace(
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            refresh_sidecar_graphs_for_rc=lambda _path: 0,
            rebuild_dataset_instance_index=lambda *_args: None,
        )
        request = {
            "RequestId": "run-backup-cleanup",
            "ProjectName": "Demo",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
            "UserName": "tester",
        }

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            patch.object(
                runner,
                "_remove_validated_tree",
                side_effect=OSError("network share is busy"),
            ),
        ):
            result = runner.run_reserving_class_import(request)

        staging_root = server_root / "r" / "run-backup-cleanup"
        self.assertTrue(result["committed"])
        self.assertFalse(result["previous_data_deleted"])
        self.assertIn("previous reserving-class folder", result["message"])
        self.assertTrue((live_rc / "sidecars" / "new-resq.json").is_file())
        self.assertTrue((staging_root / "previous" / "sidecars" / "old-resq.json").is_file())

    def test_lock_failure_removes_its_new_job_folder(self):
        server_root = self.root / "server"
        staging_parent = server_root / "r"
        lock_dir = staging_parent / ".locks"
        lock_dir.mkdir(parents=True)
        rc_path = r"Business\Auto"
        (lock_dir / runner._lock_file_name("Demo", rc_path)).write_text(
            '{"request_id":"other"}\n',
            encoding="utf-8",
        )
        request = {
            "RequestId": "run-locked",
            "ProjectName": "Demo",
            "Path": rc_path,
            "ExportMode": "configured",
            "UserName": "tester",
        }
        module = SimpleNamespace(_encode_rc_folder=lambda _rc_path: "rc")

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            self.assertRaises(runner.ResQImportCommitError),
        ):
            runner.run_reserving_class_import(request)

        self.assertFalse((staging_parent / "run-locked").exists())

    def test_request_values_cannot_select_a_target_path(self):
        request = {
            "RequestId": "run-789",
            "ProjectName": "..",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
        }
        with self.assertRaises(runner.ResQImportRequestError):
            runner.run_reserving_class_import(request)

    def _write_dataset(self, rc_dir: Path, name: str, *, source_kind: str, value: str):
        dataset_dir = rc_dir / "datasets"
        sidecar_dir = rc_dir / "sidecars"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        sidecar_dir.mkdir(parents=True, exist_ok=True)
        csv_name = f"{name}.csv"
        (dataset_dir / csv_name).write_text(value + "\n", encoding="utf-8")
        (sidecar_dir / f"{name}.json").write_text(
            json.dumps(
                {
                    "dataset_name": name,
                    "source_kind": source_kind,
                    "csv_file": csv_name,
                }
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
