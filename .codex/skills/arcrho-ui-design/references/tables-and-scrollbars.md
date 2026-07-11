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

Use explicit `::-webkit-scrollbar` styling when thumb radius, inset thumbs, or arrow buttons matter. Avoid `scrollbar-color` because it can override WebKit thumb painting. Use a track-colored thumb border, `background-clip: content-box`, and a subtle thumb radius around `5px`.

### T07 - Single tray arrows

Show exactly one compact arrow at each scrollbar-tray end: left and right for horizontal trays, up and down for vertical trays. Use muted native-style triangles on the pale tray fill with restrained hover and active states, and collapse extra WebKit start or end companion buttons.

### T08 - Sticky-aware keyboard scroll

Do not rely on `element.scrollIntoView({ block: "nearest" })` alone because a sticky header can cover a row the browser considers visible. Compare active-cell bounds with scroll-host bounds adjusted by the actual sticky-header height, then update `scrollTop` or `scrollLeft` until the cell is fully visible.

### T09 - Stable column resizing

Follow the `pi-table` pattern. Store an explicit width for every column, render a `colgroup`, set each `col` width directly, and set table `width` and `min-width` to the sum of current column widths. During drag, update only the target column width and resync the total table width; let the table grow or shrink instead of redistributing neighboring columns. Use fixed table layout and keep resize handles outside normal layout flow.
