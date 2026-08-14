"""Engine-hosted save jobs.

A Client PC save pays ~0.4 s per file operation over the mapped drive, so the
app server ships the whole save here instead: this module claims the request
(delete-to-claim, like legacy calculations — saves are interactive, not
durable), takes the reserving-class lease so the save and its inline
dependent walk serialize with propagation jobs, runs the canonical
``app_server`` service save on local disk, and publishes the service's full
response through a result file the client returns as its own HTTP response.

Failures map faithfully: an ``HTTPException`` raised by the service (409
conflicts, 400 validation, 423 holds) reaches the client with its original
status code and detail; anything else becomes a redacted 500-style error.
"""

from __future__ import annotations

import importlib
import os
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from arcrho_dependent_propagation_contract import (
    acquire_reserving_class_lease,
    release_reserving_class_lease,
    start_reserving_class_lease_heartbeat,
    stop_reserving_class_lease_heartbeat,
)
from arcrho_engine_save_contract import (
    SAVE_JOB_KINDS,
    SaveJobContractError,
    prune_stale_save_job_artifacts,
    validate_save_job_request,
    write_save_job_result,
    write_save_job_status,
)

from arcrho_engine.dependent_propagation import configure_canonical_runtime
from arcrho_engine.general_utils import safe_remove
from arcrho_engine.project_duplication import _redact_machine_paths

# How long a claimed save waits for the reserving-class lease when a
# propagation walk is still running for the same class. Walks finish in
# seconds on local disk; a lease that stays busy longer than this is
# reported to the user as a busy class rather than held open-endedly.
SAVE_JOB_LEASE_WAIT_SECONDS = 30.0
SAVE_JOB_LEASE_POLL_SECONDS = 0.25

_last_prune_at = 0.0


def _log(root: Path, message: str) -> None:
    """Append one line to the hosted-save log on the server host.

    The frozen Engine runs windowless, so ``print`` output is invisible;
    this file is the only place a hosted save can explain a failure.
    """

    try:
        log_path = root / "runtime" / "logs" / "hosted_saves.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {message}\n")
    except Exception:
        pass


def _acquire_lease_with_wait(root: Path, project: str, reserving: str):
    deadline = time.monotonic() + SAVE_JOB_LEASE_WAIT_SECONDS
    while True:
        lease = acquire_reserving_class_lease(root, project, reserving)
        if lease is not None:
            return lease
        if time.monotonic() >= deadline:
            return None
        time.sleep(SAVE_JOB_LEASE_POLL_SECONDS)


def _prune_occasionally(root: Path) -> None:
    global _last_prune_at
    now = time.monotonic()
    if now - _last_prune_at < 600:
        return
    _last_prune_at = now
    try:
        prune_stale_save_job_artifacts(root)
    except Exception:
        pass


def process_hosted_save_request(
    server_root: str | os.PathLike[str],
    request_file: str | os.PathLike[str],
    request: Mapping[str, Any],
) -> bool:
    """Claim and execute one hosted save; return True on a successful save."""

    root = Path(os.fspath(server_root)).expanduser().resolve(strict=False)
    request_path = Path(os.fspath(request_file))

    try:
        normalized = validate_save_job_request(request)
    except SaveJobContractError as exc:
        # Without a validated id there may be no status channel; claim the
        # file so the queue cannot loop, and publish a rejection if possible.
        print(f"(hosted save request rejected: {exc})")
        try:
            safe_remove(request_path)
        except Exception:
            pass
        request_id = str(request.get("RequestId") or "").strip() if isinstance(request, Mapping) else ""
        if request_id:
            try:
                write_save_job_status(
                    root, request_id, "error", message=str(exc), status_code=400
                )
            except Exception:
                pass
        return False

    request_id = normalized["RequestId"]

    # Exactly one Engine claims the save; everyone else saw the same
    # filesystem event and backs off here.
    try:
        if not safe_remove(request_path):
            return False
    except Exception:
        return False

    _prune_occasionally(root)
    _log(root, f"claimed {request_id} kind={normalized['SaveKind']} class={normalized['Path']!r}")

    def publish(status: str, *, message: str = "", status_code: int | None = None) -> None:
        write_save_job_status(
            root, request_id, status, message=message, status_code=status_code
        )

    def publish_error(message: str, status_code: int) -> None:
        try:
            publish("error", message=message, status_code=status_code)
        except Exception as exc:
            _log(root, f"{request_id} terminal publish failed: {exc!r}")

    try:
        publish("processing")
    except Exception as exc:
        _log(root, f"{request_id} processing publish failed: {exc!r}")
        return False

    lease = _acquire_lease_with_wait(root, normalized["ProjectName"], normalized["Path"])
    if lease is None:
        _log(root, f"{request_id} reserving-class lease stayed busy")
        publish_error(
            "Dependent updates are currently running for this reserving "
            "class. Please wait for them to finish, then save again.",
            423,
        )
        return False
    heartbeat_stop, heartbeat_thread = start_reserving_class_lease_heartbeat(lease)

    try:
        configure_canonical_runtime(root)
        from fastapi import HTTPException

        from app_server.services import dependent_propagation_service

        module_name, function_name = SAVE_JOB_KINDS[normalized["SaveKind"]]
        module = importlib.import_module(f"app_server.services.{module_name}")
        save_function = getattr(module, function_name)
        _log(root, f"{request_id} executing {module_name}.{function_name}")

        try:
            # The hold probe would refuse this very save (the lease we hold is
            # the hold), and the walk runs inline on local disk instead of
            # enqueueing a second job.
            with (
                dependent_propagation_service.suspended_reserving_class_hold_check(),
                dependent_propagation_service.inline_engine_propagation(),
            ):
                response = save_function(
                    *normalized["Args"], **normalized["Kwargs"]
                )
        except HTTPException as exc:
            _log(root, f"{request_id} service refusal {exc.status_code}: {exc.detail}")
            try:
                detail = _redact_machine_paths(str(exc.detail))
            except Exception:
                detail = str(exc.detail)
            publish_error(detail, int(exc.status_code))
            return False

        if not isinstance(response, dict):
            response = {"ok": True, "response": response}
        write_save_job_result(root, request_id, response)
        publish("success")
        _log(root, f"{request_id} success")
        return True
    except Exception as exc:
        _log(root, f"{request_id} failed: {exc!r}\n{traceback.format_exc()}")
        try:
            message = _redact_machine_paths(exc) or "The hosted save failed."
        except Exception:
            message = "The hosted save failed."
        publish_error(message, 500)
        return False
    finally:
        stop_reserving_class_lease_heartbeat(heartbeat_stop, heartbeat_thread)
        release_reserving_class_lease(lease)
