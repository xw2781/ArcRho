import {
  containsExcelReference,
  findExcelReferences,
  parseStandaloneExcelRange,
} from "/ui/shared/integrations/excel_reference.js?v=20260715a";

export function dfmExternalLinkSourceKey(reference) {
  return [
    String(reference?.bookPath || "").toLowerCase(),
    String(reference?.sheet || "").toLowerCase(),
    String(reference?.cell || "").toUpperCase(),
    String(reference?.endCell || reference?.cell || "").toUpperCase(),
  ].join("\u001f");
}

function findRowIndex(rows, rowId) {
  return rows.findIndex((row) => String(row?.id || "") === String(rowId || ""));
}

export function getDfmExternalLinkRangeTargets({
  rows,
  rowId,
  startColumn,
  range,
  columnCount,
  isUserEntry,
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const anchorRowIndex = findRowIndex(sourceRows, rowId);
  const startCol = Number(startColumn);
  const availableColumnCount = Math.max(0, Number(columnCount) || 0);
  if (
    anchorRowIndex < 0
    || !range
    || !Number.isInteger(startCol)
    || startCol < 0
    || typeof isUserEntry !== "function"
  ) return [];

  const targets = [];
  for (let rowOffset = 0; rowOffset < range.rowCount; rowOffset += 1) {
    const cfg = sourceRows[anchorRowIndex + rowOffset];
    if (!isUserEntry(cfg)) break;
    for (let columnOffset = 0; columnOffset < range.colCount; columnOffset += 1) {
      const col = startCol + columnOffset;
      if (col < 0 || col >= availableColumnCount) continue;
      targets.push({ cfg, rowId: String(cfg.id), col });
    }
  }

  if (targets.length) return targets;
  const anchor = sourceRows[anchorRowIndex];
  return isUserEntry(anchor)
    ? [{ cfg: anchor, rowId: String(anchor.id), col: startCol }]
    : [];
}

export function collectDfmExternalLinkGroups({
  rows,
  columnCount,
  isUserEntry,
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  if (typeof isUserEntry !== "function") return groups;

  sourceRows.forEach((cfg) => {
    if (!isUserEntry(cfg)) return;
    const rowId = String(cfg?.id || "");
    const rawInputs = cfg?.inputs ?? cfg?.formulas;
    const inputs = Array.isArray(rawInputs) ? rawInputs : [];
    inputs.forEach((input, col) => {
      const raw = String(input || "").trim();
      if (!containsExcelReference(raw)) return;
      const references = findExcelReferences(raw.startsWith("=") ? raw : `=${raw}`);
      const standaloneRange = parseStandaloneExcelRange(raw);
      const ownerTargets = standaloneRange
        ? getDfmExternalLinkRangeTargets({
          rows: sourceRows,
          rowId,
          startColumn: col,
          range: standaloneRange,
          columnCount,
          isUserEntry,
        })
        : [{ cfg, rowId, col }];
      const ownerKey = `${rowId}\u001f${col}`;
      const seenSources = new Set();
      references.forEach((reference) => {
        const sourceKey = dfmExternalLinkSourceKey(reference);
        if (seenSources.has(sourceKey)) return;
        seenSources.add(sourceKey);
        if (!groups.has(sourceKey)) {
          groups.set(sourceKey, {
            id: sourceKey,
            reference,
            consumers: new Map(),
            targets: new Map(),
          });
        }
        const group = groups.get(sourceKey);
        group.consumers.set(ownerKey, { cfg, rowId, col, raw, standaloneRange });
        ownerTargets.forEach((target) => {
          group.targets.set(`${target.rowId}\u001f${target.col}`, target);
        });
      });
    });
  });
  return groups;
}

export function getDfmExternalLinkHardCodeTargets({
  group,
  rows,
  columnCount,
  isUserEntry,
} = {}) {
  const targets = new Map();
  group?.consumers?.forEach?.((consumer) => {
    const consumerTargets = consumer.standaloneRange
      ? getDfmExternalLinkRangeTargets({
        rows,
        rowId: consumer.rowId,
        startColumn: consumer.col,
        range: consumer.standaloneRange,
        columnCount,
        isUserEntry,
      })
      : [{ cfg: consumer.cfg, rowId: consumer.rowId, col: consumer.col }];
    consumerTargets.forEach((target) => {
      targets.set(`${target.rowId}\u001f${target.col}`, target);
    });
  });
  return targets;
}
