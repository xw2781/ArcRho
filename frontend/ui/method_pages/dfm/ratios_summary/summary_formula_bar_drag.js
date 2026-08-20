/*
===============================================================================
DFM Ratios Summary Formula Bar Dragging
Lets the `fx` badge carry the floating formula bar anywhere on the DFM page when
it covers something the user needs to read. The placement is deliberately
temporary and belongs to one target: moving to another cell — or coming back to
this one — hands the bar back to its anchor above the cell it edits.
===============================================================================
*/
import {
  registerSummaryFunctions,
  summaryRuntime,
} from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260819a";
import {
  clampFormulaBarWithinFrame,
  getFormulaBarContentWidth,
} from "/ui/shared/components/formula_bar/formula_bar_layout.js?v=20260812a";

// Under the slop of an ordinary press, so clicking the badge moves nothing.
const FORMULA_BAR_DRAG_THRESHOLD_PX = 3;

/**
 * Where a dragged bar may be dropped: the DFM page, as far as it is visible.
 * A hand-placed bar is `position: fixed` and so no longer bounded by the ratio
 * grid's scroll frame; the page is what keeps it reachable.
 */
function getSummaryFormulaBarDragFrame(barEl) {
  const page = barEl?.closest?.("#dfmRatiosPage") || document.getElementById?.("dfmRatiosPage");
  const pageRect = page?.getBoundingClientRect?.();
  const viewportWidth = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
  const viewportHeight = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
  const frame = { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
  if (pageRect && pageRect.width > 0 && pageRect.height > 0) {
    frame.left = Math.max(frame.left, pageRect.left);
    frame.top = Math.max(frame.top, pageRect.top);
    // A popped-out Ratios tab is its own page, and it can sit past the window's
    // own edges only while the window is smaller than the tab reports.
    frame.right = frame.right > 0 ? Math.min(frame.right, pageRect.right) : pageRect.right;
    frame.bottom = frame.bottom > 0 ? Math.min(frame.bottom, pageRect.bottom) : pageRect.bottom;
  }
  return frame;
}

/**
 * Where `left: 0; top: 0` lands for the bar once it is fixed. Fixed positions
 * are read against the viewport until an ancestor takes over as the containing
 * block, which a popped-out tab does, so the offset is measured rather than
 * assumed.
 */
function measureSummaryFormulaBarFixedOrigin(barEl) {
  const { left, top } = barEl.style;
  barEl.style.left = "0px";
  barEl.style.top = "0px";
  const rect = barEl.getBoundingClientRect?.() || { left: 0, top: 0 };
  barEl.style.left = left;
  barEl.style.top = top;
  return { x: Number(rect.left || 0), y: Number(rect.top || 0) };
}

/** Put the bar's top-left corner on a viewport point. */
function placeSummaryFormulaBarAtViewportPoint(barEl, left, top, origin = null) {
  const fixedOrigin = origin || measureSummaryFormulaBarFixedOrigin(barEl);
  barEl.style.left = `${Math.round(left - fixedOrigin.x)}px`;
  barEl.style.top = `${Math.round(top - fixedOrigin.y)}px`;
}

/**
 * Re-apply a hand-placed position instead of the anchored one. Returns false
 * when the bar has no placement, which is what tells the anchor module to go on
 * and position the bar over its cell.
 */
function applySummaryFormulaBarDragPlacement(barEl) {
  const placement = summaryRuntime.summaryFormulaBarDragPlacement;
  if (!placement || !barEl) return false;
  const frame = getSummaryFormulaBarDragFrame(barEl);
  // The bar still sizes itself to what it shows; only where it sits is the
  // user's, so a swap between the input and the rendered display still fits.
  const contentWidth = getFormulaBarContentWidth(
    barEl,
    summaryRuntime.summaryFormulaBarContentKey?.(barEl),
    barEl.querySelector?.("#dfmSummaryFormulaBarInput"),
  );
  const width = Math.min(Math.max(0, frame.right - frame.left), Math.max(0, contentWidth));
  if (width > 0) {
    const px = `${Math.round(width)}px`;
    barEl.style.width = px;
    barEl.style.minWidth = px;
    barEl.style.maxWidth = px;
  }
  const clamped = clampFormulaBarWithinFrame({
    left: placement.left,
    top: placement.top,
    width: width > 0 ? width : Number(barEl.offsetWidth || 0),
    height: Number(barEl.offsetHeight || 0),
    frame,
  });
  placement.left = clamped.left;
  placement.top = clamped.top;
  placeSummaryFormulaBarAtViewportPoint(
    barEl,
    clamped.left,
    clamped.top,
    summaryRuntime.summaryFormulaBarDragSession?.origin || null,
  );
  summaryRuntime.scheduleSummaryFormulaBarValidationTooltipPosition?.();
  return true;
}

/** Hand the bar back to its anchor. */
function clearSummaryFormulaBarDragPlacement(barEl = null) {
  if (!summaryRuntime.summaryFormulaBarDragPlacement) return false;
  summaryRuntime.summaryFormulaBarDragPlacement = null;
  summaryRuntime.summaryFormulaBarDragSession = null;
  const bar = barEl || document.getElementById?.("dfmSummaryFormulaBar");
  bar?.classList?.remove("isDragPlaced");
  bar?.classList?.remove("isDragging");
  return true;
}

/**
 * A placement belongs to the target it was made for, so showing the bar for any
 * other cell — including coming back to this one from another — drops it.
 */
function syncSummaryFormulaBarDragPlacementTarget(barEl, targetKey) {
  const placement = summaryRuntime.summaryFormulaBarDragPlacement;
  if (!placement) return false;
  if (placement.targetKey === String(targetKey || "")) return false;
  return clearSummaryFormulaBarDragPlacement(barEl);
}

function beginSummaryFormulaBarDrag(event, barEl, handleEl) {
  if (!barEl || !event || (event.pointerType !== "touch" && event.button)) return;
  // Keep the press off the input: taking focus away from an open edit session
  // would commit the formula the user is only trying to move out of the way.
  event.preventDefault();
  const rect = barEl.getBoundingClientRect?.() || { left: 0, top: 0 };
  summaryRuntime.summaryFormulaBarDragSession = {
    pointerId: event.pointerId,
    handle: handleEl,
    startX: Number(event.clientX || 0),
    startY: Number(event.clientY || 0),
    barLeft: Number(rect.left || 0),
    barTop: Number(rect.top || 0),
    origin: null,
    active: false,
  };
  handleEl?.setPointerCapture?.(event.pointerId);
}

function moveSummaryFormulaBarDrag(event, barEl) {
  const session = summaryRuntime.summaryFormulaBarDragSession;
  if (!session || !barEl || !event || event.pointerId !== session.pointerId) return;
  const dx = Number(event.clientX || 0) - session.startX;
  const dy = Number(event.clientY || 0) - session.startY;
  if (!session.active) {
    if (Math.abs(dx) < FORMULA_BAR_DRAG_THRESHOLD_PX && Math.abs(dy) < FORMULA_BAR_DRAG_THRESHOLD_PX) return;
    session.active = true;
    barEl.classList?.add("isDragPlaced");
    barEl.classList?.add("isDragging");
    summaryRuntime.summaryFormulaBarDragPlacement = {
      targetKey: String(summaryRuntime.summaryFormulaBarVisibleKey || ""),
      left: session.barLeft,
      top: session.barTop,
    };
    // Measured after the class switch, because that is what made the bar fixed.
    session.origin = measureSummaryFormulaBarFixedOrigin(barEl);
  }
  summaryRuntime.summaryFormulaBarDragPlacement.left = session.barLeft + dx;
  summaryRuntime.summaryFormulaBarDragPlacement.top = session.barTop + dy;
  applySummaryFormulaBarDragPlacement(barEl);
}

function endSummaryFormulaBarDrag(event, barEl) {
  const session = summaryRuntime.summaryFormulaBarDragSession;
  if (!session || (event && event.pointerId !== session.pointerId)) return;
  summaryRuntime.summaryFormulaBarDragSession = null;
  if (session.handle?.hasPointerCapture?.(session.pointerId)) {
    session.handle.releasePointerCapture?.(session.pointerId);
  }
  barEl?.classList?.remove("isDragging");
}

/** The `fx` badge is the bar's handle: it carries no other action. */
function wireSummaryFormulaBarDragHandle(barEl, handleEl) {
  if (!barEl || !handleEl || handleEl.dataset?.dragWired === "1") return;
  handleEl.dataset.dragWired = "1";
  handleEl.addEventListener("pointerdown", (event) => beginSummaryFormulaBarDrag(event, barEl, handleEl));
  handleEl.addEventListener("pointermove", (event) => moveSummaryFormulaBarDrag(event, barEl));
  handleEl.addEventListener("pointerup", (event) => endSummaryFormulaBarDrag(event, barEl));
  handleEl.addEventListener("pointercancel", (event) => endSummaryFormulaBarDrag(event, barEl));
  handleEl.addEventListener("dragstart", (event) => event.preventDefault());
}

registerSummaryFunctions({
  FORMULA_BAR_DRAG_THRESHOLD_PX,
  getSummaryFormulaBarDragFrame,
  applySummaryFormulaBarDragPlacement,
  clearSummaryFormulaBarDragPlacement,
  syncSummaryFormulaBarDragPlacementTarget,
  beginSummaryFormulaBarDrag,
  moveSummaryFormulaBarDrag,
  endSummaryFormulaBarDrag,
  wireSummaryFormulaBarDragHandle,
});
