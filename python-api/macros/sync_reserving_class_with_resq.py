# <arcrho-macro>
# Title: Sync Reserving Class with ResQ
# Version: 1.2.0
# Release Note: Run the ResQ session on a ResQ-connected ArcRho Bridge worker through the shared request queue, so the macro works on a machine without ResQ installed.
# Description: Compare every dataset and supported method output in the selected reserving class, show both ArcRho and ResQ timestamps in a review table, and apply only the synchronization actions the user accepts.
# Scope: Reserving Class
# </arcrho-macro>

"""Review and apply one reserving class's ArcRho/ResQ differences.

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
and the summary. The comparison and write rules live in the canonical session
this macro never imports.
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


TITLE = "Sync Reserving Class with ResQ"
MACRO_VERSION = "1.2.0"
PROGRESS_ID = "sync-reserving-class-with-resq"
REVIEW_POLL_SECONDS = 0.5

# Pinned to data-engine/src/arcrho_bridge/resq_reserving_class_sync_contract.json
# and, for the shared worker/status facts that contract deliberately does not
# restate, to resq_reserving_class_import_contract.json. A macro cannot import
# the Bridge, so a test asserts this adapter still matches both files.
REQUEST_FUNCTION = "SyncResQReservingClass"
CONTRACT_VERSION = 1
REQUEST_RELATIVE_DIR = (
    Path("requests")
    / "RPC bridge"
    / "resq_reserving_class_sync"
    / "requests"
)
STATUS_RELATIVE_DIR = REQUEST_RELATIVE_DIR.with_name("statuses")
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
BRIDGE_WORKER_DIR = Path("runtime") / "instances" / "arcrho_bridge_worker"
BRIDGE_WORKER_ROLE = "bridge_worker"
BRIDGE_WORKER_MAX_AGE_SEC = 6

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


def _is_true(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


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


def discover_live_bridge_workers(
    server_root: object,
    *,
    max_age_sec: float = BRIDGE_WORKER_MAX_AGE_SEC,
    now: float | None = None,
) -> tuple[Path, ...]:
    """Return fresh, ResQ-connected Bridge worker heartbeats under ``server_root``."""

    root = Path(server_root)
    heartbeat_dir = root / BRIDGE_WORKER_DIR
    observed_at = time.time() if now is None else float(now)
    try:
        candidates = tuple(heartbeat_dir.glob("*.json"))
    except OSError:
        return ()

    live: list[Path] = []
    for path in candidates:
        try:
            age = observed_at - path.stat().st_mtime
        except OSError:
            continue
        if age < -max_age_sec or age > max_age_sec:
            continue
        payload = _read_json(path)
        if not payload:
            continue
        role = str(payload.get("Role") or payload.get("role") or "").strip().casefold()
        if role != BRIDGE_WORKER_ROLE or not _is_true(payload.get("ResQGuiRunning")):
            continue
        live.append(path)
    return tuple(sorted(live, key=lambda item: item.name.casefold()))


def require_live_bridge_workers(server_root: object) -> tuple[Path, ...]:
    workers = discover_live_bridge_workers(server_root)
    if workers:
        return workers
    heartbeat_dir = Path(server_root) / BRIDGE_WORKER_DIR
    raise BridgeUnavailableError(
        "No active ArcRho Bridge worker was found, so ResQ cannot be reached from "
        "this computer. Start ArcRho on a machine where ResQ is running, then "
        "synchronize again.\n"
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{heartbeat_dir}]."
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


def _row_tone(row: Mapping[str, Any]) -> str:
    status = str(row.get("status") or "").casefold()
    if row.get("conflict") or "mismatch" in status or "ambiguous" in status:
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
) -> dict[str, Any]:
    """Project the Bridge's preview rows into the reusable review-table contract."""

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
                "action": {"text": str(row.get("action_label") or "No action"), "tone": tone},
                "detail": str(row.get("detail") or ""),
            },
        })
    actionable = sum(not bool(row.get("disabled")) for row in preview)
    selected = sum(bool(row.get("selected")) and not bool(row.get("disabled")) for row in preview)
    return {
        "title": TITLE,
        # Ask the shell to host the review inside the active Project Instance
        # page as a nested window (minimizable to the toolbar). Shells without
        # an active Project Instance page fall back to the modal dialog.
        "host": "projectInstance",
        "summary": (
            f"Project: {project_name} | Reserving class: {rc_path} | ResQ: {connection_name}\n"
            f"Compared {len(preview)} logical dataset/method output(s). "
            f"{actionable} action(s) are available; {selected} are selected. "
            "Both timestamp columns are shown for every row."
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "arcrho_timestamp", "label": "ArcRho Timestamp", "width": 220},
            {"key": "resq_timestamp", "label": "ResQ Timestamp", "width": 220},
            {"key": "status", "label": "Status", "width": 190},
            {"key": "action", "label": "Proposed Action", "width": 145},
            {"key": "detail", "label": "Details", "width": 360},
        ],
        "rows": rows,
        "acceptLabel": "Apply Selected",
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter datasets and methods",
        "emptyMessage": "No datasets or methods were found on either side.",
    }


