"""Reserving-class Excel link inventory and workbook retargeting.

Project Instance's Excel Link Manager lists every external workbook referenced
by saved dataset sidecars (``external_links``) and saved DFM methods (Ratios
User Entry ``inputs``) in one reserving class, and can repoint every reference
from one workbook file to another.

By default retargeting rewrites reference text only. Stored values keep their
current snapshots, so dataset CSVs, DFM publications, output sidecars, audit
logs, and dependent review statuses are untouched; refreshing values from the
new workbook stays an explicit action in the Dataset/DFM Links tabs.

With ``refresh_values`` the retarget also reads the mapped cells from the new
workbook in one batch and commits the changed values through the canonical
save flows (``save_dataset_sidecar`` / ``save_dfm_method``), so audit entries,
review statuses, and Engine dependent propagation behave exactly like a normal
save. Value rules mirror the client Links-tab refresh: dataset links accept
any finite number and store blank cells as null with per-link atomicity, while
DFM cells require a finite result greater than zero rounded to six decimals,
with standalone ranges spilling literal values into their non-anchor cells.

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
    canonical_number,
    method_revisions,
    normalize_dfm_method,
    _evaluate_internal_formula,
)
from app_server import config
from app_server.services import (
    dataset_sidecar_status_service,
    dependent_propagation_service,
    excel_service,
)

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


def scan_reserving_class_excel_links(project_name: str, reserving_class: str) -> Dict[str, Any]:
    """Inventory workbook references without resolving the workbooks themselves.

    This is the half of the listing that reads the workspace: every dataset
    sidecar and v2 DFM method JSON in the class, which is local disk on the
    ArcRho Server host and one round trip per file from a Client PC. It is the
    registered ``excel_link_scan`` workspace read for exactly that reason.

    Whether each workbook currently exists is deliberately left out. Linked
    workbooks live on other file servers reached through drive letters the
    calling PC maps and the server host may not, so only the caller can answer
    that; ``resolve_workbook_stats`` does it there.
    """

    sidecar_dir, method_dir = _require_reserving_class_dirs(project_name, reserving_class)
    sidecar_paths = _list_json_files(sidecar_dir, _SIDECAR_FILE_RE)
    method_paths = _list_json_files(method_dir, _DFM_METHOD_FILE_RE)
    dataset_usages, dataset_errors = _dataset_usages(_read_json_files(sidecar_paths))
    dfm_usages, dfm_errors = _dfm_usages(_read_json_files(method_paths))
    return {
        "ok": True,
        "project_name": _clean(project_name),
        "reserving_class": _clean(reserving_class),
        "workbooks": _group_workbooks(dataset_usages + dfm_usages),
        "dataset_scan_count": len(sidecar_paths),
        "method_scan_count": len(method_paths),
        "errors": dataset_errors + dfm_errors,
    }


def resolve_workbook_stats(listing: Dict[str, Any]) -> Dict[str, Any]:
    """Stamp ``exists``/``mtime`` on a scan using this machine's drive mappings.

    Runs in the process the user is sitting at, whether the scan itself came
    from the gateway or from the mapped drive, so a workbook on a share only
    the Client PC maps is still reported as found.
    """

    workbooks = listing.get("workbooks")
    _apply_workbook_stats(workbooks if isinstance(workbooks, list) else [])
    return listing


def list_reserving_class_excel_links(project_name: str, reserving_class: str) -> Dict[str, Any]:
    """Scan one reserving class and resolve its workbooks, both in this process."""

    return resolve_workbook_stats(
        scan_reserving_class_excel_links(project_name, reserving_class)
    )


# ---------------------------------------------------------------------------
# Retarget
# ---------------------------------------------------------------------------


def _reserving_class_lock(project_name: str, reserving_class: str) -> threading.RLock:
    return dataset_sidecar_status_service.reserving_class_io_lock(project_name, reserving_class)


_CELL_ADDRESS_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")


def _parse_cell_address(value: Any) -> Tuple[int, int] | None:
    match = _CELL_ADDRESS_RE.fullmatch(_clean(value).replace("$", "").upper())
    if not match:
        return None
    column = 0
    for character in match.group(1):
        column = column * 26 + (ord(character) - 64)
    return int(match.group(2)) - 1, column - 1


def _column_name(index: int) -> str:
    name = ""
    value = index + 1
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _cell_key(book_path: str, sheet: str, cell: Any) -> Tuple[str, str, str]:
    return (
        os.path.normcase(_clean(book_path)),
        _clean(sheet).casefold(),
        _clean(cell).replace("$", "").upper(),
    )


def _find_references_with_addresses(text: Any) -> List[Dict[str, str]]:
    """Like ``find_workbook_references`` but keeps each match's addresses/span."""

    source = str(text if text is not None else "")
    references: List[Dict[str, str]] = []
    for match in _QUOTED_INLINE_RE.finditer(source):
        parsed = _parse_source(match.group(1))
        if parsed:
            references.append({
                **parsed,
                "cell": match.group(2),
                "end_cell": (match.group(3) or ":" + match.group(2))[1:],
                "match": match.group(0),
            })
    if references:
        return references
    standalone = _STANDALONE_RE.fullmatch(source)
    if standalone:
        parsed = _parse_source(
            standalone.group(2) if standalone.group(2) is not None else standalone.group(3) or ""
        )
        if parsed:
            references.append({
                **parsed,
                "cell": standalone.group(4),
                "end_cell": (standalone.group(5) or ":" + standalone.group(4))[1:],
                "match": source.strip(),
            })
    return references


