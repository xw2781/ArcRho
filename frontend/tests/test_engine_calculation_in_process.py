"""The hosting Engine runs a local exchange itself once it registers a calculator."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import engine_calculation_service as service  # noqa: E402


PAIRS = [
    ("Function", "ArcRhoTri"),
    ("Path", "Auto\\PP"),
    ("DatasetName", "Claim Counts--CWP"),
    ("InstanceName", "Claim Counts--CWP"),
    ("Cumulative", "True"),
    ("Transposed", "False"),
    ("Calendar", "False"),
    ("ProjectName", "Demo"),
    ("OriginLength", "3"),
    ("DevelopmentLength", "3"),
]


class InProcessCalculatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(service.set_in_process_calculator, None)
        self.data_path = str(Path(self.temp.name) / "Claim Counts--CWP@3@3@cum@dev.csv")

    def _run(self):
        with (
            patch.object(service, "is_network_path", return_value=False),
            patch.object(service.client_save_latency_log_service, "append_client_read_latency"),
            patch.object(
                service,
                "publish_and_wait",
                return_value={"ok": True, "status": "completed", "request_file": "r.json", "wait_ms": 1.0},
            ) as publish,
        ):
            outcome = service.run_engine_calculation(PAIRS, self.data_path, 15.0)
        return outcome, publish

    def test_the_calculator_gets_the_request_document_and_no_file_is_published(self) -> None:
        seen = []

        def calculator(payload):
            seen.append(dict(payload))
            Path(payload["DataPath"]).write_text("1,2\n", encoding="utf-8")

        service.set_in_process_calculator(calculator)
        outcome, publish = self._run()

        publish.assert_not_called()
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["status"], "completed")
        self.assertEqual(outcome["transport"], service.TRANSPORT_IN_PROCESS)
        self.assertIsNone(outcome["request_file"])
        # The document is what a request file would have held: native types
        # and the requesting user, so the Engine's functions read it unchanged.
        payload = seen[0]
        self.assertEqual(payload["Function"], "ArcRhoTri")
        self.assertEqual(payload["OriginLength"], 3)
        self.assertIs(payload["Cumulative"], True)
        self.assertEqual(payload["DataPath"], self.data_path)
        self.assertTrue(payload["UserName"])

    def test_a_raising_calculator_reports_its_message(self) -> None:
        def calculator(payload):
            raise RuntimeError("Dataset type [Claim Counts--CWP] is not defined for project [Demo].")

        service.set_in_process_calculator(calculator)
        outcome, publish = self._run()

        publish.assert_not_called()
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["status"], service.STATUS_ENGINE_ERROR)
        self.assertIn("is not defined for project", outcome["message"])

    def test_a_calculator_that_writes_nothing_is_a_failure(self) -> None:
        service.set_in_process_calculator(lambda payload: None)
        outcome, _publish = self._run()

        self.assertFalse(outcome["ok"])
        self.assertIn("without writing its output", outcome["message"])

    def test_without_a_calculator_the_request_file_exchange_runs(self) -> None:
        service.set_in_process_calculator(None)
        outcome, publish = self._run()

        publish.assert_called_once()
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["transport"], service.TRANSPORT_LOCAL)


if __name__ == "__main__":
    unittest.main()
