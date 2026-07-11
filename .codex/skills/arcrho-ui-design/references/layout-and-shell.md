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
