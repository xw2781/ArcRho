const STYLE_ID = "dfm-rpc-bridge-dialog-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dfmRpcOverlay {
      position: fixed;
      inset: 0;
      z-index: 12000;
      background: rgba(15, 23, 42, 0.18);
      box-sizing: border-box;
    }
    .dfmRpcWindow {
      position: fixed;
      width: min(980px, calc(100vw - 32px));
      min-width: min(620px, calc(100vw - 32px));
      height: min(760px, calc(100vh - 96px));
      min-height: 360px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 96px);
      display: flex;
      flex-direction: column;
      border: 1px solid #c8d0dc;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 22px 54px rgba(15, 23, 42, 0.24);
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      color: #172033;
      overflow: hidden;
      resize: both;
    }
    .dfmRpcMessageWindow {
      width: min(520px, calc(100vw - 32px));
      min-width: min(360px, calc(100vw - 32px));
      min-height: 0;
      height: auto;
      resize: none;
    }
    .dfmRpcOverlay.dfmRpcToastOverlay {
      align-items: flex-start;
      background: transparent;
      pointer-events: none;
      padding-top: 22px;
    }
    .dfmRpcToastOverlay .dfmRpcMessageWindow {
      width: min(420px, calc(100vw - 32px));
      min-width: min(280px, calc(100vw - 32px));
      pointer-events: auto;
    }
    .dfmRpcToastOverlay .dfmRpcHeader,
    .dfmRpcToastOverlay .dfmRpcActions {
      display: none;
    }
    .dfmRpcHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 32px;
      padding: 3px 12px;
      border-bottom: 1px solid #e2e7ef;
      background: #f7f9fc;
      cursor: move;
      user-select: none;
    }
    .dfmRpcTitle {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    .dfmRpcClose {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      box-sizing: border-box;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      color: #5b6678;
    }
    .dfmRpcHeader button {
      cursor: pointer;
    }
    .dfmRpcClose:hover { background: #edf1f7; color: #1f2937; }
    .dfmRpcBody {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      padding: 16px;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .dfmRpcMessageWindow .dfmRpcBody {
      min-height: 0;
      padding: 18px 20px;
      overflow: visible;
    }
    .dfmRpcStatus {
      margin: 0 0 14px;
      padding: 12px 14px;
      border-radius: 7px;
      border: 1px solid #c9d9f7;
      background: #eef5ff;
      color: #244a86;
      font-size: 13px;
      line-height: 1.4;
    }
    .dfmRpcStatus.warn {
      border-color: #ead19f;
      background: #fff5df;
      color: #7a5515;
    }
    .dfmRpcStatus.error {
      border-color: #efc1c1;
      background: #fff0f0;
      color: #9d2d2d;
    }
    .dfmRpcStatus.ok {
      border-color: #b9dac9;
      background: #ecf8f1;
      color: #206246;
    }
    .dfmRpcMessageWindow .dfmRpcStatus {
      margin: 0;
    }
    .dfmRpcGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      flex: 0 0 auto;
      min-height: 0;
      align-items: stretch;
    }
    .dfmRpcVersionCard {
      display: flex;
      flex-direction: column;
      border: 1px solid #d9e0ea;
      border-radius: 7px;
      background: #fbfcff;
      padding: 12px;
      min-width: 0;
      min-height: max-content;
      overflow: visible;
    }
    .dfmRpcVersionCard.selectable {
      cursor: pointer;
      transition: border-color 100ms ease-out, box-shadow 100ms ease-out, background 100ms ease-out;
    }
    .dfmRpcVersionCard.selectable:hover {
      border-color: #9fb7d9;
      background: #f7fbff;
    }
    .dfmRpcVersionCard.selected {
      border-color: #2457a6;
      box-shadow: inset 0 0 0 1px #2457a6;
      background: #f2f7ff;
    }
    .dfmRpcVersionCard.newest {
      border-color: #78b997;
      box-shadow: inset 0 0 0 1px #a8d9bd;
      background: #f3fbf6;
    }
    .dfmRpcVersionCard.newest.selected {
      border-color: #2457a6;
      box-shadow: inset 0 0 0 1px #2457a6, 0 0 0 2px rgba(99, 195, 132, 0.28);
    }
    .dfmRpcVersionTitle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 9px;
      font-size: 13px;
      font-weight: 700;
    }
    .dfmRpcSourceLabel {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 9px;
      border: 1px solid #2457a6;
      border-radius: 6px;
      background: #e8f0ff;
      color: #173d78;
      font-weight: 800;
      line-height: 1.2;
      white-space: nowrap;
    }
    .dfmRpcVersionBadges {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .dfmRpcNewSeal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 38px;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid #4d9a70;
      background: #e7f7ee;
      color: #17613a;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0;
      line-height: 1;
      white-space: nowrap;
    }
    .dfmRpcTimestampBadge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 1px 8px;
      border-radius: 999px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
    }
    .dfmRpcTimestampBadge.new {
      border: 1px solid #4d9a70;
      background: #e7f7ee;
      color: #17613a;
    }
    .dfmRpcTimestampBadge.old {
      border: 1px solid #c34646;
      background: #fff0f0;
      color: #9d2d2d;
    }
    .dfmRpcMeta {
      display: grid;
      gap: 7px;
      font-size: 12px;
      color: #4b5563;
    }
    .dfmRpcSnapshot {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 0 0 auto;
      min-height: auto;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #e2e7ef;
      overflow: visible;
    }
    .dfmRpcSnapshotTitle {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      color: #253046;
    }
    .dfmRpcPatternPreview {
      display: grid;
      gap: var(--dfmRpcPatternGap, 3px);
      align-items: start;
      justify-content: start;
      max-width: 100%;
      overflow: auto;
      padding: 6px;
      border: 1px solid #e2e7ef;
      border-radius: 5px;
      background: #fff;
    }
    .dfmRpcPatternRow {
      display: flex;
      gap: var(--dfmRpcPatternGap, 3px);
    }
    .dfmRpcPatternCell {
      width: var(--dfmRpcPatternCellWidth, 20px);
      height: var(--dfmRpcPatternCellHeight, 10px);
      flex: 0 0 auto;
      border: 1px solid #d8dee8;
      background: #f5f7fb;
    }
    .dfmRpcPatternCell.excludedCommon {
      border-color: #3f4650;
      background: #5a6470;
    }
    .dfmRpcPatternCell.excludedAdded {
      border-color: #4f9b70;
      background: #63c384;
    }
    .dfmRpcPatternCell.excludedRemoved {
      border-color: #c34646;
      background: #e95a5a;
    }
    .dfmRpcPatternCell.missingInsideTriangle {
      border-color: #e4c968;
      background: #fff3b8;
    }
    .dfmRpcPatternCell.masked {
      visibility: hidden;
      border-color: transparent;
      background: transparent;
    }
    .dfmRpcFormulaPreview {
      display: grid;
      gap: var(--dfmRpcFormulaGap, 3px);
      align-items: start;
      justify-content: start;
      max-width: 100%;
      overflow: auto;
      padding: 6px;
      border: 1px solid #e2e7ef;
      border-radius: 5px;
      background: #fff;
    }
    .dfmRpcFormulaRow {
      display: grid;
      grid-template-columns: minmax(86px, 116px) auto;
      gap: 3px;
      align-items: center;
      min-width: 0;
    }
    .dfmRpcFormulaLabel {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #5b6678;
      font-size: 11px;
      line-height: 1.2;
    }
    .dfmRpcFormulaCells {
      display: flex;
      gap: var(--dfmRpcFormulaGap, 3px);
      min-width: 0;
    }
    .dfmRpcPatternLegend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .dfmRpcPatternLegendItem {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      color: #5b6678;
      font-size: 11px;
      line-height: 1.2;
    }
    .dfmRpcNotesPreview {
      flex: 0 0 auto;
      min-height: 96px;
      max-height: 300px;
      height: auto;
      margin: 0;
      padding: 7px;
      border: 1px solid #e2e7ef;
      border-radius: 5px;
      background: #fff;
      box-sizing: border-box;
      overflow: auto;
      scrollbar-gutter: stable;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #253046;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.35;
    }
    .dfmRpcNoteDeleted,
    .dfmRpcNoteAdded {
      border-radius: 2px;
      padding: 0 1px;
    }
    .dfmRpcNoteDeleted {
      background: #ffd8d8;
      box-shadow: inset 0 0 0 1px #f3a6a6;
    }
    .dfmRpcNoteAdded {
      background: #dff5e7;
      box-shadow: inset 0 0 0 1px #99d7ad;
    }
    .dfmRpcActions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid #e2e7ef;
      background: #f7f9fc;
    }
    .dfmRpcMessageWindow .dfmRpcActions {
      padding: 10px 14px;
    }
    .dfmRpcConfirmText {
      margin: 0;
      color: #253046;
      font-size: 13px;
      line-height: 1.45;
    }
    .dfmRpcBtn {
      min-height: 30px;
      padding: 0 12px;
      border: 1px solid #c8d0dc;
      border-radius: 6px;
      background: #fff;
      color: #1f2937;
      cursor: pointer;
      font-size: 13px;
    }
    .dfmRpcBtn:hover:not(:disabled) { background: #f1f5fa; }
    .dfmRpcBtn.primary {
      border-color: #2457a6;
      background: #2457a6;
      color: #fff;
    }
    .dfmRpcBtn.primary:hover:not(:disabled) { background: #1f4d93; }
    .dfmRpcBtn:disabled {
      opacity: 0.58;
      cursor: wait;
    }
    .dfmRpcWindow .small {
      color: #5b6678;
      font-size: 12px;
      line-height: 1.35;
    }
    @media (max-width: 720px) {
      .dfmRpcWindow {
        min-width: min(360px, calc(100vw - 16px));
      }
      .dfmRpcGrid { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

function formatTime(meta) {
  if (!meta || !meta.exists) return "Missing";
  const rawTimestamp = String(meta.last_modified || "").trim();
  if (rawTimestamp) {
    return formatTimestampText(rawTimestamp) || rawTimestamp;
  }
  const jsonTimestamp = Number(meta.last_modified_timestamp);
  if (Number.isFinite(jsonTimestamp) && jsonTimestamp > 0) {
    return formatTimestampLabel(new Date(jsonTimestamp * 1000));
  }
  return "Missing last modified";
}

function formatTimestampText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = parseTimestampDate(raw);
  if (parsed) return formatTimestampLabel(parsed);
  const match = raw.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return match ? match[1] : "";
}

function parseTimestampDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (zone) {
    const normalizedZone = zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction || "0").slice(0, 3).padEnd(3, "0")}${normalizedZone}`);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((fraction || "0").slice(0, 3).padEnd(3, "0"))
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatTimestampLabel(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function comparisonMessage(comparison) {
  switch (comparison) {
    case "approval_pending":
      return { tone: "", text: "Review the proposed ArcBot edits before applying them." };
    case "remote_latest":
    case "local_latest":
      return { tone: "", text: "" };
    case "same_time":
      return { tone: "ok", text: "Local and remote are already in sync" };
    case "remote_missing":
      return { tone: "warn", text: "Remote DFM JSON is missing. No update action is available." };
    case "local_missing":
      return { tone: "error", text: "Local DFM JSON is missing. Save the DFM tab before syncing." };
    case "both_missing":
      return { tone: "error", text: "Local and remote DFM JSON files are missing." };
    default:
      return { tone: "", text: "DFM sync status is available." };
  }
}

function timestampsAreSame(local, remote) {
  if (!local?.exists || !remote?.exists) return false;
  const localModified = Number(local.last_modified_timestamp || 0);
  const remoteModified = Number(remote.last_modified_timestamp || 0);
  if (Number.isFinite(localModified) && localModified > 0 && Number.isFinite(remoteModified) && remoteModified > 0) {
    if (Math.abs(localModified - remoteModified) <= 1e-6) return true;
  }
  const localLabel = formatTime(local);
  const remoteLabel = formatTime(remote);
  return !!localLabel && localLabel !== "Missing" && localLabel === remoteLabel;
}

function resolveComparison(data) {
  const comparison = data?.comparison || "";
  if (comparison === "same_time") return comparison;
  return timestampsAreSame(data?.local || {}, data?.remote || {}) ? "same_time" : comparison;
}

function getOrderedVersions(data) {
  const local = data?.local || {};
  const remote = data?.remote || {};
  const labels = data?.labels && typeof data.labels === "object" ? data.labels : {};
  const actions = data?.actions && typeof data.actions === "object" ? data.actions : {};
  if (!local.exists || !remote.exists) return [];
  const localModified = Number(local.last_modified_timestamp || 0);
  const remoteModified = Number(remote.last_modified_timestamp || 0);
  if (timestampsAreSame(local, remote)) return [];
  const localVersion = {
    key: "local",
    source: labels.local || "ArcRho - Local",
    meta: local,
    snapshot: data?.snapshots?.local || {},
    action: actions.local || (resolveComparison(data) === "local_latest" ? "update-remote" : "keep-local"),
  };
  const remoteVersion = {
    key: "remote",
    source: labels.remote || "ResQ Server",
    meta: remote,
    snapshot: data?.snapshots?.remote || {},
    action: actions.remote || "update-local",
  };
  return [
    { ...localVersion, age: localModified < remoteModified ? "old" : "new" },
    { ...remoteVersion, age: remoteModified < localModified ? "old" : "new" },
  ];
}

function getPatternPreviewRows(pattern) {
  return Array.isArray(pattern?.preview) ? pattern.preview : [];
}

function getPatternCellValue(pattern, rowIndex, colIndex) {
  const row = getPatternPreviewRows(pattern)[rowIndex];
  if (!Array.isArray(row)) return 0;
  return Number(row[colIndex] ?? 0);
}

function normalizePatternCellValue(value) {
  const n = Number(value);
  if (n === 1) return 1;
  if (n === 2) return 2;
  return 0;
}

function getPatternOriginLabel(pattern, rowIndex, labelFallbacks = {}) {
  const labels = Array.isArray(pattern?.origin_labels) ? pattern.origin_labels : [];
  const fallbackLabels = Array.isArray(labelFallbacks?.origin_labels) ? labelFallbacks.origin_labels : [];
  return String(labels[rowIndex] ?? fallbackLabels[rowIndex] ?? "").trim();
}

function getPatternDevelopmentLabel(pattern, colIndex, labelFallbacks = {}) {
  const labels = Array.isArray(pattern?.development_labels) ? pattern.development_labels : [];
  const fallbackLabels = Array.isArray(labelFallbacks?.development_labels) ? labelFallbacks.development_labels : [];
  return String(labels[colIndex] ?? fallbackLabels[colIndex] ?? "").trim();
}

function getPatternTriangleDiagonal(pattern) {
  const rows = getPatternPreviewRows(pattern);
  let latestDataRowIndex = -1;
  let latestDataColIndex = -1;
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return;
    let rowLastDataColIndex = -1;
    row.forEach((cell, colIndex) => {
      if (normalizePatternCellValue(cell) !== 2) {
        rowLastDataColIndex = colIndex;
      }
    });
    if (rowLastDataColIndex >= 0) {
      latestDataRowIndex = rowIndex;
      latestDataColIndex = rowLastDataColIndex;
    }
  });
  return latestDataRowIndex >= 0 ? latestDataRowIndex + latestDataColIndex : -1;
}

function isPatternCellInsideTriangle(rowIndex, colIndex, diagonalIndex) {
  return diagonalIndex >= 0 && rowIndex + colIndex <= diagonalIndex;
}

function patternHasMissingInsideTriangle(pattern, diagonalIndex) {
  const rows = getPatternPreviewRows(pattern);
  return rows.some((row, rowIndex) => Array.isArray(row) && row.some((cell, colIndex) => (
    normalizePatternCellValue(cell) === 2 && isPatternCellInsideTriangle(rowIndex, colIndex, diagonalIndex)
  )));
}

function getPatternCellClass(value, otherValue, versionAge, insideTriangle) {
  if (value === 2) return insideTriangle ? "missingInsideTriangle" : "masked";
  if (value === 1 && otherValue === 1) return "excludedCommon";
  if (value === 1 && versionAge === "new") return "excludedAdded";
  if (value === 1 && versionAge === "old") return "excludedRemoved";
  return "";
}

function getSelectionCellClass(value, otherValue, versionAge) {
  if (value === 1 && otherValue === 1) return "excludedCommon";
  if (value === 1 && versionAge === "new") return "excludedAdded";
  if (value === 1 && versionAge === "old") return "excludedRemoved";
  return "";
}

function getPatternPreviewStyle(pattern) {
  const columns = Math.max(1, Number(pattern?.columns || 0));
  const gap = columns > 24 ? 2 : 3;
  const targetWidth = 360;
  const availableForCells = targetWidth - Math.max(0, columns - 1) * gap;
  const cellWidth = Math.max(6, Math.min(18, Math.floor(availableForCells / columns)));
  const cellHeight = Math.max(5, Math.round(cellWidth / 2));
  return [
    `--dfmRpcPatternGap:${gap}px`,
    `--dfmRpcPatternCellWidth:${cellWidth}px`,
    `--dfmRpcPatternCellHeight:${cellHeight}px`,
  ].join(";");
}

function getFormulaPreviewStyle(pattern) {
  const columns = Math.max(1, Number(pattern?.columns || 0));
  const gap = columns > 24 ? 2 : 3;
  const targetWidth = 360;
  const availableForCells = targetWidth - Math.max(0, columns - 1) * gap;
  const cellWidth = Math.max(6, Math.min(18, Math.floor(availableForCells / columns)));
  const cellHeight = Math.max(5, Math.round(cellWidth / 2));
  return [
    `--dfmRpcFormulaGap:${gap}px`,
    `--dfmRpcPatternCellWidth:${cellWidth}px`,
    `--dfmRpcPatternCellHeight:${cellHeight}px`,
  ].join(";");
}

function renderPatternLegend(versionAge, hasMissingInsideTriangle) {
  const legendItems = [
    '<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedCommon"></span>Common excluded</span>',
  ];
  if (versionAge === "new") {
    legendItems.push('<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedAdded"></span>Newly excluded</span>');
  } else if (versionAge === "old") {
    legendItems.push('<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedRemoved"></span>No longer excluded</span>');
  }
  if (hasMissingInsideTriangle) {
    legendItems.push('<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell missingInsideTriangle"></span>Missing inside triangle</span>');
  }
  return `<div class="dfmRpcPatternLegend">${legendItems.join("")}</div>`;
}

function renderSelectionLegend(versionAge) {
  const legendItems = [
    '<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedCommon"></span>Common selected</span>',
  ];
  if (versionAge === "new") {
    legendItems.push('<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedAdded"></span>Newly selected</span>');
  } else if (versionAge === "old") {
    legendItems.push('<span class="dfmRpcPatternLegendItem"><span class="dfmRpcPatternCell excludedRemoved"></span>No longer selected</span>');
  }
  return `<div class="dfmRpcPatternLegend">${legendItems.join("")}</div>`;
}

function renderPatternPreview(pattern, otherPattern, versionAge, labelFallbacks = {}) {
  if (!pattern?.exists) return `<div class="small">No excluded ratio triangle in this JSON.</div>`;
  const rows = getPatternPreviewRows(pattern);
  const style = getPatternPreviewStyle(pattern);
  const diagonalIndex = getPatternTriangleDiagonal(pattern);
  const hasMissingInsideTriangle = patternHasMissingInsideTriangle(pattern, diagonalIndex);
  const renderedRows = rows.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : [])
      .map((cell, colIndex) => {
        const value = normalizePatternCellValue(cell);
        const otherValue = normalizePatternCellValue(getPatternCellValue(otherPattern, rowIndex, colIndex));
        const cls = getPatternCellClass(
          value,
          otherValue,
          versionAge,
          isPatternCellInsideTriangle(rowIndex, colIndex, diagonalIndex),
        );
        const originLabel = getPatternOriginLabel(pattern, rowIndex, labelFallbacks);
        const developmentLabel = getPatternDevelopmentLabel(pattern, colIndex, labelFallbacks);
        const tooltip = originLabel || developmentLabel
          ? `Org: ${originLabel}\nDev: ${developmentLabel}`
          : "";
        return `<span class="dfmRpcPatternCell ${cls}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ""}></span>`;
      })
      .join("");
    return `<div class="dfmRpcPatternRow">${cells}</div>`;
  }).join("");
  return `
    <div class="small">${pattern.rows || 0} x ${pattern.columns || 0}; excluded cells: ${pattern.selected_count || 0}</div>
    ${renderPatternLegend(versionAge, hasMissingInsideTriangle)}
    <div class="dfmRpcPatternPreview" style="${style}">${renderedRows || '<div class="small">Empty preview</div>'}</div>
  `;
}

