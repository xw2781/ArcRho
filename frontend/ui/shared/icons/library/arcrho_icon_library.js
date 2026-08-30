/*
 * ArcRho icon library — one house-style drawing per name.
 *
 * Every glyph is drawn on the same 16-unit square as the shell's tab-type icons, with the ink kept
 * inside a ~12.5-unit box so a 14px slot and a 16px slot both land on whole pixels. The wrapper
 * fixes only the geometry contract that the drawings assume:
 *
 *   viewBox="0 0 16 16"  fill="none"  stroke="currentColor"  stroke-width="1.25"
 *   stroke-linecap="round"  stroke-linejoin="round"
 *
 * Colour is never written into a glyph. `currentColor` means the host stylesheet keeps owning the
 * resting, hovered, disabled, and accented states without a second recoloured copy of the artwork.
 * A glyph may still fill a small dot or a solid arrowhead with `currentColor`, which is the same
 * exception the tab-type set already makes.
 *
 * This module is the single source of truth. `build_icon_files.mjs` writes the matching standalone
 * `.svg` files in this folder from the table below, so a drawing edited here and rebuilt stays
 * identical whether it is inlined through `arcrhoIcon()` or applied as a CSS mask like
 * `shell/tab-type-icons/tab_type_icons.css` does.
 */

