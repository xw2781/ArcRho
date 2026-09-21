"""Verify a built XLAM against current VBA sources in a private Excel instance.

Usage: py -3.10 excel-addin/tools/verify_built_addin.py path/to/ARCRHO_BETA.xlam
The add-in is opened read-only with events disabled. The whole VBA project is
compiled through the VBE's own Compile command, because running a macro only
compiles the procedures it reaches: the 4.0.1 build passed the macro probe and
still raised "Variable not defined" on every worksheet formula. A watcher reads
and closes the modal dialog VBA shows for a compile error, so the failure is
reported here instead of hanging the session. Configuration routines are
stubbed only in memory to inspect the settings form without touching user files.
"""

from __future__ import annotations

import argparse
import ctypes
import re
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

sys.dont_write_bytecode = True
from verify_workbook_snapshots import SOURCE, check, excel_session

COMPILE_PROJECT_CONTROL_ID = 578  # the VBE's Debug > Compile <project> command
BM_CLICK = 0x00F5
WM_CLOSE = 0x0010

user32 = ctypes.windll.user32
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def _window_text(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _class_name(hwnd: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def _children(hwnd: int) -> list[int]:
    found: list[int] = []

    def collect(child, _):
        found.append(child)
        return True

    user32.EnumChildWindows(hwnd, WNDENUMPROC(collect), 0)
    return found


def _vba_dialogs(pid: int) -> list[int]:
    found: list[int] = []

    def collect(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and _class_name(hwnd) == "#32770" \
                and _window_text(hwnd).startswith("Microsoft Visual Basic"):
            found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(collect), 0)
    return found


def _process_id(excel) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(excel.Hwnd, ctypes.byref(pid))
    return pid.value


class CompileDialogWatcher(threading.Thread):
    """Reads and dismisses the modal dialog VBA raises for a compile error."""

    def __init__(self, pid: int) -> None:
        super().__init__(daemon=True)
        self.pid = pid
        self.messages: list[str] = []
        self._halt = threading.Event()

    def run(self) -> None:
        while not self._halt.is_set():
            for dialog in _vba_dialogs(self.pid):
                children = _children(dialog)
                text = " ".join(_window_text(child) for child in children
                                if _class_name(child) == "Static" and _window_text(child).strip())
                self.messages.append(" ".join(text.split()))
                ok_button = next((child for child in children if _class_name(child) == "Button"
                                  and _window_text(child).replace("&", "") == "OK"), None)
                if ok_button:
                    user32.SendMessageW(ok_button, BM_CLICK, 0, 0)
                else:
                    user32.PostMessageW(dialog, WM_CLOSE, 0, 0)
            time.sleep(0.2)

    def stop(self) -> None:
        self._halt.set()
        self.join(timeout=2)


def _error_location(vbe) -> str:
    """Where the VBE left the caret after dismissing a compile error."""
    try:
        pane = vbe.ActiveCodePane
        start_line = pane.GetSelection()[0]
        return f"{pane.CodeModule.Parent.Name} line {start_line}"
    except Exception:  # noqa: BLE001 - no pane is open when nothing failed
        return "unknown location"


def compile_project(excel, book) -> None:
    vbe = excel.VBE
    vbe.ActiveVBProject = book.VBProject
    control = vbe.CommandBars.FindControl(1, COMPILE_PROJECT_CONTROL_ID)
    if control is None:
        raise AssertionError("The VBE's Compile command was not found")
    watcher = CompileDialogWatcher(_process_id(excel))
    watcher.start()
    try:
        control.Execute()
        time.sleep(0.5)
    finally:
        watcher.stop()
        try:
            vbe.MainWindow.Visible = False
        except Exception:  # noqa: BLE001 - the window may never have opened
            pass
    if watcher.messages:
        raise AssertionError(f"{watcher.messages[0]} at {_error_location(vbe)}")
    # The Compile command greys out once the project is fully compiled, which
    # proves the command ran rather than silently doing nothing.
    if control.Enabled:
        raise AssertionError("The VBE's Compile command did not compile the project")
    check(True, "whole VBA project compiles")


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

        compile_project(excel, book)

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
              f"built add-in reports version {version}; obsolete refresh controls are hidden")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("addin", type=Path)
    verify(parser.parse_args().addin)
