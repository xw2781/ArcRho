# Draw Tool Icons

One small glyph per tool on the Flight Deck button editor's drawing pad, drawn for the icon-only
buttons of the pad's toolbar.

## Contents

- `pen.svg`, `line.svg`, `box.svg`, `oval.svg`, `erase.svg`, `cut.svg`: the six pad tools. `erase` lifts
  whole pieces and `cut` (Erase Area) rubs out only what its ring covers.
- `undo.svg`, `clear.svg`: the two actions at the end of the toolbar.
- `draw_tool_icons.css`: the tool-to-artwork mapping, and the mask mechanics that let one
  monochrome file follow the button's text color. An unmapped tool falls back to the pen.

## Drawing Rules

The set follows the tab-type icons in `ui/shell/tab-type-icons/`, so both read as one family:

- A `0 0 16 16` canvas, drawn for a 14px box.
- Outline only, `stroke-width` `1.25`, round caps and joins, solid dots only where a line needs
  its end points marked.
- `stroke="currentColor"`, never a literal color.
- Roughly 0.75 units of clearance inside the canvas edge.
- Silhouettes kept apart from one another: a tool is picked at a glance from the toolbar.

## Usage

```html
<link rel="stylesheet" href="/ui/flight_deck/draw-tool-icons/draw_tool_icons.css?v=20260901b"/>
<span class="flightDeckDrawToolIcon" data-draw-tool="erase" aria-hidden="true"></span>
```
