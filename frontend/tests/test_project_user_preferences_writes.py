from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import project_user_preferences_service


class ProjectUserPreferencesWriteTests(unittest.TestCase):
    def test_temp_paths_are_unique_for_overlapping_writes(self) -> None:
        path = str(FRONTEND_ROOT / "preferences.json")
        with patch.object(
            project_user_preferences_service.time,
            "monotonic_ns",
            side_effect=(101, 102),
        ):
            first = project_user_preferences_service._unique_preferences_temp_path(path)
            second = project_user_preferences_service._unique_preferences_temp_path(path)

        self.assertNotEqual(first, second)
        self.assertTrue(first.endswith(".tmp"))
        self.assertTrue(second.endswith(".tmp"))

    def test_same_path_updates_are_serialized_and_preserve_both_patches(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "preferences.json"
            first_write_entered = threading.Event()
            release_first_write = threading.Event()
            second_write_entered = threading.Event()
            call_guard = threading.Lock()
            errors: list[BaseException] = []
            call_count = 0
            original_write = project_user_preferences_service._write_preferences_file

            def blocking_write(target: str, data: dict[str, object]) -> None:
                nonlocal call_count
                with call_guard:
                    call_count += 1
                    current_call = call_count
                if current_call == 1:
                    first_write_entered.set()
                    if not release_first_write.wait(timeout=2):
                        raise TimeoutError("Timed out waiting to release the first preference write.")
                else:
                    second_write_entered.set()
                original_write(target, data)

            def run_update(preference_patch: dict[str, object]) -> None:
                try:
                    project_user_preferences_service.update_preferences("Example", preference_patch)
                except BaseException as error:  # pragma: no cover - reported by the assertions below
                    errors.append(error)

            with (
                patch.object(project_user_preferences_service, "_prefs_path", return_value=str(path)),
                patch.object(
                    project_user_preferences_service,
                    "_write_preferences_file",
                    side_effect=blocking_write,
                ),
            ):
                first_thread = threading.Thread(target=run_update, args=({"first": 1},))
                second_thread = threading.Thread(target=run_update, args=({"second": 2},))
                first_thread.start()
                self.assertTrue(first_write_entered.wait(timeout=1))
                second_thread.start()
                overlapped = second_write_entered.wait(timeout=0.1)
                release_first_write.set()
                first_thread.join(timeout=2)
                second_thread.join(timeout=2)

            self.assertFalse(first_thread.is_alive())
            self.assertFalse(second_thread.is_alive())
            self.assertFalse(overlapped)
            self.assertEqual(errors, [])
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["first"], 1)
            self.assertEqual(saved["second"], 2)

    def test_replace_retries_transient_permission_errors(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "preferences.json"
            real_replace = os.replace
            replace_calls = 0

            def flaky_replace(source: str, target: str) -> None:
                nonlocal replace_calls
                replace_calls += 1
                if replace_calls <= 2:
                    raise PermissionError("temporarily locked")
                real_replace(source, target)

            with (
                patch.object(project_user_preferences_service.os, "replace", side_effect=flaky_replace),
                patch.object(project_user_preferences_service.time, "sleep") as sleep,
            ):
                project_user_preferences_service._write_preferences_file(str(path), {"saved": True})

            self.assertEqual(replace_calls, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"saved": True})

    def test_persistent_permission_error_returns_locked_status_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "preferences.json"
            with (
                patch.object(project_user_preferences_service, "_prefs_path", return_value=str(path)),
                patch.object(
                    project_user_preferences_service.os,
                    "replace",
                    side_effect=PermissionError("share denied replacement"),
                ) as replace,
                patch.object(project_user_preferences_service.time, "sleep") as sleep,
            ):
                with self.assertRaises(HTTPException) as raised:
                    project_user_preferences_service.update_preferences("Example", {"saved": True})

            self.assertEqual(raised.exception.status_code, 423)
            self.assertIn("locked or inaccessible", str(raised.exception.detail))
            self.assertEqual(
                replace.call_count,
                len(project_user_preferences_service._PREFERENCES_REPLACE_RETRY_DELAYS) + 1,
            )
            self.assertEqual(
                sleep.call_count,
                len(project_user_preferences_service._PREFERENCES_REPLACE_RETRY_DELAYS),
            )
            self.assertEqual(list(Path(temp_dir).glob("*.tmp")), [])

    def test_invalid_existing_json_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "preferences.json"
            original = "{ invalid"
            path.write_text(original, encoding="utf-8")

            with patch.object(project_user_preferences_service, "_prefs_path", return_value=str(path)):
                with self.assertRaises(HTTPException) as raised:
                    project_user_preferences_service.update_preferences("Example", {"saved": True})

            self.assertEqual(raised.exception.status_code, 409)
            self.assertIn("invalid JSON", str(raised.exception.detail))
            self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_inaccessible_existing_preferences_are_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "preferences.json"
            with (
                patch.object(project_user_preferences_service, "_prefs_path", return_value=str(path)),
                patch("builtins.open", side_effect=PermissionError("read denied")),
                patch.object(project_user_preferences_service, "_write_preferences_file") as write_preferences,
            ):
                with self.assertRaises(HTTPException) as raised:
                    project_user_preferences_service.update_preferences("Example", {"saved": True})

            self.assertEqual(raised.exception.status_code, 423)
            self.assertIn("locked or inaccessible", str(raised.exception.detail))
            write_preferences.assert_not_called()


if __name__ == "__main__":
    unittest.main()
