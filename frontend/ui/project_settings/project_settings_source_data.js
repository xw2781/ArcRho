/**
 * Source Data tab - quiet surface with detail in floating panels.
 *
 * Owns the header identity line, the draggable Import Settings window (import
 * method, CSV or SQL Server source, and the Import Data action), the
 * reserving-period band notes, the column list (filter, resize, distribution
 * marks), the floating table-details panel, floating per-column preview, and
 * shared month picker.
 *
 * The Import Settings window reuses the page's `.rct-row-editor` chrome, so it
 * behaves like the Dataset Type and Reserving Class Type editor windows: it is
 * centered on open, draggable by its title bar, and closes only from its close
 * button or Escape - never from an outside click.
 *
 * Path/date persistence stays in the coordinator-composed General Settings
 * feature, and every app-server call for the imported table is injected by the
 * coordinator.
 */

import { attachArcrhoTooltip } from "../shared/components/tooltip/tooltip.js";
import {
  SKELETON_BAR_CLASS,
  SKELETON_ROW_COUNT,
} from "./project_settings_skeleton.js?v=20260821pstree1";

const COLUMN_MIN_WIDTH = { name: 120, type: 74 };
const DETAILS_CLOSE_DELAY_MS = 160;
// The details panel opens on hover, so a live read of the source file is kept
// off the pointer moving in and out of the icon.
const FILE_STATUS_FRESH_MS = 3000;
const AREA_VIEWBOX_HEIGHT = 20;

export const SOURCE_TYPE_CSV = "csv";
export const SOURCE_TYPE_MSSQL = "mssql";
export const MSSQL_AUTH_WINDOWS = "windows";

/** Normalize an app-server `/source_table` payload into the shape this tab renders. */
export function normalizeSourceState(state) {
  const data = state && typeof state === "object" ? state : {};
  const mssql = data.mssql && typeof data.mssql === "object" ? data.mssql : {};
  const lastImport = data.last_import && typeof data.last_import === "object" ? data.last_import : {};
  const sourceType = String(data.source_type || "").trim().toLowerCase() === SOURCE_TYPE_MSSQL
    ? SOURCE_TYPE_MSSQL
    : SOURCE_TYPE_CSV;
  return {
    sourceType,
    csvPath: String(data.csv_path || ""),
    masterTablePath: String(data.master_table_path || ""),
    masterTableExists: !!data.master_table_exists,
    driverAvailable: data.driver_available !== false,
    mssql: {
      server: String(mssql.server || ""),
      database: String(mssql.database || ""),
      table: String(mssql.table || ""),
      authentication: String(mssql.authentication || MSSQL_AUTH_WINDOWS),
    },
    lastImport: {
      sourceType: String(lastImport.source_type || ""),
      sourceLabel: String(lastImport.source_label || ""),
      importedAt: String(lastImport.imported_at || ""),
      importedBy: String(lastImport.imported_by || ""),
      rowCount: lastImport.row_count,
      columnCount: lastImport.column_count,
      // Modified time of the external CSV that produced the current master
      // copy, recorded by the import contract in nanoseconds.
      csvMtimeNs: lastImport.csv_mtime_ns,
    },
  };
}

/** Header identity for the configured import source. */
export function getSourceIdentity(sourceState) {
  const state = sourceState || {};
  if (state.sourceType === SOURCE_TYPE_MSSQL) {
    const profile = state.mssql || {};
    const scope = [profile.server, profile.database].filter(Boolean).join(" · ");
    return {
      name: String(profile.table || "").trim() || "No SQL Server table",
      detail: scope,
      configured: !!(profile.server && profile.database && profile.table),
    };
  }
  const raw = String(state.csvPath || "").trim();
  if (!raw) return { name: "No source file", detail: "", configured: false };
  const idx = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
  return {
    name: idx < 0 ? raw : raw.slice(idx + 1),
    detail: idx < 0 ? "" : raw.slice(0, idx),
    configured: true,
  };
}

