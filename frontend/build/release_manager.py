"""Local browser control surface for local installer builds and GitHub Releases.

Run through release_manager.bat on a Windows build machine.  The server binds to
127.0.0.1, opens the UI in the default browser, and deliberately does not contain
release business logic: it invokes build_app_from_local_repo.bat and the
canonical release_workflow module so command-line and browser actions follow the
same validation, manifest, and GitHub rules.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
import traceback
import webbrowser
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse


BUILD_ROOT = Path(__file__).resolve().parent
RELEASE_ROOT = BUILD_ROOT / "release"
FRONTEND_ROOT = BUILD_ROOT.parent
BUILD_SCRIPT = BUILD_ROOT / "build_app_from_local_repo.bat"
WORKFLOW_SCRIPT = RELEASE_ROOT / "release_workflow.py"
UI_FILE = RELEASE_ROOT / "release_manager_ui.html"

if str(RELEASE_ROOT) not in sys.path:
    sys.path.insert(0, str(RELEASE_ROOT))

import release_workflow


CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
ACTIVITY_BUFFER_LINES = 4000
PUBLISHABLE_STATUSES = frozenset({"built", "remote_published"})


class OperationRunner:
    """Runs one build, publish, or revoke subprocess at a time and buffers output.

    The browser polls the buffer, so a reload or a second tab still sees the
    activity of an operation that is already running.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._lines: list[str] = []
        self._first_line_index = 0
        self._running = False
        self._title = ""
        self._status = "Ready"
        self._completed = 0
        self._result: dict[str, Any] | None = None

    def start(self, title: str, command: list[str], environment: dict[str, str]) -> None:
        with self._lock:
            if self._running:
                raise RuntimeError("Wait for the current build or release operation to finish.")
            self._running = True
            self._title = title
            self._status = title
        self.append(f"[{title}] {subprocess.list2cmdline(command)}")
        threading.Thread(
            target=self._run,
            args=(title, command, environment),
            daemon=True,
        ).start()

    def append(self, message: str) -> None:
        if not message:
            return
        with self._lock:
            self._lines.append(message)
            overflow = len(self._lines) - ACTIVITY_BUFFER_LINES
            if overflow > 0:
                del self._lines[:overflow]
                self._first_line_index += overflow

    def snapshot(self, cursor: int) -> dict[str, Any]:
        with self._lock:
            end = self._first_line_index + len(self._lines)
            start = max(cursor, self._first_line_index)
            start = min(start, end)
            return {
                "cursor": end,
                "lines": self._lines[start - self._first_line_index :],
                "truncated": cursor < self._first_line_index,
                "running": self._running,
                "title": self._title,
                "status": self._status,
                "completed": self._completed,
                "result": self._result,
            }

    def _run(self, title: str, command: list[str], environment: dict[str, str]) -> None:
        detail = ""
        try:
            with subprocess.Popen(
                command,
                cwd=str(FRONTEND_ROOT),
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=CREATE_NO_WINDOW,
            ) as process:
                assert process.stdout is not None
                for line in process.stdout:
                    self.append(line.rstrip())
                exit_code = process.wait()
        except OSError as exc:
            exit_code = 1
            detail = str(exc)

        if exit_code == 0:
            self.append(f"[{title}] completed successfully.")
        else:
            self.append(f"[{title}] failed with exit code {exit_code}. {detail}".strip())
        self._finish(title, exit_code, detail)

    def _finish(self, title: str, exit_code: int, detail: str) -> None:
        with self._lock:
            self._running = False
            self._completed += 1
            self._status = f"{title} completed" if exit_code == 0 else f"{title} failed"
            self._result = {
                "id": self._completed,
                "title": title,
                "ok": exit_code == 0,
                "exit_code": exit_code,
                "detail": detail,
            }


def pending_records() -> list[dict[str, Any]]:
    """Project the pending manifests down to what the browser UI renders."""

    rows: list[dict[str, Any]] = []
    for record in release_workflow.list_pending_releases():
        installer = record.get("installer") if isinstance(record.get("installer"), dict) else {}
        rows.append(
            {
                "product": str(record.get("product", "")),
                "version": str(record.get("version", "")),
                "built_at": str(record.get("built_at", "")),
                "status": str(record.get("status", "unknown")),
                "installer_name": str(installer.get("name", "")),
                "installer_path": str(installer.get("path", "")),
            }
        )
    return rows


