"""Page open and file writes for the two Berquist Sherman methods.

Opening a page used to cost a Client PC two independent share visits made one
after the other: the output sidecar over the app server, then the method JSON
straight from the renderer's host API. The second one could never reach the
Arco Gateway at all, because a host-API file read does not enter the app
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

The third half is the automatic refresh (``refresh_dependents``): the Engine's
dependent-propagation walk reaches a B&S output through the reverse edges its
sources carry, recomputes the method from those sources with the canonical
``arcrho_api.berquist_sherman_contract`` -- the server-side twin of the page's
calculation modules -- and rewrites the output CSV, the output sidecar, and the
method's ``last_modified`` stamp when the numbers moved. Without it a Result
Selection or DFM save that changed a B&S source left the output CSV as the
page last saved it: the method page looked fresh, because it recomputes from
its sources on every open, while the Dataset Viewer and every dependent read
the stale cache.
"""

from __future__ import annotations

import getpass
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from typing import Any, Dict, Iterable, List, Mapping, Tuple

import pandas as pd
from fastapi import HTTPException

from arcrho_api.berquist_sherman_contract import (
    BS_ANNUAL_PERIOD_LENGTH,
    BS_JSON_FORMAT_BY_VARIANT,
    BS_SOURCE_ROLES,
    BerquistShermanContractError,
    berquist_sherman_development_count,
    berquist_sherman_method_variant,
    berquist_sherman_output_csv_text,
    berquist_sherman_precedent_names,
    calculate_berquist_sherman_output,
    normalize_annual_triangle,
    normalize_vector,
    number_or_none,
    output_values_equal,
    parse_output_csv_text,
)
from arcrho_api.io import persisted_json_text
from arcrho_api.sidecar_audit_contract import AUDIT_ACTION_AUTO_REFRESH, append_audit_entry
from arcrho_api.sidecar_core_contract import display_lengths, finalize_sidecar, stored_lengths
from arcrho_api.timestamps import utc_now_text

from app_server import config
from app_server.helpers import (
    build_dataset_cache_file_name,
    read_dataset_csv,
    sanitize_dataset_file_name,
)
from app_server.services import (
    dataset_service,
    dataset_sidecar_status_service,
    dependent_propagation_service,
    dependent_walk_service,
    precedent_cache_service,
    user_identity_service,
)


# The source roles' labels as the page names them in its own messages.
_ROLE_LABELS = {
    "paid_claims": "Paid Claims",
    "closed_claim_numbers": "Closed Claim Counts",
    "ultimate_claim_numbers": "Ultimate Claim Counts",
    "incurred_claims": "Incurred Claims",
    "reported_claim_numbers": "Reported Claim Counts",
}


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

    This runs on Arco Engine, where the workspace is local disk. It used to be
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
    # Arco Engine — whether a live Engine can pick the walk up at all and no
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


# ---------------------------------------------------------------------------
# Automatic refresh from the dependent-propagation walk
# ---------------------------------------------------------------------------


def _key(value: Any) -> str:
    return _clean(value).casefold()


def _unique_names(values: Iterable[Any]) -> List[str]:
    seen: set[str] = set()
    names: List[str] = []
    for value in values:
        name = _clean(value)
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


def _sidecar_path(project_name: str, reserving_class: str, dataset_name: str) -> str:
    return dataset_sidecar_status_service.sidecar_path(project_name, reserving_class, dataset_name)


