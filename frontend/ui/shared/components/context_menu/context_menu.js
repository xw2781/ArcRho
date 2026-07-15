export function openContextMenu(menu, opts = {}) {
  if (!menu) return;

  const {
    anchorEl = null,
    clientX = null,
    clientY = null,
    offset = 8,
    openClass = null,
    preferPointer = true,
    align = "top-left",
  } = opts;

  const wasHidden = getComputedStyle(menu).display === "none";
  const prevVisibility = menu.style.visibility;

  if (openClass) menu.classList.add(openClass);
  if (wasHidden) menu.style.display = "block";
  menu.style.visibility = "hidden";

  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const hasPointer = Number.isFinite(clientX) && Number.isFinite(clientY);
  let left = hasPointer ? clientX : 0;
  let top = hasPointer ? clientY : 0;
  let anchorRect = null;

  if ((!preferPointer || !hasPointer) && anchorEl && anchorEl.getBoundingClientRect) {
    anchorRect = anchorEl.getBoundingClientRect();
    left = anchorRect.right + offset;
    top = anchorRect.top;
  }

  // Compensate for CSS zoom (clientX/Y are unscaled, menu positioning is scaled)
  const zoom = Number(getComputedStyle(document.documentElement).zoom || 1) || 1;
  if (zoom !== 1) {
    left = left / zoom;
    top = top / zoom;
  }

  const alignTopRight = align === "top-right";
  if (alignTopRight) {
    left = left - menuRect.width;
  }

  if (left + menuRect.width > vw - offset) {
    if (anchorRect) left = anchorRect.left - menuRect.width - offset;
    else left = vw - menuRect.width - offset;
  }
  if (top + menuRect.height > vh - offset) {
    top = vh - menuRect.height - offset;
  }

  left = Math.max(offset, left);
  top = Math.max(offset, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transform = "";
  menu.style.visibility = prevVisibility || "";
}