function getFormulaPreviewRows(pattern) {
  return Array.isArray(pattern?.preview) ? pattern.preview : [];
}

function getFormulaCellValue(pattern, rowIndex, colIndex) {
  const row = getFormulaPreviewRows(pattern)[rowIndex];
  if (!Array.isArray(row)) return 0;
  return Number(row[colIndex] ?? 0) === 1 ? 1 : 0;
}

function getFormulaLabel(pattern, rowIndex) {
  const labels = Array.isArray(pattern?.formula_labels) ? pattern.formula_labels : [];
  return String(labels[rowIndex] ?? `Formula ${rowIndex + 1}`).trim() || `Formula ${rowIndex + 1}`;
}

function findFormulaRowIndex(pattern, formulaLabel, fallbackIndex) {
  const target = String(formulaLabel || "").replace(/\s+/g, " ").trim().toLowerCase();
  const labels = Array.isArray(pattern?.formula_labels) ? pattern.formula_labels : [];
  if (target) {
    const labelIndex = labels.findIndex((label) => (
      String(label || "").replace(/\s+/g, " ").trim().toLowerCase() === target
    ));
    if (labelIndex >= 0) return labelIndex;
  }
  return fallbackIndex;
}

function getFormulaDevelopmentLabel(pattern, colIndex, labelFallbacks = {}) {
  const labels = Array.isArray(pattern?.development_labels) ? pattern.development_labels : [];
  const fallbackLabels = Array.isArray(labelFallbacks?.development_labels) ? labelFallbacks.development_labels : [];
  return String(labels[colIndex] ?? fallbackLabels[colIndex] ?? "").trim();
}

