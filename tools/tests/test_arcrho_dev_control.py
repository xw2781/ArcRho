from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.arcrho_dev_control import runtime


class ArcRhoDevControlRuntimeTests(unittest.TestCase):
    def test_process_selection_includes_descendants(self) -> None:
        frontend = str(runtime.FRONTEND_ROOT)
        processes = [
            runtime.ProcessInfo(100, 1, "pythonw.exe", f'pythonw.exe "{frontend}\\electron_shell.py"'),
            runtime.ProcessInfo(101, 100, "cmd.exe", "cmd.exe /c npm run electron"),
            runtime.ProcessInfo(102, 101, "electron.exe", "electron.exe ."),
            runtime.ProcessInfo(200, 1, "python.exe", "python unrelated.py"),
        ]
        with (
            patch.object(runtime, "_query_windows_processes", return_value=processes),
            patch.object(runtime, "_read_runtime_anchor_pids", return_value=set()),
        ):
            selected = runtime.list_arcrho_dev_processes()
        self.assertEqual({item.pid for item in selected}, {100, 101, 102})

    def test_process_anchor_adds_safe_ancestors_and_descendants(self) -> None:
        processes = [
            runtime.ProcessInfo(90, 1, "pythonw.exe", "C:\\Python310\\pythonw.exe"),
            runtime.ProcessInfo(100, 90, "cmd.exe", "C:\\Windows\\cmd.exe"),
            runtime.ProcessInfo(101, 100, "electron.exe", "electron.exe"),
            runtime.ProcessInfo(102, 101, "python.exe", "C:\\Python310\\python.exe"),
            runtime.ProcessInfo(200, 1, "explorer.exe", "C:\\Windows\\explorer.exe"),
        ]
        with (
            patch.object(runtime, "_query_windows_processes", return_value=processes),
            patch.object(runtime, "_read_runtime_anchor_pids", return_value={101}),
        ):
            selected = runtime.list_arcrho_dev_processes()
        self.assertEqual({item.pid for item in selected}, {90, 100, 101, 102})

    def test_cache_paths_are_children_of_appdata_root(self) -> None:
        with tempfile.TemporaryDirectory(dir=runtime.REPO_ROOT) as temp_dir:
            appdata = Path(temp_dir)
            with patch.dict(os.environ, {"APPDATA": str(appdata)}, clear=False):
                root = runtime._electron_user_data_root().resolve()
                paths = runtime._electron_cache_paths()
        self.assertGreater(len(paths), 5)
        self.assertTrue(all(path.resolve().parent == root for path in paths))
        self.assertNotIn(root / "prefs", paths)
        self.assertNotIn(root / "logs", paths)

    def test_preference_discovery_uses_configured_project_root(self) -> None:
        with tempfile.TemporaryDirectory(dir=runtime.REPO_ROOT) as temp_dir:
            projects = Path(temp_dir) / "projects"
            preference = projects / "Sample" / "users" / "alice" / "preferences.json"
            preference.parent.mkdir(parents=True)
            preference.write_text("{}", encoding="utf-8")
            config = SimpleNamespace(
                PROJECT_SETTINGS_DIR=str(projects),
                PROJECT_USER_PREFERENCES_FILE="preferences.json",
            )
            with patch.object(runtime, "_load_frontend_config", return_value=config):
                discovered = runtime.list_project_user_preferences()
        self.assertEqual(len(discovered), 1)
        self.assertEqual(discovered[0]["project"], "Sample")
        self.assertEqual(discovered[0]["user"], "alice")

    def test_clear_preference_moves_file_to_backup_before_relaunch(self) -> None:
        with tempfile.TemporaryDirectory(dir=runtime.REPO_ROOT) as temp_dir:
            preference = Path(temp_dir) / "preferences.json"
            preference.write_text('{"saved": true}', encoding="utf-8")
            selected = {"id": "pref-id", "project": "Sample", "user": "alice", "path": str(preference)}

            def discover() -> list[dict[str, str]]:
                runtime._PREFERENCE_PATHS.clear()
                runtime._PREFERENCE_PATHS["pref-id"] = preference
                return [selected]

            with (
                patch.object(runtime, "list_project_user_preferences", side_effect=discover),
                patch.object(runtime, "stop_arcrho_dev_processes", return_value={"stopped": 3}),
                patch.object(runtime, "launch_arcrho_dev", return_value={"launched": True}),
            ):
                result = runtime.clear_project_user_preference_and_relaunch("pref-id")

            self.assertFalse(preference.exists())
            backup = Path(result["backup_path"])
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.read_text(encoding="utf-8"), '{"saved": true}')


if __name__ == "__main__":
    unittest.main()
