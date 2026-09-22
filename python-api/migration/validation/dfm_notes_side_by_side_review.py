"""Side-by-side ArcRho vs ResQ review of the Method Notes on every DFM.

A DFM's Method Notes are the sentence a reviewer wrote to explain a selection,
and they are the one piece of a method that travels to ResQ as plain text
rather than as numbers. ArcRho keeps them in the DFM's *output sidecar* --
the same field ``export_reserving_class_to_resq`` writes into ResQ's ``Notes``
-- so that is the text compared here, against ``DFM.Notes`` read live from
ResQ.

The two systems store the same sentence with different line breaks: ArcRho
writes ``\\n`` and ResQ needs ``\\r\\n``, and ResQ keeps whatever trailing blank
lines it was handed. Line endings and trailing blank lines are therefore
normalised away before the comparison, so only a real wording difference is
reported.

Notes are compared line by line, which is what a reviewer wants to see: the
workbook block lays ArcRho's line beside ResQ's and marks the ones that
disagree, rather than showing two paragraphs and leaving the reader to find
the difference.

Nothing is written back to ArcRho or ResQ. This module is the DFM-notes half
of ``combined_side_by_side_review.py``, which is what the "Review Reserving
Class against ResQ" macro runs; it is not a command line of its own.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

_VALIDATION_DIR = Path(__file__).resolve().parent
_MIGRATION_DIR = _VALIDATION_DIR.parent
if str(_MIGRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_MIGRATION_DIR))
if str(_VALIDATION_DIR) not in sys.path:
    sys.path.insert(0, str(_VALIDATION_DIR))

import resq_data_migration as migration  # noqa: E402
from dataset_side_by_side_review import resq_credentials  # noqa: E402
from resq_migration.core import (  # noqa: E402
    _clean_name,
    _encode_rc_folder,
    _normalize_import_name,
    _safe_attr,
)


TARGET_PROJECT_NAME = "NJ_Annual_Prod_2026 Q3-Aug"

# What the combined workbook's Summary calls a notes row, so a reviewer
# reading the Summary knows a DFM's notes are what disagreed, and the kind
# written beside it.
NOTES_TYPE_LABEL = "DFM Notes"
NOTES_KIND = "DFM"

# A note is prose, not a number, so the block that shows it is laid out in
# fixed columns rather than autosized to the longest sentence in the class.
LINE_COLUMN_WIDTH = 30
TEXT_COLUMN_WIDTH = 64
VERDICT_COLUMN_WIDTH = 10

SAME_LABEL = "same"
DIFFERS_LABEL = "differs"


def _normalized_lines(text: Any) -> list[str]:
    """One note as the lines that carry meaning on both sides.

    ArcRho separates lines with ``\\n`` and ResQ with ``\\r\\n``, and a note
    that was typed with a blank line at the end keeps it in one store and not
    always in the other, so neither difference is a disagreement.
    """

    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return lines


def _read_arcrho_dfm_notes(rc_dir: Path) -> dict[str, dict]:
    """Map DFM name -> the persisted ArcRho Method Notes for one reserving class.

    Every DFM with a persisted method JSON is listed, whether or not it has
    published an output yet, because a DFM missing from ResQ is worth reporting
    even when nobody has written a note on it. The notes themselves come from
    the output sidecar, which is the only place ArcRho keeps them.
    """

    methods_dir = rc_dir / "methods"
    sidecar_dir = rc_dir / "sidecars"

    notes_by_key: dict[str, dict] = {}
    if sidecar_dir.is_dir():
        for path in sorted(sidecar_dir.glob("*.json")):
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(meta, dict):
                continue
            if _clean_name(meta.get("method_type")).casefold() != "dfm":
                continue
            name = _clean_name(meta.get("method_name")) or _clean_name(meta.get("dataset_name"))
            if not name:
                continue
            notes_by_key[_normalize_import_name(name)] = {
                "name": name,
                "notes": str(meta.get("notes") or ""),
            }

    out: dict[str, dict] = {}
    if methods_dir.is_dir():
        for path in sorted(methods_dir.glob("DFM@*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            details = payload.get("details_tab")
            name = _clean_name((details or {}).get("name")) or path.stem
            key = _normalize_import_name(name)
            sidecar = notes_by_key.pop(key, None)
            out[key] = {
                "name": name,
                "notes": str((sidecar or {}).get("notes") or ""),
                "has_output": sidecar is not None,
            }

    # A published output whose method JSON has since been deleted still holds
    # notes ResQ may disagree with, so it is compared rather than dropped.
    for key, sidecar in notes_by_key.items():
        out[key] = {"name": sidecar["name"], "notes": sidecar["notes"], "has_output": True}
    return out


def _resq_dfm_notes(dfm: Any) -> str:
    return str(_safe_attr(dfm, "Notes", "") or "")


def _build_notes_record(
    rc_path: str,
    name: str,
    arcrho: dict | None,
    resq_notes: str | None,
) -> dict:
    """One DFM's notes on both sides, line by line, with what disagrees."""

    arcrho_notes = str((arcrho or {}).get("notes") or "")
    resq_text = "" if resq_notes is None else str(resq_notes)
    arcrho_lines = _normalized_lines(arcrho_notes)
    resq_lines = _normalized_lines(resq_text)

    line_count = max(len(arcrho_lines), len(resq_lines))
    rows: list[dict] = []
    differing_lines = 0
    for index in range(line_count):
        arcrho_line = arcrho_lines[index] if index < len(arcrho_lines) else ""
        resq_line = resq_lines[index] if index < len(resq_lines) else ""
        same = arcrho_line == resq_line
        if not same:
            differing_lines += 1
        rows.append({"line": index + 1, "arcrho": arcrho_line, "resq": resq_line, "same": same})

    note_parts: list[str] = []
    if resq_notes is None:
        note_parts.append("DFM exists in Arco only")
    if arcrho is None:
        note_parts.append("DFM exists in ResQ only")

    if arcrho is not None and resq_notes is not None and differing_lines:
        if not arcrho_lines:
            note_parts.append("ResQ has Method Notes where Arco has none")
            if not arcrho.get("has_output", True):
                note_parts.append("the DFM has published no output, so Arco holds no Method Notes yet")
        elif not resq_lines:
            note_parts.append("Arco has Method Notes where ResQ has none")
        else:
            note_parts.append(f"Method Notes differ on {differing_lines} line(s)")

    note = "; ".join(note_parts)
    return {
        "rc_path": rc_path,
        "name": name,
        "kind": NOTES_KIND,
        "arcrho_notes": arcrho_notes,
        "resq_notes": resq_text,
        "lines": rows,
        "line_count": line_count,
        "differing_lines": differing_lines,
        "matches": differing_lines == 0,
        "note": note,
        "needs_review": bool(note),
    }


