"""Verify a built XLAM against current VBA sources in a private Excel instance.

Usage: py -3.10 excel-addin/tools/verify_built_addin.py path/to/ARCRHO_BETA.xlam
The add-in is opened read-only with events disabled. Configuration routines are
stubbed only in memory to inspect the settings form without touching user files.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
from verify_workbook_snapshots import SOURCE, check, excel_session


def code_lines(text: str, *, exported: bool = False) -> list[str]:
    lines = text.splitlines()
    if exported:
        markers = [i for i, line in enumerate(lines) if line.startswith("Attribute VB_Exposed")]
        if markers:
            lines = lines[markers[-1] + 1:]
    return [line.strip().casefold() for line in lines
            if line.strip() and not line.startswith("Attribute ")]


def replace_procedure(module, name: str, replacement: str) -> None:
    start = module.ProcStartLine(name, 0)
    count = module.ProcCountLines(name, 0)
    module.DeleteLines(start, count)
    module.AddFromString(replacement)


def verify(path: Path) -> None:
    with excel_session() as excel:
        book = excel.Workbooks.Open(str(path.resolve()), 0, True)
        sources = [source for source in SOURCE.iterdir() if source.suffix in (".bas", ".cls", ".frm")]
        for source in sources:
            component = book.VBProject.VBComponents(source.stem)
            module = component.CodeModule
            expected_type = 100 if source.stem == "ThisWorkbook" else {
                ".bas": 1, ".cls": 2, ".frm": 3,
            }[source.suffix]
            if component.Type != expected_type:
                raise AssertionError(f"Wrong built component type: {source.name}")
            actual = module.Lines(1, module.CountOfLines) if module.CountOfLines else ""
            if code_lines(actual) != code_lines(source.read_text(encoding="cp1252"), exported=True):
                raise AssertionError(f"Built VBA differs from current source: {source.name}")
        check(True, f"all {len(sources)} built VBA modules and forms match current sources")

        core = book.VBProject.VBComponents("Core").CodeModule
        replace_procedure(core, "LoadConfig", "Public Sub LoadConfig()\r\nEnd Sub")
        replace_procedure(core, "UpdateConfigValue", "Public Sub UpdateConfigValue(ByVal keyName As String, ByVal newValue As String)\r\nEnd Sub")
        probe = book.VBProject.VBComponents.Add(1)
        probe.Name = "BuildVerification"
        probe.CodeModule.AddFromString("\r\n".join((
            "Public Function VerifyBuiltAddin() As String",
            "    Load ufSettings",
            "    VerifyBuiltAddin = ARCRHO_VERSION & Chr(124) & CStr(Not ufSettings.OptionButton1.Visible) & Chr(124) & CStr(Not ufSettings.OptionButton2.Visible) & Chr(124) & CStr(ufSettings.Label1.Visible)",
            "    Unload ufSettings",
            "End Function",
        )))
        result = excel.Run(f"'{book.Name}'!BuildVerification.VerifyBuiltAddin")
        version = re.search(r'ARCRHO_VERSION As String = "([^"]+)"', (SOURCE / "Core.bas").read_text()).group(1)
        check(result == f"{version}|True|True|True",
              f"built add-in compiles as version {version}; obsolete refresh controls are hidden")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("addin", type=Path)
    verify(parser.parse_args().addin)
