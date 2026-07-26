function resetArcodeConsoleZoom() {
  if (!/^\/ui\/arcode\/notebook-editor(?:\/|$)/i.test(window.location.pathname || "")) return;
  try {
    localStorage.setItem("arcode_ui_zoom_pct", "100");
    localStorage.setItem("arcode_zoom_mode", "css");
    localStorage.setItem("arcode_statusbar_h", "28");
  } catch {
    // Zoom preferences are best-effort only.
  }
  const root = document.documentElement;
  const body = document.body;
  if (root) {
    root.style.zoom = "1";
    root.style.setProperty("--ui-zoom", "1");
    root.style.setProperty("--app-safe-bottom", "28px");
  }
  if (body) body.style.zoom = "";
  window.ArcodeZoomBridge?.applyPageZoomValue?.(100, 28);
}

resetArcodeConsoleZoom();
window.ArcodeZoomBridge?.wirePageZoomBridge();
resetArcodeConsoleZoom();
// ---------------------------------------------------------------------------
// Resize handle (panels)
// ---------------------------------------------------------------------------

let resizing = false;

resizeHandle.addEventListener("pointerdown", (e) => {
  resizing = true;
  resizeHandle.classList.add("active");
  resizeHandle.setPointerCapture(e.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
});

resizeHandle.addEventListener("pointermove", (e) => {
  if (!resizing) return;
  const rect = scMain.getBoundingClientRect();
  const panelWidth = sidebarPosition === "left"
    ? Math.max(0, e.clientX - rect.left)
    : Math.max(0, rect.right - e.clientX);
  if (panelWidth < 60) {
    setSidebarCollapsed(true);
  } else {
    setSidebarCollapsed(false);
    const contentWidth = Math.min(500, Math.max(210, panelWidth));
    sidebarContent.style.width = `${contentWidth}px`;
  }
  cells.forEach((c) => { if (c.editor) c.editor.layout(); });
});

resizeHandle.addEventListener("pointerup", (e) => {
  resizing = false;
  resizeHandle.classList.remove("active");
  resizeHandle.releasePointerCapture(e.pointerId);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

resizeHandle.addEventListener("dblclick", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (sidebar.classList.contains("collapsed") && !sidebarContent.style.width) {
    sidebarContent.style.width = "290px";
  }
  toggleSidebarCollapsed();
});

let resizingSidebarSplit = false;

sidebarSplitHandle?.addEventListener("pointerdown", (e) => {
  if (sidebarSplitHandle.classList.contains("hidden")) return;
  resizingSidebarSplit = true;
  sidebarSplitHandle.classList.add("active");
  sidebarContent?.classList.add("dragging-split");
  sidebarSplitHandle.setPointerCapture(e.pointerId);
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
});

sidebarSplitHandle?.addEventListener("pointermove", (e) => {
  if (!resizingSidebarSplit) return;
  if (!sidebarContent) return;

  const rect = sidebarContent.getBoundingClientRect();
  const handleHeight = Math.max(4, sidebarSplitHandle.getBoundingClientRect().height || 6);
  const total = rect.height - handleHeight;
  if (total <= SIDEBAR_PANEL_MIN_HEIGHT * 2) return;

  const minRatio = SIDEBAR_PANEL_MIN_HEIGHT / total;
  const maxRatio = 1 - minRatio;
  const rawRatio = (e.clientY - rect.top) / total;
  sidebarSplitRatio = clampNumber(rawRatio, minRatio, maxRatio);
  applySidebarSplitSizes({ persistRatio: false });
});

sidebarSplitHandle?.addEventListener("pointerup", (e) => {
  if (!resizingSidebarSplit) return;
  resizingSidebarSplit = false;
  sidebarSplitHandle.classList.remove("active");
  sidebarContent?.classList.remove("dragging-split");
  try { sidebarSplitHandle.releasePointerCapture(e.pointerId); } catch {}
  saveSidebarSplitRatio();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});
sidebarSplitHandle?.addEventListener("pointercancel", () => {
  resizingSidebarSplit = false;
  sidebarSplitHandle.classList.remove("active");
  sidebarContent?.classList.remove("dragging-split");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

const newCellTypeWrap = document.getElementById("newCellTypeWrap");
const newCellTypeBtn = document.getElementById("newCellTypeBtn");
const newCellTypeLabel = document.getElementById("newCellTypeLabel");
const newCellTypeMenu = document.getElementById("newCellTypeMenu");
const newCellTypeMenuItems = Array.from(document.querySelectorAll(".sc-type-menu-item"));

function syncCellTypeDropdownUI(cellType = newCellTypeSelect?.value) {
  const normalized = normalizeCellType(cellType);
  if (!newCellTypeSelect) return;
  if (newCellTypeSelect.value !== normalized) {
    newCellTypeSelect.value = normalized;
  }
  const optionText = newCellTypeSelect.selectedOptions?.[0]?.textContent || normalized;
  if (newCellTypeLabel) {
    newCellTypeLabel.textContent = optionText;
  }
  newCellTypeMenuItems.forEach((item) => {
    const selected = item.dataset.value === normalized;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function closeCellTypeDropdownMenu() {
  if (!newCellTypeWrap || !newCellTypeBtn) return;
  newCellTypeWrap.classList.remove("open");
  newCellTypeBtn.setAttribute("aria-expanded", "false");
}

function openCellTypeDropdownMenu() {
  if (!newCellTypeWrap || !newCellTypeBtn) return;
  newCellTypeWrap.classList.add("open");
  newCellTypeBtn.setAttribute("aria-expanded", "true");
}

function isCellTypeDropdownOpen() {
  return Boolean(newCellTypeWrap?.classList.contains("open"));
}

function wireCellTypeDropdown() {
  if (!newCellTypeWrap || !newCellTypeBtn || !newCellTypeMenu || !newCellTypeSelect) return;
  syncCellTypeDropdownUI(newCellTypeSelect.value);

  newCellTypeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isCellTypeDropdownOpen()) {
      closeCellTypeDropdownMenu();
    } else {
      openCellTypeDropdownMenu();
    }
  });

  newCellTypeBtn.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCellTypeDropdownMenu();
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openCellTypeDropdownMenu();
      return;
    }
  });

  newCellTypeMenuItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextType = normalizeCellType(item.dataset.value);
      if (newCellTypeSelect.value !== nextType) {
        newCellTypeSelect.value = nextType;
        newCellTypeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        syncCellTypeDropdownUI(nextType);
      }
      closeCellTypeDropdownMenu();
      newCellTypeBtn.focus();
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeCellTypeDropdownMenu();
      newCellTypeBtn.focus();
    });
  });

  newCellTypeMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCellTypeDropdownMenu();
      newCellTypeBtn.focus();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!isCellTypeDropdownOpen()) return;
    if (!(event.target instanceof Element)) {
      closeCellTypeDropdownMenu();
      return;
    }
    if (!newCellTypeWrap.contains(event.target)) {
      closeCellTypeDropdownMenu();
    }
  }, true);
}


// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

addCellBtn.addEventListener("click", () => {
  const cell = addCell("", cells[cells.length - 1]?.id ?? null);
  focusCellCommand(cell);
});

addCellBottom.addEventListener("click", () => {
  const cell = addCell("", cells[cells.length - 1]?.id ?? null);
  focusCellCommand(cell);
});

newCellTypeSelect?.addEventListener("change", () => {
  const targetCell = getCommandTargetCell();
  const nextType = normalizeCellType(newCellTypeSelect?.value);
  syncCellTypeDropdownUI(nextType);
  if (!targetCell) return;
  if (!setCellType(targetCell.id, nextType)) return;
  setStatus(`Cell type set to ${nextType}`);
});

cellsArea.addEventListener("dragover", (e) => {
  if (draggingCellId === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  updateDropPlaceholder(e.clientY);
}, true);

cellsArea.addEventListener("drop", (e) => {
  if (draggingCellId === null) return;
  e.preventDefault();
  e.stopPropagation();
  dropDraggedCell();
}, true);

wireShortcutInputs();
wireCellTypeDropdown();

runAllBtn.addEventListener("click", () => runAllCells());
stopBtn.addEventListener("click", () => interruptExecution());
restartBtn.addEventListener("click", () => restartSession());
clearOutputBtn.addEventListener("click", () => clearAllOutputs());
shortcutsBtn.addEventListener("click", () => openShortcutsDialog());

shortcutsCloseBtn.addEventListener("click", () => closeShortcutsDialog());
shortcutsCancelBtn.addEventListener("click", () => closeShortcutsDialog());
shortcutsSaveBtn.addEventListener("click", () => saveShortcutsFromDialog());
shortcutsResetBtn.addEventListener("click", () => resetShortcutDraftToDefaults());

shortcutsOverlay.addEventListener("mousedown", (event) => {
  if (event.target === shortcutsOverlay) closeShortcutsDialog();
});

document.addEventListener("mousedown", (event) => {
  if (editingCellId === null) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".sc-cell-editor")) return;
  exitCellEditMode();
}, true);

