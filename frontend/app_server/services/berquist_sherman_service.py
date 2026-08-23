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

The save half is the mirror image: one registered hosted save
(``arcrho_engine_save_contract``) writes the method JSON, the output CSV the
page computed, and the output sidecar together, so the whole save runs on the
server host too. It exists so that no persisted project file is written from
JavaScript: the on-disk text of every ArcRho JSON file belongs to
``arcrho_api.io``, and a renderer-side write bypassed it. The method payload
itself is still taken as the page built it — ``ui/method_pages/berquist_sherman``
owns that schema together with the ResQ migration, so normalizing or defaulting
it here would stand up a competing source of truth for a contract this module
does not own.
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
from app_server.services import (
    dataset_service,
    dataset_sidecar_status_service,
    dependent_propagation_service,
)


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


def _method_identity(method: Mapping[str, Any], method_name: str) -> str:
    """Return the method name both the payload and the request agree on."""

    name = _clean(method_name)
    if not name:
        raise HTTPException(400, "method_name is required.")
    if not isinstance(method, Mapping) or not method:
        raise HTTPException(400, "B&S method payload must be a JSON object.")
    details = method.get("details_tab")
    details = details if isinstance(details, Mapping) else {}
    if _clean(details.get("name")).casefold() != name.casefold():
        raise HTTPException(409, "B&S method payload does not name the method being saved.")
    if not _clean(method.get("json_format")):
        raise HTTPException(400, "B&S method payload is missing json_format.")
    return name


def _sidecar_call(
    sidecar: Mapping[str, Any],
) -> tuple[str, Dict[str, Any]]:
    """Split the page's sidecar body into the save's positional name and kwargs.

    The body is a ``DatasetSidecarSaveRequest``, so its field names are owned by
    ``app_server.schemas.dataset`` and are not restated here. The project and
    the reserving class come from the enclosing save instead, which is the one
    identity the Engine leased.
    """

    body = dict(sidecar)
    for owned_elsewhere in ("project_name", "reserving_class", "plan_fingerprint"):
        body.pop(owned_elsewhere, None)
    dataset_name = _clean(body.pop("dataset_name", ""))
    if not dataset_name:
        raise HTTPException(400, "The B&S output sidecar must name its dataset.")
    # The output CSV is the method half's, written from ``output_csv`` under the
    # name the page chose. Grid values here would write a second CSV under a
    # name derived differently, leaving the sidecar pointing at whichever won.
    if body.get("values") is not None or body.get("mask") is not None:
        raise HTTPException(
            400, "A B&S output sidecar cannot carry grid values; the method save writes its CSV."
        )
    return dataset_name, body


def save_berquist_sherman(
    project_name: str,
    reserving_class: str,
    method: Mapping[str, Any],
    *,
    method_type: str = "",
    method_name: str = "",
    csv_file: Any = None,
    output_csv: Any = None,
    sidecar: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Write a B&S method JSON, its output CSV, and its output sidecar as one save.

    This runs on ArcRho Engine, where the workspace is local disk. It used to be
    two calls from the Client PC: this one wrote the method JSON and the CSV
    across the share, and the page then saved the output sidecar through
    ``/dataset/sidecar/save``. Each share visit costs a round trip whatever the
    file weighs, and the two B&S methods were the only ones still paying it —
    DFM, BF, CC, RS, and Bootstrap have long saved everything in one hosted
    call. Pairing the two halves here makes B&S behave the same way.

    The method text is produced by ``arcrho_api.io.persisted_json_text`` — the
    one owner of the on-disk JSON layout — so a B&S file on disk is laid out
    exactly as every other persisted ArcRho JSON file. The payload's own
    identity must name the method being saved: the path is derived from
    ``method_name`` and the variant, and a payload that says otherwise would
    leave a file whose contents disagree with its name.

    ``sidecar`` is omitted by a write that only rewrites the method JSON in
    place, such as the page's recorded-number-format sync; nothing is published
    and no dependent walk is queued for one of those.
    """

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    if not project or not reserving:
        raise HTTPException(400, "project_name and reserving_class are required.")
    name = _method_identity(method, method_name)

    # Everything both halves need is resolved before either is written, so a
    # refusal from the second half cannot leave the first half's file behind:
    # the paths, the sidecar body, and — because dependent propagation runs on
    # ArcRho Engine — whether a live Engine can pick the walk up at all and no
    # other walk is still rewriting this reserving class.
    method_path = berquist_sherman_method_path(project, reserving, method_type, name)
    files: Dict[str, str] = {method_path: persisted_json_text(dict(method))}
    csv_path = ""
    if output_csv is not None:
        csv_path = _output_csv_path(project, reserving, csv_file)
        files[csv_path] = str(output_csv)
    publish = _sidecar_call(sidecar) if sidecar is not None else None
    if publish is not None:
        dependent_propagation_service.require_reserving_class_writable(project, reserving)

    with dataset_sidecar_status_service.reserving_class_io_lock(project, reserving):
        changed_paths = _commit_text_files(files)
        # Every key here is the method half's own, so merging the two responses
        # below cannot quietly overwrite a field the sidecar half owns.
        written = {
            "ok": True,
            "method_path": method_path,
            "output_csv_path": csv_path,
            "output_csv_file": os.path.basename(csv_path) if csv_path else "",
            "method_changed_paths": changed_paths,
        }
        if publish is None:
            return written
        dataset_name, body = publish
        published = dataset_service.save_dataset_sidecar(
            project,
            reserving,
            dataset_name,
            **body,
        )
    # The sidecar half owns the response the page reads — its audit log, its
    # graph rows, and the queued dependent walk — so it is returned whole, with
    # the method half's written paths added beside it.
    return {**published, **written}


def save_propagation_roots(
    project_name: str,
    reserving_class: str,
    method: Mapping[str, Any],
    *,
    sidecar: Mapping[str, Any] | None = None,
    **_ignored: Any,
) -> List[tuple[str, str]]:
    """Return the changed roots ``save_berquist_sherman`` would propagate from.

    The walk starts at the output dataset the sidecar half publishes, so a save
    that writes no sidecar changes nothing anything downstream can see.
    """

    if sidecar is None:
        return []
    dataset_name, body = _sidecar_call(sidecar)
    return [(dataset_name, _clean(body.get("dataset_type")) or dataset_name)]
