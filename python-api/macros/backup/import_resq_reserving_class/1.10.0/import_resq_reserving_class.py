# <arcrho-macro>
# Title: Import ResQ Reserving Class
# Version: 1.10.0
# Release Note: The reserving class is now copied to a dated backup folder under the server's backups\pre-import before the import runs, so an import can be undone later: every method, every input, calculated and method-output dataset with its data file, and the class index, in the class's own folder layout; engine-generated datasets are left out, the completion box names the folder, and the twenty most recent backups of a class are kept.
# Description: Import the ResQ datasets and methods you tick into the reserving-class path selected in the active Project Instance page, merging with or overwriting the existing ArcRho copies, after copying the existing class to a dated backup folder.
# Scope: Reserving Class
# </arcrho-macro>

from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import re
import shutil
import time
import uuid
from datetime import datetime
from typing import Any, Callable

# The liveness rule is shared with the sync macro and the app server's hosted
# read; the worker constants are re-exported here so the batch macro and the
# contract-parity test keep reading them from this adapter.
from arcrho_api.bridge_liveness import (  # noqa: F401
    BRIDGE_SILENCE_LIMIT_SEC,
    BRIDGE_WORKER_DIR,
    BRIDGE_WORKER_MAX_AGE_SEC,
    BRIDGE_WORKER_ROLE,
    QUEUE_STATUS_DIRS,
    BridgeSilenceTracker,
    await_bridge_signal,
    live_worker_names,
    observe_bridge_liveness,
)


TITLE = "Import ResQ Reserving Class"
REQUEST_FUNCTION = "ImportResQReservingClass"
# Version 2: the request may carry the dataset and method names the shared
# transfer review ticked. A Bridge still on version 1 would import everything
# regardless, so it refuses the request instead.
CONTRACT_VERSION = 2
IMPORT_TIMEOUT_SEC = 60.0 * 60.0
POLL_INTERVAL_SEC = 1.0
REQUEST_CLAIM_TIMEOUT_SEC = 30.0
QUEUE_NAME = "import"
STATUS_RELATIVE_DIR = QUEUE_STATUS_DIRS[QUEUE_NAME]
REQUEST_RELATIVE_DIR = STATUS_RELATIVE_DIR.with_name("requests")
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
# How existing ArcRho copies are treated. "merge" keeps ArcRho-only artifacts
# and any live copy newer than the staged ResQ result; "overwrite" lets the
# fresh ResQ copy win every conflict while still keeping ArcRho-only work.
ALLOWED_IMPORT_POLICIES = frozenset({"merge", "overwrite"})
IMPORT_POLICY_MERGE = "merge"
IMPORT_POLICY_OVERWRITE = "overwrite"
SELECTION_NAMES_FIELD = "SelectedNames"
# Engine-generated datasets whose values differ from ResQ's, as the Bridge
# reports them in the result beside error_details.
PARITY_WARNINGS_FIELD = "engine_parity_warnings"
STATUS_VALUES = frozenset({"processing", "success", "error"})
_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')

# Where the reserving class is copied before an import rewrites it. The Bridge
# keeps its own copy only until the commit succeeds, so this is the one lasting
# record of what the class held before the import. It sits beside the projects
# tree rather than inside it, so a project copy never carries the backups and
# nothing that walks a project's data folder can mistake one for a reserving
# class.
IMPORT_BACKUP_RELATIVE_DIR = Path("backups") / "pre-import"
IMPORT_BACKUP_MANIFEST_NAME = "backup.json"
# How many past imports of one reserving class keep their copy.
IMPORT_BACKUP_KEEP_PER_CLASS = 20
METHOD_DIR_NAME = "methods"
DATASET_DIR_NAME = "datasets"
SIDECAR_DIR_NAME = "sidecars"
PROJECTS_DIR_NAME = "projects"
PROJECT_DATA_DIR_NAME = "data"
INDEX_FILE_NAME = "index.json"
# The one dataset kind the backup leaves out. ArcRho rebuilds these from the
# source warehouse whenever the class is refreshed, so copying them would
# multiply the size of every backup for nothing recoverable. Every other kind
# is kept: a person's own inputs, the calculated datasets, and each method's
# output, so a restored class reads as it did without waiting for a refresh.
ENGINE_SOURCE_KIND = "engine"


