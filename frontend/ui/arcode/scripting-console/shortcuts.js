// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function formatShortcut(ctrl, shift, alt, key) {
  const parts = [];
  if (ctrl) parts.push("Ctrl");
  if (shift) parts.push("Shift");
  if (alt) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

function normalizeShortcutKey(rawKey) {
  if (typeof rawKey !== "string") return "";
  if (rawKey === " ") return "Space";
  const trimmed = rawKey.trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();
  const aliases = {
    " ": "Space",
    space: "Space",
    spacebar: "Space",
    return: "Enter",
    esc: "Escape",
    del: "Delete",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    cmd: "Meta",
    command: "Meta",
    ctrl: "Control",
    control: "Control",
    option: "Alt",
  };
  if (aliases[lower]) return aliases[lower];
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) {
    if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
    if (/^[0-9]$/.test(trimmed)) return trimmed;
  }
  if (trimmed.startsWith("Arrow")) {
    return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
  }
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

function normalizeShortcutKeyFromCode(rawCode) {
  if (typeof rawCode !== "string") return "";
  const code = rawCode.trim();
  if (!code) return "";

  if (code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/i.test(code)) return code.toUpperCase();

  const codeMap = {
    Enter: "Enter",
    NumpadEnter: "Enter",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Tab: "Tab",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };
  return codeMap[code] || "";
}

function isInvalidShortcutKey(key) {
  return !key || MODIFIER_KEY_NAMES.has(key) || key === "Dead" || key === "Unidentified" || key === "Process";
}

function normalizeShortcutString(rawValue) {
  if (typeof rawValue !== "string") return "";
  const parts = rawValue.split("+").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";

  let ctrl = false;
  let shift = false;
  let alt = false;
  let key = "";

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "command" || lower === "meta" || lower === "ctrlcmd") {
      ctrl = true;
      continue;
    }
    if (lower === "shift") {
      shift = true;
      continue;
    }
    if (lower === "alt" || lower === "option") {
      alt = true;
      continue;
    }
    if (key) return "";
    key = normalizeShortcutKey(part);
  }

  if (isInvalidShortcutKey(key)) return "";
  return formatShortcut(ctrl, shift, alt, key);
}

function getShortcutFromKeyboardEvent(event) {
  if (!event) return "";
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  if (event.isComposing && !ctrl) return "";
  let key = normalizeShortcutKey(event.key || "");
  if (isInvalidShortcutKey(key)) {
    key = normalizeShortcutKeyFromCode(event.code || "");
  }
  if (isInvalidShortcutKey(key)) return "";
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  return formatShortcut(ctrl, shift, alt, key);
}

function validateShortcutBindings(candidate) {
  const normalized = {};
  const seen = new Map();

  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = normalizeShortcutString(candidate?.[action.id] || "");
    if (!shortcut) {
      return { ok: false, error: `Shortcut required for "${action.label}".` };
    }
    if (seen.has(shortcut)) {
      return {
        ok: false,
        error: `"${shortcut}" is assigned to both "${seen.get(shortcut)}" and "${action.label}".`,
      };
    }
    seen.set(shortcut, action.label);
    normalized[action.id] = shortcut;
  }

  return { ok: true, bindings: normalized };
}

function loadShortcutBindings() {
  const defaults = { ...SHORTCUT_DEFAULTS };
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    const merged = { ...defaults, ...parsed };
    const validated = validateShortcutBindings(merged);
    return validated.ok ? validated.bindings : defaults;
  } catch {
    return defaults;
  }
}

function getHostShortcutStorageApi() {
  const frames = [window];
  try {
    if (window.parent && window.parent !== window) frames.push(window.parent);
  } catch {}
  try {
    if (window.top && window.top !== window && window.top !== window.parent) frames.push(window.top);
  } catch {}

  for (const frame of frames) {
    try {
      const host = frame?.ADAHost;
      if (
        host &&
        typeof host.loadScriptingShortcuts === "function" &&
        typeof host.saveScriptingShortcuts === "function"
      ) {
        return host;
      }
    } catch {
      // ignore inaccessible cross-frame context
    }
  }
  return null;
}

function hasHostShortcutStorage() {
  return Boolean(getHostShortcutStorageApi());
}

function persistShortcutBindings(options = {}) {
  const skipHost = options.skipHost === true;
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcutBindings));
  } catch {}
  if (skipHost) return;
  const host = getHostShortcutStorageApi();
  if (!host) return;
  Promise.resolve(host.saveScriptingShortcuts({ ...shortcutBindings }))
    .then((result) => {
      if (result && result.ok === false) {
        setStatus("Failed to save shortcuts to APPDATA");
      }
    })
    .catch(() => {
      setStatus("Failed to save shortcuts to APPDATA");
    });
}

