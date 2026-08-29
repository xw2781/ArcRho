/*
===============================================================================
Formula Bar Dragging
Lets the `fx` badge carry a floating formula bar anywhere it is allowed to go,
for when the bar covers something the user needs to read while typing.

The placement is deliberately temporary and belongs to one target: showing the
bar for another cell — or coming back to this one — hands it back to its anchor.
The DFM Ratios bar owns its own copy of this behavior because it also has to
leave its scroll host; this module is the general one, for bars that are already
free of a frame and only need somewhere to be put.
===============================================================================
*/
import { clampFormulaBarWithinFrame } from "/ui/shared/components/formula_bar/formula_bar_layout.js?v=20260812a";

// Under the slop of an ordinary press, so clicking the badge moves nothing.
export const FORMULA_BAR_DRAG_THRESHOLD_PX = 3;

/**
 * Where `left: 0; top: 0` lands for a fixed bar. Fixed positions read against
 * the viewport until an ancestor takes over as the containing block, which a
 * popped-out window can do, so the offset is measured rather than assumed.
 */
function measureFixedOrigin(barEl) {
  if (!barEl?.style) return { x: 0, y: 0 };
  const { left, top } = barEl.style;
  barEl.style.left = "0px";
  barEl.style.top = "0px";
  const rect = barEl.getBoundingClientRect?.() || { left: 0, top: 0 };
  barEl.style.left = left;
  barEl.style.top = top;
  return { x: Number(rect.left || 0), y: Number(rect.top || 0) };
}

/**
 * One bar's hand-placed position.
 *
 * `getFrame` bounds where the bar may be dropped, in viewport coordinates.
 * `onPlaced` runs after each applied placement, for whatever the consumer hangs
 * off the bar's position.
 */
export function createFormulaBarDragController({
  getBar,
  getFrame,
  getBarSize = null,
  onPlaced = () => {},
  placedClass = "isDragPlaced",
  draggingClass = "isDragging",
} = {}) {
  let placement = null;
  let session = null;
  const wiredHandles = new WeakSet();

  function barElement() {
    return typeof getBar === "function" ? getBar() : null;
  }

  function frame() {
    const value = (typeof getFrame === "function" ? getFrame() : null) || {};
    return {
      left: Number(value.left || 0),
      top: Number(value.top || 0),
      right: Number(value.right || 0),
      bottom: Number(value.bottom || 0),
    };
  }

  function barSize(barEl) {
    const measured = typeof getBarSize === "function" ? getBarSize(barEl) : null;
    return {
      width: Number(measured?.width || barEl?.offsetWidth || 0),
      height: Number(measured?.height || barEl?.offsetHeight || 0),
    };
  }

  /** Put the bar's top-left corner on a viewport point. */
  function placeAtViewportPoint(barEl, left, top) {
    const origin = session?.origin || measureFixedOrigin(barEl);
    barEl.style.left = `${Math.round(left - origin.x)}px`;
    barEl.style.top = `${Math.round(top - origin.y)}px`;
  }

  /**
   * Re-apply the hand-placed position instead of the anchored one. Returns
   * false when the bar has no placement, which tells the caller to go on and
   * position the bar over the cell it belongs to.
   */
  function applyPlacement() {
    const barEl = barElement();
    if (!placement || !barEl) return false;
    const { width, height } = barSize(barEl);
    const clamped = clampFormulaBarWithinFrame({
      left: placement.left,
      top: placement.top,
      width,
      height,
      frame: frame(),
    });
    placement.left = clamped.left;
    placement.top = clamped.top;
    placeAtViewportPoint(barEl, clamped.left, clamped.top);
    onPlaced(clamped);
    return true;
  }

  /** Hand the bar back to its anchor. */
  function clearPlacement() {
    if (!placement) return false;
    placement = null;
    session = null;
    const barEl = barElement();
    barEl?.classList?.remove(placedClass);
    barEl?.classList?.remove(draggingClass);
    return true;
  }

  /**
   * A placement belongs to the target it was made for, so showing the bar for
   * any other cell — including coming back to this one from another — drops it.
   */
  function syncTarget(targetKey) {
    if (!placement) return false;
    if (placement.targetKey === String(targetKey || "")) return false;
    return clearPlacement();
  }

  function hasPlacement() {
    return !!placement;
  }

  function begin(event, handleEl, targetKey) {
    const barEl = barElement();
    if (!barEl || !event || (event.pointerType !== "touch" && event.button)) return;
    // Keep the press off the input: taking focus away from an open edit session
    // would commit the formula the user is only trying to move out of the way.
    event.preventDefault?.();
    const rect = barEl.getBoundingClientRect?.() || { left: 0, top: 0 };
    session = {
      pointerId: event.pointerId,
      handle: handleEl,
      targetKey: String(targetKey || ""),
      startX: Number(event.clientX || 0),
      startY: Number(event.clientY || 0),
      barLeft: Number(rect.left || 0),
      barTop: Number(rect.top || 0),
      origin: null,
      active: false,
    };
    handleEl?.setPointerCapture?.(event.pointerId);
  }

  function move(event) {
    const barEl = barElement();
    if (!session || !barEl || !event || event.pointerId !== session.pointerId) return;
    const dx = Number(event.clientX || 0) - session.startX;
    const dy = Number(event.clientY || 0) - session.startY;
    if (!session.active) {
      if (Math.abs(dx) < FORMULA_BAR_DRAG_THRESHOLD_PX && Math.abs(dy) < FORMULA_BAR_DRAG_THRESHOLD_PX) return;
      session.active = true;
      barEl.classList?.add(placedClass);
      barEl.classList?.add(draggingClass);
      placement = { targetKey: session.targetKey, left: session.barLeft, top: session.barTop };
      // Measured after the class switch, in case that is what made the bar fixed.
      session.origin = measureFixedOrigin(barEl);
    }
    placement.left = session.barLeft + dx;
    placement.top = session.barTop + dy;
    applyPlacement();
  }

  function end(event) {
    if (!session || (event && event.pointerId !== session.pointerId)) return;
    const finished = session;
    session = null;
    if (finished.handle?.hasPointerCapture?.(finished.pointerId)) {
      finished.handle.releasePointerCapture?.(finished.pointerId);
    }
    barElement()?.classList?.remove(draggingClass);
  }

  /** The `fx` badge is the bar's handle: it carries no other action. */
  function wireHandle(handleEl, getTargetKey = () => "") {
    if (!handleEl || wiredHandles.has(handleEl)) return false;
    wiredHandles.add(handleEl);
    handleEl.addEventListener("pointerdown", (event) => begin(event, handleEl, getTargetKey()));
    handleEl.addEventListener("pointermove", move);
    handleEl.addEventListener("pointerup", end);
    handleEl.addEventListener("pointercancel", end);
    handleEl.addEventListener("dragstart", (event) => event.preventDefault?.());
    return true;
  }

  return {
    applyPlacement,
    clearPlacement,
    hasPlacement,
    syncTarget,
    wireHandle,
  };
}
