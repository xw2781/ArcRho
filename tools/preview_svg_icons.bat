@echo off
REM Open the repository's SVG icons in a browser gallery, big enough to actually judge.
REM
REM   preview_svg_icons.bat                                     every SVG in the repository
REM   preview_svg_icons.bat frontend/ui/shell/tab-type-icons  just one folder
REM   preview_svg_icons.bat --serve                            live: Refresh shows current edits
REM
REM Double-click it, or run it from any directory. The window stays open on failure, and stays
REM open for as long as --serve is running (Ctrl+C to stop).
setlocal
python "%~dp0svg_icon_preview.py" %*
if errorlevel 1 pause
endlocal
