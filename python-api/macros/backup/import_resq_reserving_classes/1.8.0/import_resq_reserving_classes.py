# <arcrho-macro>
# Title: Import ResQ Reserving Classes
# Version: 1.8.0
# Release Note: Each class is now copied to a dated backup folder under the server's backups\pre-import before that class is imported, so an import can be undone later: its methods, its input, calculated and method-output datasets with their data files, and its index, with engine-generated datasets left out; the summary names the folder and lists any class whose copy failed.
# Description: Offer the fixed list of default reserving classes in a review table, all preselected, with an Overwrite checkbox in the same window, then import each accepted class from ResQ through the ArcRho Bridge one at a time, copying the class to a dated backup folder first, creating the ArcRho folder for any class the project does not hold yet, with batch progress and a final summary.
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
OVERWRITE_OPTION_KEY = "overwrite"
NEW_CLASS_LABEL = "New"

# The reserving classes this macro imports, in import order. The list is fixed
# on purpose: the macro never scans the project for other classes, and a
# listed class the project does not hold yet is imported into a new folder
# (the Bridge creates it when it commits the staged import).
RC_PATHS = [
    r"PRNJ - PA\PA\NY\Direct Group\BI Total",
    r"PRNJ - PA\PA\NY\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\Penn+CT\Direct Group\BI Total",
    r"PRNJ - PA\PA\Penn+CT\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\All States\Direct Group\PD+UMPD",
    r"PRNJ - PA\PA\All States\Direct Group\COL",
    r"PRNJ - PA\PA\All States\Direct Group\CMPxCAT",
    r"PRNJ - PA\PA\NJ\Direct Group\MP+PIP",
    r"PRNJ - PA\PA\NJ\Direct Group\BIR51+UMBIR51",
    r"PRNJ - PA\PA\NJ\Direct Group\BIx51+UMBIx51",
    r"HPPREF\HO+DF\NJ\Legacy\HOL",
    r"HPPREF\HO+DF\NJ\Legacy\HOPxCAT",
    r"Rider\MC\All States\Direct Group\BI+PIP",
    r"Rider\MC\All States\Direct Group\PD+UMPD",
    r"Rider\MC\All States\Direct Group\PhysDxCat",
    r"PRNJ - PA\PA\MA\Direct Group\BI Total",
    r"PRNJ - PA\PA\MA\Direct Group\MP+PIP",
]


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


def _existing_class_counts(server_root, project_name: str) -> dict[str, int | None]:
    """Casefolded class path -> indexed item count for every class folder held.

    The folder name is an encoded form of the class path, so the canonical
    spelling comes from each class's own ``index.json`` when it has one and is
    only decoded from the folder name when it does not — the same rule the
    Engine's source-refresh job applies when it enumerates a project. The
    lookup only tells a listed class that already exists from one that is new;
    classes outside the fixed list are never offered.
    """

    from arcrho_api.dataset_index_contract import decode_filename_segment

    data_dir = Path(server_root) / "projects" / str(project_name) / "data"
    try:
        entries = [entry for entry in data_dir.iterdir() if entry.is_dir()]
    except FileNotFoundError:
        return {}

    counts: dict[str, int | None] = {}
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
        if not name or key in counts:
            continue
        counts[key] = dataset_count
    return counts