function renderFormulaPatternPreview(pattern, otherPattern, versionAge, labelFallbacks = {}) {
  if (!pattern?.exists) return `<div class="small">No average formula selections in this JSON.</div>`;
  const rows = getFormulaPreviewRows(pattern);
  const rowCount = Math.max(Number(pattern.rows || 0), rows.length);
  const colCount = Math.max(Number(pattern.columns || 0), rows.reduce((max, row) => (
    Math.max(max, Array.isArray(row) ? row.length : 0)
  ), 0));
  const style = getFormulaPreviewStyle({ ...pattern, columns: colCount });
  const renderedRows = Array.from({ length: rowCount }, (_unused, rowIndex) => {
    const formulaLabel = getFormulaLabel(pattern, rowIndex);
    const otherRowIndex = findFormulaRowIndex(otherPattern, formulaLabel, rowIndex);
    const cells = Array.from({ length: colCount }, (_item, colIndex) => {
      const value = getFormulaCellValue(pattern, rowIndex, colIndex);
      const otherValue = getFormulaCellValue(otherPattern, otherRowIndex, colIndex);
      const cls = getSelectionCellClass(value, otherValue, versionAge);
      const developmentLabel = getFormulaDevelopmentLabel(pattern, colIndex, labelFallbacks);
      const tooltip = developmentLabel
        ? `Formula: ${formulaLabel}\nDev: ${developmentLabel}`
        : `Formula: ${formulaLabel}`;
      return `<span class="dfmRpcPatternCell ${cls}" title="${escapeHtml(tooltip)}"></span>`;
    }).join("");
    return `
      <div class="dfmRpcFormulaRow">
        <span class="dfmRpcFormulaLabel" title="${escapeHtml(formulaLabel)}">${escapeHtml(formulaLabel)}</span>
        <span class="dfmRpcFormulaCells">${cells}</span>
      </div>
    `;
  }).join("");
  return `
    <div class="small">${rowCount} x ${colCount}; selected cells: ${pattern.selected_count || 0}</div>
    ${renderSelectionLegend(versionAge)}
    <div class="dfmRpcFormulaPreview" style="${style}">${renderedRows || '<div class="small">Empty preview</div>'}</div>
  `;
}

