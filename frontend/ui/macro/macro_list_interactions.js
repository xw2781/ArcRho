const DRAG_THRESHOLD_PX = 4;
const GHOST_OFFSET_PX = 12;

export function syncMacroListSelection(list, selectedId) {
  list?.querySelectorAll(".macroListItem").forEach((item) => {
    const active = item.dataset.id === selectedId;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
  });
}

export function focusMacroListItem(list, id) {
  list?.querySelector(`.macroListItem[data-id="${CSS.escape(String(id || ""))}"]`)?.focus?.();
}

export function initMacroListKeyboard(list, { getIds, onSelect }) {
  list.addEventListener("keydown", (event) => {
    const ids = getIds();
    if (!ids.length) return;
    const current = ids.indexOf(event.target?.closest?.(".macroListItem")?.dataset?.id);
    let next;
    if (event.key === "ArrowDown") next = Math.min(ids.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else return;
    event.preventDefault();
    onSelect(ids[next]);
    focusMacroListItem(list, ids[next]);
  });
}

function clearDropIndicators(list) {
  list.querySelectorAll(".dropBefore, .dropAfter").forEach((item) => item.classList.remove("dropBefore", "dropAfter"));
}

function reorderTarget(list, source, element, clientY) {
  const item = element?.closest?.(".macroListItem");
  const over = item && list.contains(item) ? item : list.lastElementChild;
  if (!over || over === source) return null;
  const rect = over.getBoundingClientRect();
  const before = item === over && clientY < rect.top + rect.height / 2;
  const beforeId = before ? over.dataset.id : (over.nextElementSibling?.dataset.id || "");
  if (beforeId === source.dataset.id || beforeId === (source.nextElementSibling?.dataset.id || "")) return null;
  over.classList.add(before ? "dropBefore" : "dropAfter");
  return { kind: "reorder", beforeId };
}

// Pointer-driven drag for a macro list. A press that moves less than the
// threshold stays a click; beyond it the item becomes a drag with a floating
// ghost. Targets: reorder inside the same list (when `reorder` is on), or
// whatever `outsideTarget` returns for a pointer outside the owning window.
// A target may carry `highlight`, an element tinted while it is the target.
export function initMacroListDrag(list, windowElement, { getMacro, reorder = false, outsideTarget = () => null, label, onStart, onDrop }) {
  let drag = null;
  let suppressClick = false;

  const setHighlight = (element) => {
    if (drag.highlight === element) return;
    drag.highlight?.classList.remove("macroDropTarget");
    element?.classList.add("macroDropTarget");
    drag.highlight = element || null;
  };

  const finish = () => {
    drag.ghost?.remove();
    drag.item.classList.remove("dragSource");
    document.body.classList.remove("macroListDragActive");
    clearDropIndicators(list);
    setHighlight(null);
    window.removeEventListener("keydown", onKeyDown, true);
    drag = null;
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !drag?.active) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = true;
    finish();
  };

  list.addEventListener("pointerdown", (event) => {
    const item = event.target?.closest?.(".macroListItem");
    if (event.button !== 0 || !item || !list.contains(item)) return;
    suppressClick = false;
    drag = { pointerId: event.pointerId, item, startX: event.clientX, startY: event.clientY, active: false, ghost: null, target: null, highlight: null };
    try { item.setPointerCapture(event.pointerId); } catch {}
  });

  list.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const macro = getMacro(drag.item.dataset.id);
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      drag.ghost = document.createElement("div");
      drag.ghost.className = "macroDragGhost";
      document.body.appendChild(drag.ghost);
      drag.item.classList.add("dragSource");
      document.body.classList.add("macroListDragActive");
      window.addEventListener("keydown", onKeyDown, true);
      onStart?.(macro);
    }
    clearDropIndicators(list);
    const element = document.elementFromPoint(event.clientX, event.clientY);
    let target = null;
    if (list.contains(element)) {
      target = reorder ? reorderTarget(list, drag.item, element, event.clientY) : null;
    } else if (!windowElement.contains(element)) {
      target = outsideTarget(element, macro);
    }
    drag.target = target;
    setHighlight(target?.highlight || null);
    drag.ghost.dataset.kind = target?.kind || "";
    drag.ghost.textContent = label(macro, target);
    drag.ghost.style.left = `${event.clientX + GHOST_OFFSET_PX}px`;
    drag.ghost.style.top = `${event.clientY + GHOST_OFFSET_PX}px`;
  });

  const stop = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    try { drag.item.releasePointerCapture(event.pointerId); } catch {}
    if (!drag.active) {
      drag = null;
      return;
    }
    const macro = getMacro(drag.item.dataset.id);
    const target = event.type === "pointerup" ? drag.target : null;
    suppressClick = true;
    finish();
    if (target) onDrop(macro, target);
  };
  list.addEventListener("pointerup", stop);
  list.addEventListener("pointercancel", stop);

  list.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
