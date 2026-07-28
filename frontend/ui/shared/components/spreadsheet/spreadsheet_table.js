import {
  getTopLeftRangeCell,
  normalizeRange,
  writeTextToClipboard,
} from "./table_selection.js?v=20260726a";

export { getTopLeftRangeCell, normalizeRange, writeTextToClipboard };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function cloneCell(cell) {
  if (!cell) return null;
  return { r: Number(cell.r) || 0, c: Number(cell.c) || 0 };
}

function cloneRange(range) {
  return normalizeRange(range.r0, range.c0, range.r1, range.c1);
}

function cellInRange(cell, range) {
  return !!cell && !!range
    && cell.r >= range.r0
    && cell.r <= range.r1
    && cell.c >= range.c0
    && cell.c <= range.c1;
}

function sameRange(left, right) {
  return !!left && !!right
    && left.r0 === right.r0
    && left.r1 === right.r1
    && left.c0 === right.c0
    && left.c1 === right.c1;
}

function classNames(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

export function createSpreadsheetTableController(options = {}) {
  let labelAnchor = null;
  const getRoot = typeof options.getRoot === "function" ? options.getRoot : () => options.root || null;
  const getBounds = typeof options.getBounds === "function"
    ? options.getBounds
    : () => ({ maxRow: -1, maxCol: -1 });
  const readSelection = typeof options.readSelection === "function"
    ? options.readSelection
    : () => ({ ranges: [], activeCell: null, anchorCell: null });
  const writeSelection = typeof options.writeSelection === "function" ? options.writeSelection : () => {};
  const cellSelector = options.cellSelector || "td[data-r][data-c]";
  const rowHeaderSelector = options.rowHeaderSelector || "th[data-r]";
  const columnHeaderSelector = options.columnHeaderSelector || "th[data-c]";
  const getCellPosition = typeof options.getCellPosition === "function"
    ? options.getCellPosition
    : (cell) => ({ r: Number(cell?.dataset?.r), c: Number(cell?.dataset?.c) });
  const getRowHeaderIndex = typeof options.getRowHeaderIndex === "function"
    ? options.getRowHeaderIndex
    : (header) => Number(header?.dataset?.r);
  const getColumnHeaderIndex = typeof options.getColumnHeaderIndex === "function"
    ? options.getColumnHeaderIndex
    : (header) => Number(header?.dataset?.c);
  const getCellValue = typeof options.getCellValue === "function"
    ? options.getCellValue
    : (_position, cell) => String(cell?.textContent || "").trim();
  const selectedClasses = classNames(options.selectedClasses || ["arSpreadsheetSelected"]);
  const activeClasses = classNames(options.activeClasses);
  const anchorClasses = classNames(options.anchorClasses || ["arSpreadsheetSelectionAnchor"]);
  const selectedLabelClasses = classNames(options.selectedLabelClasses || ["arSpreadsheetSelectedLabel"]);
  const rowSelectedLabelClasses = classNames(options.rowSelectedLabelClasses || selectedLabelClasses);
  const columnSelectedLabelClasses = classNames(options.columnSelectedLabelClasses || selectedLabelClasses);
  const lineSeparator = options.lineSeparator || "\r\n";
  const onAfterWrite = typeof options.onAfterWrite === "function" ? options.onAfterWrite : null;
  const onAfterCopy = typeof options.onAfterCopy === "function" ? options.onAfterCopy : null;
  const scrollCellIntoView = typeof options.scrollCellIntoView === "function" ? options.scrollCellIntoView : null;

  function bounds() {
    const value = getBounds() || {};
    return {
      maxRow: Math.max(-1, Number(value.maxRow) || 0),
      maxCol: Math.max(-1, Number(value.maxCol) || 0),
    };
  }

  function normalizeState(value = readSelection()) {
    const limit = bounds();
    if (limit.maxRow < 0 || limit.maxCol < 0) {
      return { ranges: [], activeCell: null, anchorCell: null };
    }
    const clampCell = (cell) => cell ? {
      r: clamp(cell.r, 0, limit.maxRow),
      c: clamp(cell.c, 0, limit.maxCol),
    } : null;
    const ranges = (Array.isArray(value?.ranges) ? value.ranges : []).map((range) => normalizeRange(
      clamp(range.r0, 0, limit.maxRow),
      clamp(range.c0, 0, limit.maxCol),
      clamp(range.r1, 0, limit.maxRow),
      clamp(range.c1, 0, limit.maxCol),
    ));
    return {
      ranges,
      activeCell: clampCell(value?.activeCell),
      anchorCell: clampCell(value?.anchorCell),
    };
  }

  function write(next, settings = {}) {
    const normalized = normalizeState(next);
    writeSelection({
      ranges: normalized.ranges.map(cloneRange),
      activeCell: cloneCell(normalized.activeCell),
      anchorCell: cloneCell(normalized.anchorCell),
    });
    if (onAfterWrite) onAfterWrite(normalized);
    if (settings.apply !== false) applyDom();
    if (settings.scroll && normalized.activeCell && scrollCellIntoView) {
      scrollCellIntoView(normalized.activeCell);
    }
    return normalized;
  }

  function clearDomClasses(root) {
    const allStateClasses = [...new Set([
      ...selectedClasses,
      ...activeClasses,
      ...anchorClasses,
      ...rowSelectedLabelClasses,
      ...columnSelectedLabelClasses,
    ])];
    allStateClasses.forEach((className) => {
      root.querySelectorAll(`.${className}`).forEach((element) => element.classList.remove(className));
    });
    root.querySelectorAll(`${cellSelector}[aria-selected="true"]`).forEach((cell) => {
      cell.setAttribute("aria-selected", "false");
    });
  }

  function applyDom() {
    const root = getRoot();
    if (!root) return false;
    const selection = normalizeState();
    clearDomClasses(root);

    root.querySelectorAll(cellSelector).forEach((cell) => {
      const position = getCellPosition(cell);
      if (!Number.isInteger(position?.r) || !Number.isInteger(position?.c)) return;
      const selected = selection.ranges.some((range) => cellInRange(position, range));
      selectedClasses.forEach((className) => cell.classList.toggle(className, selected));
      cell.setAttribute("aria-selected", selected ? "true" : "false");
      if (selection.activeCell && position.r === selection.activeCell.r && position.c === selection.activeCell.c) {
        activeClasses.forEach((className) => cell.classList.add(className));
      }
      if (selection.anchorCell && position.r === selection.anchorCell.r && position.c === selection.anchorCell.c) {
        anchorClasses.forEach((className) => cell.classList.add(className));
      }
    });

    root.querySelectorAll(rowHeaderSelector).forEach((header) => {
      const row = getRowHeaderIndex(header);
      const selected = Number.isInteger(row) && selection.ranges.some((range) => row >= range.r0 && row <= range.r1);
      rowSelectedLabelClasses.forEach((className) => header.classList.toggle(className, selected));
    });
    root.querySelectorAll(columnHeaderSelector).forEach((header) => {
      const col = getColumnHeaderIndex(header);
      const selected = Number.isInteger(col) && selection.ranges.some((range) => col >= range.c0 && col <= range.c1);
      columnSelectedLabelClasses.forEach((className) => header.classList.toggle(className, selected));
    });
    return true;
  }

  function selection() {
    return normalizeState();
  }

  function setRange(anchorCell, activeCell, settings = {}) {
    const current = selection();
    const anchor = cloneCell(anchorCell);
    const active = cloneCell(activeCell);
    if (!anchor || !active) return current;
    const nextRange = normalizeRange(anchor.r, anchor.c, active.r, active.c);
    const ranges = settings.append
      ? [...(settings.baseRanges || current.ranges).map(cloneRange), nextRange]
      : [nextRange];
    return write({ ranges, activeCell: active, anchorCell: anchor }, settings);
  }

  function selectCell(cell, settings = {}) {
    labelAnchor = null;
    const current = selection();
    const active = cloneCell(cell);
    if (!active) return current;
    const anchor = settings.extend ? (current.anchorCell || current.activeCell || active) : active;
    return setRange(anchor, active, {
      ...settings,
      append: settings.extend ? false : !!settings.append,
    });
  }

  function selectRow(row, settings = {}) {
    const limit = bounds();
    if (limit.maxCol < 0) return selection();
    if (settings.extend && labelAnchor?.axis === "row") {
      const anchorRow = labelAnchor.index;
      return write({
        ranges: [normalizeRange(anchorRow, 0, row, limit.maxCol)],
        activeCell: { r: row, c: limit.maxCol },
        anchorCell: { r: anchorRow, c: 0 },
      }, settings);
    }
    labelAnchor = { axis: "row", index: row };
    const range = normalizeRange(row, 0, row, limit.maxCol);
    const current = selection();
    if (settings.toggle) {
      const index = current.ranges.findIndex((item) => sameRange(item, range));
      if (index >= 0) {
        labelAnchor = null;
        const ranges = current.ranges.filter((_, itemIndex) => itemIndex !== index);
        const activeCell = ranges.some((item) => cellInRange(current.activeCell, item))
          ? current.activeCell
          : getTopLeftRangeCell(ranges);
        const anchorCell = activeCell;
        return write({ ranges, activeCell, anchorCell }, settings);
      }
    }
    return write({
      ranges: settings.append ? [...current.ranges, range] : [range],
      activeCell: { r: row, c: 0 },
      anchorCell: { r: row, c: 0 },
    }, settings);
  }

  function selectColumn(col, settings = {}) {
    const limit = bounds();
    if (limit.maxRow < 0) return selection();
    if (settings.extend && labelAnchor?.axis === "column") {
      const anchorCol = labelAnchor.index;
      return write({
        ranges: [normalizeRange(0, anchorCol, limit.maxRow, col)],
        activeCell: { r: limit.maxRow, c: col },
        anchorCell: { r: 0, c: anchorCol },
      }, settings);
    }
    labelAnchor = { axis: "column", index: col };
    const range = normalizeRange(0, col, limit.maxRow, col);
    const current = selection();
    if (settings.toggle) {
      const index = current.ranges.findIndex((item) => sameRange(item, range));
      if (index >= 0) {
        labelAnchor = null;
        const ranges = current.ranges.filter((_, itemIndex) => itemIndex !== index);
        const activeCell = ranges.some((item) => cellInRange(current.activeCell, item))
          ? current.activeCell
          : getTopLeftRangeCell(ranges);
        const anchorCell = activeCell;
        return write({ ranges, activeCell, anchorCell }, settings);
      }
    }
    return write({
      ranges: settings.append ? [...current.ranges, range] : [range],
      activeCell: { r: 0, c: col },
      anchorCell: { r: 0, c: col },
    }, settings);
  }

  function clear(settings = {}) {
    labelAnchor = null;
    return write({ ranges: [], activeCell: null, anchorCell: null }, settings);
  }

  function contains(cell) {
    return selection().ranges.some((range) => cellInRange(cell, range));
  }

  function prepareContextCell(cell, settings = {}) {
    labelAnchor = null;
    return contains(cell) ? selection() : selectCell(cell, settings);
  }

  function move(deltaRow, deltaCol, settings = {}) {
    labelAnchor = null;
    const limit = bounds();
    const current = selection();
    if (limit.maxRow < 0 || limit.maxCol < 0 || !current.activeCell) return false;
    const jump = !!settings.jump;
    if (settings.extend) {
      const anchor = current.anchorCell || current.activeCell;
      const active = { ...current.activeCell };
      if (deltaRow < 0) active.r = jump ? 0 : active.r - 1;
      if (deltaRow > 0) active.r = jump ? limit.maxRow : active.r + 1;
      if (deltaCol < 0) active.c = jump ? 0 : active.c - 1;
      if (deltaCol > 0) active.c = jump ? limit.maxCol : active.c + 1;
      active.r = clamp(active.r, 0, limit.maxRow);
      active.c = clamp(active.c, 0, limit.maxCol);
      setRange(anchor, active, { scroll: settings.scroll !== false });
      return active.r !== current.activeCell.r || active.c !== current.activeCell.c;
    }

    const origin = current.anchorCell || current.activeCell;
    const active = { ...origin };
    if (deltaRow < 0) active.r = jump ? 0 : active.r - 1;
    if (deltaRow > 0) active.r = jump ? limit.maxRow : active.r + 1;
    if (deltaCol < 0) active.c = jump ? 0 : active.c - 1;
    if (deltaCol > 0) active.c = jump ? limit.maxCol : active.c + 1;
    active.r = clamp(active.r, 0, limit.maxRow);
    active.c = clamp(active.c, 0, limit.maxCol);
    const hasRange = current.ranges.length !== 1
      || current.ranges[0].r0 !== current.ranges[0].r1
      || current.ranges[0].c0 !== current.ranges[0].c1;
    if (!hasRange && active.r === origin.r && active.c === origin.c) return false;
    write({
      ranges: [normalizeRange(active.r, active.c, active.r, active.c)],
      activeCell: active,
      anchorCell: active,
    }, { scroll: settings.scroll !== false });
    return true;
  }

  function selectionText() {
    const root = getRoot();
    const current = selection();
    if (!root || !current.ranges.length) return "";
    const cellByPosition = new Map();
    root.querySelectorAll(cellSelector).forEach((cell) => {
      const position = getCellPosition(cell);
      if (Number.isInteger(position?.r) && Number.isInteger(position?.c)) {
        cellByPosition.set(`${position.r}:${position.c}`, cell);
      }
    });
    if (current.ranges.length > 1) {
      const topLeft = getTopLeftRangeCell(current.ranges);
      const cell = topLeft ? cellByPosition.get(`${topLeft.r}:${topLeft.c}`) : null;
      return topLeft ? String(getCellValue(topLeft, cell) ?? "") : "";
    }
    const range = current.ranges[0];
    const rows = [];
    for (let r = range.r0; r <= range.r1; r += 1) {
      const values = [];
      for (let c = range.c0; c <= range.c1; c += 1) {
        const cell = cellByPosition.get(`${r}:${c}`);
        values.push(String(getCellValue({ r, c }, cell) ?? ""));
      }
      rows.push(values.join("\t"));
    }
    return rows.join(lineSeparator);
  }

  async function copy() {
    const text = selectionText();
    if (!text && !selection().ranges.length) return false;
    await writeTextToClipboard(text);
    if (onAfterCopy) onAfterCopy(text);
    return true;
  }

  return {
    applyDom,
    clear,
    contains,
    copy,
    move,
    prepareContextCell,
    selectCell,
    selectColumn,
    selectRow,
    selection,
    selectionText,
    setRange,
    topLeft: () => getTopLeftRangeCell(selection().ranges),
  };
}