async function loadShortcutBindingsFromHost() {
  const host = getHostShortcutStorageApi();
  if (!host) return;
  try {
    const response = await host.loadScriptingShortcuts();
    if (!response || response.exists !== true) {
      // Bootstrap APPDATA file when missing by persisting current bindings.
      persistShortcutBindings();
      return;
    }
    const bindings = response?.bindings;
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return;
    const merged = { ...SHORTCUT_DEFAULTS, ...bindings };
    const validated = validateShortcutBindings(merged);
    if (!validated.ok) return;
    shortcutBindings = validated.bindings;
    persistShortcutBindings({ skipHost: true });
    refreshRunButtonTitles();
    if (shortcutsDialogOpen) {
      writeShortcutInputs(shortcutBindings);
      setShortcutsError("");
    }
  } catch {
    // ignore host storage read failures
  }
}

function getRunButtonTitle() {
  return `Run cell (${shortcutBindings.runCellPrimary} / ${shortcutBindings.runCellAlternate})`;
}

function refreshRunButtonTitles() {
  cells.forEach((cell) => {
    if (!cell.runBtn) return;
    const runnable = isRunnableCellType(cell.type);
    cell.runBtn.disabled = !runnable;
    cell.runBtn.title = getCellRunButtonTitle(cell.type);
  });
}

function setShortcutsError(text) {
  if (!shortcutsError) return;
  shortcutsError.textContent = text || "";
}

function readShortcutDraftFromInputs() {
  const draft = {};
  shortcutInputs.forEach((input) => {
    const id = input.dataset.shortcutId;
    if (id) draft[id] = input.value.trim();
  });
  return draft;
}

function writeShortcutInputs(bindings) {
  shortcutInputs.forEach((input) => {
    const id = input.dataset.shortcutId;
    input.value = id ? (bindings[id] || "") : "";
  });
}

function openShortcutsDialog() {
  if (!shortcutsOverlay) return;
  shortcutFocusRestoreEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  shortcutsDialogOpen = true;
  shortcutsOverlay.classList.add("open");
  shortcutsOverlay.setAttribute("aria-hidden", "false");
  writeShortcutInputs(shortcutBindings);
  setShortcutsError("");
  shortcutInputs[0]?.focus();
}

function closeShortcutsDialog(restoreFocus = true) {
  if (!shortcutsOverlay) return;
  shortcutsDialogOpen = false;
  shortcutsOverlay.classList.remove("open");
  shortcutsOverlay.setAttribute("aria-hidden", "true");
  setShortcutsError("");
  if (restoreFocus) {
    if (shortcutFocusRestoreEl && typeof shortcutFocusRestoreEl.focus === "function") {
      shortcutFocusRestoreEl.focus();
    } else if (shortcutsBtn) {
      shortcutsBtn.focus();
    }
  }
}

function saveShortcutsFromDialog() {
  const candidate = readShortcutDraftFromInputs();
  const validated = validateShortcutBindings(candidate);
  if (!validated.ok) {
    setShortcutsError(validated.error);
    return;
  }
  shortcutBindings = validated.bindings;
  resetPendingDeleteTap();
  persistShortcutBindings();
  refreshRunButtonTitles();
  closeShortcutsDialog();
  setStatus("Shortcuts updated");
}

function resetShortcutDraftToDefaults() {
  writeShortcutInputs(SHORTCUT_DEFAULTS);
  setShortcutsError("");
}

function handleEditorShortcutKeydown(event, cellId) {
  const browserEvent = event?.browserEvent;
  const pressed = getShortcutFromKeyboardEvent(browserEvent);
  if (!pressed) return false;
  if (pressed === shortcutBindings.toggleLineNumbers) {
    return toggleCodeCellLineNumbers();
  }

  const cell = getCellById(cellId);
  if (!cell || !isRunnableCellType(cell.type)) return false;

  return tryRunShortcutOnCell(pressed, cell);
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  const monacoHost = target.closest(".monaco-editor");
  if (monacoHost) {
    if (editingCellId === null) return false;
    const editingCell = getCellById(editingCellId);
    return Boolean(editingCell && editingCell.editorEl.contains(monacoHost));
  }
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  return false;
}

