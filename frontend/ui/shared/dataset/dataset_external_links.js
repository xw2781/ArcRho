import {
  readExcelCellsBatch,
  validateExcelLinksBatch,
} from "/ui/shared/integrations/excel_api.js?v=20260819a";
import {
  excelColumnFromIndex,
  formatExcelReference,
  parseExcelCellAddress,
  parseExcelReference,
  parseStandaloneExcelRange,
} from "/ui/shared/integrations/excel_reference.js?v=20260715a";

function targetCellKey(target) {
  return `${target.row},${target.column}`;
}

function normalizeSourceCell(value) {
  const parsed = parseExcelCellAddress(value);
  return parsed ? `${excelColumnFromIndex(parsed.col)}${parsed.row + 1}` : "";
}

function sourceCellForOffset(range, rowOffset, columnOffset) {
  const row = Number(rowOffset);
  const column = Number(columnOffset);
  if (
    !range
    || !Number.isInteger(row)
    || !Number.isInteger(column)
    || row < 0
    || column < 0
    || row >= range.rowCount
    || column >= range.colCount
  ) return "";
  return `${excelColumnFromIndex(range.col0 + column)}${range.row0 + row + 1}`;
}

function sourceCellForLinearIndex(range, index) {
  const numericIndex = Number(index);
  if (!range || !Number.isInteger(numericIndex) || numericIndex < 0) return "";
  return sourceCellForOffset(
    range,
    Math.floor(numericIndex / range.colCount),
    numericIndex % range.colCount,
  );
}

function sourceCellBelongsToRange(range, cell) {
  const parsed = parseExcelCellAddress(cell);
  return !!(
    range
    && parsed
    && parsed.row >= range.row0
    && parsed.row < range.row0 + range.rowCount
    && parsed.col >= range.col0
    && parsed.col < range.col0 + range.colCount
  );
}

function cloneLinks(links) {
  return links.map((link) => ({
    reference: link.reference,
    target_cells: link.target_cells.map((target) => ({ ...target })),
  }));
}

function linksSnapshot(links) {
  return JSON.stringify(links);
}

function normalizeReference(value) {
  const parsed = parseExcelReference(value);
  if (!parsed) return "";
  return formatExcelReference(
    parsed.bookPath,
    parsed.sheet,
    parsed.cell,
    parsed.endCell,
  );
}

export function normalizeDatasetExternalLinks(value) {
  const source = Array.isArray(value) ? value : [];
  const normalized = [];
  const seenLinks = new Set();
  const ownedTargets = new Set();
  source.forEach((item) => {
    const reference = normalizeReference(item?.reference);
    if (!reference) return;
    const description = describeExcelReference(reference);
    if (!description) return;
    const targetCells = [];
    const seenTargets = new Map();
    const seenSourceCells = new Set();
    let invalidTargets = false;
    const rawTargets = Array.isArray(item?.target_cells)
      ? item.target_cells
      : (Array.isArray(item?.targetCells) ? item.targetCells : []);
    const hasMappedTargets = rawTargets.some((target) => (
      Object.prototype.hasOwnProperty.call(target || {}, "source_cell")
      || Object.prototype.hasOwnProperty.call(target || {}, "sourceCell")
    ));
    const hasUnmappedTargets = rawTargets.some((target) => !(
      Object.prototype.hasOwnProperty.call(target || {}, "source_cell")
      || Object.prototype.hasOwnProperty.call(target || {}, "sourceCell")
    ));
    if (hasMappedTargets && hasUnmappedTargets) return;
    rawTargets.forEach((target) => {
      const row = Number(target?.row);
      const column = Number(target?.column);
      if (!Number.isInteger(row) || row < 0 || !Number.isInteger(column) || column < 0) {
        invalidTargets = true;
        return;
      }
      const key = `${row},${column}`;
      const sourceCell = hasMappedTargets
        ? normalizeSourceCell(target?.source_cell ?? target?.sourceCell)
        : sourceCellForLinearIndex(description.range, targetCells.length);
      if (seenTargets.has(key)) {
        if (hasMappedTargets && seenTargets.get(key) !== sourceCell) invalidTargets = true;
        return;
      }
      if (
        !sourceCell
        || !sourceCellBelongsToRange(description.range, sourceCell)
        || seenSourceCells.has(sourceCell)
      ) {
        invalidTargets = true;
        return;
      }
      seenTargets.set(key, sourceCell);
      seenSourceCells.add(sourceCell);
      targetCells.push({ row, column, source_cell: sourceCell });
    });
    if (
      invalidTargets
      || !targetCells.length
      || (!hasMappedTargets && description.sourceCellCount !== targetCells.length)
    ) return;
    const linkKey = `${reference}\u001f${targetCells.map(targetCellKey).join(";")}`;
    if (seenLinks.has(linkKey)) return;
    if (targetCells.some((target) => ownedTargets.has(targetCellKey(target)))) return;
    seenLinks.add(linkKey);
    targetCells.forEach((target) => ownedTargets.add(targetCellKey(target)));
    normalized.push({ reference, target_cells: targetCells });
  });
  return normalized;
}

