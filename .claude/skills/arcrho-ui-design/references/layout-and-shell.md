# Layout And Shell

## Layout System

### L01 - App frame

Use a desktop app frame with a 30px title bar and 24px status bar.

### L02 - Atlas body

Use a `64px` icon rail, `254px` object sidebar, and flexible main workspace.

### L03 - Workspace sequence

Put the command strip at the top of the main workspace, followed by a board or canvas split with an optional right context panel.

### L04 - Dense canvas

Use compact tiles, tables, forms, and timelines. Avoid oversized hero sections.

### L05 - Narrow fallback

On mobile or narrow layouts, collapse to a single column and hide the icon rail before compressing content into unreadable widths.

### L14 - Aligned details forms

On dense Details tabs, size every label column from the longest rendered label across all groups, format labels as `Label : `, keep a 1px label-to-control column gap, render group frames without borders or fills, and separate adjacent group frames by 1px.

### L15 - Corner-anchored window resizing

A resizable floating window should grow and shrink from one corner while its opposite edges stay put. Give it a small invisible corner hit-area with a resize cursor rather than the native CSS `resize` property, which cannot anchor an edge and paints the platform grip glyph over the app's quiet chrome. A window centered with `left: 50%` plus a translate transform must first convert to real pixel `left`/`top` and drop the transform: while the transform applies, `left` names the window's midpoint, so any width change moves both edges outward. Keep CSS the owner of the minimum size and read it back when clamping the drag.

### L16 - Pointer capture for drag and resize handles

Every custom drag, resize, splitter, or slider handle must use Pointer Events with `setPointerCapture` on the handle itself. This is a hard rule, not a preference: without capture a fast drag outruns the browser's hit-testing and the gesture silently stops tracking partway through, which reads to the user as the window "losing control" mid-drag.

- **Capture on the handle.** Call `setPointerCapture(event.pointerId)` in `pointerdown` and attach `pointermove`, `pointerup`, `pointercancel`, and `lostpointercapture` to that same handle element.
- **Never track on `document` or `window`.** Global `mousemove`/`mouseup` listeners are the bug, and moving them from `document` to `window` does not fix it. The gesture is still lost the moment the pointer crosses an iframe, a nested window, or the app edge.
- **Match the pointer id.** Ignore move and release events whose `pointerId` differs from the one captured, so a second pointer or a stray device cannot steer or end the drag.
- **End the gesture once.** Release the capture, remove the handle listeners, and clear the drag state in a single stop path shared by `pointerup`, `pointercancel`, `lostpointercapture`, and the component's own teardown, so a dialog closed mid-drag leaves nothing behind.
- **Applies to every movable surface.** Floating window and dialog headers, progress and message windows, resize corners and edges, panel splitters, and formula-bar or chart handles all follow the same pattern.

## Atlas Components

### L06 - Title bar

Keep the title bar compact and neutral. Include the ArcRho mark, current shell name, and status chips.

### L07 - Icon rail

Use icon-only global navigation at 64px wide. Give active rail buttons a white fill, light border, blue icon, and very subtle shadow.

### L08 - Object sidebar

Provide a searchable tree for projects, datasets, DFM objects, workflows, and recent or pinned items. Keep tree rows 30px high with an icon, label, and optional count or status.

### L09 - Command strip

Provide a top workspace command or search box and one to three primary tools.

### L10 - Board header

Use a concise title, one-line context, and small status chip.

### L11 - Compact tiles

Use repeated work units containing a heading, status dot, progress, table, form, or drag/drop content.

### L12 - Secondary right panel

Reserve the right panel for activity, inspector, context, or review details rather than the primary workflow.

### L13 - Quiet status bar

Use a low-contrast status line for readiness, mode, zoom, context usage, or connection state.