function getSnapshotCellNotesText(snapshot) {
  const entries = Array.isArray(snapshot?.cell_notes?.entries) ? snapshot.cell_notes.entries : [];
  if (!entries.length) return "";
  const lines = entries.map((entry) => {
    const table = String(entry?.table || "").trim();
    const row = String(entry?.row || "").trim();
    const column = String(entry?.column || "").trim();
    const note = String(entry?.note || "").trim();
    const prefix = table ? `${table}: ` : "";
    return `${prefix}Cell[${column}, ${row}] ${note}`;
  });
  if (snapshot?.cell_notes?.truncated) lines.push("...");
  return lines.join("\n");
}

function tokenizeNotes(text) {
  return String(text || "").match(/(\s+|[^\s]+)/g) || [];
}

function buildNoteDiff(oldText, newText) {
  const oldTokens = tokenizeNotes(oldText);
  const newTokens = tokenizeNotes(newText);
  const dp = Array.from({ length: oldTokens.length + 1 }, () => new Array(newTokens.length + 1).fill(0));
  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const deleted = new Array(oldTokens.length).fill(false);
  const added = new Array(newTokens.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deleted[i] = true;
      i += 1;
    } else {
      added[j] = true;
      j += 1;
    }
  }
  while (i < oldTokens.length) {
    deleted[i] = true;
    i += 1;
  }
  while (j < newTokens.length) {
    added[j] = true;
    j += 1;
  }
  return { oldTokens, newTokens, deleted, added };
}