export function describeExcelReference(reference) {
  const parsed = parseExcelReference(reference);
  if (!parsed) return null;
  const parsedStart = parseExcelCellAddress(parsed.cell);
  const parsedEnd = parseExcelCellAddress(parsed.endCell);
  if (!parsedStart || !parsedEnd) return null;
  const row0 = Math.min(parsedStart.row, parsedEnd.row);
  const row1 = Math.max(parsedStart.row, parsedEnd.row);
  const col0 = Math.min(parsedStart.col, parsedEnd.col);
  const col1 = Math.max(parsedStart.col, parsedEnd.col);
  const range = parseStandaloneExcelRange(reference) || {
    ...parsed,
    row0,
    col0,
    rowCount: 1,
    colCount: 1,
  };
  const sourceCellCount = range.rowCount * range.colCount;
  if (!Number.isSafeInteger(sourceCellCount) || sourceCellCount <= 0) return null;
  const startCell = `${excelColumnFromIndex(col0)}${row0 + 1}`;
  const endCell = `${excelColumnFromIndex(col1)}${row1 + 1}`;
  return {
    ...parsed,
    range,
    sourceCellCount,
    isRange: sourceCellCount > 1,
    address: startCell === endCell ? startCell : `${startCell}:${endCell}`,
  };
}

function displayToActualCell(row, column, transposed) {
  return transposed ? { row: column, column: row } : { row, column };
}

function actualToDisplayCell(row, column, transposed) {
  return transposed ? { row: column, column: row } : { row, column };
}

export function buildDatasetExternalLinkTargets({
  model,
  transposed = false,
  startRow,
  startColumn,
  rowCount,
  columnCount,
} = {}) {
  if (!model || !Array.isArray(model.values) || !Array.isArray(model.mask)) {
    return { ok: false, error: "The dataset grid is not available." };
  }
  const displayRowCount = transposed
    ? (Array.isArray(model.dev_labels) ? model.dev_labels.length : 0)
    : (Array.isArray(model.origin_labels) ? model.origin_labels.length : 0);
  const displayColumnCount = transposed
    ? (Array.isArray(model.origin_labels) ? model.origin_labels.length : 0)
    : (Array.isArray(model.dev_labels) ? model.dev_labels.length : 0);
  const numericStartRow = Number(startRow);
  const numericStartColumn = Number(startColumn);
  const numericRowCount = Number(rowCount);
  const numericColumnCount = Number(columnCount);
  const totalCellCount = numericRowCount * numericColumnCount;
  if (
    !Number.isSafeInteger(numericStartRow)
    || !Number.isSafeInteger(numericStartColumn)
    || !Number.isSafeInteger(numericRowCount)
    || !Number.isSafeInteger(numericColumnCount)
    || numericRowCount <= 0
    || numericColumnCount <= 0
    || !Number.isSafeInteger(totalCellCount)
  ) {
    return { ok: false, error: "The Excel range dimensions are invalid." };
  }
  const firstRowOffset = Math.max(0, -numericStartRow);
  const firstColumnOffset = Math.max(0, -numericStartColumn);
  const rowOffsetEnd = Math.min(numericRowCount, displayRowCount - numericStartRow);
  const columnOffsetEnd = Math.min(numericColumnCount, displayColumnCount - numericStartColumn);
  const targets = [];
  for (let rowOffset = firstRowOffset; rowOffset < rowOffsetEnd; rowOffset += 1) {
    for (
      let columnOffset = firstColumnOffset;
      columnOffset < columnOffsetEnd;
      columnOffset += 1
    ) {
      const displayRow = numericStartRow + rowOffset;
      const displayColumn = numericStartColumn + columnOffset;
      const actual = displayToActualCell(displayRow, displayColumn, transposed);
      if (
        model.mask?.[actual.row]?.[actual.column] !== true
        || !Array.isArray(model.values?.[actual.row])
      ) {
        continue;
      }
      targets.push({
        row: actual.row,
        column: actual.column,
        displayRow,
        displayColumn,
        rowOffset,
        columnOffset,
      });
    }
  }
  if (!targets.length) {
    return { ok: false, error: "The Excel range does not overlap an editable dataset cell." };
  }
  return {
    ok: true,
    targets,
    ignoredCellCount: totalCellCount - targets.length,
  };
}

