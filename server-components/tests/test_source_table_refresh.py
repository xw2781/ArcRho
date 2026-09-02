from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_COMPONENTS_SRC = REPO_ROOT / "server-components" / "src"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
TESTS_DIR = Path(__file__).resolve().parent
for path in (SERVER_COMPONENTS_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.dataset_index_contract import canonicalize_index_row
from arcrho_source_refresh_contract import (
    SOURCE_REFRESH_FUNCTION,
    acquire_source_refresh_lease,
    build_source_refresh_request,
    read_source_refresh_status,
    release_source_refresh_lease,
    source_refresh_request_path,
    write_source_refresh_status,
)
from arcrho_engine import source_table_refresh
from arcrho_engine import main as engine_main


def _identity_stub(bound: list):
    """Stand in for the canonical acting-identity binding."""

    @contextmanager
    def acting_identity(login_name, display_name=""):
        bound.append(str(login_name or "").strip())
        try:
            yield {"login_name": login_name, "display_name": display_name}
        finally:
            bound.pop()

    return SimpleNamespace(acting_identity=acting_identity)


def _install_fake_app_server(modules: dict):
    """Register a minimal ``app_server`` package for the lazy service imports."""

    services = types.ModuleType("app_server.services")
    for name, module in modules.items():
        setattr(services, name, module)
    app_server = types.ModuleType("app_server")
    app_server.services = services
    return patch.dict(
        sys.modules,
        {"app_server": app_server, "app_server.services": services},
    )


class ReservingClassEnumerationTests(unittest.TestCase):
    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.data_dir = Path(self.temp.name) / "data"
        self.data_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _patched_config(self):
        config = types.ModuleType("app_server.config")
        config.get_project_data_dir = lambda name: str(self.data_dir)
        config.decode_filename_segment = lambda name: str(name).replace("_%5C_", "\\")
        app_server = types.ModuleType("app_server")
        app_server.config = config
        return patch.dict(
            sys.modules, {"app_server": app_server, "app_server.config": config}
        )

    def test_the_index_owns_the_class_name_and_the_folder_is_the_fallback(self) -> None:
        indexed = self.data_dir / "HPPREF_%5C_HO+DF"
        indexed.mkdir()
        (indexed / "index.json").write_text(
            json.dumps({"reserving_class": "HPPREF\\HO+DF", "files": []}),
            encoding="utf-8",
        )
        unindexed = self.data_dir / "Auto_%5C_NJ"
        unindexed.mkdir()

        with self._patched_config():
            classes = source_table_refresh._reserving_class_paths("Demo Project")

        self.assertEqual(sorted(classes), ["Auto\\NJ", "HPPREF\\HO+DF"])

    def test_a_project_with_no_data_folder_has_no_classes(self) -> None:
        missing = types.ModuleType("app_server.config")
        missing.get_project_data_dir = lambda name: str(self.data_dir / "absent")
        missing.decode_filename_segment = lambda name: name
        app_server = types.ModuleType("app_server")
        app_server.config = missing
        with patch.dict(
            sys.modules, {"app_server": app_server, "app_server.config": missing}
        ):
            self.assertEqual(source_table_refresh._reserving_class_paths("Demo"), [])


class EngineDatasetEnumerationTests(unittest.TestCase):
    """The job must read names from index rows as the index contract writes them.

    The rows are built through ``canonicalize_index_row`` on purpose: a
    hand-typed fixture once carried the sidecar-only ``dataset_name`` field,
    which the contract's projection drops, and the enumeration silently found
    zero datasets on every real project.
    """

    def _enumerate(self, rows):
        index_service = SimpleNamespace(
            get_index=lambda project, reserving_class: {"files": rows}
        )
        with _install_fake_app_server(
            {"dataset_instance_index_service": index_service}
        ):
            return source_table_refresh._engine_dataset_instances(
                "Demo Project", "HPPREF\\NJ"
            )

    def test_engine_rows_are_found_in_a_contract_shaped_index(self) -> None:
        rows = [
            # A sidecar-flavored source names its dataset "dataset_name"; the
            # canonical projection persists it as "name" only.
            canonicalize_index_row(
                {"dataset_name": "ALAE Paid", "source_kind": "engine"}
            ),
            canonicalize_index_row({"name": "Paid", "source_kind": "engine"}),
            canonicalize_index_row({"name": "Cutoff", "source_kind": "input"}),
            canonicalize_index_row({"name": "Ultimate", "source_kind": "dfm"}),
        ]
        self.assertNotIn("dataset_name", rows[0])
        self.assertEqual(self._enumerate(rows), ["ALAE Paid", "Paid"])

    def test_duplicate_names_and_malformed_rows_are_skipped(self) -> None:
        rows = [
            canonicalize_index_row({"name": "Paid", "source_kind": "engine"}),
            canonicalize_index_row({"name": "PAID", "source_kind": "engine"}),
            "not a row",
            {"source_kind": "engine"},
        ]
        self.assertEqual(self._enumerate(rows), ["Paid"])


class RegenerationRequestTests(unittest.TestCase):
    def _with_helpers(self):
        helpers = types.ModuleType("app_server.helpers")
        helpers.set_data_path_like_vba = lambda pairs: "E:\\cache.csv"
        app_server = types.ModuleType("app_server")
        app_server.helpers = helpers
        return patch.dict(
            sys.modules, {"app_server": app_server, "app_server.helpers": helpers}
        )

    def test_triangle_pairs_carry_the_sidecar_shape(self) -> None:
        with self._with_helpers():
            pairs, data_path = source_table_refresh._regeneration_request(
                {
                    "project_name": "Demo Project",
                    "reserving_class": "HPPREF\\NJ",
                    "dataset_name": "Paid 2026Q1",
                    "dataset_type": "Paid",
                    "data_format": "Triangle",
                    "origin_length": 12,
                    "development_length": 6,
                    "cumulative": False,
                    "calendar": True,
                },
                "Demo Project",
            )
        values = dict(pairs)
        self.assertEqual(values["Function"], "ArcRhoTri")
        self.assertEqual(values["DatasetName"], "Paid")
        self.assertEqual(values["InstanceName"], "Paid 2026Q1")
        self.assertEqual(values["OriginLength"], "12")
        self.assertEqual(values["DevelopmentLength"], "6")
        self.assertEqual(values["Cumulative"], "False")
        self.assertEqual(values["Calendar"], "True")
        self.assertEqual(data_path, "E:\\cache.csv")

    def test_a_vector_asks_for_the_vector_function_and_names_its_instance(self) -> None:
        with self._with_helpers():
            pairs, _ = source_table_refresh._regeneration_request(
                {
                    "project_name": "Demo Project",
                    "reserving_class": "HPPREF\\NJ",
                    "dataset_name": "Premium",
                    "dataset_type": "Premium",
                    "data_format": "Vector",
                    "period_length": 12,
                    "origin_length": 12,
                },
                "Demo Project",
            )
        values = dict(pairs)
        self.assertEqual(values["Function"], "ArcRhoVec")
        # The vector's shape travels in both length pairs, as the dataset route
        # does for a PeriodLength request.
        self.assertEqual(values["InstanceName"], "Premium")
        self.assertEqual(values["OriginLength"], "12")
        self.assertEqual(values["DevelopmentLength"], "12")

    def test_the_project_refreshed_wins_over_the_name_in_the_sidecar(self) -> None:
        # A duplicated project's sidecars still name the project they were
        # copied from. Following that name would rebuild every dataset into the
        # source project and leave this one with no values at all.
        with self._with_helpers():
            pairs, _ = source_table_refresh._regeneration_request(
                {
                    "project_name": "Prod 2026 Q2-May",
                    "reserving_class": "HPPREF\\NJ",
                    "dataset_name": "Paid",
                    "dataset_type": "Paid",
                    "data_format": "Triangle",
                    "origin_length": 12,
                    "development_length": 12,
                },
                "Prod 2026 Q3-Aug",
            )
        self.assertEqual(dict(pairs)["ProjectName"], "Prod 2026 Q3-Aug")


class RegenerationSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)
        self.cache = self.root / "Paid.csv"
        self.cache.write_text("1,2\n3,4\n", encoding="utf-8")
        self.calls: list = []

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run(self, outcome):
        sidecar = {
            "exists": True,
            "project_name": "Demo Project",
            "reserving_class": "HPPREF\\NJ",
            "dataset_name": "Paid",
            "dataset_type": "Paid",
            "data_format": "Triangle",
            "origin_length": 12,
            "development_length": 12,
            "cumulative": True,
            "calendar": False,
        }
        def run_arcrho_tri(*args, **kwargs):
            self.calls.append(kwargs)
            return self._clear_and_return(outcome)

        runtime = SimpleNamespace(run_arcrho_tri=run_arcrho_tri)
        dataset_service = SimpleNamespace(load_dataset_sidecar=lambda *a: sidecar)
        with _install_fake_app_server(
            {"arcrho_runtime_service": runtime, "dataset_service": dataset_service}
        ), patch.object(
            source_table_refresh,
            "_regeneration_request",
            return_value=([("Function", "ArcRhoTri")], str(self.cache)),
        ):
            return source_table_refresh._regenerate_engine_dataset(
                self.root, "Demo Project", "HPPREF\\NJ", "Paid"
            )

    def _clear_and_return(self, outcome):
        # The canonical runtime removes the cache before it asks the Engine for
        # a new one; a failed run must not leave the dataset without values.
        self.cache.unlink()
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def test_a_failed_regeneration_restores_the_previous_cache(self) -> None:
        with self.assertRaises(source_table_refresh.SourceRefreshJobError):
            self._run({"ok": False, "message": "engine timed out"})
        self.assertTrue(self.cache.is_file())
        self.assertEqual(self.cache.read_text(encoding="utf-8"), "1,2\n3,4\n")
        self.assertFalse(Path(f"{self.cache}.refresh-backup").exists())

    def test_a_raised_regeneration_restores_the_previous_cache(self) -> None:
        with self.assertRaises(RuntimeError):
            self._run(RuntimeError("engine crashed"))
        self.assertTrue(self.cache.is_file())

    def test_a_successful_regeneration_keeps_the_new_cache_and_no_backup(self) -> None:
        self.assertTrue(self._run({"ok": True, "need_request": True}))
        # One index rebuild covers the whole class, at the end of its walk;
        # rebuilding after each dataset re-reads every sidecar in the folder.
        self.assertEqual(self.calls[0]["refresh_index"], False)
        self.assertEqual(self.calls[0]["recalculate_dependents_on_cache_write"], False)
        self.assertEqual(self.calls[0]["force_refresh"], True)
        # The stub deleted the cache to imitate the real refresh; success must
        # not put the stale copy back over the Engine's output.
        self.assertFalse(self.cache.exists())
        self.assertFalse(Path(f"{self.cache}.refresh-backup").exists())


