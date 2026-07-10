# <arcrho-macro>
# Title: Import Active Dataset from ResQ
# Description: Import only the active Project Instance dataset, DFM method output, or Result Selection method output from ResQ.
# Scope: Dataset, DFM, Result Selection
# </arcrho-macro>

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import traceback

MIGRATION_SCRIPT = Path(r"E:\XWSpace\Repos\ArcRho\python-api\migration\resq_data_migration.py")
PROGRESS_ID = "import-resq-dataset"
PROGRESS_TITLE = "Import Active Dataset from ResQ"


def _load_resq_migration_module():
    if not MIGRATION_SCRIPT.exists():
        raise FileNotFoundError(f"ResQ migration script not found: {MIGRATION_SCRIPT}")
    module_dir = str(MIGRATION_SCRIPT.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location("arcrho_resq_data_migration", MIGRATION_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load ResQ migration script: {MIGRATION_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _message(ui, text, *, title=PROGRESS_TITLE, kind="info", auto_close_ms=None):
    try:
        return ui.message_box(text, title=title, kind=kind, auto_close_ms=auto_close_ms)
    except TypeError:
        return ui.message_box(text, title=title, kind=kind)


def _context_value(context, *names):
    if not isinstance(context, dict):
        return ""
    for name in names:
        value = context.get(name)
        if value not in (None, ""):
            return str(value)
    return ""


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _progress_tone(status):
    status_text = str(status or "").lower()
    if status_text == "error":
        return "danger"
    if status_text == "skipped":
        return "warning"
    if status_text == "success":
        return "success"
    return None


def _make_progress_callback(progress):
    def callback(event):
        if not isinstance(event, dict):
            return
        total = _safe_int(event.get("total"), 0)
        completed = _safe_int(event.get("completed"), 0)
        message = str(event.get("message") or event.get("name") or "Importing active dataset from ResQ")
        tone = _progress_tone(event.get("status"))
        try:
            progress.update(
                completed=completed if total > 0 else None,
                total=total if total > 0 else None,
                label=message,
                detail=message,
                tone=tone,
            )
        except TypeError:
            progress.update(completed=completed if total > 0 else None, total=total if total > 0 else None, label=message)

    return callback


def _property_value(properties, *names):
    for name in names:
        value = getattr(properties, name, "")
        if value not in (None, ""):
            return str(value)
    return ""


def _candidate_names(properties):
    names = []
    for attr_name in ("dataset_name", "item_name", "name"):
        value = str(getattr(properties, attr_name, "") or "").strip()
        if value and value not in names:
            names.append(value)
    return names


def _norm_key(migration, value):
    return migration._normalize_import_name(str(value or "")).casefold()


def _name_lookup(migration, names):
    lookup = {}
    for name in names:
        clean = str(name or "").strip()
        key = _norm_key(migration, clean)
        if key and key not in lookup:
            lookup[key] = clean
    return lookup


def _first_match(migration, lookup, candidates):
    for candidate in candidates:
        match = lookup.get(_norm_key(migration, candidate))
        if match:
            return match
    return ""


def _resolve_single_export(migration, reserving_class, properties):
    candidates = _candidate_names(properties)
    if not candidates:
        raise ValueError("The active Project Instance window does not expose a dataset or method name.")

    kind = str(getattr(properties, "kind", "") or "").strip().casefold()
    method_type = str(getattr(properties, "method_type", "") or "").strip().casefold()
    triangle_lookup = _name_lookup(migration, migration._triangle_export_names(reserving_class))
    vector_lookup = _name_lookup(migration, migration._vector_export_names(reserving_class))
    dfm_lookup = _name_lookup(migration, migration._dfm_export_names(reserving_class))

    vector_name = _first_match(migration, vector_lookup, candidates)
    triangle_name = _first_match(migration, triangle_lookup, candidates)
    dfm_name = _first_match(migration, dfm_lookup, candidates)

    if kind == "dfm" or method_type == "dfm":
        if vector_name:
            return {
                "export_kind": "vector",
                "names": [vector_name],
                "include_dfm_methods": True,
                "display_kind": "DFM output",
            }
        if dfm_name:
            return {"export_kind": "dfm", "names": [dfm_name], "include_dfm_methods": False, "display_kind": "DFM method"}
        raise ValueError(f"Active DFM target was not found in ResQ: {candidates[0]}")

    if kind == "result_selection" or method_type in {"result selection", "result_selection"}:
        if vector_name:
            return {
                "export_kind": "vector",
                "names": [vector_name],
                "include_dfm_methods": False,
                "include_bf_methods": False,
                "display_kind": "Result Selection output",
            }
        raise ValueError(f"Active Result Selection output was not found in ResQ vectors: {candidates[0]}")

    if kind == "bornhuetter_ferguson" or method_type in {"bornhuetter ferguson", "bornhuetter_ferguson"}:
        if vector_name:
            return {
                "export_kind": "vector",
                "names": [vector_name],
                "include_dfm_methods": False,
                "include_bf_methods": True,
                "display_kind": "Bornhuetter Ferguson output",
            }
        raise ValueError(f"Active Bornhuetter Ferguson output was not found in ResQ vectors: {candidates[0]}")

    matches = []
    if triangle_name:
        matches.append(("triangle", triangle_name))
    if vector_name:
        matches.append(("vector", vector_name))
    if dfm_name:
        matches.append(("dfm", dfm_name))

    unique_kinds = {(kind_name, name) for kind_name, name in matches}
    if len(unique_kinds) > 1:
        details = ", ".join(f"{kind_name} '{name}'" for kind_name, name in matches)
        raise ValueError(f"Active target name is ambiguous in ResQ: {details}")
    if not matches:
        raise ValueError(f"Active target was not found in ResQ triangles, vectors, or DFM methods: {candidates[0]}")

    export_kind, name = matches[0]
    return {
        "export_kind": export_kind,
        "names": [name],
        "include_dfm_methods": export_kind == "vector",
        "include_bf_methods": export_kind == "vector",
        "display_kind": export_kind,
    }


def _safe_collection_item(collection, name):
    try:
        return collection.Item(name)
    except Exception:
        return None


def _output_vector_name(migration, item):
    output_vector = migration._safe_attr(item, "OutputVector", None)
    return migration._normalize_import_name(migration._safe_attr(output_vector, "Name", ""))


def _cleanup_active_target_artifacts(migration, reserving_class, rc_dir, target):
    dataset_names = set(target.get("names") or [])
    method_names = set()
    export_kind = str(target.get("export_kind") or "").strip().casefold()

    if export_kind == "dfm":
        dfm_collection = reserving_class.DFMMethods()
        for dfm_name in list(target.get("names") or []):
            method_names.add(dfm_name)
            dfm = _safe_collection_item(dfm_collection, dfm_name)
            output_name = _output_vector_name(migration, dfm) if dfm is not None else ""
            if output_name:
                dataset_names.add(output_name)

    if export_kind == "vector":
        vector_collection = reserving_class.Vectors()
        dfm_by_output = None
        for vector_name in list(target.get("names") or []):
            vector = _safe_collection_item(vector_collection, vector_name)
            method_type = migration._safe_int_attr(vector, "MethodType", -1) if vector is not None else -1
            if method_type == migration.METHOD_TYPE_DFM_CODE and target.get("include_dfm_methods"):
                if dfm_by_output is None:
                    dfm_by_output = migration._dfm_methods_by_output_name(reserving_class, None)
                dfm_entry = dfm_by_output.get(migration._normalize_import_name(vector_name).casefold())
                if dfm_entry:
                    dfm_name, dfm = dfm_entry
                    method_names.add(dfm_name)
                    output_name = _output_vector_name(migration, dfm)
                    if output_name:
                        dataset_names.add(output_name)
            elif method_type == migration.METHOD_TYPE_RESULT_SELECTION_CODE:
                method_names.add(vector_name)
                result_selection = migration._find_result_selection_for_vector(reserving_class, vector_name)
                if result_selection is not None:
                    method_name = migration._normalize_import_name(migration._safe_attr(result_selection, "Name", ""))
                    output_name = _output_vector_name(migration, result_selection)
                    if method_name:
                        method_names.add(method_name)
                    if output_name:
                        dataset_names.add(output_name)
                        method_names.add(output_name)
            elif method_type == migration.METHOD_TYPE_BF_CODE and target.get("include_bf_methods"):
                method_names.add(vector_name)
                bf_method = migration._find_bornhuetter_ferguson_for_vector(reserving_class, vector_name)
                if bf_method is not None:
                    method_name = migration._normalize_import_name(migration._safe_attr(bf_method, "Name", ""))
                    output_name = _output_vector_name(migration, bf_method)
                    if method_name:
                        method_names.add(method_name)
                    if output_name:
                        dataset_names.add(output_name)
                        method_names.add(output_name)

    return migration.cleanup_target_dataset_artifacts(
        rc_dir,
        dataset_names=sorted(name for name in dataset_names if str(name or "").strip()),
        method_names=sorted(name for name in method_names if str(name or "").strip()),
    )


def _import_active_dataset_from_resq(migration, project_name, rc_path, properties, server_root, progress_callback):
    try:
        import win32com.client
    except ImportError as exc:
        raise RuntimeError("pywin32 is required: pip install pywin32") from exc

    previous_scope = migration._apply_runtime_scope(project_name, server_root)
    try:
        migration.PROJECT_DATA_DIR.mkdir(parents=True, exist_ok=True)
        rc_dir = migration.PROJECT_DATA_DIR / migration._encode_rc_folder(rc_path)
        rc_dir.mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.DATASET_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.METHOD_DATA_DIR).mkdir(parents=True, exist_ok=True)
        (rc_dir / migration.DATASET_SIDECAR_DIR).mkdir(parents=True, exist_ok=True)

        progress_callback({"event": "connect", "completed": 0, "total": 0, "message": f"Connecting to ResQ: {migration.CONNECTION_NAME}"})
        app = win32com.client.Dispatch("ResQ3Automation.ResQApplication")
        try:
            app.ConnectByName(migration.CONNECTION_NAME, migration.USER_NAME, migration.PASSWORD)
        except Exception as exc:
            raise RuntimeError(f"Could not connect to ResQ COM API ({migration.CONNECTION_NAME}): {exc}") from exc

        project = app.Projects().Item(migration.PROJECT_NAME)
        reserving_class = project.ReservingClasses().Item(rc_path)
        target = _resolve_single_export(migration, reserving_class, properties)
        names = list(target["names"])
        cleaned_files, cleaned_dirs = _cleanup_active_target_artifacts(migration, reserving_class, rc_dir, target)
        progress_state = {"completed": 0, "total": len(names), "skipped": 0, "count_methods": target["export_kind"] == "dfm"}
        progress_callback({"event": "total", "completed": 0, "total": len(names), "message": f"Importing {target['display_kind']}: {names[0]}"})

        counts = {"triangles_written": 0, "vectors_written": 0, "dfms_written": 0, "bfs_written": 0, "errors": 0}
        if target["export_kind"] == "triangle":
            written, errors = migration.export_triangles_for_rc(
                reserving_class,
                rc_path,
                rc_dir,
                progress_callback=progress_callback,
                progress_state=progress_state,
                triangle_names=names,
                verbose=False,
            )
            counts["triangles_written"] += written
            counts["errors"] += errors
        elif target["export_kind"] == "vector":
            written, errors = migration.export_vectors_for_rc(
                reserving_class,
                rc_path,
                rc_dir,
                progress_callback=progress_callback,
                progress_state=progress_state,
                vector_names=names,
                include_dfm_methods=bool(target.get("include_dfm_methods")),
                include_bf_methods=bool(target.get("include_bf_methods")),
                dfm_names=None,
                method_counts=counts,
                verbose=False,
            )
            counts["vectors_written"] += written
            counts["errors"] += errors
        elif target["export_kind"] == "dfm":
            written, errors = migration.export_dfms_for_rc(
                reserving_class,
                rc_path,
                rc_dir,
                progress_callback=progress_callback,
                progress_state=progress_state,
                dfm_names=names,
                verbose=False,
            )
            counts["dfms_written"] += written
            counts["errors"] += errors
        else:
            raise ValueError(f"Unsupported export kind: {target['export_kind']}")

        total_written = (
            counts["triangles_written"]
            + counts["vectors_written"]
            + counts["dfms_written"]
            + counts["bfs_written"]
        )
        refreshed = 0
        if total_written:
            refreshed = migration.refresh_sidecar_graphs_for_rc(rc_dir)
            migration.rebuild_dataset_instance_index(migration.PROJECT_NAME, rc_path, rc_dir)
        return {
            "project_name": migration.PROJECT_NAME,
            "rc_path": rc_path,
            "target_name": names[0],
            "target_kind": target["display_kind"],
            "written": total_written,
            "errors": counts["errors"],
            "skipped": int(progress_state.get("skipped") or 0),
            "cleaned_files": cleaned_files,
            "cleaned_dirs": cleaned_dirs,
            "refreshed_sidecars": refreshed,
            "migration_path": str(MIGRATION_SCRIPT),
        }
    finally:
        migration._restore_runtime_scope(previous_scope)


def _method_type_for_reopen(properties):
    method_type = str(getattr(properties, "method_type", "") or "").strip()
    kind = str(getattr(properties, "kind", "") or "").strip().casefold()
    if method_type:
        return method_type
    if kind == "dfm":
        return "DFM"
    if kind == "result_selection":
        return "Result Selection"
    if kind == "bornhuetter_ferguson":
        return "Bornhuetter Ferguson"
    return ""


def _reopen_active_target_window(ui, window, properties, target_name):
    target = str(target_name or "").strip() or (_candidate_names(properties)[0] if _candidate_names(properties) else "")
    if not target:
        return {"reopened": False, "reason": "missing_target_name"}

    method_type = _method_type_for_reopen(properties)
    open_method = method_type.strip().casefold() in {"dfm", "result selection", "bornhuetter ferguson"}
    closed = False
    try:
        closed = bool(window.close(timeout_sec=15))
    except Exception as exc:
        return {"reopened": False, "closed": False, "error": str(exc)}

    try:
        reopened = ui.project_instance.open_dataset(
            target,
            method_type=method_type or None,
            open_method=open_method,
            timeout_sec=30,
        )
        return {
            "reopened": bool(reopened),
            "closed": closed,
            "target_name": target,
            "method_type": method_type,
            "window_id": getattr(reopened, "window_id", ""),
        }
    except Exception as exc:
        return {"reopened": False, "closed": closed, "target_name": target, "method_type": method_type, "error": str(exc)}


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    progress = None
    try:
        context = active_context if isinstance(active_context, dict) else ui.project_instance.context(timeout_sec=10)
        window = ui.project_instance.active_window(timeout_sec=10)
        if window is None:
            _message(
                ui,
                "Activate a Project Instance dataset or method window before importing one item from ResQ.",
                kind="warning",
                auto_close_ms=7000,
            )
            return {"status": "cancelled", "reason": "no_active_window"}

        properties = window.get_properties(timeout_sec=10)
        if properties.dirty:
            _message(
                ui,
                "Save or close unsaved changes in the active dataset or method window before importing from ResQ.",
                kind="warning",
                auto_close_ms=9000,
            )
            return {"status": "cancelled", "reason": "active_window_dirty"}

        project_name = _context_value(context, "projectName", "project_name") or _property_value(properties, "project_name")
        rc_path = _context_value(context, "selectedPath", "selected_path", "path") or _property_value(properties, "selected_path", "path")
        if not project_name or not rc_path:
            _message(
                ui,
                "Open a Project Instance reserving class before importing from ResQ.",
                kind="warning",
                auto_close_ms=7000,
            )
            return {"status": "cancelled", "reason": "missing_project_context", "context": context}

        candidates = _candidate_names(properties)
        if not candidates:
            _message(
                ui,
                "The active window does not expose a dataset or method name to import from ResQ.",
                kind="warning",
                auto_close_ms=7000,
            )
            return {"status": "cancelled", "reason": "missing_target_name"}

        server_root = get_server_root(required=True)
        migration = _load_resq_migration_module()
        progress = ui.progress_bar(
            progress_id=PROGRESS_ID,
            title=PROGRESS_TITLE,
            label=f"Preparing ResQ import: {candidates[0]}",
            total=1,
        )
        progress_callback = _make_progress_callback(progress)
        result = _import_active_dataset_from_resq(migration, project_name, rc_path, properties, server_root, progress_callback)
        result["status"] = "completed" if int(result.get("errors") or 0) == 0 else "completed_with_errors"
        try:
            ui.project_instance.reload_dataset_table(timeout_sec=30)
            result["dataset_table_reloaded"] = True
        except Exception as exc:
            result["dataset_table_reloaded"] = False
            result["reload_error"] = str(exc)

        if int(result.get("written") or 0) > 0:
            result["active_window_refresh"] = _reopen_active_target_window(ui, window, properties, result.get("target_name"))
        else:
            result["active_window_refresh"] = {"reopened": False, "reason": "nothing_written"}

        try:
            progress.update(completed=1, total=1, label="Import complete", detail="Import complete", tone="success" if result["status"] == "completed" else "warning")
        except Exception:
            pass

        if int(result.get("written") or 0) <= 0 and int(result.get("errors") or 0) == 0:
            kind = "warning"
            summary = "No files were imported. The target may have been skipped by the ResQ migration filters."
        else:
            kind = "success" if result["status"] == "completed" else "warning"
            summary = (
                f"Import Active Dataset from ResQ completed for:\n"
                f"{result.get('target_name')} ({result.get('target_kind')})\n\n"
                f"Written: {result.get('written', 0)}\n"
                f"Skipped: {result.get('skipped', 0)}\n"
                f"Errors: {result.get('errors', 0)}\n"
                f"Project: {result.get('project_name')}\n"
                f"Path: {result.get('rc_path')}"
            )
        _message(ui, summary, kind=kind, auto_close_ms=9000)
        return result
    except Exception as exc:
        if progress is not None:
            try:
                progress.update(label="Import failed", detail=str(exc), tone="danger")
            except Exception:
                pass
        tb = traceback.format_exc()
        _message(ui, f"Import Active Dataset from ResQ failed:\n{exc}\n\n{tb}", kind="error")
        return {"status": "error", "error": str(exc), "traceback": tb}
    finally:
        if progress is not None:
            try:
                progress.close(auto_close_ms=1200)
            except Exception:
                pass


if __name__ == "__main__":
    print(run_macro())
