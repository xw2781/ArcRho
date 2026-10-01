from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SRC = FRONTEND_ROOT.parent / "python-api" / "src"
for root in (FRONTEND_ROOT, API_SRC):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

TEST_TEMP_ROOT = FRONTEND_ROOT.parent / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

from app_server.app_control_flags import restart_flag, shutdown_flag

# The api package re-exports each router object under its module's name.
app_control_router = importlib.import_module("app_server.api.app_control_router")


class AppControlFlagTests(unittest.TestCase):
    """Two development apps run from one checkout each obey only their own server's markers."""

    def test_markers_are_named_per_port(self) -> None:
        base = Path("frontend")
        self.assertNotEqual(restart_flag(base, 28765), restart_flag(base, 51234))
        self.assertNotEqual(shutdown_flag(base, 28765), shutdown_flag(base, 51234))
        self.assertNotEqual(restart_flag(base, 28765), shutdown_flag(base, 28765))

    def test_the_server_writes_the_marker_for_its_own_port(self) -> None:
        request = SimpleNamespace(scope={"server": ("127.0.0.1", 51234)})
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as temp, \
                mock.patch.object(app_control_router.config, "BASE_DIR", Path(temp)), \
                mock.patch.object(app_control_router.threading, "Thread"):
            app_control_router.app_shutdown(request)
            app_control_router.app_restart(request)
            written = sorted(path.name for path in Path(temp).iterdir())
        self.assertEqual(written, sorted([restart_flag(Path(temp), 51234).name, shutdown_flag(Path(temp), 51234).name]))

    def test_the_supervisor_and_the_host_use_the_same_names(self) -> None:
        supervisor = (FRONTEND_ROOT / "app_shell.py").read_text(encoding="utf-8")
        self.assertIn("RESTART_FLAG = restart_flag(BASE_DIR, port)", supervisor)
        self.assertIn("SHUTDOWN_FLAG = shutdown_flag(BASE_DIR, port)", supervisor)
        # The host cannot import Python, so its copy of the names is pinned here.
        host = (FRONTEND_ROOT / "electron" / "backend_lifecycle.js").read_text(encoding="utf-8")
        for name in (restart_flag(Path("."), "${port}").name, shutdown_flag(Path("."), "${port}").name):
            self.assertIn(f"`{name}`", host)


if __name__ == "__main__":
    unittest.main()
