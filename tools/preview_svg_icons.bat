@echo off
REM Open the repository's SVG icons in a browser gallery, big enough to actually judge.
REM
REM   preview_svg_icons.bat                                   every SVG in the repository
REM   preview_svg_icons.bat frontend/ui/shell/tab-type-icons  just one folder
REM   preview_svg_icons.bat --static                          one-off snapshot, then exit
REM
REM Double-click it, or run it from any directory. The gallery is served live, so the page's
REM Refresh button always shows the current files on disk; this window has to stay open for the
REM page to work, and Ctrl+C stops it. The window also stays open on failure.
setlocal
python "%~dp0svg_icon_preview.py" %*
if errorlevel 1 pause
endlocal