function excelResultValue(result) {
  if (!result?.ok) {
    return { ok: false, error: String(result?.error || "Excel cell read failed.") };
  }
  if (result.value === null || result.value === undefined || result.value === "") {
    return { ok: true, value: null };
  }
  const value = Number(result.value);
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, error: `Excel returned a non-numeric value: ${String(result.value)}` };
}

function valuesEqual(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

function sourceGroupKey(description) {
  return [
    String(description.bookPath || "").toLowerCase(),
    String(description.sheet || "").toLowerCase(),
    description.address,
  ].join("\u001f");
}

function targetDestinationLabel(model, target) {
  const origin = String(model?.origin_labels?.[target.row] ?? `Row ${target.row + 1}`);
  const development = String(model?.dev_labels?.[target.column] ?? "");
  return development ? `${origin} / ${development}` : origin;
}

function targetValuePreview(model, targets, isRange) {
  const first = targets[0];
  if (!first) return "";
  const value = model?.values?.[first.row]?.[first.column];
  const text = value === null || value === undefined ? "" : String(value);
  return isRange ? `${text}...` : text;
}

export function createDatasetExternalLinksController({
  state,
  readCellsBatch = readExcelCellsBatch,
  validateLinksBatch = validateExcelLinksBatch,
  isReadOnly = () => false,
  isTransposed = () => false,
  onInventoryChanged = () => {},
  onTargetsClaimed = () => {},
} = {}) {
  let links = [];
  let savedLinks = [];
  let requestGeneration = 0;
  let requestController = null;
  let pendingTargetKeys = new Set();
  let targetDecorationIndex = null;
  // Target cell key -> the reference failure that left its stored value in
  // place. Kept on the controller so a re-render repaints the same cells red
  // and the Data tab can re-open the alert without another Excel read.
  let failuresByTargetKey = new Map();

  function ownedTargetKeys() {
    const keys = new Set();
    links.forEach((link) => link.target_cells.forEach((target) => keys.add(targetCellKey(target))));
    return keys;
  }

  function notifyInventoryChanged() {
    targetDecorationIndex = null;
    if (failuresByTargetKey.size) {
      // A link that was broken, hard-coded, or replaced is no longer a broken
      // reference; only cells a live link still owns stay flagged.
      const owned = ownedTargetKeys();
      failuresByTargetKey.forEach((_failure, key) => {
        if (!owned.has(key)) failuresByTargetKey.delete(key);
      });
    }
    onInventoryChanged();
  }

  function clearFailuresForTargets(targetCells) {
    (Array.isArray(targetCells) ? targetCells : []).forEach((target) => {
      failuresByTargetKey.delete(targetCellKey(target));
    });
  }

  function recordTaskFailures(task, resolveError) {
    const description = task.description;
    const failures = [];
    task.link.target_cells.forEach((target, index) => {
      const error = resolveError(index);
      const key = targetCellKey(target);
      if (!error) {
        failuresByTargetKey.delete(key);
        return;
      }
      const failure = {
        reference: task.link.reference,
        workbookPath: description?.bookPath || "",
        worksheet: description?.sheet || "",
        sourceCell: target.source_cell || "",
        destination: targetDestinationLabel(state?.model, target),
        error,
      };
      failuresByTargetKey.set(key, failure);
      failures.push(failure);
    });
    return failures;
  }

  function listFailures() {
    return Array.from(failuresByTargetKey.values()).map((failure) => ({ ...failure }));
  }

  function getTargetDecorationIndex() {
    const transposed = !!isTransposed();
    if (targetDecorationIndex?.transposed === transposed) return targetDecorationIndex.targets;
    const targets = new Map();
    links.forEach((link) => {
      const description = describeExcelReference(link.reference);
      const linkTargetKeys = new Set(link.target_cells.map(targetCellKey));
      link.target_cells.forEach((target) => {
        const display = actualToDisplayCell(target.row, target.column, transposed);
        const neighborBelongsToLink = (row, column) => linkTargetKeys.has(targetCellKey(
          displayToActualCell(row, column, transposed),
        ));
        targets.set(targetCellKey(target), {
          link,
          target,
          description,
          isArrayFormula: !!description?.isRange,
          edgeTop: !neighborBelongsToLink(display.row - 1, display.column),
          edgeRight: !neighborBelongsToLink(display.row, display.column + 1),
          edgeBottom: !neighborBelongsToLink(display.row + 1, display.column),
          edgeLeft: !neighborBelongsToLink(display.row, display.column - 1),
        });
      });
    });
    targetDecorationIndex = { transposed, targets };
    return targets;
  }

  function abort() {
    requestGeneration += 1;
    if (requestController) requestController.abort();
    requestController = null;
    pendingTargetKeys = new Set();
  }

  function load(value) {
    abort();
    failuresByTargetKey = new Map();
    links = normalizeDatasetExternalLinks(value);
    savedLinks = cloneLinks(links);
    notifyInventoryChanged();
  }

  function clear() {
    load([]);
  }

  function serialize() {
    return cloneLinks(links);
  }

  function isDirty() {
    return linksSnapshot(links) !== linksSnapshot(savedLinks);
  }

  function markClean(value = links) {
    links = normalizeDatasetExternalLinks(value);
    savedLinks = cloneLinks(links);
    notifyInventoryChanged();
  }

  function restoreSaved() {
    abort();
    failuresByTargetKey = new Map();
    links = cloneLinks(savedLinks);
    notifyInventoryChanged();
  }

  function linksForTargetCells(targetCells) {
    const keys = new Set((Array.isArray(targetCells) ? targetCells : []).map(targetCellKey));
    if (!keys.size) return new Set();
    const indexes = new Set();
    links.forEach((link, index) => {
      if (link.target_cells.some((target) => keys.has(targetCellKey(target)))) indexes.add(index);
    });
    return indexes;
  }

  function removeLinkIndexes(indexes) {
    if (!(indexes instanceof Set) || !indexes.size) return 0;
    const previousCount = links.length;
    links = links.filter((_link, index) => !indexes.has(index));
    const removed = previousCount - links.length;
    if (removed) notifyInventoryChanged();
    return removed;
  }

  function hardCodeTargetCells(targetCells) {
    const cells = Array.isArray(targetCells) ? targetCells : [];
    const indexes = linksForTargetCells(cells);
    const overlapsPendingRequest = cells.some((target) => pendingTargetKeys.has(targetCellKey(target)));
    if (overlapsPendingRequest) abort();
    return removeLinkIndexes(indexes);
  }

  function listRecords() {
    const groups = new Map();
    links.forEach((link, linkIndex) => {
      const description = describeExcelReference(link.reference);
      if (!description) return;
      const key = sourceGroupKey(description);
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          workbookPath: description.bookPath,
          worksheet: description.sheet,
          address: description.address,
          isRange: description.isRange,
          targets: new Map(),
          linkIndexes: [],
        });
      }
      const group = groups.get(key);
      group.linkIndexes.push(linkIndex);
      link.target_cells.forEach((target) => group.targets.set(targetCellKey(target), target));
    });
    return Array.from(groups.values()).map((group) => {
      const targets = Array.from(group.targets.values());
      const labels = targets.map((target) => targetDestinationLabel(state?.model, target));
      const destination = labels.length <= 1
        ? (labels[0] || "Data")
        : `${labels[0]} + ${labels.length - 1} more`;
      return {
        id: group.id,
        workbookPath: group.workbookPath,
        worksheet: group.worksheet,
        address: group.address,
        value: targetValuePreview(state?.model, targets, group.isRange),
        destination,
        affectedCellCount: targets.length,
        readOnly: !!isReadOnly(),
      };
    });
  }

  const UNPARSEABLE_REFERENCE_ERROR = "The saved link reference could not be read.";
  const UNAVAILABLE_TARGET_ERROR = "The linked dataset cell is no longer part of this dataset.";

  /**
   * Plans one batched workbook read for the given links.
   *
   * Every link contributes its source cells to a single request in link order,
   * and each task remembers where its cells start so a per-cell answer maps
   * back to the dataset cell that asked for it. A link whose reference no
   * longer parses, or whose dataset cells no longer exist, contributes nothing
   * to the request and is reported from `readable` instead.
   */
  function buildLinkReadPlan(scopedLinks) {
    const tasks = scopedLinks.map((link) => {
      const description = describeExcelReference(link.reference);
      const cells = link.target_cells.map((target) => target.source_cell);
      const validTargets = link.target_cells.every((target) => (
        state.model?.mask?.[target.row]?.[target.column] === true
        && Array.isArray(state.model?.values?.[target.row])
      ));
      return { link, description, cells, validTargets, start: -1, readable: false };
    });
    const items = [];
    tasks.forEach((task) => {
      task.start = items.length;
      task.readable = !!task.description
        && task.validTargets
        && task.cells.length === task.link.target_cells.length;
      if (!task.readable) return;
      task.cells.forEach((cell) => items.push({
        book_path: task.description.bookPath,
        sheet: task.description.sheet,
        cell,
      }));
    });
    return { tasks, items };
  }

  function unreadableTaskError(task) {
    return task.description ? UNAVAILABLE_TARGET_ERROR : UNPARSEABLE_REFERENCE_ERROR;
  }

  function emptyValidation(extra = {}) {
    return {
      ok: false,
      failures: [],
      failedCellCount: 0,
      newerWorkbooks: [],
      newerWorkbookCount: 0,
      unverifiedWorkbookCount: 0,
      ...extra,
    };
  }

  /**
   * Validates every saved link and reports which workbooks are newer, in one pass.
   *
   * The app server reads each stored source cell where it can reach the
   * workbook, so a renamed sheet, a moved workbook, or a deleted row that left
   * a `#REF!` comes back as that reference's own error rather than as a count,
   * and the workbook timestamps ride along from the same read. Values are never
   * applied here: a dataset that opens onto a broken reference keeps its saved
   * numbers and shows the broken cells red until the reference is fixed.
   */
  async function validateLinks(datasetMtime, options = {}) {
    if (!links.length || !state?.model) {
      failuresByTargetKey = new Map();
      return emptyValidation({ ok: true });
    }
    const generation = requestGeneration;
    const { tasks, items } = buildLinkReadPlan(links);
    let response = null;
    if (items.length) {
      try {
        response = await validateLinksBatch(items, { signal: options.signal });
      } catch (error) {
        if (error?.name === "AbortError") return emptyValidation({ aborted: true });
        return emptyValidation({
          error: String(error?.message || error || "Excel link validation failed."),
        });
      }
      if (generation !== requestGeneration) return emptyValidation({ stale: true });
      if (
        !response?.ok
        || !Array.isArray(response.results)
        || response.results.length !== items.length
      ) {
        return emptyValidation({
          error: String(response?.error || "Excel link validation failed."),
        });
      }
    }
    const results = Array.isArray(response?.results) ? response.results : [];
    const failures = [];
    tasks.forEach((task) => {
      failures.push(...recordTaskFailures(task, (index) => {
        if (!task.readable) return unreadableTaskError(task);
        const parsed = excelResultValue(results[task.start + index]);
        return parsed.ok ? "" : parsed.error;
      }));
    });
    const baseline = Number(datasetMtime);
    const newerWorkbooks = [];
    let unverifiedWorkbookCount = 0;
    (Array.isArray(response?.workbooks) ? response.workbooks : []).forEach((workbook) => {
      const mtime = Number(workbook?.mtime);
      if (!workbook?.ok || !Number.isFinite(mtime)) {
        unverifiedWorkbookCount += 1;
      } else if (Number.isFinite(baseline) && mtime > baseline + 0.001) {
        newerWorkbooks.push({ path: String(workbook.path || ""), mtime });
      }
    });
    return {
      ok: true,
      failures,
      failedCellCount: failures.length,
      newerWorkbooks,
      newerWorkbookCount: newerWorkbooks.length,
      unverifiedWorkbookCount,
    };
  }

  function breakLinks(ids) {
    if (isReadOnly()) return { ok: false, error: "This dataset is read-only." };
    const requestedIds = new Set(
      (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "")).filter(Boolean),
    );
    const groups = listRecords().filter((record) => requestedIds.has(record.id));
    if (!groups.length) return { ok: false, error: "The external link is no longer available." };
    const indexes = new Set();
    links.forEach((link, index) => {
      const description = describeExcelReference(link.reference);
      if (description && requestedIds.has(sourceGroupKey(description))) indexes.add(index);
    });
    const overlapsPendingRequest = links.some((link, index) => (
      indexes.has(index)
      && link.target_cells.some((target) => pendingTargetKeys.has(targetCellKey(target)))
    ));
    if (overlapsPendingRequest) abort();
    const removed = removeLinkIndexes(indexes);
    const affectedCellCount = groups.reduce(
      (count, group) => count + group.affectedCellCount,
      0,
    );
    return {
      ok: removed > 0,
      affectedCellCount,
      message: removed > 0
        ? `${groups.length === 1 ? "Link" : `${groups.length} links`} broken. Current dataset values are now hard-coded.`
        : "",
    };
  }

  function breakLink(id) {
    return breakLinks([id]);
  }

  function getCellLinkInfo(displayRow, displayColumn) {
    if (!state?.model) return null;
    const actual = displayToActualCell(displayRow, displayColumn, !!isTransposed());
    const key = targetCellKey(actual);
    const decoration = getTargetDecorationIndex().get(key);
    const link = decoration?.link;
    if (!link) return null;
    const description = decoration.description;
    const anchor = link.target_cells[0];
    if (!description || !anchor) return null;
    const transposed = !!isTransposed();
    return {
      id: sourceGroupKey(description),
      reference: link.reference,
      sourceCell: decoration.target?.source_cell || "",
      anchorDisplayRow: transposed ? anchor.column : anchor.row,
      anchorDisplayColumn: transposed ? anchor.row : anchor.column,
    };
  }

  function decorateCell(cell, displayRow, displayColumn) {
    if (!cell || !state?.model) return;
    const actual = displayToActualCell(displayRow, displayColumn, !!isTransposed());
    const key = targetCellKey(actual);
    const decoration = getTargetDecorationIndex().get(key);
    const link = decoration?.link;
    const isArrayFormula = !!decoration?.isArrayFormula;
    const failure = failuresByTargetKey.get(key);
    cell.classList.toggle("arExternalLinkCell", !!link);
    cell.classList.toggle("arExternalLinkErrorCell", !!failure);
    cell.classList.toggle("arArrayFormulaCell", isArrayFormula);
    cell.classList.toggle("arArrayFormulaEdgeTop", isArrayFormula && decoration.edgeTop);
    cell.classList.toggle("arArrayFormulaEdgeRight", isArrayFormula && decoration.edgeRight);
    cell.classList.toggle("arArrayFormulaEdgeBottom", isArrayFormula && decoration.edgeBottom);
    cell.classList.toggle("arArrayFormulaEdgeLeft", isArrayFormula && decoration.edgeLeft);
    cell.classList.remove("arExternalLinkAnchor");
    if (link) {
      cell.dataset.externalLinkReference = link.reference;
    } else {
      delete cell.dataset.externalLinkReference;
    }
    cell.removeAttribute?.("title");
  }

  async function commitReference({ displayRow, displayColumn, reference } = {}) {
    if (isReadOnly()) return { handled: true, ok: false, error: "This dataset is read-only." };
    const description = describeExcelReference(reference);
    if (!description) {
      return {
        handled: true,
        ok: false,
        error: "Enter an Excel link such as ='C:\\Folder\\[Book.xlsx]Sheet1'!A1:C3.",
      };
    }
    const targetResult = buildDatasetExternalLinkTargets({
      model: state?.model,
      transposed: !!isTransposed(),
      startRow: displayRow,
      startColumn: displayColumn,
      rowCount: description.range.rowCount,
      columnCount: description.range.colCount,
    });
    if (!targetResult.ok) return { handled: true, ...targetResult };
    const targets = targetResult.targets.map((target) => ({
      row: target.row,
      column: target.column,
      source_cell: sourceCellForOffset(
        description.range,
        target.rowOffset,
        target.columnOffset,
      ),
    }));
    if (targets.some((target) => !target.source_cell)) {
      return { handled: true, ok: false, error: "The Excel range mapping is invalid." };
    }

    abort();
    const generation = requestGeneration;
    requestController = new AbortController();
    pendingTargetKeys = new Set(targets.map(targetCellKey));
    const items = targets.map((target) => ({
      book_path: description.bookPath,
      sheet: description.sheet,
      cell: target.source_cell,
    }));
    let response;
    try {
      response = await readCellsBatch(items, { signal: requestController.signal });
    } catch (error) {
      if (error?.name === "AbortError") return { handled: true, ok: false, aborted: true };
      return { handled: true, ok: false, error: String(error?.message || error || "Excel read failed.") };
    } finally {
      if (generation === requestGeneration) {
        requestController = null;
        pendingTargetKeys = new Set();
      }
    }
    if (generation !== requestGeneration) return { handled: true, ok: false, stale: true };
    if (!response?.ok || !Array.isArray(response.results) || response.results.length !== items.length) {
      return { handled: true, ok: false, error: String(response?.error || "Excel range read failed.") };
    }
    const values = [];
    for (let index = 0; index < response.results.length; index += 1) {
      const parsed = excelResultValue(response.results[index]);
      if (!parsed.ok) {
        return { handled: true, ok: false, error: `${items[index].cell}: ${parsed.error}` };
      }
      values.push(parsed.value);
    }

    const overlapping = linksForTargetCells(targets);
    if (overlapping.size) {
      links = links.filter((_link, index) => !overlapping.has(index));
    }
    onTargetsClaimed(targets.map((target) => ({ row: target.row, column: target.column })));
    let changedCount = 0;
    targets.forEach((target, index) => {
      const value = values[index];
      const previous = state.model.values[target.row][target.column];
      if (!valuesEqual(previous, value)) changedCount += 1;
      state.model.values[target.row][target.column] = value;
      state.dirty.set(targetCellKey(target), value);
    });
    links.push({
      reference: normalizeReference(reference),
      target_cells: targets,
    });
    notifyInventoryChanged();
    return {
      handled: true,
      ok: true,
      changedCount,
      affectedCellCount: targets.length,
      reference: normalizeReference(reference),
    };
  }

  async function refreshAll(ids = null, options = {}) {
    const markRefreshedCellsDirty = options?.markRefreshedCellsDirty === true;
    const requestedIds = Array.isArray(ids)
      ? new Set(ids.map((id) => String(id || "")).filter(Boolean))
      : null;
    const scopedLinks = requestedIds
      ? links.filter((link) => {
        const description = describeExcelReference(link.reference);
        return description && requestedIds.has(sourceGroupKey(description));
      })
      : links;
    if (!scopedLinks.length || !state?.model) {
      return { linkedCellCount: 0, changedCount: 0, failedCount: 0, failures: [] };
    }
    abort();
    const generation = requestGeneration;
    requestController = new AbortController();
    pendingTargetKeys = new Set(scopedLinks.flatMap((link) => link.target_cells.map(targetCellKey)));
    const { tasks, items } = buildLinkReadPlan(scopedLinks);
    let response = null;
    if (items.length) {
      try {
        response = await readCellsBatch(items, { signal: requestController.signal });
      } catch (error) {
        if (error?.name === "AbortError") return { linkedCellCount: 0, changedCount: 0, failedCount: 0, failures: [], aborted: true };
        return {
          linkedCellCount: items.length,
          changedCount: 0,
          failedCount: items.length,
          failures: [],
          error: String(error?.message || error || "Excel refresh failed."),
        };
      } finally {
        if (generation === requestGeneration) {
          requestController = null;
          pendingTargetKeys = new Set();
        }
      }
      if (generation !== requestGeneration) {
        return { linkedCellCount: 0, changedCount: 0, failedCount: 0, failures: [], stale: true };
      }
      if (
        !response?.ok
        || !Array.isArray(response.results)
        || response.results.length !== items.length
      ) {
        // The request itself did not come back; that is a transport problem,
        // not a broken reference, so no cell is flagged as invalid.
        return {
          linkedCellCount: items.length,
          changedCount: 0,
          failedCount: items.length,
          failures: [],
          error: String(response?.error || "Excel refresh failed."),
        };
      }
    } else {
      requestController = null;
      pendingTargetKeys = new Set();
    }
    const results = response?.ok && Array.isArray(response.results) ? response.results : [];
    const failures = [];
    let linkedCellCount = 0;
    let changedCount = 0;
    let failedCount = 0;
    tasks.forEach((task) => {
      const count = task.link.target_cells.length;
      linkedCellCount += count;
      // Read every cell of the link before applying any of it: a link is
      // refreshed whole or not at all, so a broken reference can never leave
      // half of a range on new values and half on saved ones.
      const nextValues = [];
      const cellErrors = [];
      let linkFailed = false;
      for (let offset = 0; offset < count; offset += 1) {
        if (!task.readable) {
          cellErrors.push(unreadableTaskError(task));
          linkFailed = true;
          continue;
        }
        const parsed = excelResultValue(results[task.start + offset]);
        cellErrors.push(parsed.ok ? "" : parsed.error);
        if (parsed.ok) nextValues.push(parsed.value);
        else linkFailed = true;
      }
      failures.push(...recordTaskFailures(task, (index) => cellErrors[index]));
      if (linkFailed) {
        failedCount += count;
        return;
      }
      task.link.target_cells.forEach((target, index) => {
        const value = nextValues[index];
        const previous = state.model.values[target.row][target.column];
        const changed = !valuesEqual(previous, value);
        if (changed) {
          changedCount += 1;
          state.model.values[target.row][target.column] = value;
        }
        if (changed || markRefreshedCellsDirty) {
          state.dirty.set(targetCellKey(target), value);
        }
      });
    });
    return { linkedCellCount, changedCount, failedCount, failures };
  }

  return {
    abort,
    breakLink,
    breakLinks,
    clear,
    commitReference,
    decorateCell,
    hardCodeTargetCells,
    getCellLinkInfo,
    getLinkFailures: listFailures,
    isDirty,
    listRecords,
    load,
    markClean,
    refreshAll,
    restoreSaved,
    serialize,
    validateLinks,
  };
}
