export function installProjectInstanceHiddenTabs(ctx) {
  const { api, els, projectName, state } = ctx;
  const { DATASET_WINDOW_DOCK_ANIMATION_MS, DATASET_WINDOW_RESTORE_ANIMATION_MS, HIDDEN_TABS_HOVER_CLOSE_MS } = ctx.constants;
  const { hiddenWindows, datasetWindows } = state;
  const applyWindowRect = (...args) => api.applyWindowRect(...args);
  const closeDatasetWindow = (...args) => api.closeDatasetWindow(...args);
  const getFrameRect = (...args) => api.getFrameRect(...args);
  const notifyActiveDfmWindowState = (...args) => api.notifyActiveDfmWindowState(...args);
  const notifyProjectInstanceDirtyState = (...args) => api.notifyProjectInstanceDirtyState(...args);
  const notifyProjectInstanceStateChanged = (...args) => api.notifyProjectInstanceStateChanged(...args);
  const prefersReducedMotion = (...args) => api.prefersReducedMotion(...args);
  const raiseWindow = (...args) => api.raiseWindow(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const syncDatasetWindowChrome = (...args) => api.syncDatasetWindowChrome(...args);
  const toText = (...args) => api.toText(...args);

function clearHiddenTabsHoverCloseTimer() {
  if (!state.hiddenTabsHoverCloseTimer) return;
  window.clearTimeout(state.hiddenTabsHoverCloseTimer);
  state.hiddenTabsHoverCloseTimer = 0;
}

function setHiddenTabsMenuOpen(open, { pinned = state.hiddenTabsMenuPinned } = {}) {
  if (!els.hiddenTabsWrap || !els.hiddenTabsButton) return;
  if (open) clearHiddenTabsHoverCloseTimer();
  state.hiddenTabsMenuPinned = !!open && !!pinned;
  els.hiddenTabsWrap.classList.toggle("open", !!open);
  els.hiddenTabsButton.setAttribute("aria-expanded", open ? "true" : "false");
}

function scheduleHiddenTabsHoverClose() {
  if (state.hiddenTabsMenuPinned) return;
  clearHiddenTabsHoverCloseTimer();
  state.hiddenTabsHoverCloseTimer = window.setTimeout(() => {
    state.hiddenTabsHoverCloseTimer = 0;
    if (els.hiddenTabsWrap?.matches?.(":hover") || els.hiddenTabsMenu?.matches?.(":hover")) return;
    setHiddenTabsMenuOpen(false, { pinned: false });
  }, HIDDEN_TABS_HOVER_CLOSE_MS);
}

function ensureMinimizedTabTooltip() {
  if (state.minimizedTabTooltip?.isConnected) return state.minimizedTabTooltip;
  state.minimizedTabTooltip = document.createElement("div");
  state.minimizedTabTooltip.className = "pi-minimized-tab-tooltip";
  state.minimizedTabTooltip.setAttribute("role", "tooltip");
  state.minimizedTabTooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(state.minimizedTabTooltip);
  return state.minimizedTabTooltip;
}

function positionMinimizedTabTooltip(tab) {
  if (!state.minimizedTabTooltip?.classList?.contains("active") || !tab?.getBoundingClientRect) return;
  const rect = tab.getBoundingClientRect();
  const tooltipRect = state.minimizedTabTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - tooltipRect.width - 8, rect.left + (rect.width - tooltipRect.width) / 2));
  const top = Math.max(8, rect.bottom + 8);
  state.minimizedTabTooltip.style.left = `${Math.round(left)}px`;
  state.minimizedTabTooltip.style.top = `${Math.round(top)}px`;
}

function showMinimizedTabTooltip(tab, text) {
  const tooltipText = toText(text);
  if (!tooltipText) return;
  const tooltip = ensureMinimizedTabTooltip();
  tooltip.textContent = tooltipText;
  tooltip.setAttribute("aria-hidden", "false");
  tooltip.classList.add("active");
  window.requestAnimationFrame(() => positionMinimizedTabTooltip(tab));
}

function hideMinimizedTabTooltip() {
  if (!state.minimizedTabTooltip) return;
  state.minimizedTabTooltip.classList.remove("active");
  state.minimizedTabTooltip.setAttribute("aria-hidden", "true");
}

