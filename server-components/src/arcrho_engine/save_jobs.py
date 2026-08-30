"""Engine-hosted save jobs.

A Client PC save pays ~0.4 s per file operation over the mapped drive, so the
app server ships the whole save here instead: this module claims the request
(delete-to-claim, like legacy calculations — saves are interactive, not
durable), takes the reserving-class lease so the save and its inline
dependent walk serialize with propagation jobs, runs the canonical
``app_server`` service save on local disk, and publishes the service's full
response in the terminal status the client returns as its own HTTP response.
A separate result file remains temporarily for older clients during rollout.

A ``plan`` request is the first half of a two-step save: it reads the two
dependency graphs and answers with the objects the save could reach, so the
user confirms before anything is written. It runs no save and takes no
reserving-class lease, because the lease must never span the human pause —
holding it would block every other save in the class for as long as the
dialog stayed open. The plan's fingerprint comes back on the ``commit``, which
recomputes it *under* the lease and refuses with 409 when the class moved in
between.

The save runs as the user named in the request, not as the account this
instance was started under, so the ``user`` fields it writes name the person
who made the edit no matter which instance claimed the request.

Failures map faithfully: an ``HTTPException`` raised by the service (409
conflicts, 400 validation, 423 holds) reaches the client with its original
status code and detail; anything else becomes a redacted 500-style error.
"""

from __future__ import annotations

import importlib
import os
import time
import traceback
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from arcrho_dependent_propagation_contract import (
    acquire_reserving_class_lease,
    release_reserving_class_lease,
    start_reserving_class_lease_heartbeat,
    stop_reserving_class_lease_heartbeat,
)
from arcrho_engine_save_contract import (
    SAVE_JOB_KINDS,
    SAVE_JOB_MODE_PLAN,
    SAVE_PLAN_STALE_MESSAGE,
    SaveJobContractError,
    claim_save_job,
    prune_stale_save_job_artifacts,
    read_save_job_status,
    save_job_status_is_terminal,
    validate_save_job_request,
    write_save_job_result,
    write_save_job_status,
)

from arcrho_engine.dependent_propagation import configure_canonical_runtime
from arcrho_engine.general_utils import safe_remove
from arcrho_engine.project_duplication import _redact_machine_paths
from arcrho_engine.runtime_log import append_runtime_log

# How long a claimed save waits for the reserving-class lease when a
# propagation walk is still running for the same class. Walks finish in
# seconds on local disk; a lease that stays busy longer than this is
# reported to the user as a busy class rather than held open-endedly.
SAVE_JOB_LEASE_WAIT_SECONDS = 30.0
SAVE_JOB_LEASE_POLL_SECONDS = 0.25

# Floor between two live-progress status writes during the inline walk. The
# writes hit local disk, so this is generosity toward the walk, not the disk:
# a class with hundreds of dependents must not spend its time re-publishing.
SAVE_JOB_PROGRESS_MIN_INTERVAL_SECONDS = 0.2

_last_prune_at = 0.0


HOSTED_SAVE_LOG_FILENAME = "hosted_saves.log"


def _log(root: Path, message: str) -> None:
    """Append one line to the hosted-save log on the server host.

    The frozen Engine runs windowless, so ``print`` output is invisible;
    this file is the only place a hosted save can explain a failure.
    """

    append_runtime_log(root, HOSTED_SAVE_LOG_FILENAME, message)


# Where a save response carries the outcome of the walk that ran inside it.
# Method saves answer under ``propagation``; the dataset sidecar save answers
# under ``calculated_updates`` at the top of the service's own return value
# (the ``data`` wrapper only exists on the client's side of the HTTP call).
_INLINE_WALK_RESPONSE_PATHS = (
    ("propagation",),
    ("calculated_updates",),
    ("data", "calculated_updates"),
)
# Enough names to recognise the walk, short enough to keep one line readable.
_INLINE_WALK_LOG_NAME_LIMIT = 12


def _inline_walk_summary(response: Any) -> str:
    """Name what a hosted save's inline dependent walk touched.

    The walk runs inside the save (``inline_engine_propagation``), so it never
    reaches the durable queue and writes nothing to ``dependent_propagation.log``.
    Without this line a hosted save is recorded only as "success", and the
    objects it rewrote — which is what other users' open windows react to —
    leave no server-side record at all.

    Never raises: an unexpected payload shape yields an empty summary rather
    than failing the save it only describes.
    """

    payload: Any = None
    try:
        for path in _INLINE_WALK_RESPONSE_PATHS:
            candidate: Any = response
            for key in path:
                candidate = candidate.get(key) if isinstance(candidate, Mapping) else None
            if isinstance(candidate, Mapping):
                payload = candidate
                break
        if payload is None:
            return ""
        status = str(payload.get("status") or "").strip().lower()
        if status == "unchanged":
            return "walk skipped (publication unchanged)"
        # A str is iterable; taking it as a name list would log one character
        # per "dataset", so only a real sequence counts.
        raw_names = payload.get("refreshed_datasets")
        if not isinstance(raw_names, (list, tuple)):
            return ""
        names = [str(name).strip() for name in raw_names if str(name or "").strip()]
        listed = ", ".join(names[:_INLINE_WALK_LOG_NAME_LIMIT])
        if len(names) > _INLINE_WALK_LOG_NAME_LIMIT:
            listed += f", (+{len(names) - _INLINE_WALK_LOG_NAME_LIMIT} more)"
        refreshed = f"walk refreshed {len(names)}" + (f": {listed}" if listed else "")
        if payload.get("ok") is False:
            reason = _redact_machine_paths(str(payload.get("message") or "")) or "see status"
            return f"{refreshed}; walk FAILED: {reason}"
        return refreshed
    except Exception:
        return ""