def run_comparison(
    *,
    project_name: str = TARGET_PROJECT_NAME,
    rc_paths: list[str] | None = None,
    app_factory=None,
    credentials: dict[str, str] | None = None,
    progress=print,
) -> tuple[list[dict], list[tuple[str, str]]]:
    """Compare the Method Notes of every DFM in scope.

    Returns (records, rc_errors) where records covers every DFM found on
    either side and rc_errors lists reserving classes ResQ itself refused.
    """

    if app_factory is None:
        try:
            import win32com.client
        except ImportError as exc:
            raise RuntimeError("pywin32 is required: pip install pywin32") from exc

    rc_paths = list(rc_paths or [])
    previous_scope = migration._apply_runtime_scope(project_name, migration.SERVER_ROOT)
    account = resq_credentials(credentials)
    app = app_factory() if app_factory is not None else win32com.client.Dispatch("ResQ3Automation.ResQApplication")
    records: list[dict] = []
    rc_errors: list[tuple[str, str]] = []
    try:
        app.ConnectByName(account["connection_name"], account["user_name"], account["password"])
        project = app.Projects().Item(project_name)

        for rc_index, rc_path in enumerate(rc_paths, start=1):
            progress(f"RC {rc_index}/{len(rc_paths)}: {rc_path}")
            rc_dir = migration.PROJECT_DATA_DIR / _encode_rc_folder(rc_path)
            arcrho_methods = _read_arcrho_dfm_notes(rc_dir)

            try:
                reserving_class = project.ReservingClasses().Item(rc_path)
                dfm_collection = list(reserving_class.DFMMethods())
            except Exception as exc:
                rc_errors.append((rc_path, f"could not read ResQ reserving class: {type(exc).__name__}: {exc}"))
                continue

            resq_notes: dict[str, tuple[str, str]] = {}
            for dfm in dfm_collection:
                name = _clean_name(_safe_attr(dfm, "Name", ""))
                if not name:
                    continue
                try:
                    text = _resq_dfm_notes(dfm)
                except Exception as exc:
                    rc_errors.append(
                        (rc_path, f"could not read ResQ notes for DFM {name}: {type(exc).__name__}: {exc}")
                    )
                    continue
                resq_notes[_normalize_import_name(name)] = (name, text)

            for key in sorted(set(arcrho_methods) | set(resq_notes), key=str.casefold):
                arcrho = arcrho_methods.get(key)
                resq = resq_notes.get(key)
                display_name = (arcrho or {}).get("name") or (resq[0] if resq else key)
                records.append(
                    _build_notes_record(rc_path, display_name, arcrho, resq[1] if resq else None)
                )
    finally:
        try:
            app.Disconnect()
        except Exception:
            pass
        migration._restore_runtime_scope(previous_scope)
    return records, rc_errors