def _standalone_range(text: Any) -> Dict[str, Any] | None:
    """Mirror parseStandaloneExcelRange: a whole-string multi-cell reference."""

    source = str(text if text is not None else "")
    match = _STANDALONE_RE.fullmatch(source)
    if not match:
        return None
    parsed = _parse_source(match.group(2) if match.group(2) is not None else match.group(3) or "")
    if not parsed or not match.group(5):
        return None
    start = _parse_cell_address(match.group(4))
    end = _parse_cell_address(match.group(5)[1:])
    if not start or not end or start == end:
        return None
    row0, col0 = min(start[0], end[0]), min(start[1], end[1])
    row1, col1 = max(start[0], end[0]), max(start[1], end[1])
    return {
        **parsed,
        "row0": row0,
        "col0": col0,
        "row_count": row1 - row0 + 1,
        "col_count": col1 - col0 + 1,
    }


def _range_source_cells(range_info: Mapping[str, Any]) -> List[str]:
    return [
        f"{_column_name(range_info['col0'] + col_offset)}{range_info['row0'] + row_offset + 1}"
        for row_offset in range(range_info["row_count"])
        for col_offset in range(range_info["col_count"])
    ]


def _js_number_text(value: Any) -> str:
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return text or "0"


# ---------------------------------------------------------------------------
# Value refresh
# ---------------------------------------------------------------------------


def _dataset_link_sheet(link: Mapping[str, Any]) -> str:
    references = find_workbook_references(link.get("reference"))
    return references[0]["sheet"] if references else ""


def _dfm_user_entry_rows(formulas: Mapping[str, Any]) -> List[bool]:
    settings = formulas.get("custom average formula settings")
    kinds = settings.get("averageType") if isinstance(settings, Mapping) else None
    labels = formulas.get("label") if isinstance(formulas.get("label"), list) else []
    flags = []
    for index in range(len(labels)):
        kind = kinds[index] if isinstance(kinds, list) and index < len(kinds) else ""
        flags.append(str(kind) == "user_entry")
    return flags


