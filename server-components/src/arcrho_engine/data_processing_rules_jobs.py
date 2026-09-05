"""Engine worker for ArcRho data-processing-rules save jobs.

The save itself is the canonical ``data_processing_rules_service`` save, run
here on the machine hosting the workspace so the sidecar walk that follows the
write reads local disk instead of crossing a Client PC's mapped drive. The job
is durable (its queue file is retained until a validated terminal status
exists) and runs under the project-scope propagation lease, which is what lets
several Engine instances claim one request exactly once and what tells every
other writer the project is busy for the few seconds the save takes.

The service reports its stages through a callback; this module records the
latest one and republishes it on the contract heartbeat cadence, so the
status file's write rate is bounded by the contract rather than by the number
of sidecars in the project. The terminal success status embeds the service's
full response, and a refusal keeps the HTTP status the direct route would
have answered with (409 stale revision, 400 invalid rules, 423 locked).
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from arcrho_data_processing_rules_job_contract import (
    DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS,
    DataProcessingRulesJobContractError,
    data_processing_rules_job_request_path,
    read_data_processing_rules_job_status,
    validate_data_processing_rules_job_request,
    validate_request_id,
    write_data_processing_rules_job_status,
)
from arcrho_dependent_propagation_contract import (
    acquire_project_scope_lease,
    release_project_scope_lease,
    start_project_scope_lease_heartbeat,
    stop_project_scope_lease_heartbeat,
)
from arcrho_engine_job_lease import engine_job_lease_is_owned

# Path redaction and the canonical-runtime bootstrap are owned by the sibling
# durable-job modules; this job reuses them rather than growing second copies.
from arcrho_engine.dependent_propagation import configure_canonical_runtime
from arcrho_engine.project_duplication import _redact_machine_paths
from arcrho_engine.runtime_log import append_runtime_log

DATA_PROCESSING_RULES_JOB_LOG_FILENAME = "data_processing_rules_jobs.log"

Progress = dict[str, Any]


def _log(server_root: Any, message: str, *, exc: BaseException | None = None) -> None:
    append_runtime_log(server_root, DATA_PROCESSING_RULES_JOB_LOG_FILENAME, message, exc=exc)


class DataProcessingRulesJobLeaseLost(RuntimeError):
    """Raised when the project-scope lease is no longer owned mid-job."""


class DataProcessingRulesJobRefused(RuntimeError):
    """The canonical save refused; carries the direct route's HTTP status."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = int(status_code)


def _progress(stage: str, completed: int, total: int, label: str) -> Progress:
    return {
        "stage": str(stage or "").strip() or "processing",
        "completed": max(0, int(completed)),
        "total": max(0, int(total), int(completed)),
        "label": str(label or "").strip() or "Saving data processing rules",
    }


def _safe_status_message(exc: BaseException) -> str:
    message = _redact_machine_paths(exc)
    return message or "The data processing rules save failed."