function isTypingContext(event) {
  if (isTypingTarget(event?.target)) return true;
  const activeEl = document.activeElement;
  if (isTypingTarget(activeEl)) return true;
  return false;
}

function isRunShortcut(pressed) {
  return (
    pressed === shortcutBindings.runCellAdvance ||
    pressed === shortcutBindings.runCellPrimary ||
    pressed === shortcutBindings.runCellAlternate
  );
}

function getCodeCellLineNumbersMode() {
  return codeCellLineNumbersVisible ? "on" : "off";
}

function applyCodeCellLineNumbers(cell) {
  if (!cell || !cell.editor) return;
  if (normalizeCellType(cell.type) !== CELL_TYPES.CODE) return;
  cell.editor.updateOptions({ lineNumbers: getCodeCellLineNumbersMode() });
}

function toggleCodeCellLineNumbers() {
  codeCellLineNumbersVisible = !codeCellLineNumbersVisible;
  cells.forEach((cell) => applyCodeCellLineNumbers(cell));
  const msg = codeCellLineNumbersVisible ? "Code cell line numbers shown" : "Code cell line numbers hidden";
  setStatus(msg);
  postShellStatus(msg);
  saveScriptingPreference("lineNumbers", codeCellLineNumbersVisible);
  return true;
}

function toggleExecTimeVisible() {
  execTimeVisible = !execTimeVisible;
  cellsArea.classList.toggle("hide-exec-time", !execTimeVisible);
  const msg = execTimeVisible ? "Execution time shown" : "Execution time hidden";
  setStatus(msg);
  postShellStatus(msg);
  saveScriptingPreference("execTime", execTimeVisible);
  return true;
}

function loadScriptingPreferences() {
  scriptingFetch("/scripting/preferences")
    .then((r) => r.json())
    .then((prefs) => {
      if (prefs && typeof prefs.lineNumbers === "boolean") {
        codeCellLineNumbersVisible = prefs.lineNumbers;
        cells.forEach((cell) => applyCodeCellLineNumbers(cell));
      }
      if (prefs && typeof prefs.execTime === "boolean") {
        execTimeVisible = prefs.execTime;
        cellsArea.classList.toggle("hide-exec-time", !execTimeVisible);
      }
    })
    .catch(() => {});
}