def _read_sidecars(
    project_name: str,
    reserving_class: str,
    names: Iterable[Any],
    cache: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    unique = _unique_names(names)
    pending = [name for name in unique if _key(name) not in cache]
    futures = {
        name: _READ_EXECUTOR.submit(_read_json, _sidecar_path(project_name, reserving_class, name))
        for name in pending
    }
    for name in pending:
        cache[_key(name)] = futures[name].result()
    return {name: cache.get(_key(name), {}) for name in unique}


def _read_source_values(
    project_name: str,
    reserving_class: str,
    name: str,
    sidecar: Mapping[str, Any],
    *,
    role: str,
    data_format: str,
) -> List[Any]:
    """Load one source exactly as the page loads it through ``/dataset/cache/load``.

    The page asks for the source's display view of the annual cumulative
    development cache and then applies the Dataset Viewer mask with the annual
    staircase (triangles) or takes the first numeric cell per row (vectors);
    the same two normalizers run here on the same CSV, so the walk computes
    from the values the page would show.
    """

    label = _ROLE_LABELS.get(role, role)
    if not sidecar:
        raise RuntimeError(f"B&S source sidecar is missing: {name}")
    sidecar_format = _clean(sidecar.get("data_format")).lower()
    if sidecar_format != data_format.lower():
        raise RuntimeError(f"{label} must be an annual {data_format.lower()} dataset: {name}")
    generated = _clean(sidecar.get("source_kind")).lower() == "engine"
    needs_rollup = False
    if not generated:
        # Displayed, then stored. Annual is a question about the grid B&S uses,
        # which is the one the dataset is shown at, and that is the shape the
        # page tests before it will take a source at all. A hand-entered
        # dataset may hold finer periods underneath that grid; its own CSV is
        # then aggregated to it in memory, the read the methods' precedent
        # resolver and the Dataset window already make of the same file. A
        # generated dataset is the one kind whose stored pair cannot be asked
        # this, because it records how fine the project's source table is
        # rather than the shape of the cache beside it; that one is answered
        # below instead.
        display = display_lengths(sidecar)
        stored = stored_lengths(sidecar)
        annual = (BS_ANNUAL_PERIOD_LENGTH, BS_ANNUAL_PERIOD_LENGTH)
        if any(display) and display != annual:
            raise RuntimeError(f"{name} is not an annual dataset.")
        if all(stored) and stored != annual:
            if precedent_cache_service.rollup_reason(
                sidecar, BS_ANNUAL_PERIOD_LENGTH, BS_ANNUAL_PERIOD_LENGTH
            ):
                raise RuntimeError(f"{name} is not an annual dataset.")
            needs_rollup = True
    data_dir = config.get_project_dataset_cache_dir(project_name, reserving_class)
    candidates: List[str] = []
    recorded = os.path.basename(_clean(sidecar.get("csv_file")))
    # A generated dataset's own cache may sit at any period, so it is the annual
    # name below that names the file to read; every other kind holds its values
    # only in the CSV it names, and a finer one is rolled up from exactly that
    # file rather than from a coarser copy that may sit beside it.
    if recorded and not generated:
        candidates.append(os.path.join(data_dir, recorded))
    if not needs_rollup:
        cache_name = build_dataset_cache_file_name(
            name,
            data_format,
            BS_ANNUAL_PERIOD_LENGTH,
            BS_ANNUAL_PERIOD_LENGTH,
            True,
            False,
        )
        candidates.append(os.path.join(data_dir, f"{cache_name}.csv"))
    csv_path = next((path for path in candidates if os.path.isfile(path)), "")
    if not csv_path and generated:
        # The Engine rebuilds one of its own datasets at any period from the
        # source table, so a missing annual cache is produced rather than
        # refused, exactly as the DFM's precedent resolver produces it.
        try:
            csv_path = precedent_cache_service.materialize_engine_source(
                project_name,
                reserving_class,
                name,
                sidecar,
                BS_ANNUAL_PERIOD_LENGTH,
                development_length=BS_ANNUAL_PERIOD_LENGTH,
            )
        except RuntimeError as exc:
            raise RuntimeError(
                f"{label} could not be generated at annual periods: {name}: {exc}"
            ) from exc
    if not csv_path:
        raise RuntimeError(f"B&S source CSV is missing: {name}")
    try:
        frame = read_dataset_csv(csv_path).astype(object)
    except PermissionError as exc:
        raise RuntimeError(f"B&S source CSV is locked: {name}") from exc
    except Exception as exc:
        raise RuntimeError(f"B&S source CSV is invalid: {name}: {exc}") from exc
    frame = frame.where(pd.notnull(frame), None)
    values = frame.values.tolist()
    if needs_rollup:
        try:
            values = precedent_cache_service.rollup_rows(
                project_name,
                sidecar,
                values,
                BS_ANNUAL_PERIOD_LENGTH,
                BS_ANNUAL_PERIOD_LENGTH,
            )
        except ValueError as exc:
            raise RuntimeError(f"{name} could not be read at annual periods: {exc}") from exc
    if data_format == "Vector":
        return normalize_vector(values)
    mask = [[value is not None for value in row] for row in values]
    return normalize_annual_triangle(values, mask)


def _mark_review_needed(
    project_name: str,
    reserving_class: str,
    output_dataset: str,
) -> Dict[str, Any]:
    sidecar_path = _sidecar_path(project_name, reserving_class, output_dataset)
    with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        sidecar = _read_json(sidecar_path)
        if not sidecar:
            return {}
        if dataset_sidecar_status_service.normalize_status(sidecar.get("status")) \
                == dataset_sidecar_status_service.STATUS_REVIEW_NEEDED:
            return sidecar
        sidecar["status"] = dataset_sidecar_status_service.STATUS_REVIEW_NEEDED
        _commit_text_files({sidecar_path: persisted_json_text(finalize_sidecar(sidecar))})
        return sidecar


def _refresh_one(
    project_name: str,
    reserving_class: str,
    output_dataset: str,
    sidecar: Mapping[str, Any],
    changed_names: Iterable[str],
    *,
    blocked_precedent_keys: set[str],
    sidecar_cache: Dict[str, Dict[str, Any]],
    method_payload: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Recompute and republish one B&S output with refreshed metadata."""

    method_type = dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"), sidecar.get("source_kind")
    )
    method_name = _clean(sidecar.get("method_name")) or output_dataset
    method_path = berquist_sherman_method_path(project_name, reserving_class, method_type, method_name)
    method = (
        dict(method_payload)
        if isinstance(method_payload, Mapping) and method_payload
        else _read_json(method_path)
    )
    if not method:
        raise RuntimeError("B&S method JSON is missing.")
    variant = berquist_sherman_method_variant(method)
    if not variant or _clean(method.get("json_format")) != BS_JSON_FORMAT_BY_VARIANT.get(variant):
        raise RuntimeError("B&S automatic refresh requires canonical v4 JSON.")
    precedent_names = berquist_sherman_precedent_names(method)
    blocked = [name for name in precedent_names if _key(name) in blocked_precedent_keys]
    if blocked:
        raise RuntimeError("Required B&S source could not be refreshed: " + ", ".join(blocked))
    changed_keys = {_key(name) for name in changed_names if _key(name)}
    matched = [name for name in precedent_names if _key(name) in changed_keys]
    if not matched:
        return {
            "ok": True,
            "dataset_name": output_dataset,
            "skipped": True,
            "reason": "stale_reverse_dependency_edge",
        }

    tab = method.get("method_tab")
    tab = tab if isinstance(tab, Mapping) else {}
    role_names: List[Tuple[str, str, str]] = []
    for role, data_format in BS_SOURCE_ROLES[variant]:
        name = _clean(tab.get(role))
        if not name:
            raise RuntimeError(f"B&S method does not name its {_ROLE_LABELS.get(role, role)} source.")
        role_names.append((role, data_format, name))
    source_sidecars = _read_sidecars(
        project_name, reserving_class, [name for _role, _format, name in role_names], sidecar_cache
    )
    source_values = {
        role: _read_source_values(
            project_name,
            reserving_class,
            name,
            source_sidecars.get(name) or {},
            role=role,
            data_format=data_format,
        )
        for role, data_format, name in role_names
    }
    try:
        result = calculate_berquist_sherman_output(method, source_values)
    except BerquistShermanContractError as exc:
        raise RuntimeError(str(exc)) from exc
    output = result["output"]
    if not any(number_or_none(value) is not None for row in output for value in row):
        raise RuntimeError("B&S output is blank. Check the selected sources.")

    csv_file = os.path.basename(_clean(sidecar.get("csv_file"))) or (
        f"{sanitize_dataset_file_name(output_dataset)}"
        f"@{BS_ANNUAL_PERIOD_LENGTH}@{BS_ANNUAL_PERIOD_LENGTH}@cum@dev.csv"
    )
    csv_path = os.path.join(
        config.get_project_dataset_cache_dir(project_name, reserving_class), csv_file
    )
    csv_text = berquist_sherman_output_csv_text(
        output, berquist_sherman_development_count(method, source_values)
    )
    existing_text = _read_text_if_file(csv_path)
    output_changed = existing_text is None or not output_values_equal(
        parse_output_csv_text(existing_text), output
    )

    sidecar_path = _sidecar_path(project_name, reserving_class, output_dataset)
    updated_sidecar: Dict[str, Any] = dict(sidecar)
    updated_sidecar["status"] = dataset_sidecar_status_service.STATUS_CURRENT
    updated_method: Dict[str, Any] = method
    files: Dict[str, str] = {}
    now = utc_now_text()
    user = user_identity_service.get_current_display_name() or getpass.getuser()
    updated_sidecar["csv_file"] = csv_file
    updated_sidecar["updated_at"] = now
    updated_sidecar["modified_by"] = user
    updated_sidecar["audit_log"] = append_audit_entry(
        sidecar.get("audit_log"),
        event_date=now,
        action=AUDIT_ACTION_AUTO_REFRESH,
        user=user,
    )
    updated_method = deepcopy(method)
    metadata = updated_method.get("method_metadata")
    metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
    metadata["last_modified"] = now
    updated_method["method_metadata"] = metadata
    files[csv_path] = csv_text
    files[method_path] = persisted_json_text(updated_method)
    from app_server.services.method_review_service import refreshed_status

    updated_sidecar["status"] = refreshed_status(sidecar, files)
    # The sidecar goes last so a failure on the way leaves the old publication
    # whole; an unchanged file is not rewritten.
    files[sidecar_path] = persisted_json_text(finalize_sidecar(updated_sidecar))
    changed_paths = _commit_text_files(files)
    return {
        "ok": True,
        "dataset_name": output_dataset,
        "dataset_type": _clean(sidecar.get("dataset_type")) or output_dataset,
        "updated": True,
        "output_changed": output_changed,
        "status_refreshed": False,
        "method": updated_method,
        "sidecar": updated_sidecar,
        "changed_paths": changed_paths,
    }


def refresh_output(
    project_name: str,
    reserving_class: str,
    dataset_name: str,
    sidecar: Mapping[str, Any] | None = None,
    changed_precedents: Iterable[Any] = (),
    caches: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Republish one Berquist-Sherman output and report instead of raising.

    The ordered walk in :mod:`dependent_walk_service` calls this for a node
    whose precedents it has already refreshed, so no other domain is cascaded
    from here. A failure keeps the last valid publication, marks the output
    Review Needed and comes back as ``{"ok": False, "reason": ...}``, which is
    how the walk blocks everything below it.
    """

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    output_dataset = _clean(dataset_name)
    changed = _unique_names(changed_precedents)
    sidecar_cache = dependent_walk_service.walk_cache(caches, "berquist_sherman_sidecars")
    dependent_walk_service.forget_cached(
        sidecar_cache,
        [_key(name) for name in (*changed, output_dataset)],
    )
    sidecar_path = _sidecar_path(project, reserving, output_dataset)
    try:
        with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
            latest_sidecar = _read_json(sidecar_path) or dict(sidecar or {})
            return _refresh_one(
                project,
                reserving,
                output_dataset,
                latest_sidecar,
                changed,
                blocked_precedent_keys=set(),
                sidecar_cache=sidecar_cache,
            )
    except Exception as exc:
        _mark_review_needed(project, reserving, output_dataset)
        return {
            "ok": False,
            "dataset_name": output_dataset,
            "dataset_type": _clean((sidecar or {}).get("dataset_type")) or output_dataset,
            "reason": str(exc),
        }


def refresh_dependents(
    project_name: str,
    reserving_class: str,
    changed_dataset_names: Iterable[Any],
    *,
    rebuild_index: bool = True,
    blocked_precedent_names: Iterable[Any] = (),
    finalize_method_review_status: bool = True,
) -> Dict[str, Any]:
    """Refresh what these datasets reach and report the Berquist-Sherman part of it.

    One ordered pass in :mod:`dependent_walk_service` does the work: every
    object the changed datasets reach is refreshed after its own precedents,
    once, whichever domain owns it. The report is this domain's own — what was
    republished, what declined, and why — while ``downstream_fresh_names`` and ``downstream_blocked_names`` name the
    objects of other kinds the same pass refreshed and blocked.
    """

    return dependent_walk_service.run_pass(
        project_name,
        reserving_class,
        list(changed_dataset_names),
        blocked_precedent_names=blocked_precedent_names,
        finalize_method_review_status=finalize_method_review_status,
        rebuild_index=rebuild_index,
    )["berquist_sherman_updates"]