// name -> { group, keywords, paths }. `paths` is the inner markup only; the wrapper adds the rest.
export const ARCRHO_ICONS = {
  // ---- Navigation and window chrome -------------------------------------------------------
  "chevron-right": { group: "navigation", keywords: "next forward disclosure expand", paths: '<path d="m5.8 3.6 4.4 4.4-4.4 4.4"/>' },
  "chevron-left": { group: "navigation", keywords: "previous back disclosure", paths: '<path d="m10.2 3.6-4.4 4.4 4.4 4.4"/>' },
  "chevron-down": { group: "navigation", keywords: "open dropdown expand caret", paths: '<path d="m3.6 5.8 4.4 4.4 4.4-4.4"/>' },
  "chevron-up": { group: "navigation", keywords: "close collapse caret", paths: '<path d="m3.6 10.2 4.4-4.4 4.4 4.4"/>' },
  "arrow-right": { group: "navigation", keywords: "next go continue", paths: '<path d="M2.6 8h10.8"/><path d="m9.4 4 4 4-4 4"/>' },
  "arrow-left": { group: "navigation", keywords: "back return", paths: '<path d="M13.4 8H2.6"/><path d="m6.6 4-4 4 4 4"/>' },
  "arrow-up": { group: "navigation", keywords: "raise promote move up", paths: '<path d="M8 13.4V2.6"/><path d="m4 6.6 4-4 4 4"/>' },
  "arrow-down": { group: "navigation", keywords: "lower demote move down", paths: '<path d="M8 2.6v10.8"/><path d="m4 9.4 4 4 4-4"/>' },
  "close": { group: "navigation", keywords: "dismiss cancel x remove tab", paths: '<path d="M3.9 3.9 12.1 12.1"/><path d="M12.1 3.9 3.9 12.1"/>' },
  "menu": { group: "navigation", keywords: "hamburger list navigation", paths: '<path d="M2.4 4.3h11.2"/><path d="M2.4 8h11.2"/><path d="M2.4 11.7h11.2"/>' },
  "more-horizontal": { group: "navigation", keywords: "overflow ellipsis context actions", paths: '<circle cx="3.5" cy="8" r="0.95" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="0.95" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="0.95" fill="currentColor" stroke="none"/>' },
  "more-vertical": { group: "navigation", keywords: "overflow kebab row actions", paths: '<circle cx="8" cy="3.5" r="0.95" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="0.95" fill="currentColor" stroke="none"/><circle cx="8" cy="12.5" r="0.95" fill="currentColor" stroke="none"/>' },
  "expand": { group: "navigation", keywords: "fullscreen enlarge grow panel", paths: '<path d="M9.4 2.6h4v4"/><path d="M6.6 13.4h-4v-4"/><path d="M13.4 2.6 9.2 6.8"/><path d="M2.6 13.4 6.8 9.2"/>' },
  "collapse": { group: "navigation", keywords: "shrink restore panel", paths: '<path d="M13.4 2.6 9.6 6.4"/><path d="M9.6 3v3.4H13"/><path d="M2.6 13.4 6.4 9.6"/><path d="M6.4 13V9.6H3"/>' },
  "pin": { group: "navigation", keywords: "keep stick favourite tab", paths: '<path d="M5.9 2.6h4.2"/><path d="M7.1 2.6 6.6 7.9 4.5 9.5v1.1h7V9.5L9.4 7.9l-.5-5.3"/><path d="M8 10.6v2.8"/>' },
  "external-link": { group: "navigation", keywords: "open new window popout detach", paths: '<path d="M12.6 9.4v2.9a1.1 1.1 0 0 1-1.1 1.1H3.7a1.1 1.1 0 0 1-1.1-1.1V4.5a1.1 1.1 0 0 1 1.1-1.1h2.9"/><path d="M9.8 2.6h3.6v3.6"/><path d="m7.4 8.6 6-6"/>' },
  "drag-handle": { group: "navigation", keywords: "grip reorder move rows", paths: '<circle cx="6.2" cy="4.4" r="0.95" fill="currentColor" stroke="none"/><circle cx="9.8" cy="4.4" r="0.95" fill="currentColor" stroke="none"/><circle cx="6.2" cy="8" r="0.95" fill="currentColor" stroke="none"/><circle cx="9.8" cy="8" r="0.95" fill="currentColor" stroke="none"/><circle cx="6.2" cy="11.6" r="0.95" fill="currentColor" stroke="none"/><circle cx="9.8" cy="11.6" r="0.95" fill="currentColor" stroke="none"/>' },

  // ---- Actions ----------------------------------------------------------------------------
  "plus": { group: "action", keywords: "add new create", paths: '<path d="M8 3.2v9.6"/><path d="M3.2 8h9.6"/>' },
  "minus": { group: "action", keywords: "remove subtract collapse", paths: '<path d="M3.2 8h9.6"/>' },
  "search": { group: "action", keywords: "find filter lookup magnifier", paths: '<circle cx="7.1" cy="7.1" r="4.3"/><path d="m10.4 10.4 3 3"/>' },
  "filter": { group: "action", keywords: "narrow subset funnel", paths: '<path d="M2.6 3.2h10.8L9.3 8v4.1l-2.6 1.3V8Z"/>' },
  "sort": { group: "action", keywords: "order arrange rank", paths: '<path d="M3 4.2h10"/><path d="M4.6 8h6.8"/><path d="M6.2 11.8h3.6"/>' },
  "sort-ascending": { group: "action", keywords: "order low high column", paths: '<path d="M3 4.4h4.6"/><path d="M3 8h6.8"/><path d="M3 11.6h9"/>' },
  "edit": { group: "action", keywords: "pencil rename modify write", paths: '<path d="M11 2.9a1.55 1.55 0 0 1 2.2 2.2l-7.6 7.6-3 .8.8-3Z"/><path d="m9.9 4 2.2 2.2"/>' },
  "trash": { group: "action", keywords: "delete remove discard", paths: '<path d="M2.8 4.4h10.4"/><path d="M6.2 4.4V3.3a.9.9 0 0 1 .9-.9h1.8a.9.9 0 0 1 .9.9v1.1"/><path d="M4.3 4.4v8.1a.9.9 0 0 0 .9.9h5.6a.9.9 0 0 0 .9-.9V4.4"/><path d="M6.7 6.9v4.1"/><path d="M9.3 6.9v4.1"/>' },
  "copy": { group: "action", keywords: "duplicate clipboard clone", paths: '<rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.3"/><path d="M10.4 5.6V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.2a1.3 1.3 0 0 0 1.3 1.3h1.7"/>' },
  "paste": { group: "action", keywords: "clipboard insert fill", paths: '<path d="M5.9 3.5H4.4a1.2 1.2 0 0 0-1.2 1.2v7.5a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V4.7a1.2 1.2 0 0 0-1.2-1.2h-1.5"/><rect x="5.9" y="2.2" width="4.2" height="2.6" rx=".8"/>' },
  "undo": { group: "action", keywords: "revert back step", paths: '<path d="M3.1 5.5h6.4a3.6 3.6 0 0 1 0 7.2H5.8"/><path d="M5.8 2.8 3.1 5.5l2.7 2.7"/>' },
  "redo": { group: "action", keywords: "repeat forward step", paths: '<path d="M12.9 5.5H6.5a3.6 3.6 0 0 0 0 7.2h3.7"/><path d="m10.2 2.8 2.7 2.7-2.7 2.7"/>' },
  "refresh": { group: "action", keywords: "reload recompute update again", paths: '<path d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75"/><path d="M13.3 3.3v3.4H9.9"/>' },
  "sync": { group: "action", keywords: "two way exchange propagate", paths: '<path d="M2.8 8a5.2 5.2 0 0 1 8.85-3.68"/><path d="M13.2 2.8v3.4H9.8"/><path d="M13.2 8a5.2 5.2 0 0 1-8.85 3.68"/><path d="M2.8 13.2V9.8h3.4"/>' },
  "download": { group: "action", keywords: "save to disk pull fetch", paths: '<path d="M2.6 10.4v1.9a1.1 1.1 0 0 0 1.1 1.1h8.6a1.1 1.1 0 0 0 1.1-1.1v-1.9"/><path d="M8 2.6v7"/><path d="m5.1 6.7 2.9 2.9 2.9-2.9"/>' },
  "upload": { group: "action", keywords: "send push publish attach", paths: '<path d="M2.6 10.4v1.9a1.1 1.1 0 0 0 1.1 1.1h8.6a1.1 1.1 0 0 0 1.1-1.1v-1.9"/><path d="M8 10.2v-7"/><path d="M5.1 6.1 8 3.2l2.9 2.9"/>' },
  "save": { group: "action", keywords: "store commit write disk", paths: '<path d="M2.6 4.1A1.5 1.5 0 0 1 4.1 2.6h6.2l3.1 3.1v6.2a1.5 1.5 0 0 1-1.5 1.5H4.1a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M5.3 2.6v3.5h5V2.6"/><path d="M5.3 13.4V9.7h5.4v3.7"/>' },
  "import": { group: "action", keywords: "bring in load resq ingest", paths: '<path d="M8.6 2.6h3.7a1.1 1.1 0 0 1 1.1 1.1v8.6a1.1 1.1 0 0 1-1.1 1.1H8.6"/><path d="M2.6 8h7.2"/><path d="m7.2 5.4 2.6 2.6-2.6 2.6"/>' },
  "export": { group: "action", keywords: "send out extract write back", paths: '<path d="M7.4 2.6H3.7a1.1 1.1 0 0 0-1.1 1.1v8.6a1.1 1.1 0 0 0 1.1 1.1h3.7"/><path d="M13.4 8H6.2"/><path d="m10.8 5.4 2.6 2.6-2.6 2.6"/>' },
  "run": { group: "action", keywords: "play execute start calculate", paths: '<path d="M4.8 3.2 12.3 8l-7.5 4.8Z"/>' },
  "stop": { group: "action", keywords: "halt cancel abort", paths: '<rect x="4.1" y="4.1" width="7.8" height="7.8" rx="1.2"/>' },
  "pause": { group: "action", keywords: "hold suspend wait", paths: '<path d="M6.1 3.7v8.6"/><path d="M9.9 3.7v8.6"/>' },
  "lock": { group: "action", keywords: "protect read only reserved hold", paths: '<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.3"/><path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7"/>' },
  "unlock": { group: "action", keywords: "release editable open", paths: '<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.3"/><path d="M5.5 7V5.4a2.5 2.5 0 0 1 4.85-.85"/>' },
  "link": { group: "action", keywords: "connect reference dependency chain", paths: '<path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l2-2a2.83 2.83 0 0 0-4-4l-.9.9"/><path d="M9.4 6.6a2.8 2.8 0 0 0-4 0l-2 2a2.83 2.83 0 0 0 4 4l.9-.9"/>' },
  "settings": { group: "action", keywords: "gear preferences options configure", paths: '<circle cx="8" cy="8" r="2.05"/><path d="M6.68 2.29h2.64l.45 1.54.96.55 1.56-.38 1.32 2.29-1.11 1.16v1.1l1.11 1.16-1.32 2.29-1.56-.38-.96.55-.45 1.54H6.68l-.45-1.54-.96-.55-1.56.38-1.32-2.29 1.11-1.16v-1.1L2.39 6.29 3.71 4l1.56.38.96-.55Z"/>' },
  "eye": { group: "action", keywords: "show reveal visible preview", paths: '<path d="M1.7 8s2.5-4.3 6.3-4.3S14.3 8 14.3 8s-2.5 4.3-6.3 4.3S1.7 8 1.7 8Z"/><circle cx="8" cy="8" r="1.9"/>' },
  "eye-off": { group: "action", keywords: "hide conceal invisible", paths: '<path d="M6.3 4a6.2 6.2 0 0 1 1.7-.3c3.8 0 6.3 4.3 6.3 4.3a12.3 12.3 0 0 1-1.9 2.4"/><path d="M4.4 5.2A12.3 12.3 0 0 0 1.7 8s2.5 4.3 6.3 4.3a6.2 6.2 0 0 0 2.3-.45"/><path d="M2.9 2.9 13.1 13.1"/>' },
  "check": { group: "action", keywords: "done tick confirm applied", paths: '<path d="m3.3 8.5 3.2 3.2 6.2-7.4"/>' },
  "calculator": { group: "action", keywords: "compute arithmetic recalculate", paths: '<rect x="3.4" y="2" width="9.2" height="12" rx="1.4"/><rect x="5.4" y="4" width="5.2" height="2.2" rx=".6"/><circle cx="5.9" cy="8.7" r="0.8" fill="currentColor" stroke="none"/><circle cx="8" cy="8.7" r="0.8" fill="currentColor" stroke="none"/><circle cx="10.1" cy="8.7" r="0.8" fill="currentColor" stroke="none"/><circle cx="5.9" cy="11.5" r="0.8" fill="currentColor" stroke="none"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor" stroke="none"/><circle cx="10.1" cy="11.5" r="0.8" fill="currentColor" stroke="none"/>' },
  "add-column": { group: "action", keywords: "insert field new column table", paths: '<rect x="1.9" y="2.8" width="6.8" height="10.4" rx="1.2"/><path d="M5.3 2.8v10.4"/><path d="M11.9 5.8v4.4"/><path d="M9.7 8h4.4"/>' },
  "add-row": { group: "action", keywords: "insert record new row table", paths: '<rect x="2.8" y="1.9" width="10.4" height="7.2" rx="1.2"/><path d="M2.8 5.5h10.4"/><path d="M8 9.7v4.4"/><path d="M5.8 11.9h4.4"/>' },

  // ---- Data, files, and objects -----------------------------------------------------------
  "table": { group: "object", keywords: "grid sheet rows columns", paths: '<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.3"/><path d="M2.2 6.3h11.6"/><path d="M6.3 6.3v6.9"/><path d="M2.2 9.75h11.6"/>' },
  "loss-triangle": { group: "object", keywords: "triangle development reserving actuarial", paths: '<path d="M2.6 3h10.8L2.6 13.2Z"/><path d="M2.6 6.4h7.2"/><path d="M2.6 9.8h3.6"/><path d="M6.2 3v6.8"/><path d="M9.8 3v3.4"/>' },
  "chart-bar": { group: "object", keywords: "histogram column plot compare", paths: '<path d="M2.4 2.6v10.5h11.2"/><path d="M5.2 13.1V8.2"/><path d="M8.2 13.1V5.1"/><path d="M11.2 13.1V6.9"/>' },
  "chart-line": { group: "object", keywords: "trend series development factor plot", paths: '<path d="M2.4 2.6v10.5h11.5"/><path d="m4.3 11 2.8-2.8 2.4 1.2L13 4.7"/><circle cx="13" cy="4.7" r="0.95" fill="currentColor" stroke="none"/>' },
  "chart-scatter": { group: "object", keywords: "points cloud correlation plot", paths: '<path d="M2.4 2.6v10.5h11.5"/><circle cx="5" cy="10.6" r="0.85" fill="currentColor" stroke="none"/><circle cx="6.9" cy="7.9" r="0.85" fill="currentColor" stroke="none"/><circle cx="9.1" cy="9.4" r="0.85" fill="currentColor" stroke="none"/><circle cx="10.6" cy="5.7" r="0.85" fill="currentColor" stroke="none"/><circle cx="12.6" cy="7.6" r="0.85" fill="currentColor" stroke="none"/>' },
  "formula": { group: "object", keywords: "expression fx calculated derived", paths: '<path d="M9.9 5.6 13.2 12.3"/><path d="M13.2 5.6 9.9 12.3"/><path d="M7.7 3.3a1.9 1.9 0 0 0-2.9 1.65v7.35"/><path d="M3.1 7.7h3.9"/>' },
  "sigma": { group: "object", keywords: "sum total aggregate", paths: '<path d="M12.2 4.8V3.2H3.8L7.6 8l-3.8 4.8h8.4v-1.6"/>' },
  "percent": { group: "object", keywords: "ratio rate share developed", paths: '<circle cx="5.2" cy="5.2" r="2.1"/><circle cx="10.8" cy="10.8" r="2.1"/><path d="M12.4 3.6 3.6 12.4"/>' },
  "folder": { group: "object", keywords: "directory group container", paths: '<path d="M2.4 12.5V4.5a1.1 1.1 0 0 1 1.1-1.1h3l1.5 1.7h4.5a1.1 1.1 0 0 1 1.1 1.1v6.3a1.1 1.1 0 0 1-1.1 1.1H3.5a1.1 1.1 0 0 1-1.1-1.1Z"/>' },
  "folder-open": { group: "object", keywords: "directory expanded current", paths: '<path d="M2.4 12.4V4.5a1.1 1.1 0 0 1 1.1-1.1h3l1.5 1.7h4.5a1.1 1.1 0 0 1 1.1 1.1v1.1"/><path d="m2.4 12.4 1.9-4.6h9.5l-1.9 4.6a1.1 1.1 0 0 1-1 .7H3.4a1 1 0 0 1-1-.7Z"/>' },
  "file": { group: "object", keywords: "document blank page", paths: '<path d="M3.4 3.3a1.1 1.1 0 0 1 1.1-1.1h4.2l3.9 3.9v6.6a1.1 1.1 0 0 1-1.1 1.1H4.5a1.1 1.1 0 0 1-1.1-1.1Z"/><path d="M8.7 2.2v3.9h3.9"/>' },
  "file-text": { group: "object", keywords: "document notes report contents", paths: '<path d="M3.4 3.3a1.1 1.1 0 0 1 1.1-1.1h4.2l3.9 3.9v6.6a1.1 1.1 0 0 1-1.1 1.1H4.5a1.1 1.1 0 0 1-1.1-1.1Z"/><path d="M8.7 2.2v3.9h3.9"/><path d="M5.6 9.1h4.8"/><path d="M5.6 11.3h3.2"/>' },
  "database": { group: "object", keywords: "dataset store cylinder source", paths: '<ellipse cx="8" cy="4.1" rx="5" ry="1.85"/><path d="M3 4.1v7.8c0 1.02 2.24 1.85 5 1.85s5-.83 5-1.85V4.1"/><path d="M3 8c0 1.02 2.24 1.85 5 1.85S13 9.02 13 8"/>' },
  "calendar": { group: "object", keywords: "date period quarter valuation", paths: '<rect x="2.4" y="3.5" width="11.2" height="10.1" rx="1.3"/><path d="M2.4 6.7h11.2"/><path d="M5.4 2.4v2.2"/><path d="M10.6 2.4v2.2"/>' },
  "clock": { group: "object", keywords: "time duration elapsed", paths: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.5"/>' },
  "history": { group: "object", keywords: "recent previous audit versions", paths: '<path d="M2.7 8a5.3 5.3 0 1 0 1.55-3.75"/><path d="M2.7 3.3v3.4h3.4"/><path d="M8 5.4v3.3l2 1.3"/>' },
  "tag": { group: "object", keywords: "label category marker", paths: '<path d="M2.6 7.6V3.7a1.1 1.1 0 0 1 1.1-1.1h3.9l6 6-5 5Z"/><circle cx="5.5" cy="5.5" r="0.95" fill="currentColor" stroke="none"/>' },
  "note": { group: "object", keywords: "comment annotation memo method notes", paths: '<path d="M3.2 3.7a1.2 1.2 0 0 1 1.2-1.2h7.2a1.2 1.2 0 0 1 1.2 1.2v5.9L9.4 13.5H4.4a1.2 1.2 0 0 1-1.2-1.2Z"/><path d="M12.8 9.6H9.4v3.9"/><path d="M5.7 5.7h4.6"/><path d="M5.7 7.9h3"/>' },
  "user": { group: "object", keywords: "person account owner analyst", paths: '<circle cx="8" cy="5.5" r="2.6"/><path d="M3.3 13.4a4.7 4.7 0 0 1 9.4 0"/>' },
  "users": { group: "object", keywords: "team shared group session", paths: '<circle cx="6.3" cy="5.7" r="2.4"/><path d="M2.2 13.4a4.2 4.2 0 0 1 8.3 0"/><path d="M10.4 3.6a2.4 2.4 0 0 1 0 4.2"/><path d="M11.6 9.8a4.2 4.2 0 0 1 2.2 3.6"/>' },

  // ---- Status -----------------------------------------------------------------------------
  "info": { group: "status", keywords: "note detail explanation neutral", paths: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.3"/><circle cx="8" cy="5.4" r="0.85" fill="currentColor" stroke="none"/>' },
  "warning": { group: "status", keywords: "caution attention review needed", paths: '<path d="M7 2.95a1.15 1.15 0 0 1 2 0l4.65 8.4a1.15 1.15 0 0 1-1 1.7H3.35a1.15 1.15 0 0 1-1-1.7Z"/><path d="M8 6.3v2.7"/><circle cx="8" cy="11" r="0.85" fill="currentColor" stroke="none"/>' },
  "error": { group: "status", keywords: "failed broken invalid stop", paths: '<circle cx="8" cy="8" r="5.5"/><path d="m6 6 4 4"/><path d="m10 6-4 4"/>' },
  "success": { group: "status", keywords: "ok passed complete valid", paths: '<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.1 1.9 1.9 3.3-3.9"/>' },
  "pending": { group: "status", keywords: "queued waiting not started", paths: '<circle cx="8" cy="8" r="5.5"/><circle cx="5.6" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="10.4" cy="8" r="0.8" fill="currentColor" stroke="none"/>' },
  "progress": { group: "status", keywords: "running busy spinner working", paths: '<path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/>' },
  "needs-refresh": { group: "status", keywords: "stale out of date recalculate dependent", paths: '<path d="M13.3 8a5.3 5.3 0 1 1-1.55-3.75"/><path d="M13.3 3.3v3.4H9.9"/><path d="M8 5.9v2.6"/><circle cx="8" cy="10.7" r="0.85" fill="currentColor" stroke="none"/>' },
  "unsaved": { group: "status", keywords: "dirty modified dot pending write", paths: '<circle cx="8" cy="8" r="3.1" fill="currentColor" stroke="none"/>' },
  "offline": { group: "status", keywords: "disconnected unavailable no bridge", paths: '<path d="M2.3 6.2a9 9 0 0 1 3.2-1.9"/><path d="M10.5 4.3a9 9 0 0 1 3.2 1.9"/><path d="M4.9 8.7a5.7 5.7 0 0 1 1.6-1"/><path d="M9.5 7.7a5.7 5.7 0 0 1 1.6 1"/><circle cx="8" cy="11.6" r="0.95" fill="currentColor" stroke="none"/><path d="M2.9 2.9 13.1 13.1"/>' },
};

export const ICON_GROUP_LABELS = {
  navigation: "Navigation and chrome",
  action: "Actions",
  object: "Data, files, and objects",
  status: "Status",
};

// The geometry contract every drawing above is authored against.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none"' +
  ' stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"' +
  ' aria-hidden="true" focusable="false">';

export function iconNames() {
  return Object.keys(ARCRHO_ICONS);
}

export function iconsInGroup(group) {
  return iconNames().filter((name) => ARCRHO_ICONS[name].group === group);
}

/**
 * Inline markup for one icon. Returns an empty string for an unknown name rather than throwing, so
 * a missing glyph leaves a gap instead of taking a panel down.
 */
export function arcrhoIcon(name, { className = "arIcon", size = 16 } = {}) {
  const icon = ARCRHO_ICONS[name];
  if (!icon) return "";
  const attrs = ` class="${className}" width="${size}" height="${size}"`;
  return SVG_OPEN.replace(' width="16" height="16"', attrs) + icon.paths + "</svg>";
}

/** Standalone file text, as written into this folder by build_icon_files.mjs. */
export function iconFileText(name) {
  const icon = ARCRHO_ICONS[name];
  if (!icon) return "";
  const inner = icon.paths.replace(/></g, ">\n  <");
  return `${SVG_OPEN}\n  ${inner}\n</svg>\n`;
}