document.addEventListener("keydown", (event) => {
  if (shortcutsDialogOpen) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeShortcutsDialog();
    return;
  }

  if (isCellTypeDropdownOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCellTypeDropdownMenu();
      newCellTypeBtn?.focus();
    }
    return;
  }

  const key = String(event.key || "").toLowerCase();
  const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && key === "s";
  if (isSaveShortcut) {
    event.preventDefault();
    event.stopPropagation();
    window.parent?.postMessage(
      { type: "arcode:hotkey", action: event.shiftKey ? "file_save_as" : "file_save" },
      "*",
    );
    return;
  }

  if (event.key === "Escape" && editingCellId !== null) {
    // If introspection tooltip is open, dismiss it first without exiting edit mode
    if (typeof _activeInspectEl !== "undefined" && _activeInspectEl) {
      event.preventDefault();
      event.stopPropagation();
      dismissIntrospectionTooltip();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const editingCell = getCellById(editingCellId);
    if (editingCell && normalizeCellType(editingCell.type) === CELL_TYPES.MARKDOWN) {
      runMarkdownCell(editingCell, { silent: true });
    }
    exitCellEditMode();
    return;
  }

  if (!handleGlobalShortcutKeydown(event)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener("message", (event) => {
  const type = event?.data?.type;
  if (type === "arcode:scripting-save") {
    void requestNotebookSave(false);
    return;
  }
  if (type === "arcode:scripting-save-as") {
    void requestNotebookSave(true);
    return;
  }
  if (type === "arcode:scripting-open") {
    void openOpenNbDialog();
    return;
  }
  if (type === "arcode:scripting-open-path") {
    void openNotebookFilePath(event.data?.path || "");
    return;
  }
  if (type === "arcode:scripting-rename-notebook") {
    void renameCurrentNotebook();
    return;
  }
  if (type === "arcode:scripting-toggle-line-numbers") {
    toggleCodeCellLineNumbers();
    return;
  }
  if (type === "arcode:scripting-toggle-exec-time") {
    toggleExecTimeVisible();
    return;
  }
  if (type === "arcode:scripting-render-all-markdown") {
    renderAllMarkdownCells({ setStatusMessage: true });
    return;
  }
  if (type === "arcode:assistant-context-request") {
    const requestId = event.data.requestId || "";
    try {
      window.parent?.postMessage({
        type: "arcode:assistant-context-result",
        requestId,
        context: buildScriptingAssistantContext(),
      }, "*");
    } catch {}
    return;
  }
  if (type === "arcode:assistant-json-updated") {
    const updatedPath = String(event.data.path || "").trim();
    if (!updatedPath || updatedPath === currentNotebookPath) {
      void checkNotebookDiskForChanges({ force: true });
    }
  }
});

// Notebook dialogs
document.getElementById("saveNbClose").addEventListener("click", closeSaveNbDialog);
document.getElementById("saveNbCancel").addEventListener("click", closeSaveNbDialog);
document.getElementById("saveNbConfirm").addEventListener("click", confirmSaveNb);
document.getElementById("openNbClose").addEventListener("click", closeOpenNbDialog);
document.getElementById("openNbCancel").addEventListener("click", closeOpenNbDialog);
reloadDiskNotebookBtn?.addEventListener("click", () => {
  void reloadCurrentNotebookFromDisk();
});
saveNotebookCopyBtn?.addEventListener("click", () => {
  openSaveNbDialog(getNotebookCopyFilename(currentNotebookPath || currentNotebookFilename));
});
overwriteDiskNotebookBtn?.addEventListener("click", () => {
  void saveCurrentNotebookFile({ closeDialog: false, ignoreRevisionConflict: true });
});
document.getElementById("saveNbOverlay").addEventListener("mousedown", (e) => {
  if (e.target === document.getElementById("saveNbOverlay")) closeSaveNbDialog();
});
document.getElementById("openNbOverlay").addEventListener("mousedown", (e) => {
  if (e.target === document.getElementById("openNbOverlay")) closeOpenNbDialog();
});
document.getElementById("saveNbName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); confirmSaveNb(); }
  if (e.key === "Escape") closeSaveNbDialog();
});

// Initial variable load
refreshVariables();


