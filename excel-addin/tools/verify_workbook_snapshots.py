"""Exercise the production VBA snapshot path in isolated desktop Excel sessions.

Run with Python 3.10 and pywin32 on a machine with Excel and trusted VBProject
access: ``py -3.10 excel-addin/tools/verify_workbook_snapshots.py``.
The only substituted dependency is the Gateway response/credential UI. No real
project, user workbook, add-in installation, or local config is read or changed.
All scratch workbooks live under repository test/ and are removed afterwards.
"""

from __future__ import annotations

import gc
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pythoncom
from win32com.client import DispatchEx


REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "excel-addin" / "src_vba"
TEST_ROOT = REPO_ROOT / "test"
RUNTIME_NAME = "ArcRhoSnapshotSmoke.xlsm"
MODULES = (
    "Core.bas", "Utilities.bas", "ArcRhoFunctions.bas", "WorkbookSnapshots.bas",
    "DatasetRefresh.bas", "WorkbookRefresh.bas", "SnapshotEvents.cls",
    "ufProgressBar.frm",
)


def check(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS {label}", flush=True)


@contextmanager
def excel_session():
    pythoncom.CoInitialize()
    excel = None
    try:
        excel = DispatchEx("Excel.Application")
        excel.DisplayAlerts = False
        excel.Visible = False
        excel.EnableEvents = False
        excel.ScreenUpdating = False
        yield excel
    finally:
        if excel is not None:
            try:
                while excel.Workbooks.Count:
                    excel.Workbooks(1).Close(False)
            finally:
                excel.Quit()
        excel = None
        gc.collect()
        pythoncom.CoUninitialize()


def runtime(excel, directory: Path):
    book = excel.Workbooks.Add()
    for name in MODULES:
        component = book.VBProject.VBComponents.Import(str(SOURCE / name))
        component.Name = Path(name).stem
        expected_type = {".bas": 1, ".cls": 2, ".frm": 3}[Path(name).suffix]
        if component.Type != expected_type:
            raise RuntimeError(f"Excel imported {name} as the wrong component type; check CRLF headers")
    book.VBProject.VBComponents.Import(
        str(Path(__file__).with_name("snapshot_smoke_helpers.bas"))
    )
    check(excel.Run("SnapshotSmokeHelpers.SmokeBasic") == "ready", "production VBA modules compile")
    book.SaveAs(str(directory / RUNTIME_NAME), 52)
    excel.Calculation = -4135  # xlCalculationManual, only in this owned instance.
    return book


def run(excel, name: str, *args):
    return excel.Run(f"'{RUNTIME_NAME}'!SnapshotSmokeHelpers.{name}", *args)


def formula(dataset: str, project: str = "Default") -> str:
    return (
        f"='{RUNTIME_NAME}'!ArcRhoTriCell("
        f'"Motor","{dataset}",1,1,TRUE,"{project}",12,12)'
    )


def report(excel, project: str):
    book = excel.Workbooks.Add()
    main = book.Worksheets(1)
    main.Name = "Report"
    settings = book.Worksheets.Add(After=main)
    settings.Name = "ResQ Settings"
    settings.Range("B7").Value2 = project
    other = book.Worksheets.Add(After=settings)
    other.Name = "Other"
    main.Range("A1").Formula = formula("Paid")
    main.Range("A2").Formula = formula("Paid")
    main.Range("A3").Formula = formula("Single")
    main.Range("A4").Formula = formula("Blank")
    main.Range("A6").Formula = formula("Paid").replace(",1,1,TRUE", ",1,2,TRUE")
    other.Range("A1").Formula = formula("Other")
    main.Activate()
    return book


def value(book, address="A1", sheet="Report"):
    return book.Worksheets(sheet).Range(address).Value2


def check_types(excel, book):
    # VBA VarType is checked as well as values: text must not become formulas,
    # empty strings must not become Empty, and Boolean/Error must survive Excel.
    expected = (
        (1, 1, 8, ""), (1, 2, 8, "00123"), (1, 3, 8, "=1+1"),
        (1, 4, 8, "~literal"), (2, 1, 5, 4.5), (2, 2, 11, True),
        (2, 3, 10, None), (2, 4, 0, None),
    )
    for row, col, kind, expected_value in expected:
        actual_type = run(excel, "SmokeSnapshotType", book.Name, "type-check", row, col)
        if actual_type != kind:
            raise AssertionError(f"Snapshot type ({row},{col}): {actual_type} != {kind}")
        if kind not in (0, 10):
            actual = run(excel, "SmokeSnapshotCell", book.Name, "type-check", row, col)
            if actual != expected_value:
                raise AssertionError(f"Snapshot value ({row},{col}): {actual!r}")
    check(
        run(excel, "SmokeSnapshotType", book.Name, "single-blank", 1, 1) == 8
        and run(excel, "SmokeSnapshotCell", book.Name, "single-blank", 1, 1) == "",
        "1x1 blank and mixed value types survive snapshot loading",
    )


def check_save_guards(excel, first, second):
    excel.EnableEvents = True
    run(excel, "SmokeBegin", first.Name)
    try:
        first.Worksheets("Report").Range("C1").Value2 = "Uncommitted change"
        first.Save()
        check(not first.Saved, "save is cancelled while that workbook is refreshing")
        count = excel.Workbooks.Count
        first.Close(False)
        check(excel.Workbooks.Count == count, "close is cancelled while that workbook is refreshing")
        second.Worksheets("Report").Range("C1").Value2 = "Independent change"
        second.Save()
        check(second.Saved, "another workbook can still save during the refresh")
    finally:
        run(excel, "SmokeAbort")
        excel.EnableEvents = False
        for book in (first, second):
            book.Worksheets("Report").Range("C1").ClearContents()
            book.Save()


def first_user(directory: Path) -> None:
    with excel_session() as excel:
        runtime(excel, directory)
        first = report(excel, "Alpha")
        first.Worksheets("Report").Calculate()
        required = run(excel, "SmokeRequiredMessage")
        check(value(first) == required and run(excel, "SmokeCalls") == 0,
              "new formula requires explicit refresh without contacting Gateway")

        run(excel, "SmokeRefresh", True)
        check(run(excel, "SmokeCalls") == 3 and value(first) == 100
              and value(first, "A2") == 100 and value(first, "A3") == 7,
              "worksheet refresh fetches each distinct request once, including 1x1")
        first.Worksheets("Other").Calculate()
        check(value(first, sheet="Other") == required,
              "worksheet refresh leaves another sheet's missing snapshot untouched")
        run(excel, "SmokeRefresh", False)
        check(run(excel, "SmokeCalls") == 7 and value(first, sheet="Other") == 100,
              "workbook refresh fetches four distinct requests once each: " + str(excel.StatusBar))
        check(value(first, "A6") == 110, "triangle cell indices preserve row/column orientation")
        check(run(excel, "SmokeRequestKeys"), "transpose is shared only for locally transformed datasets")

        second = report(excel, "Beta")
        run(excel, "SmokeRefresh", False)
        before = run(excel, "SmokeCalls")
        first.Worksheets("Report").Calculate()
        check(value(first) == 100 and value(second) == 200
              and run(excel, "SmokeCalls") == before,
              "inactive workbook formulas use their own saved default project")

        run(excel, "SmokeResponse", 10)
        run(excel, "SmokeBegin", first.Name, "Report")
        excel.CalculateFull()
        run(excel, "SmokeEnd")
        check(run(excel, "SmokeCalls") == before + 3 and value(first) == 110
              and value(first, sheet="Other") == 100 and value(second) == 200,
              "full Excel calculation during scoped refresh fetches only its target sheet")

        first.Activate()
        cache = run(excel, "SmokeSnapshotSheet")
        previous = first.Worksheets(cache).UsedRange.Value2
        run(excel, "SmokeResponse", 999)
        for mode in ("fail", "cancel"):
            check(run(excel, "SmokeFailedRefresh", mode), f"{mode} is reported")
            check(first.Worksheets(cache).UsedRange.Value2 == previous
                  and value(first) == 110 and value(second) == 200,
                  f"{mode} preserves the saved snapshot and restores displayed values")

        run(excel, "SmokeResponse", 10)
        before = run(excel, "SmokeCalls")
        excel.Calculation = -4105  # xlCalculationAutomatic.
        run(excel, "SmokeRefresh", False)
        check(run(excel, "SmokeCalls") == before + 4 and value(first) == 110,
              "automatic calculation also fetches each distinct request only once")
        run(excel, "SmokeSeedTypes", first.Name)
        run(excel, "SmokeForget", first.Name)
        check_types(excel, first)
        check(first.Worksheets(cache).Visible == 2, "snapshot sheet is VeryHidden")
        first.SaveAs(str(directory / "SharedReport.xlsx"), 51)
        second.SaveAs(str(directory / "OtherReport.xlsx"), 51)
        check_save_guards(excel, first, second)


def second_user(directory: Path) -> None:
    with excel_session() as excel:
        runtime(excel, directory)
        excel.Calculation = -4105
        first = excel.Workbooks.Open(str(directory / "SharedReport.xlsx"), 0, True)
        second = excel.Workbooks.Open(str(directory / "OtherReport.xlsx"), 0, True)
        check(value(first) == 110 and value(second) == 200,
              "fresh Excel session opens each report with its last saved figures")
        excel.CalculateFullRebuild()
        check(value(first) == 110 and value(second) == 200
              and run(excel, "SmokeCalls") == 0,
              "full rebuild of read-only reopened reports performs zero Gateway requests")
        check_types(excel, first)
        first.Worksheets("Report").Range("A5").Formula = formula("Uncached")
        first.Worksheets("Report").Calculate()
        check(value(first, "A5") == run(excel, "SmokeRequiredMessage")
              and run(excel, "SmokeCalls") == 0,
              "new request in a reopened workbook requires refresh without network access")


def main() -> None:
    created_test_root = not TEST_ROOT.exists()
    TEST_ROOT.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="excel-snapshots-", dir=TEST_ROOT) as scratch:
            directory = Path(scratch)
            first_user(directory)
            second_user(directory)
    finally:
        gc.collect()
        if created_test_root and TEST_ROOT.exists() and not any(TEST_ROOT.iterdir()):
            TEST_ROOT.rmdir()
    print("Workbook snapshot COM smoke checks passed.", flush=True)


if __name__ == "__main__":
    main()
