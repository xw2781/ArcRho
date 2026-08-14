from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_engine_save_contract import (
    save_job_request_path,
    validate_save_job_request,
    write_save_job_result,
    write_save_job_status,
)
from app_server.services import dependent_propagation_service, engine_hosted_save_service


class EngineHostedSaveClientTests(unittest.TestCase):
    """The client half: submit, poll, and map the Engine's outcome."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        (self.root / "projects").mkdir()
        self.instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        self.instances_dir.mkdir(parents=True)
        (self.instances_dir / "engine.json").write_text(
            json.dumps({"Server": "engine", "Last seen": "2026-08-13 12:00:00"}),
            encoding="utf-8",
        )
        self.path_patch = patch.object(
            dependent_propagation_service.config,
            "load_workspace_paths",
            return_value={
                "workspace_root": str(self.root),
                "paths": {"projects_dir": "projects", "requests_dir": "requests"},
            },
        )
        self.path_patch.start()

    def tearDown(self) -> None:
        self.path_patch.stop()
        self.temp_dir.cleanup()

    def _engine_stub(self, respond) -> threading.Thread:
        """Wait for the request file, then publish what `respond` returns."""

        requests_dir = self.root / "requests"

        def run() -> None:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    candidates = [
                        item
                        for item in requests_dir.iterdir()
                        if item.name.startswith("arcrho_hosted_save_")
                    ]
                except FileNotFoundError:
                    candidates = []
                if candidates:
                    request = validate_save_job_request(
                        json.loads(candidates[0].read_text(encoding="utf-8"))
                    )
                    candidates[0].unlink()
                    respond(request)
                    return
                time.sleep(0.05)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread

    def test_a_successful_hosted_save_returns_the_engine_result(self) -> None:
        def respond(request):
            write_save_job_result(
                self.root,
                request["RequestId"],
                {
                    "ok": True,
                    "echo_args": request["Args"],
                    "propagation": {
                        "ok": True,
                        "status": "completed",
                        "refreshed_datasets": ["C 61", "C 91"],
                    },
                },
            )
            write_save_job_status(self.root, request["RequestId"], "success")

        thread = self._engine_stub(respond)
        result = engine_hosted_save_service.run_hosted_save(
            "dfm_method",
            "Demo Project",
            "HPPREF\\HO+DF\\NJ",
            args=["Demo Project", "HPPREF\\HO+DF\\NJ", {"json format": "dfm"}],
            kwargs={"notes": None},
        )
        thread.join(timeout=5)
        self.assertEqual(result["propagation"]["refreshed_datasets"], ["C 61", "C 91"])
        self.assertEqual(result["echo_args"][2], {"json format": "dfm"})
        # Terminal artifacts are consumed so the queue folders stay clean.
        statuses = self.root / "requests" / "save_jobs" / "statuses"
        self.assertEqual([item.name for item in statuses.iterdir()], [])

    def test_service_errors_keep_their_status_codes(self) -> None:
        def respond(request):
            write_save_job_status(
                self.root,
                request["RequestId"],
                "error",
                message="Output dataset is already owned by another method.",
                status_code=409,
            )

        thread = self._engine_stub(respond)
        with self.assertRaises(HTTPException) as raised:
            engine_hosted_save_service.run_hosted_save(
                "cape_cod_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        thread.join(timeout=5)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("already owned", str(raised.exception.detail))

    def test_an_unclaimed_save_fails_fast_and_retracts_the_request(self) -> None:
        with patch.object(
            engine_hosted_save_service, "SAVE_JOB_QUEUED_TIMEOUT_SECONDS", 0.5
        ):
            with self.assertRaises(HTTPException) as raised:
                engine_hosted_save_service.run_hosted_save(
                    "dfm_method",
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
                )
        self.assertEqual(raised.exception.status_code, 503)
        requests_dir = self.root / "requests"
        leftovers = [
            item.name
            for item in requests_dir.iterdir()
            if item.name.startswith("arcrho_hosted_save_")
        ]
        self.assertEqual(leftovers, [], "an unclaimed request must be retracted")

    def test_no_live_engine_refuses_before_writing_anything(self) -> None:
        for item in self.instances_dir.iterdir():
            item.unlink()
        with self.assertRaises(HTTPException) as raised:
            engine_hosted_save_service.run_hosted_save(
                "dfm_method",
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                args=["Demo Project", "HPPREF\\HO+DF\\NJ", {}],
            )
        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse((self.root / "requests").exists())


class InlineEnginePropagationTests(unittest.TestCase):
    """The Engine-side inline walk that replaces save-time job enqueueing."""

    def test_inline_mode_runs_the_walk_and_collects_refreshed_names(self) -> None:
        walk_result = {
            "ok": True,
            "updated": [
                {"ok": True, "dataset_type_name": "C 61 Reported - CWOP"},
            ],
            "dfm_updates": {
                "ok": True,
                "updated": [{"dataset_name": "C 22 - CWOP DFM", "output_changed": True}],
            },
            "result_selection_updates": {
                "ok": True,
                "updated": [{"dataset_name": "C 91 - Current Qtr Indicated"}],
            },
        }
        with patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            return_value=walk_result,
        ) as walk:
            with dependent_propagation_service.inline_engine_propagation():
                payload = dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project",
                    "HPPREF\\HO+DF\\NJ",
                    "Paid Output",
                    "Selected Ultimate",
                )
        walk.assert_called_once()
        self.assertEqual(payload["status"], "completed")
        self.assertTrue(payload["ok"])
        self.assertEqual(
            payload["refreshed_datasets"],
            [
                "C 61 Reported - CWOP",
                "C 22 - CWOP DFM",
                "C 91 - Current Qtr Indicated",
            ],
        )

    def test_a_failed_inline_walk_reports_in_the_payload_not_an_error(self) -> None:
        with patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            side_effect=OSError("disk trouble"),
        ):
            with dependent_propagation_service.inline_engine_propagation():
                payload = dependent_propagation_service.enqueue_marked_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NJ", "Paid Output"
                )
        self.assertEqual(payload["status"], "completed")
        self.assertFalse(payload["ok"])
        self.assertIn("disk trouble", payload["message"])


if __name__ == "__main__":
    unittest.main()
