# <arcrho-macro>
# Title: Import ResQ Reserving Classes
# Version: 1.4.0
# Release Note: Each class in the batch now brings ResQ's "User Calculation" average rows across as live rows that keep recalculating, instead of as frozen numbers.
# Description: List every reserving class in the active project in a review table with the canonical default classes preselected and an Overwrite checkbox in the same window, then import each accepted class from ResQ through the ArcRho Bridge one at a time with batch progress and a final summary.
# Scope: Project
# </arcrho-macro>

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

TITLE = "Import ResQ Reserving Classes"
REVIEW_POLL_SECONDS = 0.5
INDEX_FILE_NAME = "index.json"
MAX_REPORTED_FAILURES = 12
OVERWRITE_OPTION_KEY = "overwrite"


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


def _load_canonical_migration(server_root):
    """Load the canonical migration module that owns the default class list.

    A machine whose Python path already reaches the repository can import it
    directly; a Client PC loads it from the read-only shared support release
    the macro publisher maintains beside the macro library.
    """

    try:
        import resq_data_migration as module
        return module
    except ImportError:
        pass
    support_root = (Path(server_root) / "shared" / "python-api").resolve()
    pointer = json.loads((support_root / "current.json").read_text(encoding="utf-8-sig"))
    relative_root = str(pointer.get("relative_root") or "").strip()
    release_root = (support_root / relative_root).resolve()
    if support_root != release_root and support_root not in release_root.parents:
        raise ValueError("current.json points outside the shared support folder")
    migration_dir = release_root / "migration"
    entry = migration_dir / "resq_data_migration.py"
    inserted = str(migration_dir) not in sys.path
    if inserted:
        sys.path.insert(0, str(migration_dir))
    try:
        spec = importlib.util.spec_from_file_location(
            "_arcrho_macro_resq_data_migration", entry
        )
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not load the shared migration module [{entry}].")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if inserted:
            try:
                sys.path.remove(str(migration_dir))
            except ValueError:
                pass


def default_rc_paths(server_root) -> list[str]:
    """The canonical default selection, owned by the migration module.

    An unreachable or older support bundle only loses the preselection - the
    review table then starts with every class checked, exactly as before.
    """

    try:
        module = _load_canonical_migration(server_root)
        paths = getattr(module, "RC_PATH", None)
    except Exception:
        return []
    if not isinstance(paths, (list, tuple)):
        return []
    return [str(path).strip() for path in paths if str(path).strip()]


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
    default_paths: list[str] | None = None,
) -> dict[str, Any]:
    defaults = {str(path).casefold() for path in (default_paths or []) if str(path).strip()}
    rows = []
    for item in classes:
        path = str(item.get("path") or "")
        count = item.get("dataset_count")
        rows.append({
            "id": path,
            "selected": path.casefold() in defaults if defaults else True,
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
            "worker(s). Unselect any class to leave it untouched. Overwrite "
            "makes the fresh ResQ copy win even where the ArcRho copy is "
            "newer; datasets that exist only in ArcRho are kept either way."
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
    default_paths: list[str] | None = None,
) -> dict[str, Any] | None:
    """Open the non-blocking review table and poll until the user decides.

    Returns ``{"selected": [...], "overwrite": bool}`` from one window: the
    class checkboxes and the footer Overwrite checkbox travel back together.
    """

    opened = ui.send_command(
        "ui.reviewTableOpen",
        args=review_table_payload(classes, project_name, worker_count, default_paths),
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
) -> list[dict[str, Any]]:
    """Import each class through the Bridge queue, one request at a time.

    A failed class is recorded and the batch continues, because each request
    commits or restores that class independently on the server. The one
    exception is a Bridge the sibling macro has judged silent for its whole
    limit: every later class would only wait out the same silence to fail the
    same way, so the rest of the batch is marked skipped instead of sent.
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
            "datasets_imported": single._summary_count(result, "datasets_imported", "total_written"),
            "methods_imported": single._summary_count(result, "methods_imported"),
            "skipped_items": detail_lines(result) if callable(detail_lines) else [],
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
        review = review_class_selection(
            ui,
            classes,
            project_name,
            len(bridge_workers),
            default_rc_paths(server_root),
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
    )

    failed = [item for item in results if not item.get("success")]
    partial = [item for item in results if item.get("skipped_items")]
    if progress is not None:
        try:
            progress.update(
                label="Batch import complete",
                total=len(results),
                completed=len(results),
                tone="warning" if failed or partial else "success",
            )
            if not failed and not partial:
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
        kind="warning" if failed or partial or reload_error else "info",
        auto_close_ms=None if failed or partial else 3000,
    )
    return {
        "success": not failed,
        "message": message,
        "results": results,
    }


if __name__ == "__main__":
    print(run_macro())
