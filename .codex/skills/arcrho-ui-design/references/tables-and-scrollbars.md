# Tables And Scrollbars

## Table Design Rules

### T01 - Compact rows

Keep table rows around 31px high with a pale header and hover-row highlight.

### T02 - Opaque sticky headers

Prevent scroll bleed-through with paint-only header-cell covers rather than layout spacers. Use separated borders (`border-collapse: separate; border-spacing: 0;`) when sticky-header borders must remain opaque, and place seam masks on absolutely positioned `th` or `thead` pseudo-elements so they do not create white gaps above the header.

### T03 - Continuous table frame

Keep one visible outer edge across the table body, sticky header, total row, and scrollbar tray. Treat the scroll wrapper and gutter as part of the frame: retain the wrapper border, reserve stable scrollbar gutter space, add minimal right and bottom breathing room when needed, and preserve the last visible row and column borders, including masked blank cells, at maximum scroll. Keep dense table frames square unless a modal, picker, or established local panel pattern requires rounded corners.

### T04 - Balanced table insets

When a table frame is inset within a tab or page, use balanced spacing on all four sides. Do not leave the right or bottom edge flush while only the top and left are inset.

### T05 - Quiet scrollbar trays

Use pale neutral scrollbar track and corner fills inside framed table wrappers, typically `#f1f3f5`, so the tray remains part of the frame. Keep resting thumbs quiet and translucent, typically `rgba(182, 182, 182, 0.2)`, and strengthen them only while scrolling, on thumb hover, or when the pointer is over the scrollbar lane, typically `rgba(120, 120, 120, 0.267)`. Do not strengthen scrollbars on whole-table hover.

### T06 - Chromium scrollbar paint

Use explicit `::-webkit-scrollbar` styling when thumb radius, inset thumbs, or arrow buttons matter. Avoid `scrollbar-color` because it can override WebKit thumb painting. Use a track-colored thumb border, `background-clip: content-box`, and a subtle thumb radius around `5px`. Standard operational pages and framed table scroll areas should use a `20px` scrollbar width and height, matching Project Instance, with `16px` arrow buttons inside that tray. Use a narrower scrollbar only for a compact popover or similarly constrained control where `20px` would crowd the content.

### T07 - Single tray arrows

Show exactly one compact arrow at each scrollbar-tray end: left and right for horizontal trays, up and down for vertical trays. Use muted native-style triangles on the pale tray fill with restrained hover and active states, and collapse extra WebKit start or end companion buttons. Tree-style navigation or object side panels are the exception: keep the standard `20px` lane, make the track, corner, and thumb inset transparent, hide all arrow buttons, and strengthen only the thumb while scrolling, hovering the lane, or hovering the thumb. Use this side-panel pattern consistently across future workspaces.

### T08 - Sticky-aware keyboard scroll

Do not rely on `element.scrollIntoView({ block: "nearest" })` alone because a sticky header can cover a row the browser considers visible. Compare active-cell bounds with scroll-host bounds adjusted by the actual sticky-header height, then update `scrollTop` or `scrollLeft` until the cell is fully visible.

### T09 - Stable column resizing

Follow the `pi-table` pattern. Store an explicit width for every column, render a `colgroup`, set each `col` width directly, and set table `width` and `min-width` to the sum of current column widths. During drag, update only the target column width and resync the total table width; let the table grow or shrink instead of redistributing neighboring columns. Use fixed table layout and keep resize handles outside normal layout flow.

### T10 - Method table spreadsheet selection and editing

Use this spreadsheet-style table pattern across interactive method tabs. The Bornhuetter Ferguson Method table is the reference implementation when exact styling or behavior needs to be checked:

- **Highlight format:** Keep selected cell colors semantic: general cells use `#30358b` with white text; percentage- or weight-style cells use `#a8eeee` with `#0284c7` text; active source/input cells use `#9dcc00` with `#111827` text; result/ultimate cells use `#fde047` with `#111827` text; and row-label cells plus implicated row and column labels use the darker gray `#a6a6a6` with `#111827` regular-weight text. Mark the selection anchor with an inset `1px` dashed `#0f172a` outline, and expose selected cells through `aria-selected`.
- **Selection and navigation:** A click selects one cell, drag selects a rectangular range, Shift-click extends from the original anchor, a row label selects its full row, and a column label selects its full column including any Total row. Arrow keys move the complete range without resizing it and keep the anchor visible using T08; Escape clears the highlight. Right-click preserves a range when invoked inside it, selects an unhighlighted target before opening, and clamps the menu to the viewport. The menu provides Copy values, Paste only when the selection contains eligible editable targets, and Remove Highlights; dismiss it on outside interaction and restore table focus after an action.
- **Clipboard and editing:** Copy through Ctrl/Cmd+C or the menu as a tab-delimited, row-delimited matrix. Paste through Ctrl/Cmd+V or the menu: a scalar fills every eligible selected editable target, while a matrix maps from the selection's top-left cell and updates each underlying target once. Direct typing should validate and apply one edit session across eligible targets; Delete/Backspace should apply the method-appropriate cleared or zero value. Use double-click shortcuts only for explicitly togglable inputs, and keep derived display modes read-only. Never edit Total cells, missing-source rows, derived results, or unrelated columns, and recalculate, rerender, and mark the page dirty after a successful input change.
