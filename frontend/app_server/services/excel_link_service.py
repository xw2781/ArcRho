"""Reserving-class Excel link inventory and workbook retargeting.

Project Instance's Excel Link Manager lists every external workbook referenced
by saved dataset sidecars (``external_links``) and saved DFM methods (Ratios
User Entry ``inputs``) in one reserving class, and can repoint every reference
from one workbook file to another.

Retargeting rewrites reference text only. Stored values keep their current
snapshots, so dataset CSVs, DFM publications, output sidecars, audit logs, and
dependent review statuses are untouched; refreshing values from the new
workbook stays an explicit action in the Dataset/DFM Links tabs.

Reference syntax mirrors the canonical frontend parser
``ui/shared/integrations/excel_reference.js``: a quoted source
``'dir\\[Book.xlsx]Sheet'!A1:B2`` (apostrophes escaped as ``''``) that may
appear inline inside a larger formula, plus the optional-quote standalone form.
"""
from __future__ import annotations

import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Iterable, List, Mapping, Tuple

from fastapi import HTTPException

from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    DfmContractError,
    apply_owned_patch,
    method_revisions,
    normalize_dfm_method,
)
from app_server import config
from app_server.services import dataset_sidecar_status_service, excel_service

READ_MAX_WORKERS = 4
_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=READ_MAX_WORKERS,
    thread_name_prefix="arcrho-excel-link-read",
)

# Mirrors EXCEL_REFERENCE_INLINE_RE / EXCEL_REFERENCE_RE in excel_reference.js.
_QUOTED_INLINE_RE = re.compile(
    r"'((?:[^']|'')*)'!(\$?[A-Z]+\$?[0-9]+)(:\$?[A-Z]+\$?[0-9]+)?",
    re.IGNORECASE,
)
_STANDALONE_RE = re.compile(
    r"^\s*(=?)\s*(?:'((?:[^']|'')*)'|([^!]+))!(\$?[A-Z]+\$?[0-9]+)(:\$?[A-Z]+\$?[0-9]+)?\s*$",
    re.IGNORECASE,
)


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _parse_source(raw_source: str) -> Dict[str, str] | None:
    source = _clean(raw_source).replace("''", "'")
    open_bracket = source.find("[")
    close_bracket = source.find("]", open_bracket + 1)
    if open_bracket < 0 or close_bracket <= open_bracket + 1 or close_bracket >= len(source) - 1:
        return None
    directory = source[:open_bracket]
    filename = source[open_bracket + 1:close_bracket]
    sheet = source[close_bracket + 1:]
    return {
        "book_path": directory + filename,
        "dir": directory,
        "filename": filename,
        "sheet": sheet,
    }


def workbook_key(path: Any) -> str:
    """Case/separator-insensitive grouping key for a workbook path."""

    return os.path.normcase(_clean(path))


def _split_book_path(book_path: str) -> Tuple[str, str]:
    separator = max(book_path.rfind("\\"), book_path.rfind("/"))
    if separator < 0:
        return "", book_path
    return book_path[: separator + 1], book_path[separator + 1:]


def _quoted_source(book_path: str, sheet: str) -> str:
    directory, filename = _split_book_path(book_path)
    return f"{directory}[{filename}]{sheet}".replace("'", "''")


def find_workbook_references(text: Any) -> List[Dict[str, str]]:
    """Return each parseable workbook reference inside one formula string."""

    source = str(text if text is not None else "")
    references: List[Dict[str, str]] = []
    for match in _QUOTED_INLINE_RE.finditer(source):
        parsed = _parse_source(match.group(1))
        if parsed:
            references.append(parsed)
    if references:
        return references
    standalone = _STANDALONE_RE.fullmatch(source)
    if standalone:
        parsed = _parse_source(
            standalone.group(2) if standalone.group(2) is not None else standalone.group(3) or ""
        )
        if parsed:
            references.append(parsed)
    return references


def rewrite_workbook_references(text: Any, old_key: str, new_book_path: str) -> Tuple[str, int]:
    """Rewrite references to ``old_key`` in one formula string.

    Only the workbook directory/file portion changes; worksheet names and cell
    addresses are preserved exactly. Returns the rewritten text and how many
    references changed.
    """

    source = str(text if text is not None else "")
    changed = 0

    def replace_quoted(match: re.Match[str]) -> str:
        nonlocal changed
        parsed = _parse_source(match.group(1))
        if not parsed or workbook_key(parsed["book_path"]) != old_key:
            return match.group(0)
        changed += 1
        address = f"{match.group(2)}{match.group(3) or ''}"
        return f"'{_quoted_source(new_book_path, parsed['sheet'])}'!{address}"

    rewritten = _QUOTED_INLINE_RE.sub(replace_quoted, source)
    if changed:
        return rewritten, changed
    standalone = _STANDALONE_RE.fullmatch(source)
    if standalone:
        parsed = _parse_source(
            standalone.group(2) if standalone.group(2) is not None else standalone.group(3) or ""
        )
        if parsed and workbook_key(parsed["book_path"]) == old_key:
            address = f"{standalone.group(4)}{standalone.group(5) or ''}"
            equals = standalone.group(1) or ""
            return f"{equals}'{_quoted_source(new_book_path, parsed['sheet'])}'!{address}", 1
    return source, 0