def _collect_refresh_read_items(
    sidecar_payloads: List[Tuple[str, Dict[str, Any] | None, str]],
    method_payloads: List[Tuple[str, Dict[str, Any] | None, str]],
    old_key: str,
    new_book_path: str,
) -> Dict[Tuple[str, str, str], Tuple[str, str, str]]:
    """Return the deduplicated cells one batched Excel read must resolve.

    Each normalized key maps to a representative original (book, sheet, cell)
    triple so the COM read receives the reference's own spelling. Old-workbook
    references are read from the new workbook; other workbooks referenced
    inside an affected DFM formula are read from their own paths, because the
    client refresh resolves every inline reference in the cell.
    """

    keys: Dict[Tuple[str, str, str], Tuple[str, str, str]] = {}

    def add(book_path: str, sheet: str, cell: str) -> None:
        keys.setdefault(
            _cell_key(book_path, sheet, cell),
            (book_path, sheet, _clean(cell).replace("$", "").upper()),
        )

    for _path, payload, _error in sidecar_payloads:
        links = payload.get("external_links") if payload else None
        for link in links if isinstance(links, list) else []:
            if not isinstance(link, dict):
                continue
            references = find_workbook_references(link.get("reference"))
            if not references or workbook_key(references[0]["book_path"]) != old_key:
                continue
            targets = link.get("target_cells")
            for target in targets if isinstance(targets, list) else []:
                cell = _clean(target.get("source_cell")) if isinstance(target, dict) else ""
                if cell:
                    add(new_book_path, references[0]["sheet"], cell)

    for _path, payload, _error in method_payloads:
        if not payload or _clean(payload.get("json format")) != DFM_JSON_FORMAT:
            continue
        matrices = _dfm_input_matrices(payload)
        inputs = matrices[0] if matrices else []
        for row in inputs if isinstance(inputs, list) else []:
            for cell_text in row if isinstance(row, list) else []:
                references = _find_references_with_addresses(cell_text)
                if not any(workbook_key(ref["book_path"]) == old_key for ref in references):
                    continue
                range_info = _standalone_range(cell_text)
                if range_info and workbook_key(range_info["book_path"]) == old_key:
                    for source_cell in _range_source_cells(range_info):
                        add(new_book_path, range_info["sheet"], source_cell)
                    continue
                for ref in references:
                    book = (
                        new_book_path
                        if workbook_key(ref["book_path"]) == old_key
                        else ref["book_path"]
                    )
                    add(book, ref["sheet"], ref["cell"])
    return keys


def _read_refresh_cells(
    keys: Mapping[Tuple[str, str, str], Tuple[str, str, str]],
) -> Dict[Tuple[str, str, str], Dict[str, Any]]:
    if not keys:
        return {}
    ordered = list(keys.items())
    items = [
        {"book_path": book, "sheet": sheet, "cell": cell}
        for _key, (book, sheet, cell) in ordered
    ]
    response = excel_service.excel_read_cells_batch(items)
    results = response.get("results") if isinstance(response, dict) else None
    read_map: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for index, (key, _original) in enumerate(ordered):
        result = results[index] if isinstance(results, list) and index < len(results) else None
        read_map[key] = result if isinstance(result, dict) else {"ok": False, "error": "Excel read failed."}
    return read_map


def _dataset_cell_value(result: Mapping[str, Any] | None) -> Tuple[bool, Any, str]:
    """Mirror the client excelResultValue rule: blank stays null, numbers pass."""

    if not result or not result.get("ok"):
        return False, None, _clean((result or {}).get("error")) or "Excel cell read failed."
    value = result.get("value")
    if value is None or value == "":
        return True, None, ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False, None, f"Excel returned a non-numeric value: {value}"
    if number != number or number in (float("inf"), float("-inf")):
        return False, None, f"Excel returned a non-numeric value: {value}"
    return True, number, ""


def _finite_number(result: Mapping[str, Any] | None) -> float | None:
    if not result or not result.get("ok"):
        return None
    try:
        number = float(result.get("value"))
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _values_equal(left: Any, right: Any) -> bool:
    if left is None or right is None:
        return left is None and right is None
    try:
        return float(left) == float(right)
    except (TypeError, ValueError):
        return False


