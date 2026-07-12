export function normalizeRange(r0, c0, r1, c1) {
  return {
    r0: Math.min(r0, r1),
    r1: Math.max(r0, r1),
    c0: Math.min(c0, c1),
    c1: Math.max(c0, c1),
  };
}

let activeSelectableTable = null;

export function getTopLeftRangeCell(ranges = []) {
  let best = null;
  for (const range of ranges) {
    if (!range) continue;
    const cell = { r: Number(range.r0), c: Number(range.c0) };
    if (!Number.isFinite(cell.r) || !Number.isFinite(cell.c)) continue;
    if (!best || cell.r < best.r || (cell.r === best.r && cell.c < best.c)) best = cell;
  }
  return best;
}

export async function writeTextToClipboard(text) {
  const value = String(text ?? "");
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function isTypingTarget(target) {
  if (!target) return false;
  const selector = "input, textarea, select, option, button, [contenteditable='true']";
  return !!(
    target.closest
      ? target.closest(selector)
      : (target.matches && target.matches(selector))
  ) || !!target.isContentEditable;
}

function dataAttrName(key) {
  return String(key || "").replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function cellSelectorFor(row, col, rowKey = "r", colKey = "c") {
  return `td[data-${dataAttrName(rowKey)}="${row}"][data-${dataAttrName(colKey)}="${col}"]`;
}

function cellText(cell) {
  return String(cell?.textContent ?? "").trim();
}

function buildTsvFromRange(container, range, getCellText = cellText, rowKey = "r", colKey = "c") {
  const rows = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const row = [];
    for (let c = range.c0; c <= range.c1; c++) {
      row.push(getCellText(container.querySelector(cellSelectorFor(r, c, rowKey, colKey))));
    }
    rows.push(row.join("\t"));
  }
  return rows.join("\n");
}

export function wireSelectableTable(options = {}) {
  const container = options.container;
  if (!container || container.dataset.tableSelectionWired === "1") return null;
  container.dataset.tableSelectionWired = "1";

  const selectedClass = options.selectedClass || "sel";
  const activeClass = options.activeClass || "active";
  const edgeClasses = options.edgeClasses && typeof options.edgeClasses === "object"
    ? {
        top: String(options.edgeClasses.top || ""),
        right: String(options.edgeClasses.right || ""),
        bottom: String(options.edgeClasses.bottom || ""),
        left: String(options.edgeClasses.left || ""),
      }
    : null;
  const edgeClassNames = edgeClasses
    ? [...new Set(Object.values(edgeClasses).filter(Boolean))]
    : [];
  const rowKey = options.rowKey || "r";
  const colKey = options.colKey || "c";
  const cellQuery = `td[data-${dataAttrName(rowKey)}][data-${dataAttrName(colKey)}]`;
  const getCellText = typeof options.getCellText === "function" ? options.getCellText : cellText;
  const isSelectableCell = typeof options.isSelectableCell === "function" ? options.isSelectableCell : () => true;
  const canStartPointerSelection = typeof options.canStartPointerSelection === "function"
    ? options.canStartPointerSelection
    : () => true;
  const onContextMenu = typeof options.onContextMenu === "function" ? options.onContextMenu : null;
  const onSelectionChange = typeof options.onSelectionChange === "function"
    ? options.onSelectionChange
    : null;
  const exclusiveAcrossTables = options.exclusiveAcrossTables === true;
  const state = {
    activeCell: null,
    ranges: [],
    drag: null,
    isActive: false,
    exclusiveAcrossTables,
    clearSelection: null,
  };

  const markActive = () => {
    const previous = activeSelectableTable;
    if (
      exclusiveAcrossTables &&
      previous &&
      previous !== state &&
      previous.exclusiveAcrossTables &&
      typeof previous.clearSelection === "function"
    ) {
      previous.clearSelection();
    }
    state.isActive = true;
    activeSelectableTable = state;
  };

  function rcFromCell(cell) {
    const r = Number(cell?.dataset?.[rowKey]);
    const c = Number(cell?.dataset?.[colKey]);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return { r, c };
  }

  function clearClasses() {
    container.querySelectorAll(`td.${selectedClass}`).forEach((el) => el.classList.remove(selectedClass));
    container.querySelectorAll(`td.${activeClass}`).forEach((el) => el.classList.remove(activeClass));
    edgeClassNames.forEach((className) => {
      container.querySelectorAll(`td.${className}`).forEach((el) => el.classList.remove(className));
    });
  }

  function applyClasses() {
    clearClasses();
    for (const range of state.ranges) {
      for (let r = range.r0; r <= range.r1; r++) {
        for (let c = range.c0; c <= range.c1; c++) {
          const cell = container.querySelector(cellSelectorFor(r, c, rowKey, colKey));
          if (!cell || !isSelectableCell(cell)) continue;
          cell.classList.add(selectedClass);
          if (!edgeClasses) continue;
          if (r === range.r0 && edgeClasses.top) cell.classList.add(edgeClasses.top);
          if (c === range.c1 && edgeClasses.right) cell.classList.add(edgeClasses.right);
          if (r === range.r1 && edgeClasses.bottom) cell.classList.add(edgeClasses.bottom);
          if (c === range.c0 && edgeClasses.left) cell.classList.add(edgeClasses.left);
        }
      }
    }
    if (state.activeCell) {
      container.querySelector(cellSelectorFor(state.activeCell.r, state.activeCell.c, rowKey, colKey))?.classList.add(activeClass);
    }
    if (onSelectionChange) {
      onSelectionChange({
        activeCell: state.activeCell ? { ...state.activeCell } : null,
        ranges: state.ranges.map((range) => ({ ...range })),
      });
    }
  }

  function clearSelection() {
    state.activeCell = null;
    state.ranges = [];
    state.drag = null;
    state.isActive = false;
    if (activeSelectableTable === state) activeSelectableTable = null;
    applyClasses();
  }

  state.clearSelection = clearSelection;

  function selectCell(cell, append = false) {
    const rc = rcFromCell(cell);
    if (!rc) return false;
    state.activeCell = rc;
    markActive();
    if (!append) state.ranges = [];
    state.ranges.push(normalizeRange(rc.r, rc.c, rc.r, rc.c));
    applyClasses();
    return true;
  }

  function isCellInSelection(cell) {
    const rc = rcFromCell(cell);
    if (!rc) return false;
    return state.ranges.some((range) => (
      rc.r >= range.r0 && rc.r <= range.r1 && rc.c >= range.c0 && rc.c <= range.c1
    ));
  }

  async function copySelection() {
    const ranges = state.ranges.length
      ? state.ranges
      : (state.activeCell ? [normalizeRange(state.activeCell.r, state.activeCell.c, state.activeCell.r, state.activeCell.c)] : []);
    if (!ranges.length) return false;
    const topLeft = ranges.length > 1 ? getTopLeftRangeCell(ranges) : null;
    const text = ranges.length === 1
      ? buildTsvFromRange(container, ranges[0], getCellText, rowKey, colKey)
      : getCellText(topLeft ? container.querySelector(cellSelectorFor(topLeft.r, topLeft.c, rowKey, colKey)) : null);
    await writeTextToClipboard(text);
    return true;
  }

  container.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || isTypingTarget(event.target)) return;
    if (!canStartPointerSelection(event)) return;
    const cell = event.target?.closest?.(cellQuery);
    if (!cell || !container.contains(cell) || !isSelectableCell(cell)) return;
    const rc = rcFromCell(cell);
    if (!rc) return;
    event.preventDefault();
    const append = !!(event.ctrlKey || event.metaKey);
    if (!append) state.ranges = [];
    state.activeCell = rc;
    markActive();
    state.drag = { anchor: rc };
    state.ranges.push(normalizeRange(rc.r, rc.c, rc.r, rc.c));
    applyClasses();
  });

  container.addEventListener("mouseover", (event) => {
    if (!state.drag) return;
    const cell = event.target?.closest?.(cellQuery);
    if (!cell || !container.contains(cell) || !isSelectableCell(cell)) return;
    const rc = rcFromCell(cell);
    if (!rc) return;
    const lastIdx = state.ranges.length - 1;
    if (lastIdx < 0) return;
    state.activeCell = rc;
    state.ranges[lastIdx] = normalizeRange(state.drag.anchor.r, state.drag.anchor.c, rc.r, rc.c);
    applyClasses();
  });

  container.addEventListener("contextmenu", (event) => {
    const cell = event.target?.closest?.(cellQuery);
    if (!cell || !container.contains(cell) || !isSelectableCell(cell)) return;
    markActive();
    if (!isCellInSelection(cell)) selectCell(cell, false);
    if (onContextMenu) onContextMenu(event, cell, { copySelection, state });
  });

  document.addEventListener("mouseup", () => {
    state.drag = null;
  });

  document.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.key === "Escape" && activeSelectableTable === state && state.isActive) {
      clearSelection();
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || String(event.key || "").toLowerCase() !== "c") return;
    if (activeSelectableTable !== state || !state.isActive || (!state.ranges.length && !state.activeCell)) return;
    event.preventDefault();
    void copySelection();
  });

  return {
    copySelection,
    selectCell,
    clearSelection,
    state,
    applyClasses,
  };
}