def execute_data_processing_rules_save(
    server_root: str | os.PathLike[str],
    request: Mapping[str, Any],
    *,
    progress_callback: Callable[[Progress], None] | None = None,
) -> dict[str, Any]:
    """Run one validated rules save and return the save route's response.

    A refusal the service raises is re-raised as
    :class:`DataProcessingRulesJobRefused` with the status code the direct
    route maps it to, so the terminal status can carry that code.
    """

    normalized = validate_data_processing_rules_job_request(request)
    root = Path(os.fspath(server_root)).expanduser().resolve(strict=False)
    configure_canonical_runtime(root)

    from app_server.services import (
        data_processing_rules_service,
        data_processing_values_service,
        user_identity_service,
    )

    def notify(stage: str, completed: int, total: int, label: str) -> None:
        if progress_callback is not None:
            progress_callback(_progress(stage, completed, total, label))

    _log(
        root,
        f"{normalized['RequestId']} start project={normalized['ProjectName']!r} "
        f"revision={normalized['ExpectedRevision']} rules={len(normalized['Rules'])}",
    )
    try:
        # The job writes the rules file and the audit entry: act as the user
        # who asked for the save so both name them and not this service.
        with user_identity_service.acting_identity(normalized["UserName"]):
            return data_processing_rules_service.save_data_processing_rules(
                normalized["ProjectName"],
                expected_revision=normalized["ExpectedRevision"],
                data={"rules": normalized["Rules"]},
                progress=notify,
            )
    except data_processing_rules_service.RulesRevisionConflictError as exc:
        raise DataProcessingRulesJobRefused(409, str(exc)) from exc
    except (
        data_processing_rules_service.RulesWriteLockedError,
        data_processing_values_service.DataProcessingValuesLockedError,
    ) as exc:
        raise DataProcessingRulesJobRefused(423, str(exc)) from exc
    except data_processing_rules_service.RulesValidationError as exc:
        raise DataProcessingRulesJobRefused(400, "; ".join(exc.errors) or str(exc)) from exc
    except PermissionError as exc:
        raise DataProcessingRulesJobRefused(
            423, "Data processing rules file is locked. Please retry."
        ) from exc
    except ValueError as exc:
        message = str(exc)
        code = 404 if "Project folder not found under projects:" in message else 400
        raise DataProcessingRulesJobRefused(code, message) from exc


def _require_lease(lease) -> None:
    if lease.heartbeat_failed.is_set() or not engine_job_lease_is_owned(lease):
        raise DataProcessingRulesJobLeaseLost(
            "Data processing rules job project ownership was lost."
        )


def _terminal_status_or_none(server_root: Path, request_id: str) -> dict[str, Any] | None:
    try:
        status = read_data_processing_rules_job_status(server_root, request_id)
    except (OSError, ValueError, TypeError, DataProcessingRulesJobContractError):
        return None
    if status is not None and status["status"] in {"success", "error"}:
        return status
    return None


def _remove_request_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"(data processing rules job queue cleanup error: {exc})")