function renderHighlightedTokens(tokens, flags, className) {
  let html = "";
  let buffer = "";
  let highlighted = false;
  const isWhitespace = (token) => /^\s+$/.test(String(token ?? ""));
  const isInlineWhitespace = (token) => isWhitespace(token) && !/[\r\n]/.test(String(token ?? ""));
  const isChangedTextToken = (index) => !!flags[index] && !isWhitespace(tokens[index]);
  const flush = () => {
    if (!buffer) return;
    const text = escapeHtml(buffer);
    html += highlighted ? `<span class="${className}">${text}</span>` : text;
    buffer = "";
  };
  tokens.forEach((token, index) => {
    const connectsChangedText = isInlineWhitespace(token)
      && isChangedTextToken(index - 1)
      && isChangedTextToken(index + 1);
    const nextHighlighted = (!!flags[index] && !isWhitespace(token)) || connectsChangedText;
    if (nextHighlighted !== highlighted) {
      flush();
      highlighted = nextHighlighted;
    }
    buffer += token;
  });
  flush();
  return html;
}

function renderCellNotesPreview(version, otherVersion) {
  const notes = getSnapshotCellNotesText(version.snapshot);
  if (!notes) return escapeHtml("No cell notes");
  if (!otherVersion || (version.age !== "old" && version.age !== "new")) {
    return escapeHtml(notes);
  }

  const otherNotes = getSnapshotCellNotesText(otherVersion.snapshot);
  const oldNotes = version.age === "old" ? notes : otherNotes;
  const newNotes = version.age === "new" ? notes : otherNotes;
  const diff = buildNoteDiff(oldNotes, newNotes);
  if (version.age === "old") {
    return renderHighlightedTokens(diff.oldTokens, diff.deleted, "dfmRpcNoteDeleted");
  }
  return renderHighlightedTokens(diff.newTokens, diff.added, "dfmRpcNoteAdded");
}

