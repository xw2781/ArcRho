from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import electron_shell


class FakeProcess:
    """Stands in for the Electron child process.

    ``exit_after`` is the number of ``poll()`` calls the process stays alive for;
    ``None`` keeps it running until the supervisor terminates it.
    """

    def __init__(self, exit_after: int | None = None) -> None:
        self.exit_after = exit_after
        self.polls = 0
        self.terminated = False

    def poll(self) -> int | None:
        self.polls += 1
        if self.exit_after is not None and self.polls >= self.exit_after:
            return 0
        return None


class ElectronSupervisorLoopTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        tmp_root = Path(self._tmp.name)
        self.restart_flag = tmp_root / ".restart_electron"
        self.shutdown_flag = tmp_root / ".shutdown_electron"

        self._saved = (
            electron_shell.RESTART_FLAG,
            electron_shell.SHUTDOWN_FLAG,
            electron_shell.start_electron,
            electron_shell.terminate_process_tree,
            electron_shell.time.sleep,
        )
        electron_shell.RESTART_FLAG = self.restart_flag
        electron_shell.SHUTDOWN_FLAG = self.shutdown_flag
        electron_shell.terminate_process_tree = lambda proc: setattr(proc, "terminated", True)
        electron_shell.time.sleep = lambda _seconds: None

        self.launched: list[FakeProcess] = []

    def tearDown(self) -> None:
        (
            electron_shell.RESTART_FLAG,
            electron_shell.SHUTDOWN_FLAG,
            electron_shell.start_electron,
            electron_shell.terminate_process_tree,
            electron_shell.time.sleep,
        ) = self._saved
        self._tmp.cleanup()

    def _install_launcher(self, processes: list[FakeProcess], on_launch=None) -> None:
        queue = list(processes)

        def fake_start(env, mode):
            proc = queue.pop(0)
            self.launched.append(proc)
            if on_launch is not None:
                on_launch(len(self.launched))
            return proc

        electron_shell.start_electron = fake_start

    def test_user_closing_the_app_stops_the_supervisor(self) -> None:
        """The app exiting on its own must not be replaced by a fresh instance."""
        self._install_launcher([FakeProcess(exit_after=1)])

        electron_shell.run_shell("arcrho")

        self.assertEqual(len(self.launched), 1)
        self.assertFalse(self.launched[0].terminated)

    def test_restart_flag_relaunches_once_then_stops_on_close(self) -> None:
        first = FakeProcess(exit_after=None)
        second = FakeProcess(exit_after=1)

        def on_launch(count: int) -> None:
            if count == 1:
                self.restart_flag.write_text("1", encoding="utf-8")

        self._install_launcher([first, second], on_launch=on_launch)

        electron_shell.run_shell("arcrho")

        self.assertEqual(len(self.launched), 2)
        self.assertTrue(first.terminated)
        self.assertFalse(self.restart_flag.exists())
        self.assertFalse(second.terminated)

    def test_shutdown_flag_stops_the_supervisor_and_kills_electron(self) -> None:
        proc = FakeProcess(exit_after=None)

        def on_launch(_count: int) -> None:
            self.shutdown_flag.write_text("1", encoding="utf-8")

        self._install_launcher([proc], on_launch=on_launch)

        electron_shell.run_shell("arcrho")

        self.assertEqual(len(self.launched), 1)
        self.assertTrue(proc.terminated)
        self.assertFalse(self.shutdown_flag.exists())

    def test_restart_wins_over_a_process_that_already_exited(self) -> None:
        """A restart force-kills Electron, so the flag must be read before the exit."""
        first = FakeProcess(exit_after=1)
        second = FakeProcess(exit_after=1)

        def on_launch(count: int) -> None:
            if count == 1:
                self.restart_flag.write_text("1", encoding="utf-8")

        self._install_launcher([first, second], on_launch=on_launch)

        electron_shell.run_shell("arcrho")

        self.assertEqual(len(self.launched), 2)


class ChildOutputStreamsTest(unittest.TestCase):
    """The supervisor runs under pythonw.exe, whose std streams are None with no console.

    A child inheriting those handles cannot write: uvicorn logs to stderr during startup
    and exited with code 1 before binding its port, which stalled the app on the splash
    screen waiting for a server that had already died.
    """

    def setUp(self) -> None:
        self._saved = (sys.stdout, sys.stderr)

    def tearDown(self) -> None:
        sys.stdout, sys.stderr = self._saved

    def test_console_launch_lets_the_child_inherit_the_streams(self) -> None:
        self.assertEqual(electron_shell.child_output_streams(), {})

    def test_missing_stdout_redirects_the_child_to_the_null_device(self) -> None:
        sys.stdout = None
        self.assertEqual(
            electron_shell.child_output_streams(),
            {"stdout": electron_shell.subprocess.DEVNULL, "stderr": electron_shell.subprocess.DEVNULL},
        )

    def test_missing_stderr_alone_still_redirects(self) -> None:
        sys.stderr = None
        self.assertEqual(
            electron_shell.child_output_streams(),
            {"stdout": electron_shell.subprocess.DEVNULL, "stderr": electron_shell.subprocess.DEVNULL},
        )


if __name__ == "__main__":
    unittest.main()
