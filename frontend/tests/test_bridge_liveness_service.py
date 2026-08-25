"""The hosted Bridge liveness read answers from the workspace it is configured for."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, SERVER_COMPONENTS_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.bridge_liveness import BRIDGE_WORKER_DIR, QUEUE_STATUS_DIRS  # noqa: E402
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS  # noqa: E402

from app_server.services import bridge_liveness_service  # noqa: E402

REQUEST_ID = "0123456789abcdef0123456789abcdef"


class BridgeLivenessServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        patcher = patch.object(
            bridge_liveness_service.config,
            "load_workspace_paths",
            return_value={"workspace_root": str(self.root), "paths": {}},
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_read_is_registered_with_the_arguments_the_service_takes(self) -> None:
        spec = WORKSPACE_READ_KINDS["bridge_worker_liveness"]
        self.assertEqual(spec.module, "bridge_liveness_service")
        self.assertEqual(spec.function, "get_bridge_worker_liveness")
        self.assertEqual(spec.required, ())
        self.assertEqual(set(spec.optional), {"queue", "request_id"})

    def test_reports_the_worker_and_the_polled_request_from_the_configured_root(self) -> None:
        heartbeat = self.root / BRIDGE_WORKER_DIR / "worker.json"
        heartbeat.parent.mkdir(parents=True)
        heartbeat.write_text(
            json.dumps({"Role": "bridge_worker", "ResQGuiRunning": True}), encoding="utf-8"
        )
        status = {"contract_version": 1, "status": "processing", "request_id": REQUEST_ID}
        status_path = self.root / QUEUE_STATUS_DIRS["sync"] / f"{REQUEST_ID}.json"
        status_path.parent.mkdir(parents=True)
        status_path.write_text(json.dumps(status), encoding="utf-8")

        response = bridge_liveness_service.get_bridge_worker_liveness(
            queue="sync", request_id=REQUEST_ID
        )

        self.assertTrue(response["ok"])
        self.assertEqual([worker["name"] for worker in response["workers"]], ["worker.json"])
        self.assertTrue(response["workers"][0]["live"])
        self.assertTrue(response["request"]["found"])
        self.assertEqual(response["request"]["status"], status)
        self.assertLess(abs(response["request"]["age_sec"]), 2.0)

    def test_defaults_to_the_import_queue_with_no_request(self) -> None:
        response = bridge_liveness_service.get_bridge_worker_liveness()

        self.assertTrue(response["ok"])
        self.assertEqual(response["workers"], [])
        self.assertIsNone(response["request"])

    def test_refuses_an_unknown_queue_or_an_unsafe_request_id(self) -> None:
        with self.assertRaises(HTTPException) as unknown_queue:
            bridge_liveness_service.get_bridge_worker_liveness(queue="engine")
        self.assertEqual(unknown_queue.exception.status_code, 400)

        with self.assertRaises(HTTPException) as unsafe_id:
            bridge_liveness_service.get_bridge_worker_liveness(request_id="../escape")
        self.assertEqual(unsafe_id.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
