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
DATA_ENGINE_SRC = REPO_ROOT / "data-engine" / "src"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
TESTS_DIR = Path(__file__).resolve().parent
for path in (DATA_ENGINE_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fastapi import HTTPException

from arcrho_engine_save_contract import (
    build_save_job_request,
    read_save_job_result,
    read_save_job_status,
    save_job_request_path,
)
from arcrho_engine import save_jobs


@contextmanager
def _noop_context():
    yield


def _fake_app_server(save_function):
    fake_services = types.ModuleType("app_server.services")
    fake_services.dfm_service = SimpleNamespace(save_dfm_method=save_function)
    fake_services.dependent_propagation_service = SimpleNamespace(
        suspended_reserving_class_hold_check=_noop_context,
        inline_engine_propagation=_noop_context,
    )
    fake_app_server = types.ModuleType("app_server")
    fake_app_server.services = fake_services
    return {
        "app_server": fake_app_server,
        "app_server.services": fake_services,
        "app_server.services.dfm_service": fake_services.dfm_service,
    }


class HostedSaveJobTests(unittest.TestCase):
    REQUEST_ID = "feedfacefeedfacefeedfacefeedface"

    def setUp(self) -> None:
        logs_tmp = TESTS_DIR / "logs" / "tmp"
        logs_tmp.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(logs_tmp))
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _publish_request(self) -> tuple[Path, dict]:
        request = build_save_job_request(
            request_id=self.REQUEST_ID,
            save_kind="dfm_method",
            project_name="Demo",
            path="HPPREF\\HOL",
            args=["Demo", "HPPREF\\HOL", {"json format": "dfm"}],
            kwargs={"notes": "note"},
            user_name="tester",
        )
        path = save_job_request_path(self.root, self.REQUEST_ID)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(request), encoding="utf-8")
        return path, request

    def test_claimed_save_runs_the_service_and_publishes_the_result(self) -> None:
        calls: list[tuple] = []

        def fake_save(*args, **kwargs):
            calls.append((args, kwargs))
            return {"ok": True, "propagation": {"status": "completed", "ok": True}}

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(fake_save)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertTrue(completed)
        self.assertFalse(path.exists(), "the request must be claimed by delete")
        self.assertEqual(
            calls, [(("Demo", "HPPREF\\HOL", {"json format": "dfm"}), {"notes": "note"})]
        )
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "success")
        result = read_save_job_result(self.root, self.REQUEST_ID)
        self.assertEqual(result["propagation"]["status"], "completed")

    def test_service_http_exceptions_keep_their_status_codes(self) -> None:
        def conflicting_save(*_args, **_kwargs):
            raise HTTPException(409, "DFM changed on disk; reload it before saving.")

        path, request = self._publish_request()
        with (
            patch.object(save_jobs, "configure_canonical_runtime"),
            patch.dict(sys.modules, _fake_app_server(conflicting_save)),
        ):
            completed = save_jobs.process_hosted_save_request(self.root, path, request)

        self.assertFalse(completed)
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 409)
        self.assertIn("reload it before saving", status["message"])
        self.assertIsNone(read_save_job_result(self.root, self.REQUEST_ID))

    def test_contract_invalid_request_is_dropped_with_a_rejection(self) -> None:
        path, request = self._publish_request()
        request = {**request, "SaveKind": "not_a_kind"}
        path.write_text(json.dumps(request), encoding="utf-8")
        completed = save_jobs.process_hosted_save_request(self.root, path, request)
        self.assertFalse(completed)
        self.assertFalse(path.exists())
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 400)

    def test_busy_reserving_class_reports_423_instead_of_waiting_forever(self) -> None:
        from arcrho_dependent_propagation_contract import acquire_reserving_class_lease

        holder = acquire_reserving_class_lease(self.root, "Demo", "HPPREF\\HOL")
        self.assertIsNotNone(holder)
        path, request = self._publish_request()
        try:
            with (
                patch.object(save_jobs, "configure_canonical_runtime"),
                patch.object(save_jobs, "SAVE_JOB_LEASE_WAIT_SECONDS", 0.5),
                patch.dict(sys.modules, _fake_app_server(lambda *a, **k: {"ok": True})),
            ):
                completed = save_jobs.process_hosted_save_request(
                    self.root, path, request
                )
        finally:
            from arcrho_dependent_propagation_contract import (
                release_reserving_class_lease,
            )

            release_reserving_class_lease(holder)
        self.assertFalse(completed)
        status = read_save_job_status(self.root, self.REQUEST_ID)
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["status_code"], 423)


if __name__ == "__main__":
    unittest.main()
