from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import ui_automation_service


class UiAutomationCommandBudgetTests(unittest.TestCase):
    """The shell can only size an in-page wait if it is told the caller's budget.

    Without it the shell has to guess, and a command that legitimately runs
    longer than the guess is reported as failed while it is still running.
    """

    def setUp(self) -> None:
        ui_automation_service.drain_pending()
        self.addCleanup(ui_automation_service.drain_pending)

    def _submit(self, timeout_sec: float) -> dict:
        polled: dict = {}

        def submit() -> None:
            ui_automation_service.submit_command(
                "projectInstance.reloadDatasetTable",
                {"scope": "activeProjectInstance"},
                {},
                timeout_sec,
            )

        worker = threading.Thread(target=submit, daemon=True)
        worker.start()
        try:
            response = ui_automation_service.poll_command(timeout_sec=5.0)
            polled = response.get("command") or {}
        finally:
            command_id = polled.get("id")
            if command_id:
                ui_automation_service.cancel_command(command_id)
            worker.join(timeout=5.0)
        return polled

    def test_a_polled_command_carries_the_submitter_deadline(self) -> None:
        command = self._submit(30.0)

        self.assertEqual(command["command"], "projectInstance.reloadDatasetTable")
        self.assertEqual(command["timeout_sec"], 30.0)

    def test_the_forwarded_budget_is_the_one_the_submitter_will_honour(self) -> None:
        # submit_command clamps before it starts waiting, so forwarding the raw
        # request would hand the shell a budget the submitter never uses.
        command = self._submit(10_000.0)

        self.assertEqual(command["timeout_sec"], ui_automation_service._MAX_TIMEOUT_SEC)


if __name__ == "__main__":
    unittest.main()