# ---------------------------------------------------------------------------
# Reserving-class scan
# ---------------------------------------------------------------------------


def _require_reserving_class_dirs(project_name: str, reserving_class: str) -> Tuple[str, str]:
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    if not project or not reserving:
        raise HTTPException(400, "project_name and reserving_class are required.")
    try:
        sidecar_dir = config.get_project_dataset_sidecar_dir(project, reserving)
        method_dir = config.get_project_method_data_dir(project, reserving)
    except ValueError as err:
        raise HTTPException(404, str(err))
    return sidecar_dir, method_dir


def _list_json_files(folder: str, pattern: re.Pattern[str]) -> List[str]:
    try:
        entries = os.listdir(folder)
    except FileNotFoundError:
        return []
    except OSError as err:
        raise HTTPException(500, f"Could not list {os.path.basename(folder)} folder: {err}")
    return sorted(
        os.path.join(folder, name)
        for name in entries
        if pattern.fullmatch(name)
    )


_SIDECAR_FILE_RE = re.compile(r".+\.json", re.IGNORECASE)
_DFM_METHOD_FILE_RE = re.compile(r"DFM@.+\.json", re.IGNORECASE)


def _read_json_file(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _read_json_files(paths: Iterable[str]) -> List[Tuple[str, Dict[str, Any] | None, str]]:
    """Read many small JSON files with bounded parallelism.

    Returns ``(path, payload_or_None, error)`` triples in input order so a
    network-drive folder never pays one round trip per awaited file.
    """

    ordered = list(paths)
    futures = {path: _READ_EXECUTOR.submit(_read_json_file, path) for path in ordered}
    results: List[Tuple[str, Dict[str, Any] | None, str]] = []
    for path in ordered:
        try:
            results.append((path, futures[path].result(), ""))
        except FileNotFoundError:
            continue
        except (OSError, json.JSONDecodeError) as err:
            results.append((path, None, str(err)))
    return results


def _dataset_link_cells(link: Mapping[str, Any]) -> int:
    targets = link.get("target_cells")
    return len(targets) if isinstance(targets, list) else 0


def _dataset_usages(
    sidecar_payloads: List[Tuple[str, Dict[str, Any] | None, str]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    usages: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    for path, payload, error in sidecar_payloads:
        if payload is None:
            errors.append({"file": os.path.basename(path), "error": error})
            continue
        links = payload.get("external_links")
        if not isinstance(links, list) or not links:
            continue
        name = _clean(payload.get("dataset_name")) or os.path.splitext(os.path.basename(path))[0]
        by_book: Dict[str, Dict[str, Any]] = {}
        for link in links:
            if not isinstance(link, dict):
                continue
            for reference in find_workbook_references(link.get("reference")):
                book = reference["book_path"]
                entry = by_book.setdefault(
                    workbook_key(book),
                    {"book_path": book, "link_count": 0, "cell_count": 0},
                )
                entry["link_count"] += 1
                entry["cell_count"] += _dataset_link_cells(link)
        for entry in by_book.values():
            usages.append({"kind": "dataset", "name": name, **entry})
    return usages, errors


def _dfm_input_matrices(payload: Mapping[str, Any]) -> List[List[Any]]:
    ratios = payload.get("ratios tab")
    formulas = ratios.get("average formulas") if isinstance(ratios, Mapping) else None
    if not isinstance(formulas, Mapping):
        return []
    matrices = []
    for field in ("inputs", "display inputs"):
        matrix = formulas.get(field)
        if isinstance(matrix, list):
            matrices.append(matrix)
    return matrices


def _dfm_usages(
    method_payloads: List[Tuple[str, Dict[str, Any] | None, str]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    usages: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    for path, payload, error in method_payloads:
        if payload is None:
            errors.append({"file": os.path.basename(path), "error": error})
            continue
        if _clean(payload.get("json format")) != DFM_JSON_FORMAT:
            continue
        details = payload.get("details tab")
        name = _clean(details.get("name")) if isinstance(details, Mapping) else ""
        name = name or os.path.splitext(os.path.basename(path))[0]
        by_book: Dict[str, Dict[str, Any]] = {}
        # ``display inputs`` mirrors ``inputs``; inventory counts only the
        # calculation-owning ``inputs`` matrix so a formula is one link.
        ratios = payload.get("ratios tab")
        formulas = ratios.get("average formulas") if isinstance(ratios, Mapping) else None
        inputs = formulas.get("inputs") if isinstance(formulas, Mapping) else None
        for row in inputs if isinstance(inputs, list) else []:
            if not isinstance(row, list):
                continue
            for cell in row:
                for reference in find_workbook_references(cell):
                    book = reference["book_path"]
                    entry = by_book.setdefault(
                        workbook_key(book),
                        {"book_path": book, "link_count": 0, "cell_count": 0},
                    )
                    entry["link_count"] += 1
                    entry["cell_count"] += 1
        for entry in by_book.values():
            usages.append({"kind": "dfm", "name": name, **entry})
    return usages, errors


def _group_workbooks(usages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[str, Dict[str, Any]] = {}
    for usage in usages:
        key = workbook_key(usage["book_path"])
        group = groups.setdefault(key, {
            "workbook_path": usage["book_path"],
            "usages": [],
        })
        group["usages"].append({
            "kind": usage["kind"],
            "name": usage["name"],
            "link_count": usage["link_count"],
            "cell_count": usage["cell_count"],
        })
    workbooks: List[Dict[str, Any]] = []
    for group in groups.values():
        path = group["workbook_path"]
        directory, filename = _split_book_path(path)
        entries = sorted(
            group["usages"],
            key=lambda item: (item["kind"], str(item["name"]).casefold()),
        )
        workbooks.append({
            "workbook_path": path,
            "workbook_name": filename,
            "folder": directory,
            "dataset_count": sum(1 for item in entries if item["kind"] == "dataset"),
            "method_count": sum(1 for item in entries if item["kind"] == "dfm"),
            "link_count": sum(item["link_count"] for item in entries),
            "cell_count": sum(item["cell_count"] for item in entries),
            "usages": entries,
        })
    workbooks.sort(key=lambda item: (item["workbook_name"].casefold(), item["workbook_path"].casefold()))
    return workbooks


def _apply_workbook_stats(workbooks: List[Dict[str, Any]]) -> None:
    if not workbooks:
        return
    stats = excel_service.excel_file_mtimes_batch(
        [item["workbook_path"] for item in workbooks]
    )
    results = stats.get("results") if isinstance(stats, dict) else None
    for index, workbook in enumerate(workbooks):
        result = results[index] if isinstance(results, list) and index < len(results) else None
        ok = bool(isinstance(result, dict) and result.get("ok"))
        workbook["exists"] = ok
        workbook["mtime"] = result.get("mtime") if ok else None


def list_reserving_class_excel_links(project_name: str, reserving_class: str) -> Dict[str, Any]:
    sidecar_dir, method_dir = _require_reserving_class_dirs(project_name, reserving_class)
    sidecar_paths = _list_json_files(sidecar_dir, _SIDECAR_FILE_RE)
    method_paths = _list_json_files(method_dir, _DFM_METHOD_FILE_RE)
    dataset_usages, dataset_errors = _dataset_usages(_read_json_files(sidecar_paths))
    dfm_usages, dfm_errors = _dfm_usages(_read_json_files(method_paths))
    workbooks = _group_workbooks(dataset_usages + dfm_usages)
    _apply_workbook_stats(workbooks)
    return {
        "ok": True,
        "project_name": _clean(project_name),
        "reserving_class": _clean(reserving_class),
        "workbooks": workbooks,
        "dataset_scan_count": len(sidecar_paths),
        "method_scan_count": len(method_paths),
        "errors": dataset_errors + dfm_errors,
    }


# ---------------------------------------------------------------------------
# Retarget
# ---------------------------------------------------------------------------


def _reserving_class_lock(project_name: str, reserving_class: str) -> threading.RLock:
    return dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class)


def _rewrite_dataset_sidecar(path: str, old_key: str, new_book_path: str) -> Dict[str, Any] | None:
    """Rewrite one sidecar's matching references; return its result row.

    Values, timestamps, audit history, and dependency status are deliberately
    untouched: the retarget changes where a later refresh reads from, not what
    is currently stored.
    """

    from app_server.services.dataset_service import _write_dataset_sidecar_payload

    payload = _read_json_file(path)
    links = payload.get("external_links")
    if not isinstance(links, list) or not links:
        return None
    name = _clean(payload.get("dataset_name")) or os.path.splitext(os.path.basename(path))[0]
    changed = 0
    for link in links:
        if not isinstance(link, dict):
            continue
        reference = link.get("reference")
        rewritten, count = rewrite_workbook_references(reference, old_key, new_book_path)
        if not count:
            continue
        round_trip = find_workbook_references(rewritten)
        if not round_trip or any(
            workbook_key(item["book_path"]) == old_key for item in round_trip
        ):
            raise ValueError(f"Rewritten reference is not a valid workbook reference: {rewritten}")
        link["reference"] = rewritten
        changed += count
    if not changed:
        return None
    _write_dataset_sidecar_payload(path, payload)
    return {"kind": "dataset", "name": name, "ok": True, "changed_link_count": changed}


def _rewrite_dfm_method(path: str, old_key: str, new_book_path: str) -> Dict[str, Any] | None:
    """Rewrite one DFM method's matching references; return its result row.

    The patched payload goes through the canonical owned-patch merge so the
    method revisions stay consistent, Excel-linked values stay frozen, and the
    publication revision is asserted unchanged before only the method JSON is
    replaced. Output CSVs and the output sidecar are not rewritten.
    """

    from app_server.services.dfm_service import _commit_text_files, _method_json_text

    payload = _read_json_file(path)
    if _clean(payload.get("json format")) != DFM_JSON_FORMAT:
        return None
    details = payload.get("details tab")
    name = _clean(details.get("name")) if isinstance(details, Mapping) else ""
    name = name or os.path.splitext(os.path.basename(path))[0]
    try:
        current = normalize_dfm_method(payload, require_complete=True)
    except DfmContractError as err:
        raise ValueError(f"DFM method could not be normalized: {err}")
    changed = 0
    patched = json.loads(json.dumps(current))
    for matrix in _dfm_input_matrices(patched):
        for row in matrix:
            if not isinstance(row, list):
                continue
            for column, cell in enumerate(row):
                rewritten, count = rewrite_workbook_references(cell, old_key, new_book_path)
                if count:
                    row[column] = rewritten
                    changed += count
    if not changed:
        return None
    merged = apply_owned_patch(current, patched)
    if method_revisions(merged)["publication revision"] != method_revisions(current)["publication revision"]:
        raise ValueError(
            "Retargeting would change the DFM publication; open the DFM to review it instead."
        )
    _commit_text_files({path: _method_json_text(merged)})
    return {"kind": "dfm", "name": name, "ok": True, "changed_link_count": changed}


def _collect_file_results(
    kind: str,
    paths: Iterable[str],
    rewrite: Callable[[str], Dict[str, Any] | None],
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for path in paths:
        try:
            result = rewrite(path)
        except FileNotFoundError:
            continue
        except (OSError, ValueError, json.JSONDecodeError, DfmContractError, HTTPException) as err:
            detail = getattr(err, "detail", None)
            results.append({
                "kind": kind,
                "name": os.path.splitext(os.path.basename(path))[0],
                "ok": False,
                "changed_link_count": 0,
                "error": _clean(detail) or str(err),
            })
        else:
            if result is not None:
                results.append(result)
    return results


def retarget_reserving_class_workbook(
    project_name: str,
    reserving_class: str,
    old_workbook_path: str,
    new_workbook_path: str,
) -> Dict[str, Any]:
    sidecar_dir, method_dir = _require_reserving_class_dirs(project_name, reserving_class)
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    old_path = _clean(old_workbook_path)
    new_path = _clean(new_workbook_path)
    if not old_path or not new_path:
        raise HTTPException(400, "old_workbook_path and new_workbook_path are required.")
    old_key = workbook_key(old_path)
    if old_key == workbook_key(new_path):
        listing = list_reserving_class_excel_links(project, reserving)
        return {
            **listing,
            "results": [],
            "changed_file_count": 0,
            "changed_link_count": 0,
            "message": "The selected workbook is already the current link.",
        }
    if not os.path.isfile(new_path):
        raise HTTPException(400, f"The selected workbook was not found: {new_path}")

    with _reserving_class_lock(project, reserving):
        results = _collect_file_results(
            "dataset",
            _list_json_files(sidecar_dir, _SIDECAR_FILE_RE),
            lambda path: _rewrite_dataset_sidecar(path, old_key, new_path),
        )
        results += _collect_file_results(
            "dfm",
            _list_json_files(method_dir, _DFM_METHOD_FILE_RE),
            lambda path: _rewrite_dfm_method(path, old_key, new_path),
        )

    changed_files = [item for item in results if item.get("ok")]
    index_error = ""
    if changed_files:
        from app_server.services import dataset_instance_index_service

        try:
            dataset_instance_index_service.rebuild_index(project, reserving)
        except Exception as err:  # A stale index self-heals on the next read.
            index_error = str(err)

    listing = list_reserving_class_excel_links(project, reserving)
    return {
        **listing,
        "ok": all(item.get("ok") for item in results),
        "results": results,
        "changed_file_count": len(changed_files),
        "changed_link_count": sum(int(item.get("changed_link_count") or 0) for item in changed_files),
        "index_ok": not index_error,
        "index_error": index_error,
    }