function clampRatio(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatPercent(ratio) {
  const value = clampRatio(ratio) * 100;
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

export function formatSummaryNumber(value, decimals = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (Number.isInteger(num) || decimals <= 0) return Math.round(num).toLocaleString("en-US");
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Hover label for each histogram bar.
 *
 * A date-role column is binned by calendar year, and the app server ships the
 * year each bar covers. Only a free-form numeric column has to describe its
 * bars as a range between two bin edges.
 */
export function getHistBarLabels(distribution) {
  const dist = distribution || {};
  const bins = Array.isArray(dist.bins) ? dist.bins : [];
  const labels = Array.isArray(dist.bin_labels) ? dist.bin_labels : null;
  if (labels && labels.length === bins.length) return labels.map((label) => String(label));
  return getHistBarRangeLabels(dist.edges, {
    asDate: !!dist.bin_labels,
    clippedLow: !!dist.clipped_low,
    clippedHigh: !!dist.clipped_high,
  });
}

export function getHistBarRangeLabels(
  edges,
  { asDate = false, clippedLow = false, clippedHigh = false } = {},
) {
  const values = Array.isArray(edges) ? edges.map(Number) : [];
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return [];
  const magnitude = Math.max(Math.abs(values[0]), Math.abs(values[values.length - 1]));
  const decimals = magnitude < 10 ? 4 : 0;
  const label = (value) =>
    (asDate ? String(Math.round(value)) : formatSummaryNumber(value, decimals));
  const lastIndex = values.length - 2;
  return values.slice(1).map((hi, index) => {
    // A clipped end bin also holds the outlying tail the drawn domain cut away,
    // so it covers everything past that edge rather than just its own span.
    if (clippedLow && index === 0) return `≤ ${label(hi)}`;
    if (clippedHigh && index === lastIndex) return `≥ ${label(values[index])}`;
    return `${label(values[index])} ~ ${label(hi)}`;
  });
}

/**
 * Fritsch-Carlson monotone cubic tangents.
 *
 * A plain Catmull-Rom fit overshoots around a sharp mode, and because the curve
 * is filled the overshoot shows as the area dipping under its own baseline.
 * Monotone tangents keep every segment inside its two endpoint values.
 */
function monotoneTangents(ys, step) {
  const n = ys.length;
  const slopes = [];
  for (let i = 0; i < n - 1; i += 1) slopes.push((ys[i + 1] - ys[i]) / step);
  const tangents = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    tangents[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slopes[i];
      tangents[i + 1] = scale * b * slopes[i];
    }
  }
  return tangents;
}

/** Closed, smoothly interpolated area silhouette for the row distribution mark. */
export function getDistributionAreaPath(bins) {
  const heights = Array.isArray(bins) ? bins : [];
  const last = heights.length - 1;
  if (last <= 0) return "";
  const step = 100 / last;
  const ys = heights.map((value) =>
    AREA_VIEWBOX_HEIGHT - clampRatio(value) * (AREA_VIEWBOX_HEIGHT - 2));
  const tangents = monotoneTangents(ys, step);
  let path = `M0,${AREA_VIEWBOX_HEIGHT} L0,${ys[0].toFixed(2)}`;
  for (let i = 0; i < last; i += 1) {
    const x0 = i * step;
    const x1 = (i + 1) * step;
    path += ` C${(x0 + step / 3).toFixed(2)},${(ys[i] + (tangents[i] * step) / 3).toFixed(2)}`
      + ` ${(x1 - step / 3).toFixed(2)},${(ys[i + 1] - (tangents[i + 1] * step) / 3).toFixed(2)}`
      + ` ${x1.toFixed(2)},${ys[i + 1].toFixed(2)}`;
  }
  return `${path} L100,${AREA_VIEWBOX_HEIGHT} Z`;
}

export function getColumnRowSummary(column, { asDate = false } = {}) {
  const stats = column?.stats;
  const dist = column?.distribution || {};

  if (stats && stats.min !== null && stats.min !== undefined
      && stats.max !== null && stats.max !== undefined) {
    // Date-role columns hold YYYYMM values: plain integers without grouping.
    if (asDate) {
      const toDateLabel = (v) => (typeof v === "number" ? String(Math.round(v)) : String(v));
      const min = toDateLabel(stats.min);
      const max = toDateLabel(stats.max);
      return min === max ? min : `${min} ~ ${max}`;
    }
    // Decimals only when the whole column stays small; large ranges read as 0,000.
    const bounds = [stats.min, stats.max].filter((v) => typeof v === "number").map(Math.abs);
    const decimals = bounds.length && Math.max(...bounds) < 10 ? 4 : 0;
    const min = typeof stats.min === "number" ? formatSummaryNumber(stats.min, decimals) : String(stats.min);
    const max = typeof stats.max === "number" ? formatSummaryNumber(stats.max, decimals) : String(stats.max);
    return min === max ? min : `${min} ~ ${max}`;
  }
  if (dist.kind === "categorical") {
    const distinct = Number(column?.distinct_count);
    const top = Array.isArray(dist.items) && dist.items.length ? dist.items[0] : null;
    const parts = [];
    if (Number.isFinite(distinct)) parts.push(`${distinct.toLocaleString("en-US")} distinct`);
    if (top) parts.push(`${String(top.label)} ${formatPercent(top.share)}`);
    if (parts.length) return parts.join(" · ");
  }
  return String(column?.values || "");
}

export function getLastClosedMonthCanonical(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(date.getTime())) return "";
  const lastClosed = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return `${String(lastClosed.getFullYear()).padStart(4, "0")}${String(lastClosed.getMonth() + 1).padStart(2, "0")}`;
}

export function getMonthPickerYearRange(selectedYear) {
  const endYear = Number(selectedYear);
  if (!Number.isInteger(endYear) || endYear < 1) return [];
  const startYear = Math.max(1, endYear - 50);
  return Array.from({ length: endYear - startYear + 1 }, (_unused, index) => startYear + index);
}

export function createSourceDataFeature(deps = {}) {
  const {
    escapeHtml = (value) => String(value ?? ""),
    setStatus = () => {},
    normalizeMonth = () => "",
    formatMonth = (value) => String(value || ""),
    getHostApi = () => (typeof window === "undefined"
      ? null
      : window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost),
    getConfiguredColumnWidths = () => null,
    // Injected by the coordinator; the tab never calls the app server itself.
    onProfileSave = async () => false,
    onListTables = async () => ({ ok: false, error: "Not available.", tables: [] }),
    onListConnections = async () => ({ connections: [] }),
    onForgetConnection = async () => ({ connections: [] }),
    onCsvPathPick = async () => "",
    onImportData = async () => ({ ok: false, error: "Not available." }),
    onSourceFileStatus = async () => null,
  } = deps;

  const el = (id) => document.getElementById(id);
  const dom = {
    root: el("tableSummary"),
    pathIdentity: el("summaryPathIdentity"),
    pathDisplay: el("summaryPathDisplay"),
    pathName: el("summaryPathName"),
    pathDir: el("summaryPathDir"),
    pathDirRow: el("summaryPathDirRow"),
    pathInput: el("summaryTablePathInput"),
    infoBtn: el("summaryInfoBtn"),
    openFolderBtn: el("summaryOpenFolderBtn"),
    reloadBtn: el("summaryTablePathReloadBtn"),
    importSettingsBtn: el("summaryImportSettingsBtn"),
    sourcePanel: el("summaryImportWindow"),
    sourcePanelHeader: el("summaryImportWindowHeader"),
    sourcePanelResizer: el("summaryImportWindowResizer"),
    sourcePanelClose: el("summaryImportWindowClose"),
    methodSelect: el("sdMethodSelect"),
    methodTrigger: el("sdMethodTrigger"),
    methodValue: el("sdMethodValue"),
    methodList: el("sdMethodList"),
    sourceMethods: Array.from(document.querySelectorAll(".sd-source-method")),
    csvPath: el("sdCsvPath"),
    csvBrowseBtn: el("sdCsvBrowseBtn"),
    mssqlServer: el("sdMssqlServer"),
    mssqlServerCombo: el("sdMssqlServerCombo"),
    mssqlServerHistoryBtn: el("sdMssqlServerHistoryBtn"),
    mssqlServerList: el("sdMssqlServerList"),
    mssqlDatabase: el("sdMssqlDatabase"),
    mssqlDatabaseCombo: el("sdMssqlDatabaseCombo"),
    mssqlDatabaseHistoryBtn: el("sdMssqlDatabaseHistoryBtn"),
    mssqlDatabaseList: el("sdMssqlDatabaseList"),
    mssqlLoadTablesBtn: el("sdMssqlLoadTablesBtn"),
    mssqlTableSelect: el("sdMssqlTableSelect"),
    mssqlTableInput: el("sdMssqlTableInput"),
    mssqlTableCaretBtn: el("sdMssqlTableCaretBtn"),
    mssqlTableList: el("sdMssqlTableList"),
    mssqlAuthGroup: el("sdMssqlAuthGroup"),
    importDataBtn: el("sdImportDataBtn"),
    mssqlStatus: el("sdMssqlStatus"),
    message: el("summaryMessage"),
    band: el("summaryPeriodsBand"),
    originSpanNote: el("summaryOriginSpanNote"),
    originStart: el("summaryOriginStartInput"),
    originEnd: el("summaryOriginEndInput"),
    developmentEnd: el("summaryDevelopmentEndInput"),
    monthPickerButtons: Array.from(document.querySelectorAll(".sd-month-picker-btn")),
    monthPicker: el("summaryMonthPicker"),
    monthPickerYear: el("summaryMonthPickerYear"),
    monthPickerGrid: el("summaryMonthPickerGrid"),
    monthPickerPrev: el("summaryMonthPickerPrevYear"),
    monthPickerNext: el("summaryMonthPickerNextYear"),
    columnsPanel: el("summaryColumnsPanel"),
    columnsHead: el("summaryColumnsHead"),
    filter: el("summaryColumnFilter"),
    count: el("summaryColumnCount"),
    list: el("summaryColumns"),
    statsCard: el("summaryStatsCard"),
    stats: el("summaryStats"),
  };

  let columns = [];
  let sourceState = normalizeSourceState(null);
  let sourcePanelOpen = false;
  let sourceBusy = false;
  // Method chosen inside the panel; only an import commits it to the project.
  let panelMethod = SOURCE_TYPE_CSV;
  let windowDragState = null;
  let windowResizeState = null;
  let connectionHistory = [];
  let previewCard = null;
  let previewRow = null;
  let previewCell = null;
  let detailsPinned = false;
  let detailsTimer = null;
  let activeMonthInput = null;
  let activeMonthPickerButton = null;
  let monthPickerYear = null;
  let monthPickerView = "months";
  let monthPickerPointerInside = false;
  let summaryLoading = false;
  let wired = false;
  // Live identity of the external source file, read when the details panel
  // opens. The import record only carries the modified time the file had when
  // the copy was taken, so it goes stale the moment someone rewrites the file.
  let fileStatus = null;
  let fileStatusAt = 0;
  let fileStatusPending = false;
  // Last summary payload the card was rendered from, so the live read can
  // redraw the rows on its own.
  let statsData = null;

  /* ---------------- helpers ---------------- */

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  // The app server resolves each column's date role from the project's field
  // mapping and publishes it on the column, so this tab reads it rather than
  // re-deriving the mapping rule from a separately fetched copy.
  function roleForColumn(column) {
    return String(column?.role || "").trim();
  }

  function monthIndex(value) {
    const canonical = normalizeMonth(value);
    if (!canonical) return null;
    const year = Number(canonical.slice(0, 4));
    const month = Number(canonical.slice(4, 6));
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    return (year * 12) + (month - 1);
  }

  function placeFloating(node, anchorRect, gap) {
    const margin = 8;
    const rect = node.getBoundingClientRect();
    let left = anchorRect.left;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
    if (left < margin) left = margin;
    let top = anchorRect.bottom + gap;
    if (top + rect.height > window.innerHeight - margin) top = anchorRect.top - rect.height - gap;
    if (top < margin) top = margin;
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function placeAtPointer(node, pointerX, pointerY) {
    const margin = 8;
    const offset = 16;
    const rect = node.getBoundingClientRect();
    let left = pointerX + offset;
    if (left + rect.width > window.innerWidth - margin) left = pointerX - offset - rect.width;
    if (left < margin) left = margin;
    let top = pointerY + offset;
    if (top + rect.height > window.innerHeight - margin) top = pointerY - offset - rect.height;
    if (top < margin) top = margin;
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function splitPath(path) {
    const raw = String(path || "").trim();
    if (!raw) return { name: "", dir: "" };
    const idx = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
    if (idx < 0) return { name: raw, dir: "" };
    return { name: raw.slice(idx + 1), dir: raw.slice(0, idx) };
  }

  function formatTimestamp(epochSeconds) {
    const seconds = Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  }

  /* ---------------- distribution marks ---------------- */

  function distributionMark(column) {
    const dist = column?.distribution || {};
    if (dist.kind === "numeric") {
      const bins = Array.isArray(dist.bins) ? dist.bins : [];
      const path = getDistributionAreaPath(bins);
      if (!path) return "";
      return `<svg class="sd-area" viewBox="0 0 100 ${AREA_VIEWBOX_HEIGHT}" preserveAspectRatio="none" aria-hidden="true">`
        + `<path d="${path}"></path></svg>`;
    }
    if (dist.kind === "categorical") {
      const items = Array.isArray(dist.items) ? dist.items : [];
      if (!items.length) return "";
      const rest = Number(dist.other_share || 0);
      return '<span class="sd-strip" aria-hidden="true">'
        + items.map((item, index) =>
            `<i style="flex:${Number(item.share || 0).toFixed(4)};opacity:${(1 - index * 0.13).toFixed(2)}"></i>`).join("")
        + (rest > 0.001 ? `<i class="rest" style="flex:${rest.toFixed(4)}"></i>` : "")
        + "</span>";
    }
    return "";
  }

  function previewHtml(column) {
    const dist = column?.distribution || {};
    const role = roleForColumn(column);
    const distinct = Number.isFinite(Number(column?.distinct_count)) && column.distinct_count !== null
      ? Number(column.distinct_count)
      : null;
    const meta = distinct !== null
      ? `<b>${distinct.toLocaleString()}</b> distinct values`
      : escapeHtml(String(column?.values || "").replace(/^Range:\s*/i, "Range "));
    const nullRatio = clampRatio(column?.null_ratio);
    const filledRatio = 1 - nullRatio;
    const filledPercent = formatPercent(filledRatio);
    const nullPercent = formatPercent(nullRatio);

    let body = "";
    if (dist.kind === "categorical" && Array.isArray(dist.items) && dist.items.length) {
      body = '<p class="sd-preview-section sd-preview-section-with-note"><span>Most Frequent</span><span>% of filled</span></p><div class="sd-bars">'
        + dist.items.map((item) => {
            const pct = clampRatio(item.share) * 100;
            const pctLabel = formatPercent(item.share);
            return `<div class="sd-bar-row" title="${escapeHtml(item.label)}: ${pctLabel}">`
              + `<span class="sd-bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>`
              + `<span class="sd-bar-track" role="meter" aria-label="${escapeHtml(item.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}" style="--sd-bar-share:${pct.toFixed(1)}%">`
              + '<span class="sd-bar-fill"></span></span>'
              + `<span class="sd-bar-pct">${pctLabel}</span></div>`;
          }).join("")
        + "</div>"
        + (Number(dist.other_count || 0) > 0
            ? `<p class="sd-preview-values">and ${Number(dist.other_count).toLocaleString()} more values</p>`
            : "");
    } else if (dist.kind === "numeric" && Array.isArray(dist.bins) && dist.bins.length) {
      // Full-height bar cells keep short bars hoverable; the title carries the
      // bar's year for a date column and its bin range otherwise.
      const rangeLabels = getHistBarLabels(dist);
      body = '<p class="sd-preview-section">Distribution</p><div class="sd-hist">'
        + dist.bins.map((value, index) => {
            const title = rangeLabels[index] ? ` title="${escapeHtml(rangeLabels[index])}"` : "";
            // No minimum height: a floor turns empty bins into a dashed baseline
            // that reads as data. Empty stays empty; the cell keeps the tooltip.
            return `<span class="sd-hist-bar"${title}>`
              + `<i style="height:${(clampRatio(value) * 100).toFixed(1)}%"></i></span>`;
          }).join("")
        + "</div>"
        + `<p class="sd-preview-values">${escapeHtml(String(column?.values || ""))}</p>`;
    } else {
      body = `<p class="sd-preview-values">${escapeHtml(String(column?.values || ""))}</p>`;
    }

    if (dist.kind === "categorical") {
      body += `<p class="sd-preview-values">Values: ${escapeHtml(String(column?.values || ""))}</p>`;
    }

    return '<div class="sd-preview-head">'
      + `<span class="sd-preview-name">${escapeHtml(column?.name)}</span>`
      + `<span class="sd-preview-type">${escapeHtml(role ? "Date" : column?.type)}${role ? ` &middot; ${escapeHtml(role)}` : ""}</span>`
      + "</div>"
      + `<div class="sd-preview-meta">${meta}</div>`
      + `<div class="sd-preview-completeness" aria-label="${filledPercent} filled, ${nullPercent} null">`
      + `<span><b>${filledPercent}</b> filled</span><span><b>${nullPercent}</b> null</span></div>`
      + body;
  }

  /* ---------------- column list ---------------- */

  function visibleColumns() {
    const query = String(dom.filter?.value || "").trim().toLowerCase();
    if (!query) return columns;
    return columns.filter((column) =>
      String(column?.name || "").toLowerCase().includes(query)
      || String(column?.values || "").toLowerCase().includes(query));
  }

  function renderColumns() {
    if (!dom.list) return;
    const rows = visibleColumns();
    if (!rows.length) {
      dom.list.innerHTML = '<div class="sd-empty-row">No columns match this filter.</div>';
    } else {
      dom.list.innerHTML = rows.map((column) => {
        const role = roleForColumn(column);
        const index = columns.indexOf(column);
        const summary = getColumnRowSummary(column, { asDate: !!role });
        const typeLabel = role ? "Date" : column?.type;
        return `<div class="sd-row" data-index="${index}" role="button" tabindex="0">`
          + '<span class="sd-c-name">'
          + `<span class="sd-row-name" title="${escapeHtml(column?.name)}">${escapeHtml(column?.name)}</span>`
          + (role ? `<span class="sd-row-role">${escapeHtml(role)}</span>` : "")
          + "</span>"
          + `<span class="sd-c-type"><span class="sd-row-type sd-type-${escapeHtml(typeLabel)}">${escapeHtml(typeLabel)}</span></span>`
          + '<span class="sd-c-dist">'
          + `<span class="sd-dist-mark">${distributionMark(column)}</span>`
          + `<span class="sd-dist-summary">${escapeHtml(summary)}</span>`
          + "</span>"
          + "</div>";
      }).join("");
    }
    if (dom.count) {
      dom.count.textContent = rows.length === columns.length
        ? String(columns.length)
        : `${rows.length} / ${columns.length}`;
    }
  }

  /* ---------------- floating column preview ---------------- */

  function ensurePreviewCard() {
    if (previewCard) return previewCard;
    previewCard = document.createElement("div");
    previewCard.className = "sd-preview-card";
    previewCard.setAttribute("role", "dialog");
    previewCard.setAttribute("aria-label", "Column distribution preview");
    previewCard.hidden = true;
    document.body.appendChild(previewCard);
    return previewCard;
  }

  function showPreview(row, pointer, { cell = null } = {}) {
    const column = columns[Number(row?.dataset?.index)];
    if (!column) return;
    const card = ensurePreviewCard();
    if (previewRow && previewRow !== row) previewRow.classList.remove("active");
    previewRow = row;
    previewCell = cell || row.querySelector(".sd-c-dist");
    row.classList.add("active");
    card.innerHTML = previewHtml(column);
    card.hidden = false;
    card.style.left = "-9999px";
    card.style.top = "0px";
    if (pointer) placeAtPointer(card, pointer.x, pointer.y);
    else placeFloating(card, (previewCell || row).getBoundingClientRect(), 6);
  }

  function hidePreview() {
    if (previewRow) previewRow.classList.remove("active");
    previewRow = null;
    previewCell = null;
    if (previewCard) previewCard.hidden = true;
  }

  /* ---------------- floating table details ---------------- */

  function formatIsoTimestamp(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString();
  }

  /**
   * Source CSV mtime in epoch seconds, or 0 for a SQL Server source.
   *
   * The live read of the file wins whenever the panel has one; the time
   * recorded at import stands in until it arrives, and stays when the file
   * cannot be reached.
   */
  function sourceCsvMtimeSeconds() {
    const live = fileStatus?.exists ? fileStatus.csv_mtime_ns : null;
    const nanoseconds = Number(live ?? sourceState.lastImport?.csvMtimeNs);
    if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0;
    return nanoseconds / 1e9;
  }

  /** Note beside `Modified` when the file no longer matches the imported copy. */
  function sourceCsvMtimeNote() {
    if (!fileStatus) return "";
    if (!fileStatus.exists) return "source file not reachable";
    return fileStatus.matches_import ? "" : "changed since the last import";
  }

  /** Read the source file's own identity, at most once every few seconds. */
  async function refreshFileStatus() {
    if (sourceState.sourceType === SOURCE_TYPE_MSSQL || fileStatusPending) return;
    if (fileStatus && Date.now() - fileStatusAt < FILE_STATUS_FRESH_MS) return;
    fileStatusPending = true;
    try {
      const status = await onSourceFileStatus();
      fileStatus = status && status.ok !== false ? status : null;
      fileStatusAt = Date.now();
      if (statsData) renderStats();
    } catch {
      // The recorded modified time stays on screen.
    } finally {
      fileStatusPending = false;
    }
  }

  function renderStats(data = statsData) {
    if (!dom.stats) return;
    statsData = data;
    const lastImport = sourceState.lastImport || {};
    const importedFrom = lastImport.sourceType === SOURCE_TYPE_MSSQL
      ? `SQL Server · ${lastImport.sourceLabel || ""}`
      : lastImport.sourceLabel;
    const rows = [
      { key: "Rows", value: Number(data?.row_count || 0).toLocaleString(), note: "" },
      { key: "Columns", value: String(data?.column_count ?? columns.length), note: "" },
      { key: "File Size", value: String(data?.file_size_str || ""), note: "CSV, comma delimited" },
      // The source CSV's own modified time as the file has it now, not the
      // master copy's - the copy is rewritten on import, so its mtime only
      // ever repeats "Imported At".
      { key: "Modified", value: formatTimestamp(sourceCsvMtimeSeconds()), note: sourceCsvMtimeNote() },
      // The imported copy is what every ArcRho consumer actually reads.
      { key: "Imported From", value: String(importedFrom || "").trim(), note: "" },
      {
        key: "Imported At",
        value: formatIsoTimestamp(lastImport.importedAt),
        note: lastImport.importedBy ? `by ${lastImport.importedBy}` : "",
      },
    ].filter((row) => row.value);

    dom.stats.innerHTML = rows.map((row) =>
      '<div class="sd-stat-row">'
      + `<span class="sd-stat-key">${escapeHtml(row.key)}</span>`
      + `<span class="sd-stat-val">${escapeHtml(row.value)}`
      + (row.note ? `<span class="sd-stat-note">${escapeHtml(row.note)}</span>` : "")
      + "</span></div>").join("");
  }

  function openDetails() {
    if (!dom.statsCard || !dom.infoBtn || dom.infoBtn.disabled) return;
    clearTimeout(detailsTimer);
    dom.statsCard.hidden = false;
    dom.statsCard.style.left = "-9999px";
    dom.statsCard.style.top = "0px";
    dom.infoBtn.setAttribute("aria-expanded", "true");
    placeFloating(dom.statsCard, dom.infoBtn.getBoundingClientRect(), 6);
    refreshFileStatus();
  }

  function closeDetails() {
    clearTimeout(detailsTimer);
    detailsPinned = false;
    if (dom.statsCard) dom.statsCard.hidden = true;
    if (dom.infoBtn) dom.infoBtn.setAttribute("aria-expanded", "false");
  }

  function scheduleCloseDetails() {
    if (detailsPinned) return;
    clearTimeout(detailsTimer);
    detailsTimer = setTimeout(closeDetails, DETAILS_CLOSE_DELAY_MS);
  }

  /* ---------------- column resizing ---------------- */

  function currentColumnWidth(key) {
    if (!dom.columnsPanel) return 0;
    const raw = getComputedStyle(dom.columnsPanel).getPropertyValue(`--sd-col-${key}`);
    return parseFloat(raw) || 0;
  }

  function applyConfiguredColumnWidths() {
    if (!dom.columnsPanel) return;
    const configured = getConfiguredColumnWidths() || null;
    if (!configured) return;
    ["name", "type"].forEach((key) => {
      const width = Math.round(Number(configured[key]));
      if (!Number.isFinite(width) || width <= 0) return;
      const min = COLUMN_MIN_WIDTH[key] || 80;
      dom.columnsPanel.style.setProperty(`--sd-col-${key}`, `${Math.max(min, width)}px`);
    });
  }

  function wireResizers() {
    if (!dom.columnsHead || !dom.columnsPanel) return;
    let drag = null;
    dom.columnsHead.querySelectorAll(".sd-resizer").forEach((handle) => {
      handle.addEventListener("mousedown", (event) => {
        const key = handle.dataset.col;
        if (!key) return;
        drag = { key, handle, startX: event.clientX, startWidth: currentColumnWidth(key) };
        handle.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        hidePreview();
        event.preventDefault();
      });
    });
    window.addEventListener("mousemove", (event) => {
      if (!drag) return;
      const min = COLUMN_MIN_WIDTH[drag.key] || 80;
      const next = Math.max(min, drag.startWidth + (event.clientX - drag.startX));
      dom.columnsPanel.style.setProperty(`--sd-col-${drag.key}`, `${next}px`);
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag.handle.classList.remove("dragging");
      drag = null;
      document.body.style.cursor = "";
    });
  }

  /* ---------------- path display ---------------- */

  function syncPathDisplay(path) {
    const isSql = sourceState.sourceType === SOURCE_TYPE_MSSQL;
    if (!isSql && path !== undefined) sourceState.csvPath = String(path ?? "");
    const identity = getSourceIdentity(sourceState);
    // Open folder acts on the external CSV selection; SQL Server has no path.
    const value = isSql ? "" : String(path ?? dom.pathInput?.value ?? "");
    const parts = isSql ? { name: identity.name, dir: identity.detail } : splitPath(value);

    if (dom.pathName) dom.pathName.textContent = identity.name;
    if (dom.pathDir) dom.pathDir.textContent = parts.dir;
    if (dom.pathDirRow) dom.pathDirRow.hidden = !parts.dir;
    if (dom.pathDisplay) {
      dom.pathDisplay.title = isSql ? [identity.detail, identity.name].filter(Boolean).join(" · ") : value;
      dom.pathDisplay.setAttribute(
        "aria-label",
        isSql ? "SQL Server source table" : "Edit source table path",
      );
    }
    const hasPath = !isSql && !!value.trim();
    if (dom.openFolderBtn) dom.openFolderBtn.disabled = !parts.dir || isSql;
    if (dom.infoBtn) dom.infoBtn.disabled = !(hasPath || (isSql && identity.configured) || sourceState.masterTableExists);
    if (dom.infoBtn?.disabled) closeDetails();
  }

  /**
   * Clicking the source identity opens the Import Settings panel.
   *
   * The panel is the one place that edits the source for either method, so the
   * old inline path input is no longer an editor; the coordinator keeps it as
   * the current CSV path it commits and the folder actions read.
   */
  function beginPathEdit() {
    if (sourcePanelOpen) closeSourcePanel();
    else openSourcePanel();
  }

  function endPathEdit() {
    if (!dom.pathInput || !dom.pathIdentity) return;
    dom.pathInput.hidden = true;
    dom.pathIdentity.hidden = false;
    syncPathDisplay(dom.pathInput.value);
  }

  /* ---------------- state ---------------- */

  function showMessage(text, isError = false) {
    if (!dom.message) return;
    const value = String(text || "").trim();
    dom.message.textContent = value;
    dom.message.classList.toggle("error", !!isError);
    dom.message.hidden = !value;
  }

  function setBodyVisible(visible) {
    if (dom.band) dom.band.hidden = !visible;
    if (dom.columnsPanel) dom.columnsPanel.hidden = !visible;
    if (!visible) closeMonthPicker({ force: true });
  }

  function loadingRowsHtml() {
    const bar = `${SKELETON_BAR_CLASS} sd-loading-bar`;
    return '<div class="sd-loading-rows" aria-hidden="true">'
      + Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => (
        `<div class="sd-row sd-loading-row" data-loading-row="${index}">`
        + `<span class="sd-c-name"><i class="${bar}"></i></span>`
        + `<span class="sd-c-type"><i class="${bar}"></i></span>`
        + `<span class="sd-c-dist"><i class="${bar} sd-loading-bar-mark"></i>`
        + `<i class="${bar} sd-loading-bar-summary"></i></span>`
        + "</div>"
      )).join("")
      + "</div>";
  }

  /** Keep the working surface stable while the imported table is copied/read. */
  function setSummaryLoading(loading, message = "") {
    summaryLoading = !!loading;
    dom.root?.classList.toggle("is-loading", summaryLoading);
    dom.root?.setAttribute("aria-busy", String(summaryLoading));
    [dom.originStart, dom.originEnd, dom.developmentEnd, ...dom.monthPickerButtons, dom.filter]
      .forEach((control) => {
        if (control) control.disabled = summaryLoading;
      });

    if (summaryLoading) {
      closeMonthPicker({ force: true });
      if (dom.list) {
        dom.list.classList.add("is-loading");
        dom.list.querySelector(".sd-loading-rows")?.remove();
        dom.list.insertAdjacentHTML("afterbegin", loadingRowsHtml());
      }
      if (dom.count) dom.count.textContent = "";
      showMessage(message || "Reading the source table...", false);
      return;
    }

    if (dom.list) {
      dom.list.classList.remove("is-loading");
      dom.list.querySelector(".sd-loading-rows")?.remove();
    }
  }

  function refreshOriginSpanNote() {
    if (!dom.originSpanNote) return;
    const start = monthIndex(dom.originStart?.value);
    const end = monthIndex(dom.originEnd?.value);
    if (start === null || end === null) {
      dom.originSpanNote.textContent = "";
      dom.originSpanNote.classList.remove("error");
      return;
    }
    if (end < start) {
      dom.originSpanNote.textContent = "start is after end";
      dom.originSpanNote.classList.add("error");
      return;
    }
    dom.originSpanNote.textContent = "";
    dom.originSpanNote.classList.remove("error");
  }

  /* ---------------- month picker ---------------- */

  function canonicalMonth(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || y < 1 || !Number.isInteger(m) || m < 1 || m > 12) return "";
    return `${String(y).padStart(4, "0")}${String(m).padStart(2, "0")}`;
  }

  function closeMonthPicker({ restoreFocus = false, force = false } = {}) {
    if (monthPickerPointerInside && !force) return;
    const button = activeMonthPickerButton;
    if (dom.monthPicker) dom.monthPicker.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    activeMonthInput = null;
    activeMonthPickerButton = null;
    monthPickerYear = null;
    monthPickerView = "months";
    monthPickerPointerInside = false;
    if (restoreFocus) button?.focus();
  }

  function setMonthPickerNavState(button, { hidden, disabled }) {
    if (!button) return;
    button.disabled = disabled;
    button.classList.toggle("is-year-view-hidden", hidden);
    if (hidden) button.setAttribute("aria-hidden", "true");
    else button.removeAttribute("aria-hidden");
  }

  function renderMonthPicker() {
    if (!dom.monthPickerGrid || !Number.isInteger(monthPickerYear)) return;
    const selected = normalizeMonth(activeMonthInput?.value);
    const showingYears = monthPickerView === "years";
    if (dom.monthPickerYear) dom.monthPickerYear.textContent = String(monthPickerYear);
    dom.monthPickerYear?.setAttribute("aria-expanded", String(showingYears));
    setMonthPickerNavState(dom.monthPickerPrev, {
      hidden: showingYears,
      disabled: showingYears || monthPickerYear <= 1,
    });
    setMonthPickerNavState(dom.monthPickerNext, {
      hidden: showingYears,
      disabled: showingYears,
    });
    dom.monthPickerGrid.dataset.view = showingYears ? "years" : "months";
    dom.monthPickerGrid.setAttribute("aria-label", showingYears ? "Choose year" : `Choose month in ${monthPickerYear}`);
    if (showingYears) {
      const years = getMonthPickerYearRange(monthPickerYear);
      dom.monthPickerGrid.innerHTML = years.map((year) => {
        const pressed = year === monthPickerYear ? "true" : "false";
        return `<button class="sd-month-picker-year-option" type="button" data-year="${year}" aria-pressed="${pressed}">${year}</button>`;
      }).join("");
      return;
    }
    dom.monthPickerGrid.innerHTML = Array.from({ length: 12 }, (_unused, index) => {
      const canonical = canonicalMonth(monthPickerYear, index + 1);
      const display = formatMonth(canonical);
      const label = String(display || canonical).split(/\s+/)[0];
      const pressed = canonical === selected ? "true" : "false";
      return `<button class="sd-month-picker-month" type="button" data-month="${canonical}" aria-label="${escapeHtml(display)}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
    }).join("");
  }

  function positionMonthPicker() {
    if (!dom.monthPicker || !activeMonthInput || dom.monthPicker.hidden) return;
    placeFloating(dom.monthPicker, activeMonthInput.getBoundingClientRect(), 6);
  }

  function focusMonthPickerTarget(selector) {
    setTimeout(() => {
      const target = dom.monthPickerGrid?.querySelector(selector)
        || dom.monthPickerGrid?.querySelector("button");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "nearest" });
    }, 0);
  }

  function toggleMonthPickerYearView() {
    if (!activeMonthInput || !Number.isInteger(monthPickerYear)) return;
    monthPickerView = monthPickerView === "years" ? "months" : "years";
    renderMonthPicker();
    positionMonthPicker();
    const selector = monthPickerView === "years"
      ? `[data-year="${monthPickerYear}"]`
      : '[aria-pressed="true"]';
    focusMonthPickerTarget(selector);
  }

  function showMonthPickerMonthsForYear(value) {
    const year = Number(value);
    if (!Number.isInteger(year) || !getMonthPickerYearRange(monthPickerYear).includes(year)) return;
    monthPickerYear = year;
    monthPickerView = "months";
    renderMonthPicker();
    positionMonthPicker();
    focusMonthPickerTarget('[aria-pressed="true"]');
  }

  function openMonthPicker(button) {
    if (!dom.monthPicker || !button) return;
    if (activeMonthPickerButton === button && !dom.monthPicker.hidden) {
      closeMonthPicker({ restoreFocus: true, force: true });
      return;
    }
    const input = el(button.dataset.monthPickerFor);
    if (!input || input.disabled) return;
    if (activeMonthPickerButton && activeMonthPickerButton !== button) {
      activeMonthPickerButton.setAttribute("aria-expanded", "false");
    }
    const base = normalizeMonth(input.value) || getLastClosedMonthCanonical();
    activeMonthInput = input;
    activeMonthPickerButton = button;
    monthPickerYear = Number(base.slice(0, 4));
    monthPickerView = "months";
    renderMonthPicker();
    dom.monthPicker.hidden = false;
    dom.monthPicker.style.left = "-9999px";
    dom.monthPicker.style.top = "0px";
    button.setAttribute("aria-expanded", "true");
    positionMonthPicker();
    focusMonthPickerTarget('[aria-pressed="true"]');
  }

  function applyPickerMonth(value) {
    const canonical = normalizeMonth(value);
    const input = activeMonthInput;
    if (!canonical || !input) return;
    input.value = formatMonth(canonical);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    closeMonthPicker({ force: true });
    input.focus();
  }

  /* ---------------- import settings window ---------------- */

  /**
   * App-styled listbox shared by the Import Method and Table Or View pickers.
   *
   * A native `select` popup cannot be themed, so both dropdowns are built from
   * the same trigger/list pair and behave identically.
   */
  const REMOVE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>';

  /** One markup shape for every dropdown row, selected state included. */
  function renderOptionRows(rows, selectedValue, { removable = false } = {}) {
    const selected = String(selectedValue || "");
    return rows.map((option) => {
      const value = String(option.value || "");
      const label = String(option.label || value);
      const kind = String(option.kind || "");
      return `<div class="sd-select-opt" role="option" data-value="${escapeHtml(value)}" aria-selected="${value === selected ? "true" : "false"}">`
        + `<span class="sd-select-opt-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`
        + (kind ? `<span class="sd-select-opt-kind">${escapeHtml(kind)}</span>` : "")
        + (removable
            ? `<button class="sd-select-opt-remove" type="button" data-remove="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(label)}">${REMOVE_ICON}</button>`
            : "")
        + "</div>";
    }).join("");
  }

  /** Anchor a body-rendered list under its field, flipping up when needed. */
  function positionListNear(list, anchor) {
    if (!list || list.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 3;
    list.style.width = `${Math.round(rect.width)}px`;
    list.style.left = "-9999px";
    list.style.top = "0px";
    const listRect = list.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - listRect.width - margin);
    let top = rect.bottom + gap;
    if (top + listRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - listRect.height - gap);
    }
    list.style.left = `${Math.round(Math.max(margin, left))}px`;
    list.style.top = `${Math.round(top)}px`;
  }

  /**
   * App-styled listbox on a button trigger, for a short fixed option set.
   *
   * Used by Import Method. Pickers that need typing use `createSdCombo`.
   */
  function createSdSelect({ root, trigger, valueEl, list, emptyText, placeholder, onChange }) {
    let options = [];

    // Lists render into document.body: the window is resizable
    // (`overflow: hidden`) and is centered with a transform, either of which
    // would otherwise clip or mis-anchor them.
    if (list && list.parentElement !== document.body) document.body.appendChild(list);

    const getValue = () => String(trigger?.dataset?.value || "");

    function render() {
      if (!list) return;
      if (!options.length) {
        list.innerHTML = `<div class="sd-select-empty">${escapeHtml(emptyText)}</div>`;
        return;
      }
      list.innerHTML = renderOptionRows(options, getValue());
    }

    function setValue(next, { notify = false } = {}) {
      const value = String(next || "");
      if (trigger) trigger.dataset.value = value;
      if (valueEl) {
        const match = options.find((option) => String(option.value || "") === value);
        valueEl.textContent = match?.label || value || placeholder;
      }
      render();
      if (notify) onChange?.(value);
    }

    function close() {
      if (!list || list.hidden) return;
      list.hidden = true;
      trigger?.setAttribute("aria-expanded", "false");
    }

    function open() {
      if (!list || !options.length || trigger?.disabled) return;
      render();
      list.hidden = false;
      trigger?.setAttribute("aria-expanded", "true");
      positionListNear(list, root);
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }

    trigger?.addEventListener("click", () => {
      if (list?.hidden) open();
      else close();
    });
    list?.addEventListener("click", (event) => {
      const option = event.target.closest(".sd-select-opt");
      if (!option) return;
      setValue(option.dataset.value, { notify: true });
      close();
      trigger?.focus();
    });

    return {
      root,
      getValue,
      setValue,
      open,
      close,
      positionList: () => positionListNear(list, root),
      isOpen: () => !!list && !list.hidden,
      hasOptions: () => options.length > 0,
      owns: (node) => !!(root?.contains(node) || list?.contains(node)),
      setOptions(next, { keepSelection = true } = {}) {
        options = Array.isArray(next) ? next : [];
        const previous = keepSelection ? getValue() : "";
        const stillPresent = options.some((option) => String(option.value || "") === previous);
        if (trigger) trigger.disabled = sourceBusy || !options.length;
        setValue(stillPresent ? previous : "");
      },
      setDisabled(disabled) {
        if (trigger) trigger.disabled = !!disabled || !options.length;
      },
    };
  }

  /**
   * Editable combobox: the field itself is the search box.
   *
   * Typing filters the list in place. The input lives in the window markup and
   * is never re-rendered, so the caret keeps its position across keystrokes -
   * re-rendering the field on every keystroke is what used to send the caret
   * back to the start.
   *
   * `freeText` fields (Server, Database) accept any value and use the list only
   * as history. A non-`freeText` field (Table Or View) must end on a listed
   * option, so the typed text is a filter and the committed value is kept
   * separately; leaving the field restores the committed label.
   */
  function createSdCombo({
    root,
    input,
    caret,
    list,
    emptyText,
    freeText = false,
    removable = false,
    onRemove,
  }) {
    let options = [];
    let committed = "";
    let filter = "";

    if (list && list.parentElement !== document.body) document.body.appendChild(list);

    const labelFor = (value) =>
      options.find((option) => String(option.value || "") === String(value || ""))?.label
      || String(value || "");

    function visibleOptions() {
      const query = filter.trim().toLowerCase();
      if (!query) return options;
      return options.filter((option) =>
        String(option.label || option.value || "").toLowerCase().includes(query));
    }

    function render() {
      if (!list) return;
      if (!options.length) {
        list.innerHTML = `<div class="sd-select-empty">${escapeHtml(emptyText)}</div>`;
        return;
      }
      const rows = visibleOptions();
      if (!rows.length) {
        list.innerHTML = `<div class="sd-select-empty">No match for "${escapeHtml(filter)}".</div>`;
        return;
      }
      const count = rows.length === options.length
        ? ""
        : `<div class="sd-select-count">${rows.length} of ${options.length}</div>`;
      list.innerHTML = count + renderOptionRows(rows, committed, { removable });
    }

    function close() {
      if (!list || list.hidden) return;
      list.hidden = true;
      caret?.setAttribute("aria-expanded", "false");
      input?.setAttribute("aria-expanded", "false");
    }

    /** Drop a half-typed filter and show what is actually committed. */
    function restoreCommittedText() {
      filter = "";
      if (input && !freeText) input.value = labelFor(committed);
    }

    function open({ selectAll = false } = {}) {
      if (!list || input?.disabled) return;
      render();
      list.hidden = false;
      caret?.setAttribute("aria-expanded", "true");
      input?.setAttribute("aria-expanded", "true");
      positionListNear(list, root);
      if (selectAll) input?.select();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }

    function commit(value, { notify = true } = {}) {
      committed = String(value || "");
      if (input) {
        input.value = freeText ? committed : labelFor(committed);
        if (freeText && notify) input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      filter = "";
      close();
    }

    input?.addEventListener("input", () => {
      filter = String(input.value || "");
      if (freeText) committed = filter;
      if (list?.hidden) open();
      else {
        render();
        positionListNear(list, root);
      }
    });
    input?.addEventListener("focus", () => {
      if (!freeText) open({ selectAll: true });
    });
    input?.addEventListener("blur", () => {
      // Deferred so a click on an option still lands before the revert.
      setTimeout(() => {
        if (list && !list.hidden) return;
        restoreCommittedText();
      }, 120);
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        restoreCommittedText();
        close();
        return;
      }
      if (event.key === "ArrowDown" && list?.hidden) {
        event.preventDefault();
        open();
        return;
      }
      if (event.key !== "Enter") return;
      const rows = visibleOptions();
      // A single remaining match commits without reaching for the mouse.
      if (rows.length === 1) {
        event.preventDefault();
        commit(rows[0].value);
        return;
      }
      if (!freeText) event.preventDefault();
    });

    caret?.addEventListener("click", () => {
      if (list?.hidden) {
        filter = "";
        open();
        input?.focus();
      } else {
        close();
      }
    });
    list?.addEventListener("mousedown", (event) => {
      // Keep focus in the field so blur does not fire before the click lands.
      event.preventDefault();
    });
    list?.addEventListener("click", (event) => {
      const remove = event.target.closest(".sd-select-opt-remove");
      if (remove) {
        event.stopPropagation();
        onRemove?.(remove.dataset.remove);
        return;
      }
      const option = event.target.closest(".sd-select-opt");
      if (!option) return;
      commit(option.dataset.value);
      input?.focus();
    });

    return {
      root,
      getValue: () => committed,
      open,
      close,
      positionList: () => positionListNear(list, root),
      isOpen: () => !!list && !list.hidden,
      hasOptions: () => options.length > 0,
      owns: (node) => !!(root?.contains(node) || list?.contains(node)),
      setValue(next) {
        commit(next, { notify: false });
      },
      setOptions(next, { keepSelection = true } = {}) {
        options = Array.isArray(next) ? next : [];
        filter = "";
        const stillPresent = options.some(
          (option) => String(option.value || "") === committed,
        );
        if (input) input.disabled = sourceBusy || (!options.length && !freeText);
        if (caret) caret.disabled = sourceBusy || !options.length;
        if (!freeText && !(keepSelection && stillPresent)) commit("", { notify: false });
        else if (input && !freeText) input.value = labelFor(committed);
        if (!list?.hidden) render();
      },
      setDisabled(disabled) {
        if (input) input.disabled = !!disabled || (!options.length && !freeText);
        if (caret) caret.disabled = !!disabled || !options.length;
      },
    };
  }

  const methodSelect = createSdSelect({
    root: dom.methodSelect,
    trigger: dom.methodTrigger,
    valueEl: dom.methodValue,
    list: dom.methodList,
    emptyText: "No import methods are available.",
    placeholder: "CSV File",
    onChange: (value) => {
      panelMethod = value === SOURCE_TYPE_MSSQL ? SOURCE_TYPE_MSSQL : SOURCE_TYPE_CSV;
      setSourceStatus("");
      syncPanelMethod();
    },
  });

  const tableSelect = createSdCombo({
    root: dom.mssqlTableSelect,
    input: dom.mssqlTableInput,
    caret: dom.mssqlTableCaretBtn,
    list: dom.mssqlTableList,
    emptyText: "No tables or views were found.",
  });

  const serverCombo = createSdCombo({
    root: dom.mssqlServerCombo,
    input: dom.mssqlServer,
    caret: dom.mssqlServerHistoryBtn,
    list: dom.mssqlServerList,
    emptyText: "No servers have been used yet.",
    freeText: true,
    removable: true,
    onRemove: (server) => forgetConnection(server, null),
  });

  const databaseCombo = createSdCombo({
    root: dom.mssqlDatabaseCombo,
    input: dom.mssqlDatabase,
    caret: dom.mssqlDatabaseHistoryBtn,
    list: dom.mssqlDatabaseList,
    emptyText: "No databases have been used for this server yet.",
    freeText: true,
    removable: true,
    onRemove: (database) => forgetConnection(String(dom.mssqlServer?.value || "").trim(), database),
  });

  /** Databases recorded for the server currently typed in. */
  function syncDatabaseHistory() {
    const currentServer = String(dom.mssqlServer?.value || "").trim().toLowerCase();
    databaseCombo.setOptions(
      connectionHistory
        .filter((entry) => entry.server.toLowerCase() === currentServer)
        .map((entry) => ({ value: entry.database, label: entry.database })),
    );
  }

  /**
   * Refresh both history lists from the shared record.
   *
   * Only called when the record itself changes - re-seeding the server list on
   * every keystroke would clear the filter the user is typing.
   */
  function syncConnectionHistory() {
    const servers = [];
    const seenServers = new Set();
    for (const entry of connectionHistory) {
      const key = entry.server.toLowerCase();
      if (key && !seenServers.has(key)) {
        seenServers.add(key);
        servers.push({ value: entry.server, label: entry.server });
      }
    }
    serverCombo.setOptions(servers);
    syncDatabaseHistory();
  }

  function applyConnectionHistory(payload) {
    const entries = Array.isArray(payload?.connections) ? payload.connections : [];
    connectionHistory = entries.map((entry) => ({
      server: String(entry?.server || ""),
      database: String(entry?.database || ""),
    })).filter((entry) => entry.server && entry.database);
    syncConnectionHistory();
    return connectionHistory;
  }

  async function loadConnectionHistory() {
    applyConnectionHistory(await onListConnections());
  }

  async function forgetConnection(server, database) {
    const name = String(server || "").trim();
    if (!name) return;
    applyConnectionHistory(await onForgetConnection(name, database));
    setSourceStatus(
      database
        ? `Removed the saved connection ${name}.${database}.`
        : `Removed every saved connection for ${name}.`,
      "ok",
    );
  }

  function readProfileFromPanel() {
    return {
      server: String(dom.mssqlServer?.value || "").trim(),
      database: String(dom.mssqlDatabase?.value || "").trim(),
      table: tableSelect.getValue().trim(),
      authentication: MSSQL_AUTH_WINDOWS,
    };
  }

  function readCsvPathFromPanel() {
    return String(dom.csvPath?.value || "").trim();
  }

  function selectedMethod() {
    return panelMethod === SOURCE_TYPE_MSSQL ? SOURCE_TYPE_MSSQL : SOURCE_TYPE_CSV;
  }

  function setSourceStatus(text, tone = "") {
    if (!dom.mssqlStatus) return;
    const value = String(text || "").trim();
    dom.mssqlStatus.textContent = value;
    dom.mssqlStatus.classList.toggle("error", tone === "error");
    dom.mssqlStatus.classList.toggle("ok", tone === "ok");
    dom.mssqlStatus.hidden = !value;
  }

  function setSourceBusy(busy) {
    sourceBusy = !!busy;
    [dom.importDataBtn, dom.mssqlLoadTablesBtn, dom.csvBrowseBtn].forEach((button) => {
      if (button) button.disabled = sourceBusy;
    });
    methodSelect.setDisabled(sourceBusy);
    tableSelect.setDisabled(sourceBusy);
    serverCombo.setDisabled(sourceBusy);
    databaseCombo.setDisabled(sourceBusy);
  }

  /** Show only the selected method's fields; the window owns that choice. */
  function syncPanelMethod() {
    const method = selectedMethod();
    serverCombo.close();
    databaseCombo.close();
    dom.sourceMethods.forEach((section) => {
      section.hidden = String(section.dataset.method || "") !== method;
    });
    tableSelect.close();
  }

  function syncSourcePanelFields() {
    if (dom.csvPath) dom.csvPath.value = sourceState.csvPath;
    if (dom.mssqlServer) dom.mssqlServer.value = sourceState.mssql.server;
    if (dom.mssqlDatabase) dom.mssqlDatabase.value = sourceState.mssql.database;
    tableSelect.setValue(sourceState.mssql.table);
    dom.mssqlAuthGroup?.querySelectorAll(".sd-auth-opt").forEach((button) => {
      const active = String(button.dataset.auth || "") === MSSQL_AUTH_WINDOWS;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
    if (!sourceState.driverAvailable) {
      setSourceStatus(
        "SQL Server support is not installed in this ArcRho runtime. Install the Microsoft ODBC Driver for SQL Server.",
        "error",
      );
    }
  }

  function openSourcePanel() {
    if (!dom.sourcePanel) return;
    // The window always opens on the project's saved method and saved values.
    panelMethod = sourceState.sourceType;
    methodSelect.setOptions(
      [
        { value: SOURCE_TYPE_CSV, label: "CSV File" },
        { value: SOURCE_TYPE_MSSQL, label: "SQL Server" },
      ],
      { keepSelection: false },
    );
    methodSelect.setValue(panelMethod);
    tableSelect.setOptions([], { keepSelection: false });
    syncSourcePanelFields();
    syncPanelMethod();
    sourcePanelOpen = true;
    // Re-center on every open so a dragged window never opens off-screen.
    dom.sourcePanel.style.left = "50%";
    dom.sourcePanel.style.top = "140px";
    dom.sourcePanel.style.transform = "translateX(-50%)";
    dom.sourcePanel.classList.add("show");
    dom.importSettingsBtn?.setAttribute("aria-expanded", "true");
    const firstField = selectedMethod() === SOURCE_TYPE_MSSQL ? dom.mssqlServer : dom.csvPath;
    setTimeout(() => firstField?.focus({ preventScroll: true }), 0);
    // Saved server/database pairs are shared by everyone on this ArcRho Server,
    // so they are re-read each time the window opens.
    loadConnectionHistory();
  }

  function closeSourcePanel({ restoreFocus = false } = {}) {
    if (!dom.sourcePanel || !sourcePanelOpen) return;
    methodSelect.close();
    tableSelect.close();
    serverCombo.close();
    databaseCombo.close();
    sourcePanelOpen = false;
    windowDragState = null;
    windowResizeState = null;
    dom.sourcePanel.classList.remove("show");
    dom.importSettingsBtn?.setAttribute("aria-expanded", "false");
    if (restoreFocus) dom.importSettingsBtn?.focus();
  }

  /* ---- window dragging and resizing, matching the page's other editors ---- */

  /**
   * Turn the centered position into real pixels. The window opens with
   * `left: 50%; transform: translateX(-50%)`, so until the transform is dropped
   * `left` names the window's midpoint and any width change grows both edges.
   */
  function pinSourcePanelPosition(rect) {
    dom.sourcePanel.style.left = `${rect.left}px`;
    dom.sourcePanel.style.top = `${rect.top}px`;
    dom.sourcePanel.style.transform = "none";
  }

  /** CSS owns the minimum window size; this only reads it back for clamping. */
  function sourcePanelSizeLimits() {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(dom.sourcePanel) : null;
    const num = (value, fallback) => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
      minWidth: num(style?.minWidth, 320),
      minHeight: num(style?.minHeight, 240),
    };
  }

  function onWindowHeaderMouseDown(event) {
    if (!dom.sourcePanel || event.button !== 0) return;
    if (event.target.closest("button")) return;
    pinSourcePanelPosition(dom.sourcePanel.getBoundingClientRect());
    const rect = dom.sourcePanel.getBoundingClientRect();
    windowDragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.preventDefault();
  }

  /** Bottom-right grip: the top-left corner stays put and the box follows the pointer. */
  function onWindowResizerMouseDown(event) {
    if (!dom.sourcePanel || event.button !== 0) return;
    const rect = dom.sourcePanel.getBoundingClientRect();
    pinSourcePanelPosition(rect);
    windowResizeState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      ...sourcePanelSizeLimits(),
    };
    event.preventDefault();
    event.stopPropagation();
  }

  function onWindowResizeMove(event) {
    const state = windowResizeState;
    const rect = dom.sourcePanel.getBoundingClientRect();
    const maxWidth = Math.max(state.minWidth, window.innerWidth - rect.left - 8);
    const maxHeight = Math.max(state.minHeight, window.innerHeight - rect.top - 8);
    const width = state.startWidth + (event.clientX - state.startX);
    const height = state.startHeight + (event.clientY - state.startY);
    dom.sourcePanel.style.width = `${Math.max(state.minWidth, Math.min(maxWidth, width))}px`;
    dom.sourcePanel.style.height = `${Math.max(state.minHeight, Math.min(maxHeight, height))}px`;
    repositionSourceLists();
  }

  function onWindowMouseMove(event) {
    if (!dom.sourcePanel) return;
    if (windowResizeState) {
      onWindowResizeMove(event);
      return;
    }
    if (!windowDragState) return;
    const maxLeft = window.innerWidth - dom.sourcePanel.offsetWidth - 8;
    const maxTop = window.innerHeight - dom.sourcePanel.offsetHeight - 8;
    dom.sourcePanel.style.left = `${Math.max(8, Math.min(maxLeft, event.clientX - windowDragState.offsetX))}px`;
    dom.sourcePanel.style.top = `${Math.max(8, Math.min(maxTop, event.clientY - windowDragState.offsetY))}px`;
    repositionSourceLists();
  }

  /** Keep a body-rendered dropdown anchored while the window moves or resizes. */
  function repositionSourceLists() {
    methodSelect.positionList();
    tableSelect.positionList();
    serverCombo.positionList();
    databaseCombo.positionList();
  }

  function onWindowMouseUp() {
    windowDragState = null;
    windowResizeState = null;
  }

  async function browseForCsv() {
    if (sourceBusy) return;
    const picked = await onCsvPathPick(readCsvPathFromPanel());
    const value = String(picked || "").trim();
    if (!value) return;
    if (dom.csvPath) dom.csvPath.value = value;
    setSourceStatus("");
  }

  async function loadTableOptions() {
    const profile = readProfileFromPanel();
    if (!profile.server || !profile.database) {
      setSourceStatus("Enter the server and database name first.", "error");
      return;
    }
    setSourceBusy(true);
    setSourceStatus("Reading tables and views...");
    try {
      const result = await onListTables(profile);
      if (!result?.ok) {
        tableSelect.setOptions([], { keepSelection: false });
        setSourceStatus(result?.error || "Could not read tables from that database.", "error");
        return;
      }
      const listed = Array.isArray(result.tables) ? result.tables : [];
      tableSelect.setOptions(
        listed.map((item) => ({
          value: String(item.qualified_name || ""),
          label: String(item.qualified_name || ""),
          kind: item.kind === "view" ? "View" : "Table",
        })),
      );
      setSourceStatus(
        `Connected. ${Number(result.table_count ?? listed.length)} table(s) and view(s) available.`,
        "ok",
      );
    } finally {
      setSourceBusy(false);
    }
  }

  /**
   * Save the chosen method, then rebuild the project-owned master table from it.
   * CSV re-copies the selected file; SQL Server streams the selected table.
   */
  async function importData() {
    const method = selectedMethod();
    const profile = readProfileFromPanel();
    const csvPath = readCsvPathFromPanel();

    if (method === SOURCE_TYPE_MSSQL) {
      if (!profile.server || !profile.database) {
        setSourceStatus("Enter the server and database name first.", "error");
        return;
      }
      if (!profile.table) {
        setSourceStatus("Select a table or view to import.", "error");
        return;
      }
    } else if (!csvPath) {
      setSourceStatus("Choose a CSV file to import.", "error");
      return;
    }

    setSourceBusy(true);
    setSourceStatus(method === SOURCE_TYPE_MSSQL
      ? "Importing the table from SQL Server..."
      : "Importing the CSV file into this project...");
    try {
      const saved = await onProfileSave(method, profile, csvPath);
      if (!saved) {
        setSourceStatus("Could not save the import settings.", "error");
        return;
      }
      setBodyVisible(true);
      setSummaryLoading(
        true,
        method === SOURCE_TYPE_MSSQL
          ? "Importing and reading the source table..."
          : "Copying and reading the source table...",
      );
      const result = await onImportData(method);
      if (!result?.ok) {
        setSummaryLoading(false);
        showMessage("", false);
        setSourceStatus(result?.error || "The import failed.", "error");
        return;
      }
      const rowCount = Number(result.rowCount || 0);
      setSourceStatus(
        rowCount > 0
          ? `Imported ${rowCount.toLocaleString("en-US")} row(s) into this project.`
          : "Imported the source table into this project.",
        "ok",
      );
    } finally {
      setSourceBusy(false);
    }
  }

  /* ---------------- tooltips ---------------- */

  /**
   * Attach the shared ArcRho tooltip to the header controls.
   *
   * The label comes from each control's own `aria-label` so the accessible name
   * stays the single source for its wording; only the switch options, whose
   * visible text is already their name, carry a separate explanatory string.
   *
   * Only header controls are covered. The shared tooltip sits at z-index 5600,
   * below this tab's floating panels, so a control inside one of those panels
   * would get a tooltip hidden behind its own panel.
   */
  function wireTooltips() {
    const fromAriaLabel = [
      dom.infoBtn,
      dom.reloadBtn,
      dom.importSettingsBtn,
    ];
    fromAriaLabel.forEach((control) => {
      attachArcrhoTooltip(control, control?.getAttribute("aria-label"));
    });

  }

  /* ---------------- wiring ---------------- */

  function wire() {
    if (wired) return;
    wired = true;

    wireTooltips();

    dom.pathDisplay?.addEventListener("click", beginPathEdit);
    dom.pathInput?.addEventListener("blur", () => {
      // project_settings.js commits the value on blur; restore the quiet display after it.
      setTimeout(endPathEdit, 0);
    });
    dom.pathInput?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        endPathEdit();
        dom.pathDisplay?.focus();
      }
    });

    dom.importSettingsBtn?.addEventListener("click", () => {
      if (sourcePanelOpen) closeSourcePanel({ restoreFocus: true });
      else openSourcePanel();
    });
    dom.sourcePanelClose?.addEventListener("click", () => closeSourcePanel({ restoreFocus: true }));
    dom.sourcePanelHeader?.addEventListener("mousedown", onWindowHeaderMouseDown);
    dom.sourcePanelResizer?.addEventListener("mousedown", onWindowResizerMouseDown);
    dom.csvBrowseBtn?.addEventListener("click", () => browseForCsv());
    dom.mssqlLoadTablesBtn?.addEventListener("click", () => loadTableOptions());
    dom.importDataBtn?.addEventListener("click", () => importData());

    dom.mssqlAuthGroup?.addEventListener("click", (event) => {
      const button = event.target.closest(".sd-auth-opt");
      if (!button || button.disabled) return;
      // SQL Server login stays a disabled placeholder until it is implemented.
      syncSourcePanelFields();
    });
    [dom.csvPath, dom.mssqlServer, dom.mssqlDatabase].forEach((input) => {
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeSourcePanel({ restoreFocus: true });
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        // Enter advances the step the field belongs to, never the import itself.
        if (input === dom.mssqlDatabase || input === dom.mssqlServer) loadTableOptions();
      });
    });
    // A changed connection invalidates the table list it produced.
    [dom.mssqlServer, dom.mssqlDatabase].forEach((input) => {
      input?.addEventListener("input", () => {
        if (tableSelect.hasOptions()) tableSelect.setOptions([], { keepSelection: false });
        if (input === dom.mssqlServer) syncDatabaseHistory();
      });
    });

    dom.monthPickerButtons.forEach((button) => {
      button.addEventListener("click", () => openMonthPicker(button));
    });
    dom.monthPicker?.addEventListener("pointerenter", () => {
      monthPickerPointerInside = true;
    });
    dom.monthPicker?.addEventListener("pointerleave", () => {
      monthPickerPointerInside = false;
    });
    dom.monthPickerYear?.addEventListener("click", toggleMonthPickerYearView);
    dom.monthPickerPrev?.addEventListener("click", () => {
      if (monthPickerView !== "months" || !Number.isInteger(monthPickerYear) || monthPickerYear <= 1) return;
      monthPickerYear -= 1;
      renderMonthPicker();
    });
    dom.monthPickerNext?.addEventListener("click", () => {
      if (monthPickerView !== "months" || !Number.isInteger(monthPickerYear)) return;
      monthPickerYear += 1;
      renderMonthPicker();
    });
    dom.monthPickerGrid?.addEventListener("click", (event) => {
      const yearButton = event.target.closest(".sd-month-picker-year-option");
      if (yearButton) {
        showMonthPickerMonthsForYear(yearButton.dataset.year);
        return;
      }
      const monthButton = event.target.closest(".sd-month-picker-month");
      if (monthButton) applyPickerMonth(monthButton.dataset.month);
    });

    dom.openFolderBtn?.addEventListener("click", async () => {
      // The full file path is passed so the explorer opens the source folder
      // with the file itself selected.
      const value = String(dom.pathInput?.value || "").trim();
      if (!value) return;
      const host = getHostApi();
      if (typeof host?.showItemInFolder !== "function") {
        setStatus("Opening a folder is only available in the desktop app.");
        return;
      }
      const result = await host.showItemInFolder({ path: value });
      if (result && result.ok === false) {
        setStatus(`Could not open the folder: ${result.error || "unknown error"}`);
      }
    });

    dom.infoBtn?.addEventListener("mouseenter", openDetails);
    dom.infoBtn?.addEventListener("mouseleave", scheduleCloseDetails);
    dom.infoBtn?.addEventListener("focus", openDetails);
    dom.infoBtn?.addEventListener("blur", scheduleCloseDetails);
    dom.infoBtn?.addEventListener("click", () => {
      detailsPinned = !detailsPinned;
      if (detailsPinned) openDetails();
      else closeDetails();
    });
    dom.statsCard?.addEventListener("mouseenter", () => clearTimeout(detailsTimer));
    dom.statsCard?.addEventListener("mouseleave", (event) => {
      // Dragging a selection past the card edge must not close it out from
      // under the text the user is selecting; the mouseup below closes it.
      if (event.buttons) return;
      scheduleCloseDetails();
    });
    document.addEventListener("mouseup", () => {
      if (!dom.statsCard || dom.statsCard.hidden) return;
      if (dom.statsCard.matches(":hover") || dom.infoBtn?.matches(":hover")) return;
      scheduleCloseDetails();
    });
    document.addEventListener("mousedown", (event) => {
      if (
        previewCard
        && !previewCard.hidden
        && !previewCard.contains(event.target)
        && !previewCell?.contains(event.target)
      ) {
        hidePreview();
      }
      if (
        activeMonthPickerButton
        && !dom.monthPicker?.contains(event.target)
        && !activeMonthPickerButton.contains(event.target)
      ) {
        closeMonthPicker();
      }
      // The Import Settings window is a regular window: an outside click never
      // closes it, only its own dropdowns dismiss. Each list lives in
      // document.body, so ownership is asked of the select, not the markup.
      if (sourcePanelOpen) {
        if (!methodSelect.owns(event.target)) methodSelect.close();
        if (!tableSelect.owns(event.target)) tableSelect.close();
        if (!serverCombo.owns(event.target)) serverCombo.close();
        if (!databaseCombo.owns(event.target)) databaseCombo.close();
      }
      if (!detailsPinned) return;
      if (dom.statsCard?.contains(event.target) || dom.infoBtn?.contains(event.target)) return;
      closeDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePreview();
        closeDetails();
        closeMonthPicker({ restoreFocus: true, force: true });
        // Escape dismisses an open dropdown first, then the window itself.
        const anyListOpen = methodSelect.isOpen() || tableSelect.isOpen()
          || serverCombo.isOpen() || databaseCombo.isOpen();
        if (sourcePanelOpen && anyListOpen) {
          methodSelect.close();
          tableSelect.close();
          serverCombo.close();
          databaseCombo.close();
        } else {
          closeSourcePanel({ restoreFocus: true });
        }
      }
    });
    window.addEventListener("resize", () => {
      closeMonthPicker();
      repositionSourceLists();
    });
    // The window is user-resizable, so an open list has to track its trigger.
    if (typeof ResizeObserver === "function" && dom.sourcePanel) {
      new ResizeObserver(() => repositionSourceLists()).observe(dom.sourcePanel);
    }

    dom.filter?.addEventListener("input", () => {
      hidePreview();
      renderColumns();
    });

    // The preview opens only from a Distribution & Summary cell click (or Enter/Space
    // on a focused row); Escape or an outside click closes it.
    dom.list?.addEventListener("click", (event) => {
      const cell = event.target.closest(".sd-c-dist");
      const row = cell?.closest(".sd-row");
      if (!cell || !row) return;
      showPreview(row, { x: event.clientX, y: event.clientY }, { cell });
    });
    dom.list?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest(".sd-row");
      if (!row) return;
      event.preventDefault();
      showPreview(row, null);
    });

    [dom.originStart, dom.originEnd].forEach((input) => {
      input?.addEventListener("input", refreshOriginSpanNote);
      input?.addEventListener("change", refreshOriginSpanNote);
      input?.addEventListener("blur", refreshOriginSpanNote);
    });

    wireResizers();
  }

  /* ---------------- public API ---------------- */

  return {
    init() {
      wire();
      applyConfiguredColumnWidths();
      syncPathDisplay();
      refreshOriginSpanNote();
    },
    applyConfiguredColumnWidths,
    syncPathDisplay,
    endPathEdit,
    refreshOriginSpanNote,
    /** Apply a `/source_table` payload; owns which import source the tab shows. */
    applySourceState(state) {
      sourceState = normalizeSourceState(state);
      // A new selection, or a fresh import, retires what the panel last read
      // from the file: both the path and what it is being compared with move.
      fileStatus = null;
      fileStatusAt = 0;
      // The hidden path input is the page's record of the CSV selection; the
      // `/source_table` payload is its single source of truth.
      if (dom.pathInput) {
        dom.pathInput.value = sourceState.sourceType === SOURCE_TYPE_MSSQL ? "" : sourceState.csvPath;
      }
      if (sourcePanelOpen) syncSourcePanelFields();
      syncPathDisplay(sourceState.sourceType === SOURCE_TYPE_MSSQL ? "" : sourceState.csvPath);
      if (sourceState.driverAvailable) setSourceStatus("");
      return sourceState;
    },
    getSourceState() {
      return sourceState;
    },
    getSourceType() {
      return sourceState.sourceType;
    },
    setSourceStatus,
    closeSourcePanel,
    // Drag needs document-level listeners, which the coordinator already owns
    // for the Dataset Type and Reserving Class Type editor windows.
    onEditorMouseMove: onWindowMouseMove,
    onEditorMouseUp: onWindowMouseUp,
    showLoading(message = "Reading the source table...") {
      setBodyVisible(true);
      hidePreview();
      setSummaryLoading(true, message);
    },
    /**
     * Drop the previous project's tab content the moment the selection changes.
     *
     * Reading a project's import record and table summary costs several network
     * round trips, so without this the old path, columns, stats, and period
     * months stay readable for seconds as though they belonged to the newly
     * selected project. The busy frame takes their place instead.
     */
    resetForProjectChange(message = "Loading project...") {
      closeSourcePanel();
      closeDetails();
      hidePreview();
      sourceState = normalizeSourceState(null);
      columns = [];
      statsData = null;
      if (dom.pathInput) dom.pathInput.value = "";
      endPathEdit();
      if (dom.list) dom.list.innerHTML = "";
      if (dom.count) dom.count.textContent = "";
      if (dom.stats) dom.stats.innerHTML = "";
      if (dom.filter) dom.filter.value = "";
      [dom.originStart, dom.originEnd, dom.developmentEnd].forEach((input) => {
        if (input) input.value = "";
      });
      refreshOriginSpanNote();
      syncPathDisplay();
      setSourceStatus("");
      setBodyVisible(true);
      setSummaryLoading(true, message);
    },
    showError(message) {
      setSummaryLoading(false);
      showMessage(message, true);
      hidePreview();
    },
    showNoPath(message = "No source file is configured for this project.") {
      setSummaryLoading(false);
      setBodyVisible(false);
      showMessage(message, false);
      columns = [];
      statsData = null;
      hidePreview();
      closeDetails();
      if (dom.list) dom.list.innerHTML = "";
      if (dom.count) dom.count.textContent = "";
      if (dom.stats) dom.stats.innerHTML = "";
      syncPathDisplay();
    },
    renderSummary(data) {
      setSummaryLoading(false);
      hidePreview();
      columns = Array.isArray(data?.columns) ? data.columns : [];
      setBodyVisible(true);
      showMessage("", false);
      renderStats(data);
      renderColumns();
      refreshOriginSpanNote();
      syncPathDisplay();
    },
  };
}
