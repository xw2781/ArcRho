# <arcrho-macro>
# Title: Show Diagnostic Triangle
# Version: 1.0.0
# Release Note: Initial release for opening the diagnostic triangle linked to the active DFM.
# Description: Open the diagnostic dataset linked to the active Project Instance DFM using
#   E:\ResQ\Automations\Reserve Review\diagnostic_mapping.xlsx.
# Scope: DFM
# </arcrho-macro>

from __future__ import annotations

import importlib
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import arcrho_api
import arcrho_api.ui as arcrho_ui_module

# The embedded macro runner can keep modules loaded between runs; reload so the
# window-object UI API is visible after an ArcRho update.
importlib.reload(arcrho_ui_module)
importlib.reload(arcrho_api)
from arcrho_api import ArcRhoUI, message_box

MAPPING_WORKBOOK = Path(r"E:\ResQ\Automations\Reserve Review\diagnostic_mapping.xlsx")
NOT_FOUND_MESSAGE = "No linked diagnostic dataset found for this method."

_NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _show(message: str, title: str = "Show Diagnostic Triangle") -> None:
    message_box(message, title=title, buttons=["OK"], kind="info")


def _normal_key(value: object) -> str:
    text = str(value or "").strip()
    if text.lower().startswith("dfm:"):
        text = text[4:].strip()
    return re.sub(r"\s+", " ", text).casefold()


def _cell_column(cell_ref: str) -> int:
    letters = "".join(ch for ch in str(cell_ref or "") if ch.isalpha()).upper()
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - ord("A") + 1)
    return col


def _xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext())


def _load_shared_strings(book: zipfile.ZipFile) -> list[str]:
    try:
        raw = book.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    return [_xml_text(item) for item in root.findall(f"{_NS_MAIN}si")]


def _first_sheet_path(book: zipfile.ZipFile) -> str:
    workbook = ET.fromstring(book.read("xl/workbook.xml"))
    sheets = workbook.find(f"{_NS_MAIN}sheets")
    first_sheet = sheets.find(f"{_NS_MAIN}sheet") if sheets is not None else None
    if first_sheet is None:
        raise ValueError("Mapping workbook has no worksheets.")

    rel_id = first_sheet.attrib.get(f"{_NS_REL}id", "")
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall(f"{_REL_NS}Relationship"):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib.get("Target", "")
            if target.startswith("/"):
                return target.lstrip("/")
            return "xl/" + target.lstrip("/")
    raise ValueError("Could not resolve the first worksheet in the mapping workbook.")


def _cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        return _xml_text(cell.find(f"{_NS_MAIN}is"))
    value = _xml_text(cell.find(f"{_NS_MAIN}v"))
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (ValueError, IndexError):
            return ""
    return value.strip()


def _iter_mapping_rows(workbook_path: Path):
    with zipfile.ZipFile(workbook_path) as book:
        shared_strings = _load_shared_strings(book)
        sheet_path = _first_sheet_path(book)
        root = ET.fromstring(book.read(sheet_path))
        sheet_data = root.find(f"{_NS_MAIN}sheetData")
        if sheet_data is None:
            return
        for row in sheet_data.findall(f"{_NS_MAIN}row"):
            values = {}
            for cell in row.findall(f"{_NS_MAIN}c"):
                col = _cell_column(cell.attrib.get("r", ""))
                if col:
                    values[col] = _cell_value(cell, shared_strings).strip()
            yield values


def _find_diagnostic_dataset(method_name: str) -> str:
    wanted = _normal_key(method_name)
    if not wanted:
        return ""
    if not MAPPING_WORKBOOK.exists():
        raise FileNotFoundError(f"Mapping workbook not found: {MAPPING_WORKBOOK}")
    for row in _iter_mapping_rows(MAPPING_WORKBOOK):
        source_method = row.get(1, "")
        diagnostic_dataset = row.get(2, "")
        if _normal_key(source_method) == wanted:
            return str(diagnostic_dataset or "").strip()
    return ""


def run_macro(active_dfm=None, active_context=None):
    app = ArcRhoUI()
    window = app.project_instance.active_window()
    if not window:
        _show("Activate a DFM window in a Project Instance page first.")
        return {"message": "No active Project Instance window."}

    props = window.properties
    if props.kind != "dfm":
        _show("Activate a DFM window in a Project Instance page first.")
        return {"message": "The active Project Instance window is not a DFM window."}

    method_name = props.item_name or props.name or props.dataset_name
    diagnostic_dataset = _find_diagnostic_dataset(method_name)
    if not diagnostic_dataset:
        _show(NOT_FOUND_MESSAGE)
        return {"message": NOT_FOUND_MESSAGE}

    opened = app.project_instance.open_dataset(diagnostic_dataset)
    print(f"Opened diagnostic dataset '{diagnostic_dataset}' for DFM '{method_name}'.")
    return {
        "message": f"Opened diagnostic dataset: {diagnostic_dataset}",
        "details": {
            "methodName": method_name,
            "diagnosticDataset": diagnostic_dataset,
            "windowId": opened.id,
        },
    }
