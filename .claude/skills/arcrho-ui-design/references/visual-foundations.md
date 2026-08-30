# Visual Foundations

## Visual Language

### V01 - Pale surfaces

Use pale gray and white backgrounds, typically `#eef2f6`, `#f4f7fa`, `#f8fafc`, `#fbfcfe`, and `#ffffff`.

### V02 - Neutral borders

Prefer `1px` neutral borders such as `#d8dde3`, `#cbd5e1`, and `#cfd6df`.

### V03 - Restrained accents

Use ArcRho blue `#2b6df6` for active navigation and primary action. Use teal `#0f766e`, green `#15803d`, amber `#b45309`, and red `#be123c` only as restrained semantic accents.

### V04 - Subtle elevation

Keep elevation subtle, usually `0 1px 2px rgba(15, 23, 42, 0.04)` for selected items and `0 8px 20px rgba(15, 23, 42, 0.08)` for hover or floating states.

### V05 - Compact corners

Keep radii compact and consistent within each workspace. Avoid large pill or card-heavy page composition except for status chips.

## Typography

### V06 - Font stack

Use `Arial, "Segoe UI", "SegoeUI", Tahoma, sans-serif` as the default font stack.

### V07 - Base text

Keep base text between 12px and 13px.

### V08 - Board titles

Use a main board title around 20px with bold weight and tight line height.

### V09 - Section labels

Use 11px bold, neutral-gray section labels. Do not set them in uppercase.

### V18 - Title-case labels

Capitalize the first letter of every word in interface labels, such as `Origin Span`, `File Size`, and `Column Name`, and never set a label in full uppercase. This should cover section labels, tile and stat labels, table column headers, form field labels, group titles, and inline tags. Action button text, helper sentences, and status text stay in sentence case.

The rule holds in the stylesheet as much as in the markup: do not apply `text-transform: uppercase` to any label, and in particular not to kind badges and chips, which must show a product or object name exactly as it is written (`ArcRho`, `Excel`, `Formula`), never `ARCRHO`. Keep their letter spacing at `0` like every other label.

### V10 - Tight hierarchy

Keep letter spacing at `0`. Use weight and spacing, not oversized type, to create hierarchy.

## Motion

### V11 - Short transitions

Keep transitions between 120ms and 190ms.

### V12 - Confirm state changes

Use motion for state confirmation: hover lift, dialog pop or fade, toast slide-in, active running pulse, switch knob movement, and drag feedback.

### V13 - No decorative loops

Avoid continuous decorative animation. Use running lights only for actual or simulated work.

## What To Avoid

### V14 - No marketing visuals

Avoid marketing landing pages, oversized hero sections, decorative orbs, stock-like imagery, and one-note color themes.

### V15 - No nested cards

Avoid cards inside cards. Use panels and tiles only where they frame real repeated content or tools.

### V16 - No heavy effects

Avoid purple-heavy gradients, large rounded rectangles, excessive shadows, and decorative animation.

### V17 - Show the workflow

Do not hide application workflow behind explanatory text. Show the working surface directly.
