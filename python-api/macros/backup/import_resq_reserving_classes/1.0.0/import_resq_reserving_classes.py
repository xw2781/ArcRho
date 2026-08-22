# <arcrho-macro>
# Title: Import ResQ Reserving Classes
# Version: 1.0.0
# Release Note: Initial release: pick any set of the project's reserving classes and import each through the ArcRho Bridge queue.
# Description: List every reserving class in the active project, let the user pick any set in a review table, then import each selected class from ResQ through the ArcRho Bridge one at a time with batch progress and a final summary.
# Scope: Project
# </arcrho-macro>

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

TITLE = "Import ResQ Reserving Classes"
REVIEW_POLL_SECONDS = 0.5
INDEX_FILE_NAME = "index.json"
MAX_REPORTED_FAILURES = 12


def _load_single_import_macro():
    """Import the sibling macro that owns the Bridge import queue client.

    The macro runner puts the running macro's folder on ``sys.path`` before
    executing it, and the single-class macro is deployed to the same folder,
    so a plain import finds it in the repository and on a user machine alike.
    The queue protocol adapter is defined once, there.
    """

    try:
        import import_resq_reserving_class as single
    except ImportError as exc:
        raise RuntimeError(
            "This macro needs the 'Import ResQ Reserving Class' macro in the "
            "same macros folder. Load or update it from the Macro Library, "
            "then run this macro again."
        ) from exc
    return single


def _message(ui, text, *, title=TITLE, kind="info", auto_close_ms=None):
    return ui.message_box(
        str(text or ""),
        title=title,
        kind=kind,
        auto_close_ms=auto_close_ms,
        timeout_sec=120,
    )


def _context_value(context, *names):
    for name in names:
        value = str((context or {}).get(name) or "").strip()
        if value:
            return value
    return ""


