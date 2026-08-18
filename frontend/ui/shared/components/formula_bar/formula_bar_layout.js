/*
===============================================================================
Formula Bar Layout
Where a floating formula bar sits and how wide it gets. Two ordered rules: the
bar stays inside the grid frame it belongs to, and within what is left it grows
as wide as its own content needs.

Callers work in viewport coordinates. A bar positioned inside a scrolling host
converts the result into that host's content space; a fixed-position bar applies
it as-is.
===============================================================================
*/

// Keeps the bar clear of the frame's right edge and its scrollbar gutter.
export const FORMULA_BAR_FRAME_INSET_PX = 14;
export const FORMULA_BAR_ANCHOR_GAP_PX = 4;

let widthCache = null;

/** Text metrics survive a scroll but not a resize, which can also change zoom. */
export function invalidateFormulaBarWidthCache() {
  widthCache = null;
}

/**
 * Width the bar's contents actually want. It is measured at `max-content` with
 * the pixel clamps lifted and restored before the browser can paint; an
 * `<input>` contributes its preferred size rather than the text inside it, so
 * whatever that text overflows by is added back.
 */
export function measureFormulaBarContentWidth(barEl, inputEl = null) {
  if (!barEl?.style) return 0;
  const { width, minWidth, maxWidth } = barEl.style;
  barEl.style.width = "max-content";
  barEl.style.minWidth = "0";
  barEl.style.maxWidth = "none";
  let natural = Number(barEl.getBoundingClientRect?.().width || 0);
  if (inputEl && inputEl.style?.display !== "none") {
    natural += Math.max(0, Number(inputEl.scrollWidth || 0) - Number(inputEl.clientWidth || 0));
  }
  barEl.style.width = width;
  barEl.style.minWidth = minWidth;
  barEl.style.maxWidth = maxWidth;
  return Math.ceil(natural);
}

/**
 * Measured width for the bar, reusing the last measurement while the bar shows
 * the same thing. `key` is whatever the caller considers its visible content.
 */
export function getFormulaBarContentWidth(barEl, key, inputEl = null) {
  if (widthCache && widthCache.el === barEl && widthCache.key === key) return widthCache.width;
  const width = measureFormulaBarContentWidth(barEl, inputEl);
  // A bar measured before it has been laid out reports nothing; caching that
  // would pin it shut until its content happened to change.
  if (width > 0) widthCache = { el: barEl, key, width };
  return width;
}

/**
 * Place the bar above its anchor, in viewport coordinates.
 *
 * `frame` bounds the bar; `frame.top` is where the grid's content starts, which
 * is what decides whether there is room above rather than the window edge.
 * Returns the bar's position, the width it should take, and which side of the
 * anchor it ended up on.
 */
export function computeFormulaBarLayout({
  anchorRect,
  frame,
  contentWidth,
  barHeight = 0,
  gap = FORMULA_BAR_ANCHOR_GAP_PX,
}) {
  const frameLeft = Number(frame?.left || 0);
  const frameRight = Number(frame?.right || 0);
  const frameWidth = Math.max(0, frameRight - frameLeft);
  const width = Math.min(frameWidth, Math.max(0, Number(contentWidth) || 0));
  if (!(width > 0)) return null;

  // Align with the anchor's left edge, then slide left rather than let the bar's
  // right side run past the frame.
  const left = Math.min(
    Math.max(Number(anchorRect?.left || 0), frameLeft),
    Math.max(frameLeft, frameRight - width),
  );

  const anchorTop = Number(anchorRect?.top || 0);
  const anchorBottom = Number(anchorRect?.bottom ?? anchorTop);
  const aboveTop = anchorTop - Number(barHeight || 0) - gap;
  // Sit above the anchor, dropping below it only when there is no room up top.
  const fitsAbove = aboveTop >= Number(frame?.top || 0);

  return {
    left: Math.round(left),
    top: Math.round(fitsAbove ? aboveTop : anchorBottom + gap),
    width: Math.round(width),
    placement: fitsAbove ? "above" : "below",
  };
}

/**
 * Keep a bar the user placed by hand inside the frame it may live in. Where
 * `computeFormulaBarLayout` derives a position from an anchor, this one only
 * corrects a position the caller already owns, so a dragged bar cannot be
 * dropped — or left by a later resize — outside the page that holds it.
 */
export function clampFormulaBarWithinFrame({ left, top, width, height, frame }) {
  const frameLeft = Number(frame?.left || 0);
  const frameTop = Number(frame?.top || 0);
  const frameRight = Number(frame?.right ?? frameLeft);
  const frameBottom = Number(frame?.bottom ?? frameTop);
  // A frame narrower than the bar pins it to the frame's own edge rather than
  // pushing it off the opposite side.
  const maxLeft = Math.max(frameLeft, frameRight - Math.max(0, Number(width) || 0));
  const maxTop = Math.max(frameTop, frameBottom - Math.max(0, Number(height) || 0));
  return {
    left: Math.round(Math.min(Math.max(Number(left) || 0, frameLeft), maxLeft)),
    top: Math.round(Math.min(Math.max(Number(top) || 0, frameTop), maxTop)),
  };
}
