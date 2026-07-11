# Controls And States

## Controls

### C01 - Button sizing

Keep buttons between 28px and 34px high. Use icon and text for command buttons and icon-only treatment for familiar actions.

### C02 - Primary actions

Style primary actions with a blue-tinted background, blue text, and border rather than a saturated filled block.

### C03 - Input styling

Keep inputs 30px high with white fill and a blue focus ring such as `rgba(96, 165, 250, 0.16)`.

### C04 - Tabbed-page corners

Apply the shared 4px control-radius token to ordinary buttons, general inputs, selects, textareas, and picker icon frames. Preserve explicit shapes for pill chips, circular controls, asymmetric split controls, and square table or page frames.

### C05 - Refined dropdowns

Refine every dropdown or select-like opened menu to match the app instead of relying on an unstyled browser-native menu. Use app borders, pale surfaces, compact rows, hover and selected states, keyboard focus styling, and trigger-aligned sizing.

### C06 - Compact carets

Use filled-triangle carets for dropdown and numeric-stepper arrows. Flip the same caret for stepper-up; keep it muted at rest and full-strength on hover, focus, or open. Reserve a clear right-side arrow lane, align caret x-positions across adjacent controls, and balance input padding so values remain centered.

### C07 - Compact switches

Use 42px by 20px switches with a green enabled state.

### C08 - Sparse status chips

Use small rounded status chips with an optional dot, and use them sparingly for state and counts.

### C09 - SVG close icons

Use centered inline SVG stroke icons for close and dismiss actions instead of text glyphs so shape, line weight, and hit targets remain consistent.

### C10 - Clear drag feedback

Use a dashed neutral border for drag/drop at rest, a blue-tinted surface on hover or drag-over, and clear drop-result text.

## Interaction Expectations

### C11 - Working demos

Include working controls in every design demo, such as style switchers, dialog open and close, toast feedback, toggles, drag sorting, drop targets, and an animation trigger.

### C12 - Stable components

Keep components stable while content changes. Avoid layout shifts from hover states, active labels, or dynamic status text.

### C13 - Text must fit

Ensure text fits inside controls and panels at desktop and narrow widths.

### C14 - Visible state

Prefer explicit visible state over hidden behavior.
