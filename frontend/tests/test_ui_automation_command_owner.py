from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
API_SRC = FRONTEND_ROOT.parent / "python-api" / "src"
for root in (FRONTEND_ROOT, API_SRC):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from app_server.services import ui_automation_service
from arcrho_api import ui as arcrho_ui


class UiAutomationCommandOwnerTests(unittest.TestCase):
    """A macro's commands go back to the window that started it.

    Two apps can share one server; without an addressee the other app's shell
    could answer a review-table poll for a dialog it never opened.
    """

    def setUp(self) -> None:
        ui_automation_service.drain_pending()
        self.addCleanup(ui_automation_service.drain_pending)
        self._workers: list[threading.Thread] = []

    def tearDown(self) -> None:
        ui_automation_service.drain_pending()
        for worker in self._workers:
            worker.join(timeout=5.0)

    def _submit(self, owner: str = "") -> None:
        def submit() -> None:
            ui_automation_service.submit_command("ui.reviewTableStatus", {}, {}, 30.0, owner=owner)

        worker = threading.Thread(target=submit, daemon=True)
        worker.start()
        self._workers.append(worker)
        deadline = time.monotonic() + 5.0
        while ui_automation_service.queue_status()["queued"] < 1 and time.monotonic() < deadline:
            time.sleep(0.01)

    def test_an_addressed_command_is_refused_to_a_stranger_and_given_to_its_owner(self) -> None:
        self._submit(owner="shell_a")

        stranger = ui_automation_service.poll_command(timeout_sec=0.3, client_id="shell_b")
        self.assertIsNone(stranger["command"])

        owner = ui_automation_service.poll_command(timeout_sec=1.0, client_id="shell_a")
        self.assertEqual(owner["command"]["owner"], "shell_a")

    def test_an_unaddressed_command_goes_to_whoever_asks(self) -> None:
        self._submit()

        polled = ui_automation_service.poll_command(timeout_sec=1.0, client_id="shell_b")
        self.assertEqual(polled["command"]["command"], "ui.reviewTableStatus")
        self.assertEqual(polled["command"]["owner"], "")

    def test_a_stranger_skips_an_addressed_command_for_a_later_free_one(self) -> None:
        self._submit(owner="shell_a")
        self._submit()

        polled = ui_automation_service.poll_command(timeout_sec=1.0, client_id="shell_b")
        self.assertEqual(polled["command"]["owner"], "")
        self.assertEqual(ui_automation_service.queue_status()["queued"], 1)

    def test_an_addressed_command_falls_back_to_a_stranger_after_the_grace_period(self) -> None:
        with mock.patch.object(ui_automation_service, "OWNER_GRACE_SEC", 0.3):
            self._submit(owner="gone_window")
            started = time.monotonic()
            polled = ui_automation_service.poll_command(timeout_sec=2.0, client_id="shell_b")
            waited = time.monotonic() - started

        self.assertEqual(polled["command"]["owner"], "gone_window")
        self.assertLess(waited, 1.5)

    def test_the_grace_period_is_three_seconds(self) -> None:
        self.assertEqual(ui_automation_service.OWNER_GRACE_SEC, 3.0)


class PublicApiCommandOwnerTests(unittest.TestCase):
    def setUp(self) -> None:
        previous = arcrho_ui.set_command_owner("")
        self.addCleanup(arcrho_ui.set_command_owner, previous)

    def _sent_payload(self) -> dict:
        with mock.patch.object(arcrho_ui, "_post_json", return_value={"ok": True, "result": {}}) as post:
            arcrho_ui.send_command("ui.messageBox", args={"text": "hi"})
        return post.call_args.args[1]

    def test_a_command_is_unaddressed_outside_a_run(self) -> None:
        self.assertNotIn("owner", self._sent_payload())

    def test_every_command_during_a_run_names_the_starting_window(self) -> None:
        previous = arcrho_ui.set_command_owner("shell_a")
        self.assertEqual(previous, "")
        self.assertEqual(self._sent_payload()["owner"], "shell_a")

        self.assertEqual(arcrho_ui.set_command_owner(previous), "shell_a")
        self.assertNotIn("owner", self._sent_payload())


class MacroRunCommandOwnerTests(unittest.TestCase):
    def test_the_macro_host_addresses_the_run_and_clears_it_afterwards(self) -> None:
        from app_server.services import scripting_macro_service

        source = (
            "from arcrho_api import ui as arcrho_ui\n"
            "def run_macro():\n"
            "    return {'message': 'owner=' + arcrho_ui.get_command_owner()}\n"
        )
        result = scripting_macro_service.run_macro_source(
            source, "owner_probe.py", {}, client_id="shell_a"
        )

        self.assertTrue(result.get("success"), result)
        self.assertEqual(result.get("message"), "owner=shell_a")
        self.assertEqual(arcrho_ui.get_command_owner(), "")


if __name__ == "__main__":
    unittest.main()
