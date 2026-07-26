# <arcrho-macro>
# Title: Import ResQ Reserving Class
# Version: 1.2.4
# Release Note: Show bounded ResQ item errors returned by ArcRho Bridge.
# Description: Import all configured ResQ datasets and methods into the reserving-class path selected in the active Project Instance page.
# Scope: Reserving Class
# </arcrho-macro>

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import time
import uuid
from typing import Any, Callable


TITLE = "Import ResQ Reserving Class"
REQUEST_FUNCTION = "ImportResQReservingClass"
CONTRACT_VERSION = 1
BRIDGE_WORKER_MAX_AGE_SEC = 6
IMPORT_TIMEOUT_SEC = 60.0 * 60.0
POLL_INTERVAL_SEC = 1.0
REQUEST_CLAIM_TIMEOUT_SEC = 30.0
BRIDGE_WORKER_DIR = Path("runtime") / "instances" / "arcrho_bridge_worker"
BRIDGE_WORKER_ROLE = "bridge_worker"
REQUEST_RELATIVE_DIR = (
    Path("requests")
    / "RPC bridge"
    / "resq_reserving_class_import"
    / "requests"
)
STATUS_RELATIVE_DIR = REQUEST_RELATIVE_DIR.with_name("statuses")
REQUEST_ROOT = REQUEST_RELATIVE_DIR.parent
REQUIRED_REQUEST_FIELDS = (
    "Function",
    "ContractVersion",
    "RequestId",
    "ProjectName",
    "Path",
    "UserName",
    "ExportMode",
)
FORBIDDEN_PATH_FIELDS = ("StatusPath", "DataPath", "TargetPath", "ServerRoot")
ALLOWED_EXPORT_MODES = frozenset(
    {"configured", "all", "triangles", "vectors", "vector", "dfm", "dfms"}
)
STATUS_VALUES = frozenset({"processing", "success", "error"})
_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


class BridgeUnavailableError(RuntimeError):
    """Raised before publication when no ResQ-connected Bridge worker is live."""


class BridgeRequestError(RuntimeError):
    """Raised when a published Bridge request cannot complete successfully."""

    def __init__(self, message: str, *, status: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status or {}


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
        value = str(context.get(name) or "").strip()
        if value:
            return value
    return ""


def _has_import_context(context: object) -> bool:
    """Return whether a macro-runner context identifies an import target."""

    if not isinstance(context, dict):
        return False
    return bool(
        _context_value(context, "projectName", "project_name")
        and _context_value(context, "selectedPath", "selected_path", "path")
    )


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
        raise ValueError("Reserving-class path must be a relative logical ArcRho path.")
    return normalized


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
        "No active ArcRho Bridge worker was found. "
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{heartbeat_dir}]."
    )


def _request_paths(server_root: object, request_id: str) -> tuple[Path, Path]:
    root = Path(server_root)
    request_dir = root / REQUEST_RELATIVE_DIR
    status_dir = root / STATUS_RELATIVE_DIR
    return request_dir / f"{request_id}.json", status_dir / f"{request_id}.json"


def _user_name() -> str:
    try:
        return str(getpass.getuser() or "unknown").strip() or "unknown"
    except Exception:
        return "unknown"


