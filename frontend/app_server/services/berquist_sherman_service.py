"""Page open and file writes for the two Berquist Sherman methods.

Opening a page used to cost a Client PC two independent share visits made one
after the other: the output sidecar over the app server, then the method JSON
straight from the renderer's host API. The second one could never reach the
ArcRho Gateway at all, because a host-API file read does not enter the app
server, and the first one is heavier than it looks —
:func:`dataset_service.load_dataset_sidecar` also opens the project's
dataset-type rows and the reserving-class index.

Pairing them here turns the page open into one registered workspace read
(``arcrho_workspace_read_contract``), which the Gateway can run on the server
host where the workspace is local disk, exactly as DFM, BF, CC, RS, and
Bootstrap already do.

The save half writes the method JSON and the output CSV the page computed.
It exists so that no persisted project file is written from JavaScript: the
on-disk text of every ArcRho JSON file belongs to ``arcrho_api.io``, and a
renderer-side write bypassed it. The method payload itself is still taken as
the page built it — ``ui/method_pages/berquist_sherman`` owns that schema
together with the ResQ migration, so normalizing or defaulting it here would
stand up a competing source of truth for a contract this module does not own.
"""

from __future__ import annotations

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Mapping

from fastapi import HTTPException

from arcrho_api.io import persisted_json_text

from app_server import config
from app_server.services import dataset_sidecar_status_service, dataset_service


# The method JSON and the sidecar are independent files, so the two reads
# overlap; on a mapped drive that saves a full round trip per page open.
_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="arcrho-bs-read",
)

# The only method types this read may open, taken from the canonical table
# rather than restated as literals.
BERQUIST_SHERMAN_METHOD_TYPES = (
    dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR,
    dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_CRA,
)


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _read_json(path: str) -> Dict[str, Any]:
    """Return a parsed JSON object, or ``{}`` when the method has never saved."""

    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except PermissionError as exc:
        raise HTTPException(
            423, f"B&S file is locked or inaccessible: {os.path.basename(path)}"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            500, f"Invalid B&S JSON: {os.path.basename(path)}: {exc}"
        ) from exc
    return payload if isinstance(payload, dict) else {}


def berquist_sherman_method_path(
    project_name: str,
    reserving_class: str,
    method_type: str,
    method_name: str,
) -> str:
    """Resolve the canonical method JSON path for a B&S variant.

    The variant arrives from the browser and selects a filename prefix, so it is
    checked against the two B&S method types before it reaches the path builder.
    Without that check this read would open any method type's JSON — and it is a
    hosted read, so it would do so on the server host under the caller's
    identity.
    """

    # A method type and a source kind both name the variant, exactly as
    # ``method_json_path`` accepts either; an unrecognized value normalizes to
    # itself, so each candidate is checked rather than the first truthy one.
    normalized = next(
        (
            candidate
            for candidate in (
                dataset_sidecar_status_service.normalize_method_type(method_type),
                dataset_sidecar_status_service.normalize_method_type("", method_type),
            )
            if candidate in BERQUIST_SHERMAN_METHOD_TYPES
        ),
        "",
    )
    if not normalized:
        raise HTTPException(400, f"Not a Berquist Sherman method type: {method_type}")
    try:
        return dataset_sidecar_status_service.method_json_path(
            project_name,
            reserving_class,
            normalized,
            method_name,
        )
    except ValueError as exc:
        # An unresolvable project or reserving class, not a bad method type.
        raise HTTPException(400, str(exc)) from exc


def load_berquist_sherman_method(
    project_name: str,
    reserving_class: str,
    method_type: str,
    method_name: str,
) -> Dict[str, Any]:
    """Return the method JSON and the output sidecar for one B&S page open.

    A method that has never been saved is not an error: the page opens fresh
    from its Project Instance arguments, so ``exists`` is False and ``method``
    is None while the sidecar half is still served.
    """

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(
            400, "project_name, reserving_class, and method_name are required."
        )

    method_path = berquist_sherman_method_path(project, reserving, method_type, name)
    method_future = _READ_EXECUTOR.submit(_read_json, method_path)
    sidecar_future = _READ_EXECUTOR.submit(
        dataset_service.load_dataset_sidecar, project, reserving, name
    )
    method = method_future.result()
    sidecar = sidecar_future.result()

    return {
        "ok": True,
        "exists": bool(method),
        "method": method or None,
        "method_path": method_path,
        "sidecar": sidecar,
    }