def _walk_stage_timing(
    marks: Sequence[tuple[str, float]], started_at: float, finished_at: float
) -> str:
    """Render the inline walk's stage transitions as one line of durations.

    ``marks`` holds the first progress call of each stage in order, as
    ``(stage, monotonic)``. A stage lasts until the next stage's first call;
    the last one runs to ``finished_at``, so it also carries the save's
    return path. The time before the first mark is the save's own commit.

    The queued-walk diary times every stage transition, and that is what
    localizes a stall; without this line a slow hosted save reports one total
    and leaves nothing behind but file timestamps.
    """

    if not marks:
        return ""
    parts = [f"before walk {max(0.0, marks[0][1] - started_at):.1f}s"]
    for index, (stage, at) in enumerate(marks):
        end = marks[index + 1][1] if index + 1 < len(marks) else finished_at
        parts.append(f"{stage} {max(0.0, end - at):.1f}s")
    return "stages: " + ", ".join(parts)


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


def _process_plan_request(
    root: Path,
    request_id: str,
    normalized: Mapping[str, Any],
    publish,
    publish_error,
) -> bool:
    """Answer one plan request: which dependents can this save reach?

    Deliberately outside the reserving-class lease. The plan only reads, and
    a walk running concurrently can at worst make the plan stale — which the
    commit's fingerprint recheck catches under the lease. Waiting for the
    lease here would instead make every plan queue behind an unrelated walk
    for no gain.
    """

    try:
        configure_canonical_runtime(root)
        from fastapi import HTTPException

        from app_server.services import save_plan_service

        try:
            plan = save_plan_service.build_save_plan(
                normalized["SaveKind"],
                normalized["ProjectName"],
                normalized["Path"],
                normalized["Args"],
                normalized["Kwargs"],
            )
        except HTTPException as exc:
            _log(root, f"{request_id} plan refusal {exc.status_code}: {exc.detail}")
            try:
                detail = _redact_machine_paths(str(exc.detail))
            except Exception:
                detail = str(exc.detail)
            publish_error(detail, int(exc.status_code))
            return False

        write_save_job_result(root, request_id, plan)
        publish("success", response=plan)
        _log(root, f"{request_id} plan reached {plan.get('dependent_count')} dependent(s)")
        return True
    except Exception as exc:
        _log(root, f"{request_id} plan failed: {exc!r}\n{traceback.format_exc()}")
        try:
            message = _redact_machine_paths(exc) or "The dependent-update plan failed."
        except Exception:
            message = "The dependent-update plan failed."
        publish_error(message, 500)
        return False


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
    # filesystem event and backs off here. The exclusive-create marker is the
    # arbiter — delete-to-claim on the queue file once let two instances both
    # believe they had won, and the loser's 409 then overwrote the winner's
    # success status. The queue file is still removed afterwards (best effort)
    # so the rescan cycle stops re-offering it.
    try:
        if not claim_save_job(root, request_id):
            return False
    except Exception:
        return False
    try:
        safe_remove(request_path)
    except Exception:
        pass

    _prune_occasionally(root)
    _log(
        root,
        f"claimed {request_id} kind={normalized['SaveKind']} "
        f"mode={normalized['Mode']} class={normalized['Path']!r}",
    )

    def publish(
        status: str,
        *,
        message: str = "",
        status_code: int | None = None,
        response: Mapping[str, Any] | None = None,
        progress: Mapping[str, Any] | None = None,
    ) -> None:
        # A terminal status is written once and never demoted: should any
        # duplicate execution slip past the claim, neither its "processing"
        # announcement nor its late 409 may replace the outcome the client
        # is about to read.
        try:
            existing = read_save_job_status(root, request_id)
        except Exception:
            existing = None
        if save_job_status_is_terminal(existing):
            _log(
                root,
                f"{request_id} kept existing terminal status "
                f"{existing.get('status')!r}; dropped late {status!r}",
            )
            return
        write_save_job_status(
            root,
            request_id,
            status,
            message=message,
            status_code=status_code,
            response=response,
            progress=progress,
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

    if normalized["Mode"] == SAVE_JOB_MODE_PLAN:
        return _process_plan_request(root, request_id, normalized, publish, publish_error)

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
    started_at = time.monotonic()
    walk_stage_marks: list[tuple[str, float]] = []

    try:
        configure_canonical_runtime(root)
        from fastapi import HTTPException

        from app_server.services import dependent_propagation_service, user_identity_service

        module_name, function_name = SAVE_JOB_KINDS[normalized["SaveKind"]]
        module = importlib.import_module(f"app_server.services.{module_name}")
        save_function = getattr(module, function_name)

        # The user confirmed a specific list of dependent objects; re-derive it
        # here, where the lease guarantees nothing else can change the class
        # between this check and the write.
        if normalized["PlanFingerprint"]:
            from app_server.services import save_plan_service

            try:
                matches, current = save_plan_service.plan_fingerprint_matches(
                    normalized["SaveKind"],
                    normalized["ProjectName"],
                    normalized["Path"],
                    normalized["Args"],
                    normalized["Kwargs"],
                    normalized["PlanFingerprint"],
                )
            except HTTPException as exc:
                _log(root, f"{request_id} plan recheck refusal {exc.status_code}")
                publish_error(_redact_machine_paths(str(exc.detail)), int(exc.status_code))
                return False
            if not matches:
                _log(
                    root,
                    f"{request_id} reviewed plan is stale "
                    f"(reviewed={normalized['PlanFingerprint'][:12]} now={current[:12]})",
                )
                publish_error(SAVE_PLAN_STALE_MESSAGE, 409)
                return False

        _log(root, f"{request_id} executing {module_name}.{function_name}")

        last_progress_monotonic = [0.0]

        def publish_walk_progress(
            stage: str, completed: int, total: int, label: str
        ) -> None:
            """Publish one live walk step into the processing status.

            Throttled, and never allowed to fail the save it narrates. The
            client polls these over the Gateway to show which dependent is
            being refreshed while the save request is still in flight.

            Each stage's first call is also kept as a timing mark ahead of
            the throttle, so a short stage still marks where the next one
            began.
            """

            try:
                now = time.monotonic()
                stage_name = str(stage)
                if not walk_stage_marks or walk_stage_marks[-1][0] != stage_name:
                    walk_stage_marks.append((stage_name, now))
                if now - last_progress_monotonic[0] < SAVE_JOB_PROGRESS_MIN_INTERVAL_SECONDS:
                    return
                last_progress_monotonic[0] = now
                publish(
                    "processing",
                    progress={
                        "stage": str(stage),
                        "completed": int(completed),
                        "total": int(total),
                        "label": str(label),
                    },
                )
            except Exception:
                pass

        # Older canonical bundles predate the inline progress hook; the save
        # must run identically without it.
        inline_save_progress = getattr(
            dependent_propagation_service, "inline_save_progress", None
        )
        progress_scope = (
            inline_save_progress(publish_walk_progress)
            if callable(inline_save_progress)
            else nullcontext()
        )

        try:
            # This instance runs under its own service profile, so the save
            # acts as the user who submitted it — otherwise every sidecar and
            # index row would name whichever instance claimed the request. The
            # hold probe would refuse this very save (the lease we hold is the
            # hold), and the walk runs inline on local disk instead of
            # enqueueing a second job.
            with (
                user_identity_service.acting_identity(
                    normalized["UserName"], normalized["UserDisplayName"]
                ) as identity,
                dependent_propagation_service.suspended_reserving_class_hold_check(),
                dependent_propagation_service.inline_engine_propagation(),
                progress_scope,
            ):
                _log(root, f"{request_id} acting as {identity['display_name']!r}")
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

        returned_at = time.monotonic()
        if not isinstance(response, dict):
            response = {"ok": True, "response": response}
        # Keep the separate result during mixed-client rollout. Current
        # clients consume the same payload from the terminal status and avoid
        # one extra SMB read; older clients still read this legacy artifact.
        write_save_job_result(root, request_id, response)
        publish("success", response=response)
        published_at = time.monotonic()
        detail = "; ".join(
            part
            for part in (
                _inline_walk_summary(response),
                _walk_stage_timing(walk_stage_marks, started_at, returned_at),
                f"publish {published_at - returned_at:.1f}s",
            )
            if part
        )
        _log(root, f"{request_id} success in {published_at - started_at:.1f}s ({detail})")
        return True
    except Exception as exc:
        failed_at = time.monotonic()
        timing = _walk_stage_timing(walk_stage_marks, started_at, failed_at)
        _log(
            root,
            f"{request_id} failed after {failed_at - started_at:.1f}s: {exc!r}"
            + (f" ({timing})" if timing else "")
            + f"\n{traceback.format_exc()}",
        )
        try:
            message = _redact_machine_paths(exc) or "The hosted save failed."
        except Exception:
            message = "The hosted save failed."
        publish_error(message, 500)
        return False
    finally:
        stop_reserving_class_lease_heartbeat(heartbeat_stop, heartbeat_thread)
        release_reserving_class_lease(lease)
