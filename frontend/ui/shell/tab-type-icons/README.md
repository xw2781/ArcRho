# Tab Type Icons

One small glyph per shell tab type, drawn for the left edge of a tab in the main tab bar.

## Contents

- `*.svg`: one icon per tab type. The file name is the tab type, so `dfm` renders `dfm.svg`.
- `default.svg`: the fallback glyph for a tab type with no icon of its own.
- `tab_type_icons.css`: the type-to-artwork mapping, and the mask mechanics that let one
  monochrome file follow the tab's text color.

## Drawing Rules

Every icon follows the same rules, so a row of tabs reads as one set rather than a collection:

- A `0 0 16 16` canvas, drawn for a 14px box. Coordinates sit on quarter units so edges stay
  crisp at that size.
- Outline only, `stroke-width` `1.25`, round caps and joins, no fill except for the few solid
  dots that need weight.
- `stroke="currentColor"`, never a literal color. Color is the host's decision.
- Roughly 0.75 units of clearance inside the canvas edge, so the stroke is never clipped.
- Detail is kept to about five elements. Anything finer turns to mud at 14px.
- Silhouettes are kept apart from one another, because a tab is identified at a glance and by
  outline rather than by inspection.

The set follows the same subjects as the Home launch cards in `ui/shell/home_card_icons.js`, so a
type looks like itself in both places. It is drawn separately because the Home cards render at
34px, where detail that disappears in a tab still reads.

## Usage

Include the stylesheet once, then give an element the `tabTypeIcon` class and a `data-tab-type`
attribute:

```html
<link rel="stylesheet" href="/ui/shell/tab-type-icons/tab_type_icons.css?v=20260821a"/>
<span class="tabTypeIcon" data-tab-type="dfm" aria-hidden="true"></span>
```

The host sets the width, height, and color. An unknown or missing `data-tab-type` falls back to
`default.svg` on its own, so a new tab type shows a generic page rather than an empty box.

The icons are plain SVG and can also be used inline or in an `<img>`, but only the mask route
follows `currentColor` through hover and active states.

## Adding An Icon

1. Draw the SVG under the rules above and save it as `<tab type>.svg`.
2. Add the matching `[data-tab-type="<tab type>"]` rule to `tab_type_icons.css`.
3. Check it against the rest of the set in `docs/ui/tab_type_icon_preview.html`.
