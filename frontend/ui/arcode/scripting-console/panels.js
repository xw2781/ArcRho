// ---------------------------------------------------------------------------
// Variables panel
// ---------------------------------------------------------------------------

async function refreshVariables() {
  try {
    const resp = await scriptingFetch("/scripting/variables");
    const vars = await resp.json();
    renderVariables(vars);
  } catch {
    // Silently fail
  }
}

function renderVariables(vars) {
  if (!vars || vars.length === 0) {
    varsBody.innerHTML = `<div class="sc-var-empty">No variables yet.<br>Run a cell to see variables here.</div>`;
    return;
  }

  let html = `<table class="sc-var-table">
    <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Value</th><th></th></tr></thead><tbody>`;

  vars.forEach((v) => {
    html += `<tr>
      <td class="sc-var-name">${escapeHtml(v.name)}</td>
      <td class="sc-var-type">${escapeHtml(v.type)}</td>
      <td class="sc-var-size">${escapeHtml(v.size || "")}</td>
      <td class="sc-var-preview" title="${escapeHtml(v.preview)}">${escapeHtml(v.preview)}</td>
      <td><button class="sc-var-del" data-var-name="${escapeHtml(v.name)}" title="Delete variable">&times;</button></td>
    </tr>`;
  });

  html += `</tbody></table>`;
  varsBody.innerHTML = html;

  // Wire delete buttons
  varsBody.querySelectorAll(".sc-var-del").forEach((btn) => {
    btn.addEventListener("click", () => deleteVariable(btn.dataset.varName));
  });
}

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle("collapsed", Boolean(collapsed));
  requestAnimationFrame(() => {
    cells.forEach((c) => { if (c.editor) c.editor.layout(); });
  });
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!sidebar.classList.contains("collapsed"));
}


// ---------------------------------------------------------------------------
// Sidebar layout + panel actions
// ---------------------------------------------------------------------------

let panelCtxTarget = null;

const sidebarCtxMenu = document.getElementById("sidebarCtxMenu");
const ctxMoveLeft = document.getElementById("ctxMoveLeft");
const ctxMoveRight = document.getElementById("ctxMoveRight");
const panelSlotCtxMenu = document.getElementById("panelSlotCtxMenu");
const ctxMovePanelTop = document.getElementById("ctxMovePanelTop");
const ctxMovePanelBottom = document.getElementById("ctxMovePanelBottom");
const scMain = document.querySelector(".sc-main");
const SIDEBAR_POS_KEY = "sc_sidebar_position";
const SIDEBAR_SPLIT_LAYOUT_KEY = "sc_sidebar_split_layout";
const SIDEBAR_SPLIT_RATIO_KEY = "sc_sidebar_split_ratio";
const TOC_HEADING_NUMBERS_KEY = "sc_toc_heading_numbers";
const TOC_HEADING_NUMBER_MODES = Object.freeze({
  NONE: 0,
  FROM_FIRST: 1,
  FROM_SECOND: 2,
});
const PANEL_TYPES = Object.freeze({
  TOC: "toc",
  VARS: "vars",
});
const PANEL_COLLAPSE_KEY = "sc_panel_collapsed";
const SIDEBAR_PANEL_MIN_HEIGHT = 72;

let sidebarPosition = localStorage.getItem(SIDEBAR_POS_KEY) || "left";
let sidebarSplitLayout = loadSidebarSplitLayout();
let sidebarSplitRatio = loadSidebarSplitRatio();
let panelCollapsedState = loadPanelCollapsedState();
let tocHeadingNumberMode = loadTocHeadingNumberMode();
let syncingRenderedMarkdownHeadings = false;