def create_import_request(
    *,
    project_name: object,
    rc_path: object,
    request_id: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build the location-independent payload consumed by ArcRho Bridge."""

    identifier = str(request_id or uuid.uuid4().hex).strip()
    if not identifier:
        raise ValueError("Request ID is required.")
    payload: dict[str, Any] = {
        "Function": REQUEST_FUNCTION,
        "ContractVersion": CONTRACT_VERSION,
        "RequestId": identifier,
        "ProjectName": _logical_project_name(project_name),
        "Path": _logical_rc_path(rc_path),
        "UserName": _user_name(),
        "ExportMode": "configured",
    }
    return identifier, payload


def publish_import_request(
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


def _report_macro_activity() -> None:
    cancel_checker = globals().get("check_macro_cancelled")
    if callable(cancel_checker):
        cancel_checker()
    activity_reporter = globals().get("report_macro_activity")
    if callable(activity_reporter):
        activity_reporter()


def _progress_tone(status: object) -> str:
    normalized = str(status or "").strip().casefold()
    if normalized in {"error", "failed", "fail"}:
        return "error"
    if normalized in {"warning", "warn", "skipped"}:
        return "warning"
    if normalized in {"success", "complete", "completed"}:
        return "success"
    return ""


def _update_progress_from_status(progress, status: dict[str, Any]) -> None:
    if progress is None:
        return
    progress_payload = status.get("progress")
    detail = progress_payload if isinstance(progress_payload, dict) else {}
    state = str(status.get("status") or "").strip().casefold()
    label = str(detail.get("label") or detail.get("message") or status.get("message") or "").strip()
    if not label:
        label = "ArcRho Bridge is importing from ResQ" if state == "processing" else "Import from ResQ"
    try:
        progress.update(
            label=label,
            total=_safe_int(detail.get("total"), getattr(progress, "total", 0)),
            completed=_safe_int(detail.get("completed"), getattr(progress, "completed", 0)),
            tone=_progress_tone(detail.get("status") or state),
        )
    except Exception:
        pass


def wait_for_import_result(
    *,
    server_root: object,
    request_id: str,
    timeout_sec: float = IMPORT_TIMEOUT_SEC,
    poll_interval_sec: float = POLL_INTERVAL_SEC,
    claim_timeout_sec: float = REQUEST_CLAIM_TIMEOUT_SEC,
    progress=None,
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Poll the deterministic Bridge status file until a terminal result arrives."""

    if timeout_sec <= 0 or poll_interval_sec <= 0 or claim_timeout_sec <= 0:
        raise ValueError("Timeout, polling interval, and claim timeout must be positive.")
    _, status_path = _request_paths(server_root, request_id)
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
                    f"ArcRho Bridge returned a status for a different or missing request ID at "
                    f"[{status_path}]."
                )
            version = status.get("contract_version")
            if isinstance(version, bool) or version != CONTRACT_VERSION:
                raise BridgeRequestError(
                    f"ArcRho Bridge returned unsupported status contract version [{version!r}]."
                )
            _update_progress_from_status(progress, status)
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
        elif time.monotonic() >= claim_deadline:
            raise BridgeRequestError(
                f"ArcRho Bridge did not claim request [{request_id}] within "
                f"{claim_timeout_sec:g} seconds. Restart a current ArcRho Bridge worker "
                "and try the import again."
            )

        if not discover_live_bridge_workers(server_root):
            raise BridgeRequestError(
                "ArcRho Bridge became unavailable while the import was waiting for a result. "
                "The existing reserving-class data was left unchanged."
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(float(poll_interval_sec), remaining))

    raise BridgeRequestError(
        f"ArcRho Bridge request [{request_id}] timed out after {timeout_sec:g} seconds. "
        "The existing reserving-class data was left unchanged."
    )


def _status_result(status: dict[str, Any]) -> dict[str, Any]:
    result = status.get("result")
    return result if isinstance(result, dict) else status


