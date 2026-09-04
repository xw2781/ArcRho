"""The copy taken of a reserving class before a ResQ import rewrites it.

``Import ResQ Reserving Class`` and ``Import ResQ Reserving Classes`` copy the
class aside so an import that turned out wrong can be undone. The copy is one
file at a time -- every method, every sidecar a person could have edited, every
data file those sidecars name, and the class index -- which is why where it runs
matters so much: on a Client PC each of those copies is its own round trip over
the mapped drive, and on the server host they are local disk.

This module is the one definition of that copy, so the macros, the app server's
hosted mutation, and the Bridge cannot drift apart in what a backup holds. It
owns three things:

``back_up_reserving_class_on_disk``
    The copy itself, wherever it runs.
``back_up_reserving_class``
    The transport choice: inside the ArcRho app the copy runs on the server
    host through the ``resq_import_backup`` hosted mutation, and it falls back
    to the mapped drive only where the app server cannot be imported at all,
    which is a script outside the app, never a Client PC inside it.
``backup_sentence``
    The line the completion box shows about it.

The mutation contract requires every hosted kind to be idempotent, and this one
is because the caller owns the backup id: an id whose copy the server already
finished is reported as it stands rather than copied a second time. A backup
whose outcome the server never confirmed is reported as unknown, never taken
again over the share, because the second run would be reasoning about a
workspace the first one may already have written to.

A backup that fails never stops an import. Refusing to import would leave the
person worse off than they were before there were backups at all, so every
failure comes back in the result for the completion box to warn about.
"""

from __future__ import annotations

import getpass
import json
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


BACKUP_MUTATION_KIND = "resq_import_backup"
# Where a reserving class is copied before an import rewrites it. The Bridge
# keeps its own copy only until its commit succeeds, so this is the one lasting
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
IMPORT_POLICY_MERGE = "merge"
# The one dataset kind the backup leaves out. ArcRho rebuilds these from the
# source warehouse whenever the class is refreshed, so copying them would
# multiply the size of every backup for nothing recoverable. Every other kind
# is kept: a person's own inputs, the calculated datasets, and each method's
# output, so a restored class reads as it did without waiting for a refresh.
ENGINE_SOURCE_KIND = "engine"

# The backup id is the folder stamp plus a tag, so two people importing the
# same class in the same second still get a folder each while a retry of one
# request finds the copy it already asked for.
_BACKUP_STAMP_FORMAT = "%Y%m%d-%H%M%S"
_BACKUP_ID_RE = re.compile(r"^(\d{8}-\d{6})-([0-9a-f]{8})$")


def new_backup_id(now: datetime | None = None) -> str:
    """A fresh id naming one backup: the folder stamp and a tag unique to it."""

    stamp = (now or datetime.now()).strftime(_BACKUP_STAMP_FORMAT)
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def validate_backup_id(value: object) -> str:
    """The id as this module writes them, or a refusal before anything is copied."""

    identifier = str(value or "").strip().casefold()
    if not _BACKUP_ID_RE.match(identifier):
        raise ValueError(
            "A backup id must be a timestamp and tag, as in 20260904-131500-a1b2c3d4."
        )
    return identifier


def _backup_stamp(backup_id: str) -> str:
    """The folder name an id asks for, so both transports choose the same one."""

    return validate_backup_id(backup_id)[:15]


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


def encode_filename_segment(value: object) -> str:
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


def decode_filename_segment(value: object) -> str:
    def replace(match) -> str:
        try:
            return chr(int(match.group(1), 16))
        except (TypeError, ValueError):
            return match.group(0)

    return _ENCODED_SEGMENT_RE.sub(replace, str(value or ""))


def reserving_class_folder_name(rc_path: object) -> str:
    """The data folder name ArcRho gives a reserving-class path."""

    text = encode_filename_segment(str(rc_path if rc_path is not None else "").strip())
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
    return decode_filename_segment(folder.name).strip()


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
    lot to read for a lookup that all but always ends at the first step, and it
    is exactly the step that costs a Client PC one round trip per class.
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
        if decode_filename_segment(entry.name).strip().casefold() == wanted:
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


def _empty_backup(backup_id: str = "") -> dict[str, Any]:
    return {
        "backup_id": backup_id,
        "files": 0,
        "methods": 0,
        "datasets": 0,
        "sidecars": 0,
        "engine_datasets_skipped": 0,
        "path": "",
        "error": "",
        "reason": "",
        "pruned": 0,
        "reused": False,
        "unconfirmed": False,
    }


def _finished_backup_manifest(target: Path, backup_id: str) -> dict[str, Any] | None:
    """The manifest of a finished copy carrying this id, when there is one.

    A folder without a manifest is a copy that stopped part way, so it is
    written over rather than trusted; that is what keeps a repeat of the same
    request landing on the same end state.
    """

    try:
        with (target / IMPORT_BACKUP_MANIFEST_NAME).open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload if str(payload.get("backup_id") or "") == backup_id else None


def _resolve_backup_target(
    class_backup_dir: Path,
    backup_id: str,
) -> tuple[Path, dict[str, Any] | None]:
    """The folder this id's copy belongs in, and the copy already in it.

    Only a folder named for this id's own stamp can hold it, so the search is
    the stamp and its collision suffixes rather than every backup of the class.
    """

    stamp = _backup_stamp(backup_id)
    target = class_backup_dir / stamp
    attempt = 1
    while target.exists():
        manifest = _finished_backup_manifest(target, backup_id)
        if manifest is not None:
            return target, manifest
        attempt += 1
        target = class_backup_dir / f"{stamp}-{attempt}"
    return target, None


