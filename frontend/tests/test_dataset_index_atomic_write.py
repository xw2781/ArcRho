from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
if str(PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(PYTHON_API_SRC))

from arcrho_api import dataset_index_contract


_TEST_TEMP_ROOT = REPOSITORY_ROOT / "frontend" / "tests" / "logs" / "tmp"


class DatasetIndexAtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        _TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(_TEST_TEMP_ROOT))
        self.addCleanup(self.temp_dir.cleanup)
        self.rc_dir = Path(self.temp_dir.name) / "Auto_%5C_PP"
        self.rc_dir.mkdir()
        self.index_path = self.rc_dir / dataset_index_contract.INDEX_FILE_NAME
        self.payload = dataset_index_contract.build_dataset_index_payload(
            "Demo",
            r"Auto\PP",
            self.rc_dir,
        )

    def test_unchanged_payload_skips_replace(self) -> None:
        self.assertTrue(
            dataset_index_contract.write_index_json(
                self.index_path,
                self.payload,
            )
        )
        original_text = self.index_path.read_text(encoding="utf-8")

        with mock.patch.object(
            dataset_index_contract.os,
            "replace",
            side_effect=AssertionError("unchanged index must not be replaced"),
        ):
            changed = dataset_index_contract.write_index_json(
                self.index_path,
                self.payload,
            )

        self.assertFalse(changed)
        self.assertEqual(self.index_path.read_text(encoding="utf-8"), original_text)

    def test_replace_failure_preserves_destination_and_cleans_unique_temp(self) -> None:
        self.index_path.write_text('{"old": true}\n', encoding="utf-8")
        before = self.index_path.read_bytes()

        with mock.patch.object(
            dataset_index_contract.os,
            "replace",
            side_effect=OSError(5, "replace failed"),
        ):
            with self.assertRaises(OSError):
                dataset_index_contract.write_index_json(
                    self.index_path,
                    self.payload,
                )

        self.assertEqual(self.index_path.read_bytes(), before)
        self.assertEqual(
            list(self.rc_dir.glob(f"{self.index_path.name}.*.tmp")),
            [],
        )

    def test_existing_index_permission_failure_is_not_overwritten(self) -> None:
        self.index_path.write_text('{"old": true}\n', encoding="utf-8")
        before = self.index_path.read_bytes()
        original_read_text = Path.read_text

        def fail_destination_read(path, *args, **kwargs):
            if Path(path) == self.index_path:
                raise PermissionError(13, "Access is denied", str(path))
            return original_read_text(path, *args, **kwargs)

        with (
            mock.patch.object(Path, "read_text", new=fail_destination_read),
            mock.patch.object(dataset_index_contract.os, "replace") as replace,
        ):
            with self.assertRaises(PermissionError):
                dataset_index_contract.write_index_json(
                    self.index_path,
                    self.payload,
                )

        replace.assert_not_called()
        self.assertEqual(self.index_path.read_bytes(), before)

    def test_temp_names_are_unique_across_changed_writes(self) -> None:
        sources: list[str] = []
        original_replace = dataset_index_contract.os.replace

        def capture_replace(source, destination):
            sources.append(str(source))
            return original_replace(source, destination)

        with mock.patch.object(
            dataset_index_contract.os,
            "replace",
            side_effect=capture_replace,
        ):
            self.assertTrue(
                dataset_index_contract.write_index_json(
                    self.index_path,
                    self.payload,
                )
            )
            changed_payload = dict(self.payload)
            changed_payload["folder_signature"] = "sha256:" + ("1" * 64)
            self.assertTrue(
                dataset_index_contract.write_index_json(
                    self.index_path,
                    changed_payload,
                )
            )

        self.assertEqual(len(sources), 2)
        self.assertEqual(len(set(sources)), 2)

    def test_non_utf8_index_is_replaced_by_canonical_json(self) -> None:
        self.index_path.write_bytes(b"\xff\xfe\x00")

        self.assertTrue(
            dataset_index_contract.write_index_json(
                self.index_path,
                self.payload,
            )
        )

        self.assertEqual(
            self.index_path.read_text(encoding="utf-8"),
            dataset_index_contract.serialize_index_json(self.payload),
        )

    def test_replace_retries_a_transient_sharing_violation(self) -> None:
        self.index_path.write_text('{"old": true}\n', encoding="utf-8")
        original_replace = dataset_index_contract.os.replace
        attempts = 0

        def replace_after_one_lock(source, destination):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise PermissionError(13, "sharing violation", str(destination))
            return original_replace(source, destination)

        with (
            mock.patch.object(
                dataset_index_contract.os,
                "replace",
                side_effect=replace_after_one_lock,
            ),
            mock.patch.object(dataset_index_contract.time, "sleep"),
        ):
            self.assertTrue(
                dataset_index_contract.write_index_json(
                    self.index_path,
                    self.payload,
                )
            )

        self.assertEqual(attempts, 2)
        self.assertEqual(
            self.index_path.read_text(encoding="utf-8"),
            dataset_index_contract.serialize_index_json(self.payload),
        )

    def test_update_lock_serializes_complete_transactions(self) -> None:
        start = threading.Event()
        state_lock = threading.Lock()
        active = 0
        max_active = 0

        def worker() -> None:
            nonlocal active, max_active
            start.wait()
            with dataset_index_contract.index_update_lock(
                self.index_path,
                project_name="Demo",
                reserving_class=r"Auto\PP",
            ):
                with state_lock:
                    active += 1
                    max_active = max(max_active, active)
                time.sleep(0.03)
                with state_lock:
                    active -= 1

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        start.set()
        for thread in threads:
            thread.join(timeout=2)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(max_active, 1)


if __name__ == "__main__":
    unittest.main()
