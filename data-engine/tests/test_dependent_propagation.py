from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_ENGINE_SRC = REPO_ROOT / "data-engine" / "src"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
TESTS_DIR = Path(__file__).resolve().parent
for path in (DATA_ENGINE_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_dependent_propagation_contract import (
    DEPENDENT_PROPAGATION_FUNCTION,
    build_dependent_propagation_request,
    dependent_propagation_request_path,
    dependent_propagation_status_path,
    validate_dependent_propagation_status,
)
from arcrho_engine import dependent_propagation
from arcrho_engine import main as engine_main


class DependentPropagationEngineTests(unittest.TestCase):
    REQUEST_ID = "0123456789abcdef0123456789abcdef"

    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _publish_request(self, request_id: str | None = None) -> tuple[Path, dict]:
        request = build_dependent_propagation_request(
            request_id=request_id or self.REQUEST_ID,
            project_name="Demo",
            path="HPPREF\\HOL",
            changed_roots=[{"dataset_name": "Paid", "dataset_type": "Paid Loss"}],
            user_name="tester",
        )
        path = dependent_propagation_request_path(self.root, request["RequestId"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(request), encoding="utf-8")
        return path, request

    def test_walk_failure_summary_names_dataset_and_method_failures(self) -> None:
        message = dependent_propagation._summarize_walk_failure(
            {
                "skipped": [{"dataset_type_name": "C 61 Reported - CWOP"}],
                "result_selection_updates": {
                    "ok": False,
                    "errors": [
                        {
                            "dataset_name": "C 91 - Current Qtr Indicated",
                            "reason": "Required precedent needs review: C 41 - BF Reported ex CWOP",
                        }
                    ],
                },
                "bootstrap_updates": {"ok": True, "errors": []},
            }
        )
        self.assertIn("C 61 Reported - CWOP", message)
        self.assertIn(
            "C 91 - Current Qtr Indicated: Required precedent needs review: "
            "C 41 - BF Reported ex CWOP",
            message,
        )
        self.assertIn("save again or refresh to retry", message)

        generic = dependent_propagation._summarize_walk_failure({"skipped": []})
        self.assertIn("One or more dependent updates failed.", generic)

    def test_request_filename_must_match_request_id(self) -> None:
        path, request = self._publish_request()
        renamed = path.with_name("other-name.json")
        path.rename(renamed)
        with patch.object(dependent_propagation, "execute_dependent_propagation") as walk:
            completed = dependent_propagation.process_durable_dependent_propagation_request(
                self.root, renamed, request
            )
        self.assertFalse(completed)
        walk.assert_not_called()
        self.assertTrue(renamed.exists())

    def test_contract_invalid_request_publishes_rejected_status_and_is_consumed(self) -> None:
        path, request = self._publish_request()
        request = {**request, "DataPath": r"E:\ArcRho Server\file.csv"}
        path.write_text(json.dumps(request), encoding="utf-8")
        completed = dependent_propagation.process_durable_dependent_propagation_request(
            self.root, path, request
        )
        self.assertFalse(completed)
        self.assertFalse(path.exists())
        persisted = json.loads(
            dependent_propagation_status_path(self.root, self.REQUEST_ID).read_text(
                encoding="utf-8"
            )
        )
        status = validate_dependent_propagation_status(
            persisted, expected_request_id=self.REQUEST_ID
        )
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["progress"]["stage"], "rejected")

    def test_unidentifiable_request_is_dropped_so_the_rescan_cannot_loop(self) -> None:
        path = (
            self.root / "requests" / "dependent_propagation" / "requests" / "bad.json"
        )
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"Function": DEPENDENT_PROPAGATION_FUNCTION}), encoding="utf-8")
        completed = dependent_propagation.process_durable_dependent_propagation_request(
            self.root, path, {"Function": DEPENDENT_PROPAGATION_FUNCTION}
        )
        self.assertFalse(completed)
        self.assertFalse(path.exists())

    def test_request_is_retained_until_a_validated_terminal_status_exists(self) -> None:
        path, request = self._publish_request()

        with (
            patch.object(
                dependent_propagation,
                "execute_dependent_propagation",
                return_value={"ok": True, "steps": []},
            ),
            patch.object(
                dependent_propagation,
                "write_dependent_propagation_status",
                side_effect=PermissionError("locked"),
            ),
        ):
            completed = dependent_propagation.process_durable_dependent_propagation_request(
                self.root, path, request
            )

        self.assertFalse(completed)
        self.assertTrue(path.exists())

    def test_handler_dispatches_durable_propagation_off_the_legacy_path(self) -> None:
        handler = engine_main.RequestHandler()
        path, request = self._publish_request()
        with (
            patch.object(
                engine_main,
                "process_durable_dependent_propagation_request",
            ) as process,
            patch.object(engine_main, "get_project_root", return_value=self.root),
        ):
            handler.process_file(str(path), dispatch_duplication=False)
        process.assert_called_once()
        self.assertTrue(handler.shutdown(wait=True, timeout=2.0))

    def test_scheduled_dispatch_runs_on_the_propagation_worker_thread(self) -> None:
        handler = engine_main.RequestHandler()
        path, request = self._publish_request()
        with (
            patch.object(
                engine_main,
                "process_durable_dependent_propagation_request",
            ) as process,
            patch.object(engine_main, "get_project_root", return_value=self.root),
        ):
            handler.process_file(str(path), dispatch_duplication=True)
            handler._propagation_queue.join()
        process.assert_called_once()
        self.assertTrue(handler.shutdown(wait=True, timeout=2.0))

    def test_rescan_cycle_offers_the_propagation_queue_subfolder(self) -> None:
        path, _request = self._publish_request()
        observed: list[str] = []

        class _Recorder:
            def process_file_debug(self, file_path):
                observed.append(str(file_path))

        engine_main.process_existing_requests(self.root / "requests", _Recorder())
        self.assertEqual(observed, [str(path)])


if __name__ == "__main__":
    unittest.main()
