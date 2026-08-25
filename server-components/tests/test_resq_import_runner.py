from __future__ import annotations

import errno
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENGINE_SRC = REPOSITORY_ROOT / "server-components" / "src"
CANONICAL_SRC = REPOSITORY_ROOT / "python-api" / "src"
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
for source_root in (ENGINE_SRC, CANONICAL_SRC):
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))

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
        (api_src / "arcrho_api" / "engine_dataset_sidecar_contract.py").write_text("", encoding="utf-8")

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

        def rebuild(project, rc, path):
            rebuild_calls.append((project, rc, Path(path)))
            self._write_index(Path(path))

        module = SimpleNamespace(
            INDEX_FILE_NAME="index.json",
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            merge_preserved_arcrho_artifacts=lambda _live, _stage, **_kwargs: {
                "groups": 0,
                "files": 0,
                "names": [],
            },
            refresh_sidecar_graphs_for_rc=lambda path: refresh_calls.append(Path(path)),
            rebuild_dataset_instance_index=rebuild,
        )

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-123"), events.append)

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

    def test_item_errors_skip_the_item_and_still_commit_the_rc(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")

        events = []

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "partial", source_kind="input", value="partial")
            return {
                "errors": 1,
                "engine_errors": 0,
                "engine_available": True,
                "total_written": 1,
                "error_details": [{
                    "kind": "vector",
                    "name": "G 41 - BF Paid",
                    "message": r"Input is unavailable at E:\ArcRho Server\projects\Demo\data\missing.csv",
                }],
            }

        module = SimpleNamespace(
            INDEX_FILE_NAME="index.json",
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            merge_preserved_arcrho_artifacts=lambda _live, _stage, **_kwargs: {
                "groups": 0,
                "files": 0,
                "names": [],
            },
            refresh_sidecar_graphs_for_rc=lambda _path: None,
            rebuild_dataset_instance_index=(
                lambda _project, _rc, path: self._write_index(Path(path))
            ),
        )

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-456"), events.append)

        self.assertTrue(result["committed"])
        self.assertTrue((live_rc / "sidecars" / "partial.json").is_file())
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["error_details"][0]["name"], "G 41 - BF Paid")
        self.assertNotIn("E:\\", result["error_details"][0]["message"])
        self.assertTrue(any(event.get("kind") == "resq_skip" for event in events))

    def test_merge_runs_before_graph_refresh_and_commit(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "ArcRho-only", source_kind="calculated", value="keep")
        events = []
        order = []

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "new-resq", source_kind="input", value="new")
            return {"errors": 0, "engine_errors": 0, "engine_available": True}

        merge_kwargs = []

        def merge(live, stage, **kwargs):
            order.append("merge")
            merge_kwargs.append(kwargs)
            source = Path(live) / "sidecars" / "ArcRho-only.json"
            target = Path(stage) / "sidecars" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
            source_csv = Path(live) / "datasets" / "ArcRho-only.csv"
            target_csv = Path(stage) / "datasets" / source_csv.name
            target_csv.write_bytes(source_csv.read_bytes())
            return {"groups": 1, "files": 2, "names": ["ArcRho-only"]}

        def refresh(_path):
            order.append("refresh")

        module = SimpleNamespace(
            INDEX_FILE_NAME="index.json",
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            merge_preserved_arcrho_artifacts=merge,
            refresh_sidecar_graphs_for_rc=refresh,
            rebuild_dataset_instance_index=lambda _project, _rc, path: self._write_index(Path(path)),
        )

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            result = runner.run_reserving_class_import(
                self._swap_request("run-merge-policy"),
                events.append,
            )

        self.assertEqual(order, ["merge", "refresh"])
        # A request with no policy keeps today's merge behavior.
        self.assertEqual(merge_kwargs, [{"overwrite": False}])
        self.assertEqual(result["import_policy"], "merge")
        self.assertEqual(result["arcrho_groups_preserved"], 1)
        self.assertEqual(result["arcrho_artifacts_preserved"], 2)
        self.assertTrue((live_rc / "sidecars" / "ArcRho-only.json").is_file())
        self.assertTrue(any(event.get("kind") == "arcrho_merge" for event in events))

    def test_an_overwrite_request_skips_the_newer_live_protection(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        merge_kwargs = []
        module = self._swap_module()
        original_merge = module.merge_preserved_arcrho_artifacts
        module.merge_preserved_arcrho_artifacts = (
            lambda live, stage, **kwargs: merge_kwargs.append(kwargs)
            or original_merge(live, stage)
        )
        request = {**self._swap_request("run-overwrite"), "ImportPolicy": "overwrite"}

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            result = runner.run_reserving_class_import(request)

        self.assertTrue(result["committed"])
        self.assertEqual(result["import_policy"], "overwrite")
        self.assertEqual(merge_kwargs, [{"overwrite": True}])

    def test_an_unknown_import_policy_is_rejected_before_any_work(self):
        server_root = self.root / "server"
        request = {**self._swap_request("run-bad-policy"), "ImportPolicy": "replace"}

        with patch.object(runner, "get_project_root", return_value=server_root):
            with self.assertRaisesRegex(runner.ResQImportRequestError, "ImportPolicy"):
                runner.run_reserving_class_import(request)
        self.assertFalse((server_root / "r").exists())

    def test_backup_cleanup_failure_keeps_the_committed_import_and_old_backup(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
            patch.object(
                runner,
                "_remove_validated_tree",
                side_effect=OSError("network share is busy"),
            ),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-backup-cleanup"))

        staging_root = server_root / "r" / "run-backup-cleanup"
        self.assertTrue(result["committed"])
        self.assertFalse(result["previous_data_deleted"])
        self.assertIn("previous reserving-class files", result["message"])
        self.assertTrue((live_rc / "sidecars" / "new-resq.json").is_file())
        self.assertTrue((staging_root / "previous" / "sidecars" / "old-resq.json").is_file())

    def test_the_commit_replaces_files_and_writes_the_index_last(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "kept", source_kind="input", value="old")
        self._write_dataset(live_rc, "dropped-by-resq", source_kind="input", value="old")
        self._write_index(live_rc, "live")
        installed = []
        real_replace = runner.os.replace

        def recording_replace(source, target):
            if str(target).startswith(str(live_rc)):
                installed.append(Path(target).name)
            return real_replace(source, target)

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(
                runner,
                "load_resq_data_migration",
                return_value=self._swap_module("kept", "added"),
            ),
            patch.object(runner.os, "replace", recording_replace),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-reconcile"))

        self.assertTrue(result["committed"])
        # The index publishes the folder, so it must land after its contents.
        self.assertEqual(installed[-1], "index.json")
        self.assertEqual(json.loads((live_rc / "index.json").read_text())["marker"], "staged")
        self.assertEqual((live_rc / "datasets" / "kept.csv").read_text().strip(), "new")
        self.assertTrue((live_rc / "sidecars" / "added.json").is_file())
        # A dataset ResQ no longer exports must not survive as an orphan.
        self.assertFalse((live_rc / "sidecars" / "dropped-by-resq.json").exists())
        self.assertFalse((live_rc / "datasets" / "dropped-by-resq.csv").exists())
        self.assertFalse((server_root / "r" / "run-reconcile").exists())

    def test_a_transient_file_lock_does_not_discard_a_staged_import(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        self._write_index(live_rc, "live")
        contended = live_rc / "datasets" / "new-resq.csv"
        remaining_failures = [2]
        real_replace = runner.os.replace

        def flaky_replace(source, target):
            if remaining_failures[0] and Path(target) == contended:
                remaining_failures[0] -= 1
                raise PermissionError(13, "Access is denied", str(source), 5, str(target))
            return real_replace(source, target)

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
            patch.object(runner.time, "sleep"),
            patch.object(runner.os, "replace", flaky_replace),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-flaky-file"))

        self.assertEqual(remaining_failures[0], 0)
        self.assertTrue(result["committed"])
        self.assertTrue(result["previous_data_deleted"])
        self.assertTrue(contended.is_file())
        self.assertFalse((live_rc / "sidecars" / "old-resq.json").exists())

    def test_a_persistent_file_lock_rolls_the_live_rc_back_completely(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        self._write_dataset(live_rc, "dropped-by-resq", source_kind="input", value="old")
        self._write_index(live_rc, "live")
        before = self._folder_snapshot(live_rc)
        blocked = live_rc / "datasets" / "new-resq.csv"
        real_replace = runner.os.replace

        def blocked_replace(source, target):
            if Path(target) == blocked:
                raise PermissionError(13, "Access is denied", str(source), 5, str(target))
            return real_replace(source, target)

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
            patch.object(runner.time, "sleep") as sleep,
            patch.object(runner.os, "replace", blocked_replace),
            self.assertRaises(runner.ResQImportCommitError) as raised,
        ):
            runner.run_reserving_class_import(self._swap_request("run-blocked-file"))

        self.assertEqual(sleep.call_count, len(runner._COMMIT_RETRY_DELAYS))
        self.assertIn("still open in another program", str(raised.exception))
        self.assertIn("restored to its previous contents", str(raised.exception))
        # Every replaced and removed file must be back, byte for byte.
        self.assertEqual(self._folder_snapshot(live_rc), before)

    def test_a_non_transient_commit_failure_is_raised_without_waiting(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        self._write_index(live_rc, "live")
        before = self._folder_snapshot(live_rc)
        real_replace = runner.os.replace

        def broken_replace(source, target):
            if Path(target) == live_rc / "datasets" / "new-resq.csv":
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            return real_replace(source, target)

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
            patch.object(runner.time, "sleep") as sleep,
            patch.object(runner.os, "replace", broken_replace),
            self.assertRaises(runner.ResQImportCommitError) as raised,
        ):
            runner.run_reserving_class_import(self._swap_request("run-cross-device"))

        self.assertEqual(sleep.call_count, 0)
        self.assertNotIn("still open in another program", str(raised.exception))
        self.assertEqual(self._folder_snapshot(live_rc), before)

    def test_the_commit_never_moves_the_index_update_lock(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        self._write_index(live_rc, "live")
        lock_path = live_rc / ".index.json.lock"
        lock_path.write_text("", encoding="utf-8")

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-index-lock"))

        self.assertTrue(result["committed"])
        self.assertTrue(lock_path.is_file())

    def test_lock_failure_removes_its_new_job_folder(self):
        server_root = self.root / "server"
        staging_parent = server_root / "r"
        self._write_orphaned_lock(server_root)
        request = self._swap_request("run-locked")
        module = SimpleNamespace(_encode_rc_folder=lambda _rc_path: "rc")

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            self.assertRaises(runner.ResQImportCommitError),
        ):
            runner.run_reserving_class_import(request)

        self.assertFalse((staging_parent / "run-locked").exists())

    def test_an_expired_lock_from_a_killed_worker_no_longer_blocks_the_rc(self):
        # A terminated Bridge worker runs no ``finally``, so its lock file
        # survives. Before the lease, that blocked the reserving class forever.
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        lock_path = self._write_orphaned_lock(server_root)
        os.utime(
            lock_path,
            (0, time.time() - runner.RESQ_IMPORT_LOCK_STALE_SECONDS - 1),
        )

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=self._swap_module()),
        ):
            result = runner.run_reserving_class_import(self._swap_request("run-after-kill"))

        self.assertTrue(result["committed"])
        # The import owns and then releases the lease, leaving nothing behind.
        self.assertFalse(lock_path.exists())

    def test_a_live_import_still_holds_the_reserving_class(self):
        server_root = self.root / "server"
        lock_path = self._write_orphaned_lock(server_root)
        request = self._swap_request("run-contended")
        module = SimpleNamespace(_encode_rc_folder=lambda _rc_path: "rc")

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            self.assertRaises(runner.ResQImportCommitError) as raised,
        ):
            runner.run_reserving_class_import(request)

        self.assertIn("already processing this reserving class", str(raised.exception))
        self.assertIn(
            str(int(runner.RESQ_IMPORT_LOCK_STALE_SECONDS)),
            str(raised.exception),
        )
        self.assertEqual(lock_path.read_text(encoding="utf-8"), '{"request_id":"other"}\n')

    def test_a_running_import_renews_its_lease_while_it_works(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")
        observed = []

        def importer(_project_name, _rc_path, **kwargs):
            lock_dir = server_root / "r" / ".locks"
            observed.extend(sorted(path.name for path in lock_dir.glob("*.lock")))
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "new-resq", source_kind="input", value="new")
            return {"errors": 0, "engine_errors": 0, "engine_available": True}

        module = self._swap_module()
        module.import_reserving_class_from_resq = importer

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
        ):
            runner.run_reserving_class_import(self._swap_request("run-heartbeat"))

        self.assertEqual(observed, [runner._lock_file_name("Demo", r"Business\Auto")])
        self.assertEqual(list((server_root / "r" / ".locks").glob("*.lock")), [])

    def test_a_failure_before_the_commit_removes_the_staged_job_folder(self):
        server_root = self.root / "server"
        live_rc = server_root / "projects" / "Demo" / "data" / "rc"
        self._write_dataset(live_rc, "old-resq", source_kind="input", value="old")

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            self._write_dataset(stage_rc, "partial", source_kind="input", value="partial")
            return {"errors": 0, "engine_errors": 0, "engine_available": True}

        # The module lacks the merge/graph/index helpers, so the run fails
        # after staging but before anything live is moved aside.
        module = SimpleNamespace(
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
        )

        with (
            patch.object(runner, "get_project_root", return_value=server_root),
            patch.object(runner, "load_resq_data_migration", return_value=module),
            self.assertRaises(runner.ResQMigrationBundleError),
        ):
            runner.run_reserving_class_import(self._swap_request("run-import-error"))

        # Nothing was moved aside yet, so the staged copy is pure garbage.
        self.assertFalse((server_root / "r" / "run-import-error").exists())
        self.assertTrue((live_rc / "sidecars" / "old-resq.json").is_file())

    def test_discarding_an_abandoned_job_never_deletes_a_commit_backup(self):
        server_root = self.root / "server"
        staging_parent = server_root / "r"
        staged = staging_parent / "abandoned" / "d" / "rc"
        staged.mkdir(parents=True)
        (staged / "index.json").write_text("{}", encoding="utf-8")
        backed_up = staging_parent / "half-committed" / "previous" / "sidecars"
        backed_up.mkdir(parents=True)
        (backed_up / "old-resq.json").write_text("{}", encoding="utf-8")

        self.assertTrue(runner.discard_abandoned_import_job("abandoned", server_root))
        self.assertFalse(runner.discard_abandoned_import_job("half-committed", server_root))
        self.assertFalse(runner.discard_abandoned_import_job("never-existed", server_root))

        self.assertFalse((staging_parent / "abandoned").exists())
        self.assertTrue((backed_up / "old-resq.json").is_file())

    def test_request_values_cannot_select_a_target_path(self):
        request = {
            "RequestId": "run-789",
            "ProjectName": "..",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
        }
        with self.assertRaises(runner.ResQImportRequestError):
            runner.run_reserving_class_import(request)

    def _write_orphaned_lock(self, server_root: Path) -> Path:
        """Write the lock a killed or still-running worker would leave behind."""

        lock_dir = server_root / "r" / ".locks"
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock_path = lock_dir / runner._lock_file_name("Demo", r"Business\Auto")
        lock_path.write_text('{"request_id":"other"}\n', encoding="utf-8")
        return lock_path

    def _swap_module(self, *staged_names: str) -> SimpleNamespace:
        names = staged_names or ("new-resq",)

        def importer(_project_name, _rc_path, **kwargs):
            stage_rc = Path(kwargs["project_data_dir"]) / "rc"
            for name in names:
                self._write_dataset(stage_rc, name, source_kind="input", value="new")
            return {"errors": 0, "engine_errors": 0, "engine_available": True}

        return SimpleNamespace(
            INDEX_FILE_NAME="index.json",
            _encode_rc_folder=lambda _rc_path: "rc",
            import_reserving_class_from_resq=importer,
            _apply_runtime_scope=lambda *args: ("previous", args),
            _restore_runtime_scope=lambda _previous: None,
            merge_preserved_arcrho_artifacts=lambda _live, _stage, **_kwargs: {
                "groups": 0,
                "files": 0,
                "names": [],
            },
            refresh_sidecar_graphs_for_rc=lambda _path: 0,
            rebuild_dataset_instance_index=lambda _project, _rc, path: self._write_index(Path(path)),
        )

    def _folder_snapshot(self, rc_dir: Path) -> dict:
        return {
            str(path.relative_to(rc_dir)): path.read_bytes()
            for path in sorted(rc_dir.rglob("*"))
            if path.is_file()
        }

    def _write_index(self, rc_dir: Path, marker: str = "staged"):
        rc_dir.mkdir(parents=True, exist_ok=True)
        (rc_dir / "index.json").write_text(
            json.dumps({"schema_version": 1, "marker": marker}),
            encoding="utf-8",
        )

    def _swap_request(self, request_id: str) -> dict:
        return {
            "RequestId": request_id,
            "ProjectName": "Demo",
            "Path": r"Business\Auto",
            "ExportMode": "configured",
            "UserName": "tester",
        }

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
