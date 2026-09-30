# <arcrho-macro>
# Title: Review Reserving Class against ResQ
# Version: 1.1.0
# Release Note: Compare the Method Notes on every DFM as well, line by line, on their own sheet beside the datasets and Result Selections.
# Description: Lay the Arco values and the live ResQ values of the reserving class selected in the active Project Instance page side by side in one Excel workbook: every plain triangle and vector, every Result Selection with its Selected Ultimate, the Method Notes on every DFM, and a difference grid beside each pair. The Summary sheet links straight to whatever disagrees, and the workbook opens when the review finishes. Nothing is written back to Arco or ResQ.
# Scope: Reserving Class
# Icon: table
# </arcrho-macro>

"""Compare one reserving class with ResQ and open the workbook that shows it.

ResQ automation exists only where ResQ is installed, which is usually not the
machine Arco runs on. This macro therefore owns no ResQ session: it publishes
a logical request to the shared Arco Bridge queue and a ResQ-connected Bridge
worker runs the canonical review
(``python-api/migration/validation/combined_side_by_side_review.py``) on its
behalf, writing the workbook on the server where both sides are local disk.

Everything in this file is client-side: the context, the request, the wait,
and opening the finished workbook. The comparison rules and the workbook
layout live in the canonical review this macro never imports, so the two
cannot drift apart.

The review is served from the synchronization queue's folders, which is where
the Bridge contract puts it: inside the Arco app every poll is the hosted
Bridge-liveness read, and that read knows the import queue and the sync queue
and no others. The worker tells a review from a synchronization by the
request's ``Function``, and a status file is named by its request id, so
nothing collides.
"""

from __future__ import annotations

import getpass
import json
import os
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping

# The liveness rule is shared with the import and sync macros and the app
# server's hosted read; the worker constants come from there rather than being
# restated here.
from arcrho_api.bridge_liveness import (
    BRIDGE_SILENCE_LIMIT_SEC,
    BRIDGE_WORKER_DIR,
    BRIDGE_WORKER_MAX_AGE_SEC,
    QUEUE_STATUS_DIRS,
    BridgeSilenceTracker,
    await_bridge_signal,
    live_worker_names,
    observe_bridge_liveness,
)


TITLE = "Review Reserving Class against ResQ"
PROGRESS_ID = "review-reserving-class-against-resq"

REQUEST_FUNCTION = "ReviewResQReservingClass"
CONTRACT_VERSION = 1
# The queue folders are the synchronization queue's; see the module docstring
# and server-components/src/arcrho_bridge/resq_reserving_class_review_contract.json.
QUEUE_NAME = "sync"
STATUS_RELATIVE_DIR = QUEUE_STATUS_DIRS[QUEUE_NAME]
REQUEST_RELATIVE_DIR = STATUS_RELATIVE_DIR.with_name("requests")
REQUIRED_REQUEST_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Path",
    "UserName",
)
FORBIDDEN_PATH_FIELDS = ("StatusPath", "DataPath", "TargetPath", "ServerRoot")
STATUS_VALUES = frozenset({"processing", "success", "error"})

# A review only reads, but it reads every dataset, Result Selection and DFM of
# a reserving class out of ResQ one at a time, so it is given the same hour a
# queued import gets.
REVIEW_TIMEOUT_SEC = 60.0 * 60.0
POLL_INTERVAL_SEC = 1.0
REQUEST_CLAIM_TIMEOUT_SEC = 30.0

_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


class BridgeUnavailableError(RuntimeError):
    """Raised before publication when no ResQ-connected Bridge worker is live."""