function updateHiddenTabsArea() {
  const count = hiddenWindows.size;
  hideMinimizedTabTooltip();
  if (els.hiddenTabsLabel) {
    els.hiddenTabsLabel.textContent = `${count} hidden`;
  }
  if (els.hiddenTabsList) {
    els.hiddenTabsList.innerHTML = "";
    for (const [id, item] of hiddenWindows) {
      const fullTitle = item.fullTitle || item.title;
      const tab = document.createElement("div");
      tab.className = "pi-minimized-tab";
      tab.classList.toggle("dirty", item.frame?.dataset?.dirty === "1");
      tab.dataset.windowId = id;
      tab.dataset.fullTitle = fullTitle;
      tab.addEventListener("mouseenter", () => showMinimizedTabTooltip(tab, fullTitle));
      tab.addEventListener("mousemove", () => positionMinimizedTabTooltip(tab));
      tab.addEventListener("mouseleave", hideMinimizedTabTooltip);
      tab.addEventListener("focusin", () => showMinimizedTabTooltip(tab, fullTitle));
      tab.addEventListener("focusout", hideMinimizedTabTooltip);
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "pi-minimized-tab-restore";
      restoreBtn.setAttribute("aria-label", item.title);
      restoreBtn.textContent = item.title;
      restoreBtn.addEventListener("click", () => restoreHiddenWindow(id));
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "pi-minimized-tab-close";
      closeBtn.title = `Close ${item.title}`;
      closeBtn.setAttribute("aria-label", `Close ${item.title}`);
      closeBtn.textContent = "x";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeHiddenWindow(id);
      });
      tab.append(restoreBtn, closeBtn);
      els.hiddenTabsList.appendChild(tab);
    }
  }
  if (!els.hiddenTabsMenu) return;
  els.hiddenTabsMenu.innerHTML = "";
  const actions = document.createElement("div");
  actions.className = "pi-hidden-tabs-actions";
  const resumeAllBtn = document.createElement("button");
  resumeAllBtn.type = "button";
  resumeAllBtn.className = "pi-hidden-tabs-action";
  resumeAllBtn.textContent = "Resume all tabs";
  resumeAllBtn.addEventListener("click", () => {
    void restoreAllHiddenWindows();
  });
  const closeAllBtn = document.createElement("button");
  closeAllBtn.type = "button";
  closeAllBtn.className = "pi-hidden-tabs-action danger";
  closeAllBtn.textContent = "Close all tabs";
  closeAllBtn.addEventListener("click", () => {
    closeAllHiddenWindows();
  });
  actions.append(resumeAllBtn, closeAllBtn);
  els.hiddenTabsMenu.appendChild(actions);
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "pi-hidden-tabs-empty";
    empty.textContent = "No hidden tabs.";
    els.hiddenTabsMenu.appendChild(empty);
    return;
  }
  for (const [id, item] of hiddenWindows) {
    const row = document.createElement("div");
    row.className = "pi-hidden-tab-row";
    row.classList.toggle("dirty", item.frame?.dataset?.dirty === "1");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pi-hidden-tab-item";
    button.setAttribute("role", "menuitem");
    const fullTitle = item.fullTitle || item.title;
    button.title = fullTitle;
    button.innerHTML = `
      <svg class="pi-hidden-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2"></rect>
        <path d="M9 9h6"></path>
        <path d="M9 13h6"></path>
      </svg>
      <span class="pi-hidden-tab-name"></span>
    `;
    button.querySelector(".pi-hidden-tab-name").textContent = fullTitle;
    button.addEventListener("click", () => restoreHiddenWindow(id));
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "pi-hidden-tab-delete";
    deleteBtn.title = `Close ${fullTitle}`;
    deleteBtn.setAttribute("aria-label", `Close ${fullTitle}`);
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 13h10l1-13"></path>
        <path d="M9 7V5h6v2"></path>
      </svg>
    `;
    deleteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeHiddenWindow(id);
    });
    row.append(button, deleteBtn);
    els.hiddenTabsMenu.appendChild(row);
  }
}

function getMinimizedTabElement(frameOrId) {
  const id = typeof frameOrId === "string" ? frameOrId : frameOrId?.dataset?.windowId || "";
  if (!id || !els.hiddenTabsList) return null;
  for (const tab of els.hiddenTabsList.querySelectorAll(".pi-minimized-tab")) {
    if (tab.dataset.windowId === id) return tab;
  }
  return null;
}

function getHiddenDockTargetRect(frameOrId = null) {
  const target = getMinimizedTabElement(frameOrId) || els.hiddenTabsButton || els.hiddenTabsWrap;
  const targetRect = target?.getBoundingClientRect?.();
  const rootRect = els.root?.getBoundingClientRect?.();
  if (!targetRect || !rootRect) return null;
  return {
    x: targetRect.left - rootRect.left,
    y: targetRect.top - rootRect.top,
    width: Math.max(1, targetRect.width),
    height: Math.max(1, targetRect.height),
  };
}

function getFrameTransformToRect(frameRect, targetRect) {
  const scaleX = Math.max(0.08, targetRect.width / Math.max(1, frameRect.width));
  const scaleY = Math.max(0.08, targetRect.height / Math.max(1, frameRect.height));
  return {
    x: targetRect.x - frameRect.x,
    y: targetRect.y - frameRect.y,
    scaleX,
    scaleY,
  };
}

async function animateWindowToDock(frame, dockRect = getHiddenDockTargetRect(frame)) {
  const frameRect = getFrameRect(frame);
  if (!dockRect || prefersReducedMotion() || typeof frame.animate !== "function") return;
  const transform = getFrameTransformToRect(frameRect, dockRect);
  frame.style.pointerEvents = "none";
  frame.style.transformOrigin = "top left";
  try {
    const animation = frame.animate(
      [
        {
          transform: "translate(0, 0) scale(1, 1)",
          opacity: 1,
          offset: 0,
        },
        {
          transform: `translate(${Math.round(transform.x * 0.72)}px, ${Math.round(transform.y * 0.34)}px) scale(0.72, 0.82)`,
          opacity: 0.86,
          offset: 0.52,
        },
        {
          transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scaleX}, ${transform.scaleY})`,
          opacity: 0.08,
          offset: 1,
        },
      ],
      {
        duration: DATASET_WINDOW_DOCK_ANIMATION_MS,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    );
    await animation.finished;
  } catch {
    // Best-effort visual polish only.
  } finally {
    frame.style.transformOrigin = "";
    frame.style.pointerEvents = "";
  }
}

