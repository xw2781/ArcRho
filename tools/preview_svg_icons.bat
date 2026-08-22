@echo off
REM Open the repository's SVG icons in a browser gallery, big enough to actually judge.
REM
REM   preview_svg_icons.bat                                     every SVG in the repository
REM   preview_svg_icons.bat frontend/ui/shell/tab-type-icons  just one folder
REM
REM Double-click it, or run it from any directory. The window stays open on failure.
setlocal
python "%~dp0svg_icon_preview.py" %*
if errorlevel 1 pause
endlocal