def process_durable_data_processing_rules_request(
    server_root: str | os.PathLike[str],
    request_file: str | os.PathLike[str],
    request: Mapping[str, Any],
) -> bool:
    """Process one retained queue file under the project-scope lease."""

    root = Path(os.fspath(server_root)).expanduser().resolve(strict=False)
    request_path = Path(os.fspath(request_file))
    raw_request_id = request.get("RequestId") if isinstance(request, Mapping) else None
    try:
        request_id = validate_request_id(raw_request_id)
    except DataProcessingRulesJobContractError as exc:
        # A request without a safe id can never publish status; drop it so the
        # queue rescan does not reprocess it forever.
        print(f"(data processing rules job request error: {_safe_status_message(exc)})")
        _remove_request_file(request_path)
        return False

    expected_path = data_processing_rules_job_request_path(root, request_id)
    try:
        if request_path.resolve(strict=False) != expected_path.resolve(strict=False):
            print("(data processing rules job request filename does not match RequestId)")
            return False
    except OSError:
        return False

    terminal = _terminal_status_or_none(root, request_id)
    if terminal is not None:
        _remove_request_file(request_path)
        return terminal["status"] == "success"

    try:
        normalized = validate_data_processing_rules_job_request(request)
    except DataProcessingRulesJobContractError as exc:
        message = _safe_status_message(exc)
        try:
            write_data_processing_rules_job_status(
                root,
                request_id,
                "error",
                progress=_progress("rejected", 0, 0, "Data processing rules save rejected"),
                message=message,
                status_code=400,
            )
        except Exception as status_exc:
            print(
                "(error: could not publish rejected data processing rules job status: "
                f"{_redact_machine_paths(status_exc)})"
            )
            return False
        print(f"(data processing rules job request error: {message})")
        _remove_request_file(request_path)
        return False

    lease = acquire_project_scope_lease(root, normalized["ProjectName"])
    if lease is None:
        _log(root, f"{request_id} claim missed (project busy)")
        return False
    claimed_at = time.monotonic()
    heartbeat_stop, heartbeat_thread = start_project_scope_lease_heartbeat(lease)
    try:
        # One lock serializes every status write: job progress and the status
        # heartbeat below republish the same file, and a stale heartbeat write
        # must never land after a newer progress write.
        status_write_lock = threading.Lock()
        current_progress = _progress("starting", 0, 0, "Preparing the rules save")

        def publish(
            status: str,
            progress: Progress,
            *,
            message: str = "",
            status_code: int | None = None,
            result: Mapping[str, Any] | None = None,
        ) -> None:
            _require_lease(lease)
            with status_write_lock:
                write_data_processing_rules_job_status(
                    root,
                    request_id,
                    status,
                    progress=progress,
                    message=message,
                    status_code=status_code,
                    result=result,
                )

        def record_progress(progress: Progress) -> None:
            # The sidecar check reports once per file. A new stage is published
            # at once so the window follows the save; ticks within a stage are
            # left to the heartbeat, which bounds the status file's write rate
            # by the contract cadence instead of by the size of the project.
            nonlocal current_progress
            stage_changed = progress["stage"] != current_progress["stage"]
            current_progress = progress
            if stage_changed:
                publish("processing", progress)

        # Remote pollers treat a status whose updated_at stops moving as an
        # abandoned job, so republish the current progress on the contract
        # heartbeat cadence even while one slow stage is still running.
        heartbeat_stop_event = threading.Event()

        def status_heartbeat_loop() -> None:
            while not heartbeat_stop_event.wait(
                DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS
            ):
                try:
                    publish("processing", current_progress)
                except Exception:
                    # Lease loss or filesystem trouble ends the heartbeat; the
                    # job thread surfaces the same condition on its next write.
                    return

        status_heartbeat_thread = threading.Thread(
            target=status_heartbeat_loop,
            name=f"arcrho-data-processing-rules-status-{request_id[:8]}",
            daemon=True,
        )

        terminal_result: dict[str, Any] | None = None
        terminal_code: int | None = None
        try:
            publish("processing", current_progress)
            status_heartbeat_thread.start()
            try:
                terminal_result = execute_data_processing_rules_save(
                    root, normalized, progress_callback=record_progress
                )
            finally:
                heartbeat_stop_event.set()
                status_heartbeat_thread.join(
                    timeout=DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS * 2
                )
            terminal_state = "success"
            terminal_message = ""
            terminal_progress = _progress(
                "complete",
                current_progress["total"],
                current_progress["total"],
                "Data processing rules saved",
            )
        except DataProcessingRulesJobLeaseLost:
            _log(root, f"{request_id} project ownership was lost")
            return False
        except DataProcessingRulesJobRefused as exc:
            terminal_state = "error"
            terminal_message = _safe_status_message(exc)
            terminal_code = exc.status_code
            terminal_progress = current_progress
            _log(root, f"{request_id} refused {terminal_code}: {terminal_message}")
        except Exception as exc:
            terminal_state = "error"
            terminal_message = _safe_status_message(exc)
            terminal_code = 500
            terminal_progress = current_progress
            # The status message is redacted for the client; the log keeps the
            # real exception and its traceback.
            _log(root, f"{request_id} raised: {terminal_message}", exc=exc)

        _log(
            root,
            f"{request_id} {terminal_state} after {time.monotonic() - claimed_at:.2f}s"
            + (f": {terminal_message}" if terminal_message else ""),
        )
        try:
            publish(
                terminal_state,
                terminal_progress,
                message=terminal_message,
                status_code=terminal_code,
                result=terminal_result,
            )
        except Exception as status_exc:
            _log(
                root,
                "could not publish data processing rules job status: "
                f"{_redact_machine_paths(status_exc)}",
                exc=status_exc,
            )
            return False
        if _terminal_status_or_none(root, request_id) is not None:
            _remove_request_file(request_path)
        return terminal_state == "success"
    except DataProcessingRulesJobLeaseLost:
        return False
    finally:
        stop_project_scope_lease_heartbeat(heartbeat_stop, heartbeat_thread)
        release_project_scope_lease(lease)