function versionPrimaryLabel(version) {
  if (version?.primaryLabel) return String(version.primaryLabel);
  if (version?.action === "update-remote") return "Confirm";
  if (version?.action === "update-local") return "Confirm";
  if (version?.action === "accept-agent-edit") return "Accept";
  if (version?.action === "reject-agent-edit") return "Reject";
  if (version?.key === "local") return "Keep Using Local";
  if (version?.key === "remote") return "Use Remote Version";
  return "Use Selected Version";
}

function clampDialogPosition(dialogWindow, left, top) {
  const margin = 8;
  const rect = dialogWindow.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - Math.min(96, rect.width));
  const maxTop = Math.max(margin, window.innerHeight - Math.min(80, rect.height));
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}

function placeDialogWindow(dialogWindow) {
  const rect = dialogWindow.getBoundingClientRect();
  const top = Math.min(64, Math.max(16, Math.floor(window.innerHeight * 0.08)));
  const left = Math.max(8, Math.round((window.innerWidth - rect.width) / 2));
  const clamped = clampDialogPosition(dialogWindow, left, top);
  dialogWindow.style.left = `${clamped.left}px`;
  dialogWindow.style.top = `${clamped.top}px`;
}

function enableDialogDrag(dialogWindow, header) {
  if (!dialogWindow || !header) return;
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    const rect = dialogWindow.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    header.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const onPointerMove = (moveEvent) => {
      const nextLeft = startLeft + moveEvent.clientX - startX;
      const nextTop = startTop + moveEvent.clientY - startY;
      const clamped = clampDialogPosition(dialogWindow, nextLeft, nextTop);
      dialogWindow.style.left = `${clamped.left}px`;
      dialogWindow.style.top = `${clamped.top}px`;
    };
    const onPointerUp = () => {
      header.releasePointerCapture?.(event.pointerId);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  });
}

function renderVersionCard(version, selectedKey, versions, labelFallbacks = {}) {
  const snapshot = version.snapshot || {};
  const otherVersion = Array.isArray(versions)
    ? versions.find((item) => item.key !== version.key)
    : null;
  const otherPattern = otherVersion?.snapshot?.ratio_pattern || {};
  const otherFormulaPattern = otherVersion?.snapshot?.average_formula_pattern || {};
  return `
    <div
      class="dfmRpcVersionCard selectable ${version.age === "new" ? "newest" : ""} ${selectedKey === version.key ? "selected" : ""}"
      data-version-source="${version.key}"
      role="radio"
      aria-checked="${selectedKey === version.key ? "true" : "false"}"
      tabindex="0"
    >
      <div class="dfmRpcVersionTitle">
        <span class="dfmRpcSourceLabel">${escapeHtml(version.source)}</span>
        <span class="dfmRpcVersionBadges">${version.age === "new" ? '<span class="dfmRpcNewSeal">NEW</span>' : ""}</span>
      </div>
      <div class="dfmRpcMeta">
        <div><strong>Last Modified:</strong> <span class="dfmRpcTimestampBadge ${version.age === "new" ? "new" : "old"}">${escapeHtml(formatTime(version.meta))}</span></div>
      </div>
      <div class="dfmRpcSnapshot">
        <p class="dfmRpcSnapshotTitle">Ratio Selection Snapshot</p>
        ${renderPatternPreview(snapshot.ratio_pattern || {}, otherPattern, version.age, labelFallbacks)}
        <p class="dfmRpcSnapshotTitle">Average Formulas</p>
        ${renderFormulaPatternPreview(snapshot.average_formula_pattern || {}, otherFormulaPattern, version.age, labelFallbacks)}
        <p class="dfmRpcSnapshotTitle">Cell Notes</p>
        <pre class="dfmRpcNotesPreview">${renderCellNotesPreview(version, otherVersion)}</pre>
      </div>
    </div>
  `;
}