def _apply_dataset_link_values(
    links: List[Dict[str, Any]],
    values: List[List[Any]],
    new_key: str,
    read_map: Mapping[Tuple[str, str, str], Mapping[str, Any]],
    new_book_path: str,
) -> Tuple[int, int, int, List[str]]:
    """Apply refreshed values per link atomically; returns counts and errors."""

    refreshed = 0
    changed = 0
    failed = 0
    errors: List[str] = []
    for link in links:
        if not isinstance(link, dict):
            continue
        references = find_workbook_references(link.get("reference"))
        if not references or workbook_key(references[0]["book_path"]) != new_key:
            continue
        sheet = references[0]["sheet"]
        targets = [target for target in link.get("target_cells") or [] if isinstance(target, dict)]
        pending: List[Tuple[int, int, Any]] = []
        link_error = ""
        for target in targets:
            row, column = target.get("row"), target.get("column")
            cell = _clean(target.get("source_cell"))
            in_bounds = (
                isinstance(row, int) and isinstance(column, int)
                and 0 <= row < len(values)
                and isinstance(values[row], list) and 0 <= column < len(values[row])
            )
            if not cell or not in_bounds:
                link_error = "The linked dataset cells are no longer available."
                break
            ok, value, error = _dataset_cell_value(read_map.get(_cell_key(new_book_path, sheet, cell)))
            if not ok:
                link_error = f"{cell}: {error}"
                break
            pending.append((row, column, value))
        if link_error:
            failed += len(targets)
            errors.append(link_error)
            continue
        refreshed += len(pending)
        for row, column, value in pending:
            if not _values_equal(values[row][column], value):
                values[row][column] = value
                changed += 1
    return refreshed, changed, failed, errors


def _dfm_range_targets(
    user_entry_flags: List[bool],
    anchor_row: int,
    anchor_col: int,
    range_info: Mapping[str, Any],
    column_count: int,
) -> List[Tuple[int, int, int]]:
    """Mirror getDfmExternalLinkRangeTargets: clip to user-entry rows/columns."""

    targets: List[Tuple[int, int, int]] = []
    for row_offset in range(range_info["row_count"]):
        row = anchor_row + row_offset
        if row >= len(user_entry_flags) or not user_entry_flags[row]:
            break
        for col_offset in range(range_info["col_count"]):
            col = anchor_col + col_offset
            if 0 <= col < column_count:
                targets.append((row, col, row_offset * range_info["col_count"] + col_offset))
    if targets:
        return targets
    if 0 <= anchor_row < len(user_entry_flags) and user_entry_flags[anchor_row]:
        return [(anchor_row, anchor_col, 0)]
    return []


_DATASET_REFERENCE_TOKEN_RE = re.compile(r"\[[^\]]+\]\s*\[")


