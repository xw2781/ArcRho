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
import time
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
    "DatasetRefresh.bas", "WorkbookRefresh.bas", "FormulaEntry.bas", "SnapshotEvents.cls",
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
                excel.EnableEvents = False
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
        f"='{RUNTIME_NAME}'!ArcoTriCell("
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


def vector_report(excel):
    book = excel.Workbooks.Add()
    sheet = book.Worksheets(1)
    sheet.Name = "Vectors"
    prefix = f"='{RUNTIME_NAME}'!"
    for cell, function, dataset, index in (
        ("A1", "ArcoVecCell", "Vertical", 1),
        ("A2", "ADASVecCell", "Vertical", 3),
        ("A3", "ArcoVecCell", "Horizontal", 2),
        ("A4", "ArcoVecCell", "VectorSingle", 1),
    ):
        sheet.Range(cell).Formula = prefix + f'{function}("Motor","{dataset}",{index},"Alpha",12)'
    sheet.Range("C1:C3").FormulaArray = prefix + 'ArcoVec("Motor","Vertical",FALSE,"Alpha",12)'
    sheet.Range("E1:G1").FormulaArray = prefix + 'ArcoVec("Motor","Vertical",TRUE,"Alpha",12)'
    sheet.Range("E2:G2").FormulaArray = prefix + 'ADASVec("Motor","Horizontal",FALSE,"Alpha",12)'
    return book


def check_vectors(book):
    sheet = book.Worksheets("Vectors")
    check(sheet.Range("A1:A4").Value2 == ((10,), (30,), (20,), (42,))
          and sheet.Range("C1:C3").Value2 == ((10,), (20,), (30,))
          and sheet.Range("E1:G2").Value2 == ((10, 20, 30), (10, 20, 30)),
          "VecCell and ADAS aliases preserve vertical, horizontal and scalar vector values")


def first_user(directory: Path) -> None:
    with excel_session() as excel:
        runtime(excel, directory)
        first = report(excel, "Alpha")
        first.Worksheets("Report").Calculate()
        required = run(excel, "SmokeRequiredMessage")
        check(value(first) == required and run(excel, "SmokeCalls") == 0,
              "uncached formulas calculated without a user edit stay offline")

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
            check(run(excel, "SmokeFailedRefresh", mode, True), f"{mode} is reported")
            check(first.Worksheets(cache).UsedRange.Value2 == previous
                  and value(first) == 110 and value(second) == 200
                  and not run(excel, "SmokeProgressVisible"),
                  f"{mode} closes progress, preserves the snapshot and restores displayed values")

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
        vectors = vector_report(excel)
        before = run(excel, "SmokeCalls")
        run(excel, "SmokeRefresh")
        check_vectors(vectors)
        check(run(excel, "SmokeCalls") == before + 3,
              "vector cells, arrays, aliases and transpose share their three dataset requests")
        vectors.SaveAs(str(directory / "Vectors.xlsx"), 51)
        legacy = report(excel, "Alpha")
        legacy.Worksheets("Report").Calculate()
        legacy.SaveAs(str(directory / "LegacyUncached.xlsx"), 51)


def second_user(directory: Path) -> None:
    with excel_session() as excel:
        runtime(excel, directory)
        excel.Calculation = -4105
        first = excel.Workbooks.Open(str(directory / "SharedReport.xlsx"), 0, True)
        second = excel.Workbooks.Open(str(directory / "OtherReport.xlsx"), 0, True)
        vectors = excel.Workbooks.Open(str(directory / "Vectors.xlsx"), 0, True)
        check(value(first) == 110 and value(second) == 200,
              "fresh Excel session opens each report with its last saved figures")
        excel.CalculateFullRebuild()
        check(value(first) == 110 and value(second) == 200
              and run(excel, "SmokeCalls") == 0,
              "full rebuild of read-only reopened reports performs zero Gateway requests")
        check_types(excel, first)
        check_vectors(vectors)
        first.Worksheets("Report").Range("A5").Formula = formula("Uncached")
        first.Worksheets("Report").Calculate()
        check(value(first, "A5") == run(excel, "SmokeRequiredMessage")
              and run(excel, "SmokeCalls") == 0,
              "recalculation without edit events cannot fetch missing requests")


