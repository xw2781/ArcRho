---
name: desktop-input-control-works
description: GUI verification on the RDP desktop - use tools/agent_screen_control; it drives the mouse via SendInput (INPUT must be 40 bytes) in per-monitor DPI real pixels
metadata: 
  node_type: memory
  type: reference
  originSessionId: 08dd6aed-1cab-42e0-8078-9dd61053a559
  modified: 2026-09-22T23:48:50.695Z
---

Synthetic mouse and keyboard input works from a PowerShell tool call on the Server PC (see [[dev-pc-and-client-pc-identity]]). The tool process runs inside the user's own active RDP session, so injected input lands on their live desktop and is visible to them; it cannot reach the other twenty-odd disconnected sessions on that server.

What works: `SetCursorPos`, left/right/double click, wheel, key taps, and modifier chords through `user32!SendInput`. `Get-Process | Where MainWindowTitle` plus `Graphics.CopyFromScreen` give a window list and a screenshot for verification.

**Why:** the first attempt looked like the system was blocking input — clicks registered nowhere and `SendInput` returned 0. It was not a block. The `INPUT` struct had two extra padding fields, so `Marshal.SizeOf` reported 48 bytes instead of the 40 that x64 expects, and Windows rejected every event. `mouse_event` fails the same way but silently, because it returns void.

**How to apply:**
- Declare `INPUT` as `uint type` plus an explicit-layout union of `MOUSEINPUT`/`KEYBDINPUT`, with no trailing padding, and assert `Marshal.SizeOf` is 40 before trusting a run.
- Call `SetProcessDpiAwarenessContext(-4)` (per-monitor v2) first, not `SetProcessDPIAware`. On 2026-09-22, after an RDP reconnect at another scale, a system-aware process saw a 2560x1920 screen while the real pixels (and every BitBlt screenshot) were 2048x1536, so clicks drifted 25%. `GetDeviceCaps` HORZRES vs DESKTOPHORZRES differing is the tell.
- Use `tools/agent_screen_control/agent_screen_control.ps1` (windows / screenshot / click / drag) instead of hand-rolled SendInput; the workflow and rules are in `agent-instructions/gui-verification.md`.
- Guard every injected click: after moving the cursor, check `WindowFromPoint` equals the handle you meant to hit, and abort otherwise. A `TopMost` test window still ended up behind ResQ, and the first round of clicks went into the live ResQ main window instead.
- Another agent may be driving the same desktop at the same time. Check the screenshot before assuming a failure is yours.