def _write_notes_block(sheet, start_row: int, record: dict, styles: dict) -> tuple[int, int]:
    """Write one DFM's ArcRho | ResQ notes, line by line. Returns (header_row, next_free_row)."""

    from openpyxl.styles import Alignment

    wrap = Alignment(vertical="top", wrap_text=True)

    header_row = start_row
    header_cell = sheet.cell(row=header_row, column=1, value=record["name"])
    header_cell.font = styles["bold"]
    if record["note"]:
        note_cell = sheet.cell(row=header_row, column=4, value=record["note"])
        note_cell.font = styles["note"]

    label_row = header_row + 1
    for column, text in enumerate(("Line", "Arco", "ResQ", "Same?"), start=1):
        cell = sheet.cell(row=label_row, column=column, value=text)
        cell.font = styles["bold"]
        cell.fill = styles["header_fill"]

    row = label_row + 1
    if not record["lines"]:
        sheet.cell(row=row, column=1, value="(no Method Notes on either side)")
        return header_row, row

    for entry in record["lines"]:
        sheet.cell(row=row, column=1, value=f"Line {entry['line']}")
        arcrho_cell = sheet.cell(row=row, column=2, value=entry["arcrho"] or None)
        arcrho_cell.alignment = wrap
        resq_cell = sheet.cell(row=row, column=3, value=entry["resq"] or None)
        resq_cell.alignment = wrap
        verdict = sheet.cell(row=row, column=4, value=SAME_LABEL if entry["same"] else DIFFERS_LABEL)
        if not entry["same"]:
            verdict.fill = styles["flag_fill"]
            arcrho_cell.fill = styles["flag_fill"]
            resq_cell.fill = styles["flag_fill"]
        row += 1
    return header_row, row - 1


def size_notes_sheet(sheet) -> None:
    """Fixed widths for a sheet of prose, where autosizing reads badly."""

    sheet.column_dimensions["A"].width = LINE_COLUMN_WIDTH
    sheet.column_dimensions["B"].width = TEXT_COLUMN_WIDTH
    sheet.column_dimensions["C"].width = TEXT_COLUMN_WIDTH
    sheet.column_dimensions["D"].width = VERDICT_COLUMN_WIDTH