class DurableSourceRefreshTests(unittest.TestCase):
    REQUEST_ID = "0123456789abcdef0123456789abcdef"

    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)
        self.request = build_source_refresh_request(
            request_id=self.REQUEST_ID,
            project_name="Demo Project",
            user_name="Test User",
        )
        self.request_path = source_refresh_request_path(self.root, self.REQUEST_ID)
        self.request_path.parent.mkdir(parents=True, exist_ok=True)
        self.request_path.write_text(json.dumps(self.request), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _process(self, execute):
        with patch.object(source_table_refresh, "execute_source_refresh", execute):
            return source_table_refresh.process_durable_source_refresh_request(
                self.root, self.request_path, self.request
            )

    def test_a_completed_job_publishes_success_and_drops_its_queue_file(self) -> None:
        result = source_table_refresh._empty_result()
        result.update({"imported": True, "row_count": 42, "source_type": "csv"})
        seen = []

        def execute(root, request, *, progress_callback=None):
            seen.append(request["RequestId"])
            progress_callback(
                source_table_refresh._progress("caches", 1, 3, "Rebuilding caches")
            )
            return result

        self.assertTrue(self._process(execute))
        self.assertEqual(seen, [self.REQUEST_ID])
        status = read_source_refresh_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")
        self.assertEqual(status["result"]["row_count"], 42)
        self.assertFalse(self.request_path.exists())

    def test_reported_failures_make_the_job_terminal_error_with_its_counts(self) -> None:
        result = source_table_refresh._empty_result()
        result.update(
            {
                "imported": True,
                "classes_total": 2,
                "classes_refreshed": 1,
                "datasets_failed": 1,
                "failures": ["HPPREF\\NJ: Paid: the ArcRho Engine did not return values."],
            }
        )

        self.assertFalse(self._process(lambda *a, **k: result))
        status = read_source_refresh_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertIn("1 dataset(s) failed", status["message"])
        self.assertEqual(status["result"]["classes_refreshed"], 1)

    def test_a_raised_job_publishes_a_redacted_error(self) -> None:
        def explode(*args, **kwargs):
            raise OSError(r"E:\ArcRho Server\projects\Demo\source\master_table.csv")

        self.assertFalse(self._process(explode))
        status = read_source_refresh_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        # The client is told the filesystem failed, never where on the server.
        self.assertNotIn("master_table.csv", status["message"])
        self.assertNotIn("projects", status["message"])

    def test_a_held_project_is_not_claimed_and_leaves_the_request_queued(self) -> None:
        lease = acquire_source_refresh_lease(self.root, "Demo Project")
        self.addCleanup(release_source_refresh_lease, lease)
        called = []
        self.assertFalse(self._process(lambda *a, **k: called.append(1)))
        self.assertEqual(called, [])
        self.assertTrue(self.request_path.exists())

    def test_an_already_terminal_request_is_dropped_without_rerunning(self) -> None:
        write_source_refresh_status(
            self.root,
            self.REQUEST_ID,
            "success",
            progress={"stage": "complete", "completed": 1, "total": 1, "label": "Done"},
        )
        called = []
        self.assertTrue(self._process(lambda *a, **k: called.append(1)))
        self.assertEqual(called, [])
        self.assertFalse(self.request_path.exists())

    def test_a_rejected_payload_publishes_an_error_and_drops_the_file(self) -> None:
        broken = {**self.request, "Force": "yes"}
        with patch.object(source_table_refresh, "execute_source_refresh") as execute:
            handled = source_table_refresh.process_durable_source_refresh_request(
                self.root, self.request_path, broken
            )
        self.assertFalse(handled)
        execute.assert_not_called()
        status = read_source_refresh_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertFalse(self.request_path.exists())


class EngineDispatchTests(unittest.TestCase):
    def test_the_engine_routes_the_function_to_the_source_refresh_worker(self) -> None:
        handler = engine_main.RequestHandler()
        self.addCleanup(handler.shutdown, wait=False)
        request = {
            "Function": SOURCE_REFRESH_FUNCTION,
            "RequestId": "0123456789abcdef0123456789abcdef",
        }
        with patch.object(handler, "_schedule_source_refresh") as scheduled:
            handler.process_file = types.MethodType(
                engine_main.RequestHandler.process_file, handler
            )
            with patch.object(engine_main, "read_json", return_value=request):
                handler.process_file("queued.json", dispatch_duplication=True)
        scheduled.assert_called_once()


if __name__ == "__main__":
    unittest.main()
