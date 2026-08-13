import {
  createSpreadsheetTableController,
  getTopLeftRangeCell,
  normalizeRange,
} from "/ui/shared/components/spreadsheet/spreadsheet_table.js?v=20260715a";
import {
  getDatasetGridSelectionLayout,
  getDisplayDatasetModel,
  setDatasetGridEditConfig,
} from "/ui/shared/tabs/data/dataset_grid_view.js?v=20260811j";
import { parseExcelReference } from "/ui/shared/integrations/excel_reference.js?v=20260715a";
import { createFormulaHoverEditor } from "/ui/shared/components/formula_hover/formula_hover.js?v=20260812b";

export function wireDatasetGridInteractions(deps) {
  const {
    state,
    renderTable,
    isReadOnly = () => false,
    setStatus = () => {},
    notifyDatasetUpdated = () => {},
    refreshDatasetSettingsDirty = () => {},
    commitExternalReference = async () => ({ handled: false, ok: false }),
    cancelExternalReference = () => {},
    hardCodeExternalLinkCells = () => 0,
    decorateExternalLinkCell = () => {},
    getExternalLinkCellInfo = () => null,
  } = deps;

  const formulaHover = createFormulaHoverEditor({
    onCommit: commitHoveredExternalFormula,
    onDismiss: () => document.getElementById("keySink")?.focus?.({ preventScroll: true }),
    onEditStart: cancelExternalReference,
    onStatus: setStatus,
  });

  const spreadsheetTable = createSpreadsheetTableController({
    getRoot: () => document.getElementById("tableWrap"),
    getBounds: () => {
      const { maxRow, maxCol } = getDatasetGridSelectionLayout();
      return { maxRow, maxCol };
    },
    readSelection: () => ({
      ranges: state.selRanges || [],
      activeCell: state.activeCell,
      anchorCell: state.selectionAnchor,
    }),
    writeSelection: ({ ranges, activeCell, anchorCell }) => {
      state.selRanges = ranges;
      state.activeCell = activeCell;
      state.selectionAnchor = anchorCell;
    },
    cellSelector: "td[data-r][data-c]",
    rowHeaderSelector: "th.rowhdr[data-r]",
    columnHeaderSelector: "th.colhdr[data-c]",
    selectedClasses: ["sel"],
    activeClasses: ["active"],
    anchorClasses: ["selectionAnchor", "arSpreadsheetSelectionAnchor"],
    rowSelectedLabelClasses: ["activeRow", "arSpreadsheetSelectedLabel"],
    columnSelectedLabelClasses: ["activeCol", "arSpreadsheetSelectedLabel"],
    getCellValue: ({ r, c }, cell) => (
      cell?.dataset?.copyValue ?? getDisplayDatasetModel()?.values?.[r]?.[c] ?? ""
    ),
    lineSeparator: "\n",
    scrollCellIntoView: scrollDatasetCellIntoView,
  });

  setDatasetGridEditConfig({
    isEditableCell: (displayR, displayC) => !!canEditDisplayCell(displayR, displayC, { silent: true }),
    isEditingCell: (displayR, displayC) => state.editingCell?.r === displayR && state.editingCell?.c === displayC,
    onCellFocus: (displayR, displayC) => {
      formulaHover.hide?.();
      cancelExternalReference();
      state.activeCell = { r: displayR, c: displayC };
      applySelectionFromState();
    },
    onCellInput: (displayR, displayC, rawValue, input, td) => {
      if (isExternalReferenceDraft(rawValue)) {
        if (state.editingCell) state.editingCell.pendingExternalReference = String(rawValue || "");
        return;
      }
      if (state.editingCell) delete state.editingCell.pendingExternalReference;
      const nextValue = setDisplayCellValue(displayR, displayC, rawValue, { silentInvalid: true });
      syncInputCellDisplay(td, input, nextValue);
    },
    onCellPaste: (displayR, displayC, event) => {
      const data = event.clipboardData?.getData("text/plain") || "";
      if (!data.includes("\t") && !data.includes("\n") && !data.includes("\r")) return;
      event.preventDefault();
      applyPastedGridText(data, { r: displayR, c: displayC });
    },
    onCellCommit: async (displayR, displayC, rawValue, input, td) => {
      const edit = state.editingCell;
      if (edit?.r !== displayR || edit?.c !== displayC || edit.commitPending) return;
      if (isExternalReferenceDraft(rawValue)) {
        edit.commitPending = true;
        input.readOnly = true;
        input.setAttribute("aria-busy", "true");
        setStatus("Loading linked values from Excel...");
        const result = await commitExternalReference({
          displayRow: displayR,
          displayColumn: displayC,
          reference: rawValue,
        });
        if (state.editingCell !== edit) return;
        edit.commitPending = false;
        input.readOnly = false;
        input.removeAttribute("aria-busy");
        if (!result?.ok) {
          if (!result?.aborted && !result?.stale) {
            setStatus(result?.error || "The Excel link could not be loaded.");
            requestAnimationFrame(() => input.isConnected && input.focus({ preventScroll: true }));
          }
          return;
        }
        state.editingCell = null;
        renderTable();
        notifyDatasetUpdated();
        applySelectionFromState();
        setStatus(`Linked ${result.affectedCellCount} dataset cell${result.affectedCellCount === 1 ? "" : "s"} to Excel.`);
        return;
      }
      const nextValue = setDisplayCellValue(displayR, displayC, rawValue, { hardCodeLinks: true });
      syncInputCellDisplay(td, input, nextValue);
      state.editingCell = null;
      renderTable();
      notifyDatasetUpdated();
      applySelectionFromState();
    },
    onCellKeyDown: (displayR, displayC, event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget?.blur?.();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelCellEdit(displayR, displayC);
    },
    onCellContextMenu: (displayR, displayC) => prepareContextSelection(displayR, displayC),
    canPasteSelection: () => hasEditableSelectionTarget(),
    onContextAction: (action) => handleGridContextAction(action),
    onTableRendered: () => {
      formulaHover.hide?.();
      applySelectionFromState();
    },
    decorateCell: (cell, displayR, displayC) => {
      decorateExternalLinkCell(cell, displayR, displayC);
      const info = getExternalLinkCellInfo(displayR, displayC);
      if (!info?.reference) return;
      formulaHover.attach(cell, {
        ...info,
        formula: info.reference,
        readOnly: isReadOnly(),
      }, {
        resolveAnchor: () => resolveExternalFormulaAnchor(info, cell),
        positionRect: () => resolveExternalFormulaRangeRect(info, cell),
      });
    },
  });
  wireArrowKeyNavigation();
  wireRectSelectionAndCopy();

  function sameExternalFormulaRange(left, right) {
    return !!(
      left?.reference
      && right?.reference === left.reference
      && right.anchorDisplayRow === left.anchorDisplayRow
      && right.anchorDisplayColumn === left.anchorDisplayColumn
    );
  }

  function externalFormulaRangeCells(info) {
    return Array.from(document.querySelectorAll?.("#tableWrap td[data-r][data-c]") || []).filter((cell) => {
      const row = Number(cell.dataset?.r);
      const column = Number(cell.dataset?.c);
      return Number.isInteger(row)
        && Number.isInteger(column)
        && sameExternalFormulaRange(info, getExternalLinkCellInfo(row, column));
    });
  }

  function resolveExternalFormulaAnchor(info, fallbackCell = null) {
    const selector = `#tableWrap td[data-r="${info.anchorDisplayRow}"][data-c="${info.anchorDisplayColumn}"]`;
    return document.querySelector(selector) || fallbackCell;
  }

  function resolveExternalFormulaRangeRect(info, fallbackCell = null) {
    const cells = externalFormulaRangeCells(info);
    if (!cells.length && fallbackCell) cells.push(fallbackCell);
    const rects = cells
      .map((cell) => cell.getBoundingClientRect?.())
      .filter(Boolean);
    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function wireArrowKeyNavigation() {
    if (window.__arcRhoArrowNavWired) return;
    window.__arcRhoArrowNavWired = true;

    document.addEventListener("keydown", (e) => {
      const delta = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      }[e.key];
      if (!delta || isTypingTarget(e.target) || !state.activeCell) return;
      if (spreadsheetTable.move(delta[0], delta[1], {
        extend: e.shiftKey,
        jump: e.ctrlKey || e.metaKey,
      })) {
        e.preventDefault();
      }
    });
  }

  function scrollDatasetCellIntoView({ r, c }) {
    const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
    const wrap = document.getElementById("tableWrap");
    if (!td || !wrap) return;
    const tdRect = td.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const stickyLeft = wrap.querySelector("tbody th, tbody td:first-child")?.getBoundingClientRect().width || 0;
    const stickyTop = wrap.querySelector("thead th")?.getBoundingClientRect().height || 0;
    const leftDelta = tdRect.left - (wrapRect.left + stickyLeft);
    const rightDelta = tdRect.right - wrapRect.right;
    const topDelta = tdRect.top - (wrapRect.top + stickyTop);
    const bottomDelta = tdRect.bottom - wrapRect.bottom;
    if (leftDelta < 0) wrap.scrollLeft += leftDelta;
    else if (rightDelta > 0) wrap.scrollLeft += rightDelta;
    if (topDelta < 0) wrap.scrollTop += topDelta;
    else if (bottomDelta > 0) wrap.scrollTop += bottomDelta;
  }

  function rcFromTd(td) {
    const r = Number(td?.dataset?.r);
    const c = Number(td?.dataset?.c);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return { r, c };
  }

  function isTypingTarget(t) {
    if (!t) return false;
    return !!(
      t.closest
        ? t.closest("input, textarea, select, option, button, [contenteditable='true']")
        : (t.matches && t.matches("input, textarea, select, option, button, [contenteditable='true']"))
    ) || !!t.isContentEditable;
  }

  function displayToActualCell(displayR, displayC) {
    return document.getElementById("transposedChk")?.checked === true
      ? { r: displayC, c: displayR }
      : { r: displayR, c: displayC };
  }

  function parseEditableCellValue(rawInput) {
    const raw = String(rawInput ?? "").trim().replace(/,/g, "");
    if (raw === "") return { ok: true, value: null };
    let value = null;
    if (raw.endsWith("%")) {
      const pct = Number(raw.slice(0, -1));
      value = Number.isFinite(pct) ? pct / 100 : NaN;
    } else {
      value = Number(raw);
    }
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: null };
  }

  function isExternalReferenceDraft(rawInput) {
    const raw = String(rawInput ?? "").trim();
    return !!raw && (raw.startsWith("=") || !!parseExcelReference(raw));
  }

  async function commitHoveredExternalFormula({ formula, context }) {
    if (isReadOnly()) {
      const error = "Generated datasets are read-only.";
      setStatus(error);
      return { ok: false, error };
    }
    const displayRow = Number(context?.anchorDisplayRow);
    const displayColumn = Number(context?.anchorDisplayColumn);
    if (!Number.isInteger(displayRow) || !Number.isInteger(displayColumn)) {
      const error = "The linked range anchor is unavailable.";
      setStatus(error);
      return { ok: false, error };
    }

    cancelExternalReference();
    setStatus("Loading linked values from Excel...");
    const result = await commitExternalReference({
      displayRow,
      displayColumn,
      reference: formula,
    });
    if (!result?.ok) {
      if (!result?.aborted && !result?.stale) {
        setStatus(result?.error || "The Excel link could not be loaded.");
      }
      return result;
    }

    state.editingCell = null;
    renderTable();
    notifyDatasetUpdated();
    applySelectionFromState();
    setStatus(`Linked ${result.affectedCellCount} dataset cell${result.affectedCellCount === 1 ? "" : "s"} to Excel.`);
    return result;
  }

  function canEditDisplayCell(displayR, displayC, options = {}) {
    if (isReadOnly()) {
      if (!options?.silent) setStatus("Generated datasets are read-only.");
      return null;
    }
    const model = getDisplayDatasetModel();
    const sourceModel = state.model;
    if (!model || !sourceModel) return null;
    if (displayR < 0 || displayC < 0) return null;
    if (displayR >= (model.origin_labels?.length || 0) || displayC >= (model.dev_labels?.length || 0)) return null;
    const actual = displayToActualCell(displayR, displayC);
    if (!sourceModel.mask?.[actual.r]?.[actual.c]) return null;
    if (!Array.isArray(sourceModel.values?.[actual.r])) return null;
    return actual;
  }

  function setDisplayCellValue(displayR, displayC, rawValue, options = {}) {
    const actual = canEditDisplayCell(displayR, displayC);
    if (!actual) return null;
    const parsed = parseEditableCellValue(rawValue);
    if (!parsed.ok) {
      if (!options?.silentInvalid) setStatus("Enter a numeric value.");
      return null;
    }
    if (options?.hardCodeLinks) hardCodeExternalLinkCells([actual]);
    state.model.values[actual.r][actual.c] = parsed.value;
    state.dirty.set(`${actual.r},${actual.c}`, parsed.value);
    return parsed.value;
  }

  function restoreDirtyValue(key, edit) {
    if (!state.dirty || typeof state.dirty.set !== "function") return;
    if (edit.hadDirtyValue) {
      state.dirty.set(key, edit.previousDirtyValue);
    } else if (typeof state.dirty.delete === "function") {
      state.dirty.delete(key);
    }
  }

  function cancelCellEdit(displayR, displayC) {
    const edit = state.editingCell;
    if (!edit || edit.r !== displayR || edit.c !== displayC) return false;
    if (edit.commitPending || edit.pendingExternalReference) cancelExternalReference();
    const actualR = Number.isInteger(edit.actualR) ? edit.actualR : null;
    const actualC = Number.isInteger(edit.actualC) ? edit.actualC : null;
    if (actualR !== null && actualC !== null && Array.isArray(state.model?.values?.[actualR])) {
      state.model.values[actualR][actualC] = edit.previousValue;
      restoreDirtyValue(`${actualR},${actualC}`, edit);
    }
    state.editingCell = null;
    renderTable();
    notifyDatasetUpdated();
    applySelectionFromState();
    setStatus("Edit canceled.");
    return true;
  }

  function syncInputCellDisplay(td, input, value) {
    if (td) {
      td.dataset.copyValue = value == null ? "" : String(value);
    }
    if (input) {
      input.classList.toggle("dsCellInputBlank", value == null);
    }
  }

  function getPrimaryEditCell() {
    const ranges = Array.isArray(state.selRanges) ? state.selRanges : [];
    return getTopLeftRangeCell(ranges) || state.activeCell;
  }

  function zeroSelectedCells() {
    if (isReadOnly()) {
      setStatus("Generated datasets are read-only.");
      return 0;
    }
    const ranges = Array.isArray(state.selRanges) && state.selRanges.length
      ? state.selRanges
      : (state.activeCell ? [normalizeRange(state.activeCell.r, state.activeCell.c, state.activeCell.r, state.activeCell.c)] : []);
    if (!ranges.length) return 0;

    const seen = new Set();
    let applied = 0;
    for (const range of ranges) {
      for (let r = range.r0; r <= range.r1; r += 1) {
        for (let c = range.c0; c <= range.c1; c += 1) {
          const key = `${r},${c}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const actual = canEditDisplayCell(r, c, { silent: true });
          if (!actual) continue;
          hardCodeExternalLinkCells([actual]);
          state.model.values[actual.r][actual.c] = 0;
          state.dirty.set(`${actual.r},${actual.c}`, 0);
          applied += 1;
        }
      }
    }
    if (!applied) return 0;
    state.editingCell = null;
    renderTable();
    notifyDatasetUpdated();
    applySelectionFromState();
    setStatus(`Set ${applied} cell${applied === 1 ? "" : "s"} to 0.`);
    return applied;
  }

  function parseClipboardRows(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((row, index, arr) => index < arr.length - 1 || row !== "")
      .map((row) => row.split("\t"));
  }

  function applyPastedGridText(text, start) {
    if (isReadOnly()) {
      setStatus("Generated datasets are read-only.");
      return 0;
    }
    const model = getDisplayDatasetModel();
    const sourceModel = state.model;
    if (!model || !sourceModel || !start) return 0;

    const rows = parseClipboardRows(text);
    if (!rows.length) return 0;

    if (rows.length === 1 && rows[0].length === 1 && isExternalReferenceDraft(rows[0][0])) {
      const rawReference = rows[0][0];
      void (async () => {
        setStatus("Loading linked values from Excel...");
        const result = await commitExternalReference({
          displayRow: start.r,
          displayColumn: start.c,
          reference: rawReference,
        });
        if (!result?.ok) {
          if (!result?.aborted && !result?.stale) setStatus(result?.error || "The Excel link could not be loaded.");
          return;
        }
        state.editingCell = null;
        state.activeCell = { r: start.r, c: start.c };
        state.selectionAnchor = { r: start.r, c: start.c };
        state.selRanges = [normalizeRange(start.r, start.c, start.r, start.c)];
        renderTable();
        notifyDatasetUpdated();
        applySelectionFromState();
        setStatus(`Linked ${result.affectedCellCount} dataset cell${result.affectedCellCount === 1 ? "" : "s"} to Excel.`);
      })();
      return 1;
    }

    if (rows.length === 1 && rows[0].length === 1 && Array.isArray(state.selRanges) && state.selRanges.length) {
      const parsed = parseEditableCellValue(rows[0][0]);
      if (!parsed.ok) return 0;
      const seen = new Set();
      let applied = 0;
      for (const range of state.selRanges) {
        for (let r = range.r0; r <= range.r1; r += 1) {
          for (let c = range.c0; c <= range.c1; c += 1) {
            const actual = canEditDisplayCell(r, c, { silent: true });
            if (!actual) continue;
            const key = `${actual.r},${actual.c}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hardCodeExternalLinkCells([actual]);
            state.model.values[actual.r][actual.c] = parsed.value;
            state.dirty.set(key, parsed.value);
            applied += 1;
          }
        }
      }
      if (!applied) return 0;
      state.editingCell = null;
      renderTable();
      notifyDatasetUpdated();
      applySelectionFromState();
      setStatus(`Pasted ${applied} cell${applied === 1 ? "" : "s"}.`);
      return applied;
    }

    let applied = 0;
    for (let rr = 0; rr < rows.length; rr += 1) {
      for (let cc = 0; cc < rows[rr].length; cc += 1) {
        const displayR = start.r + rr;
        const displayC = start.c + cc;
        if (displayR < 0 || displayC < 0) continue;
        if (displayR >= (model.origin_labels?.length || 0) || displayC >= (model.dev_labels?.length || 0)) continue;

        const actual = displayToActualCell(displayR, displayC);
        if (!sourceModel.mask?.[actual.r]?.[actual.c]) continue;

        const parsed = parseEditableCellValue(rows[rr][cc]);
        if (!parsed.ok) continue;

        if (!Array.isArray(sourceModel.values[actual.r])) continue;
        hardCodeExternalLinkCells([actual]);
        sourceModel.values[actual.r][actual.c] = parsed.value;
        state.dirty.set(`${actual.r},${actual.c}`, parsed.value);
        applied += 1;
      }
    }
    if (!applied) return 0;
    state.activeCell = { r: start.r, c: start.c };
    state.selectionAnchor = { r: start.r, c: start.c };
    const lastDisplayRow = Math.min(
      start.r + rows.length - 1,
      Math.max(0, (model.origin_labels?.length || 0) - 1),
    );
    const lastDisplayColumn = Math.min(
      start.c + Math.max(0, rows.reduce((max, row) => Math.max(max, row.length), 0) - 1),
      Math.max(0, (model.dev_labels?.length || 0) - 1),
    );
    state.selRanges = [normalizeRange(
      start.r,
      start.c,
      lastDisplayRow,
      lastDisplayColumn,
    )];
    renderTable();
    notifyDatasetUpdated();
    applySelectionFromState();
    setStatus(`Pasted ${applied} cell${applied === 1 ? "" : "s"}.`);
    return applied;
  }

  function focusCellInput(displayR, displayC, initialText = null) {
    const actual = canEditDisplayCell(displayR, displayC);
    if (!actual) return false;
    formulaHover.hide?.();
    cancelExternalReference();
    const dirtyKey = `${actual.r},${actual.c}`;
    const hadDirtyValue = !!state.dirty?.has?.(dirtyKey);
    state.editingCell = {
      r: displayR,
      c: displayC,
      actualR: actual.r,
      actualC: actual.c,
      previousValue: state.model?.values?.[actual.r]?.[actual.c],
      hadDirtyValue,
      previousDirtyValue: hadDirtyValue ? state.dirty.get(dirtyKey) : undefined,
    };
    state.activeCell = { r: displayR, c: displayC };
    renderTable();
    applySelectionFromState();

    const input = document.querySelector(`#tableWrap .dsCellInput[data-r="${displayR}"][data-c="${displayC}"]`);
    if (!input) {
      state.editingCell = null;
      canEditDisplayCell(displayR, displayC);
      renderTable();
      applySelectionFromState();
      return false;
    }
    if (initialText !== null) {
      input.value = String(initialText);
      setDisplayCellValue(displayR, displayC, input.value, { silentInvalid: true });
      const actual = displayToActualCell(displayR, displayC);
      syncInputCellDisplay(input.closest("td"), input, state.model?.values?.[actual.r]?.[actual.c]);
      notifyDatasetUpdated();
    }
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      if (initialText === null) {
        try { input.select(); } catch { /* number inputs do not expose text selection consistently */ }
      } else {
        try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* keep browser default cursor placement */ }
      }
    });
    return true;
  }

  function applySelectionFromState() {
    spreadsheetTable.applyDom();
  }

  function clearGridSelection() {
    state.dragSel = null;
    spreadsheetTable.clear();
  }

  function prepareContextSelection(r, c) {
    spreadsheetTable.prepareContextCell({ r, c });
    window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;
  }

  function hasEditableSelectionTarget() {
    const ranges = Array.isArray(state.selRanges) ? state.selRanges : [];
    for (const range of ranges) {
      for (let r = range.r0; r <= range.r1; r += 1) {
        for (let c = range.c0; c <= range.c1; c += 1) {
          if (canEditDisplayCell(r, c, { silent: true })) return true;
        }
      }
    }
    return false;
  }

  async function pasteSelectionFromClipboard() {
    if (!navigator.clipboard?.readText) {
      setStatus("Clipboard paste is not available in this browser.");
      return 0;
    }
    try {
      const text = await navigator.clipboard.readText();
      const start = getTopLeftRangeCell(state.selRanges || []) || state.activeCell;
      return text && start ? applyPastedGridText(text, start) : 0;
    } catch (error) {
      setStatus(`Paste failed: ${String(error?.message || error)}`);
      return 0;
    }
  }

  async function handleGridContextAction(action) {
    if (action === "paste") return pasteSelectionFromClipboard();
    if (action === "toggle_subtotal") {
      state.showSubtotal = state.showSubtotal === false;
      state.activeCell = null;
      state.selRanges = [];
      renderTable();
      refreshDatasetSettingsDirty();
      return true;
    }
    if (action === "remove_highlights") {
      clearGridSelection();
      return true;
    }
    return false;
  }

  async function copyActiveRangeToClipboard() {
    return spreadsheetTable.copy();
  }

  function wireRectSelectionAndCopy() {
    if (window.__arcRhoRectSelWired) return;
    window.__arcRhoRectSelWired = true;

    // state containers
    if (!Array.isArray(state.selRanges)) state.selRanges = [];
    state.dragSel = null;
    window.__arcRhoDatasetCopyActiveGridSelection = copyActiveRangeToClipboard;
    window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;

    const wrap = document.getElementById("tableWrap");
    if (!wrap) return;

    // start drag
    wrap.addEventListener("mousedown", (e) => {
      // left button only
      if (e.button !== 0) return;
      if (isTypingTarget(e.target)) return;

      // NEW: leave dropdown/input focus when interacting with grid
      const ae = document.activeElement;
      if (ae && isTypingTarget(ae)) {
        try { ae.blur(); } catch {}
      }

      const td = e.target.closest('td[data-r][data-c]');
      if (!td) return;

      e.preventDefault(); // stop text selection

      const rc = rcFromTd(td);
      if (!rc) return;
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;

      const append = !!(e.ctrlKey || e.metaKey) && !e.shiftKey;
      const baseRanges = append ? spreadsheetTable.selection().ranges : [];
      spreadsheetTable.selectCell(rc, { append, extend: e.shiftKey });
      const selected = spreadsheetTable.selection();

      state.dragSel = {
        anchor: selected.anchorCell || { r: rc.r, c: rc.c },
        append,
        baseRanges,
      };
    });

    // drag over (use mouseover to avoid heavy mousemove)
    wrap.addEventListener("mouseover", (e) => {
      if (!state.dragSel) return;

      const td = e.target.closest('td[data-r][data-c]');
      if (!td) return;

      const rc = rcFromTd(td);
      if (!rc) return;

      const { anchor, append, baseRanges } = state.dragSel;
      spreadsheetTable.setRange(anchor, rc, { append, baseRanges });
    });

    // end drag anywhere
    document.addEventListener("mouseup", () => {
      state.dragSel = null;
    });

    // Click row header -> select entire row
    // Click row header -> select / deselect entire row
    wrap.addEventListener("click", (e) => {
      const th = e.target.closest("th.rowhdr[data-r]");
      if (!th) return;
      const r = Number(th.dataset.r);
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;
      spreadsheetTable.selectRow(r, {
        append: (e.ctrlKey || e.metaKey) && !e.shiftKey,
        extend: e.shiftKey,
        toggle: !e.shiftKey,
      });
    });

    // Click column header -> select / deselect entire column
    wrap.addEventListener("click", (e) => {
      const th = e.target.closest("th.colhdr[data-c]");
      if (!th) return;
      const c = Number(th.dataset.c);
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;
      spreadsheetTable.selectColumn(c, {
        append: (e.ctrlKey || e.metaKey) && !e.shiftKey,
        extend: e.shiftKey,
        toggle: !e.shiftKey,
      });
    });

    // Ctrl+C copy
    document.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;

      const isCopy = (e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey);
      if (!isCopy) return;

      if (!state.selRanges || !state.selRanges.length) return;
      if (window.__arcRhoCopyActiveGridSelection !== copyActiveRangeToClipboard) return;

      e.preventDefault();
      copyActiveRangeToClipboard();
    });

    document.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape" && (state.activeCell || state.selRanges?.length)) {
        e.preventDefault();
        clearGridSelection();
        return;
      }
      if (!state.activeCell) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "F2") {
        const cell = getPrimaryEditCell();
        if (!cell) return;
        const info = getExternalLinkCellInfo(cell.r, cell.c);
        if (!info?.reference) return;
        const hoveredCell = document.querySelector(`#tableWrap td[data-r="${cell.r}"][data-c="${cell.c}"]`);
        const anchor = resolveExternalFormulaAnchor(info, hoveredCell);
        if (!anchor) return;
        e.preventDefault();
        formulaHover.open(anchor, {
          ...info,
          formula: info.reference,
          readOnly: isReadOnly(),
        }, {
          focus: true,
          positionRect: () => resolveExternalFormulaRangeRect(info, anchor),
        });
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        zeroSelectedCells();
        return;
      }

      if (/^[0-9]$/.test(e.key || "") || e.key === "=") {
        const cell = getPrimaryEditCell();
        if (!cell) return;
        e.preventDefault();
        focusCellInput(cell.r, cell.c, e.key);
      }
    });

    document.addEventListener("paste", (e) => {
      if (isTypingTarget(e.target)) return;
      if (isReadOnly()) {
        setStatus("Generated datasets are read-only.");
        return;
      }
      const text = String(e.clipboardData?.getData("text/plain") || "");
      if (!text) return;
      const start = getTopLeftRangeCell(state.selRanges || []) || state.activeCell;
      if (!start) return;
      const applied = applyPastedGridText(text, start);
      if (!applied) return;
      e.preventDefault();
    });
  }

  return {
    applySelectionFromState,
    copyActiveRangeToClipboard,
  };
}
