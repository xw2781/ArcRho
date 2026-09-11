---
name: hide-trailing-tag-whole-when-narrow
description: "CSS-only technique used 2026-09-11 in the PI path tree to drop a row's trailing level tag whole (never cut mid-word) when the panel is narrow, while the star stays pinned at the right edge; includes the harness caveat that the path tree picker is single-instance"
metadata: 
  node_type: memory
  type: project
  originSessionId: 570bc3a3-d95e-41b4-87b6-38e6b27bf5dd
  modified: 2026-09-11T18:55:24.642Z
---

The PI reserving-class path tree (`.pi-path-tree` rules in `frontend/ui/project_instance/project_instance.css`)
hides a row's level tag whole when it no longer fits, with no JS:

- the row is `flex-wrap: wrap`, fixed `height: 26px`, `overflow: hidden`; a tag that does not fit wraps to a
  second line the height clips away;
- flex line-breaking never moves the *first* item on a line, so the leading arrow and type icon are
  `position: absolute` (an abspos flex child keeps its static place at the row's content edge, honouring the
  depth `padding-left` the JS sets inline) and margins re-create their 14/13px widths and 6px gaps; the label
  is then first in flow and never wraps;
- the star is `position: absolute; right: 4px` on a `::after` strip that uses `background: inherit` +
  `box-shadow: inherit` + `clip-path: inset(0 0 0 1px)`, so it repeats the row's normal/hover/selected look in
  every theme (dark.css forces `.ptree-fav-btn` background transparent, so the star itself cannot carry it).

The wrap is only the detector: the shared picker (`syncLevelOverflow` in `path_tree_picker.js`) re-measures
on a ResizeObserver of the window plus a MutationObserver of the body (expand/collapse), and once any visible
row's tag has wrapped it adds `ptree-levels-overflow` on the window so every tag hides together (user asked
for all-or-nothing). Measure with `level.offsetTop >= label.offsetTop + label.offsetHeight`, not a top-vs-top
compare: a shorter tag centred on the same line sits a few px lower than the label and reads as wrapped.

Earlier attempt worth not repeating: `max-width: calc(100% - 40px)` + ellipsis on the label keeps the wrap
trick working but shrinks labels to "C…" at 170px; the user preferred labels running under the star.

Harness caveat: `openFloatingPathTreePicker` is single-instance (a second call closes the first), so a mock
page can mount only one tree — capture one panel width per Electron run (see [[electron-ui-screenshot-check]]).

**Why:** a clipped "SUBCHANN" tag and a star pushed off-screen were the complaint; the user explicitly allowed
the star to cover text but not partial tags.
**How to apply:** reuse the same pattern for any dense row with an optional trailing tag and a pinned action.