def review_sync_plan(
    ui,
    preview: list[Mapping[str, Any]],
    project_name: str,
    rc_path: str,
    connection_name: str,
) -> list[str] | None:
    """Open the non-blocking review table and poll until the user decides."""

    opened = ui.send_command(
        "ui.reviewTableOpen",
        args=review_table_payload(preview, project_name, rc_path, connection_name),
        timeout_sec=20,
    )
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
            payload = _result_payload(status)
            state = str(payload.get("status") or payload.get("state") or "").strip().casefold()
            if state == "completed":
                if not bool(payload.get("accepted")):
                    return None
                selected = payload.get("selectedRowIds") or payload.get("selected_row_ids") or []
                return [str(value) for value in selected if str(value).strip()]
            if state not in {"", "pending", "open"}:
                raise RuntimeError(str(payload.get("error") or f"Review table ended in an unexpected state: {state}"))
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
    status = str(result.get("status") or "")
    if status == "stale":
        names = [str(value) for value in result.get("stale_items") or []]
        details = "\n".join(f"- {name}" for name in names[:12])
        return (
            "No actions were applied because one or more selected timestamps changed during review.\n"
            "Run the macro again to review a fresh comparison."
            + (f"\n\nChanged items:\n{details}" if details else "")
        )
    if status == "no_changes":
        return "No synchronization actions were selected. Nothing was changed."

    results = [item for item in result.get("results") or [] if isinstance(item, Mapping)]
    successful = [item for item in results if item.get("id") and item.get("success")]
    failed = [item for item in results if item.get("id") and not item.get("success")]
    warnings = [item for item in results if not item.get("id")]
    to_resq = sum(item.get("action") == "arcrho_to_resq" for item in successful)
    to_arcrho = sum(item.get("action") == "resq_to_arcrho" for item in successful)
    lines = [
        "Reserving-class synchronization completed." if not failed else "Reserving-class synchronization completed with errors.",
        f"Project: {result.get('project_name')}",
        f"Path: {result.get('rc_path')}",
        f"ResQ connection: {result.get('connection_name')}",
        "",
        f"Applied: {len(successful)}",
        f"ArcRho -> ResQ: {to_resq}",
        f"ResQ -> ArcRho: {to_arcrho}",
        f"Failed or skipped: {len(failed)}",
    ]
    if failed or warnings:
        lines.extend(("", "Details:"))
        for item in (failed + warnings)[:12]:
            lines.append(f"- {item.get('name')}: {item.get('message')}")
    return "\n".join(lines)


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
        close_progress()

        selected_ids = review_sync_plan(ui, preview, project_name, rc_path, connection_name)
        if selected_ids is None:
            return {
                "status": "cancelled",
                "cancelled": True,
                "project_name": project_name,
                "rc_path": rc_path,
                "connection_name": connection_name,
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
        summary = _sync_summary_message(result)
        kind = "warning" if status in {"stale", "no_changes", "completed_with_errors"} else "success"
        _message(ui, summary, kind=kind, auto_close_ms=None if status in {"stale", "completed_with_errors"} else 7000)
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