export function createDfmRpcBridgeDialog(options = {}) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "dfmRpcOverlay";
  overlay.innerHTML = `
    <div class="dfmRpcWindow" role="dialog" aria-modal="true" aria-labelledby="dfmRpcTitle">
      <div class="dfmRpcHeader">
        <h2 class="dfmRpcTitle" id="dfmRpcTitle">Review Changes &amp; Select One Version</h2>
        <button class="dfmRpcClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="dfmRpcBody"></div>
      <div class="dfmRpcActions">
        <button class="dfmRpcBtn" type="button" data-action="refresh">Refresh</button>
        <button class="dfmRpcBtn primary" type="button" data-action="primary" style="display:none;"></button>
        <button class="dfmRpcBtn" type="button" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dialogWindow = overlay.querySelector(".dfmRpcWindow");
  const header = overlay.querySelector(".dfmRpcHeader");
  const body = overlay.querySelector(".dfmRpcBody");
  const closeBtns = overlay.querySelectorAll(".dfmRpcClose, [data-action='close']");
  const refreshBtn = overlay.querySelector("[data-action='refresh']");
  const primaryBtn = overlay.querySelector("[data-action='primary']");
  let onRefresh = null;
  let onPrimary = null;
  let currentVersions = [];
  let selectedVersionKey = "";

  placeDialogWindow(dialogWindow);
  enableDialogDrag(dialogWindow, header);

  function close(reason = "user") {
    overlay.remove();
    if (typeof options?.onClose === "function") {
      options.onClose(reason);
    }
  }

  closeBtns.forEach((btn) => btn.addEventListener("click", () => close("user")));
  refreshBtn?.addEventListener("click", async () => {
    if (typeof onRefresh !== "function") return;
    await onRefresh();
  });
  primaryBtn?.addEventListener("click", async () => {
    if (typeof onPrimary !== "function") return;
    await onPrimary(primaryBtn.dataset.primaryAction || "", selectedVersionKey);
  });

  function setBusy(busy) {
    overlay.querySelectorAll("button").forEach((btn) => {
      if (btn.classList.contains("dfmRpcClose")) return;
      btn.disabled = !!busy;
    });
  }

  function setWaiting(text) {
    primaryBtn.style.display = "none";
    body.innerHTML = `<div class="dfmRpcStatus">${text || "Waiting..."}</div>`;
  }

  function setMessage(text, tone = "") {
    primaryBtn.style.display = "none";
    const toneClass = tone ? ` ${tone}` : "";
    body.innerHTML = `<div class="dfmRpcStatus${toneClass}">${text || ""}</div>`;
  }

  function setComparison(data, handlers = {}) {
    onRefresh = handlers.onRefresh || null;
    onPrimary = handlers.onPrimary || null;
    const labelFallbacks = handlers.labelFallbacks || {};
    const comparison = resolveComparison(data);
    const msg = comparisonMessage(comparison);
    currentVersions = getOrderedVersions(data);
    selectedVersionKey = currentVersions.find((version) => version.age === "new")?.key || "";
    if (currentVersions.length) {
      body.innerHTML = `
        ${msg.text ? `<div class="dfmRpcStatus ${msg.tone}">${msg.text}</div>` : ""}
        <div class="dfmRpcGrid" role="radiogroup" aria-label="DFM version selection">
          ${currentVersions.map((version) => renderVersionCard(version, selectedVersionKey, currentVersions, labelFallbacks)).join("")}
        </div>
      `;
      body.querySelectorAll("[data-version-source]").forEach((card) => {
        const selectCard = () => {
          selectedVersionKey = card.dataset.versionSource || "";
          const selected = currentVersions.find((version) => version.key === selectedVersionKey);
          primaryBtn.textContent = versionPrimaryLabel(selected);
          primaryBtn.dataset.primaryAction = selected?.action || "";
          body.querySelectorAll("[data-version-source]").forEach((item) => {
            const checked = item.dataset.versionSource === selectedVersionKey;
            item.classList.toggle("selected", checked);
            item.setAttribute("aria-checked", checked ? "true" : "false");
          });
        };
        card.addEventListener("click", selectCard);
        card.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          selectCard();
        });
      });
      const selected = currentVersions.find((version) => version.key === selectedVersionKey);
      primaryBtn.textContent = versionPrimaryLabel(selected);
      primaryBtn.dataset.primaryAction = selected?.action || "";
      primaryBtn.style.display = "";
    } else {
      currentVersions = [];
      selectedVersionKey = "";
      const local = data?.local || {};
      const remote = data?.remote || {};
      body.innerHTML = `
        <div class="dfmRpcStatus ${msg.tone}">${msg.text}</div>
        <div class="dfmRpcGrid">
          <div class="dfmRpcVersionCard">
            <div class="dfmRpcVersionTitle"><span class="dfmRpcSourceLabel">ArcRho - Local</span></div>
            <div class="dfmRpcMeta">
              <div><strong>Last Modified:</strong> ${escapeHtml(formatTime(local))}</div>
            </div>
          </div>
          <div class="dfmRpcVersionCard">
            <div class="dfmRpcVersionTitle"><span class="dfmRpcSourceLabel">ResQ Server</span></div>
            <div class="dfmRpcMeta">
              <div><strong>Last Modified:</strong> ${escapeHtml(formatTime(remote))}</div>
            </div>
          </div>
        </div>
      `;
      primaryBtn.style.display = "none";
      primaryBtn.dataset.primaryAction = "";
    }
  }

  return {
    close,
    setBusy,
    setComparison,
    setMessage,
    setWaiting,
  };
}

export function createDfmRpcBridgeMessageBox(initialText = "", tone = "", options = {}) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "dfmRpcOverlay";
  const title = String(options?.title || "DFM Sync");
  overlay.innerHTML = `
    <div class="dfmRpcWindow dfmRpcMessageWindow" role="dialog" aria-modal="true" aria-labelledby="dfmRpcMessageTitle">
      <div class="dfmRpcHeader">
        <h2 class="dfmRpcTitle" id="dfmRpcMessageTitle">${escapeHtml(title)}</h2>
        <button class="dfmRpcClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="dfmRpcBody"></div>
      <div class="dfmRpcActions">
        <button class="dfmRpcBtn" type="button" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dialogWindow = overlay.querySelector(".dfmRpcWindow");
  const header = overlay.querySelector(".dfmRpcHeader");
  const body = overlay.querySelector(".dfmRpcBody");
  const closeBtns = overlay.querySelectorAll(".dfmRpcClose, [data-action='close']");
  let busyState = false;
  let pendingAutoDismiss = false;
  let dismissTimer = null;
  const autoDismissMs = Math.max(0, Number(options?.autoDismissMs ?? 2000));

  placeDialogWindow(dialogWindow);
  enableDialogDrag(dialogWindow, header);

  function close() {
    document.removeEventListener("keydown", onKeyDown);
    if (dismissTimer) clearTimeout(dismissTimer);
    overlay.remove();
  }

  function showTemporaryNotification() {
    if (dismissTimer || busyState || !pendingAutoDismiss) return;
    overlay.classList.add("dfmRpcToastOverlay");
    dialogWindow.classList.add("dfmRpcToastWindow");
    dialogWindow.setAttribute("role", "status");
    dialogWindow.removeAttribute("aria-modal");
    dialogWindow.removeAttribute("aria-labelledby");
    dismissTimer = setTimeout(close, autoDismissMs);
  }

  function setBusy(busy) {
    busyState = !!busy;
    overlay.querySelectorAll("button").forEach((btn) => {
      if (btn.classList.contains("dfmRpcClose")) return;
      btn.disabled = !!busy;
    });
    showTemporaryNotification();
  }

  function setMessage(text, nextTone = "") {
    const toneClass = nextTone ? ` ${nextTone}` : "";
    body.innerHTML = `<div class="dfmRpcStatus${toneClass}">${escapeHtml(text || "")}</div>`;
    pendingAutoDismiss = nextTone === "ok";
    showTemporaryNotification();
  }

  function setWaiting(text) {
    pendingAutoDismiss = false;
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    setMessage(text || "Waiting...");
  }

  function closeIfIdle() {
    if (!busyState) close();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeIfIdle();
  }

  closeBtns.forEach((btn) => btn.addEventListener("click", close));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeIfIdle();
  });
  document.addEventListener("keydown", onKeyDown);
  setMessage(initialText || "Ready.", tone);

  return {
    close,
    setBusy,
    setMessage,
    setWaiting,
  };
}