async function animateWindowFromDock(frame, dockRect = getHiddenDockTargetRect(frame)) {
  const frameRect = getFrameRect(frame);
  if (!dockRect || prefersReducedMotion() || typeof frame.animate !== "function") return;
  const transform = getFrameTransformToRect(frameRect, dockRect);
  frame.style.pointerEvents = "none";
  frame.style.transformOrigin = "top left";
  try {
    const animation = frame.animate(
      [
        {
          transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scaleX}, ${transform.scaleY})`,
          opacity: 0.08,
          offset: 0,
        },
        {
          transform: `translate(${Math.round(transform.x * 0.2)}px, ${Math.round(transform.y * 0.58)}px) scale(1.03, 0.96)`,
          opacity: 0.92,
          offset: 0.78,
        },
        {
          transform: "translate(0, 0) scale(1, 1)",
          opacity: 1,
          offset: 1,
        },
      ],
      {
        duration: DATASET_WINDOW_RESTORE_ANIMATION_MS,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      }
    );
    await animation.finished;
  } catch {
    // Best-effort visual polish only.
  } finally {
    frame.style.transformOrigin = "";
    frame.style.pointerEvents = "";
  }
}

async function hideDatasetWindow(frame, restoreRect) {
  const id = frame?.dataset?.windowId || "";
  if (!id) return;
  const title = frame.dataset.windowDatasetName || frame.dataset.windowTitle || frame.getAttribute("aria-label") || "Dataset";
  hiddenWindows.set(id, {
    frame,
    title,
    fullTitle: frame.dataset.windowTitle || frame.getAttribute("aria-label") || title,
    restoreRect: restoreRect || getFrameRect(frame),
  });
  frame.dataset.hidden = "1";
  if (state.activeDatasetWindow === frame) state.activeDatasetWindow = null;
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  await animateWindowToDock(frame);
  frame.style.display = "none";
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  setStatus(`Hidden ${title}`);
}

async function restoreHiddenWindow(id) {
  const item = hiddenWindows.get(id);
  if (!item?.frame) return;
  const dockRect = getHiddenDockTargetRect(id);
  hiddenWindows.delete(id);
  item.frame.dataset.hidden = "0";
  item.frame.style.display = "flex";
  applyWindowRect(item.frame, item.restoreRect || getFrameRect(item.frame));
  raiseWindow(item.frame);
  updateHiddenTabsArea();
  setHiddenTabsMenuOpen(hiddenWindows.size > 0);
  await animateWindowFromDock(item.frame, dockRect);
  notifyProjectInstanceStateChanged();
  setStatus(`Restored ${item.title}`);
}

function closeHiddenWindow(id) {
  const item = hiddenWindows.get(id);
  if (!item?.frame) return;
  const title = item.title || item.frame.dataset.windowTitle || "dataset window";
  closeDatasetWindow(item.frame, { status: false });
  if (!hiddenWindows.size) setHiddenTabsMenuOpen(false, { pinned: false });
  setStatus(`Closed ${title}`);
}

function closeAllHiddenWindows() {
  const ids = Array.from(hiddenWindows.keys());
  const count = ids.length;
  if (!count) return;
  const dirtyCount = ids.reduce((total, id) => {
    const frame = hiddenWindows.get(id)?.frame;
    return total + (frame?.dataset?.dirty === "1" ? 1 : 0);
  }, 0);
  if (dirtyCount) {
    const ok = window.confirm(`${dirtyCount} hidden DFM ${dirtyCount === 1 ? "window has" : "windows have"} unsaved changes. Close anyway?`);
    if (!ok) return;
  }
  for (const id of Array.from(hiddenWindows.keys())) {
    const item = hiddenWindows.get(id);
    if (!item?.frame) {
      hiddenWindows.delete(id);
      continue;
    }
    datasetWindows.delete(item.frame.dataset.windowKey || "");
    item.frame.remove();
    hiddenWindows.delete(id);
  }
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  setHiddenTabsMenuOpen(false, { pinned: false });
  notifyProjectInstanceDirtyState();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  setStatus(`Closed ${count} hidden ${count === 1 ? "tab" : "tabs"}`);
}

async function restoreAllHiddenWindows() {
  const ids = Array.from(hiddenWindows.keys());
  if (!ids.length) return;
  for (const id of ids) {
    await restoreHiddenWindow(id);
  }
  setHiddenTabsMenuOpen(false, { pinned: false });
}

async function activateDatasetWindow(frame) {
  if (!frame?.isConnected) return false;
  if (frame.dataset.hidden === "1" || frame.style.display === "none") {
    await restoreHiddenWindow(frame.dataset.windowId || "");
  } else {
    frame.style.display = "flex";
    raiseWindow(frame);
    setStatus(`Activated ${frame.dataset.windowTitle || frame.getAttribute("aria-label") || "dataset window"}`);
  }
  notifyProjectInstanceStateChanged();
  return true;
}


function initHiddenTabsArea() {
  if (!els.hiddenTabsButton || els.hiddenTabsButton.dataset.wired === "1") return;
  els.hiddenTabsButton.dataset.wired = "1";
  updateHiddenTabsArea();
  els.hiddenTabsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextOpen = !els.hiddenTabsWrap?.classList?.contains("open");
    setHiddenTabsMenuOpen(nextOpen, { pinned: nextOpen });
  });
  els.hiddenTabsButton.addEventListener("mouseenter", () => {
    setHiddenTabsMenuOpen(true, { pinned: state.hiddenTabsMenuPinned });
  });
  els.hiddenTabsButton.addEventListener("mouseleave", () => {
    scheduleHiddenTabsHoverClose();
  });
  els.hiddenTabsMenu?.addEventListener("mouseenter", () => {
    setHiddenTabsMenuOpen(true, { pinned: state.hiddenTabsMenuPinned });
  });
  els.hiddenTabsMenu?.addEventListener("mouseleave", () => {
    scheduleHiddenTabsHoverClose();
  });
  document.addEventListener("mousedown", (event) => {
    if (els.hiddenTabsWrap?.contains(event.target)) return;
    setHiddenTabsMenuOpen(false, { pinned: false });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setHiddenTabsMenuOpen(false, { pinned: false });
  });
}

  Object.assign(api, {
    activateDatasetWindow,
    animateWindowFromDock,
    animateWindowToDock,
    clearHiddenTabsHoverCloseTimer,
    closeAllHiddenWindows,
    closeHiddenWindow,
    ensureMinimizedTabTooltip,
    getFrameTransformToRect,
    getHiddenDockTargetRect,
    getMinimizedTabElement,
    hideDatasetWindow,
    hideMinimizedTabTooltip,
    initHiddenTabsArea,
    positionMinimizedTabTooltip,
    restoreAllHiddenWindows,
    restoreHiddenWindow,
    scheduleHiddenTabsHoverClose,
    setHiddenTabsMenuOpen,
    showMinimizedTabTooltip,
    updateHiddenTabsArea
  });
}