class BridgeRequestError(RuntimeError):
    """Raised when a published Bridge request cannot complete successfully."""

    def __init__(self, message: str, *, status: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status or {}


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _logical_project_name(value: object) -> str:
    name = str(value or "").strip()
    if (
        not name
        or name in {".", ".."}
        or any(character in name for character in _INVALID_PROJECT_NAME_CHARS)
    ):
        raise ValueError("Project name must be a single logical project identifier.")
    return name


def _logical_rc_path(value: object) -> str:
    normalized = str(value or "").strip().replace("/", "\\")
    segments = [part.strip() for part in normalized.split("\\")]
    if (
        not normalized
        or normalized.startswith("\\")
        or ":" in normalized
        or "\x00" in normalized
        or any(part in {"", ".", ".."} for part in segments)
    ):
        raise ValueError("Reserving-class path must be a relative logical Arco path.")
    return normalized


def _user_name() -> str:
    try:
        return str(getpass.getuser() or "unknown").strip() or "unknown"
    except Exception:
        return "unknown"


def _request_paths(server_root: object, request_id: str) -> tuple[Path, Path]:
    root = Path(server_root)
    return (
        root / REQUEST_RELATIVE_DIR / f"{request_id}.json",
        root / STATUS_RELATIVE_DIR / f"{request_id}.json",
    )


def create_review_request(
    *,
    project_name: object,
    rc_path: object,
    request_id: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build the location-independent payload consumed by Arco Bridge."""

    identifier = str(request_id or uuid.uuid4().hex).strip()
    if not identifier:
        raise ValueError("Request ID is required.")
    return identifier, {
        "Function": REQUEST_FUNCTION,
        "ContractVersion": CONTRACT_VERSION,
        "RequestId": identifier,
        "ProjectName": _logical_project_name(project_name),
        "Path": _logical_rc_path(rc_path),
        "UserName": _user_name(),
    }


def publish_review_request(
    *,
    server_root: object,
    request_id: str,
    payload: dict[str, Any],
) -> Path:
    """Atomically publish a Bridge request after the hard availability preflight."""

    request_path, _ = _request_paths(server_root, request_id)
    temp_path = request_path.with_name(f".{request_id}.tmp")
    try:
        request_path.parent.mkdir(parents=True, exist_ok=True)
        with temp_path.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
        os.replace(temp_path, request_path)
    except Exception as exc:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise BridgeRequestError(
            f"Could not publish Arco Bridge request [{request_id}]: {exc}"
        ) from exc
    return request_path


def _observe(server_root: object, request_id: str = "") -> dict[str, Any] | None:
    """One liveness look; a look that fails is a silent look, not a verdict."""

    try:
        return observe_bridge_liveness(server_root, queue=QUEUE_NAME, request_id=request_id)
    except Exception:
        return None


def _request_status(observation: object) -> dict[str, Any] | None:
    request = observation.get("request") if isinstance(observation, dict) else None
    status = request.get("status") if isinstance(request, dict) else None
    return status if isinstance(status, dict) else None


def require_live_bridge_workers(server_root: object, *, sleep=time.sleep) -> tuple[str, ...]:
    """Names of the live workers, after waiting out a silence shorter than the limit."""

    observation, tracker = await_bridge_signal(
        lambda: _observe(server_root),
        limit_sec=BRIDGE_SILENCE_LIMIT_SEC,
        poll_interval_sec=POLL_INTERVAL_SEC,
        sleep=sleep,
    )
    workers = live_worker_names(observation)
    if workers:
        return workers
    raise BridgeUnavailableError(
        "No active Arco Bridge worker was found, so ResQ cannot be reached from "
        "this computer. Start Arco on a machine where ResQ is running, then try "
        f"again.\n{tracker.describe()}. "
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{Path(server_root) / BRIDGE_WORKER_DIR}]."
    )


def _progress_tone(status: object) -> str:
    normalized = str(status or "").strip().casefold()
    if normalized in {"error", "failed", "fail"}:
        return "error"
    if normalized in {"warning", "warn", "skipped"}:
        return "warning"
    if normalized in {"success", "complete", "completed"}:
        return "success"
    return ""


def _update_progress_from_status(progress, status: Mapping[str, Any]) -> None:
    if progress is None:
        return
    payload = status.get("progress")
    detail = payload if isinstance(payload, Mapping) else {}
    state = str(status.get("status") or "").strip().casefold()
    label = str(detail.get("label") or detail.get("message") or status.get("message") or "").strip()
    if not label:
        label = "Arco Bridge is comparing this reserving class with ResQ"
    try:
        progress.update(
            label=label,
            detail=label,
            total=_safe_int(detail.get("total"), getattr(progress, "total", 0)),
            completed=_safe_int(detail.get("completed"), getattr(progress, "completed", 0)),
            tone=_progress_tone(detail.get("status") or state),
        )
    except Exception:
        pass


def wait_for_review_result(
    *,
    server_root: object,
    request_id: str,
    timeout_sec: float = REVIEW_TIMEOUT_SEC,
    poll_interval_sec: float = POLL_INTERVAL_SEC,
    claim_timeout_sec: float = REQUEST_CLAIM_TIMEOUT_SEC,
    progress=None,
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Poll the request's status until a terminal result arrives.

    Every poll is one liveness look that also carries the status file, so the
    worker is judged from the same observation the result comes from. Silence
    past the limit abandons the wait; it does not prove the review stopped.
    """

    if timeout_sec <= 0 or poll_interval_sec <= 0 or claim_timeout_sec <= 0:
        raise ValueError("Timeout, polling interval, and claim timeout must be positive.")
    _, status_path = _request_paths(server_root, request_id)
    deadline = time.monotonic() + float(timeout_sec)
    claim_deadline = time.monotonic() + min(float(claim_timeout_sec), float(timeout_sec))
    tracker = BridgeSilenceTracker(limit_sec=BRIDGE_SILENCE_LIMIT_SEC)

    while True:
        if on_poll is not None:
            on_poll()
        observation = _observe(server_root, request_id)
        status = _request_status(observation)
        if status is not None:
            reported_id = str(status.get("request_id") or status.get("RequestId") or "").strip()
            if reported_id != request_id:
                raise BridgeRequestError(
                    "Arco Bridge returned a status for a different or missing request ID at "
                    f"[{status_path}]."
                )
            state = str(status.get("status") or "").strip().casefold()
            version = status.get("contract_version")
            # A failure is a message and nothing else, so it is reported
            # whatever stamped it: a Bridge that closed this request out as
            # part of the shared queue writes that queue's version.
            if state != "error" and (isinstance(version, bool) or version != CONTRACT_VERSION):
                raise BridgeRequestError(
                    f"Arco Bridge returned unsupported status contract version [{version!r}]."
                )
            _update_progress_from_status(progress, status)
            if state == "success":
                return status
            if state == "error":
                detail = str(status.get("message") or "unknown Arco Bridge error").strip()
                raise BridgeRequestError(
                    f"Arco Bridge request [{request_id}] failed: {detail}",
                    status=status,
                )
            if state and state not in STATUS_VALUES:
                raise BridgeRequestError(
                    f"Arco Bridge request [{request_id}] returned unsupported status [{state}]."
                )
        elif time.monotonic() >= claim_deadline:
            raise BridgeRequestError(
                f"Arco Bridge did not claim request [{request_id}] within "
                f"{claim_timeout_sec:g} seconds. A Bridge older than this macro does not "
                "know how to review a reserving class; restart a current Arco Bridge worker "
                "and try again."
            )

        if not tracker.record(observation) and tracker.exceeded:
            raise BridgeUnavailableError(
                f"Arco Bridge request [{request_id}] was abandoned: {tracker.describe()}. "
                "Whether the review finished is unknown; if the Bridge was only slow it may "
                f"still complete. Check [{status_path}] before reviewing this reserving class "
                "again."
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(float(poll_interval_sec), remaining))

    raise BridgeRequestError(
        f"Arco Bridge request [{request_id}] timed out after {timeout_sec:g} seconds. "
        "Nothing was changed in Arco or ResQ."
    )


def run_review(
    *,
    server_root: object,
    project_name: str,
    rc_path: str,
    progress=None,
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Publish one review and return what the Bridge reported.

    The caller runs the hard availability preflight first, so a computer that
    cannot reach ResQ at all is turned away before anything is published and
    before a progress bar is opened on a run that cannot start.
    """

    request_id, payload = create_review_request(project_name=project_name, rc_path=rc_path)
    publish_review_request(server_root=server_root, request_id=request_id, payload=payload)
    status = wait_for_review_result(
        server_root=server_root,
        request_id=request_id,
        progress=progress,
        on_poll=on_poll,
    )
    result = status.get("result")
    if not isinstance(result, Mapping):
        raise BridgeRequestError(
            f"Arco Bridge reported success for [{request_id}] without a result payload.",
            status=dict(status),
        )
    return dict(result)


def workbook_path(server_root: object, result: Mapping[str, Any]) -> Path:
    """Where this computer reaches the workbook the Bridge just wrote.

    The Bridge names the file under the server root rather than by its own
    absolute path, so a Client PC that reaches the workspace through a mapped
    drive and one that reaches it by its UNC name both find the same file.
    """

    relative = str(result.get("workbook_relative_path") or "").strip()
    if not relative:
        raise BridgeRequestError("Arco Bridge did not report where it wrote the review workbook.")
    return Path(server_root) / relative


def review_summary(result: Mapping[str, Any], rc_path: str) -> str:
    """What the run found, short enough to read before opening the workbook."""

    lines = [
        f"{rc_path}",
        "",
        f"Datasets: {_safe_int(result.get('datasets_compared'))} compared, "
        f"{_safe_int(result.get('datasets_needing_review'))} need review.",
        f"Result Selections: {_safe_int(result.get('result_selections_compared'))} compared, "
        f"{_safe_int(result.get('result_selections_needing_review'))} need review.",
        f"DFM notes: {_safe_int(result.get('dfm_notes_compared'))} compared, "
        f"{_safe_int(result.get('dfm_notes_needing_review'))} need review.",
    ]
    skipped = (
        _safe_int(result.get("skipped_datasets"))
        + _safe_int(result.get("skipped_result_selections"))
        + _safe_int(result.get("skipped_dfm_notes"))
    )
    if skipped:
        lines.append(f"{skipped} item(s) were left out of the review by name.")
    errors = [entry for entry in result.get("reserving_class_errors") or [] if isinstance(entry, Mapping)]
    for entry in errors[:5]:
        lines.append(f"ResQ refused: {entry.get('note')}")
    return "\n".join(lines)


def _report_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    reporter = globals().get("report_macro_activity")
    if callable(reporter):
        reporter()


def _message(ui, text: object, *, title: str = TITLE, kind: str = "info", auto_close_ms=None):
    return ui.message_box(
        str(text or ""),
        title=title,
        kind=kind,
        auto_close_ms=auto_close_ms,
        timeout_sec=600,
    )


def _context_value(context: object, *names: str) -> str:
    if not isinstance(context, Mapping):
        return ""
    for name in names:
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _has_review_context(context: object) -> bool:
    return bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    progress_holder = {"value": None}

    def close_progress():
        progress = progress_holder.get("value")
        progress_holder["value"] = None
        if progress is not None:
            try:
                progress.close()
            except Exception:
                pass

    try:
        context = (
            active_context
            if _has_review_context(active_context)
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = _context_value(context, "projectName", "project_name")
        rc_path = _context_value(context, "selectedPath", "selected_path", "path")
        if not project_name or not rc_path:
            raise ValueError(
                "The active Project Instance page does not expose a project and "
                "reserving-class path."
            )

        root = get_server_root(required=True)
        require_live_bridge_workers(root)
        progress_holder["value"] = ui.progress_bar(
            progress_id=PROGRESS_ID,
            title=TITLE,
            label=f"Comparing Arco and ResQ: {rc_path}",
            total=0,
        )
        result = run_review(
            server_root=root,
            project_name=project_name,
            rc_path=rc_path,
            progress=progress_holder.get("value"),
            on_poll=_report_activity,
        )
        close_progress()

        path = workbook_path(root, result)
        summary = review_summary(result, rc_path)
        opened = True
        try:
            os.startfile(path)  # noqa: S606 - opening the report the Bridge just wrote, for the person who asked for it
        except Exception as exc:
            opened = False
            summary = f"{summary}\n\nThe workbook could not be opened here: {exc}\n{path}"
        _message(
            ui,
            summary,
            kind="warning" if result.get("needs_attention") else "info",
            auto_close_ms=6000 if opened and not result.get("needs_attention") else None,
        )
        result["message"] = summary
        result["workbook_opened"] = opened
        result["status"] = "completed"
        return result
    except BridgeUnavailableError as exc:
        # Nothing was published, so this is a precondition, not a failure to
        # report as a crash with a traceback the user cannot act on.
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.update(label="ResQ is not reachable", detail=str(exc), tone="error")
            except Exception:
                pass
        _message(ui, str(exc), kind="warning")
        return {"status": "unavailable", "error": str(exc), "message": str(exc)}
    except Exception as exc:
        tb = traceback.format_exc()
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.update(label="Review failed", detail=str(exc), tone="error")
            except Exception:
                pass
        message = f"Reserving-class review failed:\n{exc}\n\n{tb}"
        _message(ui, message, kind="error")
        return {"status": "error", "error": str(exc), "traceback": tb, "message": message}
    finally:
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.close(auto_close_ms=1500)
            except Exception:
                pass
