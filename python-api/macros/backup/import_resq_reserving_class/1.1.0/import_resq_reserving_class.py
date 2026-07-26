# <arcrho-macro>
# Title: Import ResQ Reserving Class
# Version: 1.1.0
# Release Note: Use the ArcRho Server engine worker pool and stop immediately when no worker is available.
# Description: Import all configured ResQ datasets and methods into the reserving-class path selected in the active Project Instance page.
# Scope: Reserving Class
# </arcrho-macro>

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_resq_migration_module():
    path = Path(r"E:\XWSpace\Repos\ArcRho\python-api\migration\resq_data_migration.py")
    if not path.is_file():
        raise FileNotFoundError(f"Could not locate resq_data_migration.py: {path}")
    spec = importlib.util.spec_from_file_location("arcrho_resq_data_migration", path)
    if not spec or not spec.loader:
        raise ImportError(f"Could not load resq_data_migration.py: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.__arcrho_migration_path__ = str(path)
    return module


def _message(ui, text, *, title="Import ResQ Reserving Class", kind="info", auto_close_ms=None):
    return ui.message_box(
        str(text or ""),
        title=title,
        kind=kind,
        auto_close_ms=auto_close_ms,
        timeout_sec=15,
    )


def _context_value(context, *names):
    for name in names:
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def _progress_tone(status):
    normalized = str(status or "").strip().lower()
    if normalized in {"error", "failed", "fail"}:
        return "error"
    if normalized in {"warning", "warn", "skipped"}:
        return "warning"
    if normalized in {"success", "complete", "completed"}:
        return "success"
    return ""


def _make_progress_callback(progress):
    def update(event):
        cancel_checker = globals().get("check_macro_cancelled")
        if callable(cancel_checker):
            cancel_checker()
        activity_reporter = globals().get("report_macro_activity")
        if callable(activity_reporter):
            activity_reporter()
        if progress is None:
            return
        payload = event if isinstance(event, dict) else {}
        event_name = str(payload.get("event") or "").strip().lower()
        if event_name in {"activity", "start"}:
            return
        total = _safe_int(payload.get("total"), progress.total)
        completed = _safe_int(payload.get("completed"), progress.completed)
        status = str(payload.get("status") or "").strip()

        dataset_name = str(payload.get("dataset_name") or payload.get("name") or "").strip()
        if event_name == "total":
            triangles = _safe_int(payload.get("triangles"), 0)
            vectors = _safe_int(payload.get("vectors"), 0)
            label = f"{total} dataset(s) discovered ({triangles} triangles, {vectors} vectors)"
        elif event_name == "start":
            label = f"Importing dataset: {dataset_name}" if dataset_name else "Importing datasets"
        elif event_name == "finish":
            label = f"Imported dataset: {dataset_name}" if dataset_name else "Importing datasets"
        elif event_name == "method":
            label = f"Finalizing dataset: {dataset_name}" if dataset_name else "Finalizing datasets"
        elif event_name == "complete":
            label = "Import complete"
        elif event_name == "connect":
            label = "Connecting to ResQ"
        else:
            label = "Import from ResQ"
        try:
            progress.update(
                label=label,
                total=total,
                completed=completed,
                tone=_progress_tone(status),
            )
        except Exception:
            pass

    return update


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    try:
        context = ui.project_instance.context(timeout_sec=10)
    except Exception as exc:
        message = f"Activate a Project Instance page and select a reserving-class path before importing from ResQ.\n\n{exc}"
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    project_name = _context_value(context, "projectName", "project_name")
    rc_path = _context_value(context, "selectedPath", "selected_path", "path")
    if not project_name or not rc_path:
        message = "Select a reserving-class path in the active Project Instance page before importing from ResQ."
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    progress = None
    migration = None
    migration_path = ""
    server_root = ""
    worker_instances = []
    try:
        server_root = get_server_root(required=True)
        migration = _load_resq_migration_module()
        migration_path = str(getattr(migration, "__arcrho_migration_path__", getattr(migration, "__file__", "")) or "")
        worker_instances = migration.require_running_engine_instances(server_root)

        try:
            progress = ui.progress_bar(
                progress_id="import-resq-reserving-class",
                title="Import ResQ Reserving Class",
                label=f"Preparing import with {len(worker_instances)} data-engine worker(s)",
            )
        except Exception:
            progress = None

        call_args = (
            migration.import_reserving_class_from_resq,
            project_name,
            rc_path,
        )
        call_kwargs = {
            "server_root": server_root,
            "export_mode": "configured",
            "cleanup_target": None,
            "progress_callback": _make_progress_callback(progress),
            "verbose": False,
        }
        trusted_runner = globals().get("run_trusted_macro_call")
        if callable(trusted_runner):
            result = trusted_runner(*call_args, **call_kwargs)
        else:
            result = call_args[0](*call_args[1:], **call_kwargs)
    except Exception as exc:
        raw = str(exc)
        engine_error_type = getattr(migration, "EngineUnavailableError", None) if migration is not None else None
        is_engine_unavailable = isinstance(engine_error_type, type) and isinstance(exc, engine_error_type)
        is_connection_error = "ResQ COM API" in raw or "pywin32" in raw or "ResQ3Automation" in raw
        if is_engine_unavailable:
            prefix = "No running ArcRho Engine instance was detected."
            detail = "The migration stopped before connecting to ResQ or changing the selected reserving class."
            title = "ArcRho Data Engine Unavailable"
        else:
            prefix = "Could not connect to ResQ." if is_connection_error else "Import from ResQ failed."
            detail = ""
            title = "Import ResQ Reserving Class"
        message = prefix
        if detail:
            message += f"\n\n{detail}"
        message += f"\n\nProject: {project_name}\nPath: {rc_path}"
        if server_root:
            message += f"\nServer: {server_root}"
        if raw:
            message += f"\n\n{raw}"
        if progress is not None:
            try:
                progress.update(label="Import failed", tone="error")
            except Exception:
                pass
        _message(ui, message, title=title, kind="error")
        return {"success": False, "message": message}

    result["migration_path"] = migration_path
    result["engine_workers_detected"] = len(worker_instances)
    imported = int(result.get("datasets_imported") or result.get("total_written") or 0)
    grand_total = int(result.get("grand_total") or result.get("datasets_total") or 0)
    skipped = int(result.get("skipped") or 0)
    errors = int(result.get("errors") or 0)
    suffix = f"\nSkipped: {skipped}" if skipped else ""
    suffix += f"\nErrors: {errors}" if errors else ""
    error_details = result.get("error_details") if isinstance(result.get("error_details"), list) else []
    if errors and error_details:
        suffix += "\n\nFirst errors:"
        for item in error_details[:3]:
            if isinstance(item, dict):
                kind = str(item.get("kind") or "item").strip()
                name = str(item.get("name") or "").strip()
                detail = str(item.get("message") or "").strip()
                suffix += f"\n- {kind} {name}: {detail}"[:240]
    if errors and migration_path:
        suffix += f"\n\nMigration: {migration_path}"
    if progress is not None:
        try:
            progress.update(
                label="Import complete",
                completed=grand_total or progress.completed,
                total=grand_total or progress.total,
                tone="warning" if errors else "success",
            )
            if not errors:
                progress.close(auto_close_ms=3000)
        except Exception:
            pass
    try:
        reload_info = ui.project_instance.reload_dataset_table(timeout_sec=30)
        result["dataset_table_reloaded"] = bool(reload_info.get("refreshed", True))
    except Exception as exc:
        result["dataset_table_reloaded"] = False
        result["dataset_table_reload_error"] = str(exc)
        suffix += f"\n\nDataset table reload failed: {exc}"

    message = f"Import from ResQ completed.\nDatasets imported: {imported}{suffix}"
    _message(ui, message, kind="warning" if errors else "info", auto_close_ms=None if errors else 3000)
    return {"success": errors == 0, "message": message, "result": result}