function saveScriptingPreference(key, value) {
  scriptingFetch("/scripting/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}

function tryRunShortcutOnCell(pressed, cell) {
  if (!cell || !isRunnableCellType(cell.type)) return false;
  if (pressed === shortcutBindings.runCellAdvance) {
    runCellAndAdvance(cell.id);
    return true;
  }
  if (pressed === shortcutBindings.runCellPrimary || pressed === shortcutBindings.runCellAlternate) {
    runCell(cell.id);
    return true;
  }
  return false;
}

function getEditingShortcutCell(event) {
  if (editingCellId === null) return null;
  const editingCell = getCellById(editingCellId);
  if (!editingCell || !editingCell.editorEl) return null;
  const eventTarget = event?.target instanceof Element ? event.target : null;
  const activeEl = document.activeElement instanceof Element ? document.activeElement : null;
  const target = eventTarget || activeEl;
  if (!target) return null;
  const monacoHost = target.closest(".monaco-editor");
  if (!monacoHost) return null;
  if (!editingCell.editorEl.contains(monacoHost)) return null;
  return editingCell;
}

function getCommandTargetCell() {
  const focused = cells.find((c) => c.id === focusedCellId);
  if (focused) return focused;
  return cells[0] || null;
}

function resetPendingDeleteTap() {
  pendingDeleteTapKey = "";
  pendingDeleteTapAt = 0;
}

function cutFocusedCell() {
  const cell = getCommandTargetCell();
  if (!cell) return false;
  if (cells.length <= 1) {
    setStatus("Cannot cut the only cell");
    return true;
  }

  cellClipboard = {
    type: cell.type,
    code: cell.editor ? cell.editor.getValue() : "",
    executionCount: cell.executionCount ?? null,
    mode: "cut",
  };
  deleteCell(cell.id);
  setStatus("Cell cut (ready to paste)");
  return true;
}

function copyFocusedCell() {
  const cell = getCommandTargetCell();
  if (!cell) return false;

  cellClipboard = {
    type: cell.type,
    code: cell.editor ? cell.editor.getValue() : "",
    executionCount: cell.executionCount ?? null,
    mode: "copy",
  };
  setStatus("Cell copied");
  return true;
}

function pasteCellAfterFocused() {
  if (!cellClipboard) {
    setStatus("Nothing to paste");
    return true;
  }

  const targetCell = getCommandTargetCell();
  const newCell = targetCell
    ? addCell(cellClipboard.code || "", targetCell.id, "after", cellClipboard.type)
    : addCell(cellClipboard.code || "", null, "after", cellClipboard.type);
  focusCellCommand(newCell);
  if (cellClipboard.mode === "cut") {
    cellClipboard = null;
    setStatus("Cell pasted");
  } else {
    setStatus("Cell pasted (copied)");
  }
  return true;
}

function deleteFocusedCellWithGuard() {
  const cell = getCommandTargetCell();
  if (!cell) return false;
  if (cells.length <= 1) {
    setStatus("Cannot delete the only cell");
    return true;
  }

  deleteCell(cell.id);
  setStatus("Cell deleted");
  return true;
}

function clearFocusedCellOutput() {
  const cell = getCommandTargetCell();
  if (!cell) return false;
  if (!clearCellOutput(cell)) return false;
  setStatus("Cell output cleared");
  return true;
}

function tryHandleDeleteCellDoubleTap(pressedShortcut) {
  if (pressedShortcut !== shortcutBindings.deleteCellDoubleTap) {
    resetPendingDeleteTap();
    return false;
  }

  const now = Date.now();
  if (
    pendingDeleteTapKey === pressedShortcut &&
    now - pendingDeleteTapAt <= DELETE_CELL_DOUBLE_TAP_MS
  ) {
    resetPendingDeleteTap();
    return deleteFocusedCellWithGuard();
  }

  pendingDeleteTapKey = pressedShortcut;
  pendingDeleteTapAt = now;
  setStatus(`Press ${pressedShortcut} again to delete cell`);
  return true;
}

function handleGlobalShortcutKeydown(event) {
  if (!event || event.repeat) return false;
  const pressed = getShortcutFromKeyboardEvent(event);
  if (!pressed) return false;
  const typingContext = isTypingContext(event);
  if (typingContext) {
    resetPendingDeleteTap();
    if (pressed === shortcutBindings.toggleLineNumbers) {
      return toggleCodeCellLineNumbers();
    }
    if (!isRunShortcut(pressed)) return false;
    const editingCell = getEditingShortcutCell(event);
    if (!editingCell) return false;
    return tryRunShortcutOnCell(pressed, editingCell);
  }

  if (pressed === shortcutBindings.toggleLineNumbers) {
    resetPendingDeleteTap();
    return toggleCodeCellLineNumbers();
  }
  if (pressed === shortcutBindings.clearCellOutput) {
    resetPendingDeleteTap();
    return clearFocusedCellOutput();
  }

  const targetCell = getCommandTargetCell();
  if (
    pressed === shortcutBindings.runCellAlternate
    && runSelectedCellsSequentially(targetCell ? targetCell.id : null)
  ) {
    resetPendingDeleteTap();
    return true;
  }
  if (tryRunShortcutOnCell(pressed, targetCell)) {
    resetPendingDeleteTap();
    return true;
  }

  if (pressed === shortcutBindings.undoNotebook) {
    resetPendingDeleteTap();
    return undoNotebookChange();
  }
  if (pressed === shortcutBindings.redoNotebook) {
    resetPendingDeleteTap();
    return redoNotebookChange();
  }
  if (pressed === shortcutBindings.addCellBefore) {
    resetPendingDeleteTap();
    addCellAdjacentToFocused("before", CELL_TYPES.CODE);
    return true;
  }
  if (pressed === shortcutBindings.addCellAfter) {
    resetPendingDeleteTap();
    addCellAdjacentToFocused("after", CELL_TYPES.CODE);
    return true;
  }
  if (pressed === shortcutBindings.copyCell) {
    resetPendingDeleteTap();
    return copyFocusedCell();
  }
  if (pressed === shortcutBindings.pasteCellAfter) {
    resetPendingDeleteTap();
    return pasteCellAfterFocused();
  }
  if (pressed === shortcutBindings.cutCell) {
    resetPendingDeleteTap();
    return cutFocusedCell();
  }
  if (tryHandleDeleteCellDoubleTap(pressed)) {
    return true;
  }

  return false;
}

function wireShortcutInputs() {
  shortcutInputs.forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Tab") return;

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        input.blur();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        input.value = "";
        setShortcutsError("");
        return;
      }

      const shortcut = getShortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      input.value = shortcut;
      setShortcutsError("");
    });
  });
}

shortcutBindings = loadShortcutBindings();
loadShortcutBindingsFromHost();