def _report_macro_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    activity_reporter = globals().get("report_macro_activity")
    if callable(activity_reporter):
        activity_reporter()


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (FileNotFoundError, PermissionError, OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def list_reserving_classes(server_root, project_name: str) -> list[dict[str, Any]]:
    """Every reserving class in the project that owns persisted data.

    The folder name is an encoded form of the class path, so the canonical
    spelling comes from each class's own ``index.json`` when it has one and is
    only decoded from the folder name when it does not — the same rule the
    Engine's source-refresh job applies when it enumerates a project.
    """

    from arcrho_api.dataset_index_contract import decode_filename_segment

    data_dir = Path(server_root) / "projects" / str(project_name) / "data"
    try:
        entries = sorted(
            (entry for entry in data_dir.iterdir() if entry.is_dir()),
            key=lambda entry: (entry.name.casefold(), entry.name),
        )
    except FileNotFoundError:
        return []

    classes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if entry.name.startswith("."):
            continue
        index_payload = _read_json(entry / INDEX_FILE_NAME)
        name = ""
        dataset_count = None
        if index_payload is not None:
            name = str(index_payload.get("reserving_class") or "").strip()
            files = index_payload.get("files")
            if isinstance(files, list):
                dataset_count = len(files)
        if not name:
            name = decode_filename_segment(entry.name).strip()
        key = name.casefold()
        if not name or key in seen:
            continue
        seen.add(key)
        classes.append({"path": name, "dataset_count": dataset_count})
    return classes


def review_table_payload(
    classes: list[dict[str, Any]],
    project_name: str,
    worker_count: int,
) -> dict[str, Any]:
    rows = []
    for item in classes:
        path = str(item.get("path") or "")
        count = item.get("dataset_count")
        rows.append({
            "id": path,
            "selected": True,
            "disabled": False,
            "cells": {
                "path": path,
                "datasets": "" if count is None else str(count),
            },
        })
    return {
        "title": TITLE,
        # Host the review inside the active Project Instance page as a nested
        # window when one exists; other shells fall back to the modal dialog.
        "host": "projectInstance",
        "summary": (
            f"Project: {project_name}\n"
            f"{len(classes)} reserving class(es) found; every selected class is "
            f"imported from ResQ one at a time by {worker_count} ArcRho Bridge "
            "worker(s). Unselect any class to leave it untouched."
        ),
        "columns": [
            {"key": "path", "label": "Reserving Class", "width": 420},
            {"key": "datasets", "label": "Indexed Items", "width": 130},
        ],
        "rows": rows,
        "acceptLabel": "Import Selected",
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter reserving classes",
        "emptyMessage": "This project has no reserving-class data folders yet.",
    }


def _result_payload(response: Any) -> dict[str, Any]:
    payload = getattr(response, "result", None)
    if isinstance(payload, dict):
        return payload
    if isinstance(response, dict):
        inner = response.get("result")
        return inner if isinstance(inner, dict) else response
    return {}


def review_class_selection(
    ui,
    classes: list[dict[str, Any]],
    project_name: str,
    worker_count: int,
) -> list[str] | None:
    """Open the non-blocking review table and poll until the user decides."""

    opened = ui.send_command(
        "ui.reviewTableOpen",
        args=review_table_payload(classes, project_name, worker_count),
        timeout_sec=20,
    )
    opened_payload = _result_payload(opened)
    dialog_id = str(opened_payload.get("dialogId") or opened_payload.get("dialog_id") or "").strip()
    if not dialog_id:
        raise RuntimeError(
            "ArcRho did not return a review-table dialog ID. Update or restart the ArcRho shell."
        )
    try:
        while True:
            _report_macro_activity()
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
                raise RuntimeError(
                    str(payload.get("error") or f"Review table ended in an unexpected state: {state}")
                )
            time.sleep(REVIEW_POLL_SECONDS)
    finally:
        try:
            ui.send_command("ui.reviewTableClose", args={"dialogId": dialog_id}, timeout_sec=10)
        except Exception:
            pass


def import_selected_classes(
    single,
    *,
    server_root,
    project_name: str,
    rc_paths: list[str],
    progress=None,
) -> list[dict[str, Any]]:
    """Import each class through the Bridge queue, one request at a time.

    A failed class is recorded and the batch continues, because each request
    commits or restores that class independently on the server. The one
    exception is a Bridge that stopped heartbeating: every later class would
    only wait out the claim timeout to fail the same way, so the rest of the
    batch is marked skipped immediately.
    """

    results: list[dict[str, Any]] = []
    total = len(rc_paths)
    for position, rc_path in enumerate(rc_paths, start=1):
        _report_macro_activity()
        request_id = ""
        if progress is not None:
            try:
                progress.update(
                    label=f"Importing {rc_path} ({position} of {total})",
                    total=total,
                    completed=position - 1,
                )
            except Exception:
                pass
        try:
            request_id, payload = single.create_import_request(
                project_name=project_name, rc_path=rc_path
            )
            single.publish_import_request(
                server_root=server_root, request_id=request_id, payload=payload
            )
            status = single.wait_for_import_result(
                server_root=server_root,
                request_id=request_id,
                on_poll=_report_macro_activity,
            )
        except Exception as exc:
            results.append({
                "path": rc_path,
                "success": False,
                "error": str(exc),
                "request_id": request_id,
            })
            if not single.discover_live_bridge_workers(server_root):
                for remaining in rc_paths[position:]:
                    results.append({
                        "path": remaining,
                        "success": False,
                        "error": "Skipped: ArcRho Bridge became unavailable.",
                        "request_id": "",
                    })
                break
            continue
        result = single._status_result(status)
        errors = single._summary_count(result, "errors") or 0
        results.append({
            "path": rc_path,
            "success": errors == 0,
            "error": str(status.get("message") or "").strip() if errors else "",
            "request_id": request_id,
            "datasets_imported": single._summary_count(result, "datasets_imported", "total_written"),
            "methods_imported": single._summary_count(result, "methods_imported"),
        })
    return results


def _summary_message(project_name: str, results: list[dict[str, Any]]) -> str:
    succeeded = [item for item in results if item.get("success")]
    failed = [item for item in results if not item.get("success")]
    datasets = sum(item.get("datasets_imported") or 0 for item in succeeded)
    methods = sum(item.get("methods_imported") or 0 for item in succeeded)
    lines = [
        "Batch import from ResQ finished.",
        f"Project: {project_name}",
        f"Reserving classes imported: {len(succeeded)} of {len(results)}",
    ]
    if datasets:
        lines.append(f"Datasets imported: {datasets}")
    if methods:
        lines.append(f"Methods imported: {methods}")
    if failed:
        lines.append("")
        lines.append("Failed:")
        for item in failed[:MAX_REPORTED_FAILURES]:
            detail = str(item.get("error") or "Import failed.").strip()
            lines.append(f"- {item.get('path')}: {detail}")
        if len(failed) > MAX_REPORTED_FAILURES:
            lines.append(f"... and {len(failed) - MAX_REPORTED_FAILURES} more.")
    return "\n".join(lines)


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    single = _load_single_import_macro()
    ui = ArcRhoUI()
    progress = None
    try:
        context = (
            active_context
            if isinstance(active_context, dict)
            and _context_value(active_context, "projectName", "project_name")
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = single._logical_project_name(
            _context_value(context, "projectName", "project_name")
        )
    except Exception as exc:
        message = (
            "Activate a Project Instance page for the project to import "
            f"before running this macro.\n\n{exc}"
        )
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    try:
        server_root = Path(get_server_root(required=True))
        bridge_workers = single.require_live_bridge_workers(server_root)
    except single.BridgeUnavailableError as exc:
        message = (
            "No active ArcRho Bridge worker was detected, so no import was started.\n\n"
            f"Project: {project_name}\n\n{exc}"
        )
        _message(ui, message, title="ArcRho Bridge Unavailable", kind="error")
        return {"success": False, "message": message, "reason": "bridge_unavailable"}
    except Exception as exc:
        message = f"Could not prepare the ArcRho Bridge import.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}

    try:
        classes = list_reserving_classes(server_root, project_name)
    except Exception as exc:
        message = f"Could not list the project's reserving classes.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    if not classes:
        message = f"Project {project_name} has no reserving-class data folders to import."
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    try:
        selected = review_class_selection(ui, classes, project_name, len(bridge_workers))
    except Exception as exc:
        message = f"The reserving-class selection could not be completed.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    if not selected:
        message = "Import cancelled; no reserving class was changed."
        _message(ui, message, auto_close_ms=3000)
        return {"success": False, "message": message, "reason": "cancelled"}

    try:
        progress = ui.progress_bar(
            progress_id="import-resq-reserving-classes",
            title=TITLE,
            label=f"Importing {len(selected)} reserving class(es) from ResQ",
            total=len(selected),
        )
    except Exception:
        progress = None

    results = import_selected_classes(
        single,
        server_root=server_root,
        project_name=project_name,
        rc_paths=selected,
        progress=progress,
    )

    failed = [item for item in results if not item.get("success")]
    if progress is not None:
        try:
            progress.update(
                label="Batch import complete",
                total=len(results),
                completed=len(results),
                tone="warning" if failed else "success",
            )
            if not failed:
                progress.close(auto_close_ms=3000)
        except Exception:
            pass

    reload_error = ""
    try:
        ui.project_instance.reload_dataset_table(timeout_sec=30)
    except Exception as exc:
        reload_error = str(exc)

    message = _summary_message(project_name, results)
    if reload_error:
        message += f"\n\nDataset table reload failed: {reload_error}"
    _message(
        ui,
        message,
        kind="warning" if failed or reload_error else "info",
        auto_close_ms=None if failed else 3000,
    )
    return {
        "success": not failed,
        "message": message,
        "results": results,
    }


if __name__ == "__main__":
    print(run_macro())
