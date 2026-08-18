/*
 * Shared cascade (second-level) menu controller.
 *
 * Hover alone cannot keep a submenu reachable: the pointer has to cross the gap
 * between the parent row and the submenu, and it has to travel diagonally over
 * sibling rows to reach the lower entries. Either move ends the parent's hover
 * and a CSS-only cascade disappears mid-approach.
 *
 * This controller adds the two affordances a cascade needs:
 *   1. a close grace period, so a momentary exit does not close the submenu, and
 *   2. an approach corridor, so the submenu stays open while the pointer is
 *      still heading toward it, even across sibling rows.
 *
 * Geometry and the hover bridge live in `/ui/shared/styles/cascade_menu.css`.
 */

const OPEN_CLASS = "menuSubmenuOpen";
const FLIP_CLASS = "menuSubmenuFlip";
const ITEM_SELECTOR = ".menuItem.hasSubmenu";
const SUBMENU_SELECTOR = ":scope > .menuSubmenu";

/* Grace period after the pointer leaves the parent item or the submenu. */
const CLOSE_DELAY_MS = 260;
/* Grace period re-armed while the pointer is still heading toward the submenu. */
const CORRIDOR_DELAY_MS = 320;
/* Vertical tolerance on the corridor, so grazing the panel edge still counts. */
const CORRIDOR_PAD_PX = 12;
/* Keeps a flipped or shifted submenu clear of the window edge. */
const VIEWPORT_PAD_PX = 8;

const WIRED = new WeakSet();

/** Open items from outermost to innermost, so nested cascades close in order. */
const openPath = [];
let closeTimer = 0;
let lastPoint = null;

function submenuOf(item) {
  return item?.querySelector?.(SUBMENU_SELECTOR) || null;
}

function isDisabled(item) {
  return !item || item.classList.contains("disabled") || item.getAttribute("aria-disabled") === "true";
}

function cascadeItemFor(node) {
  if (!(node instanceof Element)) return null;
  const item = node.closest(ITEM_SELECTOR);
  return item && !isDisabled(item) ? item : null;
}

function cancelClose() {
  if (!closeTimer) return;
  clearTimeout(closeTimer);
  closeTimer = 0;
}

function scheduleClose(delayMs) {
  cancelClose();
  if (openPath.length === 0) return;
  closeTimer = setTimeout(() => {
    closeTimer = 0;
    closeAllCascadeSubmenus();
  }, delayMs);
}

function applyOpenState(item, open) {
  item.classList.toggle(OPEN_CLASS, open);
  if (item.hasAttribute("aria-haspopup") || item.hasAttribute("aria-expanded")) {
    item.setAttribute("aria-expanded", open ? "true" : "false");
  }
  const submenu = submenuOf(item);
  if (!submenu) return;
  if (open) {
    positionCascadeSubmenu(item);
    return;
  }
  submenu.classList.remove(FLIP_CLASS);
  submenu.style.removeProperty("--ar-menu-cascade-shift");
}

/**
 * Keeps an opened submenu inside the window: flips it to the parent's other
 * side when it would run off the edge, then lifts it when it would run past the
 * bottom. Both values depend on live measurements, so they cannot live in CSS.
 */
export function positionCascadeSubmenu(item) {
  const submenu = submenuOf(item);
  if (!submenu || typeof submenu.getBoundingClientRect !== "function") return;
  submenu.classList.remove(FLIP_CLASS);
  submenu.style.removeProperty("--ar-menu-cascade-shift");

  const viewWidth = window.innerWidth || 0;
  const viewHeight = window.innerHeight || 0;
  let rect = submenu.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const itemRect = item.getBoundingClientRect();
  const overflowsRight = rect.right > viewWidth - VIEWPORT_PAD_PX;
  const fitsLeft = itemRect.left - rect.width > VIEWPORT_PAD_PX;
  if (overflowsRight && fitsLeft) {
    submenu.classList.add(FLIP_CLASS);
    rect = submenu.getBoundingClientRect();
  }

  const overflowsBottom = rect.bottom - (viewHeight - VIEWPORT_PAD_PX);
  if (overflowsBottom <= 0) return;
  const lift = Math.min(overflowsBottom, Math.max(0, rect.top - VIEWPORT_PAD_PX));
  if (lift > 0) submenu.style.setProperty("--ar-menu-cascade-shift", `-${Math.round(lift)}px`);
}