def _output_csv_path(project_name: str, reserving_class: str, csv_file: Any) -> str:
    """Resolve the bare CSV file name the page chose inside the dataset cache.

    The page owns the cache file naming (it also names the CSV in the sidecar it
    saves next), so only the folder is decided here; a name carrying a path
    separator would let the browser steer the write outside that folder.
    """

    name = _clean(csv_file)
    if not name or os.path.basename(name) != name or not name.casefold().endswith(".csv"):
        raise HTTPException(400, f"Not a dataset cache file name: {csv_file!r}")
    return os.path.join(config.get_project_dataset_cache_dir(project_name, reserving_class), name)


def _read_text_if_file(path: str) -> str | None:
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def _commit_text_files(files: Mapping[str, str]) -> List[str]:
    """Replace each changed file atomically; an unchanged file is not rewritten."""

    changed: List[str] = []
    for path, text in files.items():
        if _read_text_if_file(path) == text:
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = f"{path}.{uuid.uuid4().hex}.tmp"
        try:
            with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            os.replace(temporary, path)
        except PermissionError as exc:
            raise HTTPException(423, f"B&S file is locked: {os.path.basename(path)}") from exc
        except OSError as exc:
            raise HTTPException(500, f"B&S write failed: {os.path.basename(path)}: {exc}") from exc
        finally:
            try:
                os.unlink(temporary)
            except OSError:
                pass
        changed.append(path)
    return changed


def save_berquist_sherman_method(
    project_name: str,
    reserving_class: str,
    method_type: str,
    method_name: str,
    method: Mapping[str, Any],
    *,
    csv_file: Any = None,
    output_csv: Any = None,
) -> Dict[str, Any]:
    """Write a B&S method JSON, and its output CSV when one is supplied.

    The method text is produced by ``arcrho_api.io.persisted_json_text`` — the
    one owner of the on-disk JSON layout — so a B&S file on disk is laid out
    exactly as every other persisted ArcRho JSON file. The payload's own
    identity must name the method being saved: the path is derived from
    ``method_name`` and the variant, and a payload that says otherwise would
    leave a file whose contents disagree with its name.

    The output sidecar is not written here. The page saves it next through the
    canonical ``/dataset/sidecar/save`` route, which is also what queues the
    dependent walk.
    """

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    name = _clean(method_name)
    if not project or not reserving or not name:
        raise HTTPException(
            400, "project_name, reserving_class, and method_name are required."
        )
    if not isinstance(method, Mapping) or not method:
        raise HTTPException(400, "B&S method payload must be a JSON object.")
    details = method.get("details_tab")
    details = details if isinstance(details, Mapping) else {}
    if _clean(details.get("name")).casefold() != name.casefold():
        raise HTTPException(409, "B&S method payload does not name the method being saved.")
    if not _clean(method.get("json_format")):
        raise HTTPException(400, "B&S method payload is missing json_format.")

    method_path = berquist_sherman_method_path(project, reserving, method_type, name)
    files: Dict[str, str] = {method_path: persisted_json_text(dict(method))}
    csv_path = ""
    if output_csv is not None:
        csv_path = _output_csv_path(project, reserving, csv_file)
        files[csv_path] = str(output_csv)
    with dataset_sidecar_status_service.reserving_class_io_lock(project, reserving):
        changed_paths = _commit_text_files(files)
    return {
        "ok": True,
        "method_path": method_path,
        "csv_path": csv_path,
        "csv_file": os.path.basename(csv_path) if csv_path else "",
        "changed_paths": changed_paths,
    }