export function confirmDfmRpcBridgeAction(message, options = {}) {
  ensureStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dfmRpcOverlay";
    const title = String(options?.title || "Confirm DFM Sync");
    const confirmLabel = String(options?.confirmLabel || "Confirm");
    const cancelLabel = String(options?.cancelLabel || "Cancel");
    overlay.innerHTML = `
      <div class="dfmRpcWindow dfmRpcMessageWindow" role="dialog" aria-modal="true" aria-labelledby="dfmRpcConfirmTitle">
        <div class="dfmRpcHeader">
          <h2 class="dfmRpcTitle" id="dfmRpcConfirmTitle">${escapeHtml(title)}</h2>
          <button class="dfmRpcClose" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="dfmRpcBody">
          <p class="dfmRpcConfirmText">${escapeHtml(message || "")}</p>
        </div>
        <div class="dfmRpcActions">
          <button class="dfmRpcBtn" type="button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button class="dfmRpcBtn primary" type="button" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const dialogWindow = overlay.querySelector(".dfmRpcWindow");
    const header = overlay.querySelector(".dfmRpcHeader");

    placeDialogWindow(dialogWindow);
    enableDialogDrag(dialogWindow, header);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    }

    overlay.querySelector(".dfmRpcClose")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='cancel']")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='confirm']")?.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeyDown);
  });
}