def formula_entry(directory: Path) -> None:
    with excel_session() as excel:
        owner = runtime(excel, directory)
        run(excel, "SmokePrepare", owner.Name)
        excel.EnableEvents = True
        excel.Calculation = -4105
        legacy = excel.Workbooks.Open(str(directory / "LegacyUncached.xlsx"), 0, True)
        excel.CalculateFullRebuild()
        check(value(legacy) == run(excel, "SmokeRequiredMessage")
              and run(excel, "SmokeCalls") == 0,
              "opening a legacy workbook without snapshots does not fetch existing formulas")
        legacy.Close(False)
        book = excel.Workbooks.Open(str(directory / "SharedReport.xlsx"), 0, True)
        excel.CalculateFullRebuild()
        check(value(book) == 110 and run(excel, "SmokeCalls") == 0,
              "enabled edit events still open and rebuild saved formulas offline")
        sheet = book.Worksheets("Report")
        sheet.Range("A5").Formula = formula("Entered")
        check(value(book, "A5") == 100 and value(book) == 110
              and run(excel, "SmokeCalls") == 1,
              "entering a new formula immediately fetches only its missing request")
        run(excel, "SmokeResponse", 10)
        sheet.Range("A7:A16").Formula = formula("Pasted")
        check(all(row[0] == 110 for row in sheet.Range("A7:A16").Value2)
              and run(excel, "SmokeCalls") == 2,
              "pasting repeated new formulas fetches their shared dataset once")
        credentials = run(excel, "SmokeCredentialCalls")
        sheet.Range("A17").Formula = formula("Entered")
        check(value(book, "A17") == 100 and run(excel, "SmokeCalls") == 2
              and run(excel, "SmokeCredentialCalls") == credentials,
              "a newly entered cached formula reuses saved values without credential enrollment")
        sheet.Range("A5").Formula = formula("Edited")
        check(value(book, "A5") == 110 and run(excel, "SmokeCalls") == 3,
              "editing a formula loads its new request without a ribbon refresh")
        excel.Calculation = -4135
        sheet.Range("A18").Formula = formula("ManualEntry")
        check(value(book, "A18") == 110 and run(excel, "SmokeCalls") == 4
              and excel.Calculation == -4135,
              "formula entry returns values without changing manual calculation mode")
        excel.Calculation = -4105
        cache = run(excel, "SmokeSnapshotSheet")
        previous = book.Worksheets(cache).UsedRange.Value2
        run(excel, "SmokeResponse", 999, "fail")
        sheet.Range("A19").Formula = formula("EntryFailure")
        check(book.Worksheets(cache).UsedRange.Value2 == previous
              and value(book) == 110 and value(book, "A17") == 100
              and "Simulated Gateway failure" in str(value(book, "A19")),
              "a failed new formula leaves existing saved requests unchanged")
        run(excel, "SmokeResponse", 0)
        sheet.Range("A19").Formula = formula("EntryFailure")
        check(value(book, "A19") == 100,
              "re-entering a failed formula retries its missing request")
        before = run(excel, "SmokeCalls")
        prefix = f"='{RUNTIME_NAME}'!"
        sheet.Range("F1:F3").FormulaArray = prefix + 'ArcoVec("Motor","ProjectVector",FALSE,"Beta",12)'
        sheet.Range("F5").Formula = prefix + 'ArcoVecCell("Motor","ProjectVector",2,"Beta",12)'
        sheet.Range("G1:G3").FormulaArray = prefix + 'ArcoVec("Motor","ProjectVector",FALSE,"Default",12)'
        sheet.Range("G5").Formula = prefix + 'ArcoVecCell("Motor","ProjectVector",2,"Alpha",12)'
        check(sheet.Range("F1:F3").Value2 == ((200,), (210,), (220,))
              and sheet.Range("F5").Value2 == 210
              and sheet.Range("G1:G3").Value2 == ((100,), (110,), (120,))
              and sheet.Range("G5").Value2 == 110
              and run(excel, "SmokeCalls") == before + 2,
              "entered Vec and VecCell honor an explicit project and distinguish the workbook default")
        book.SaveAs(str(directory / "EnteredReport.xlsx"), 51)
        fresh = excel.Workbooks.Add()
        fresh.Worksheets(1).Range("A1").Formula = formula("FirstFormula", "Alpha")
        check(fresh.Worksheets(1).Range("A1").Value2 == 100,
              "the first Arco formula in a new workbook loads immediately")

    with excel_session() as excel:
        owner = runtime(excel, directory)
        run(excel, "SmokePrepare", owner.Name)
        excel.EnableEvents = True
        excel.Calculation = -4105
        book = excel.Workbooks.Open(str(directory / "EnteredReport.xlsx"), 0, True)
        excel.CalculateFullRebuild()
        check(value(book, "A5") == 110 and value(book, "A17") == 100
              and value(book, "A19") == 100
              and value(book, "F5") == 210 and run(excel, "SmokeCalls") == 0,
              "automatically fetched formula values persist across fresh Excel sessions")