function closeInnermost() {
  const item = openPath.pop();
  if (item) applyOpenState(item, false);
}

/** Opens `item`, closing any open sibling branch that is not on its path. */
export function openCascadeSubmenu(item) {
  if (!item || isDisabled(item) || !submenuOf(item)) return;
  while (openPath.length > 0 && !openPath[openPath.length - 1].contains(item)) closeInnermost();
  if (openPath[openPath.length - 1] === item) return;
  openPath.push(item);
  applyOpenState(item, true);
}

export function closeAllCascadeSubmenus() {
  cancelClose();
  while (openPath.length > 0) closeInnermost();
  lastPoint = null;
}

function crossProductSign(p, q, r) {
  return (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
}

function isInsideTriangle(point, a, b, c) {
  const d1 = crossProductSign(point, a, b);
  const d2 = crossProductSign(point, b, c);
  const d3 = crossProductSign(point, c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * True while the pointer is inside the triangle spanned by its previous
 * position and the near edge of the open submenu, which is the corridor a user
 * sweeps through when reaching for a lower submenu row.
 */
function isApproachingSubmenu(previous, current, rect) {
  if (!previous) return false;
  if (Math.abs(current.x - previous.x) < 1 && Math.abs(current.y - previous.y) < 1) return false;
  const nearEdgeX = rect.left >= current.x ? rect.left : rect.right;
  if ((nearEdgeX - previous.x) * (current.x - previous.x) <= 0) return false;
  return isInsideTriangle(
    current,
    previous,
    { x: nearEdgeX, y: rect.top - CORRIDOR_PAD_PX },
    { x: nearEdgeX, y: rect.bottom + CORRIDOR_PAD_PX },
  );
}

function onPointerOver(event) {
  const item = cascadeItemFor(event.target);
  if (item) {
    cancelClose();
    openCascadeSubmenu(item);
    return;
  }
  if (openPath.length > 0 && !closeTimer) scheduleClose(CLOSE_DELAY_MS);
}

function onPointerMove(event) {
  // Pointer history is only worth keeping while a cascade is open; this handler
  // otherwise sees every move in the application.
  if (openPath.length === 0) {
    lastPoint = null;
    return;
  }
  const previous = lastPoint;
  const current = { x: event.clientX, y: event.clientY };
  lastPoint = current;
  if (!closeTimer) return;
  const submenu = submenuOf(openPath[openPath.length - 1]);
  const rect = submenu?.getBoundingClientRect?.();
  if (!rect || rect.width === 0) return;
  if (isApproachingSubmenu(previous, current, rect)) scheduleClose(CORRIDOR_DELAY_MS);
}

function onPointerDown(event) {
  if (openPath.length === 0) return;
  const target = event.target;
  const inOpenBranch = target instanceof Element && openPath.some((item) => item.contains(target));
  if (!inOpenBranch) closeAllCascadeSubmenus();
}

/**
 * Wires the document once. Listeners are delegated, so submenus rendered later
 * (recent files, recent notebooks) need no extra registration.
 */
export function initCascadeMenus(doc = document) {
  if (!doc || WIRED.has(doc)) return;
  WIRED.add(doc);
  doc.addEventListener("pointerover", onPointerOver, true);
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.defaultView?.addEventListener?.("blur", closeAllCascadeSubmenus);
  doc.defaultView?.addEventListener?.("resize", closeAllCascadeSubmenus);
  const global = doc.defaultView;
  if (global) {
    global.ArcRhoCascadeMenu = Object.freeze({
      open: openCascadeSubmenu,
      closeAll: closeAllCascadeSubmenus,
      position: positionCascadeSubmenu,
    });
  }
}
