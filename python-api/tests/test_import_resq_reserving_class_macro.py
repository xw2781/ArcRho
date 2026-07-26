from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


_MACRO_PATH = (
    Path(__file__).resolve().parents[1]
    / "macros"
    / "import_resq_reserving_class.py"
)


def load_macro_module():
    spec = importlib.util.spec_from_file_location(
        "import_resq_reserving_class_macro_under_test",
        _MACRO_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the reserving-class migration macro.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Progress:
    def __init__(self):
        self.total = 0
        self.completed = 0
        self.updates = []

    def update(self, **kwargs):
        self.updates.append(kwargs)
        self.total = int(kwargs.get("total", self.total) or 0)
        self.completed = int(kwargs.get("completed", self.completed) or 0)

    def close(self, **_kwargs):
        return None


class _UI:
    def __init__(self):
        self.messages = []
        self.progress_calls = []
        self.project_instance = types.SimpleNamespace(
            context=lambda **_kwargs: {
                "projectName": "Demo",
                "selectedPath": r"Auto\PP",
            },
            reload_dataset_table=lambda **_kwargs: {"refreshed": True},
        )

    def message_box(self, message, **kwargs):
        self.messages.append((message, kwargs))
        return {"ok": True}

    def progress_bar(self, **kwargs):
        self.progress_calls.append(kwargs)
        return _Progress()


class ImportResqReservingClassMacroTests(unittest.TestCase):
    def setUp(self):
        self.module = load_macro_module()
        self.ui = _UI()
        self.api_module = types.ModuleType("arcrho_api")
        self.api_module.ArcRhoUI = lambda: self.ui
        self.api_module.get_server_root = lambda **_kwargs: Path(r"E:\ArcRho Server")

    def test_no_worker_stops_before_progress_or_resq_import_and_alerts(self):
        class NoWorkerError(RuntimeError):
            pass

        migration = types.SimpleNamespace(
            EngineUnavailableError=NoWorkerError,
            require_running_engine_instances=Mock(
                side_effect=NoWorkerError("No active engine heartbeat.")
            ),
            import_reserving_class_from_resq=Mock(),
            __file__="migration.py",
        )

        with (
            patch.dict(sys.modules, {"arcrho_api": self.api_module}),
            patch.object(
                self.module,
                "_load_resq_migration_module",
                return_value=migration,
            ),
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(self.ui.progress_calls, [])
        migration.import_reserving_class_from_resq.assert_not_called()
        self.assertEqual(len(self.ui.messages), 1)
        message, options = self.ui.messages[0]
        self.assertIn("stopped before connecting to ResQ", message)
        self.assertEqual(options["title"], "ArcRho Data Engine Unavailable")
        self.assertEqual(options["kind"], "error")

    def test_worker_backed_import_uses_trusted_untraced_call(self):
        migration = types.SimpleNamespace(
            EngineUnavailableError=RuntimeError,
            require_running_engine_instances=Mock(
                return_value=tuple(Path(f"worker-{index}.json") for index in range(5))
            ),
            import_reserving_class_from_resq=Mock(return_value={
                "datasets_imported": 2,
                "grand_total": 2,
                "errors": 0,
                "skipped": 0,
            }),
            __file__="migration.py",
        )
        trusted_calls = []

        def run_trusted(func, *args, **kwargs):
            trusted_calls.append((func, args, kwargs))
            return func(*args, **kwargs)

        self.module.run_trusted_macro_call = run_trusted
        self.module.check_macro_cancelled = lambda: None
        self.module.report_macro_activity = lambda: None

        with (
            patch.dict(sys.modules, {"arcrho_api": self.api_module}),
            patch.object(
                self.module,
                "_load_resq_migration_module",
                return_value=migration,
            ),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        self.assertEqual(len(trusted_calls), 1)
        self.assertEqual(result["result"]["engine_workers_detected"], 5)
        migration.import_reserving_class_from_resq.assert_called_once()
        self.assertEqual(self.ui.progress_calls[0]["label"], "Preparing import with 5 data-engine worker(s)")


if __name__ == "__main__":
    unittest.main()
