---
name: arcrho-ui-design
description: ArcRho frontend UI design reference for applying the app's dense, quiet, operational workspace style. Use when Codex is asked to make or fix frontend UI, visual styling, layout, controls, icons, dropdowns, tables, drag/drop areas, empty/loading/error states, or interaction polish in ArcRho; apply these rules during implementation and do not update the skill unless explicitly asked to revise durable design guidance.
---

# ArcRho UI Design Reference

## Purpose

Use this skill as the baseline reference for ArcRho frontend UI work. It captures the current modern, minimal, clean direction from the Atlas navigation demo in `frontend/docs/ui/global_app_ui_demo.html`.

Atlas is an object-first global app shell: a compact icon rail, searchable project tree, command strip, broad work canvas, and contextual activity panel. It should feel like a focused desktop analytics tool, not a marketing site.

## Design Prompt

Design ArcRho interfaces as dense, quiet, operational workspaces for actuarial data, DFM, workflow, scripting, and project management. Use the Atlas navigation pattern as the primary reference: a thin global icon rail, a structured object tree, a command/search strip, a large task canvas, and a right-side context or activity area when needed.

Keep surfaces pale, borders precise, typography compact, and motion short. Favor visible data, controls, and state over decorative composition. Build real application screens with working controls, tables, forms, tabs, drag/drop areas, status indicators, modals, toasts, and empty/loading/error states.

## Layout System

- App frame: desktop shell with a 30px title bar and 24px status bar.
- Atlas body: `64px` icon rail, `254px` object sidebar, and a flexible main workspace.
- Main workspace: command strip at the top, then a board/canvas split with optional right context panel.
- Canvas density: use compact tiles, tables, forms, and timelines. Avoid oversized hero sections.
- Mobile/narrow fallback: collapse to a single column; hide the icon rail before compressing content into unreadable widths.

## Visual Language

- Backgrounds: use pale grays and whites, typically `#eef2f6`, `#f4f7fa`, `#f8fafc`, `#fbfcfe`, and `#ffffff`.
- Borders: prefer `1px` neutral borders such as `#d8dde3`, `#cbd5e1`, and `#cfd6df`.
- Accent colors: use ArcRho blue `#2b6df6` for active navigation and primary action; teal `#0f766e`, green `#15803d`, amber `#b45309`, and red `#be123c` only as restrained semantic accents.
- Shadows: keep elevation subtle, usually `0 1px 2px rgba(15, 23, 42, 0.04)` for selected items and `0 8px 20px rgba(15, 23, 42, 0.08)` for hover/floating states.
- Corners: use 6px to 8px radii for controls, tiles, dialogs, and panels. Avoid large pill/card-heavy page composition except for status chips.

## Typography

- Font stack: `Arial, "Segoe UI", "SegoeUI", Tahoma, sans-serif`.
- Base text: 12px to 13px.
- Main board title: around 20px, bold, tight line height.
- Section labels: 10px to 11px, uppercase, bold, neutral gray.
- Keep letter spacing at `0`. Use weight and spacing, not oversized type, to create hierarchy.

## Atlas Components

- Title bar: compact, neutral, includes ArcRho mark, current shell name, and status chips.
- Icon rail: 64px wide, icon-only global navigation. Active rail buttons use white fill, light border, blue icon, and very subtle shadow.
- Object sidebar: searchable tree for projects, datasets, DFM objects, workflows, and recent/pinned items. Tree rows are 30px high with icon, label, and optional count/status.
- Command strip: top workspace control area with a command/search box and 1-3 primary tools.
- Board header: concise title, one-line context, and a small status chip.
- Tiles: compact repeated work units with heading, status dot, progress, table, form, or drag/drop content.
- Right panel: activity timeline, inspector, context, or review details. Use it for secondary information, not primary workflow.
- Status bar: low-contrast line for readiness, mode, zoom, context usage, or connection state.

## Controls And States

- Buttons: 28px to 34px high. Use icon + text for command buttons, icon-only for familiar actions.
- Primary action: blue-tinted background with blue text and border, not a saturated filled block.
- Inputs: 30px high, white fill, 6px radius, blue focus ring `rgba(96, 165, 250, 0.16)`.
- Dropdowns: when adding any dropdown or select-like control, refine the opened menu UI to match the app design instead of relying on an unstyled browser-native menu. Menus should use app borders, pale surfaces, compact row height, hover and selected states, keyboard focus styling, and sizing that aligns with the trigger.
- Dropdown and numeric-stepper arrows should use the compact filled-triangle caret style: a single down caret for dropdowns, the same caret flipped for stepper-up, muted at rest and full-strength on hover, focus, or open; keep a clear right-side arrow lane, align caret x-positions with adjacent dropdowns, and balance input padding so values stay centered.
- Switches: compact 42px by 20px with green enabled state.
- Chips: small rounded status labels with optional dot; use sparingly for state and counts.
- Close buttons and dismiss actions should use centered inline SVG stroke icons instead of text glyphs so the icon shape, line weight, and hit target stay consistent with the surrounding control size.
- Drag/drop: dashed neutral border at rest, blue-tinted surface on hover/over state, clear drop result text.