class BridgeUnavailableError(RuntimeError):
    """Raised when no ResQ-connected Bridge worker has shown life for the silence limit."""


class BridgeRequestError(RuntimeError):
    """Raised when a published Bridge request cannot complete successfully."""

    def __init__(self, message: str, *, status: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status or {}


def _message(ui, text, *, title=TITLE, kind="info", auto_close_ms=None, buttons=None):
    kwargs = {
        "title": title,
        "kind": kind,
        "auto_close_ms": auto_close_ms,
        "timeout_sec": 120,
    }
    if buttons is not None:
        kwargs["buttons"] = list(buttons)
    return ui.message_box(str(text or ""), **kwargs)


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
        f"No active ArcRho Bridge worker was found: {tracker.describe()}. "
        f"Expected a ResQ-connected heartbeat newer than {BRIDGE_WORKER_MAX_AGE_SEC:g} "
        f"seconds under [{Path(server_root) / BRIDGE_WORKER_DIR}]."
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


_FILENAME_SEGMENT_REPLACEMENTS = {
    "\\": "_%5C_",
    "/": "_%2F_",
    ":": "_%3A_",
    "*": "_%2A_",
    "?": "_%3F_",
    '"': "_%22_",
    "<": "_%3C_",
    ">": "_%3E_",
    "|": "_%7C_",
}
_ENCODED_SEGMENT_RE = re.compile(r"_%([0-9A-Fa-f]{2})_")


def _encode_filename_segment(value: object) -> str:
    """Encode one logical name the way ArcRho names its folders and files."""

    encoded: list[str] = []
    for character in str(value if value is not None else ""):
        replacement = _FILENAME_SEGMENT_REPLACEMENTS.get(character)
        if replacement is not None:
            encoded.append(replacement)
        elif ord(character) < 32:
            encoded.append(f"_%{ord(character):02X}_")
        else:
            encoded.append(character)
    return "".join(encoded)


def _decode_filename_segment(value: object) -> str:
    def replace(match) -> str:
        try:
            return chr(int(match.group(1), 16))
        except (TypeError, ValueError):
            return match.group(0)

    return _ENCODED_SEGMENT_RE.sub(replace, str(value or ""))


def reserving_class_folder_name(rc_path: object) -> str:
    """The data folder name ArcRho gives a reserving-class path.

    The rule is the app server's own folder naming, repeated here because a
    macro is deployed as one self-contained file and cannot rely on the app's
    internals being importable on a user machine.
    """

    text = _encode_filename_segment(str(rc_path if rc_path is not None else "").strip())
    text = re.sub(r"[. ]+$", lambda match: "^" * len(match.group(0)), text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or "ReservingClass"


def _folder_reserving_class_name(folder: Path) -> str:
    """The class path a data folder holds, from its index or from its name."""

    try:
        with (folder / INDEX_FILE_NAME).open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        payload = None
    if isinstance(payload, dict):
        name = str(payload.get("reserving_class") or "").strip()
        if name:
            return name
    return _decode_filename_segment(folder.name).strip()


def find_reserving_class_dir(
    server_root: object,
    project_name: object,
    rc_path: object,
) -> Path | None:
    """The project's data folder for one reserving class, or None when it is new.

    The encoded folder name is tried first because that is what an import
    writes to. A folder named under an older rule is found instead by decoding
    each folder's own name, and only then by reading the class path each folder
    reports in its index -- the index of every class in a large project is a
    lot to read for a lookup that all but always ends at the first step.
    """

    data_dir = Path(server_root) / PROJECTS_DIR_NAME / str(project_name) / PROJECT_DATA_DIR_NAME
    direct = data_dir / reserving_class_folder_name(rc_path)
    if direct.is_dir():
        return direct
    wanted = str(rc_path or "").strip().casefold()
    if not wanted:
        return None
    try:
        entries = sorted(
            item
            for item in data_dir.iterdir()
            if item.is_dir() and not item.name.startswith(".")
        )
    except OSError:
        return None
    for entry in entries:
        if _decode_filename_segment(entry.name).strip().casefold() == wanted:
            return entry
    for entry in entries:
        if _folder_reserving_class_name(entry).casefold() == wanted:
            return entry
    return None


def prune_import_backups(class_backup_dir: Path, keep: int = IMPORT_BACKUP_KEEP_PER_CLASS) -> int:
    """Delete all but the newest ``keep`` backups of one reserving class."""

    try:
        stamps = sorted(item for item in class_backup_dir.iterdir() if item.is_dir())
    except OSError:
        return 0
    stale_count = max(len(stamps) - max(int(keep), 1), 0)
    removed = 0
    for stale in stamps[:stale_count]:
        try:
            shutil.rmtree(stale)
        except OSError:
            continue
        removed += 1
    return removed


def _folder_files(folder: Path) -> list[Path]:
    """Every file directly in one folder; subfolders are caches, not content."""

    try:
        return sorted(item for item in folder.iterdir() if item.is_file())
    except OSError:
        return []


def dataset_backup_plan(rc_dir: Path) -> dict[str, Any]:
    """Which dataset files to copy, and how many engine-generated ones to skip.

    A dataset is a sidecar and the data file it names. The sidecar records the
    kind ArcRho settled on for it, so the choice is read from the class itself
    rather than worked out again. Everything but an engine-generated dataset is
    copied, and a data file no sidecar claims is copied too: an unidentifiable
    file is exactly the one worth keeping.
    """

    sidecars: list[Path] = []
    datasets: list[Path] = []
    claimed: set[str] = set()
    skipped = 0
    dataset_dir = rc_dir / DATASET_DIR_NAME
    for sidecar in _folder_files(rc_dir / SIDECAR_DIR_NAME):
        try:
            with sidecar.open("r", encoding="utf-8-sig") as stream:
                payload = json.load(stream)
        except (OSError, UnicodeError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        data_file = str(payload.get("csv_file") or "").strip()
        if data_file:
            claimed.add(data_file.casefold())
        if str(payload.get("source_kind") or "").strip().casefold() == ENGINE_SOURCE_KIND:
            skipped += 1
            continue
        sidecars.append(sidecar)
        if data_file and (dataset_dir / data_file).is_file():
            datasets.append(dataset_dir / data_file)
    datasets.extend(
        item for item in _folder_files(dataset_dir) if item.name.casefold() not in claimed
    )
    return {
        "sidecars": sidecars,
        "datasets": sorted(set(datasets)),
        "engine_datasets_skipped": skipped,
    }


def backup_reserving_class(
    server_root: object,
    project_name: object,
    rc_path: object,
    *,
    import_policy: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Copy a reserving class aside before an import rewrites it.

    The copy holds every method, every dataset a person could have entered or
    edited, and the class index, in the same folder layout the class itself
    uses, so restoring it is a plain folder copy. Engine-generated datasets are
    left out; ArcRho rebuilds those from the source warehouse.

    Both import policies rewrite these files, so the copy is taken either way.
    The Bridge keeps its own copy only until its commit succeeds, so this one is
    what a later recovery reads. A backup that cannot be written is reported
    rather than raised: refusing the import would leave the person worse off
    than before there were backups at all, so the completion box says so
    instead.
    """

    backup: dict[str, Any] = {
        "files": 0,
        "methods": 0,
        "datasets": 0,
        "sidecars": 0,
        "engine_datasets_skipped": 0,
        "path": "",
        "error": "",
        "reason": "",
        "pruned": 0,
    }
    try:
        rc_dir = find_reserving_class_dir(server_root, project_name, rc_path)
        if rc_dir is None:
            backup["reason"] = "no_class_folder"
            return backup
        methods = _folder_files(rc_dir / METHOD_DIR_NAME)
        plan = dataset_backup_plan(rc_dir)
        backup["engine_datasets_skipped"] = plan["engine_datasets_skipped"]
        copies: list[tuple[Path, str]] = (
            [(item, f"{METHOD_DIR_NAME}/{item.name}") for item in methods]
            + [(item, f"{SIDECAR_DIR_NAME}/{item.name}") for item in plan["sidecars"]]
            + [(item, f"{DATASET_DIR_NAME}/{item.name}") for item in plan["datasets"]]
        )
        index_file = rc_dir / INDEX_FILE_NAME
        if index_file.is_file():
            copies.append((index_file, INDEX_FILE_NAME))
        if not copies:
            backup["reason"] = "nothing_to_back_up"
            return backup

        class_backup_dir = (
            Path(server_root)
            / IMPORT_BACKUP_RELATIVE_DIR
            / _encode_filename_segment(str(project_name))
            / rc_dir.name
        )
        stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
        target = class_backup_dir / stamp
        attempt = 1
        while target.exists():
            attempt += 1
            target = class_backup_dir / f"{stamp}-{attempt}"
        target.mkdir(parents=True)
        for source, relative in copies:
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        backup["files"] = len(copies)
        backup["methods"] = len(methods)
        backup["sidecars"] = len(plan["sidecars"])
        backup["datasets"] = len(plan["datasets"])
        backup["path"] = str(target)
        _write_backup_manifest(
            target,
            project_name=project_name,
            rc_path=rc_path,
            rc_dir=rc_dir,
            import_policy=import_policy,
            backup=backup,
            relative_names=[relative for _source, relative in copies],
        )
        backup["pruned"] = prune_import_backups(class_backup_dir)
    except Exception as exc:
        backup["error"] = str(exc)
    return backup


def _write_backup_manifest(
    target: Path,
    *,
    project_name: object,
    rc_path: object,
    rc_dir: Path,
    import_policy: str,
    backup: dict[str, Any],
    relative_names: list[str],
) -> None:
    """Record what the copy holds, so a later restore needs no guesswork."""

    payload = {
        "backup_of": "reserving class",
        "taken_at": datetime.now().isoformat(timespec="seconds"),
        "taken_by": _user_name(),
        "taken_before": "ResQ import",
        "import_policy": str(import_policy or IMPORT_POLICY_MERGE),
        "project_name": str(project_name),
        "reserving_class": str(rc_path),
        "source_dir": str(rc_dir),
        "restore_by": (
            "Copy the folders below back over the source folder, leaving this "
            "note behind, then reload the dataset table in the Project Instance "
            "page."
        ),
        "excluded": (
            "Engine-generated datasets; ArcRho rebuilds those from the source "
            "warehouse."
        ),
        "file_count": backup["files"],
        "method_count": backup["methods"],
        "sidecar_count": backup["sidecars"],
        "dataset_count": backup["datasets"],
        "engine_datasets_skipped": backup["engine_datasets_skipped"],
        "files": relative_names,
    }
    try:
        with (target / IMPORT_BACKUP_MANIFEST_NAME).open("w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
    except OSError:
        # The copies are the backup; a note that could not be written never
        # voids one.
        pass


def backup_sentence(backup: object) -> str:
    """One completion-box line describing the copy taken before the import."""

    entry = backup if isinstance(backup, dict) else {}
    error = str(entry.get("error") or "")
    if error:
        return (
            "WARNING - the existing reserving class could not be copied aside "
            f"before the import, so there is no restore point: {error}"
        )
    if not int(entry.get("files") or 0):
        return ""
    return (
        f"Backed up {entry.get('methods')} method(s) and "
        f"{entry.get('datasets')} dataset(s) to [{entry.get('path')}] before "
        f"importing; {entry.get('engine_datasets_skipped')} engine-generated "
        "dataset(s) were left out."
    )


def create_import_request(
    *,
    project_name: object,
    rc_path: object,
    request_id: str | None = None,
    import_policy: str = IMPORT_POLICY_MERGE,
    selected_names: list[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build the location-independent payload consumed by ArcRho Bridge.

    ``selected_names`` is what the shared transfer review ticked; omitting it
    asks for every dataset and method ResQ offers.
    """

    identifier = str(request_id or uuid.uuid4().hex).strip()
    if not identifier:
        raise ValueError("Request ID is required.")
    policy = str(import_policy or IMPORT_POLICY_MERGE).strip().casefold()
    if policy not in ALLOWED_IMPORT_POLICIES:
        raise ValueError("Import policy must be merge or overwrite.")
    payload: dict[str, Any] = {
        "Function": REQUEST_FUNCTION,
        "ContractVersion": CONTRACT_VERSION,
        "RequestId": identifier,
        "ProjectName": _logical_project_name(project_name),
        "Path": _logical_rc_path(rc_path),
        "UserName": _user_name(),
        "ExportMode": "configured",
    }
    # The field is optional in the Bridge contract, so a merge request stays
    # byte-compatible with a Bridge that predates the overwrite policy.
    if policy != IMPORT_POLICY_MERGE:
        payload["ImportPolicy"] = policy
    if selected_names is not None:
        names = [str(name or "").strip() for name in selected_names]
        names = [name for name in names if name]
        if not names:
            raise ValueError("At least one dataset or method must be selected.")
        payload[SELECTION_NAMES_FIELD] = names
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


def _message_button(response) -> str:
    """Clicked-button text from a UI command result, in any of its shapes."""

    button = getattr(response, "button", "")
    if button:
        return str(button)
    payload = getattr(response, "result", None)
    if isinstance(payload, dict) and payload.get("button"):
        return str(payload.get("button"))
    if isinstance(response, dict):
        inner = response.get("result")
        if isinstance(inner, dict) and inner.get("button"):
            return str(inner.get("button"))
        return str(response.get("button") or "")
    return ""


def choose_import_policy(ui, *, title: str = TITLE, scope_note: str = "") -> str | None:
    """Ask how existing ArcRho copies are treated; ``None`` means cancelled.

    Overwrite is destructive, so it takes a second, explicit confirmation.
    Anything other than a clear Overwrite or Cancel answer falls back to the
    non-destructive merge, so an automated caller keeps today's behavior.
    """

    scope_lines = f"{scope_note}\n\n" if scope_note else ""
    choice = _message(
        ui,
        scope_lines
        + "How should existing ArcRho data be treated?\n\n"
        + "Merge: keep datasets that exist only in ArcRho and any ArcRho copy "
        + "newer than the ResQ version.\n"
        + "Overwrite: the fresh ResQ copy replaces the ArcRho copy for "
        + "everything ResQ provides, even where the ArcRho copy is newer. "
        + "Datasets that exist only in ArcRho are kept either way.",
        title=title,
        kind="question",
        buttons=["Merge", "Overwrite", "Cancel"],
    )
    button = _message_button(choice).strip().casefold()
    if button == "cancel":
        return None
    if button != IMPORT_POLICY_OVERWRITE:
        return IMPORT_POLICY_MERGE
    if confirm_overwrite(ui, title=title, scope_note=scope_note):
        return IMPORT_POLICY_OVERWRITE
    return None


def confirm_overwrite(ui, *, title: str = TITLE, scope_note: str = "") -> bool:
    """The explicit second confirmation every overwrite import must pass."""

    scope_lines = f"{scope_note}\n\n" if scope_note else ""
    confirm = _message(
        ui,
        scope_lines
        + "Overwrite replaces every dataset and method output that ResQ "
        + "provides, discarding the current ArcRho copies and any edits made "
        + "to them, even recent ones. This cannot be undone.\n\n"
        + "Overwrite the existing ArcRho data?",
        title=title,
        kind="warning",
        buttons=["Overwrite", "Cancel"],
    )
    return _message_button(confirm).strip().casefold() == IMPORT_POLICY_OVERWRITE


def confirm_without_preview(ui, error) -> bool:
    """Ask whether to import when the comparison with ResQ could not be made.

    The comparison is a check, not a gate: a review the Bridge could not
    produce is reported, and the person decides whether to import everything.
    """

    confirmation = _message(
        ui,
        "The comparison with ResQ failed, so the datasets and methods cannot be "
        f"listed for review before the import.\n\n{error}\n\n"
        "Importing without the review brings across everything ResQ offers.",
        kind="warning",
        buttons=["Import Anyway", "Cancel"],
    )
    return _message_button(confirmation).strip().casefold() == "import anyway"


def review_import_plan(ui, root, project_name, rc_path, *, overwrite: bool) -> dict:
    """Compare both sides and let the person tick what the import brings across.

    Runs the shared queue's ``transfer_preview`` phase -- the same comparison
    the Export macro reviews, in the same window -- and returns the ticked
    names. Accepting the table is what starts the import; cancelling it
    publishes nothing.
    """

    from arcrho_api.resq_sync_queue import (
        DIRECTION_IMPORT,
        PHASE_TRANSFER_PREVIEW,
        PREVIEW_TIMEOUT_SEC,
        run_bridge_phase,
    )
    from arcrho_api.resq_transfer_review import review_transfer

    progress = ui.progress_bar(
        progress_id="import-resq-reserving-class-preview",
        title=TITLE,
        label=f"Comparing ArcRho and ResQ: {rc_path}",
        total=0,
    )
    preview_result = None
    failure = None
    try:
        preview_result = run_bridge_phase(
            server_root=root,
            project_name=project_name,
            rc_path=rc_path,
            phase=PHASE_TRANSFER_PREVIEW,
            direction=DIRECTION_IMPORT,
            timeout_sec=PREVIEW_TIMEOUT_SEC,
            progress=progress,
            progress_label=f"Comparing ArcRho and ResQ: {rc_path}",
            on_poll=_report_macro_activity,
        )
    except Exception as exc:
        failure = exc
    finally:
        try:
            progress.close()
        except Exception:
            pass
    if failure is not None:
        return {
            "status": "failed",
            "error": str(failure),
            "accepted": confirm_without_preview(ui, failure),
            "names": None,
        }
    preview = [row for row in preview_result.get("preview") or [] if isinstance(row, dict)]
    review = review_transfer(
        ui,
        preview,
        direction=DIRECTION_IMPORT,
        title=TITLE,
        accept_label="Import Selected from ResQ",
        project_name=project_name,
        rc_path=rc_path,
        connection_name=str(preview_result.get("connection_name") or ""),
        class_direction=dict(preview_result.get("class_direction") or {}),
        selection=dict(preview_result.get("selection") or {}),
        overwrite=overwrite,
        on_poll=_report_macro_activity,
    )
    return {
        "status": "reviewed",
        "accepted": review["accepted"],
        "names": review["names"],
        "preview": preview,
    }


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
            detail=label,
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
    """Poll the request's status until a terminal result arrives.

    Every poll is one liveness look that also carries the status file, so the
    worker is judged from the same observation the result comes from. Silence
    past the limit abandons the wait; it does not prove the import stopped.
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

        if not tracker.record(observation) and tracker.exceeded:
            raise BridgeUnavailableError(
                f"ArcRho Bridge request [{request_id}] was abandoned: {tracker.describe()}. "
                "Whether the import finished is unknown; if the Bridge was only slow it may "
                f"still complete. Check [{status_path}] before importing this reserving class "
                "again."
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


def import_selection_sentence(selection) -> str:
    """What the import remembered for the next review to open with."""

    entry = selection if isinstance(selection, dict) else {}
    error = str(entry.get("error") or "")
    if error:
        return f"The selection was not saved, so the next import opens with everything ticked. {error}"
    saved = int(entry.get("saved") or 0)
    if not saved:
        return ""
    return f"Saved the {saved} selected item(s) as the default for the next import."


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
    skipped = _detail_lines(result)
    if skipped:
        lines.extend((
            "",
            "Skipped (could not be exported from ResQ; any existing ArcRho copy is kept):",
            *skipped,
        ))
    parity = _detail_lines(result, PARITY_WARNINGS_FIELD)
    if parity:
        lines.extend((
            "",
            "WARNING - ArcRho Engine results that differ from ResQ at two decimal places "
            "(the Engine result was kept):",
            *parity,
        ))
    selection = import_selection_sentence(result.get("selection"))
    if selection:
        lines.extend(("", selection))
    detail = str(status.get("message") or result.get("message") or "").strip()
    if detail:
        lines.extend(("", detail))
    return "\n".join(lines)


def _dataset_table_reload_cost(reload_info: Any) -> str:
    """Describe a dataset-table reload that had to rebuild the index.

    Serving the persisted index costs three directory listings; rebuilding reads
    every sidecar and method payload and rewrites index.json, which on a network
    share is the difference between an instant reload and a slow one. Reporting
    the reason here puts it in front of the operator who just waited for it.
    """

    if not isinstance(reload_info, dict):
        return ""
    reason = str(reload_info.get("index_rebuild_reason") or "").strip()
    if not reason:
        return ""
    try:
        seconds = float(reload_info.get("index_elapsed_ms") or 0) / 1000.0
    except (TypeError, ValueError):
        seconds = 0.0
    elapsed = f" in {seconds:.1f}s" if seconds > 0 else ""
    return f"Dataset table index was rebuilt{elapsed} ({reason})."


def _detail_lines(result: object, field: str = "error_details") -> list[str]:
    """One display line per bounded per-item detail in a Bridge result."""

    details = result.get(field) if isinstance(result, dict) else None
    if not isinstance(details, list):
        return []
    lines = []
    for raw in details[:12]:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "item").strip()
        name = str(raw.get("name") or "unnamed").strip()
        detail = str(raw.get("message") or "Import failed.").strip()
        lines.append(f"- {kind} {name}: {detail}")
    return lines


def _failure_details_message(error: Exception) -> str:
    status = error.status if isinstance(error, BridgeRequestError) else {}
    lines = _detail_lines(_status_result(status))
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
        import_policy = choose_import_policy(
            ui,
            scope_note=f"Project: {project_name}\nPath: {rc_path}",
        )
    except Exception as exc:
        message = f"The import could not be prepared.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    if import_policy is None:
        message = "Import cancelled; nothing was changed."
        _message(ui, message, auto_close_ms=3000)
        return {"success": False, "message": message, "reason": "cancelled"}

    try:
        review = review_import_plan(
            ui,
            server_root,
            project_name,
            rc_path,
            overwrite=import_policy == IMPORT_POLICY_OVERWRITE,
        )
    except Exception as exc:
        message = f"The import could not be reviewed.\n\n{exc}"
        _message(ui, message, kind="error")
        return {"success": False, "message": message}
    if not review.get("accepted"):
        message = "Import cancelled; nothing was changed."
        _message(ui, message, auto_close_ms=3000)
        return {"success": False, "message": message, "reason": "cancelled", "review": review}
    selected_names = review.get("names")
    if selected_names is not None and not selected_names:
        message = "Nothing was selected, so nothing was imported."
        _message(ui, message, auto_close_ms=6000)
        return {
            "success": False,
            "message": message,
            "reason": "empty_selection",
            "review": review,
        }

    try:
        progress = ui.progress_bar(
            progress_id="import-resq-reserving-class",
            title=TITLE,
            label=f"Preparing import with {len(bridge_workers)} ArcRho Bridge worker(s)",
            total=0,
        )
    except Exception:
        progress = None

    if progress is not None:
        try:
            progress.update(label="Backing up the existing reserving class")
        except Exception:
            pass
    backup = backup_reserving_class(
        server_root,
        project_name,
        rc_path,
        import_policy=import_policy,
    )

    try:
        request_id, payload = create_import_request(
            project_name=project_name,
            rc_path=rc_path,
            import_policy=import_policy,
            selected_names=selected_names,
        )
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
        backup_note = backup_sentence(backup)
        if backup_note:
            message += f"\n\n{backup_note}"
        _message(ui, message, kind="error")
        return {
            "success": False,
            "message": message,
            "request_id": request_id,
            "backup": backup,
        }

    result = _status_result(status)
    errors = _summary_count(result, "errors") or 0
    # An Engine result that disagrees with ResQ is kept, but the person must
    # see it, so the completion box behaves as it does for a skipped item. A
    # backup that could not be taken is held open the same way.
    warnings = (
        errors
        or bool(_detail_lines(result, PARITY_WARNINGS_FIELD))
        or bool(backup.get("error"))
    )
    if progress is not None:
        try:
            progress.update(label="Import complete", tone="warning" if warnings else "success")
            if not warnings:
                progress.close(auto_close_ms=3000)
        except Exception:
            pass
    reload_info: dict = {}
    try:
        reload_info = ui.project_instance.reload_dataset_table(timeout_sec=30)
        dataset_table_reloaded = bool(reload_info.get("refreshed", True))
        reload_error = ""
    except Exception as exc:
        dataset_table_reloaded = False
        reload_error = str(exc)

    message = _success_message(project_name, rc_path, status)
    backup_note = backup_sentence(backup)
    if backup_note:
        message += f"\n\n{backup_note}"
    reload_cost = _dataset_table_reload_cost(reload_info)
    if reload_cost:
        message += f"\n\n{reload_cost}"
    if reload_error:
        message += f"\n\nDataset table reload failed: {reload_error}"
    _message(
        ui,
        message,
        kind="warning" if warnings or reload_error else "info",
        auto_close_ms=None if warnings else 3000,
    )
    return {
        "success": errors == 0,
        "message": message,
        "request_id": request_id,
        "result": result,
        "backup": backup,
        "dataset_table_reloaded": dataset_table_reloaded,
    }


if __name__ == "__main__":
    print(run_macro())