def _apply_dfm_refresh(
    merged: Dict[str, Any],
    new_key: str,
    read_map: Mapping[Tuple[str, str, str], Mapping[str, Any]],
    new_book_path: str,
) -> Tuple[int, int, int, List[str]]:
    """Refresh merged user-entry values in place; mirrors refreshAllExcelLinks."""

    formulas = merged["ratios tab"]["average formulas"]
    labels = formulas["label"]
    inputs = formulas["inputs"]
    display_inputs = formulas["display inputs"]
    values = formulas["values"]
    user_entry_flags = _dfm_user_entry_rows(formulas)
    column_count = len(merged["ratios tab"]["ratio triangle"]["development labels"])
    refreshed = 0
    changed = 0
    failed = 0
    errors: List[str] = []

    cells = [
        (row_index, col_index, str(inputs[row_index][col_index] or "").strip())
        for row_index, is_user_entry in enumerate(user_entry_flags)
        if is_user_entry
        for col_index in range(min(column_count, len(inputs[row_index])))
        if any(
            workbook_key(ref["book_path"]) == new_key
            for ref in _find_references_with_addresses(inputs[row_index][col_index])
        )
    ]

    def assign(row: int, col: int, value: float) -> bool:
        nonlocal changed
        current = canonical_number(values[row][col])
        next_value = canonical_number(value)
        values[row][col] = next_value
        if current is None or abs(float(current) - float(next_value)) > 1e-10:
            changed += 1
            return True
        return False

    for row_index, col_index, text in cells:
        range_info = _standalone_range(text)
        if range_info and workbook_key(range_info["book_path"]) == new_key:
            targets = _dfm_range_targets(
                user_entry_flags, row_index, col_index, range_info, column_count
            )
            if not targets:
                failed += range_info["row_count"] * range_info["col_count"]
                errors.append("The Excel range no longer maps to User Entry cells.")
                continue
            source_cells = _range_source_cells(range_info)
            numbers: List[float] = []
            range_error = ""
            for source_cell in source_cells:
                number = _finite_number(
                    read_map.get(_cell_key(new_book_path, range_info["sheet"], source_cell))
                )
                if number is None or number <= 0:
                    range_error = f"Excel cell {source_cell} must contain a number greater than 0."
                    break
                numbers.append(float(canonical_number(number)))
            if range_error:
                failed += len(targets)
                errors.append(range_error)
                continue
            refreshed += len(targets)
            for row, col, linear_index in targets:
                value = numbers[linear_index]
                assign(row, col, value)
                if not (row == row_index and col == col_index):
                    literal = _js_number_text(value)
                    inputs[row][col] = literal
                    if row < len(display_inputs) and col < len(display_inputs[row]):
                        display_inputs[row][col] = literal
            continue

        refreshed += 1
        expression = text if text.startswith("=") else f"={text}"
        unresolved = ""
        for ref in _find_references_with_addresses(expression):
            number = _finite_number(read_map.get(_cell_key(
                new_book_path if workbook_key(ref["book_path"]) == new_key else ref["book_path"],
                ref["sheet"],
                ref["cell"],
            )))
            if number is None:
                unresolved = f"Excel cell {ref['cell']} could not be read."
                break
            expression = expression.replace(ref["match"], _js_number_text(number))
        if unresolved:
            failed += 1
            errors.append(unresolved)
            continue
        if _DATASET_REFERENCE_TOKEN_RE.search(expression):
            failed += 1
            errors.append(
                "A formula mixing Excel and dataset references must be refreshed from the DFM Links tab."
            )
            continue
        result = _evaluate_internal_formula(expression, labels, values, col_index)
        if result is None or result <= 0:
            failed += 1
            errors.append("The refreshed formula result must be a number greater than 0.")
            continue
        assign(row_index, col_index, float(result))
    return refreshed, changed, failed, errors


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
    changed = _rewrite_link_references(links, old_key, new_book_path)
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


def _rewrite_link_references(links: List[Any], old_key: str, new_book_path: str) -> int:
    changed = 0
    for link in links:
        if not isinstance(link, dict):
            continue
        rewritten, count = rewrite_workbook_references(link.get("reference"), old_key, new_book_path)
        if not count:
            continue
        round_trip = find_workbook_references(rewritten)
        if not round_trip or any(
            workbook_key(item["book_path"]) == old_key for item in round_trip
        ):
            raise ValueError(f"Rewritten reference is not a valid workbook reference: {rewritten}")
        link["reference"] = rewritten
        changed += count
    return changed


