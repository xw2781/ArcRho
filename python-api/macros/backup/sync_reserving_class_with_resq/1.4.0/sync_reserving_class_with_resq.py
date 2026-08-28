# <arcrho-macro>
# Title: Sync Reserving Class with ResQ
# Version: 1.4.0
# Release Note: Push the whole reserving class one way, chosen from each side's latest timestamp; rows whose own timestamps disagree are marked for review without blocking the sync, and the Proposed Action column is gone.
# Description: Compare every dataset and supported method output in the selected reserving class, push the whole class from whichever side changed last, and mark rows whose own timestamps disagree with that direction for review.
# Scope: Reserving Class
# </arcrho-macro>

"""Review and push one reserving class's ArcRho/ResQ differences one way.

ResQ automation exists only where ResQ is installed, which is usually not the
machine ArcRho runs on. This macro therefore owns no ResQ session at all: it
publishes logical requests to the shared Bridge queue and a ResQ-connected
Bridge worker runs the canonical synchronization session
(``resq_migration.sync_session``) on its behalf.

The session is split into the two phases the review table needs:

1. ``preview`` compares both sides and returns the review rows, each carrying
   the signature of the observation it was drawn from.
2. ``apply`` receives the accepted rows *with those signatures* and writes only
   when every one of them still matches a freshly observed plan, so nothing is
   written over a change made while the review table was open.

Everything in this file is client-side: context, the review table, progress,
and the results table. The comparison and write rules live in the canonical
session this macro never imports.
"""

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import time
import traceback
import uuid
from typing import Any, Callable, Mapping

from arcrho_api.bridge_liveness import (  # noqa: F401
    BRIDGE_SILENCE_LIMIT_SEC,
    BRIDGE_WORKER_DIR,
    BRIDGE_WORKER_MAX_AGE_SEC,
    BRIDGE_WORKER_ROLE,
    QUEUE_STATUS_DIRS,
    await_bridge_signal,
    live_worker_names,
    observe_bridge_liveness,
)


TITLE = "Sync Reserving Class with ResQ"
MACRO_VERSION = "1.4.0"
PROGRESS_ID = "sync-reserving-class-with-resq"
REVIEW_POLL_SECONDS = 0.5

# Pinned to server-components/src/arcrho_bridge/resq_reserving_class_sync_contract.json
# and, for the shared worker/status facts that contract deliberately does not
# restate, to resq_reserving_class_import_contract.json. A macro cannot import
# the Bridge, so a test asserts this adapter still matches both files. The
# worker facts and the liveness rule come from arcrho_api.bridge_liveness,
# which the import macros and the app server's hosted read share.
REQUEST_FUNCTION = "SyncResQReservingClass"
# Version 2: the preview carries the reserving class's one direction and every
# row's action follows it, so a Bridge still on version 1 must refuse rather
# than answer with per-row directions this macro would apply.
CONTRACT_VERSION = 2
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
    "Phase",
)
ALLOWED_PHASES = frozenset({"preview", "apply"})
SELECTION_FIELD = "SelectedRows"
SELECTION_ROW_FIELDS = ("Id", "Signature")
FORBIDDEN_PATH_FIELDS = ("StatusPath", "DataPath", "TargetPath", "ServerRoot")
STATUS_VALUES = frozenset({"processing", "success", "error"})

# A preview only reads; an apply can rewrite a whole reserving class, so it is
# given the same hour a queued ResQ import gets.
PREVIEW_TIMEOUT_SEC = 30.0 * 60.0
APPLY_TIMEOUT_SEC = 60.0 * 60.0
POLL_INTERVAL_SEC = 1.0
REQUEST_CLAIM_TIMEOUT_SEC = 30.0

KIND_DATASET = "Dataset"
_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


class BridgeUnavailableError(RuntimeError):
    """Raised before publication when no ResQ-connected Bridge worker is live."""