def fixed_reserving_classes(server_root, project_name: str) -> list[dict[str, Any]]:
    """The fixed class list, each entry marked as held by the project or new.

    ``dataset_count`` is the indexed item count of an existing class (``None``
    when its index is missing or unreadable) and ``exists`` is False for a
    listed class the project has no folder for yet.
    """

    existing = _existing_class_counts(server_root, project_name)
    classes: list[dict[str, Any]] = []
    for rc_path in RC_PATHS:
        key = rc_path.casefold()
        classes.append({
            "path": rc_path,
            "dataset_count": existing.get(key),
            "exists": key in existing,
        })
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
        if not item.get("exists", True):
            datasets = NEW_CLASS_LABEL
        else:
            datasets = "" if count is None else str(count)
        rows.append({
            "id": path,
            "selected": True,
            "disabled": False,
            "cells": {
                "path": path,
                "datasets": datasets,
            },
        })
    new_count = sum(1 for item in classes if not item.get("exists", True))
    return {
        "title": TITLE,
        # Host the review inside the active Project Instance page as a nested
        # window when one exists; other shells fall back to the modal dialog.
        "host": "projectInstance",
        "summary": (
            f"Project: {project_name}\n"
            f"{len(classes)} default reserving class(es) listed"
            + (f", {new_count} not in this project yet" if new_count else "")
            + "; every selected class is imported from ResQ one at a time by "
            f"{worker_count} ArcRho Bridge worker(s). A class marked "
            f"{NEW_CLASS_LABEL} has no ArcRho folder yet; the import creates "
            "it. Unselect any class to leave it untouched. Overwrite makes "
            "the fresh ResQ copy win even where the ArcRho copy is newer; "
            "datasets that exist only in ArcRho are kept either way."
        ),
        "columns": [
            {"key": "path", "label": "Reserving Class", "width": 420},
            {"key": "datasets", "label": "Indexed Items", "width": 130},
        ],
        "rows": rows,
        "options": [{
            "key": OVERWRITE_OPTION_KEY,
            "label": "Overwrite existing ArcRho data",
            "checked": False,
            "hint": (
                "The fresh ResQ copy replaces the ArcRho copy for everything "
                "ResQ provides, even where the ArcRho copy is newer."
            ),
        }],
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
) -> dict[str, Any] | None:
    """Open the non-blocking review table and poll until the user decides.

    Returns ``{"selected": [...], "overwrite": bool}`` from one window: the
    class checkboxes and the footer Overwrite checkbox travel back together.
    """

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
                options = payload.get("optionStates") or payload.get("option_states") or {}
                return {
                    "selected": [str(value) for value in selected if str(value).strip()],
                    "overwrite": isinstance(options, dict)
                    and bool(options.get(OVERWRITE_OPTION_KEY)),
                }
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
    import_policy: str = "merge",
    progress=None,
    new_paths: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Import each class through the Bridge queue, one request at a time.

    A failed class is recorded and the batch continues, because each request
    commits or restores that class independently on the server. The one
    exception is a Bridge the sibling macro has judged silent for its whole
    limit: every later class would only wait out the same silence to fail the
    same way, so the rest of the batch is marked skipped instead of sent.

    ``new_paths`` names the classes the project had no folder for when the
    batch started; a committed import of one of them is reported as created.
    """

    created_keys = {str(path).casefold() for path in (new_paths or set())}
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
        backup = single.backup_reserving_class(
            server_root,
            project_name,
            rc_path,
            import_policy=import_policy,
        )
        try:
            request_id, payload = single.create_import_request(
                project_name=project_name,
                rc_path=rc_path,
                import_policy=import_policy,
            )
            single.publish_import_request(
                server_root=server_root, request_id=request_id, payload=payload
            )
            status = single.wait_for_import_result(
                server_root=server_root,
                request_id=request_id,
                on_poll=_report_macro_activity,
            )
        except single.BridgeUnavailableError as exc:
            results.append({
                "path": rc_path,
                "success": False,
                "error": str(exc),
                "request_id": request_id,
                "backup": backup,
            })
            for remaining in rc_paths[position:]:
                results.append({
                    "path": remaining,
                    "success": False,
                    "error": "Skipped: the ArcRho Bridge stopped responding, so this class was not sent.",
                    "request_id": "",
                })
            break
        except Exception as exc:
            results.append({
                "path": rc_path,
                "success": False,
                "error": str(exc),
                "request_id": request_id,
                "backup": backup,
            })
            continue
        result = single._status_result(status)
        # A committed class with item errors is a success with skipped items:
        # the Bridge skips a ResQ item it cannot export (keeping any existing
        # ArcRho copy) instead of failing the whole reserving class.
        detail_lines = getattr(single, "_detail_lines", None)
        results.append({
            "path": rc_path,
            "success": True,
            "error": "",
            "request_id": request_id,
            "backup": backup,
            "created": rc_path.casefold() in created_keys,
            "datasets_imported": single._summary_count(result, "datasets_imported", "total_written"),
            "methods_imported": single._summary_count(result, "methods_imported"),
            "skipped_items": detail_lines(result) if callable(detail_lines) else [],
            "engine_differences": (
                detail_lines(result, single.PARITY_WARNINGS_FIELD) if callable(detail_lines) else []
            ),
        })
    return results


def _backup_lines(results: list[dict[str, Any]]) -> list[str]:
    """What was copied aside before the batch, and anything that was not.

    The folder is named once, because every class of one batch backs up under
    the same server folder, and only the classes whose copy failed are listed
    by name.
    """

    backups = [item.get("backup") for item in results]
    taken = [entry for entry in backups if isinstance(entry, dict) and entry.get("files")]
    failed = [
        (str(item.get("path") or ""), str((item.get("backup") or {}).get("error") or ""))
        for item in results
        if isinstance(item.get("backup"), dict) and item["backup"].get("error")
    ]
    lines: list[str] = []
    if taken:
        methods = sum(int(entry.get("methods") or 0) for entry in taken)
        datasets = sum(int(entry.get("datasets") or 0) for entry in taken)
        skipped = sum(int(entry.get("engine_datasets_skipped") or 0) for entry in taken)
        root = str(Path(str(taken[0].get("path"))).parent.parent)
        lines.append("")
        lines.append(
            f"Backed up {methods} method(s) and {datasets} dataset(s) from "
            f"{len(taken)} reserving class(es) to [{root}] before importing; "
            f"{skipped} engine-generated dataset(s) were left out."
        )
    if failed:
        lines.append("")
        lines.append(
            "WARNING - the existing reserving class could not be copied aside "
            "before the import, so there is no restore point for:"
        )
        for path, error in failed[:MAX_REPORTED_FAILURES]:
            lines.append(f"- {path}: {error}")
    return lines


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
    created = [item for item in succeeded if item.get("created")]
    if created:
        lines.append(f"New reserving classes created: {len(created)}")
        lines.extend(f"- {item.get('path')}" for item in created)
    if datasets:
        lines.append(f"Datasets imported: {datasets}")
    if methods:
        lines.append(f"Methods imported: {methods}")
    lines.extend(_backup_lines(results))
    if failed:
        lines.append("")
        lines.append("Failed:")
        for item in failed[:MAX_REPORTED_FAILURES]:
            detail = str(item.get("error") or "Import failed.").strip()
            lines.append(f"- {item.get('path')}: {detail}")
        if len(failed) > MAX_REPORTED_FAILURES:
            lines.append(f"... and {len(failed) - MAX_REPORTED_FAILURES} more.")
    partial = [item for item in succeeded if item.get("skipped_items")]
    if partial:
        lines.append("")
        lines.append("Skipped items (could not be exported from ResQ; any existing ArcRho copy is kept):")
        reported = 0
        for item in partial:
            if reported >= MAX_REPORTED_FAILURES:
                break
            lines.append(f"{item.get('path')}:")
            for detail in item["skipped_items"]:
                if reported >= MAX_REPORTED_FAILURES:
                    break
                lines.append(str(detail))
                reported += 1
        remaining = sum(len(item["skipped_items"]) for item in partial) - reported
        if remaining > 0:
            lines.append(f"... and {remaining} more.")
    differing = [item for item in succeeded if item.get("engine_differences")]
    if differing:
        lines.append("")
        lines.append(
            "WARNING - ArcRho Engine results that differ from ResQ at two decimal places "
            "(the Engine result was kept):"
        )
        for item in differing:
            lines.append(f"{item.get('path')}:")
            lines.extend(str(detail) for detail in item["engine_differences"])
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

    # The class list is fixed; the project is only read to tell a listed class
    # that already exists from one whose folder the import will create.
    try:
        classes = fixed_reserving_classes(server_root, project_name)
    except Exception as exc:
        message = f"Could not check the project's reserving-class folders.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    new_paths = {item["path"] for item in classes if not item.get("exists")}

    try:
        review = review_class_selection(
            ui,
            classes,
            project_name,
            len(bridge_workers),
        )
    except Exception as exc:
        message = f"The reserving-class selection could not be completed.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    selected = review["selected"] if review else []
    if not selected:
        message = "Import cancelled; no reserving class was changed."
        _message(ui, message, auto_close_ms=3000)
        return {"success": False, "message": message, "reason": "cancelled"}

    # The Overwrite checkbox lives in the selection window; the destructive
    # branch still takes the sibling macro's explicit confirmation so both
    # imports word and confirm it identically.
    import_policy = single.IMPORT_POLICY_MERGE
    if review.get("overwrite"):
        confirmed = single.confirm_overwrite(
            ui,
            title=TITLE,
            scope_note=(
                f"Project: {project_name}\n"
                f"Selected reserving classes: {len(selected)}"
            ),
        )
        if not confirmed:
            message = "Import cancelled; no reserving class was changed."
            _message(ui, message, auto_close_ms=3000)
            return {"success": False, "message": message, "reason": "cancelled"}
        import_policy = single.IMPORT_POLICY_OVERWRITE

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
        import_policy=import_policy,
        progress=progress,
        new_paths=new_paths,
    )

    failed = [item for item in results if not item.get("success")]
    partial = [item for item in results if item.get("skipped_items")]
    # A class whose method files could not be copied aside holds the box open
    # too: that import ran without a restore point and the person must see it.
    unbacked = [
        item
        for item in results
        if isinstance(item.get("backup"), dict) and item["backup"].get("error")
    ]
    if progress is not None:
        try:
            progress.update(
                label="Batch import complete",
                total=len(results),
                completed=len(results),
                tone="warning" if failed or partial or unbacked else "success",
            )
            if not failed and not partial and not unbacked:
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
        kind="warning" if failed or partial or unbacked or reload_error else "info",
        auto_close_ms=None if failed or partial or unbacked else 3000,
    )
    return {
        "success": not failed,
        "message": message,
        "results": results,
    }


if __name__ == "__main__":
    print(run_macro())
