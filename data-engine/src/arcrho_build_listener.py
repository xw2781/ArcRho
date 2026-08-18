"""The server-side worker that turns a queued build request into a deploy.

The listener runs on the machine that owns the ArcRho Server workspace, where
writing a freshly frozen component into ``apps`` is a local disk copy instead of
the multi-minute SMB transfer a client pays. It watches
``requests\\builds\\requests``, claims one request at a time through the shared
Engine job lease, reproduces the requester's source in its own clone, and then
runs exactly the same ``build_exe.py`` a human would run — the build and deploy
logic itself is not duplicated here.

**The listener owns its clone.** Every claimed request resets the working tree
to the requested source, so the clone must not be used for editing. A request
whose source mode is ``working-tree`` carries a patch against a base commit the
server can already resolve, which is what lets an agent deploy a change that is
still uncommitted on the client.

A consequence worth knowing: syncing rewrites the listener's own source files
too. The running process keeps the code it already imported, so the build in
flight is unaffected, but the listener should be restarted after a change to
its own modules. Its heartbeat reports the commit it was started from so that
mismatch is visible rather than silent.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from arcrho_build_components import (
    COMPONENT_KEYS,
    REPOSITORY_ROOT,
    Component,
    component_by_key,
)
from build_runtime import build_python_executable
from arcrho_build_request_contract import (
    BUILD_LEASE_HEARTBEAT_SECONDS,
    BUILD_LEASE_STALE_SECONDS,
    BuildRequestContractError,
    LISTENER_HEARTBEAT_SECONDS,
    SOURCE_MODE_REF,
    SOURCE_MODE_WORKING_TREE,
    build_build_status,
    build_component_state,
    build_lock_path,
    build_log_path,
    build_payload_path,
    build_request_path,
    build_requests_directory,
    ensure_build_protocol_directories,
    listener_heartbeat_path,
    validate_build_request,
    write_build_status,
    write_json_atomic,
)
from arcrho_engine_job_lease import (
    acquire_engine_job_lease,
    release_engine_job_lease,
    start_engine_job_lease_heartbeat,
    stop_engine_job_lease_heartbeat,
)


CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
POLL_SECONDS = 2.0
# One component's build: venv preparation, pip, PyInstaller, and the deploy
# swap. Generous on purpose — a timeout here abandons a half-deployed component.
COMPONENT_BUILD_TIMEOUT_SECONDS = 3600.0
PATCH_MEMBER_NAME = "changes.patch"
UNTRACKED_PREFIX = "untracked/"


class BuildListenerError(RuntimeError):
    """Raised when a claimed request cannot be prepared or built."""


def _now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _machine_name() -> str:
    return os.environ.get("COMPUTERNAME") or socket.gethostname()


def _user_name() -> str:
    return os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"


def git_output(repository_root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=str(repository_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
    )
    if completed.returncode != 0:
        raise BuildListenerError(
            f"git {' '.join(arguments)} failed: "
            f"{(completed.stderr or completed.stdout or '').strip()}"
        )
    return (completed.stdout or "").strip()


def _try_git_output(repository_root: Path, *arguments: str) -> str:
    try:
        return git_output(repository_root, *arguments)
    except (BuildListenerError, OSError):
        return ""


class BuildListener:
    """Polls the build queue and services one request at a time."""

    def __init__(
        self,
        server_root: str | os.PathLike[str],
        *,
        repository_root: str | os.PathLike[str] = REPOSITORY_ROOT,
        python_executable: str = "",
        allowed_users: Iterable[str] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self.server_root = Path(server_root)
        self.repository_root = Path(repository_root)
        self.python_executable = str(python_executable or _default_python_executable())
        self.allowed_users = tuple(allowed_users) if allowed_users is not None else None
        self._log = log or (lambda message: None)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._heartbeat_path: Path | None = None
        self._current_build: subprocess.Popen[str] | None = None
        self.started_commit = _try_git_output(self.repository_root, "rev-parse", "--short", "HEAD")

    # ---------------------------------------------------------------- lifecycle

    @property
    def running(self) -> bool:
        return bool(self._threads) and not self._stop.is_set()

    def start(self) -> None:
        if self.running:
            return
        ensure_build_protocol_directories(self.server_root)
        self._stop.clear()
        self._heartbeat_path = listener_heartbeat_path(
            self.server_root, _machine_name(), _user_name()
        )
        self._threads = [
            threading.Thread(target=self._heartbeat_loop, name="build-listener-heartbeat", daemon=True),
            threading.Thread(target=self._poll_loop, name="build-listener-poll", daemon=True),
        ]
        for thread in self._threads:
            thread.start()
        self._log(
            f"Build listener started on {_machine_name()} "
            f"(commit {self.started_commit or 'unknown'}); queue: "
            f"{build_requests_directory(self.server_root)}"
        )

    def stop(self) -> None:
        if not self._threads:
            return
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5.0)
        self._threads = []
        if self._heartbeat_path is not None:
            try:
                self._heartbeat_path.unlink()
            except OSError:
                pass
            self._heartbeat_path = None
        self._log("Build listener stopped; remote build requests are no longer serviced.")

    # ------------------------------------------------------------------- loops

    def _heartbeat_loop(self) -> None:
        created = _now_text()
        while not self._stop.is_set():
            path = self._heartbeat_path
            if path is not None:
                payload = {
                    "Server": path.stem,
                    "User": _user_name(),
                    "Created": created,
                    "Last seen": _now_text(),
                    "Repository": str(self.repository_root),
                    "Commit": self.started_commit,
                    "Components": list(COMPONENT_KEYS),
                }
                try:
                    write_json_atomic(path, payload)
                except OSError:
                    pass
            self._stop.wait(LISTENER_HEARTBEAT_SECONDS)

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as exc:  # noqa: BLE001 - a poll failure must not kill the loop
                self._log(f"Build queue poll failed: {exc}")
            self._stop.wait(POLL_SECONDS)

    def poll_once(self) -> int:
        """Service every queued request once; returns how many were handled."""

        directory = build_requests_directory(self.server_root)
        try:
            entries = sorted(directory.glob("*.json"))
        except OSError:
            return 0
        handled = 0
        for path in entries:
            if self._stop.is_set():
                break
            if self._service_request(path):
                handled += 1
        return handled

    # ---------------------------------------------------------------- servicing

    def _service_request(self, path: Path) -> bool:
        request_id = path.stem
        lease = acquire_engine_job_lease(
            build_lock_path(self.server_root, request_id),
            stale_seconds=BUILD_LEASE_STALE_SECONDS,
            payload_fields={"request_id": request_id, "listener": _machine_name()},
        )
        if lease is None:
            return False

        stop_event = thread = None
        log_path = build_log_path(self.server_root, request_id)
        created_at = ""
        components: list[dict[str, Any]] = []
        try:
            stop_event, thread = start_engine_job_lease_heartbeat(
                lease, interval_seconds=BUILD_LEASE_HEARTBEAT_SECONDS
            )
            request = self._read_request(path)
            components = [build_component_state(role) for role in request["Components"]]
            created_at = self._publish(
                request_id,
                "claimed",
                f"Claimed by {_machine_name()} for {request['UserName']}.",
                components,
                log_path,
                created_at,
            )
            self._append_log(
                log_path,
                f"=== {request_id} claimed by {_machine_name()} at {_now_text()} ===",
            )
            self._prepare_sources(request, log_path)
            created_at = self._run_components(request, components, log_path, created_at)
            failed = [item for item in components if item["state"] == "error"]
            if failed:
                message = "; ".join(
                    f"{item['role']}: {item['message'] or 'build failed'}" for item in failed
                )
                self._publish(request_id, "error", message, components, log_path, created_at)
            else:
                built = ", ".join(item["role"] for item in components)
                self._publish(
                    request_id,
                    "success",
                    f"Built and deployed: {built}.",
                    components,
                    log_path,
                    created_at,
                )
        except Exception as exc:  # noqa: BLE001 - every failure becomes a status
            self._append_log(log_path, f"ERROR: {exc}")
            try:
                self._publish(request_id, "error", str(exc), components, log_path, created_at)
            except Exception:  # noqa: BLE001 - the status write is best effort
                self._log(f"[{request_id}] could not publish the failure status.")
            self._log(f"[{request_id}] failed: {exc}")
        finally:
            if stop_event is not None and thread is not None:
                stop_engine_job_lease_heartbeat(
                    stop_event, thread, interval_seconds=BUILD_LEASE_HEARTBEAT_SECONDS
                )
            release_engine_job_lease(lease)
            # The request is consumed once serviced; its status and log stay for
            # the poller, so removing it here is what stops a redelivery loop.
            try:
                path.unlink()
            except OSError:
                pass
        return True

    def _read_request(self, path: Path) -> dict[str, Any]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise BuildListenerError(f"The build request could not be read: {exc}") from exc
        try:
            return validate_build_request(
                payload,
                known_roles=COMPONENT_KEYS,
                allowed_users=self.allowed_users,
            )
        except BuildRequestContractError as exc:
            raise BuildListenerError(str(exc)) from exc

    def _publish(
        self,
        request_id: str,
        status: str,
        message: str,
        components: Iterable[Mapping[str, Any]],
        log_path: Path,
        created_at: str,
    ) -> str:
        try:
            log_bytes = log_path.stat().st_size
        except OSError:
            log_bytes = 0
        payload = build_build_status(
            request_id=request_id,
            status=status,
            message=message,
            components=components,
            log_bytes=log_bytes,
            listener=f"{_machine_name()}@{_user_name()}",
            listener_commit=self.started_commit,
            created_at=created_at,
        )
        write_build_status(self.server_root, payload)
        return str(payload["created_at"])

    # ------------------------------------------------------------------ sources

    def _prepare_sources(self, request: Mapping[str, Any], log_path: Path) -> None:
        repository = self.repository_root
        if not (repository / ".git").exists():
            raise BuildListenerError(
                f"The listener's repository clone is not a git repository: {repository}"
            )
        self._append_log(log_path, f"--- syncing {repository} ---")
        fetch = _try_git_output(repository, "fetch", "--all", "--prune", "--quiet")
        if fetch:
            self._append_log(log_path, fetch)

        if request["SourceMode"] == SOURCE_MODE_REF:
            target = self._resolve_ref(request["Ref"])
        else:
            target = request["BaseCommit"]
            if not self._commit_exists(target):
                raise BuildListenerError(
                    f"Base commit {target} is not in the server clone. Push the branch "
                    "that contains it, then request the build again."
                )

        git_output(repository, "checkout", "--force", "--detach", target)
        git_output(repository, "reset", "--hard", target)
        git_output(repository, "clean", "-fd")
        self._append_log(log_path, f"checked out {target}")

        if request["SourceMode"] == SOURCE_MODE_WORKING_TREE:
            self._apply_payload(request, log_path)

    def _resolve_ref(self, ref: str) -> str:
        for candidate in (ref, f"origin/{ref}"):
            resolved = _try_git_output(self.repository_root, "rev-parse", "--verify", f"{candidate}^{{commit}}")
            if resolved:
                return resolved
        raise BuildListenerError(
            f"Ref {ref!r} could not be resolved in the server clone. Push it first."
        )

    def _commit_exists(self, commit: str) -> bool:
        return bool(
            _try_git_output(self.repository_root, "rev-parse", "--verify", f"{commit}^{{commit}}")
        )

    def _apply_payload(self, request: Mapping[str, Any], log_path: Path) -> None:
        payload_name = str(request.get("PayloadName") or "")
        if not payload_name:
            self._append_log(log_path, "no working-tree payload; building the base commit as-is")
            return
        archive_path = build_payload_path(self.server_root, request["RequestId"])
        if not archive_path.is_file():
            raise BuildListenerError(
                f"The working-tree payload for this request is missing: {archive_path}"
            )
        repository = self.repository_root
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            if PATCH_MEMBER_NAME in names:
                patch_text = archive.read(PATCH_MEMBER_NAME).decode("utf-8")
                if patch_text.strip():
                    self._apply_patch(patch_text, log_path)
            written = 0
            for name in sorted(names):
                if not name.startswith(UNTRACKED_PREFIX) or name.endswith("/"):
                    continue
                relative = name[len(UNTRACKED_PREFIX):]
                destination = (repository / relative).resolve()
                if repository.resolve() not in destination.parents:
                    raise BuildListenerError(
                        f"The payload tried to write outside the repository: {relative}"
                    )
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(name))
                written += 1
            if written:
                self._append_log(log_path, f"restored {written} untracked file(s)")

    def _apply_patch(self, patch_text: str, log_path: Path) -> None:
        # The patch goes to git as bytes: a text-mode pipe on Windows turns
        # every "\n" into "\r\n", and git then fails to match some hunks
        # against the LF files it just checked out.
        completed = subprocess.run(
            ["git", "apply", "--binary", "--whitespace=nowarn", "-"],
            cwd=str(self.repository_root),
            input=patch_text.encode("utf-8"),
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )
        if completed.returncode != 0:
            output = completed.stderr or completed.stdout or b""
            raise BuildListenerError(
                "The working-tree patch did not apply to the base commit: "
                f"{output.decode('utf-8', errors='replace').strip()}"
            )
        self._append_log(log_path, "applied the requester's working-tree changes")

    # ------------------------------------------------------------------- builds

    def _run_components(
        self,
        request: Mapping[str, Any],
        components: list[dict[str, Any]],
        log_path: Path,
        created_at: str,
    ) -> str:
        for entry in components:
            if self._stop.is_set():
                entry.update(state="skipped", message="The listener was stopped.")
                continue
            component = component_by_key(entry["role"])
            entry.update(state="building", message="")
            created_at = self._publish(
                request["RequestId"],
                "building",
                f"Building {component.label}...",
                components,
                log_path,
                created_at,
            )
            exit_code, detail = self._run_build_script(component, log_path)
            if exit_code == 0:
                entry.update(state="success", message="Built and deployed.", exit_code=0)
            else:
                entry.update(state="error", message=detail, exit_code=exit_code)
                # Later components would build from the same sources, but a
                # failure usually means the sources are broken; stopping keeps a
                # half-broken deploy from spreading across components.
                for pending in components:
                    if pending["state"] == "pending":
                        pending.update(state="skipped", message="An earlier component failed.")
                break
        return created_at

    def _run_build_script(self, component: Component, log_path: Path) -> tuple[int, str]:
        script = component.build_script
        if not script.exists():
            return 1, f"Missing build script: {script}"
        environment = os.environ.copy()
        environment.setdefault("ARCRHO_DEPLOY_ROOT", str(self.server_root))
        command = [self.python_executable, str(script)]
        self._append_log(log_path, f"--- {component.label}: {subprocess.list2cmdline(command)} ---")
        try:
            process = subprocess.Popen(
                command,
                cwd=str(component.source_dir),
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=CREATE_NO_WINDOW,
            )
        except OSError as exc:
            return 1, f"The build could not start: {exc}"

        self._current_build = process
        deadline = time.monotonic() + COMPONENT_BUILD_TIMEOUT_SECONDS
        last_line = ""
        try:
            assert process.stdout is not None
            for line in process.stdout:
                text = line.rstrip()
                if text:
                    last_line = text
                    self._append_log(log_path, f"[{component.label}] {text}")
                    self._log(f"[{component.label}] {text}")
                if time.monotonic() > deadline:
                    process.kill()
                    return 1, "The build exceeded its time limit and was stopped."
            exit_code = process.wait()
        finally:
            self._current_build = None
        if exit_code != 0:
            return exit_code, last_line or f"The build exited with code {exit_code}."
        return 0, ""

    def _append_log(self, log_path: Path, message: str) -> None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(f"{message}\n")
        except OSError:
            pass


def _default_python_executable() -> str:
    """The interpreter used for component builds; owned by ``build_runtime``."""

    return build_python_executable()
