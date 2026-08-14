from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


BUILD_DIR = Path(__file__).resolve().parents[1] / "build"
if str(BUILD_DIR) not in sys.path:
    sys.path.insert(0, str(BUILD_DIR))

import release_manager


PENDING_MANIFEST = {
    "product": "ArcRho",
    "version": "1.2.13",
    "built_at": "2026-08-14T09:12:44Z",
    "status": "built",
    "installer": {"name": "ArcRho Setup 1.2.13.exe", "path": "C:/tmp/ArcRho Setup 1.2.13.exe"},
}


def wait_for(predicate, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class OperationRunnerTests(unittest.TestCase):
    def test_streams_output_and_reports_success(self) -> None:
        runner = release_manager.OperationRunner()
        runner.start("Echo", ["cmd.exe", "/d", "/c", "echo streamed line"], os.environ.copy())
        self.assertTrue(wait_for(lambda: runner.snapshot(0)["completed"] == 1))

        snapshot = runner.snapshot(0)
        self.assertFalse(snapshot["running"])
        self.assertIn("streamed line", snapshot["lines"])
        self.assertEqual(snapshot["cursor"], len(snapshot["lines"]))
        self.assertTrue(snapshot["result"]["ok"])
        self.assertEqual(snapshot["result"]["exit_code"], 0)

        # A cursor at the end returns no repeats, which is what the browser polls with.
        self.assertEqual(runner.snapshot(snapshot["cursor"])["lines"], [])

    def test_reports_failure_exit_code(self) -> None:
        runner = release_manager.OperationRunner()
        runner.start("Failing", ["cmd.exe", "/d", "/c", "exit 3"], os.environ.copy())
        self.assertTrue(wait_for(lambda: runner.snapshot(0)["completed"] == 1))

        snapshot = runner.snapshot(0)
        self.assertFalse(snapshot["result"]["ok"])
        self.assertEqual(snapshot["result"]["exit_code"], 3)
        self.assertEqual(snapshot["status"], "Failing failed")

    def test_refuses_a_second_concurrent_operation(self) -> None:
        runner = release_manager.OperationRunner()
        runner.start("First", ["cmd.exe", "/d", "/c", "echo first"], os.environ.copy())
        with self.assertRaises(RuntimeError):
            runner.start("Second", ["cmd.exe", "/d", "/c", "echo second"], os.environ.copy())
        self.assertTrue(wait_for(lambda: not runner.snapshot(0)["running"]))

    def test_trims_the_buffer_and_flags_truncation(self) -> None:
        runner = release_manager.OperationRunner()
        with mock.patch.object(release_manager, "ACTIVITY_BUFFER_LINES", 5):
            for index in range(9):
                runner.append(f"line {index}")
        snapshot = runner.snapshot(0)
        self.assertEqual(snapshot["cursor"], 9)
        self.assertEqual(snapshot["lines"], [f"line {index}" for index in range(4, 9)])
        self.assertTrue(snapshot["truncated"])


class ReleaseManagerServerTests(unittest.TestCase):
    """Drives the loopback API the browser UI calls."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = release_manager.ReleaseManagerServer(0)
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, path: str, *, method: str = "GET", body=None, token=None, host=None):
        request = urllib.request.Request(f"{self.base_url}{path}", method=method)
        request.add_header("X-ArcRho-Token", self.server.session_token if token is None else token)
        if host is not None:
            request.add_header("Host", host)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, data=data, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_serves_the_ui_document_without_a_token(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/", timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertEqual(response.status, 200)
        self.assertIn("ArcRho Release Manager", body)
        self.assertIn('data-theme="dark"', body)

    def test_api_requires_the_session_token(self) -> None:
        status, payload = self.request("/api/pending", token="wrong-token")
        self.assertEqual(status, 403)
        self.assertIn("session token", payload["error"])

    def test_api_rejects_a_foreign_host_header(self) -> None:
        status, payload = self.request("/api/pending", host="release-manager.example")
        self.assertEqual(status, 403)
        self.assertIn("Host", payload["error"])

    def test_environment_lists_products_and_paths(self) -> None:
        status, payload = self.request("/api/environment")
        self.assertEqual(status, 200)
        self.assertEqual(payload["products"], list(release_manager.release_workflow.PRODUCTS))
        self.assertTrue(payload["repository"])
        self.assertTrue(payload["work_dir"])

    def test_pending_projects_manifest_fields(self) -> None:
        with mock.patch.object(
            release_manager.release_workflow, "list_pending_releases", return_value=[dict(PENDING_MANIFEST)]
        ):
            status, payload = self.request("/api/pending")
        self.assertEqual(status, 200)
        self.assertEqual(
            payload["records"],
            [
                {
                    "product": "ArcRho",
                    "version": "1.2.13",
                    "built_at": "2026-08-14T09:12:44Z",
                    "status": "built",
                    "installer_name": "ArcRho Setup 1.2.13.exe",
                    "installer_path": "C:/tmp/ArcRho Setup 1.2.13.exe",
                }
            ],
        )

    def test_read_failures_become_readable_errors(self) -> None:
        failure = release_manager.release_workflow.ReleaseWorkflowError("gh is not authenticated")
        with mock.patch.object(release_manager.release_workflow, "next_version", side_effect=failure):
            status, payload = self.request("/api/suggested-version?product=ArcRho")
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "gh is not authenticated")

    def test_build_rejects_an_invalid_version(self) -> None:
        with mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, payload = self.request(
                "/api/build", method="POST", body={"product": "ArcRho", "version": "not-a-version"}
            )
        self.assertEqual(status, 400)
        self.assertIn("Invalid version", payload["error"])
        start.assert_not_called()

    def test_build_starts_a_build_only_run(self) -> None:
        with mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, payload = self.request(
                "/api/build", method="POST", body={"product": "arcrho", "version": "1.2.13"}
            )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        title, command, environment = start.call_args.args
        self.assertEqual(title, "Building ArcRho 1.2.13 without publishing")
        self.assertEqual(command[-2:], ["--build-only", "1.2.13"])
        self.assertEqual(environment["ARCRHO_BUILD_PRODUCT"], "arcrho")
        self.assertEqual(environment["ARCRHO_NONINTERACTIVE"], "1")

    def test_publish_refuses_a_record_that_is_already_published(self) -> None:
        published = dict(PENDING_MANIFEST, status="published")
        with mock.patch.object(
            release_manager.release_workflow, "list_pending_releases", return_value=[published]
        ), mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, payload = self.request(
                "/api/publish", method="POST", body={"product": "ArcRho", "version": "1.2.13"}
            )
        self.assertEqual(status, 409)
        self.assertIn("cannot be published", payload["error"])
        start.assert_not_called()

    def test_publish_passes_the_commit_choice_through(self) -> None:
        with mock.patch.object(
            release_manager.release_workflow, "list_pending_releases", return_value=[dict(PENDING_MANIFEST)]
        ), mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, _ = self.request(
                "/api/publish",
                method="POST",
                body={"product": "ArcRho", "version": "1.2.13", "commit": False},
            )
        self.assertEqual(status, 200)
        command = start.call_args.args[1]
        self.assertIn("publish", command)
        self.assertIn("--no-commit", command)

    def test_publish_requires_a_known_local_record(self) -> None:
        with mock.patch.object(
            release_manager.release_workflow, "list_pending_releases", return_value=[]
        ), mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, payload = self.request(
                "/api/publish", method="POST", body={"product": "ArcRho", "version": "9.9.9"}
            )
        self.assertEqual(status, 404)
        self.assertIn("No local build record", payload["error"])
        start.assert_not_called()

    def test_revoke_requires_the_typed_version(self) -> None:
        with mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, payload = self.request(
                "/api/revoke",
                method="POST",
                body={"product": "ArcRho", "version": "1.2.13", "confirm": "1.2.12"},
            )
        self.assertEqual(status, 400)
        self.assertIn("did not match", payload["error"])
        start.assert_not_called()

    def test_revoke_confirms_with_the_matching_version(self) -> None:
        with mock.patch.object(release_manager.OperationRunner, "start") as start:
            status, _ = self.request(
                "/api/revoke",
                method="POST",
                body={"product": "ArcRho", "version": "1.2.13", "confirm": "1.2.13"},
            )
        self.assertEqual(status, 200)
        command = start.call_args.args[1]
        self.assertIn("revoke", command)
        self.assertEqual(command[-2:], ["--confirm-version", "1.2.13"])

    def test_rejects_an_invalid_request_body(self) -> None:
        request = urllib.request.Request(f"{self.base_url}/api/build", method="POST")
        request.add_header("X-ArcRho-Token", self.server.session_token)
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, data=b"not json", timeout=10)
        self.assertEqual(raised.exception.code, 400)

    def test_unknown_routes_answer_with_json(self) -> None:
        status, payload = self.request("/api/does-not-exist")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "Not found")


if __name__ == "__main__":
    unittest.main()