def find_pending_record(product: str, version: str) -> dict[str, Any] | None:
    for record in pending_records():
        if record["product"] == product and record["version"] == version:
            return record
    return None


def build_command(product: str, version: str) -> tuple[list[str], dict[str, str]]:
    environment = os.environ.copy()
    environment["ARCRHO_BUILD_PRODUCT"] = product.casefold()
    environment["ARCRHO_NONINTERACTIVE"] = "1"
    return ["cmd.exe", "/d", "/c", str(BUILD_SCRIPT), "--build-only", version], environment


def publish_command(product: str, version: str, commit: bool) -> tuple[list[str], dict[str, str]]:
    command = [sys.executable, str(WORKFLOW_SCRIPT), "publish", "--product", product, "--version", version]
    if not commit:
        command.append("--no-commit")
    return command, os.environ.copy()


def revoke_command(product: str, version: str) -> tuple[list[str], dict[str, str]]:
    command = [
        sys.executable,
        str(WORKFLOW_SCRIPT),
        "revoke",
        "--product",
        product,
        "--version",
        version,
        "--confirm-version",
        version,
    ]
    return command, os.environ.copy()


class ReleaseManagerHandler(BaseHTTPRequestHandler):
    """Serves the UI document and the JSON API it calls."""

    server_version = "ArcRhoReleaseManager/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    @property
    def runner(self) -> OperationRunner:
        return self.server.runner  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not self._host_allowed():
            return
        if parsed.path in ("/", "/index.html"):
            self._send_file(UI_FILE, "text/html; charset=utf-8")
            return
        if not self._authorized():
            return

        query = parse_qs(parsed.query)
        if parsed.path == "/api/environment":
            self._send_json(
                {
                    "products": list(release_workflow.PRODUCTS),
                    "repository": str(FRONTEND_ROOT.parent),
                    "work_dir": str(release_workflow.local_release_work_dir()),
                }
            )
        elif parsed.path == "/api/pending":
            self._guarded(lambda: {"records": pending_records()})
        elif parsed.path == "/api/suggested-version":
            product = query.get("product", [""])[0]
            self._guarded(lambda: {"version": release_workflow.next_version(product)})
        elif parsed.path == "/api/history":
            product = query.get("product", [""])[0]
            self._guarded(lambda: {"product": product, "records": release_workflow.list_release_history(product)})
        elif parsed.path == "/api/activity":
            cursor = self._int_param(query, "cursor")
            self._send_json(self.runner.snapshot(cursor))
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self._host_allowed() or not self._authorized():
            return
        try:
            payload = self._read_json_body()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path == "/api/build":
            self._start_build(payload)
        elif parsed.path == "/api/publish":
            self._start_publish(payload)
        elif parsed.path == "/api/revoke":
            self._start_revoke(payload)
        elif parsed.path == "/api/open-installer":
            self._open_installer(payload)
        elif parsed.path == "/api/shutdown":
            self._send_json({"ok": True})
            self.server.request_shutdown("quit requested from the browser")  # type: ignore[attr-defined]
        else:
            self._send_json({"error": "Not found"}, status=404)

    def _start_build(self, payload: dict[str, Any]) -> None:
        try:
            product = release_workflow.normalize_product(str(payload.get("product", "")))
            version = release_workflow.validate_version(str(payload.get("version", "")).strip())
        except release_workflow.ReleaseWorkflowError as exc:
            self._send_json({"error": str(exc)}, status=400)
            return
        command, environment = build_command(product, version)
        self._launch(f"Building {product} {version} without publishing", command, environment)

    def _start_publish(self, payload: dict[str, Any]) -> None:
        record = self._requested_record(payload)
        if record is None:
            return
        status = record["status"]
        if status not in PUBLISHABLE_STATUSES:
            self._send_json(
                {"error": f"This local record is {status!r} and cannot be published."},
                status=409,
            )
            return
        command, environment = publish_command(
            record["product"], record["version"], bool(payload.get("commit", True))
        )
        self._launch(f"Publishing {record['product']} {record['version']}", command, environment)

    def _start_revoke(self, payload: dict[str, Any]) -> None:
        try:
            product = release_workflow.normalize_product(str(payload.get("product", "")))
            version = release_workflow.validate_version(str(payload.get("version", "")).strip())
        except release_workflow.ReleaseWorkflowError as exc:
            self._send_json({"error": str(exc)}, status=400)
            return
        if str(payload.get("confirm", "")).strip() != version:
            self._send_json(
                {"error": "The entered version did not match; nothing was deleted."},
                status=400,
            )
            return
        command, environment = revoke_command(product, version)
        self._launch(f"Revoking {product} {version}", command, environment)

    def _open_installer(self, payload: dict[str, Any]) -> None:
        record = self._requested_record(payload)
        if record is None:
            return
        path = Path(record["installer_path"])
        if not path.is_file():
            self._send_json(
                {"error": f"The recorded installer is no longer available:\n{path}"},
                status=404,
            )
            return
        try:
            os.startfile(path)  # type: ignore[attr-defined]
        except OSError as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        self._send_json({"ok": True, "name": path.name})

    def _requested_record(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        product = str(payload.get("product", "")).strip()
        version = str(payload.get("version", "")).strip()
        try:
            record = find_pending_record(product, version)
        except release_workflow.ReleaseWorkflowError as exc:
            self._send_json({"error": str(exc)}, status=500)
            return None
        if record is None:
            self._send_json({"error": f"No local build record for {product} {version}."}, status=404)
            return None
        return record

    def _launch(self, title: str, command: list[str], environment: dict[str, str]) -> None:
        try:
            self.runner.start(title, command, environment)
        except RuntimeError as exc:
            self._send_json({"error": str(exc)}, status=409)
            return
        self._send_json({"ok": True, "title": title})

    def _guarded(self, produce: Callable[[], dict[str, Any]]) -> None:
        """Answer a read request, turning workflow and tooling failures into 500s."""

        try:
            self._send_json({"ok": True, **produce()})
        except release_workflow.ReleaseWorkflowError as exc:
            self._send_json({"error": str(exc)}, status=500)
        except Exception as exc:  # noqa: BLE001 - surface gh/tooling failures in the UI
            self.runner.append(f"[request {self.path}] {exc}")
            traceback.print_exc()
            self._send_json({"error": str(exc)}, status=500)

    def _int_param(self, query: dict[str, list[str]], name: str) -> int:
        try:
            return max(0, int(query.get(name, ["0"])[0]))
        except ValueError:
            return 0

    def _host_allowed(self) -> bool:
        """Reject DNS-rebinding hosts; only the loopback names may reach the API."""

        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").casefold()
        if host in ("127.0.0.1", "localhost", "::1", ""):
            return True
        self._send_json({"error": "Unexpected Host header"}, status=403)
        return False

    def _authorized(self) -> bool:
        token = str(getattr(self.server, "session_token", ""))
        if secrets.compare_digest(self.headers.get("X-ArcRho-Token") or "", token):
            return True
        self._send_json({"error": "Missing or invalid session token"}, status=403)
        return False

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length header") from exc
        if length <= 0:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid request body: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object")
        return payload

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
        except OSError as exc:
            self._send_json({"error": f"Missing UI file: {path} ({exc})"}, status=500)
            return
        self._send_bytes(data, content_type)

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self._send_bytes(
            json.dumps(payload).encode("utf-8"),
            "application/json; charset=utf-8",
            status=status,
        )

    def _send_bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


class ReleaseManagerServer(ThreadingHTTPServer):
    """Loopback server that owns the session token and the single operation runner."""

    daemon_threads = True

    def __init__(self, port: int) -> None:
        super().__init__(("127.0.0.1", port), ReleaseManagerHandler)
        self.session_token = secrets.token_urlsafe(32)
        self.runner = OperationRunner()
        self.shutdown_requested = False

    def handle_error(self, request: Any, client_address: Any) -> None:
        # A browser that navigates away or reloads drops its keep-alive socket;
        # that is normal here and must not print a traceback in the console the
        # operator is watching for build output.
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        traceback.print_exc()

    def request_shutdown(self, reason: str) -> None:
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        print(f"Release Manager stopping: {reason}", flush=True)
        threading.Thread(target=self.shutdown, daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open ArcRho Release Manager in a local browser.")
    parser.add_argument("--port", type=int, default=0, help="Loopback port to listen on; 0 picks a free port.")
    parser.add_argument("--no-browser", action="store_true", help="Print the URL instead of opening a browser.")
    args = parser.parse_args(argv)

    server = ReleaseManagerServer(args.port)
    url = f"http://127.0.0.1:{server.server_port}/?{urlencode({'token': server.session_token})}"
    print(f"ArcRho Release Manager: {url}", flush=True)
    print("Keep this window open while you build, publish, or revoke. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown_requested = True
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