def large_workbook(excel) -> None:
    book = excel.Workbooks.Add()
    sheets = [book.Worksheets(1)]
    sheets.append(book.Worksheets.Add(After=sheets[0]))
    for index, sheet in enumerate(sheets):
        sheet.Name = f"Large{index + 1}"
        sheet.Range("A1:BH1000").Formula = "=ROW()+COLUMN()"
        sheet.Range("BJ1:CC1000").FormulaArray = formula("LargeArray", "Alpha")
        sheet.Range("A1002").Formula = formula(f"LargeScalar{index}", "Alpha")
    sheets[0].Activate()
    before = run(excel, "SmokeCalls")
    started = time.monotonic()
    run(excel, "SmokeRefresh", False, True)
    elapsed = time.monotonic() - started
    print(f"INFO large workbook refresh completed in {elapsed:.2f}s", flush=True)
    check(run(excel, "SmokeCalls") == before + 3
          and all(sheet.Range("A1002").Value2 == 100 for sheet in sheets)
          and all(sheet.Range("BJ1").Value2 == 100 for sheet in sheets),
          "visible workbook refresh handles 120,000 ordinary formulas and 40,000 array cells")
    check(run(excel, "SmokeProgressCalls") == 3
          and run(excel, "SmokeFirstProgress") > 0
          and not run(excel, "SmokeProgressVisible"),
          "real modeless progress advances before dataset requests begin")
    book.Close(False)


def collector_ranges(excel) -> None:
    book = excel.Workbooks.Add()
    sheet = book.Worksheets(1)
    sheet.Range("B1:C4").FormulaArray = formula("FirstArray", "Alpha")
    sheet.Range("D1:F4").FormulaArray = formula("SecondArray", "Alpha")
    sheet.Range("G1").Formula = formula("BesideArrays", "Alpha")
    sheet.Range("J1").Formula = "=1+1"
    found = run(excel, "SmokeBlocks", book.Name, "B2,D2,G1,J1")
    check(set(found.split("|")) == {"$B$1:$C$4", "$D$1:$F$4", "$G$1"},
          "discontiguous edits find adjacent legacy arrays and their neighboring scalar once")
    check(run(excel, "SmokeBlocks", book.Name, "B2") == "$B$1:$C$4"
          and run(excel, "SmokeBlocks", book.Name, "J1") == "",
          "single-cell discovery stays scoped to the edited cell or its containing array")
    book.Close(False)


def main() -> None:
    created_test_root = not TEST_ROOT.exists()
    TEST_ROOT.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="excel-snapshots-", dir=TEST_ROOT) as scratch:
            directory = Path(scratch)
            first_user(directory)
            second_user(directory)
            formula_entry(directory)
            with excel_session() as excel:
                runtime(excel, directory)
                collector_ranges(excel)
                large_workbook(excel)
    finally:
        gc.collect()
        if created_test_root and TEST_ROOT.exists() and not any(TEST_ROOT.iterdir()):
            TEST_ROOT.rmdir()
    print("Workbook snapshot COM smoke checks passed.", flush=True)


if __name__ == "__main__":
    main()