class BridgeRequestError(RuntimeError):
    """Raised when a published Bridge request cannot complete successfully."""

    def __init__(self, message: str, *, status: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status or {}


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


def _has_sync_context(context: object) -> bool:
    return bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


def _report_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    reporter = globals().get("report_macro_activity")
    if callable(reporter):
        reporter()


def _result_payload(result: object) -> dict[str, Any]:
    if isinstance(result, Mapping):
        payload = result.get("result")
        return dict(payload) if isinstance(payload, Mapping) else dict(result)
    payload = getattr(result, "result", None)
    return dict(payload) if isinstance(payload, Mapping) else {}


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (FileNotFoundError, PermissionError, OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


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
        raise ValueError("Reserving-class path must be a relative logical ArcRho path.")
    return normalized


def _user_name() -> str:
    try:
        return str(getpass.getuser() or "unknown").strip() or "unknown"
    except Exception:
        return "unknown"


def _observe(server_root: object) -> dict[str, Any] | None:
    """One liveness look; a look that fails is a silent look, not a verdict."""

    try:
        return observe_bridge_liveness(server_root, queue=QUEUE_NAME)
    except Exception:
        return None


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
        "No active ArcRho Bridge worker was found, so ResQ cannot be reached from "
        "this computer. Start ArcRho on a machine where ResQ is running, then "
        f"synchronize again.\n{tracker.describe()}. "
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{Path(server_root) / BRIDGE_WORKER_DIR}]."
    )


def _request_paths(server_root: object, request_id: str) -> tuple[Path, Path]:
    root = Path(server_root)
    return (
        root / REQUEST_RELATIVE_DIR / f"{request_id}.json",
        root / STATUS_RELATIVE_DIR / f"{request_id}.json",
    )


