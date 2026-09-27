"""A test run can never reach the real Gateway this PC is signed in to."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import Request

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "server-components" / "src", REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import config as api_config  # noqa: E402
from arcrho_api import gateway_test_guard as guard  # noqa: E402
from app_server import config as app_config  # noqa: E402

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MODULE = Path(__file__).stem
IN_PROCESS = "GuardInThisProcessTests"


class GuardInThisProcessTests(unittest.TestCase):
    """Run in this process, and again in every child the launch tests start."""

    def test_the_run_sees_no_gateway_credential(self) -> None:
        self.assertTrue(guard.guard_active())
        self.assertEqual(os.environ[guard.GUARD_ENV], "1")
        self.assertEqual(api_config.gateway_config_path(), guard.MISSING_CREDENTIAL)
        self.assertEqual(app_config.load_gateway_config(), {"enabled": False})

    def test_a_real_gateway_is_refused_before_a_connection_is_made(self) -> None:
        opener = guard.gateway_opener()
        for url in ("http://NE7SASWPN02.PRCINS.NET:28767/api/capabilities", "http://127.0.0.1:28767/api/health"):
            with self.subTest(url=url), patch.object(socket, "create_connection", side_effect=AssertionError("connected")):
                with self.assertRaises(URLError) as raised:
                    opener.open(Request(url), timeout=1)
                self.assertIn("never reaches a real Arco Gateway", str(raised.exception.reason))


class GuardBehaviourTests(unittest.TestCase):
    def test_record_mode_names_the_test_that_sent_the_request(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as folder:
            record = Path(folder) / "record.jsonl"
            with patch.dict(os.environ, {guard.RECORD_ENV: str(record)}):
                with self.assertRaises(URLError):
                    guard.gateway_opener().open(Request("http://gateway.example:28767/api/workspace/read", data=b"{}"))
            entry = json.loads(record.read_text(encoding="utf-8"))
        self.assertEqual(entry["url"], "http://gateway.example:28767/api/workspace/read")
        self.assertEqual(entry["method"], "POST")
        self.assertEqual(entry["test"], self.id())

    def test_only_a_loopback_gateway_the_test_started_can_be_allowed(self) -> None:
        with self.assertRaises(ValueError):
            guard.allow_test_gateway("http://NE7SASWPN02.PRCINS.NET:28767")

        class Answer(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args) -> None:
                pass

        server = HTTPServer(("127.0.0.1", 0), Answer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/api/health"
        withdraw = guard.allow_test_gateway(url)
        with guard.gateway_opener().open(Request(url), timeout=5) as response:
            self.assertEqual(response.read(), b"{}")
        withdraw()
        with self.assertRaises(URLError):
            guard.gateway_opener().open(Request(url), timeout=5)


def _child_env() -> dict[str, str]:
    """This process's environment without the guard it passed on, so a child must find it itself."""

    env = {name: value for name, value in os.environ.items() if name not in (guard.GUARD_ENV, api_config.GATEWAY_CONFIG_ENV)}
    env.pop("PYTHONPATH", None)
    return env


class GuardLaunchTests(unittest.TestCase):
    """Every usual way of starting a suite turns the guard on in the child."""

    def _run(self, args: list[str], cwd: Path) -> None:
        result = subprocess.run(
            [sys.executable, *args], cwd=cwd, env=_child_env(), capture_output=True, text=True, timeout=120
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Ran 2 tests", result.stderr)

    def test_unittest_from_the_frontend_folder(self) -> None:
        self._run(["-m", "unittest", f"tests.{MODULE}.{IN_PROCESS}"], FRONTEND_ROOT)

    def test_unittest_from_the_tests_folder(self) -> None:
        self._run(["-m", "unittest", f"{MODULE}.{IN_PROCESS}"], FRONTEND_ROOT / "tests")

    def test_unittest_discover(self) -> None:
        self._run(["-m", "unittest", "discover", "-s", ".", "-p", f"{MODULE}.py", "-k", IN_PROCESS], FRONTEND_ROOT / "tests")

    def test_a_test_file_run_directly(self) -> None:
        self._run([str(Path(__file__)), IN_PROCESS], REPOSITORY_ROOT)

    def test_an_ordinary_process_keeps_its_gateway(self) -> None:
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]);"
            "from arcrho_api import config, gateway_test_guard as guard;"
            "print(guard.guard_active(), config.gateway_config_path() != guard.MISSING_CREDENTIAL)"
        )
        result = subprocess.run(
            [sys.executable, "-c", script, str(REPOSITORY_ROOT / "python-api" / "src")],
            env=_child_env(), capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.stdout.split(), ["False", "True"], result.stderr)


if __name__ == "__main__":
    unittest.main()