def _retarget_dataset_with_refresh(
    path: str,
    project: str,
    reserving: str,
    old_key: str,
    new_book_path: str,
    read_map: Mapping[Tuple[str, str, str], Mapping[str, Any]],
) -> Dict[str, Any] | None:
    """Rewrite one sidecar's references and commit refreshed values.

    Changed values go through ``save_dataset_sidecar`` so the CSV, audit log,
    review statuses, and Engine propagation behave exactly like a normal save.
    When no value changes (or every read fails), only the reference text is
    replaced, exactly like the metadata-only retarget.
    """

    from app_server.services import dataset_service

    payload = _read_json_file(path)
    links = payload.get("external_links")
    if not isinstance(links, list) or not links:
        return None
    name = _clean(payload.get("dataset_name")) or os.path.splitext(os.path.basename(path))[0]
    changed_links = _rewrite_link_references(links, old_key, new_book_path)
    if not changed_links:
        return None

    refreshed = changed = failed = 0
    errors: List[str] = []
    values: List[List[Any]] | None = None
    try:
        model = dataset_service.load_cached_dataset_values(project, reserving, name)
        values = [list(row) for row in model.get("values") or []]
    except HTTPException as err:
        failed = sum(
            len(link.get("target_cells") or [])
            for link in links
            if isinstance(link, dict)
            and any(
                workbook_key(ref["book_path"]) == workbook_key(new_book_path)
                for ref in find_workbook_references(link.get("reference"))
            )
        )
        errors.append(_clean(err.detail) or "The dataset CSV could not be loaded.")
    if values is not None:
        refreshed, changed, failed, errors = _apply_dataset_link_values(
            links, values, workbook_key(new_book_path), read_map, new_book_path
        )

    result = {
        "kind": "dataset",
        "name": name,
        "ok": True,
        "changed_link_count": changed_links,
        "refreshed_cell_count": refreshed,
        "failed_refresh_count": failed,
        "value_changed": changed > 0,
    }
    if errors:
        result["refresh_errors"] = errors
    if changed > 0 and values is not None:
        is_vector = _clean(payload.get("data_format")).casefold() == "vector"
        period_length = payload.get("period_length") if is_vector else None
        origin_length = int(period_length or payload.get("origin_length") or len(values) or 1)
        development_length = int(
            period_length
            or payload.get("development_length")
            or max((len(row) for row in values), default=1)
        )
        save = dataset_service.save_dataset_sidecar(
            project,
            reserving,
            name,
            dataset_type=payload.get("dataset_type") or name,
            source_kind=payload.get("source_kind") or "input",
            data_format=payload.get("data_format") or "Triangle",
            origin_length=origin_length,
            development_length=development_length,
            cumulative=bool(payload.get("cumulative", True)),
            transposed=bool(payload.get("transposed")),
            calendar=bool(payload.get("calendar")),
            show_subtotal=payload.get("show_subtotal"),
            number_format=payload.get("number_format") or "",
            decimal_places=(
                payload.get("decimal_places")
                if payload.get("decimal_places") is not None
                else 1
            ),
            external_links=links,
            values=values,
        )
        result["propagation"] = save.get("calculated_updates")
        result["propagation_ok"] = bool(save.get("propagation_ok"))
    else:
        from app_server.services.dataset_service import _write_dataset_sidecar_payload

        _write_dataset_sidecar_payload(path, payload)
        result["surgical_write"] = True
    return result