def create_sync_request(
    *,
    project_name: object,
    rc_path: object,
    phase: str,
    selected_rows: list[Mapping[str, Any]] | None = None,
    request_id: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build the location-independent payload consumed by ArcRho Bridge."""

    identifier = str(request_id or uuid.uuid4().hex).strip()
    if not identifier:
        raise ValueError("Request ID is required.")
    normalized_phase = str(phase or "").strip().casefold()
    if normalized_phase not in ALLOWED_PHASES:
        raise ValueError("Phase must be one of: " + ", ".join(sorted(ALLOWED_PHASES)) + ".")
    payload: dict[str, Any] = {
        "Function": REQUEST_FUNCTION,
        "ContractVersion": CONTRACT_VERSION,
        "RequestId": identifier,
        "ProjectName": _logical_project_name(project_name),
        "Path": _logical_rc_path(rc_path),
        "UserName": _user_name(),
        "Phase": normalized_phase,
    }
    if normalized_phase == "apply":
        payload[SELECTION_FIELD] = _selection_payload(selected_rows)
    elif selected_rows:
        raise ValueError("A preview request must not carry a selection.")
    return identifier, payload


def _selection_payload(selected_rows: list[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Echo the reviewed rows back exactly as the preview reported them.

    The signature is the Bridge's own observation, not something this macro
    recomputes; sending it back unchanged is what lets the apply phase prove
    nothing moved while the review table was open.
    """

    rows: list[dict[str, Any]] = []
    for row in selected_rows or []:
        if not isinstance(row, Mapping):
            continue
        row_id = str(row.get("id") or "").strip()
        signature = row.get("signature")
        if not row_id or not isinstance(signature, Mapping):
            raise ValueError(
                "The ArcRho Bridge preview did not report a signature for every selected "
                "row. Compare the reserving class again."
            )
        rows.append({"Id": row_id, "Signature": dict(signature), "Name": str(row.get("name") or "")})
    if not rows:
        raise ValueError("At least one reviewed row is required to apply a synchronization.")
    return rows


def publish_sync_request(
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
            f"Could not publish ArcRho Bridge request [{request_id}]: {exc}"
        ) from exc
    return request_path


def _progress_tone(status: object) -> str:
    normalized = str(status or "").strip().casefold()
    if normalized in {"error", "failed", "fail"}:
        return "error"
    if normalized in {"warning", "warn", "skipped"}:
        return "warning"
    if normalized in {"success", "complete", "completed"}:
        return "success"
    return ""


def _update_progress_from_status(progress, status: Mapping[str, Any], fallback_label: str) -> None:
    if progress is None:
        return
    progress_payload = status.get("progress")
    detail = progress_payload if isinstance(progress_payload, Mapping) else {}
    state = str(status.get("status") or "").strip().casefold()
    label = str(detail.get("message") or detail.get("label") or status.get("message") or "").strip()
    if not label:
        label = fallback_label
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


def wait_for_sync_result(
    *,
    server_root: object,
    request_id: str,
    timeout_sec: float,
    poll_interval_sec: float = POLL_INTERVAL_SEC,
    claim_timeout_sec: float = REQUEST_CLAIM_TIMEOUT_SEC,
    progress=None,
    progress_label: str = "ArcRho Bridge is working with ResQ",
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Poll the deterministic Bridge status file until a terminal result arrives."""

    if timeout_sec <= 0 or poll_interval_sec <= 0 or claim_timeout_sec <= 0:
        raise ValueError("Timeout, polling interval, and claim timeout must be positive.")
    request_path, status_path = _request_paths(server_root, request_id)
    deadline = time.monotonic() + float(timeout_sec)
    claim_deadline = time.monotonic() + min(float(claim_timeout_sec), float(timeout_sec))

    while True:
        if on_poll is not None:
            on_poll()
        status = _read_json(status_path)
        if status is not None:
            reported_id = str(status.get("request_id") or status.get("RequestId") or "").strip()
            if reported_id != request_id:
                raise BridgeRequestError(
                    "ArcRho Bridge returned a status for a different or missing request ID at "
                    f"[{status_path}]."
                )
            version = status.get("contract_version")
            if isinstance(version, bool) or version != CONTRACT_VERSION:
                raise BridgeRequestError(
                    f"ArcRho Bridge returned unsupported status contract version [{version!r}]."
                )
            _update_progress_from_status(progress, status, progress_label)
            state = str(status.get("status") or "").strip().casefold()
            if state == "success":
                return status
            if state == "error":
                detail = str(status.get("message") or "unknown ArcRho Bridge error").strip()
                raise BridgeRequestError(
                    f"ArcRho Bridge request [{request_id}] failed: {detail}",
                    status=status,
                )
            if state and state not in STATUS_VALUES:
                raise BridgeRequestError(
                    f"ArcRho Bridge request [{request_id}] returned unsupported status [{state}]."
                )
        elif time.monotonic() > claim_deadline and request_path.exists():
            raise BridgeRequestError(
                f"No ArcRho Bridge worker claimed request [{request_id}] within "
                f"{claim_timeout_sec:g} seconds. Confirm ResQ is running on a machine with "
                "ArcRho open."
            )
        if time.monotonic() > deadline:
            raise BridgeRequestError(
                f"ArcRho Bridge request [{request_id}] did not finish within "
                f"{timeout_sec:g} seconds."
            )
        time.sleep(poll_interval_sec)


def run_bridge_phase(
    *,
    server_root: object,
    project_name: str,
    rc_path: str,
    phase: str,
    selected_rows: list[Mapping[str, Any]] | None = None,
    timeout_sec: float,
    progress=None,
    progress_label: str,
) -> dict[str, Any]:
    """Publish one synchronization phase and return the Bridge's result payload."""

    require_live_bridge_workers(server_root)
    request_id, payload = create_sync_request(
        project_name=project_name,
        rc_path=rc_path,
        phase=phase,
        selected_rows=selected_rows,
    )
    publish_sync_request(server_root=server_root, request_id=request_id, payload=payload)
    status = wait_for_sync_result(
        server_root=server_root,
        request_id=request_id,
        timeout_sec=timeout_sec,
        progress=progress,
        progress_label=progress_label,
        on_poll=_report_activity,
    )
    result = status.get("result")
    if not isinstance(result, Mapping):
        raise BridgeRequestError(
            f"ArcRho Bridge reported success for [{request_id}] without a result payload.",
            status=dict(status),
        )
    return dict(result)


def _direction_sides(action: object) -> tuple[str, str]:
    """The source and target names of the reserving class's direction, or blanks."""

    normalized = str(action or "")
    if normalized == "arcrho_to_resq":
        return "ArcRho", "ResQ"
    if normalized == "resq_to_arcrho":
        return "ResQ", "ArcRho"
    return "", ""


def _row_tone(row: Mapping[str, Any]) -> str:
    status = str(row.get("status") or "").casefold()
    if row.get("review") or "mismatch" in status or "ambiguous" in status:
        return "warn"
    if "unsupported" in status or "unknown" in status:
        return "muted"
    if row.get("action"):
        return "info"
    if "synchronized" in status or "same timestamp" in status:
        return "ok"
    return "muted"


def review_table_payload(
    preview: list[Mapping[str, Any]],
    project_name: str,
    rc_path: str,
    connection_name: str,
    direction: Mapping[str, Any],
) -> dict[str, Any]:
    """Project the Bridge's preview rows into the reusable review-table contract.

    ``direction`` is the Bridge's reserving-class verdict: the way every row is
    pushed and the two latest timestamps that decided it. A row marked for
    review is one whose own timestamps point the other way; it is shown with
    a warning and stays ticked, because the review is a caution, not a block.
    """

    rows = []
    for row in preview:
        tone = _row_tone(row)
        rows.append({
            "id": str(row.get("id") or ""),
            "selected": bool(row.get("selected")),
            "disabled": bool(row.get("disabled")),
            "cells": {
                "kind": str(row.get("kind") or KIND_DATASET),
                "name": str(row.get("name") or ""),
                "arcrho_timestamp": str(row.get("arcrho_timestamp") or ""),
                "resq_timestamp": str(row.get("resq_timestamp") or ""),
                "status": {"text": str(row.get("status") or ""), "tone": tone},
                "review": {"text": "Review" if row.get("review") else "", "tone": "warn"},
                "detail": str(row.get("detail") or ""),
            },
        })
    actionable = sum(not bool(row.get("disabled")) for row in preview)
    selected = sum(bool(row.get("selected")) and not bool(row.get("disabled")) for row in preview)
    review = sum(bool(row.get("review")) for row in preview)
    source, target = _direction_sides(direction.get("action"))
    direction_text = f"{source} to {target}" if source else "none, neither side is newer"
    return {
        "title": TITLE,
        # Ask the shell to host the review inside the active Project Instance
        # page as a nested window (minimizable to the toolbar). Shells without
        # an active Project Instance page fall back to the modal dialog.
        "host": "projectInstance",
        "summary": (
            f"Project: {project_name} | Reserving class: {rc_path} | ResQ: {connection_name}\n"
            f"Latest ArcRho change: {direction.get('arcrho_timestamp') or 'Unknown'} | "
            f"Latest ResQ change: {direction.get('resq_timestamp') or 'Unknown'} | "
            f"Direction: {direction_text}\n"
            f"Compared {len(preview)} logical dataset/method output(s). "
            f"{actionable} can be pushed; {selected} are selected; {review} marked for review."
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "arcrho_timestamp", "label": "ArcRho Timestamp", "width": 220},
            {"key": "resq_timestamp", "label": "ResQ Timestamp", "width": 220},
            {"key": "status", "label": "Status", "width": 190},
            {"key": "review", "label": "Review", "width": 90},
            {"key": "detail", "label": "Details", "width": 360},
        ],
        "rows": rows,
        "acceptLabel": f"Sync to {target}" if target else "Apply Selected",
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter datasets and methods",
        "emptyMessage": "No dataset or method exists in both ArcRho and ResQ for this reserving class.",
    }


def _await_review_table(ui, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Open a non-blocking review table, poll until it completes, and return the completion."""

    opened = ui.send_command("ui.reviewTableOpen", args=dict(payload), timeout_sec=20)
    opened_payload = _result_payload(opened)
    dialog_id = str(opened_payload.get("dialogId") or opened_payload.get("dialog_id") or "").strip()
    if not dialog_id:
        raise RuntimeError("ArcRho did not return a review-table dialog ID. Update or restart the ArcRho shell.")
    try:
        while True:
            _report_activity()
            status = ui.send_command(
                "ui.reviewTableStatus",
                args={"dialogId": dialog_id},
                timeout_sec=20,
            )
            completion = _result_payload(status)
            state = str(completion.get("status") or completion.get("state") or "").strip().casefold()
            if state == "completed":
                return completion
            if state not in {"", "pending", "open"}:
                raise RuntimeError(str(completion.get("error") or f"Review table ended in an unexpected state: {state}"))
            time.sleep(REVIEW_POLL_SECONDS)
    finally:
        try:
            ui.send_command(
                "ui.reviewTableClose",
                args={"dialogId": dialog_id},
                timeout_sec=10,
            )
        except Exception:
            pass


def review_sync_plan(
    ui,
    preview: list[Mapping[str, Any]],
    project_name: str,
    rc_path: str,
    connection_name: str,
    direction: Mapping[str, Any],
) -> list[str] | None:
    """Show the sync plan and return the accepted row IDs, or None when cancelled."""

    completion = _await_review_table(
        ui, review_table_payload(preview, project_name, rc_path, connection_name, direction)
    )
    if not bool(completion.get("accepted")):
        return None
    selected = completion.get("selectedRowIds") or completion.get("selected_row_ids") or []
    return [str(value) for value in selected if str(value).strip()]


def accepted_rows(preview: list[Mapping[str, Any]], selected_ids: list[str]) -> list[dict[str, Any]]:
    """Return the reviewed rows the user accepted, in the order they chose them."""

    by_id = {str(row.get("id") or ""): row for row in preview if str(row.get("id") or "")}
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row_id in selected_ids:
        identifier = str(row_id or "").strip()
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        row = by_id.get(identifier)
        if row is None or row.get("disabled") or not row.get("action"):
            continue
        rows.append(dict(row))
    return rows


def _sync_summary_message(result: Mapping[str, Any]) -> str:
    """The short message for a run that applied nothing: a stale review or an empty selection."""

    if str(result.get("status") or "") == "stale":
        names = [str(value) for value in result.get("stale_items") or []]
        details = "\n".join(f"- {name}" for name in names[:12])
        return (
            "No actions were applied because one or more selected timestamps changed during review.\n"
            "Run the macro again to review a fresh comparison."
            + (f"\n\nChanged items:\n{details}" if details else "")
        )
    return "No synchronization actions were selected. Nothing was changed."


def sync_result_table_payload(result: Mapping[str, Any]) -> dict[str, Any]:
    """Project the Bridge's apply results into the read-only review-table contract.

    One row per result item: the accepted rows in the order they were written,
    then any dependent-refresh warning, which carries no row id, then any item
    the writes made both systems recalculate, which the Bridge re-baselined
    without writing. The whole run went one way, so the direction is named
    once in the header rather than on every row.
    """

    direction = result.get("direction") if isinstance(result.get("direction"), Mapping) else {}
    source, target = _direction_sides(direction.get("action"))
    items = [item for item in result.get("results") or [] if isinstance(item, Mapping)]
    rows = []
    applied = failed = warnings = recalculated = 0
    for index, item in enumerate(items, start=1):
        if item.get("absorbed"):
            recalculated += 1
            outcome = {"text": "Recalculated", "tone": "info"}
        elif not str(item.get("id") or ""):
            warnings += 1
            outcome = {"text": "Warning", "tone": "warn"}
        elif item.get("success"):
            applied += 1
            outcome = {"text": "Applied", "tone": "ok"}
        else:
            failed += 1
            outcome = {"text": "Failed", "tone": "error"}
        rows.append({
            "id": f"result-{index}",
            "cells": {
                "kind": str(item.get("kind") or KIND_DATASET),
                "name": str(item.get("name") or ""),
                "outcome": outcome,
                "detail": str(item.get("message") or ""),
            },
        })
    headline = (
        "Reserving-class synchronization completed with errors."
        if failed
        else "Reserving-class synchronization completed."
    )
    return {
        "title": "ResQ Sync Results",
        "host": "projectInstance",
        "selectable": False,
        "summary": (
            f"{headline}\n"
            f"Project: {result.get('project_name')} | Reserving class: {result.get('rc_path')} | "
            f"ResQ: {result.get('connection_name')}\n"
            f"Direction: {f'{source} to {target}' if source else 'none'}. "
            f"Applied {applied} of {applied + failed} accepted action(s); {failed} failed"
            + (f"; {warnings} dependent-refresh warning(s)" if warnings else "")
            + (f"; {recalculated} recalculated item(s) re-baselined" if recalculated else "")
            + "."
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "outcome", "label": "Outcome", "width": 110},
            {"key": "detail", "label": "Details", "width": 620},
        ],
        "rows": rows,
        "acceptLabel": "Close",
        "searchPlaceholder": "Filter results",
    }


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
            if _has_sync_context(active_context)
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = _context_value(context, "projectName", "project_name")
        rc_path = _context_value(context, "selectedPath", "selected_path", "path")
        if not project_name or not rc_path:
            raise ValueError("The active Project Instance page does not expose a project and reserving-class path.")

        active_window = ui.project_instance.active_window(timeout_sec=10)
        if active_window is not None and active_window.get_properties(timeout_sec=10).dirty:
            message = "Save or close unsaved dataset/method changes before synchronizing this reserving class."
            _message(ui, message, kind="warning", auto_close_ms=9000)
            return {"status": "cancelled", "cancelled": True, "reason": "active_window_dirty"}

        root = get_server_root(required=True)
        progress_holder["value"] = ui.progress_bar(
            progress_id=f"{PROGRESS_ID}-scan",
            title=TITLE,
            label=f"Comparing ArcRho and ResQ: {rc_path}",
            total=0,
        )
        preview_result = run_bridge_phase(
            server_root=root,
            project_name=project_name,
            rc_path=rc_path,
            phase="preview",
            timeout_sec=PREVIEW_TIMEOUT_SEC,
            progress=progress_holder.get("value"),
            progress_label=f"Comparing ArcRho and ResQ: {rc_path}",
        )
        preview = [row for row in preview_result.get("preview") or [] if isinstance(row, Mapping)]
        connection_name = str(preview_result.get("connection_name") or "")
        direction = dict(preview_result.get("direction") or {})
        close_progress()

        selected_ids = review_sync_plan(ui, preview, project_name, rc_path, connection_name, direction)
        if selected_ids is None:
            return {
                "status": "cancelled",
                "cancelled": True,
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": connection_name,
                "direction": direction,
                "preview": preview,
            }

        reviewed = accepted_rows(preview, selected_ids)
        if not reviewed:
            result = {
                "status": "no_changes",
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": connection_name,
                "successes": 0,
                "failures": 0,
                "results": [],
            }
        else:
            progress_holder["value"] = ui.progress_bar(
                progress_id=f"{PROGRESS_ID}-apply",
                title=TITLE,
                label="Rechecking selected timestamps",
                total=len(reviewed),
            )
            result = run_bridge_phase(
                server_root=root,
                project_name=project_name,
                rc_path=rc_path,
                phase="apply",
                selected_rows=reviewed,
                timeout_sec=APPLY_TIMEOUT_SEC,
                progress=progress_holder.get("value"),
                progress_label="Synchronizing ArcRho and ResQ",
            )
        result["preview"] = preview
        result["direction"] = direction

        local_writes = any(
            item.get("success") and item.get("action") == "resq_to_arcrho"
            for item in result.get("results") or []
            if isinstance(item, Mapping)
        )
        if local_writes:
            try:
                ui.project_instance.reload_dataset_table(timeout_sec=30)
                result["dataset_table_reloaded"] = True
            except Exception as exc:
                result["dataset_table_reloaded"] = False
                result["reload_error"] = str(exc)

        status = str(result.get("status") or "")
        if status in {"completed", "completed_with_errors"}:
            payload = sync_result_table_payload(result)
            result["message"] = payload["summary"]
            _await_review_table(ui, payload)
        else:
            summary = _sync_summary_message(result)
            _message(ui, summary, kind="warning", auto_close_ms=None if status == "stale" else 7000)
            result["message"] = summary
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
                progress.update(label="Synchronization failed", detail=str(exc), tone="error")
            except Exception:
                pass
        message = f"Reserving-class synchronization failed:\n{exc}\n\n{tb}"
        _message(ui, message, kind="error")
        return {"status": "error", "error": str(exc), "traceback": tb, "message": message}
    finally:
        progress = progress_holder.get("value")
        if progress is not None:
            try:
                progress.close(auto_close_ms=1500)
            except Exception:
                pass
