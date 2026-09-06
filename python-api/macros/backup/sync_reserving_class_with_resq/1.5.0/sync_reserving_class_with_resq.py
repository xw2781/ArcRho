# <arcrho-macro>
# Title: Sync Reserving Class with ResQ
# Version: 1.5.0
# Release Note: A ResQ "User Calculation" average row now syncs across as a live row that keeps recalculating, under its ResQ name, instead of as frozen numbers.
# Description: Compare every dataset and supported method output in the selected reserving class, push the whole class from whichever side changed last, and mark rows whose own timestamps disagree with that direction for review.
# Scope: Reserving Class
# </arcrho-macro>

"""Review and push one reserving class's ArcRho/ResQ differences one way.

ResQ automation exists only where ResQ is installed, which is usually not the
machine ArcRho runs on. This macro therefore owns no ResQ session at all: it
publishes logical requests to the shared Bridge queue through
``arcrho_api.resq_sync_queue`` and a ResQ-connected Bridge worker runs the
canonical synchronization session (``resq_migration.sync_session``) on its
behalf.

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

import traceback
from typing import Any, Mapping

from arcrho_api.resq_sync_queue import (
    PREVIEW_TIMEOUT_SEC,
    WRITE_TIMEOUT_SEC,
    BridgeUnavailableError,
    run_bridge_phase,
)
from arcrho_api.ui import await_review_table


TITLE = "Sync Reserving Class with ResQ"
MACRO_VERSION = "1.4.1"
PROGRESS_ID = "sync-reserving-class-with-resq"

KIND_DATASET = "Dataset"


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
    """Open a non-blocking review table and return its completion once the person is done."""

    return await_review_table(ui, dict(payload), on_poll=_report_activity)


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
            on_poll=_report_activity,
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
                timeout_sec=WRITE_TIMEOUT_SEC,
                progress=progress_holder.get("value"),
                progress_label="Synchronizing ArcRho and ResQ",
                on_poll=_report_activity,
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