def _retarget_dfm_with_refresh(
    path: str,
    project: str,
    reserving: str,
    old_key: str,
    new_book_path: str,
    read_map: Mapping[Tuple[str, str, str], Mapping[str, Any]],
) -> Dict[str, Any] | None:
    """Rewrite one DFM's references, refresh linked values, and save.

    The combined payload goes through ``save_dfm_method`` so revisions,
    publication, output CSVs, the output sidecar, review statuses, and Engine
    propagation follow the normal save rules. Cells whose refresh fails keep
    their stored values while the reference rewrite still persists.
    """

    from app_server.services import dfm_service

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
    changed_links = 0
    patched = json.loads(json.dumps(current))
    for matrix in _dfm_input_matrices(patched):
        for row in matrix:
            if not isinstance(row, list):
                continue
            for column, cell in enumerate(row):
                rewritten, count = rewrite_workbook_references(cell, old_key, new_book_path)
                if count:
                    row[column] = rewritten
                    changed_links += count
    if not changed_links:
        return None
    merged = apply_owned_patch(current, patched)
    refreshed, changed, failed, errors = _apply_dfm_refresh(
        merged, workbook_key(new_book_path), read_map, new_book_path
    )
    save = dfm_service.save_dfm_method(
        project,
        reserving,
        merged,
        expected_owned_revision=method_revisions(current)["owned revision"],
    )
    result = {
        "kind": "dfm",
        "name": name,
        "ok": True,
        "changed_link_count": changed_links,
        "refreshed_cell_count": refreshed,
        "failed_refresh_count": failed,
        "value_changed": changed > 0,
        "propagation": save.get("propagation"),
        "propagation_ok": bool(save.get("propagation_ok")),
    }
    if errors:
        result["refresh_errors"] = errors
    return result


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
    refresh_values: bool = False,
    listing: Callable[[str, str], Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Repoint every reference from one workbook to another across the class.

    The response carries the refreshed inventory so the client pays one round
    trip. ``listing`` supplies it; the route passes the transport-selecting
    loader so that re-scan is hosted like the plain listing, while the rewrite
    itself always runs here — it writes, and a value refresh opens the picked
    workbook through the caller's own drive mappings.
    """

    load_listing = listing or list_reserving_class_excel_links
    sidecar_dir, method_dir = _require_reserving_class_dirs(project_name, reserving_class)
    project = _clean(project_name)
    reserving = _clean(reserving_class)
    old_path = _clean(old_workbook_path)
    new_path = _clean(new_workbook_path)
    if not old_path or not new_path:
        raise HTTPException(400, "old_workbook_path and new_workbook_path are required.")
    old_key = workbook_key(old_path)
    if old_key == workbook_key(new_path):
        return {
            **load_listing(project, reserving),
            "results": [],
            "changed_file_count": 0,
            "changed_link_count": 0,
            "refresh_requested": bool(refresh_values),
            "message": "The selected workbook is already the current link.",
        }
    if not os.path.isfile(new_path):
        raise HTTPException(400, f"The selected workbook was not found: {new_path}")

    if refresh_values:
        # Refreshing commits real value changes, so fail fast before any write
        # when no Engine could run the resulting propagation walks or another
        # walk is still rewriting this reserving class.
        dependent_propagation_service.require_reserving_class_writable(
            project, reserving
        )
        sidecar_paths = _list_json_files(sidecar_dir, _SIDECAR_FILE_RE)
        method_paths = _list_json_files(method_dir, _DFM_METHOD_FILE_RE)
        read_map = _read_refresh_cells(_collect_refresh_read_items(
            _read_json_files(sidecar_paths),
            _read_json_files(method_paths),
            old_key,
            new_path,
        ))
        # The canonical save functions take the reserving-class lock per file,
        # so the slow batched Excel read above never blocks other writers.
        # The hold was preflighted once above; without the suspension the first
        # file's enqueued propagation job would make the class read as busy and
        # 423 every following file's save. The nested jobs coalesce into one
        # walk through the Engine's queued-request merge.
        with dependent_propagation_service.suspended_reserving_class_hold_check():
            results = _collect_file_results(
                "dataset",
                sidecar_paths,
                lambda path: _retarget_dataset_with_refresh(
                    path, project, reserving, old_key, new_path, read_map
                ),
            )
            results += _collect_file_results(
                "dfm",
                method_paths,
                lambda path: _retarget_dfm_with_refresh(
                    path, project, reserving, old_key, new_path, read_map
                ),
            )
        surgical_writes = [item for item in results if item.get("surgical_write")]
    else:
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
        surgical_writes = results

    changed_files = [item for item in results if item.get("ok")]
    index_error = ""
    if any(item.get("ok") for item in surgical_writes):
        # Value-refresh saves rebuild the index themselves; reference-only
        # rewrites still need one rebuild so the next read stays fast.
        from app_server.services import dataset_instance_index_service

        try:
            dataset_instance_index_service.rebuild_index(project, reserving)
        except Exception as err:  # A stale index self-heals on the next read.
            index_error = str(err)

    return {
        **load_listing(project, reserving),
        "ok": all(item.get("ok") for item in results),
        "results": results,
        "changed_file_count": len(changed_files),
        "changed_link_count": sum(int(item.get("changed_link_count") or 0) for item in changed_files),
        "refresh_requested": bool(refresh_values),
        "refreshed_cell_count": sum(int(item.get("refreshed_cell_count") or 0) for item in results),
        "failed_refresh_count": sum(int(item.get("failed_refresh_count") or 0) for item in results),
        "value_changed_file_count": sum(1 for item in results if item.get("value_changed")),
        "propagation_ok": all(
            item.get("propagation_ok", True) for item in results if item.get("ok")
        ),
        "index_ok": not index_error,
        "index_error": index_error,
    }