function normalizePanelType(raw) {
  return raw === PANEL_TYPES.VARS ? PANEL_TYPES.VARS : PANEL_TYPES.TOC;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSidebarSplitLayout(raw) {
  const topRaw = raw && typeof raw === "object" ? raw.top : null;
  const bottomRaw = raw && typeof raw === "object" ? raw.bottom : null;

  const top = normalizePanelType(topRaw);
  let bottom = (bottomRaw === PANEL_TYPES.TOC || bottomRaw === PANEL_TYPES.VARS)
    ? bottomRaw
    : (top === PANEL_TYPES.TOC ? PANEL_TYPES.VARS : PANEL_TYPES.TOC);
  if (bottom === top) {
    bottom = top === PANEL_TYPES.TOC ? PANEL_TYPES.VARS : PANEL_TYPES.TOC;
  }
  return { top, bottom };
}

function loadSidebarSplitLayout() {
  try {
    const raw = localStorage.getItem(SIDEBAR_SPLIT_LAYOUT_KEY);
    if (!raw) return { top: PANEL_TYPES.TOC, bottom: PANEL_TYPES.VARS };
    return normalizeSidebarSplitLayout(JSON.parse(raw));
  } catch {
    return { top: PANEL_TYPES.TOC, bottom: PANEL_TYPES.VARS };
  }
}

function saveSidebarSplitLayout() {
  try {
    localStorage.setItem(SIDEBAR_SPLIT_LAYOUT_KEY, JSON.stringify(sidebarSplitLayout));
  } catch {}
}

function loadSidebarSplitRatio() {
  try {
    const raw = Number.parseFloat(localStorage.getItem(SIDEBAR_SPLIT_RATIO_KEY) || "");
    if (!Number.isFinite(raw)) return 0.58;
    return clampNumber(raw, 0.2, 0.8);
  } catch {
    return 0.58;
  }
}

function saveSidebarSplitRatio() {
  try {
    localStorage.setItem(SIDEBAR_SPLIT_RATIO_KEY, String(sidebarSplitRatio));
  } catch {}
}

function normalizeTocHeadingNumberMode(value) {
  const numeric = Number(value);
  if (numeric === TOC_HEADING_NUMBER_MODES.FROM_SECOND) return TOC_HEADING_NUMBER_MODES.FROM_SECOND;
  if (numeric === TOC_HEADING_NUMBER_MODES.FROM_FIRST) return TOC_HEADING_NUMBER_MODES.FROM_FIRST;
  return TOC_HEADING_NUMBER_MODES.NONE;
}

function loadTocHeadingNumberMode() {
  try {
    return normalizeTocHeadingNumberMode(localStorage.getItem(TOC_HEADING_NUMBERS_KEY));
  } catch {
    return TOC_HEADING_NUMBER_MODES.NONE;
  }
}

function saveTocHeadingNumberMode() {
  try {
    localStorage.setItem(TOC_HEADING_NUMBERS_KEY, String(tocHeadingNumberMode));
  } catch {}
}

function updateTocHeadingNumbersButton() {
  if (!tocHeadingNumbersBtn) return;
  const mode = normalizeTocHeadingNumberMode(tocHeadingNumberMode);
  tocHeadingNumbersBtn.classList.toggle("active", mode !== TOC_HEADING_NUMBER_MODES.NONE);
  tocHeadingNumbersBtn.setAttribute(
    "aria-pressed",
    mode === TOC_HEADING_NUMBER_MODES.NONE ? "false" : (mode === TOC_HEADING_NUMBER_MODES.FROM_FIRST ? "true" : "mixed")
  );
  tocHeadingNumbersBtn.title = mode === TOC_HEADING_NUMBER_MODES.NONE
    ? "Show heading numbers from first heading"
    : (mode === TOC_HEADING_NUMBER_MODES.FROM_FIRST
      ? "Show heading numbers from second heading"
      : "Hide heading numbers");
}

function toggleTocHeadingNumbers() {
  tocHeadingNumberMode = normalizeTocHeadingNumberMode(tocHeadingNumberMode + 1);
  saveTocHeadingNumberMode();
  updateTocHeadingNumbersButton();
  if (typeof refreshRenderedMarkdownCells === "function") {
    refreshRenderedMarkdownCells({ refresh: false });
  }
  renderToc();
}

function getPanelSlot(panelType) {
  return sidebarSplitLayout.top === panelType ? "top" : "bottom";
}

function panelDisplayName(panelType) {
  return panelType === PANEL_TYPES.VARS ? "Variables" : "TOC";
}

function getPanelElements(panelType) {
  if (panelType === PANEL_TYPES.VARS) {
    return { view: varsView, slot: varsView?.parentElement, header: varsHeader };
  }
  return { view: tocView, slot: tocView?.parentElement, header: tocHeader };
}

function loadPanelCollapsedState() {
  try {
    const raw = localStorage.getItem(PANEL_COLLAPSE_KEY);
    if (!raw) return { [PANEL_TYPES.TOC]: false, [PANEL_TYPES.VARS]: false };
    const parsed = JSON.parse(raw);
    return {
      [PANEL_TYPES.TOC]: Boolean(parsed?.[PANEL_TYPES.TOC]),
      [PANEL_TYPES.VARS]: Boolean(parsed?.[PANEL_TYPES.VARS]),
    };
  } catch {
    return { [PANEL_TYPES.TOC]: false, [PANEL_TYPES.VARS]: false };
  }
}

function savePanelCollapsedState() {
  try {
    localStorage.setItem(PANEL_COLLAPSE_KEY, JSON.stringify(panelCollapsedState));
  } catch {}
}

function setPanelCollapsed(panelType, collapsed, { persist = true } = {}) {
  const normalized = normalizePanelType(panelType);
  const { view, slot, header } = getPanelElements(normalized);
  if (!view || !slot) return;

  const nextCollapsed = Boolean(collapsed);
  panelCollapsedState[normalized] = nextCollapsed;
  view.classList.toggle("collapsed", nextCollapsed);
  slot.classList.toggle("collapsed", nextCollapsed);
  if (header) {
    header.title = nextCollapsed
      ? `Expand ${panelDisplayName(normalized)} panel`
      : `Collapse ${panelDisplayName(normalized)} panel`;
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
  }

  if (!nextCollapsed && sidebar.classList.contains("collapsed")) {
    setSidebarCollapsed(false);
  }
  if (persist) savePanelCollapsedState();
  applySidebarSplitSizes({ persistRatio: false });
}

function togglePanelCollapsed(panelType) {
  const normalized = normalizePanelType(panelType);
  setPanelCollapsed(normalized, !panelCollapsedState[normalized]);
}

function applySidebarSplitSizes({ persistRatio = false } = {}) {
  if (!sidebarTopSlot || !sidebarBottomSlot || !sidebarSplitHandle) return;

  const topCollapsed = Boolean(panelCollapsedState[sidebarSplitLayout.top]);
  const bottomCollapsed = Boolean(panelCollapsedState[sidebarSplitLayout.bottom]);

  sidebarSplitHandle.classList.toggle("hidden", topCollapsed || bottomCollapsed);

  if (topCollapsed && bottomCollapsed) {
    sidebarTopSlot.style.flex = "0 0 auto";
    sidebarBottomSlot.style.flex = "0 0 auto";
  } else if (topCollapsed) {
    sidebarTopSlot.style.flex = "0 0 auto";
    sidebarBottomSlot.style.flex = "1 1 auto";
  } else if (bottomCollapsed) {
    sidebarTopSlot.style.flex = "1 1 auto";
    sidebarBottomSlot.style.flex = "0 0 auto";
  } else {
    const ratioPercent = clampNumber(sidebarSplitRatio, 0.2, 0.8) * 100;
    sidebarTopSlot.style.flex = `0 0 ${ratioPercent}%`;
    sidebarBottomSlot.style.flex = "1 1 auto";
  }

  if (persistRatio) {
    saveSidebarSplitRatio();
  }
}

function applySidebarSplitLayout(layout = sidebarSplitLayout) {
  sidebarSplitLayout = normalizeSidebarSplitLayout(layout);

  const topPanel = sidebarSplitLayout.top === PANEL_TYPES.TOC ? tocView : varsView;
  const bottomPanel = sidebarSplitLayout.bottom === PANEL_TYPES.TOC ? tocView : varsView;
  if (sidebarTopSlot) sidebarTopSlot.appendChild(topPanel);
  if (sidebarBottomSlot) sidebarBottomSlot.appendChild(bottomPanel);

  saveSidebarSplitLayout();
  setPanelCollapsed(PANEL_TYPES.TOC, panelCollapsedState[PANEL_TYPES.TOC], { persist: false });
  setPanelCollapsed(PANEL_TYPES.VARS, panelCollapsedState[PANEL_TYPES.VARS], { persist: false });
  applySidebarSplitSizes({ persistRatio: false });
}

function movePanelToSlot(panelType, targetSlot) {
  const normalizedTarget = targetSlot === "bottom" ? "bottom" : "top";
  if (getPanelSlot(panelType) === normalizedTarget) return;

  const nextTop = normalizedTarget === "top" ? panelType : (panelType === PANEL_TYPES.TOC ? PANEL_TYPES.VARS : PANEL_TYPES.TOC);
  const nextBottom = normalizedTarget === "bottom" ? panelType : (panelType === PANEL_TYPES.TOC ? PANEL_TYPES.VARS : PANEL_TYPES.TOC);
  applySidebarSplitLayout({ top: nextTop, bottom: nextBottom });
  const { view } = getPanelElements(panelType);
  view?.scrollIntoView?.({ block: "nearest" });
  setStatus(`${panelDisplayName(panelType)} moved to ${normalizedTarget}`);
}

function applySidebarPosition(pos) {
  sidebarPosition = pos;
  scMain.classList.toggle("sidebar-left", pos === "left");
  try { localStorage.setItem(SIDEBAR_POS_KEY, pos); } catch {}
  // Re-layout editors after DOM reflow
  requestAnimationFrame(() => {
    cells.forEach((c) => { if (c.editor) c.editor.layout(); });
  });
}

function openSidebarCtxMenu(e) {
  e.preventDefault();
  closePanelSlotCtxMenu();
  // Position menu at cursor
  sidebarCtxMenu.style.left = `${e.clientX}px`;
  sidebarCtxMenu.style.top = `${e.clientY}px`;
  sidebarCtxMenu.classList.add("open");

  // Disable the option for current position
  ctxMoveLeft.classList.toggle("disabled", sidebarPosition === "left");
  ctxMoveRight.classList.toggle("disabled", sidebarPosition === "right");
}

function closeSidebarCtxMenu() {
  sidebarCtxMenu.classList.remove("open");
}

function openPanelSlotCtxMenu(panelType, e) {
  e.preventDefault();
  panelCtxTarget = panelType === PANEL_TYPES.VARS ? PANEL_TYPES.VARS : PANEL_TYPES.TOC;
  closeSidebarCtxMenu();

  panelSlotCtxMenu.style.left = `${e.clientX}px`;
  panelSlotCtxMenu.style.top = `${e.clientY}px`;
  panelSlotCtxMenu.classList.add("open");

  const currentSlot = getPanelSlot(panelCtxTarget);
  ctxMovePanelTop.classList.toggle("disabled", currentSlot === "top");
  ctxMovePanelBottom.classList.toggle("disabled", currentSlot === "bottom");
}

function closePanelSlotCtxMenu() {
  panelSlotCtxMenu.classList.remove("open");
  panelCtxTarget = null;
}

ctxMoveLeft.addEventListener("click", () => {
  if (sidebarPosition !== "left") applySidebarPosition("left");
  closeSidebarCtxMenu();
});

ctxMoveRight.addEventListener("click", () => {
  if (sidebarPosition !== "right") applySidebarPosition("right");
  closeSidebarCtxMenu();
});

ctxMovePanelTop.addEventListener("click", () => {
  if (!panelCtxTarget || ctxMovePanelTop.classList.contains("disabled")) return;
  movePanelToSlot(panelCtxTarget, "top");
  closePanelSlotCtxMenu();
});

ctxMovePanelBottom.addEventListener("click", () => {
  if (!panelCtxTarget || ctxMovePanelBottom.classList.contains("disabled")) return;
  movePanelToSlot(panelCtxTarget, "bottom");
  closePanelSlotCtxMenu();
});

// Close context menu on any click outside
document.addEventListener("mousedown", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) {
    closeSidebarCtxMenu();
    closePanelSlotCtxMenu();
    return;
  }
  if (!sidebarCtxMenu.contains(target)) closeSidebarCtxMenu();
  if (!panelSlotCtxMenu.contains(target)) closePanelSlotCtxMenu();
}, true);