def _backup_from_manifest(target: Path, manifest: dict[str, Any], backup_id: str) -> dict[str, Any]:
    backup = _empty_backup(backup_id)
    backup.update(
        {
            "files": int(manifest.get("file_count") or 0),
            "methods": int(manifest.get("method_count") or 0),
            "sidecars": int(manifest.get("sidecar_count") or 0),
            "datasets": int(manifest.get("dataset_count") or 0),
            "engine_datasets_skipped": int(manifest.get("engine_datasets_skipped") or 0),
            "path": str(target),
            "reused": True,
        }
    )
    return backup


def back_up_reserving_class_on_disk(
    server_root: object,
    project_name: object,
    rc_path: object,
    *,
    backup_id: str = "",
    import_policy: str = "",
    taken_by: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Copy a reserving class aside, wherever this runs.

    The copy holds every method, every dataset a person could have entered or
    edited, and the class index, in the same folder layout the class itself
    uses, so restoring it is a plain folder copy. Engine-generated datasets are
    left out; ArcRho rebuilds those from the source warehouse.

    Both import policies rewrite these files, so the copy is taken either way.
    A backup that cannot be written is reported rather than raised.
    """

    identifier = str(backup_id or "").strip().casefold() or new_backup_id(now)
    backup = _empty_backup(identifier)
    try:
        identifier = validate_backup_id(identifier)
        rc_dir = find_reserving_class_dir(server_root, project_name, rc_path)
        if rc_dir is None:
            backup["reason"] = "no_class_folder"
            return backup
        class_backup_dir = (
            Path(server_root)
            / IMPORT_BACKUP_RELATIVE_DIR
            / encode_filename_segment(str(project_name))
            / rc_dir.name
        )
        target, finished = _resolve_backup_target(class_backup_dir, identifier)
        if finished is not None:
            # This very request already ran here; saying so beats copying the
            # class a second time under a second folder.
            return _backup_from_manifest(target, finished, identifier)

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

        target.mkdir(parents=True, exist_ok=True)
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
            backup_id=identifier,
            project_name=project_name,
            rc_path=rc_path,
            rc_dir=rc_dir,
            import_policy=import_policy,
            taken_by=taken_by,
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
    backup_id: str,
    project_name: object,
    rc_path: object,
    rc_dir: Path,
    import_policy: str,
    taken_by: str,
    backup: dict[str, Any],
    relative_names: list[str],
) -> None:
    """Record what the copy holds, so a later restore needs no guesswork.

    The manifest is written last, so a folder without one is a copy that
    stopped part way and the id it was asked for is free to be tried again.
    """

    payload = {
        "backup_of": "reserving class",
        "backup_id": backup_id,
        "taken_at": datetime.now().isoformat(timespec="seconds"),
        # Hosted, the copy runs under the ArcRho Server's own profile, so the
        # person who asked for it is passed in rather than read from here.
        "taken_by": str(taken_by or "").strip() or _user_name(),
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
        # voids one. It does leave the id free to be asked for again, which is
        # the safe direction: a second copy costs a folder, a skipped one costs
        # the restore point.
        pass


def back_up_reserving_class(
    server_root: object,
    project_name: object,
    rc_path: object,
    *,
    import_policy: str = "",
    backup_id: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Take the copy on the server host when the app can, else on this machine.

    Inside the ArcRho app the whole copy runs where the workspace is local
    disk, so a Client PC pays one request instead of one round trip per file.
    The mapped drive is used only where the app server cannot be imported at
    all, which is a script outside the app, never a Client PC inside it.

    A gateway failure that proves nothing was written falls back to the drive;
    one the server may already have acted on is reported as unknown instead,
    because a second copy taken from here would be reasoning about a workspace
    the first one already wrote to.
    """

    identifier = str(backup_id or "").strip().casefold() or new_backup_id(now)
    try:
        identifier = validate_backup_id(identifier)
    except ValueError as exc:
        backup = _empty_backup(identifier)
        backup["error"] = str(exc)
        return backup

    kwargs: dict[str, Any] = {
        "project_name": str(project_name),
        "reserving_class": str(rc_path),
        "backup_id": identifier,
        "import_policy": str(import_policy or IMPORT_POLICY_MERGE),
    }
    def on_this_machine() -> dict[str, Any]:
        return back_up_reserving_class_on_disk(
            server_root,
            project_name,
            rc_path,
            backup_id=identifier,
            import_policy=import_policy,
            now=now,
        )

    try:
        from app_server.services import resq_import_backup_service, workspace_mutation_client
    except ImportError:
        return on_this_machine()
    try:
        result = workspace_mutation_client.run_workspace_mutation(
            BACKUP_MUTATION_KIND,
            kwargs,
            local=lambda: resq_import_backup_service.back_up_reserving_class_for_import(**kwargs),
        )
    except Exception as exc:
        backup = _empty_backup(identifier)
        detail = getattr(exc, "detail", None) or exc
        backup["error"] = str(detail)
        backup["unconfirmed"] = True
        return backup
    if not isinstance(result, dict):
        backup = _empty_backup(identifier)
        backup["error"] = "The ArcRho Server did not describe the copy it took."
        backup["unconfirmed"] = True
        return backup
    merged = _empty_backup(identifier)
    merged.update(result)
    return merged


def backup_sentence(backup: object) -> str:
    """One completion-box line describing the copy taken before the import."""

    entry = backup if isinstance(backup, dict) else {}
    error = str(entry.get("error") or "")
    if error and entry.get("unconfirmed"):
        return (
            "WARNING - ArcRho Server did not confirm the copy of the existing "
            "reserving class, so whether there is a restore point is unknown. "
            f"Look under [{IMPORT_BACKUP_RELATIVE_DIR}] before importing this "
            f"class again: {error}"
        )
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
