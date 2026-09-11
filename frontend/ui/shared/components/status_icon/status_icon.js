// Review-status glyphs.
//
// The Project Instance dataset table paints its Status column with two icons:
// a yellow warning triangle for an object that Needs Review and a green check
// for one that is Updated. Any other table that reports the same verdict about
// an object - the Excel Link Manager, for a dataset whose linked workbook was
// saved after its values were loaded - draws them from here, and colours them
// with the .pi-status-* rules in ui/shared/styles/pi_table.css, so the two
// tables cannot drift apart.
//
// The markup is returned as a string because the dataset table builds its
// rows with innerHTML; the caller wraps it in a `.pi-status-cell` element that
// carries the `warning` or `updated` class the colours key on.

const NEEDS_REVIEW_ICON_SVG = `
      <svg class="pi-status-icon warning" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path class="pi-status-stroke" d="M9 2.3 16 15.2H2z"></path>
        <path class="pi-status-dark-mark" d="M8.25 6h1.5v4.8h-1.5zm0 5.9h1.5v1.45h-1.5z"></path>
      </svg>
    `;

const UPDATED_ICON_SVG = `
    <svg class="pi-status-icon updated" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle class="pi-status-stroke" cx="9" cy="9" r="7"></circle>
      <circle class="pi-status-soft-fill" cx="9" cy="9" r="4.8"></circle>
      <path class="pi-status-stroke" d="m6 9 2 2 4.1-4.2"></path>
    </svg>
  `;

/** The SVG for a Needs Review (`true`) or Updated (`false`) status cell. */
export function reviewStatusIconSvg(needsReview) {
  return needsReview ? NEEDS_REVIEW_ICON_SVG : UPDATED_ICON_SVG;
}