// Right-click on panel headers for top/bottom move; elsewhere in sidebar for left/right move.
tocHeader?.addEventListener("contextmenu", (e) => openPanelSlotCtxMenu(PANEL_TYPES.TOC, e));
tocHeader?.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("button")) return;
  togglePanelCollapsed(PANEL_TYPES.TOC);
});
tocHeader?.addEventListener("keydown", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("button")) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  togglePanelCollapsed(PANEL_TYPES.TOC);
});
tocHeadingNumbersBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleTocHeadingNumbers();
});
varsHeader?.addEventListener("contextmenu", (e) => openPanelSlotCtxMenu(PANEL_TYPES.VARS, e));
varsHeader?.addEventListener("click", () => togglePanelCollapsed(PANEL_TYPES.VARS));
varsHeader?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  togglePanelCollapsed(PANEL_TYPES.VARS);
});
sidebar?.addEventListener("contextmenu", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".sc-toc-header")) return;
  if (target.closest(".sc-vars-header")) return;
  openSidebarCtxMenu(e);
});

// Apply saved layout on load
applySidebarPosition(sidebarPosition);
applySidebarSplitLayout(sidebarSplitLayout);
updateTocHeadingNumbersButton();


// ---------------------------------------------------------------------------
// Table of Contents
// ---------------------------------------------------------------------------