## Table Design Rules

- Tables: compact row height around 31px, pale header, hover row highlight.
- Sticky table headers: prevent scroll bleed-through with paint-only header-cell covers, not layout spacers. Use separated borders (`border-collapse: separate; border-spacing: 0;`) when sticky header borders need to stay opaque, and place seam masks on `th`/`thead` pseudo-elements that are absolutely positioned so they do not create white gaps above the header.
- Table wrap framing should keep one visible outer edge across the table body, sticky header, total row, and scrollbar tray. Treat the scroll wrapper and gutter as part of the frame: keep the wrapper border, reserve stable scrollbar gutter space, add minimal right/bottom breathing room when needed, and preserve the last visible row/column borders, including masked blank cells, so the grid edge remains visible at max scroll. Dense table frames should stay square unless the surface is a modal, picker, or panel whose local pattern already uses rounded corners.
- Scrollbar trays inside framed table wrappers should use pale neutral track/corner fill, typically `#f1f3f5`, and remain visually part of the table frame. Resting thumbs should be quiet and translucent, typically `rgba(182, 182, 182, 0.2)`, then strengthen only while scrolling, on thumb hover, or when the pointer is over the scrollbar lane, typically `rgba(120, 120, 120, 0.267)`; do not strengthen scrollbars on whole-table hover.
- Custom Chromium/Electron table scrollbars should use explicit `::-webkit-scrollbar` styling when thumb radius, inset thumbs, or arrow buttons matter. Avoid mixing `scrollbar-color` into those components because it can override WebKit thumb painting. Use a track-colored thumb border, `background-clip: content-box`, and a subtle thumb radius around `5px` so rounded ends are visible without making the table frame feel pill-shaped.
- When table scrollbar trays include arrow buttons, show exactly one compact arrow at each tray end: left/right for horizontal trays and up/down for vertical trays. Use muted native-style triangle arrows on the same pale tray fill with restrained hover/active states, and collapse any extra WebKit start/end companion buttons so each side has only one arrow.
- Keyboard navigation in scrollable tables with sticky headers must use scroll-container-aware visibility checks. Do not rely on `element.scrollIntoView({ block: "nearest" })` by itself for active rows or cells because sticky headers can cover a row the browser considers visible. When moving a selected or highlighted cell by keyboard, compare the cell bounds against the scroll host bounds adjusted by the actual sticky header height, then update `scrollTop` or `scrollLeft` so the active cell is fully visible below the header.
- Resizable table columns: follow the `pi-table` pattern. Store an explicit width for every column, render a `colgroup`, set each `col` width directly, and set the table `width`/`min-width` to the sum of the current column widths. During drag, update only the target column width and then resync the total table width; let the whole table grow or shrink instead of allowing the browser to redistribute neighboring columns. Use fixed table layout and keep resize handles outside normal layout flow.

## Motion

- Keep transitions short: 120ms to 190ms.
- Use motion for state confirmation: hover lift, modal pop/fade, toast slide-in, active running pulse, switch knob movement, drag feedback.
- Avoid continuous decorative animation. Running lights should indicate actual work or simulated work in demos.

## Interaction Expectations

- Every design demo should include at least a few interactive controls: style switchers, modal open/close, toast feedback, toggles, drag sorting, drop targets, and an animation trigger.
- Components should remain stable while content changes. Avoid layout shift from hover states, active labels, or dynamic status text.
- Text must fit inside controls and panels at desktop and narrow widths.
- Prefer explicit visible state over hidden behavior.

## What To Avoid

- Marketing landing pages, oversized hero sections, decorative orbs, stock-like imagery, and one-note color themes.
- Nested cards inside cards. Use panels and tiles only where they frame real repeated content or tools.
- Purple-heavy gradients, large rounded rectangles, excessive shadows, and decorative animation.
- Hiding application workflow behind explanatory text. Show the working surface directly.

## Implementation Notes

- Reference demo: `frontend/docs/ui/global_app_ui_demo.html`, especially the `style-atlas` section and Atlas CSS selectors.
- Keep production shell changes compatible with frontend behavior contracts and `arcrho:*` message semantics.
- Standalone design demos belong in `frontend/docs/ui/` unless they are wired into runtime navigation.