def _summary_count(result: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        if key in result:
            return _safe_int(result.get(key))
    return None


def _success_message(project_name: str, rc_path: str, status: dict[str, Any]) -> str:
    result = _status_result(status)
    lines = ["Import from ResQ completed.", f"Project: {project_name}", f"Path: {rc_path}"]
    metrics = (
        ("Datasets imported", "datasets_imported", "total_written"),
        ("Methods imported", "methods_imported"),
        ("Skipped", "skipped"),
        ("Errors", "errors"),
    )
    for label, *keys in metrics:
        value = _summary_count(result, *keys)
        if value is not None:
            lines.append(f"{label}: {value}")
    detail = str(status.get("message") or result.get("message") or "").strip()
    if detail:
        lines.extend(("", detail))
    return "\n".join(lines)


def _failure_details_message(error: Exception) -> str:
    status = error.status if isinstance(error, BridgeRequestError) else {}
    result = _status_result(status)
    details = result.get("error_details") if isinstance(result, dict) else None
    if not isinstance(details, list):
        return ""
    lines = []
    for raw in details[:12]:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "item").strip()
        name = str(raw.get("name") or "unnamed").strip()
        detail = str(raw.get("message") or "Import failed.").strip()
        lines.append(f"- {kind} {name}: {detail}")
    return "\n\nDetails:\n" + "\n".join(lines) if lines else ""


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI, get_server_root

    ui = ArcRhoUI()
    progress = None
    project_name = ""
    rc_path = ""
    server_root = None
    request_id = ""
    try:
        # The macro window sends an informational, non-DFM context when a Project
        # Instance page has no open DFM. That context has no import target, so use
        # the Project Instance automation contract to read the selected path.
        context = (
            active_context
            if _has_import_context(active_context)
            else ui.project_instance.context(timeout_sec=10)
        )
        project_name = _logical_project_name(_context_value(context, "projectName", "project_name"))
        rc_path = _logical_rc_path(_context_value(context, "selectedPath", "selected_path", "path"))
    except Exception as exc:
        message = (
            "Activate a Project Instance page and select a valid reserving-class path "
            f"before importing from ResQ.\n\n{exc}"
        )
        _message(ui, message, kind="warning")
        return {"success": False, "message": message}

    try:
        server_root = Path(get_server_root(required=True))
        bridge_workers = require_live_bridge_workers(server_root)
    except BridgeUnavailableError as exc:
        message = (
            "No active ArcRho Bridge worker was detected, so the import was not started.\n\n"
            f"Project: {project_name}\nPath: {rc_path}\n\n{exc}"
        )
        _message(ui, message, title="ArcRho Bridge Unavailable", kind="error")
        return {"success": False, "message": message, "reason": "bridge_unavailable"}
    except Exception as exc:
        message = f"Could not prepare the ArcRho Bridge import.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}

    try:
        progress = ui.progress_bar(
            progress_id="import-resq-reserving-class",
            title=TITLE,
            label=f"Preparing import with {len(bridge_workers)} ArcRho Bridge worker(s)",
            total=0,
        )
    except Exception:
        progress = None

    try:
        request_id, payload = create_import_request(project_name=project_name, rc_path=rc_path)
        publish_import_request(server_root=server_root, request_id=request_id, payload=payload)
        if progress is not None:
            try:
                progress.update(label="ArcRho Bridge is importing from ResQ")
            except Exception:
                pass
        status = wait_for_import_result(
            server_root=server_root,
            request_id=request_id,
            progress=progress,
            on_poll=_report_macro_activity,
        )
    except Exception as exc:
        if progress is not None:
            try:
                progress.update(label="Import failed", tone="error")
            except Exception:
                pass
        message = f"Import from ResQ failed.\n\nProject: {project_name}\nPath: {rc_path}"
        if request_id:
            message += f"\nRequest: {request_id}"
        message += f"\n\n{exc}{_failure_details_message(exc)}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message, "request_id": request_id}

    result = _status_result(status)
    errors = _summary_count(result, "errors") or 0
    if progress is not None:
        try:
            progress.update(label="Import complete", tone="warning" if errors else "success")
            if not errors:
                progress.close(auto_close_ms=3000)
        except Exception:
            pass
    try:
        reload_info = ui.project_instance.reload_dataset_table(timeout_sec=30)
        dataset_table_reloaded = bool(reload_info.get("refreshed", True))
        reload_error = ""
    except Exception as exc:
        dataset_table_reloaded = False
        reload_error = str(exc)

    message = _success_message(project_name, rc_path, status)
    if reload_error:
        message += f"\n\nDataset table reload failed: {reload_error}"
    _message(ui, message, kind="warning" if errors or reload_error else "info", auto_close_ms=None if errors else 3000)
    return {
        "success": errors == 0,
        "message": message,
        "request_id": request_id,
        "result": result,
        "dataset_table_reloaded": dataset_table_reloaded,
    }


if __name__ == "__main__":
    print(run_macro())
