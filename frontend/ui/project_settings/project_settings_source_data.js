/**
 * Source Data tab - quiet surface with detail in floating panels.
 *
 * Owns the header identity line, the reserving-period band notes, the column
 * list (filter, resize, distribution marks), the floating table-details panel,
 * floating per-column preview, and shared month picker. Path/date persistence
 * stays in the coordinator-composed General Settings feature.
 */

const COLUMN_MIN_WIDTH = { name: 120, type: 74 };
const PREVIEW_OPEN_DELAY_MS = 110;
const DETAILS_CLOSE_DELAY_MS = 160;
const AREA_VIEWBOX_HEIGHT = 20;

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
    getHostApi = () => (typeof window === "undefined" ? null : window.ADAHost),
    onPathEditRequested = () => {},
    getConfiguredColumnWidths = () => null,
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
    copyBtn: el("summaryCopyPathBtn"),
    copyFolderBtn: el("summaryCopyFolderBtn"),
    openFolderBtn: el("summaryOpenFolderBtn"),
    reloadBtn: el("summaryTablePathReloadBtn"),
    browseBtn: el("summaryTablePathBrowseBtn"),
    message: el("summaryMessage"),
    band: el("summaryPeriodsBand"),
    originSpanNote: el("summaryOriginSpanNote"),
    originStart: el("summaryOriginStartInput"),
    originEnd: el("summaryOriginEndInput"),
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
  let dateRoles = { originField: "", developmentField: "" };
  let previewCard = null;
  let previewTimer = null;
  let previewRow = null;
  let previewCell = null;
  let previewPinned = false;
  let detailsPinned = false;
  let detailsTimer = null;
  let activeMonthInput = null;
  let activeMonthPickerButton = null;
  let monthPickerYear = null;
  let monthPickerView = "months";
  let monthPickerPointerInside = false;
  let wired = false;

  /* ---------------- helpers ---------------- */

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function roleForColumn(name) {
    const key = normalizeKey(name);
    if (!key) return "";
    if (key === normalizeKey(dateRoles.originField)) return "Origin Date";
    if (key === normalizeKey(dateRoles.developmentField)) return "Development Date";
    return "";
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

  function areaPath(bins) {
    const last = bins.length - 1;
    if (last <= 0) return "";
    const points = bins.map((value, index) => {
      const x = ((index / last) * 100).toFixed(2);
      const y = (AREA_VIEWBOX_HEIGHT - (Number(value) || 0) * (AREA_VIEWBOX_HEIGHT - 2)).toFixed(2);
      return `${x},${y}`;
    });
    return `M0,${AREA_VIEWBOX_HEIGHT} L${points.join(" L")} L100,${AREA_VIEWBOX_HEIGHT} Z`;
  }

  function distributionMark(column) {
    const dist = column?.distribution || {};
    if (dist.kind === "numeric") {
      const bins = Array.isArray(dist.bins) ? dist.bins : [];
      const path = areaPath(bins);
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
    const role = roleForColumn(column?.name);
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
      body = '<p class="sd-preview-section">Distribution</p><div class="sd-hist">'
        + dist.bins.map((value) =>
            `<i style="height:${Math.max(2, Math.round((Number(value) || 0) * 100))}%"></i>`).join("")
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
      + `<span class="sd-preview-type">${escapeHtml(column?.type)}${role ? ` &middot; ${escapeHtml(role)}` : ""}</span>`
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
        const role = roleForColumn(column?.name);
        const index = columns.indexOf(column);
        return `<div class="sd-row" data-index="${index}" role="button" tabindex="0">`
          + '<span class="sd-c-name">'
          + `<span class="sd-row-name" title="${escapeHtml(column?.name)}">${escapeHtml(column?.name)}</span>`
          + (role ? `<span class="sd-row-role">${escapeHtml(role)}</span>` : "")
          + "</span>"
          + `<span class="sd-c-type"><span class="sd-row-type sd-type-${escapeHtml(column?.type)}">${escapeHtml(column?.type)}</span></span>`
          + `<span class="sd-c-dist">${distributionMark(column)}</span>`
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
    previewCard.setAttribute("role", "tooltip");
    previewCard.hidden = true;
    document.body.appendChild(previewCard);
    return previewCard;
  }

  function showPreview(row, pointer, { pinned = false, cell = null } = {}) {
    if (previewPinned && !pinned) return;
    const column = columns[Number(row?.dataset?.index)];
    if (!column) return;
    clearTimeout(previewTimer);
    previewTimer = null;
    const card = ensurePreviewCard();
    if (previewRow && previewRow !== row) previewRow.classList.remove("active");
    previewRow = row;
    previewCell = pinned ? (cell || row.querySelector(".sd-c-dist")) : null;
    previewPinned = pinned;
    row.classList.add("active");
    card.dataset.pinned = String(pinned);
    card.setAttribute("role", pinned ? "dialog" : "tooltip");
    if (pinned) card.setAttribute("aria-label", "Column distribution preview");
    else card.removeAttribute("aria-label");
    card.innerHTML = previewHtml(column);
    card.hidden = false;
    card.style.left = "-9999px";
    card.style.top = "0px";
    if (pointer) {
      placeAtPointer(card, pointer.x, pointer.y);
    } else {
      const cell = row.querySelector(".sd-c-dist") || row;
      placeFloating(card, cell.getBoundingClientRect(), 6);
    }
  }

  function hidePreview({ force = false } = {}) {
    clearTimeout(previewTimer);
    previewTimer = null;
    if (previewPinned && !force) return;
    if (previewRow) previewRow.classList.remove("active");
    previewRow = null;
    previewCell = null;
    previewPinned = false;
    if (previewCard) {
      previewCard.hidden = true;
      previewCard.dataset.pinned = "false";
      previewCard.setAttribute("role", "tooltip");
      previewCard.removeAttribute("aria-label");
    }
  }

  /* ---------------- floating table details ---------------- */

  function renderStats(data) {
    if (!dom.stats) return;
    const rows = [
      { key: "Rows", value: Number(data?.row_count || 0).toLocaleString(), note: "data rows, header excluded" },
      { key: "Columns", value: String(data?.column_count ?? columns.length), note: "" },
      { key: "File Size", value: String(data?.file_size_str || ""), note: "CSV, comma delimited" },
      { key: "Modified", value: formatTimestamp(data?.csv_mtime), note: "" },
      { key: "Last Read", value: data?.from_cache ? "Cached summary" : "Just now", note: "" },
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
    const value = String(path ?? dom.pathInput?.value ?? "");
    const parts = splitPath(value);
    if (dom.pathName) dom.pathName.textContent = parts.name || "No source file";
    if (dom.pathDir) dom.pathDir.textContent = parts.dir;
    if (dom.pathDirRow) dom.pathDirRow.hidden = !parts.dir;
    if (dom.pathDisplay) dom.pathDisplay.title = value;
    const hasPath = !!value.trim();
    if (dom.copyBtn) dom.copyBtn.disabled = !hasPath;
    if (dom.copyFolderBtn) dom.copyFolderBtn.disabled = !parts.dir;
    if (dom.openFolderBtn) dom.openFolderBtn.disabled = !hasPath;
    if (dom.infoBtn) dom.infoBtn.disabled = !hasPath;
    if (!hasPath) closeDetails();
  }

  function beginPathEdit() {
    if (!dom.pathInput || !dom.pathDisplay || !dom.pathIdentity) return;
    if (dom.pathInput.disabled) return;
    dom.pathIdentity.hidden = true;
    dom.pathInput.hidden = false;
    dom.pathInput.focus();
    dom.pathInput.select();
    onPathEditRequested();
  }

  function endPathEdit() {
    if (!dom.pathInput || !dom.pathDisplay || !dom.pathIdentity) return;
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

  async function copyToClipboard(value, successMessage, errorMessage) {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(successMessage);
    } catch {
      setStatus(errorMessage);
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

  /* ---------------- wiring ---------------- */

  function wire() {
    if (wired) return;
    wired = true;

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

    dom.copyBtn?.addEventListener("click", () => copyToClipboard(
      dom.pathInput?.value,
      "Source table path copied to the clipboard.",
      "Could not copy the source table path.",
    ));

    dom.copyFolderBtn?.addEventListener("click", () => copyToClipboard(
      splitPath(dom.pathInput?.value).dir,
      "Source folder path copied to the clipboard.",
      "Could not copy the source folder path.",
    ));

    dom.openFolderBtn?.addEventListener("click", async () => {
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
    dom.statsCard?.addEventListener("mouseleave", scheduleCloseDetails);
    document.addEventListener("mousedown", (event) => {
      if (
        previewPinned
        && !previewCard?.contains(event.target)
        && !previewCell?.contains(event.target)
      ) {
        hidePreview({ force: true });
      }
      if (
        activeMonthPickerButton
        && !dom.monthPicker?.contains(event.target)
        && !activeMonthPickerButton.contains(event.target)
      ) {
        closeMonthPicker();
      }
      if (!detailsPinned) return;
      if (dom.statsCard?.contains(event.target) || dom.infoBtn?.contains(event.target)) return;
      closeDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePreview({ force: true });
        closeDetails();
        closeMonthPicker({ restoreFocus: true, force: true });
      }
    });
    window.addEventListener("resize", () => closeMonthPicker());

    dom.filter?.addEventListener("input", () => {
      hidePreview();
      renderColumns();
    });

    // Hover previews follow the pointer; clicking a Distribution cell pins one in place.
    dom.list?.addEventListener("mousemove", (event) => {
      if (previewPinned) return;
      const cell = event.target.closest(".sd-c-dist");
      if (!cell) {
        if (previewRow || previewTimer) hidePreview();
        return;
      }
      const row = cell.closest(".sd-row");
      if (!row) return;
      const pointer = { x: event.clientX, y: event.clientY };
      if (row === previewRow) {
        if (previewCard && !previewCard.hidden) placeAtPointer(previewCard, pointer.x, pointer.y);
        return;
      }
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(row, pointer), PREVIEW_OPEN_DELAY_MS);
    });
    dom.list?.addEventListener("click", (event) => {
      const cell = event.target.closest(".sd-c-dist");
      const row = cell?.closest(".sd-row");
      if (!cell || !row) return;
      showPreview(row, { x: event.clientX, y: event.clientY }, { pinned: true, cell });
    });
    dom.list?.addEventListener("mouseleave", () => hidePreview());
    dom.list?.addEventListener("scroll", () => hidePreview());
    dom.list?.addEventListener("focusin", (event) => {
      const row = event.target.closest(".sd-row");
      if (row) showPreview(row, null);
    });
    dom.list?.addEventListener("focusout", () => hidePreview());

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
    setDateRoles(roles = {}) {
      dateRoles = {
        originField: String(roles.originField || ""),
        developmentField: String(roles.developmentField || ""),
      };
      if (columns.length) renderColumns();
    },
    showLoading(message = "Reading the source table...") {
      setBodyVisible(true);
      showMessage(message, false);
      hidePreview({ force: true });
      if (dom.list) dom.list.innerHTML = "";
      if (dom.count) dom.count.textContent = "";
    },
    showError(message) {
      showMessage(message, true);
      hidePreview({ force: true });
    },
    showNoPath(message = "No source file is configured for this project.") {
      setBodyVisible(false);
      showMessage(message, false);
      columns = [];
      hidePreview({ force: true });
      closeDetails();
      if (dom.list) dom.list.innerHTML = "";
      if (dom.count) dom.count.textContent = "";
      if (dom.stats) dom.stats.innerHTML = "";
      syncPathDisplay();
    },
    renderSummary(data) {
      hidePreview({ force: true });
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