function buildToc() {
  const entries = [];
  cells.forEach((cell) => {
    if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
    const source = cell.editor ? cell.editor.getValue() : "";
    const lines = source.split("\n");
    let headingIndex = 0;
    for (const line of lines) {
      const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        entries.push({
          cellId: cell.id,
          headingIndex,
          level: match[1].length,
          text: match[2].replace(/[*_`\[\]]/g, "").trim(),
        });
        headingIndex += 1;
      }
    }
  });
  return entries;
}

function buildTocNumberLabels(entries, mode = tocHeadingNumberMode) {
  const normalizedMode = normalizeTocHeadingNumberMode(mode);
  const counters = [0, 0, 0, 0, 0, 0];
  const labels = [];
  if (!Array.isArray(entries)) return labels;
  if (normalizedMode === TOC_HEADING_NUMBER_MODES.NONE) return entries.map(() => "");
  const titleLevel = entries.length ? clampNumber(Number(entries[0]?.level || 1), 1, 6) : 1;

  entries.forEach((entry, idx) => {
    if (normalizedMode === TOC_HEADING_NUMBER_MODES.FROM_SECOND && idx === 0) {
      labels[idx] = "";
      return;
    }
    const rawLevel = clampNumber(Number(entry?.level || 1), 1, 6);
    const level = normalizedMode === TOC_HEADING_NUMBER_MODES.FROM_SECOND
      ? clampNumber(rawLevel - titleLevel, 1, 6)
      : rawLevel;
    const index = level - 1;
    counters[index] += 1;
    for (let i = index + 1; i < counters.length; i += 1) counters[i] = 0;
    const label = counters.slice(0, level).filter((value) => value > 0).join(".");
    labels[idx] = label;
  });
  return labels;
}

function getRenderedMarkdownHeadingNumberLabel(cellId, headingIndex) {
  const mode = normalizeTocHeadingNumberMode(tocHeadingNumberMode);
  if (mode === TOC_HEADING_NUMBER_MODES.NONE) return "";
  const normalizedCellId = Number(cellId);
  const normalizedHeadingIndex = Number(headingIndex);
  if (!Number.isFinite(normalizedCellId) || !Number.isFinite(normalizedHeadingIndex)) return "";
  const entries = buildToc();
  const numberLabels = buildTocNumberLabels(entries, mode);
  const index = entries.findIndex((entry) => (
    Number(entry.cellId) === normalizedCellId
    && Number(entry.headingIndex) === normalizedHeadingIndex
  ));
  return index >= 0 ? (numberLabels[index] || "") : "";
}

function getRunningTocTargetCellId(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const runningCell = cells.find((cell) => cell?.cellEl?.classList?.contains("running"));
  if (!runningCell) return null;

  const headingCellIds = new Set(entries.map((entry) => entry.cellId));
  if (headingCellIds.has(runningCell.id)) return runningCell.id;

  const runningIndex = cells.findIndex((cell) => cell.id === runningCell.id);
  if (runningIndex < 0) return null;

  let targetHeadingCellId = null;
  for (let idx = 0; idx <= runningIndex; idx += 1) {
    const cellId = cells[idx]?.id;
    if (headingCellIds.has(cellId)) targetHeadingCellId = cellId;
  }
  return targetHeadingCellId;
}

function renderToc() {
  const entries = buildToc();
  if (entries.length === 0) {
    tocBody.innerHTML = `<div class="sc-toc-empty">No headings yet.<br>Add markdown cells with # headers.</div>`;
    return;
  }

  tocBody.innerHTML = "";
  const runningTocCellId = getRunningTocTargetCellId(entries);
  const numberLabels = buildTocNumberLabels(entries);
  const collapsedAncestorStack = [];
  entries.forEach((entry, entryIndex) => {
    while (
      collapsedAncestorStack.length
      && entry.level <= collapsedAncestorStack[collapsedAncestorStack.length - 1]
    ) {
      collapsedAncestorStack.pop();
    }

    const hiddenByCollapsedAncestor = collapsedAncestorStack.length > 0;
    const cell = getCellById(entry.cellId);
    const section = getMarkdownSectionTargets(cell);
    const canCollapse = Boolean(
      cell
      && cell.markdownRendered
      && section.allTargets.length > 0
    );
    const isCollapsed = canCollapse && collapsedSectionControllers.has(entry.cellId);

    if (hiddenByCollapsedAncestor) {
      return;
    }

    const row = document.createElement("div");
    row.className = "sc-toc-row";
    row.dataset.level = entry.level;
    row.dataset.cellId = entry.cellId;
    row.classList.toggle("collapsed", isCollapsed);
    row.classList.toggle("running", entry.cellId === runningTocCellId);

    const foldBtn = document.createElement("button");
    foldBtn.className = "sc-toc-fold";
    foldBtn.type = "button";
    foldBtn.innerHTML = getSectionToggleIconSvg(isCollapsed);
    foldBtn.disabled = !canCollapse;
    foldBtn.setAttribute("aria-hidden", canCollapse ? "false" : "true");
    foldBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    foldBtn.title = canCollapse
      ? (isCollapsed ? "Expand section" : "Collapse section")
      : "No collapsible section";
    foldBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMarkdownSectionCollapse(entry.cellId);
    });

    const btn = document.createElement("button");
    btn.className = "sc-toc-item";
    btn.dataset.cellId = entry.cellId;
    btn.textContent = entry.text;
    btn.title = entry.text;
    btn.addEventListener("click", () => {
      scrollToCell(entry.cellId);
    });

    row.appendChild(foldBtn);
    if (tocHeadingNumberMode !== TOC_HEADING_NUMBER_MODES.NONE && numberLabels[entryIndex]) {
      const numberEl = document.createElement("span");
      numberEl.className = "sc-toc-number";
      numberEl.textContent = `${numberLabels[entryIndex] || ""}.`;
      row.appendChild(numberEl);
    }
    row.appendChild(btn);
    const runningSpinner = document.createElement("span");
    runningSpinner.className = "sc-toc-running-spinner";
    runningSpinner.setAttribute("aria-hidden", "true");
    row.appendChild(runningSpinner);
    tocBody.appendChild(row);

    if (isCollapsed) {
      collapsedAncestorStack.push(entry.level);
    }
  });
}

function scrollToCell(cellId) {
  const cell = getCellById(cellId);
  if (!cell) return;
  scrollCellsAreaToCell(cell.cellEl, { behavior: "smooth", block: "center" });
  focusCell(cellId);
}

function scrollCellsAreaToCell(cellEl, options = {}) {
  if (!cellsArea || !cellEl) return;

  const areaRect = cellsArea.getBoundingClientRect();
  const cellRect = cellEl.getBoundingClientRect();
  const block = options.block || "nearest";
  let targetTop = cellsArea.scrollTop + cellRect.top - areaRect.top;

  if (block === "center") {
    targetTop -= Math.max(0, (cellsArea.clientHeight - cellRect.height) / 2);
  } else if (block === "end") {
    targetTop -= Math.max(0, cellsArea.clientHeight - cellRect.height);
  } else if (block === "nearest") {
    const currentTop = cellsArea.scrollTop;
    const currentBottom = currentTop + cellsArea.clientHeight;
    const cellTop = cellsArea.scrollTop + cellRect.top - areaRect.top;
    const cellBottom = cellTop + cellRect.height;
    if (cellTop >= currentTop && cellBottom <= currentBottom) return;
    targetTop = cellTop < currentTop
      ? cellTop
      : cellBottom - cellsArea.clientHeight;
  }

  const maxTop = Math.max(0, cellsArea.scrollHeight - cellsArea.clientHeight);
  cellsArea.scrollTo({
    top: clampNumber(targetTop, 0, maxTop),
    behavior: options.behavior || "auto",
  });
}

function refreshToc() {
  refreshSectionCollapses({ animate: false });
  renderToc();
  if (!syncingRenderedMarkdownHeadings && typeof refreshRenderedMarkdownCells === "function") {
    syncingRenderedMarkdownHeadings = true;
    try {
      refreshRenderedMarkdownCells({ refresh: false });
    } finally {
      syncingRenderedMarkdownHeadings = false;
    }
  }
}


// ---------------------------------------------------------------------------
// Running state UI
// ---------------------------------------------------------------------------

function setRunningUI(running) {
  runAllBtn.style.display = running ? "none" : "";
  stopBtn.style.display = running ? "" : "none";
}

async function interruptExecution() {
  try {
    await scriptingFetch("/scripting/interrupt", { method: "POST" });
    setStatus("Interrupt sent");
  } catch {
    setStatus("Interrupt failed");
  }
}


// ---------------------------------------------------------------------------
// Variable deletion
// ---------------------------------------------------------------------------

async function deleteVariable(name) {
  try {
    const resp = await scriptingFetch("/scripting/del-variable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await resp.json();
    if (result.success) {
      setStatus(`Deleted '${name}'`);
    } else {
      setStatus(result.message || "Delete failed");
    }
    refreshVariables();
  } catch {
    setStatus("Delete failed");
  }
}


