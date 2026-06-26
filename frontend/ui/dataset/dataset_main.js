// Entry point: orchestrates load/save/toggle and wires events.

import { state } from "/ui/shared/state.js";
import { config } from "/ui/shared/config.js";
import { $, logLine } from "/ui/shared/dom.js";
import {
  getDataset,
  loadDatasetNotes,
  loadDatasetSidecar,
  patchDataset,
  saveDatasetNotes,
  saveDatasetSidecar,
} from "/ui/shared/api.js";
import {
  renderTable,
  renderActiveCellUI,
  renderChart,
  redrawChartSafely,
  setDatasetRenderNumberFormatSettings,
} from "/ui/dataset/dataset_render.js";
import { createTabbedPage } from "/ui/shared/tabbed_page.js";
import { wireTabPopoutWindows } from "/ui/shared/tab_popout_window.js";
import { createDatasetDependencyGuard } from "/ui/dataset/dataset_dependency_guard.js";
import { createDatasetHeadersService } from "/ui/dataset/dataset_headers_service.js";
import { wireDatasetGridInteractions } from "/ui/dataset/dataset_grid_interactions.js";
import { wireDatasetNotesEditor } from "/ui/dataset/dataset_notes_editor.js";
import { publishDfmInputHelpers as publishDatasetHostDfmHelpers, wireDatasetHostBridge } from "/ui/dataset/dataset_host_bridge.js";
import { createDatasetRunController } from "/ui/dataset/dataset_run_controller.js";
import { wireDatasetInputController } from "/ui/dataset/dataset_input_controller.js";
import {
  applyDecimalPlacesToDatasetNumberFormat,
  clampDatasetDecimalPlaces,
  normalizeDatasetNumberFormat,
} from "/ui/dataset/dataset_number_format.js";
import { openLazyReservingClassPicker } from "/ui/shared/reserving_class_lazy_picker.js";
import { openProjectNameTreePicker } from "/ui/shared/project_name_tree_picker.js";
import { openDatasetNamePicker } from "/ui/dataset/dataset_name_picker.js";
import { decodeFileNameSegment } from "/ui/shared/filename_sanitizer.js";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/project_user_preferences.js";
import {
  loadProjectValidValueList,
  loadDatasetValidValueList,
  loadReservingClassValidValueList,
  clearValidValueListCache,
  validateReservingClassPathByTypeNames,
  buildReservingClassPathPartLookup,
  normalizeReservingClassPathByPartLookup,
  normalizeReservingClassPath,
  normalizeReservingClassPathKey,
} from "/ui/shared/valid_value_list_provider.js";
import {
  getLastViewedDatasetInputs,
  setLastViewedDatasetInputs,
  pushBrowsingHistoryEntry,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import "/ui/shared/zoom_bridge.js?v=20260521a";

const FONT_STORAGE_KEY = "arcrho_app_font";
const FORCE_REBUILD_KEY = "arcrho_force_rebuild_enabled";
const LOCAL_PROJECT_PREFS_ENDPOINT = "/local-project/preferences";
const CALCULATED_DATASETS_UPDATED_MESSAGE = "arcrho:calculated-datasets-updated";
let calculatedDatasetRefreshInFlight = false;

function buildFontStack(font) {
  const raw = String(font || "").trim();
  if (!raw) return "";
  if (raw.includes(",")) return raw;
  const primary = /\s/.test(raw) ? `"${raw.replace(/\"/g, "")}"` : raw;
  return `${primary}, "Segoe UI", "SegoeUI", Tahoma, Arial, sans-serif`;
}

function applyAppFont(font) {
  const stack = buildFontStack(font);
  if (!stack) return;
  const root = document.documentElement;
  if (root) root.style.setProperty("--app-font", stack);
  if (document.body) document.body.style.fontFamily = stack;
}

function loadAppFontFromStorage() {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw && typeof raw === "string") return raw;
  } catch {}
  return "";
}

function isForceRebuildEnabled() {
  try {
    return localStorage.getItem(FORCE_REBUILD_KEY) === "1";
  } catch {
    return false;
  }
}

window.ArcRhoZoomBridge?.wirePageZoomBridge();
applyAppFont(loadAppFontFromStorage());

function notifyDatasetUpdated() {
  window.dispatchEvent(new CustomEvent("arcrho:dataset-updated"));
  updateDatasetSaveUi();
}

function normalizeDatasetMatchText(value) {
  return String(value || "").trim().toLowerCase();
}

function collectCurrentDatasetNamesForMatch() {
  return new Set([
    normalizeDatasetMatchText(getDatasetInstanceNameValue()),
    normalizeDatasetMatchText(document.getElementById("triInput")?.value || ""),
  ].filter(Boolean));
}

function isCalculationStepUpdated(step) {
  return !!step?.ok || String(step?.status || "").toLowerCase() === "updated";
}

function calculationContextMatches(report, step = {}) {
  const reportProject = String(step?.project_name || report?.project_name || "").trim();
  const reportPath = String(step?.reserving_class || report?.reserving_class || "").trim();
  if (reportProject && normalizeDatasetMatchText(reportProject) !== normalizeDatasetMatchText(getResolvedProjectValue())) {
    return false;
  }
  if (reportPath && normalizeReservingClassPath(reportPath) !== normalizeReservingClassPath(getResolvedReservingClassValue())) {
    return false;
  }
  return true;
}

function calculationStepMatchesCurrentDataset(step) {
  const currentNames = collectCurrentDatasetNamesForMatch();
  if (!currentNames.size) return false;
  return [
    step?.dataset_type_name,
    step?.dataset_name,
    step?.instance_name,
  ].some((value) => currentNames.has(normalizeDatasetMatchText(value)));
}

function calculationReportTargetsCurrentDataset(report) {
  if (!report || typeof report !== "object") return false;
  const steps = collectCalculationSteps(report);
  if (steps.some((step) => isCalculationStepUpdated(step) && calculationContextMatches(report, step) && calculationStepMatchesCurrentDataset(step))) {
    return true;
  }
  if (!calculationContextMatches(report)) return false;
  const currentNames = collectCurrentDatasetNamesForMatch();
  return Array.isArray(report.targets) && report.targets.some((target) => currentNames.has(normalizeDatasetMatchText(target)));
}

async function handleCalculatedDatasetsUpdatedMessage(report) {
  if (calculatedDatasetRefreshInFlight || !calculationReportTargetsCurrentDataset(report)) return;
  if (state.dirty.size || datasetSettingsDirty || notesDirty) {
    setStatus("This dataset was recalculated on disk. Save or discard local edits before reloading.");
    return;
  }
  calculatedDatasetRefreshInFlight = true;
  try {
    setStatus("Upstream formula change refreshed this dataset. Reloading...");
    await loadDataset();
    setStatus("Dataset refreshed after upstream recalculation.");
  } catch (err) {
    const message = String(err?.message || err || "Dataset refresh failed.");
    setStatus(`Dataset refresh failed: ${message}`);
  } finally {
    calculatedDatasetRefreshInFlight = false;
  }
}

window.addEventListener("message", (e) => {
  if (e?.data?.type === "arcrho:dataset-save") {
    void handleDatasetSaveCommand();
    return;
  }
  if (e?.data?.type === "arcrho:set-app-font") {
    applyAppFont(e.data.font);
  }
  if (e?.data?.type === CALCULATED_DATASETS_UPDATED_MESSAGE) {
    void handleCalculatedDatasetsUpdatedMessage(e.data.report || null);
    return;
  }
  if (e?.data?.type === "arcrho:workflow-global-changed") {
    handleWorkflowGlobalChange(e.data.globalControl);
  }
  if (e?.data?.type === "arcrho:force-rebuild-toggle") {
    try {
      localStorage.setItem(FORCE_REBUILD_KEY, e?.data?.enabled ? "1" : "0");
    } catch {
      // ignore
    }
    return;
  }
  if (e?.data?.type === "arcrho:server-connection-updated") {
    clearValidValueListCache();
    logLine("Server connection updated.");
  }
});

window.addEventListener("storage", (e) => {
  if (!workflowId) return;
  if (e.key === `${WF_GLOBAL_CTRL_PREFIX}${workflowId}`) {
    try {
      const frameEl = window.frameElement;
      if (frameEl && frameEl.offsetParent === null) return;
    } catch {
      // ignore
    }
    handleWorkflowGlobalChange();
  }
});

window.addEventListener("mousedown", () => {
  window.parent.postMessage({ type: "arcrho:close-shell-menus" }, "*");
}, { capture: true });

function requestCloseActiveTab() {
  window.parent.postMessage({ type: "arcrho:close-active-tab" }, "*");
}

window.addEventListener("keydown", (e) => {
  const key = (e.key || "").toLowerCase();
  if (e.altKey && key === "w") {
    e.preventDefault();
    e.stopPropagation();
    requestCloseActiveTab();
    return;
  }
  if (e.ctrlKey && key === "q") {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: "arcrho:hotkey", action: "app_shutdown" }, "*");
    return;
  }
  if (e.ctrlKey) {
    if (key === "s") {
      e.preventDefault();
      e.stopPropagation();
      const action = e.shiftKey ? "file_save_as" : "file_save";
      window.parent.postMessage({ type: "arcrho:hotkey", action }, "*");
      return;
    }
    if (key === "o") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "file_import" }, "*");
      return;
    }
    if (key === "p") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "file_print" }, "*");
      return;
    }
    if (e.shiftKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage({ type: "arcrho:hotkey", action: "view_toggle_nav" }, "*");
      return;
    }
  }
  if (e.altKey && key === "r" && e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: "arcrho:hotkey", action: "file_restart" }, "*");
    return;
  }
}, { capture: true });

// -----------------------------
// Persist dataset across refresh
// -----------------------------
const LS_DS_KEY = "arcrho_last_ds_id";
const LS_FORM_KEY = "arcrho_tri_inputs";

// Per-instance storage (e.g. workflow embeds)
const qs = new URLSearchParams(window.location.search);
const instanceId = qs.get("inst") || "default";
const isProjectInstanceHost = qs.get("project_instance") === "1";
const isProjectInstanceDraft = qs.get("draft_instance") === "1" || qs.get("draft") === "1";
const isReadOnlyDatasetViewer = qs.get("readonly") === "1" || qs.get("generated_dataset") === "1";
let isSidecarReadOnlyDataset = false;
const stepId = instanceId.startsWith("step_") ? instanceId : null;
const scopedKey = (k) => `${k}::${instanceId}`;
const workflowId = qs.get("wf") || "";
const WF_GLOBAL_CTRL_PREFIX = "arcrho_workflow_global_ctrl_v1::";
const DEFAULT_PROJECT_DISPLAY = "Default Project";
const DEFAULT_PATH_DISPLAY = "Default Path";
const DEFAULT_TOKEN = "__DEFAULT__";
const BROWSING_HISTORY_MAX_ENTRIES = 15;
const DATASET_TABS = [
  { id: "details", label: "Details" },
  { id: "data", label: "Data" },
  { id: "chart", label: "Chart" },
  { id: "notes", label: "Notes" },
  { id: "auditLog", label: "Audit Log" },
];

function normalizeDatasetAuditLog(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const eventDate = String(raw.event_date ?? raw["Event Date"] ?? "").trim();
      const action = String(raw.action ?? raw.Action ?? "").trim();
      const changeInfo = String(raw.change_info ?? raw["Change Info"] ?? "").trim();
      const user = String(raw.user ?? raw.User ?? "").trim();
      if (!eventDate && !action && !changeInfo && !user) return null;
      return { eventDate, action, changeInfo, user };
    })
    .filter(Boolean)
    .slice(-50);
}

function formatDatasetAuditEventDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${hour12}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${ampm}`;
}

function renderDatasetAuditLog(entries = []) {
  const body = document.getElementById("datasetAuditLogBody");
  const empty = document.getElementById("datasetAuditLogEmpty");
  if (!body) return;
  const rows = normalizeDatasetAuditLog(entries).slice().reverse();
  body.replaceChildren();
  for (const entry of rows) {
    const tr = document.createElement("tr");
    for (const value of [formatDatasetAuditEventDate(entry.eventDate), entry.action, entry.changeInfo, entry.user]) {
      const td = document.createElement("td");
      td.textContent = value;
      td.title = value;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  if (empty) empty.hidden = rows.length > 0;
}

function normalizeDatasetDependencyEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : { dataset_type_name: entry };
      const datasetName = String(
        source.dataset_name
          ?? source.datasetName
          ?? source.dataset_type_name
          ?? source.datasetTypeName
          ?? source.name
          ?? "",
      ).trim();
      const datasetTypeName = String(
        source.dataset_type_name
          ?? source.datasetTypeName
          ?? source.dataset_type
          ?? source.datasetType
          ?? datasetName,
      ).trim();
      const name = datasetName || datasetTypeName;
      if (!name) return null;
      const key = normalizeProjectText(name);
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        datasetName: name,
        datasetTypeName: datasetTypeName || name,
        formula: String(source.formula ?? source.Formula ?? "").trim(),
        methodType: String(source.method_type ?? source.methodType ?? "").trim(),
      };
    })
    .filter(Boolean);
}

function escapeFormulaRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFormulaComponentNames(precedents = []) {
  const names = [];
  const seen = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    const key = normalizeProjectText(text);
    if (!text || !key || seen.has(key)) return;
    seen.add(key);
    names.push(text);
  };
  for (const entry of normalizeDatasetDependencyEntries(precedents)) {
    add(entry.datasetName);
    add(entry.datasetTypeName);
  }
  for (const name of allDatasetTypes) add(name);
  return names.sort((a, b) => b.length - a.length);
}

function findFormulaComponentMatches(formula, precedents = []) {
  const text = String(formula || "");
  if (!text.trim()) return [];
  const names = getFormulaComponentNames(precedents);
  const matches = [];

  const quotedRe = /"([^"]+)"/g;
  let quotedMatch;
  while ((quotedMatch = quotedRe.exec(text)) !== null) {
    const token = String(quotedMatch[1] || "").trim();
    if (!token) continue;
    matches.push({
      start: quotedMatch.index,
      end: quotedMatch.index + String(quotedMatch[0] || "").length,
      token,
    });
  }

  for (const name of names) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])(${escapeFormulaRegExp(name)})(?=$|[^A-Za-z0-9_])`, "gi");
    let match;
    while ((match = re.exec(text)) !== null) {
      const prefixLen = String(match[1] || "").length;
      const token = String(match[2] || "").trim();
      const start = match.index + prefixLen;
      if (token) matches.push({ start, end: start + token.length, token });
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
  }

  matches.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
  const used = [];
  const out = [];
  for (const hit of matches) {
    const overlaps = used.some((range) => hit.start < range.end && hit.end > range.start);
    if (overlaps) continue;
    const key = normalizeProjectText(hit.token);
    if (!key) continue;
    used.push({ start: hit.start, end: hit.end });
    out.push(hit);
  }
  return out.sort((a, b) => a.start - b.start);
}

function findFormulaDependencyEntry(token, precedents = []) {
  const tokenKey = normalizeProjectText(token);
  if (!tokenKey) return { datasetName: String(token || "").trim(), datasetTypeName: String(token || "").trim() };
  const entries = normalizeDatasetDependencyEntries(precedents);
  const match = entries.find((entry) => (
    normalizeProjectText(entry.datasetName) === tokenKey
    || normalizeProjectText(entry.datasetTypeName) === tokenKey
  ));
  return match || { datasetName: String(token || "").trim(), datasetTypeName: String(token || "").trim() };
}

function createFormulaSvgIcon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function createFormulaOperatorIcon(value) {
  const op = String(value || "").trim();
  if (op === "+") return createFormulaSvgIcon(["M12 5v14", "M5 12h14"]);
  if (op === "-") return createFormulaSvgIcon(["M5 12h14"]);
  if (op === "*") return createFormulaSvgIcon(["M6 6l12 12", "M18 6L6 18"]);
  if (op === "/") return createFormulaSvgIcon(["M16 5L8 19"]);
  return document.createTextNode(op);
}

function createFormulaCalculatedIcon() {
  const icon = document.createElement("span");
  icon.className = "dsFormulaCalculatedIcon";
  icon.appendChild(createFormulaSvgIcon(["M4 7h8v6H4zM12 11h8v6h-8zM12 3h8v6h-8z"]));
  return icon;
}

function datasetFormulaEntryHasFormula(entry) {
  const datasetTypeName = String(entry?.datasetTypeName || entry?.datasetName || "").trim();
  return !!String(entry?.formula || getDatasetTypeFormulaByName(datasetTypeName) || "").trim();
}

function normalizeDatasetMethodType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "dfm") return "DFM";
  if (text === "result selection") return "Result Selection";
  return "";
}

function appendDatasetChipLabel(parent, text) {
  const label = document.createElement("span");
  label.className = "dsFormulaTokenText";
  label.textContent = text;
  parent.appendChild(label);
}

function appendFormulaRawText(parent, text) {
  const value = String(text || "").trim();
  if (!value || !parent) return;
  const span = document.createElement("span");
  span.className = "dsFormulaRawText";
  span.textContent = value;
  parent.appendChild(span);
}

function appendRichFormulaText(parent, text) {
  const segment = String(text || "");
  if (!segment || !parent) return;
  const operatorRe = /[+\-*/()]/g;
  let cursor = 0;
  let match;
  while ((match = operatorRe.exec(segment)) !== null) {
    if (match.index > cursor) {
      appendFormulaRawText(parent, segment.slice(cursor, match.index));
    }
    const op = document.createElement("span");
    const opClass = match[0] === "+" ? " plus" : (match[0] === "-" ? " minus" : "");
    op.className = `dsFormulaOperatorToken${opClass}`;
    op.appendChild(createFormulaOperatorIcon(match[0]));
    parent.appendChild(op);
    cursor = match.index + match[0].length;
  }
  if (cursor < segment.length) {
    appendFormulaRawText(parent, segment.slice(cursor));
  }
}

function appendFormulaComponentChip(parent, entry, label, options = {}) {
  const interactive = !!options.interactive;
  const methodType = normalizeDatasetMethodType(entry?.methodType);
  const openMethod = !!options.openMethod;
  const chip = document.createElement(interactive ? "button" : "span");
  if (interactive) chip.type = "button";
  chip.className = "dsFormulaComponentChip";
  if (datasetFormulaEntryHasFormula(entry)) chip.appendChild(createFormulaCalculatedIcon());
  appendDatasetChipLabel(chip, label);
  if (interactive) {
    chip.setAttribute("aria-label", openMethod && methodType
      ? `Open ${methodType} method ${entry.datasetName || label}`
      : `Open ${entry.datasetName || label}`);
    chip.addEventListener("click", () => openRelatedDataset(entry, { openMethod }));
  }
  parent.appendChild(chip);
}

function renderRichFormulaTokens(parent, formula, precedents = [], options = {}) {
  const formulaText = String(formula || "").trim();
  if (!parent || !formulaText) return;
  const matches = findFormulaComponentMatches(formulaText, precedents);
  if (!matches.length) {
    appendRichFormulaText(parent, formulaText);
    return;
  }

  let cursor = 0;
  for (const hit of matches) {
    if (hit.start > cursor) {
      appendRichFormulaText(parent, formulaText.slice(cursor, hit.start));
    }
    const entry = findFormulaDependencyEntry(hit.token, precedents);
    appendFormulaComponentChip(parent, entry, hit.token, options);
    cursor = hit.end;
  }
  if (cursor < formulaText.length) {
    appendRichFormulaText(parent, formulaText.slice(cursor));
  }
}

function renderDetailFormula(formula, precedents = []) {
  const formulaText = String(formula || "").trim();
  const formulaInput = document.getElementById("dsDetailFormula");
  const formulaBox = document.getElementById("dsDetailFormulaBox");
  if (formulaInput) {
    formulaInput.value = formulaText;
    formulaInput.removeAttribute("title");
  }
  if (!formulaBox) return;
  formulaBox.replaceChildren();
  formulaBox.removeAttribute("title");
  formulaBox.classList.toggle("empty", !formulaText);
  if (!formulaText) {
    return;
  }

  renderRichFormulaTokens(formulaBox, formulaText, precedents, { interactive: true, openMethod: true });
}

function ensureDependentFormulaTooltip() {
  let tooltip = document.getElementById("dsDependentFormulaTooltip");
  if (tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.id = "dsDependentFormulaTooltip";
  tooltip.className = "dsDependentFormulaTooltip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  return tooltip;
}

function positionDependentFormulaTooltip(tooltip, event) {
  if (!tooltip || tooltip.hidden) return;
  const margin = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, event.clientX - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, event.clientY - rect.height - margin);
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showDependentFormulaTooltip(dependent, event) {
  const formula = String(dependent?.formula || "").trim();
  if (!formula) return;
  const tooltip = ensureDependentFormulaTooltip();
  tooltip.replaceChildren();
  const title = document.createElement("div");
  title.className = "dsDependentFormulaTooltipTitle";
  title.textContent = dependent.datasetName || "Dependent dataset";
  const body = document.createElement("div");
  body.className = "dsDependentFormulaTooltipBody";
  renderRichFormulaTokens(body, formula);
  tooltip.append(title, body);
  tooltip.hidden = false;
  positionDependentFormulaTooltip(tooltip, event);
}

function hideDependentFormulaTooltip() {
  const tooltip = document.getElementById("dsDependentFormulaTooltip");
  if (tooltip) tooltip.hidden = true;
}

function openRelatedDataset(entry, options = {}) {
  const datasetName = String(entry?.datasetName || "").trim();
  if (!datasetName) return;
  if (!isProjectInstanceHost) {
    setStatus("Dataset links open from Project Instance dataset windows.");
    return;
  }
  const methodType = normalizeDatasetMethodType(entry?.methodType);
  const payload = buildDatasetSidecarContextPayload();
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-open-dependent-dataset",
      inst: instanceId,
      datasetName,
      datasetTypeName: String(entry?.datasetTypeName || datasetName).trim(),
      methodType,
      openMethod: !!options.openMethod,
      projectName: payload.project_name,
      reservingClass: payload.reserving_class,
    }, "*");
    setStatus(options.openMethod
      ? `Opening related item: ${datasetName}`
      : `Opening dataset: ${datasetName}`);
  } catch {
    setStatus("Could not open dataset from this window.");
  }
}

function renderDatasetDependents(entries = []) {
  const list = document.getElementById("dsDependentsList");
  if (!list) return;
  hideDependentFormulaTooltip();
  const dependents = normalizeDatasetDependencyEntries(entries);
  list.replaceChildren();
  if (!dependents.length) {
    return;
  }
  for (const dependent of dependents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dsDependentLink";
    if (datasetFormulaEntryHasFormula(dependent)) button.appendChild(createFormulaCalculatedIcon());
    appendDatasetChipLabel(button, dependent.datasetName);
    button.setAttribute("aria-label", dependent.formula
      ? `Open ${dependent.datasetName}. Formula: ${dependent.formula}`
      : `Open ${dependent.datasetName}`);
    button.addEventListener("mouseenter", (event) => showDependentFormulaTooltip(dependent, event));
    button.addEventListener("mousemove", (event) => {
      const tooltip = document.getElementById("dsDependentFormulaTooltip");
      positionDependentFormulaTooltip(tooltip, event);
    });
    button.addEventListener("mouseleave", hideDependentFormulaTooltip);
    button.addEventListener("blur", hideDependentFormulaTooltip);
    button.addEventListener("click", () => openRelatedDataset(dependent));
    list.appendChild(button);
  }
}

function getDatasetInitialTab() {
  const requested = String(qs.get("tab") || qs.get("initial_tab") || "").trim();
  return DATASET_TABS.some((tab) => tab.id === requested) ? requested : "data";
}

const LEN_DROPDOWN_CONFIG = {
  originLenSelect: {
    wrapId: "originLenWrap",
    buttonId: "originLenDisplay",
    dropdownId: "originLenDropdown",
  },
  devLenSelect: {
    wrapId: "devLenWrap",
    buttonId: "devLenDisplay",
    dropdownId: "devLenDropdown",
  },
};

let syncingLen = false;
let allProjects = [];
let lastProjectSelection = "";
let activeProjectIndex = -1;
let allDatasetTypes = [];
let activeDatasetIndex = -1;
let lastDatasetSelection = "";
let allReservingClassPaths = [];
let datasetDependencyGuard = null;
let datasetHeadersService = null;
let datasetGridInteractions = null;
let datasetRunController = null;
let reservingClassPathByKey = new Map();
let reservingClassPathPartByKey = new Map();
let lastReservingClassSelection = "";
const datasetProjectPrefs = new Map();
let localDatasetViewerPrefsLoadPromise = null;
let localDatasetViewerProjectSaved = "";
let notesContextKey = "";
let notesContextPayload = null;
let notesDirty = false;
let lastSavedNotesText = "";
let notesProgrammaticInput = false;
let notesSyncNonce = 0;
let datasetSettingsDirty = false;
let datasetSaveInFlight = false;
let datasetInstanceNameConflict = false;
let datasetInstanceNameConflictMessage = "";
let savedProjectInstanceDraftName = "";
let cachedDatasetInstanceRows = [];
let cachedDatasetInstanceKey = "";
let cachedDatasetInstanceLoadPromise = null;
let sidecarContextKey = "";
let sidecarContextPayload = null;
let lastSavedDatasetSettings = null;
let currentDatasetSidecarSourceKind = "";
let currentDatasetSidecarDataFormat = "";
let currentDatasetPrecedents = [];
let sidecarSyncNonce = 0;
let datasetCancelConfirmResolve = null;
const lenDropdownActiveIndexBySelect = new Map();

function setLastProjectSelection(value) {
  lastProjectSelection = String(value || "");
}

function notifyProjectSelectionCommitted(projectName, source = "") {
  const projectInput = document.getElementById("projectSelect");
  const project = String(projectName || "").trim();
  if (!projectInput || !project) return;
  projectInput.dispatchEvent(new CustomEvent("arcrho:project-selected", {
    bubbles: true,
    detail: { projectName: project, source },
  }));
}

function setLastDatasetSelection(value) {
  lastDatasetSelection = String(value || "");
}

function readDatasetInputsFromQueryParams() {
  const project = String(
    qs.get("project")
    || qs.get("project_name")
    || qs.get("p")
    || "",
  ).trim();
  const path = normalizeReservingClassPath(
    qs.get("path")
    || qs.get("reserving_class")
    || qs.get("rc")
    || "",
  );
  const tri = String(
    qs.get("tri")
    || qs.get("dataset_name")
    || qs.get("dataset")
    || "",
  ).trim();
  const instanceName = String(qs.get("instance_name") || qs.get("instanceName") || "").trim();
  const originLen = String(qs.get("origin_len") || qs.get("originLen") || "").trim();
  const devLen = String(qs.get("dev_len") || qs.get("devLen") || "").trim();
  const dataFormat = String(qs.get("data_format") || qs.get("dataFormat") || "").trim();
  const numberFormat = String(qs.get("number_format") || qs.get("numberFormat") || "").trim();
  const decimalPlaces = String(qs.get("decimal_places") || qs.get("decimalPlaces") || "").trim();
  const normalized = normalizeBrowsingHistoryEntry({ project, path, tri });
  if (normalized && instanceName) normalized.instanceName = instanceName;
  if (normalized && originLen) normalized.originLen = originLen;
  if (normalized && devLen) normalized.devLen = devLen;
  if (normalized && dataFormat) normalized.dataFormat = dataFormat;
  if (normalized && numberFormat) normalized.numberFormat = numberFormat;
  if (normalized && decimalPlaces) normalized.decimalPlaces = decimalPlaces;
  return normalized;
}

function normalizeDraftDataFormat(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase() === "vector"
    ? "Vector"
    : "Triangle";
}

function getProjectInstanceDraftDataFormat() {
  const queryInputs = readDatasetInputsFromQueryParams();
  return normalizeDraftDataFormat(queryInputs?.dataFormat);
}

function numericFallbackLabels(count) {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 12;
  return Array.from({ length: safeCount }, (_, index) => String(index + 1));
}

function labelsFromProjectSettings(labels, fallbackCount) {
  if (Array.isArray(labels) && labels.length) return labels.map(String);
  return numericFallbackLabels(fallbackCount);
}

function buildProjectInstanceDraftMask(originCount, devCount, dataFormat) {
  const isVector = normalizeDraftDataFormat(dataFormat) === "Vector";
  return Array.from({ length: originCount }, (_, r) => (
    Array.from({ length: devCount }, (_, c) => isVector || r + c < devCount)
  ));
}

function buildProjectInstanceDraftModel() {
  const { originLen, devLen } = getTriInputs();
  const dataFormat = getProjectInstanceDraftDataFormat();
  const isVector = dataFormat === "Vector";
  const originLabels = labelsFromProjectSettings(state.headerLabels, originLen);
  const projectDevLabels = labelsFromProjectSettings(state.devHeaderLabels, devLen);
  const devLabels = isVector ? [projectDevLabels[0] || "1"] : projectDevLabels;
  const originCount = Math.max(1, originLabels.length);
  const devCount = Math.max(1, devLabels.length);
  const mask = buildProjectInstanceDraftMask(originCount, devCount, dataFormat);
  const values = mask.map((row) => row.map((hasValue) => (hasValue ? 0 : null)));
  return {
    id: `draft:${getDatasetInstanceNameValue() || getTriInputs().tri || "dataset"}`,
    origin_labels: originLabels,
    dev_labels: devLabels,
    values,
    mask,
    data_format: dataFormat,
    mtime: null,
  };
}

function initializeProjectInstanceDraftModel() {
  state.dirty.clear();
  state.fileMtime = null;
  state.model = buildProjectInstanceDraftModel();
  const meta = document.getElementById("dsMeta");
  if (meta) {
    meta.textContent = `draft | origins=${state.model.origin_labels.length} | dev=${state.model.dev_labels.length}`;
  }
}

async function refreshProjectInstanceDraftModel() {
  const project = getResolvedProjectValue();
  if (project) {
    await ensureHeadersForProject(project, { forceRefresh: true });
    await ensureDevHeadersForProject(project, { forceRefresh: true });
  }
  initializeProjectInstanceDraftModel();
  renderTable();
  notifyDatasetUpdated();
  renderChart();
  setStatus("Ready to edit new dataset draft.");
}

function normalizeProjectText(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getDatasetNumberFormatValue() {
  return normalizeDatasetNumberFormat(document.getElementById("numberFormatSelect")?.value);
}

function setDatasetNumberFormatValue(value) {
  const input = document.getElementById("numberFormatSelect");
  if (!input) return;
  input.value = normalizeDatasetNumberFormat(value);
}

function getDatasetDecimalPlacesValue() {
  return clampDatasetDecimalPlaces(document.getElementById("decimalPlaces")?.value);
}

function getDatasetSyncedNumberFormatValue() {
  return applyDecimalPlacesToDatasetNumberFormat(getDatasetNumberFormatValue(), getDatasetDecimalPlacesValue());
}

function setDatasetDecimalPlacesValue(value) {
  const input = document.getElementById("decimalPlaces");
  if (!input) return;
  input.value = String(clampDatasetDecimalPlaces(value));
}

function normalizeDatasetViewerPrefs(raw, projectFallback = "", sharedReservingClassPath = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const project = String(source.project || source.project_name || projectFallback || "").trim();
  const path = normalizeReservingClassPath(
    sharedReservingClassPath
    || source.path
    || source.reservingClass
    || source.reserving_class
    || "",
  );
  const tri = String(source.tri || source.datasetName || source.dataset_name || "").trim();
  if (!project) return null;
  return { project, path, tri };
}

function normalizeLocalDatasetViewerPrefs(raw) {
  const prefs = raw && typeof raw === "object" ? raw : {};
  const project = String(
    prefs.projectName
    || prefs.project_name
    || prefs.project
    || "",
  ).trim();
  return { project };
}

async function loadLastDatasetViewerProjectFromAppData() {
  if (window.ADA_DFM_CONTEXT) return "";
  if (localDatasetViewerPrefsLoadPromise) return localDatasetViewerPrefsLoadPromise;
  localDatasetViewerPrefsLoadPromise = (async () => {
    try {
      const res = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, { cache: "no-store" });
      if (!res.ok) return "";
      const payload = await res.json().catch(() => ({}));
      const normalized = normalizeLocalDatasetViewerPrefs(payload?.preferences || payload);
      localDatasetViewerProjectSaved = normalized.project;
      return normalized.project;
    } catch {
      return "";
    } finally {
      localDatasetViewerPrefsLoadPromise = null;
    }
  })();
  return localDatasetViewerPrefsLoadPromise;
}

function saveLastDatasetViewerProjectToAppData(projectName) {
  if (window.ADA_DFM_CONTEXT) return;
  const project = String(projectName || "").trim();
  if (!project || normalizeProjectText(project) === normalizeProjectText(localDatasetViewerProjectSaved)) return;
  localDatasetViewerProjectSaved = project;
  void (async () => {
    try {
      const res = await fetch(LOCAL_PROJECT_PREFS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: project,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) localDatasetViewerProjectSaved = "";
    } catch {
      localDatasetViewerProjectSaved = "";
    }
  })();
}

async function loadDatasetProjectPrefs(projectName, options = {}) {
  const project = String(projectName || "").trim();
  if (!project) return null;
  const key = normalizeProjectText(project);
  if (!options?.forceReload && datasetProjectPrefs.has(key)) return datasetProjectPrefs.get(key);
  try {
    const prefs = await loadProjectUserPreferences(project, options);
    const normalized = normalizeDatasetViewerPrefs(
      prefs?.datasetViewer,
      project,
      prefs?.lastReservingClassPath || prefs?.last_reserving_class_path || "",
    );
    datasetProjectPrefs.set(key, normalized);
    return normalized;
  } catch {
    datasetProjectPrefs.set(key, null);
    return null;
  }
}

function saveDatasetProjectPrefs(raw) {
  const normalized = normalizeDatasetViewerPrefs(raw);
  if (!normalized) return;
  const key = normalizeProjectText(normalized.project);
  datasetProjectPrefs.set(key, normalized);
  scheduleProjectUserPreferencesSave(normalized.project, {
    lastReservingClassPath: normalized.path,
    datasetViewer: {
      datasetName: normalized.tri,
      updated_at: new Date().toISOString(),
    },
  });
}

function getDefaultDisplayLabelForInput(input) {
  if (input?.id === "projectSelect") return DEFAULT_PROJECT_DISPLAY;
  if (input?.id === "pathInput") return DEFAULT_PATH_DISPLAY;
  return "Default";
}

function buildDefaultDisplayValue(input, raw) {
  const resolved = String(raw || "").trim();
  const label = getDefaultDisplayLabelForInput(input);
  return resolved ? `${label} (${resolved})` : label;
}

function getDefaultValueForInput(input) {
  const defaults = loadWorkflowDefaults();
  if (!defaults || !input) return "";
  if (input.id === "projectSelect") return defaults.project || "";
  if (input.id === "pathInput") return defaults.reservingClass || "";
  return "";
}

function isDefaultTokenValue(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (lower === DEFAULT_TOKEN.toLowerCase() || lower === "default") return true;
  const defaultLabels = [DEFAULT_PROJECT_DISPLAY, DEFAULT_PATH_DISPLAY];
  return defaultLabels.some((label) => {
    const labelLower = label.toLowerCase();
    return lower === labelLower || (lower.startsWith(`${labelLower} (`) && lower.endsWith(")"));
  });
}

function isInputDefaultBound(input) {
  if (!input) return false;
  if (input.dataset?.globalDefault === "1") return true;
  return isDefaultTokenValue(input.value);
}

function setInputDefaultBound(input, bound) {
  if (!input) return;
  if (bound) {
    input.dataset.globalDefault = "1";
    input.value = buildDefaultDisplayValue(input, getDefaultValueForInput(input));
  } else {
    delete input.dataset.globalDefault;
  }
}

function getWorkflowVarValue(vars, key, fallbackName) {
  if (!Array.isArray(vars)) return "";
  const byKey = vars.find((v) => v && typeof v === "object" && String(v.key || "") === key);
  if (byKey && typeof byKey.value === "string") return byKey.value.trim();
  const target = String(fallbackName || "").trim().toLowerCase();
  if (!target) return "";
  const byName = vars.find((v) => {
    if (!v || typeof v !== "object") return false;
    const name = String(v.name || "").trim().toLowerCase();
    return name === target;
  });
  if (byName && typeof byName.value === "string") return byName.value.trim();
  return "";
}

function normalizeSearchTokens(q) {
  return normalizeProjectText(q).split(" ").filter(Boolean);
}

function matchesProject(name, tokens) {
  if (!tokens.length) return true;
  const hay = normalizeProjectText(name);
  return tokens.every(t => hay.includes(t));
}

function getActiveProjectValue() {
  const list = document.getElementById("projectDropdown");
  if (!list) return "";
  const opt = list.children[activeProjectIndex];
  return opt?.dataset?.value || "";
}

function renderProjectOptions(projects, activeValue = "") {
  const list = document.getElementById("projectDropdown");
  if (!list) return;
  list.innerHTML = "";
  const defaults = loadWorkflowDefaults();
  const defaultProject = (defaults?.project || "").trim();
  const options = [];
  if (workflowId && defaultProject) {
    options.push({
      label: buildDefaultDisplayValue(document.getElementById("projectSelect"), defaultProject),
      value: DEFAULT_TOKEN,
    });
  }
  for (const p of projects) {
    options.push({ label: p, value: p });
  }

  options.forEach((optData, i) => {
    const opt = document.createElement("div");
    opt.className = "projectOption";
    opt.textContent = optData.label;
    opt.dataset.value = optData.value;
    opt.dataset.index = String(i);
    opt.addEventListener("mouseenter", () => {
      setActiveProjectIndex(i);
    });
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const projectInput = document.getElementById("projectSelect");
      if (projectInput) {
        if (isDefaultTokenValue(optData.value)) {
          setInputDefaultBound(projectInput, true);
        } else {
          setInputDefaultBound(projectInput, false);
          projectInput.value = optData.value;
        }
      }
      showProjectDropdown(false);
      void handleProjectSelection(optData.value);
    });
    list.appendChild(opt);
  });

  activeProjectIndex = -1;
  if (options.length) {
    let idx = 0;
    if (activeValue) {
      const found = options.findIndex((o) => o.value === activeValue);
      if (found >= 0) idx = found;
    }
    setActiveProjectIndex(idx);
  }
}

function showProjectDropdown(open) {
  const list = document.getElementById("projectDropdown");
  if (!list) return;
  const hasItems = !!list.children.length;
  if (open && hasItems) list.classList.add("open");
  else list.classList.remove("open");
}

function filterProjectOptions(query) {
  const tokens = normalizeSearchTokens(query);
  const filtered = tokens.length
    ? allProjects.filter(p => matchesProject(p, tokens))
    : allProjects.slice();
  const activeValue = getActiveProjectValue();
  renderProjectOptions(filtered, activeValue);
  showProjectDropdown(true);
}

function getProjectFilterQuery(input) {
  if (isInputDefaultBound(input)) return "";
  return input?.value || "";
}

function getProjectOptionsList() {
  const list = document.getElementById("projectDropdown");
  if (!list) return [];
  return Array.from(list.children);
}

function setActiveProjectIndex(idx) {
  const opts = getProjectOptionsList();
  if (!opts.length) {
    activeProjectIndex = -1;
    return;
  }
  let next = idx;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  activeProjectIndex = next;
  opts.forEach((el, i) => el.classList.toggle("active", i === activeProjectIndex));
  opts[activeProjectIndex].scrollIntoView({ block: "nearest" });
}

function getActiveProjectIndex() {
  return activeProjectIndex;
}

function chooseActiveProject() {
  const opts = getProjectOptionsList();
  if (activeProjectIndex < 0 || activeProjectIndex >= opts.length) return false;
  const value = opts[activeProjectIndex].dataset.value || opts[activeProjectIndex].textContent;
  if (!value) return false;
  const projectInput = document.getElementById("projectSelect");
  if (projectInput) {
    if (isDefaultTokenValue(value)) {
      setInputDefaultBound(projectInput, true);
    } else {
      setInputDefaultBound(projectInput, false);
      projectInput.value = value;
    }
  }
  showProjectDropdown(false);
  void handleProjectSelection(value);
  return true;
}

function findExactProjectMatch(value) {
  const v = normalizeProjectText(value);
  if (!v) return "";
  return allProjects.find(p => normalizeProjectText(p) === v) || "";
}

function getActiveDatasetValue() {
  const list = document.getElementById("datasetDropdown");
  if (!list) return "";
  const opt = list.children[activeDatasetIndex];
  return opt?.dataset?.value || "";
}

function renderDatasetOptions(items, activeValue = "") {
  const list = document.getElementById("datasetDropdown");
  if (!list) return;
  list.innerHTML = "";
  items.forEach((name, i) => {
    const opt = document.createElement("div");
    opt.className = "datasetOption";
    opt.textContent = name;
    opt.dataset.value = name;
    opt.dataset.index = String(i);
    opt.addEventListener("mouseenter", () => {
      setActiveDatasetIndex(i);
    });
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const triInput = document.getElementById("triInput");
      if (triInput) triInput.value = name;
      showDatasetDropdown(false);
      void handleDatasetSelection(name);
    });
    list.appendChild(opt);
  });

  activeDatasetIndex = -1;
  if (items.length) {
    const idx = activeValue ? Math.max(0, items.indexOf(activeValue)) : 0;
    setActiveDatasetIndex(idx);
  }
}

function showDatasetDropdown(open) {
  const list = document.getElementById("datasetDropdown");
  if (!list) return;
  const hasItems = !!list.children.length;
  if (open && hasItems) list.classList.add("open");
  else list.classList.remove("open");
}

function filterDatasetOptions(query) {
  if (!allDatasetTypes.length) {
    showDatasetDropdown(false);
    return;
  }
  const tokens = normalizeSearchTokens(query);
  const filtered = tokens.length
    ? allDatasetTypes.filter(name => matchesProject(name, tokens))
    : allDatasetTypes;
  const activeValue = getActiveDatasetValue();
  renderDatasetOptions(filtered, activeValue);
  showDatasetDropdown(true);
}

function getDatasetOptionsList() {
  const list = document.getElementById("datasetDropdown");
  if (!list) return [];
  return Array.from(list.children);
}

function setActiveDatasetIndex(idx) {
  const opts = getDatasetOptionsList();
  if (!opts.length) {
    activeDatasetIndex = -1;
    return;
  }
  let next = idx;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  activeDatasetIndex = next;
  opts.forEach((el, i) => el.classList.toggle("active", i === activeDatasetIndex));
  opts[activeDatasetIndex].scrollIntoView({ block: "nearest" });
}

function getActiveDatasetIndex() {
  return activeDatasetIndex;
}

function chooseActiveDataset() {
  const opts = getDatasetOptionsList();
  if (activeDatasetIndex < 0 || activeDatasetIndex >= opts.length) return false;
  const value = opts[activeDatasetIndex].dataset.value || opts[activeDatasetIndex].textContent;
  if (!value) return false;
  const triInput = document.getElementById("triInput");
  if (triInput) triInput.value = value;
  showDatasetDropdown(false);
  void handleDatasetSelection(value);
  return true;
}

function findExactDatasetMatch(value) {
  const v = normalizeProjectText(value);
  if (!v) return "";
  return allDatasetTypes.find(name => normalizeProjectText(name) === v) || "";
}

function ensureDatasetTypeOption(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  const key = normalizeProjectText(name);
  const existing = allDatasetTypes.find((item) => normalizeProjectText(item) === key);
  if (existing) return existing;

  allDatasetTypes = [...allDatasetTypes, name].sort((a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true }),
  );
  renderDatasetOptions(allDatasetTypes, name);
  return name;
}

function getDatasetTypeFormulaByName(datasetTypeName) {
  const key = normalizeProjectText(datasetTypeName);
  if (!key) return "";
  const formulaMap = state.datasetTypeFormulaByKey instanceof Map ? state.datasetTypeFormulaByKey : null;
  if (!formulaMap) return "";
  return String(formulaMap.get(key) || "").trim();
}

function resizeDetailFormulaInput() {
  const formulaBox = document.getElementById("dsDetailFormulaBox");
  if (!formulaBox) return;
  formulaBox.style.maxHeight = "140px";
}

window.addEventListener("resize", () => {
  resizeDetailFormulaInput();
});

function syncDetailFormulaFromDatasetType(datasetTypeName) {
  const formula = getDatasetTypeFormulaByName(datasetTypeName);
  renderDetailFormula(formula, currentDatasetPrecedents);
  resizeDetailFormulaInput();
}

function syncDetailDatasetTypeFromTopInput(rawValue, options = {}) {
  const syncName = !!options?.syncName;
  const dsDetailName = document.getElementById("dsDetailName");
  const prevType = String(dsDetailName?.dataset?.datasetType || "").trim();
  const raw = String(rawValue || "").trim();
  const canonical = raw ? (ensureDatasetTypeOption(raw) || raw) : "";
  const nextType = String(canonical || "").trim();

  if (dsDetailName) {
    if (syncName) {
      const currentName = String(dsDetailName.value || "").trim();
      if (!currentName || normalizeProjectText(prevType) !== normalizeProjectText(nextType)) {
        dsDetailName.value = nextType;
      }
    }
    dsDetailName.dataset.datasetType = nextType;
  }

  syncDetailFormulaFromDatasetType(nextType);
  void refreshDatasetInstanceNameConflict();
}

function getDatasetInstanceNameValue() {
  const detailName = String(document.getElementById("dsDetailName")?.value || "").trim();
  return detailName || String(document.getElementById("triInput")?.value || "").trim();
}

function normalizeDatasetInstanceKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getCachedInstanceNamesFromItem(item = {}) {
  const names = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) names.push(text);
  };
  add(item.name);
  return names;
}

function cachedInstanceMatchesName(item, instanceName) {
  const instanceKey = normalizeDatasetInstanceKey(instanceName);
  if (!instanceKey) return false;
  const itemNames = getCachedInstanceNamesFromItem(item).map(normalizeDatasetInstanceKey);
  return itemNames.includes(instanceKey);
}

async function loadCachedDatasetInstancesForCurrentContext() {
  const project = getResolvedProjectValue();
  const path = getResolvedReservingClassValue();
  if (!project || !path) {
    cachedDatasetInstanceRows = [];
    cachedDatasetInstanceKey = "";
    return [];
  }
  const key = `${normalizeProjectText(project)}\u001f${normalizeReservingClassPath(path).toLowerCase()}`;
  if (cachedDatasetInstanceKey === key) return cachedDatasetInstanceRows;
  if (cachedDatasetInstanceLoadPromise) return cachedDatasetInstanceLoadPromise;
  cachedDatasetInstanceLoadPromise = (async () => {
    try {
      const url = new URL("/datasets/cached", window.location.origin);
      url.searchParams.set("project_name", project);
      url.searchParams.set("reserving_class", path);
      const resp = await fetch(url.toString(), { cache: "no-store" });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || "Cached dataset lookup failed.");
      cachedDatasetInstanceRows = Array.isArray(payload?.files) ? payload.files : [];
      cachedDatasetInstanceKey = key;
      return cachedDatasetInstanceRows;
    } catch {
      cachedDatasetInstanceRows = [];
      cachedDatasetInstanceKey = key;
      return cachedDatasetInstanceRows;
    } finally {
      cachedDatasetInstanceLoadPromise = null;
    }
  })();
  return cachedDatasetInstanceLoadPromise;
}

function setDatasetInstanceNameConflict(hasConflict, message = "") {
  datasetInstanceNameConflict = !!hasConflict;
  datasetInstanceNameConflictMessage = datasetInstanceNameConflict ? String(message || "Name already exists.") : "";
  const warning = document.getElementById("dsDetailNameWarning");
  if (warning) {
    warning.textContent = datasetInstanceNameConflictMessage;
    warning.hidden = !datasetInstanceNameConflict;
  }
  const input = document.getElementById("dsDetailName");
  if (input) {
    input.setCustomValidity(datasetInstanceNameConflict ? datasetInstanceNameConflictMessage : "");
    input.classList.toggle("invalid", datasetInstanceNameConflict);
  }
  updateDatasetSaveUi();
}

function invalidateCachedDatasetInstances() {
  cachedDatasetInstanceRows = [];
  cachedDatasetInstanceKey = "";
  cachedDatasetInstanceLoadPromise = null;
}

async function refreshDatasetInstanceNameConflict() {
  if (!isProjectInstanceDraft) {
    setDatasetInstanceNameConflict(false);
    return false;
  }
  const instanceName = getDatasetInstanceNameValue();
  if (!instanceName) {
    setDatasetInstanceNameConflict(false);
    return false;
  }
  if (savedProjectInstanceDraftName && normalizeDatasetInstanceKey(instanceName) === normalizeDatasetInstanceKey(savedProjectInstanceDraftName)) {
    setDatasetInstanceNameConflict(false);
    return false;
  }
  const rows = await loadCachedDatasetInstancesForCurrentContext();
  const conflict = rows.some((item) => cachedInstanceMatchesName(item, instanceName));
  setDatasetInstanceNameConflict(
    conflict,
    conflict ? "Name already exists in this reserving class path." : "",
  );
  return conflict;
}

function loadDatasetTypeDependencyModel(projectName, options = {}) {
  return datasetDependencyGuard.loadDatasetTypeDependencyModel(projectName, options);
}

function validateDatasetTypeDependencies(datasetType, options = {}) {
  return datasetDependencyGuard.validateDatasetTypeDependencies(datasetType, options);
}

function setInputInvalid(input, message) {
  if (!input) return;
  input.setCustomValidity(String(message || "Invalid value."));
}

function clearInputInvalid(input) {
  if (!input) return;
  input.setCustomValidity("");
}

function reportInputInvalid(input, message, statusText = "") {
  if (!input) return;
  setInputInvalid(input, message);
  try { input.reportValidity(); } catch {}
  if (statusText) setStatus(statusText);
}

function rebuildReservingClassPathLookup(paths) {
  reservingClassPathByKey = new Map();
  reservingClassPathPartByKey = buildReservingClassPathPartLookup(paths);
  for (const raw of Array.isArray(paths) ? paths : []) {
    const normalized = normalizeReservingClassPath(raw);
    if (!normalized) continue;
    const key = normalizeReservingClassPathKey(normalized);
    if (!key || reservingClassPathByKey.has(key)) continue;
    reservingClassPathByKey.set(key, normalized);
  }
}

function findExactReservingClassMatch(value) {
  const normalized = normalizeReservingClassPath(value);
  const key = normalizeReservingClassPathKey(normalized);
  if (!key) return "";
  const exact = reservingClassPathByKey.get(key);
  if (exact) return exact;
  return normalizeReservingClassPathByPartLookup(normalized, reservingClassPathPartByKey);
}

function ensureReservingClassOption(value) {
  const normalized = normalizeReservingClassPath(value);
  if (!normalized) return "";
  const existing = findExactReservingClassMatch(normalized);
  if (existing) return existing;
  allReservingClassPaths = [...allReservingClassPaths, normalized].sort((a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true }),
  );
  rebuildReservingClassPathLookup(allReservingClassPaths);
  return normalized;
}

async function refreshDatasetTypesForProject(project, useCache = true) {
  datasetDependencyGuard.clearProjectCache(project);

  if (!project) {
    allDatasetTypes = [];
    state.datasetTypeSourceByKey = new Map();
    state.datasetTypeFormulaByKey = new Map();
    renderDatasetOptions([]);
    syncDetailDatasetTypeFromTopInput(document.getElementById("triInput")?.value || "", { syncName: false });
    showDatasetDropdown(false);
    return;
  }

  let items = [];
  try {
    items = await loadDatasetValidValueList(project, { forceReload: !useCache });
  } catch (err) {
    console.error(`Failed to load dataset types for project "${project}":`, err);
    items = [];
  }
  allDatasetTypes = Array.isArray(items) ? items : [];
  try {
    await loadDatasetTypeDependencyModel(project, { forceReload: !useCache });
  } catch {
    state.datasetTypeSourceByKey = new Map();
    state.datasetTypeFormulaByKey = new Map();
  }
  renderDatasetOptions(allDatasetTypes);
  syncDetailDatasetTypeFromTopInput(document.getElementById("triInput")?.value || "", { syncName: false });
  showDatasetDropdown(false);
}

async function refreshReservingClassPathsForProject(project, useCache = true) {
  if (!project) {
    allReservingClassPaths = [];
    rebuildReservingClassPathLookup([]);
    return;
  }

  let items = [];
  try {
    items = await loadReservingClassValidValueList(project, { forceReload: !useCache });
  } catch (err) {
    console.error(`Failed to load reserving class values for project "${project}":`, err);
    items = [];
  }
  allReservingClassPaths = Array.isArray(items) ? items : [];
  rebuildReservingClassPathLookup(allReservingClassPaths);
}

async function handleDatasetSelection(value, options = {}) {
  const strict = !!options?.strict;
  const showMessage = !!options?.showMessage;
  const name = findExactDatasetMatch(value);
  const triInput = document.getElementById("triInput");
  if (!name) {
    if (strict && triInput) {
      if (lastDatasetSelection) triInput.value = lastDatasetSelection;
      else triInput.value = "";
      clearInputInvalid(triInput);
      if (showMessage) {
        reportInputInvalid(
          triInput,
          "Dataset Type is not in the valid list for this project.",
          "Invalid Dataset Type. Please select a value from the valid list.",
        );
      }
    }
    return false;
  }
  const switched = name !== lastDatasetSelection;

  if (triInput) triInput.value = name;
  syncDetailDatasetTypeFromTopInput(name, { syncName: switched });
  const dependencyResult = await validateDatasetTypeDependencies(name, {
    showMessage: switched || showMessage || strict,
  });
  if (!dependencyResult.ok) {
    showDatasetDropdown(false);
    return false;
  }
  lastDatasetSelection = name;
  clearInputInvalid(triInput);
  showDatasetDropdown(false);
  if (switched) {
    saveTriInputsToStorage();
    await syncSidecarForCurrentDataset({ applyLengths: true });
    enforceDevLenRule({ source: "origin" });
    scheduleAutoRun();
  }
  return true;
}

function validateAndNormalizeProjectInput(options = {}) {
  const strict = !!options?.strict;
  const showMessage = !!options?.showMessage;
  const input = document.getElementById("projectSelect");
  if (!input) return { ok: false, value: "" };

  if (isInputDefaultBound(input)) {
    const resolvedDefault = getResolvedProjectValue();
    const matchedDefault = findExactProjectMatch(resolvedDefault);
    if (!matchedDefault) {
      if (strict && showMessage) {
        reportInputInvalid(
          input,
          "Default Project is not in the valid list.",
          "Invalid Project Name. Please select a valid project.",
        );
      }
      return { ok: false, value: "" };
    }
    clearInputInvalid(input);
    return { ok: true, value: matchedDefault };
  }

  const raw = String(input.value || "").trim();
  const matched = findExactProjectMatch(raw);
  if (!matched) {
    if (strict) {
      if (lastProjectSelection) input.value = lastProjectSelection;
      else input.value = "";
      clearInputInvalid(input);
      if (showMessage) {
        reportInputInvalid(
          input,
          "Project Name is not in the valid list.",
          "Invalid Project Name. Please select a valid project.",
        );
      }
    }
    return { ok: false, value: "" };
  }
  input.value = matched;
  clearInputInvalid(input);
  return { ok: true, value: matched };
}

function validateAndNormalizeDatasetInput(options = {}) {
  const strict = !!options?.strict;
  const showMessage = !!options?.showMessage;
  const input = document.getElementById("triInput");
  if (!input) return { ok: false, value: "" };
  const matched = findExactDatasetMatch(input.value);
  if (!matched) {
    if (strict) {
      if (lastDatasetSelection) input.value = lastDatasetSelection;
      else input.value = "";
      clearInputInvalid(input);
      if (showMessage) {
        reportInputInvalid(
          input,
          "Dataset Type is not in the valid list for this project.",
          "Invalid Dataset Type. Please select a value from the valid list.",
        );
      }
    }
    return { ok: false, value: "" };
  }
  input.value = matched;
  clearInputInvalid(input);
  return { ok: true, value: matched };
}

async function validateAndNormalizeReservingClassInput(projectName, options = {}) {
  const strict = !!options?.strict;
  const showMessage = !!options?.showMessage;
  const input = document.getElementById("pathInput");
  if (!input) return { ok: false, value: "" };
  const project = String(projectName || "").trim();

  if (isInputDefaultBound(input)) {
    const resolvedDefault = getResolvedReservingClassValue();
    const normalizedDefault = normalizeReservingClassPath(resolvedDefault);
    if (!normalizedDefault) {
      if (strict && showMessage) {
        reportInputInvalid(
          input,
          "Default Path is empty.",
          "Invalid Reserving Class. Please select a value from the valid list.",
        );
      }
      return { ok: false, value: "" };
    }
    const validatedDefault = await validateReservingClassPathByTypeNames(project, normalizedDefault);
    if (!validatedDefault?.ok || !validatedDefault?.path) {
      if (strict && showMessage) {
        reportInputInvalid(
          input,
          "Default Path is not in the valid list for this project.",
          "Invalid Reserving Class. Please select a value from the valid list.",
        );
      }
      return { ok: false, value: "" };
    }
    const canonicalDefault = normalizeReservingClassPath(validatedDefault.path);
    clearInputInvalid(input);
    lastReservingClassSelection = canonicalDefault;
    return { ok: true, value: canonicalDefault };
  }

  const normalizedInput = normalizeReservingClassPath(input.value);
  if (!normalizedInput) {
    if (strict) {
      if (lastReservingClassSelection) input.value = lastReservingClassSelection;
      else input.value = "";
      clearInputInvalid(input);
      if (showMessage) {
        reportInputInvalid(
          input,
          "Reserving Class is not in the valid list for this project.",
          "Invalid Reserving Class. Please select a value from the valid list.",
        );
      }
    }
    return { ok: false, value: "" };
  }

  const validatedInput = await validateReservingClassPathByTypeNames(project, normalizedInput);
  if (!validatedInput?.ok || !validatedInput?.path) {
    if (strict) {
      if (lastReservingClassSelection) input.value = lastReservingClassSelection;
      else input.value = "";
      clearInputInvalid(input);
      if (showMessage) {
        reportInputInvalid(
          input,
          "Reserving Class is not in the valid list for this project.",
          "Invalid Reserving Class. Please select a value from the valid list.",
        );
      }
    }
    return { ok: false, value: "" };
  }

  input.value = normalizeReservingClassPath(validatedInput.path);
  clearInputInvalid(input);
  lastReservingClassSelection = input.value;
  return { ok: true, value: input.value };
}

async function validateTriInputsBeforeRun(options = {}) {
  const showMessage = !!options?.showMessage;
  const hasNameConflict = await refreshDatasetInstanceNameConflict();
  if (hasNameConflict) {
    setStatus(datasetInstanceNameConflictMessage || "Dataset instance name already exists.");
    return { ok: false };
  }
  const projectResult = validateAndNormalizeProjectInput({ strict: true, showMessage });
  if (!projectResult.ok || !projectResult.value) return { ok: false };

  const project = projectResult.value;
  await refreshDatasetTypesForProject(project);
  await refreshReservingClassPathsForProject(project);

  const reservingResult = await validateAndNormalizeReservingClassInput(project, { strict: true, showMessage });
  if (!reservingResult.ok || !reservingResult.value) return { ok: false };

  const datasetResult = validateAndNormalizeDatasetInput({ strict: true, showMessage });
  if (!datasetResult.ok || !datasetResult.value) return { ok: false };
  const triInputs = getTriInputs();
  const dependencyResult = await validateDatasetTypeDependencies(datasetResult.value, {
    showMessage,
    precheckInputs: {
      project,
      path: reservingResult.value,
      tri: datasetResult.value,
      instanceName: triInputs.instanceName,
      cumulative: triInputs.cumulative,
      calendar: triInputs.calendar,
      originLen: triInputs.originLen,
      devLen: triInputs.devLen,
    },
  });
  if (!dependencyResult.ok) return { ok: false };

  saveTriInputsToStorage();
  return {
    ok: true,
    project,
    path: reservingResult.value,
    tri: datasetResult.value,
    instanceName: triInputs.instanceName,
    dependencyBypassedByExistingCsv: !!dependencyResult?.bypassedByExistingCsv,
  };
}

function recordDatasetBrowsingHistory(entry) {
  if (window.ADA_DFM_CONTEXT) return;
  const normalized = normalizeBrowsingHistoryEntry(entry);
  if (!normalized) return;
  const out = pushBrowsingHistoryEntry(normalized, { maxEntries: BROWSING_HISTORY_MAX_ENTRIES });
  try {
    window.parent.postMessage(
      {
        type: "arcrho:browsing-history-updated",
        entry: out?.entry || normalized,
      },
      "*",
    );
  } catch {
    // ignore
  }
}

function getLenDropdownIds(selectId) {
  return LEN_DROPDOWN_CONFIG[selectId] || null;
}

function getLenDropdownElements(selectId) {
  const ids = getLenDropdownIds(selectId);
  if (!ids) return null;
  return {
    select: document.getElementById(selectId),
    wrap: document.getElementById(ids.wrapId),
    button: document.getElementById(ids.buttonId),
    dropdown: document.getElementById(ids.dropdownId),
  };
}

function getLenDropdownActiveIndex(selectId) {
  const idx = lenDropdownActiveIndexBySelect.get(selectId);
  return Number.isInteger(idx) ? idx : -1;
}

function setLenDropdownActiveIndex(selectId, idx) {
  const parts = getLenDropdownElements(selectId);
  const dropdown = parts?.dropdown;
  if (!dropdown) return;
  const opts = Array.from(dropdown.children);
  if (!opts.length) {
    lenDropdownActiveIndexBySelect.set(selectId, -1);
    return;
  }
  let next = Number.isFinite(idx) ? idx : 0;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  lenDropdownActiveIndexBySelect.set(selectId, next);
  opts.forEach((el, i) => el.classList.toggle("active", i === next));
  opts[next]?.scrollIntoView?.({ block: "nearest" });
}

function syncLenDropdownButtonLabel(selectId) {
  const parts = getLenDropdownElements(selectId);
  const select = parts?.select;
  const button = parts?.button;
  if (!select || !button) return;
  const label = button.querySelector(".lenSelectValue");
  if (!label) return;
  const selected = select.options[select.selectedIndex];
  label.textContent = (selected?.textContent || select.value || "").trim();
}

function renderLenDropdownOptions(selectId) {
  const parts = getLenDropdownElements(selectId);
  const select = parts?.select;
  const dropdown = parts?.dropdown;
  if (!select || !dropdown) return;

  dropdown.innerHTML = "";
  const options = Array.from(select.options);
  if (!options.length) {
    lenDropdownActiveIndexBySelect.set(selectId, -1);
    syncLenDropdownButtonLabel(selectId);
    showLenDropdown(selectId, false);
    return;
  }

  options.forEach((opt, i) => {
    const item = document.createElement("div");
    item.className = "datasetOption lenOption";
    item.textContent = String(opt.textContent || opt.value || "");
    item.dataset.value = String(opt.value || "");
    item.dataset.index = String(i);
    item.addEventListener("mouseenter", () => {
      setLenDropdownActiveIndex(selectId, i);
    });
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setLenSelectValue(selectId, opt.value, { emitChange: true });
      showLenDropdown(selectId, false);
      parts.button?.focus();
    });
    dropdown.appendChild(item);
  });

  const selectedIdx = options.findIndex((opt) => opt.value === select.value);
  setLenDropdownActiveIndex(selectId, selectedIdx >= 0 ? selectedIdx : 0);
  syncLenDropdownButtonLabel(selectId);
}

function refreshLenDropdowns() {
  Object.keys(LEN_DROPDOWN_CONFIG).forEach((selectId) => {
    renderLenDropdownOptions(selectId);
  });
}

function showLenDropdown(selectId, open) {
  const parts = getLenDropdownElements(selectId);
  const wrap = parts?.wrap;
  const dropdown = parts?.dropdown;
  const button = parts?.button;
  if (!wrap || !dropdown || !button) return;

  if (open) {
    Object.keys(LEN_DROPDOWN_CONFIG).forEach((id) => {
      if (id !== selectId) showLenDropdown(id, false);
    });
  }

  const shouldOpen = !!open && !!dropdown.children.length;
  wrap.classList.toggle("open", shouldOpen);
  dropdown.classList.toggle("open", shouldOpen);
  button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function closeAllLenDropdowns() {
  Object.keys(LEN_DROPDOWN_CONFIG).forEach((selectId) => {
    showLenDropdown(selectId, false);
  });
}

function setLenSelectValue(selectId, value, options = {}) {
  const emitChange = !!options?.emitChange;
  const select = document.getElementById(selectId);
  if (!select) return false;
  const nextValue = String(value ?? "");
  if (![...select.options].some((opt) => opt.value === nextValue)) return false;
  const changed = select.value !== nextValue;
  select.value = nextValue;
  syncLenDropdownButtonLabel(selectId);
  renderLenDropdownOptions(selectId);
  if (emitChange && changed) {
    select.dispatchEvent(new Event("change"));
  }
  return true;
}

function chooseActiveLenDropdownOption(selectId) {
  const select = document.getElementById(selectId);
  if (!select || !select.options.length) return false;
  const idx = getLenDropdownActiveIndex(selectId);
  let nextIdx = idx;
  if (nextIdx < 0 || nextIdx >= select.options.length) {
    nextIdx = Math.max(0, select.selectedIndex);
  }
  const opt = select.options[nextIdx];
  if (!opt) return false;
  const changed = select.value !== opt.value;
  select.value = opt.value;
  syncLenDropdownButtonLabel(selectId);
  renderLenDropdownOptions(selectId);
  showLenDropdown(selectId, false);
  if (changed) select.dispatchEvent(new Event("change"));
  return true;
}

function moveLenDropdownActiveOption(selectId, dir) {
  const parts = getLenDropdownElements(selectId);
  const dropdown = parts?.dropdown;
  if (!dropdown || !dropdown.children.length) return;
  const idx = getLenDropdownActiveIndex(selectId);
  const baseIdx = idx >= 0 ? idx : 0;
  setLenDropdownActiveIndex(selectId, baseIdx + dir);
}

function cycleLenSelect(selectId, dir) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const idx = select.selectedIndex + dir;
  if (idx < 0 || idx >= select.options.length) return;
  select.selectedIndex = idx;
  syncLenDropdownButtonLabel(selectId);
  renderLenDropdownOptions(selectId);
  select.dispatchEvent(new Event("change"));
}

function wireLenDropdown(selectId) {
  const parts = getLenDropdownElements(selectId);
  const select = parts?.select;
  const button = parts?.button;
  const wrap = parts?.wrap;
  if (!select || !button || !wrap) return;
  if (button.dataset.wired === "1") return;
  button.dataset.wired = "1";

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showProjectDropdown(false);
    showDatasetDropdown(false);
    const willOpen = !wrap.classList.contains("open");
    if (willOpen) renderLenDropdownOptions(selectId);
    showLenDropdown(selectId, willOpen);
  });

  button.addEventListener("keydown", (e) => {
    const key = e.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!wrap.classList.contains("open")) {
        renderLenDropdownOptions(selectId);
        showLenDropdown(selectId, true);
      }
      moveLenDropdownActiveOption(selectId, key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (wrap.classList.contains("open")) {
        chooseActiveLenDropdownOption(selectId);
      } else {
        renderLenDropdownOptions(selectId);
        showLenDropdown(selectId, true);
      }
      return;
    }
    if (key === "Escape" && wrap.classList.contains("open")) {
      e.preventDefault();
      e.stopPropagation();
      showLenDropdown(selectId, false);
    }
  });

  button.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY > 0 ? 1 : -1;
    cycleLenSelect(selectId, dir);
  }, { passive: false });

  wrap.addEventListener("focusout", (e) => {
    const next = e.relatedTarget;
    if (next && wrap.contains(next)) return;
    showLenDropdown(selectId, false);
  });

  select.addEventListener("change", () => {
    syncLenDropdownButtonLabel(selectId);
    renderLenDropdownOptions(selectId);
  });

  syncLenDropdownButtonLabel(selectId);
  renderLenDropdownOptions(selectId);
  showLenDropdown(selectId, false);
}

function wireLenDropdowns() {
  Object.keys(LEN_DROPDOWN_CONFIG).forEach((selectId) => {
    wireLenDropdown(selectId);
  });
}

function isLenLinked() {
  return !!document.getElementById("linkLenChk")?.checked;
}

function syncLen(from) {
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return;
  if (!isLenLinked()) return;
  if (syncingLen) return;

  syncingLen = true;
  try {
    if (from === "origin") {
      setLenSelectValue("devLenSelect", o.value);
    } else if (from === "dev") {
      setLenSelectValue("originLenSelect", d.value);
    } else {
      // init / unknown
      setLenSelectValue("devLenSelect", o.value);
    }
  } finally {
    syncingLen = false;
  }
}

function saveLastDsId(dsId) {
  if (!dsId) return;
  try {
    localStorage.setItem(scopedKey(LS_DS_KEY), String(dsId));
  } catch {
    // ignore
  }
}

function loadLastDsId() {
  try {
    return localStorage.getItem(scopedKey(LS_DS_KEY)) || "";
  } catch {
    return "";
  }
}

// Persist ArcRhoTri input controls so refresh doesn't reset them.
function saveTriInputsToStorage() {
  try {
    const projectInput = document.getElementById("projectSelect");
    const pathInput = document.getElementById("pathInput");
    const triInput = document.getElementById("triInput");
    const linkLenChecked = window.ADA_DFM_CONTEXT
      ? false
      : !!document.getElementById("linkLenChk")?.checked;
    const payload = {
      project: getStoredInputValue(projectInput),
      path: getStoredInputValue(pathInput),
      tri: triInput?.value || "",
      instanceName: getDatasetInstanceNameValue(),
      originLen: document.getElementById("originLenSelect")?.value || "",
      devLen: document.getElementById("devLenSelect")?.value || "",
      linkLen: linkLenChecked,
      cumulative: !!document.getElementById("cumulativeChk")?.checked,
      transposed: !!document.getElementById("transposedChk")?.checked,
      calendar: document.querySelector('input[name="timeMode"][value="calendar"]')?.checked === true,
      decimalPlaces: getDatasetDecimalPlacesValue(),
      numberFormat: getDatasetSyncedNumberFormatValue(),
    };
    const resolvedInputs = normalizeBrowsingHistoryEntry({
      project: getResolvedProjectValue(),
      path: getResolvedReservingClassValue(),
      tri: String(triInput?.value || "").trim(),
      instanceName: getDatasetInstanceNameValue(),
    });
    localStorage.setItem(scopedKey(LS_FORM_KEY), JSON.stringify(payload));
    if (!window.ADA_DFM_CONTEXT) {
      saveDatasetProjectPrefs(resolvedInputs);
      const matchedProject = findExactProjectMatch(getResolvedProjectValue());
      if (matchedProject) saveLastDatasetViewerProjectToAppData(matchedProject);
    }
    if (!window.ADA_DFM_CONTEXT && resolvedInputs) {
      setLastViewedDatasetInputs(resolvedInputs);
    }
    try {
      window.parent.postMessage({
        type: "arcrho:dataset-settings-changed",
        stepId: instanceId,
        settings: payload,
        resolved: resolvedInputs || null,
      }, "*");
    } catch {
      // ignore
    }
    refreshDatasetSettingsDirty();
  } catch {
    // ignore
  }
}

function isDatasetReadOnly() {
  return isReadOnlyDatasetViewer || isSidecarReadOnlyDataset;
}

async function restoreTriInputsFromStorage() {
  let s = null;
  try {
    const raw = localStorage.getItem(scopedKey(LS_FORM_KEY)) || "";
    if (raw) s = JSON.parse(raw);
  } catch {
    s = null;
  }
  if (!window.ADA_DFM_CONTEXT && !workflowId) {
    const localProject = await loadLastDatasetViewerProjectFromAppData();
    const matchedProject = findExactProjectMatch(localProject);
    if (matchedProject) {
      const base = s && typeof s === "object" ? s : {};
      const sameBaseProject = normalizeProjectText(base.project) === normalizeProjectText(matchedProject);
      const prefs = await loadDatasetProjectPrefs(matchedProject);
      s = {
        ...base,
        project: matchedProject,
        path: prefs?.path || (sameBaseProject ? (base.path || "") : ""),
        tri: prefs?.tri || (sameBaseProject ? (base.tri || "") : ""),
      };
    }
  }
  if (s && typeof s === "object") {
    const project = isDefaultTokenValue(s.project)
      ? String(loadWorkflowDefaults()?.project || "").trim()
      : String(s.project || "").trim();
    const prefs = await loadDatasetProjectPrefs(project);
    if (prefs) {
      s = {
        ...s,
        path: prefs.path || s.path || "",
        tri: prefs.tri || s.tri || "",
      };
    }
  }
  if ((!s || typeof s !== "object") && !window.ADA_DFM_CONTEXT) {
    s = getLastViewedDatasetInputs();
    const prefs = await loadDatasetProjectPrefs(s?.project || "");
    if (prefs) s = prefs;
  }
  if (!s || typeof s !== "object") return;

  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  const detailNameInput = document.getElementById("dsDetailName");
  const originSel = document.getElementById("originLenSelect");
  const devSel = document.getElementById("devLenSelect");

  // Only restore if the saved value is valid in the current UI.
  if (projectInput && typeof s.project === "string") {
    if (isDefaultTokenValue(s.project)) {
      setInputDefaultBound(projectInput, true);
    } else if (s.project.trim()) {
      setInputDefaultBound(projectInput, false);
      const match = findExactProjectMatch(s.project);
      projectInput.value = match || s.project;
    }
  }
  if (pathInput && typeof s.path === "string") {
    if (isDefaultTokenValue(s.path)) {
      setInputDefaultBound(pathInput, true);
    } else if (s.path.trim()) {
      setInputDefaultBound(pathInput, false);
      pathInput.value = normalizeReservingClassPath(s.path);
    }
  }
  if (triInput && typeof s.tri === "string" && s.tri.trim()) triInput.value = s.tri;
  if (detailNameInput && typeof s.instanceName === "string" && s.instanceName.trim()) {
    detailNameInput.value = s.instanceName.trim();
  }

  if (originSel && s.originLen && [...originSel.options].some(o => o.value === String(s.originLen))) {
    originSel.value = String(s.originLen);
  }
  if (devSel && s.devLen && [...devSel.options].some(o => o.value === String(s.devLen))) {
    devSel.value = String(s.devLen);
  }
  refreshLenDropdowns();

  const linkChk = document.getElementById("linkLenChk");
  if (linkChk) {
    linkChk.checked = window.ADA_DFM_CONTEXT ? false : (typeof s.linkLen === "boolean" ? s.linkLen : linkChk.checked);
  }

  const cumChk = document.getElementById("cumulativeChk");
  if (cumChk && typeof s.cumulative === "boolean") cumChk.checked = s.cumulative;

  const transposedChk = document.getElementById("transposedChk");
  if (transposedChk && typeof s.transposed === "boolean") transposedChk.checked = s.transposed;

  if (typeof s.calendar === "boolean") {
    const mode = s.calendar ? "calendar" : "development";
    const modeInput = document.querySelector(`input[name="timeMode"][value="${mode}"]`);
    if (modeInput) modeInput.checked = true;
  }
  if (s.decimalPlaces !== undefined || s.decimal_places !== undefined) {
    setDatasetDecimalPlacesValue(s.decimalPlaces ?? s.decimal_places);
  }
  if (typeof s.numberFormat === "string") {
    setDatasetNumberFormatValue(s.numberFormat);
  }
}

function applyTriInputsFromQueryParams() {
  const queryInputs = readDatasetInputsFromQueryParams();
  if (!queryInputs) return false;

  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  const detailNameInput = document.getElementById("dsDetailName");
  const originSel = document.getElementById("originLenSelect");
  const devSel = document.getElementById("devLenSelect");
  if (projectInput && queryInputs.project) {
    setInputDefaultBound(projectInput, false);
    projectInput.value = queryInputs.project;
  }
  if (pathInput && queryInputs.path) {
    setInputDefaultBound(pathInput, false);
    pathInput.value = queryInputs.path;
  }
  if (triInput && queryInputs.tri) {
    triInput.value = queryInputs.tri;
  }
  if (detailNameInput && queryInputs.instanceName) {
    detailNameInput.value = queryInputs.instanceName;
  } else if (detailNameInput && queryInputs.tri && !String(detailNameInput.value || "").trim()) {
    detailNameInput.value = queryInputs.tri;
  }
  if (originSel && queryInputs.originLen && [...originSel.options].some(o => o.value === String(queryInputs.originLen))) {
    originSel.value = String(queryInputs.originLen);
  }
  if (devSel && queryInputs.devLen && [...devSel.options].some(o => o.value === String(queryInputs.devLen))) {
    devSel.value = String(queryInputs.devLen);
  }
  if (queryInputs.decimalPlaces !== undefined || queryInputs.decimal_places !== undefined) {
    setDatasetDecimalPlacesValue(queryInputs.decimalPlaces ?? queryInputs.decimal_places);
  }
  if (typeof queryInputs.numberFormat === "string") {
    setDatasetNumberFormatValue(queryInputs.numberFormat);
  }
  refreshLenDropdowns();
  if (!window.ADA_DFM_CONTEXT) {
    setLastViewedDatasetInputs(queryInputs);
  }
  return true;
}

function hasScopedTriInputs() {
  try {
    return !!localStorage.getItem(scopedKey(LS_FORM_KEY));
  } catch {
    return false;
  }
}

function loadWorkflowDefaults() {
  if (!workflowId) return null;
  try {
    const raw = localStorage.getItem(`${WF_GLOBAL_CTRL_PREFIX}${workflowId}`) || "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const vars = Array.isArray(parsed.vars) ? parsed.vars : null;
    const project = vars
      ? (getWorkflowVarValue(vars, "project", "Default Project") || getWorkflowVarValue(vars, "project", "Project"))
      : (typeof parsed.project === "string" ? parsed.project : "");
    const reservingClass = vars
      ? (getWorkflowVarValue(vars, "reservingClass", "Default Path") || getWorkflowVarValue(vars, "reservingClass", "Reserving Class"))
      : (typeof parsed.reservingClass === "string" ? parsed.reservingClass : "");
    return { project, reservingClass, vars: vars || [] };
  } catch {
    return null;
  }
}

function applyWorkflowDefaultsIfNew() {
  if (!workflowId) return;
  if (hasScopedTriInputs()) return;

  const defaults = loadWorkflowDefaults();
  if (!defaults) return;

  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");

  if (projectInput && defaults.project) {
    setInputDefaultBound(projectInput, true);
  }
  if (pathInput && defaults.reservingClass) {
    setInputDefaultBound(pathInput, true);
  }
  if (defaults.project) {
    void applyResolvedProjectDefaults(defaults.project);
  }
  saveTriInputsToStorage();
}

function getResolvedProjectValue() {
  const input = document.getElementById("projectSelect");
  const raw = (input?.value || "").trim();
  if (isInputDefaultBound(input)) {
    const defaults = loadWorkflowDefaults();
    return (defaults?.project || "").trim();
  }
  return raw;
}

function getResolvedReservingClassValue() {
  const input = document.getElementById("pathInput");
  const raw = normalizeReservingClassPath(input?.value || "");
  if (isInputDefaultBound(input)) {
    const defaults = loadWorkflowDefaults();
    return normalizeReservingClassPath(defaults?.reservingClass || "");
  }
  return raw;
}

function getStoredInputValue(input) {
  if (!input) return "";
  if (isInputDefaultBound(input)) return DEFAULT_TOKEN;
  return input.value || "";
}

async function applyResolvedProjectDefaults(project) {
  if (!project) return;
  if (project === lastProjectSelection) return;
  lastProjectSelection = project;
  await ensureHeadersForProject(project);
  await ensureDevHeadersForProject(project);
  await refreshDatasetTypesForProject(project);
  await refreshReservingClassPathsForProject(project);
}

function extractDefaultsFromControl(control) {
  if (!control || typeof control !== "object") return null;
  const vars = Array.isArray(control.vars) ? control.vars : null;
  const project = vars
    ? (getWorkflowVarValue(vars, "project", "Default Project") || getWorkflowVarValue(vars, "project", "Project"))
    : (typeof control.project === "string" ? control.project : "");
  const reservingClass = vars
    ? (getWorkflowVarValue(vars, "reservingClass", "Default Path") || getWorkflowVarValue(vars, "reservingClass", "Reserving Class"))
    : (typeof control.reservingClass === "string" ? control.reservingClass : "");
  return { project, reservingClass };
}

function handleWorkflowGlobalChange(control = null) {
  if (!workflowId) return;
  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");
  const projectDefault = isInputDefaultBound(projectInput);
  const pathDefault = isInputDefaultBound(pathInput);
  if (!projectDefault && !pathDefault) return;

  const defaults = control ? extractDefaultsFromControl(control) : loadWorkflowDefaults();
  if (!defaults) return;

  if (projectDefault && projectInput) {
    setInputDefaultBound(projectInput, true);
  }
  if (pathDefault && pathInput) {
    setInputDefaultBound(pathInput, true);
  }

  if (projectDefault && defaults.project) {
    void applyResolvedProjectDefaults(defaults.project);
  }

  if (projectDefault || pathDefault) {
    const currentProjectValue = projectDefault ? DEFAULT_TOKEN : (projectInput?.value || "");
    renderProjectOptions(allProjects, currentProjectValue);
    saveTriInputsToStorage();
    scheduleAutoRun(0);
    try {
      window.dispatchEvent(new CustomEvent("arcrho:workflow-defaults-updated", { detail: defaults }));
    } catch {
      // ignore
    }
  }
}

// NEW: allow shell to specify dataset id via ?ds=xxx
const dsFromUrl = qs.get("ds");

// Priority:
//  1) ?ds=... in URL
//  2) localStorage persisted value
//  3) config default
if (dsFromUrl) {
  config.DS_ID = dsFromUrl;
  saveLastDsId(dsFromUrl);
} else {
  const saved = loadLastDsId();
  if (saved) config.DS_ID = saved;
}

const LEN_CHOICES = [12, 6, 3, 1];

function fillLenDropdowns() {
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return;

  o.innerHTML = "";
  d.innerHTML = "";

  for (const n of LEN_CHOICES) {
    const opt1 = document.createElement("option");
    opt1.value = String(n);
    opt1.textContent = String(n);
    o.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = String(n);
    opt2.textContent = String(n);
    d.appendChild(opt2);
  }

  // defaults
  o.value = "12";
  d.value = "12";
  refreshLenDropdowns();
}

async function loadProjectsDropdown() {
  const input = document.getElementById("projectSelect");
  const list = document.getElementById("projectDropdown");
  if (!input || !list) return;

  try {
    allProjects = await loadProjectValidValueList();
  } catch (err) {
    console.error("Failed to load project names:", err);
    setStatus("Failed to load project names.");
    allProjects = [];
  }
  renderProjectOptions(allProjects);
  showProjectDropdown(false);

  // default values you requested
  const pathInput = document.getElementById("pathInput");
  const triInput = document.getElementById("triInput");
  if (!window.ADA_DFM_CONTEXT && pathInput && !pathInput.value && !isInputDefaultBound(pathInput)) {
    pathInput.value = "PRNJ - PA\\PA\\NJ\\Direct Group\\COL";
  }
  if (!window.ADA_DFM_CONTEXT && triInput && !triInput.value) triInput.value = "Net Loss--Incurred";

}

function showDatasetLoadingPopup(message = "") {
  datasetRunController.showDatasetLoadingPopup(message);
}

function hideDatasetLoadingPopup() {
  datasetRunController.hideDatasetLoadingPopup();
}

function getTriInputs() {
  enforceDevLenRule();
  const project = getResolvedProjectValue();
  const path = getResolvedReservingClassValue();
  const tri = (document.getElementById("triInput")?.value || "").trim();
  const instanceName = getDatasetInstanceNameValue();
  const originLen = parseInt(document.getElementById("originLenSelect")?.value, 10);
  const devLen = parseInt(document.getElementById("devLenSelect")?.value, 10);
  const cumulative = !!document.getElementById("cumulativeChk")?.checked;
  const transposed = !!document.getElementById("transposedChk")?.checked;
  const calendar = document.querySelector('input[name="timeMode"][value="calendar"]')?.checked === true;

  return {
    project,
    path,
    tri,
    instanceName,
    cumulative,
    transposed,
    calendar,
    originLen: Number.isFinite(originLen) ? originLen : 12,
    devLen: Number.isFinite(devLen) ? devLen : 12,
  };
}

function resolveTriRequestInputs(rawInputs = {}) {
  const project = String(rawInputs?.project || "").trim();
  const path = normalizeReservingClassPath(rawInputs?.path || "");
  const tri = String(rawInputs?.tri || "").trim();
  const instanceName = String(rawInputs?.instanceName || rawInputs?.instance_name || "").trim();
  const cumulative = !!rawInputs?.cumulative;
  const calendar = !!rawInputs?.calendar;
  const originRaw = Number(rawInputs?.originLen);
  const devRaw = Number(rawInputs?.devLen);
  return {
    project,
    path,
    tri,
    instanceName,
    cumulative,
    calendar,
    originLen: Number.isFinite(originRaw) ? originRaw : 12,
    devLen: Number.isFinite(devRaw) ? devRaw : 12,
  };
}

function buildTriRequestPayload(rawInputs = {}) {
  const resolved = resolveTriRequestInputs(rawInputs);
  return {
    Path: resolved.path,
    TriangleName: resolved.tri,
    DatasetTypeName: resolved.tri,
    InstanceName: resolved.instanceName || resolved.tri,
    ProjectName: resolved.project,
    Cumulative: resolved.cumulative,
    Calendar: resolved.calendar,
    OriginLength: resolved.originLen,
    DevelopmentLength: resolved.devLen,
    LocalOnly: !!window.ADA_DFM_CONTEXT,
    AllowDerived: true,
    timeout_sec: 6.0,
  };
}

async function precheckArcRhoTriCsv(rawInputs = {}) {
  const resolved = resolveTriRequestInputs(rawInputs);
  if (!resolved.project || !resolved.path || !resolved.tri) {
    return { ok: false, hasExistingCsv: false, skipped: true, data: null };
  }
  try {
    const precheckResp = await fetch("/arcrho/tri/precheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTriRequestPayload(resolved)),
    });
    if (!precheckResp.ok) {
      return { ok: false, hasExistingCsv: false, skipped: false, data: null };
    }
    const data = await precheckResp.json().catch(() => ({}));
    return {
      ok: true,
      hasExistingCsv: data?.need_request === false || data?.cache_exists === true,
      skipped: false,
      data,
    };
  } catch {
    return { ok: false, hasExistingCsv: false, skipped: false, data: null };
  }
}

datasetDependencyGuard = createDatasetDependencyGuard({
  normalizeProjectText,
  getResolvedProjectValue,
  getTriInputs,
  precheckArcRhoTriCsv,
  setInputInvalid,
  clearInputInvalid,
  setStatus,
});

function getTriInputsForStorage() {
  enforceDevLenRule();
  const projectInput = document.getElementById("projectSelect");
  const pathInput = document.getElementById("pathInput");
  const tri = (document.getElementById("triInput")?.value || "").trim();
  const originLen = parseInt(document.getElementById("originLenSelect")?.value, 10);
  const devLen = parseInt(document.getElementById("devLenSelect")?.value, 10);
  const cumulative = !!document.getElementById("cumulativeChk")?.checked;
  const transposed = !!document.getElementById("transposedChk")?.checked;
  const calendar = document.querySelector('input[name="timeMode"][value="calendar"]')?.checked === true;

  return {
    project: getStoredInputValue(projectInput),
    path: getStoredInputValue(pathInput),
    tri,
    cumulative,
    transposed,
    calendar,
    decimalPlaces: getDatasetDecimalPlacesValue(),
    numberFormat: getDatasetSyncedNumberFormatValue(),
    originLen: Number.isFinite(originLen) ? originLen : 12,
    devLen: Number.isFinite(devLen) ? devLen : 12,
  };
}

function buildDatasetSidecarContextPayload() {
  return {
    project_name: getResolvedProjectValue(),
    reserving_class: getResolvedReservingClassValue(),
    dataset_name: getDatasetInstanceNameValue(),
    dataset_type: (document.getElementById("triInput")?.value || "").trim(),
    instance_name: getDatasetInstanceNameValue(),
  };
}

function hasDatasetSidecarContext(payload) {
  return !!(
    String(payload?.project_name || "").trim()
    && String(payload?.reserving_class || "").trim()
    && String(payload?.dataset_name || "").trim()
  );
}

function buildDatasetSidecarContextKey(payload) {
  if (!hasDatasetSidecarContext(payload)) return "";
  return `${payload.project_name}\u001f${payload.reserving_class}\u001f${payload.dataset_type || ""}\u001f${payload.dataset_name}`;
}

function getCurrentDatasetSettings() {
  const triInputs = getTriInputs();
  return {
    dataset_type: triInputs.tri,
    instance_name: triInputs.instanceName || triInputs.tri,
    data_format: isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : undefined,
    origin_length: triInputs.originLen,
    development_length: triInputs.devLen,
    cumulative: !!triInputs.cumulative,
    transposed: !!triInputs.transposed,
    calendar: !!triInputs.calendar,
    decimal_places: getDatasetDecimalPlacesValue(),
    number_format: getDatasetSyncedNumberFormatValue(),
  };
}

function getManualInputDatasetValuePayload() {
  if (!hasManualInputGridChanges() || !state.model) return {};
  const values = Array.isArray(state.model.values)
    ? state.model.values.map((row) => (
      Array.isArray(row)
        ? row.map((value) => {
          if (value == null || value === "") return null;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : null;
        })
        : []
    ))
    : null;
  const mask = Array.isArray(state.model.mask)
    ? state.model.mask.map((row) => (Array.isArray(row) ? row.map(Boolean) : []))
    : null;
  if (!Array.isArray(values) || !values.length) return {};
  return {
    source_kind: "input",
    data_format: currentDatasetSidecarDataFormat || state.model?.data_format || getProjectInstanceDraftDataFormat(),
    origin_labels: Array.isArray(state.model.origin_labels) ? state.model.origin_labels.map(String) : undefined,
    values,
    mask,
  };
}

function normalizeDatasetSettings(source = {}) {
  const origin = Number(source.origin_length ?? source.originLen);
  const development = Number(source.development_length ?? source.devLen);
  const numberFormat = source.number_format ?? source.numberFormat ?? source.num_format;
  const decimalPlaces = source.decimal_places ?? source.decimalPlaces;
  const normalizedDecimalPlaces = clampDatasetDecimalPlaces(decimalPlaces);
  return {
    dataset_type: String(source.dataset_type ?? source.datasetType ?? source.tri ?? "").trim(),
    instance_name: String(source.instance_name ?? source.instanceName ?? source.dataset_name ?? source.datasetName ?? "").trim(),
    origin_length: Number.isFinite(origin) && origin > 0 ? Math.trunc(origin) : 12,
    development_length: Number.isFinite(development) && development > 0 ? Math.trunc(development) : 12,
    cumulative: typeof source.cumulative === "boolean" ? source.cumulative : true,
    transposed: typeof source.transposed === "boolean" ? source.transposed : false,
    calendar: typeof source.calendar === "boolean" ? source.calendar : false,
    decimal_places: normalizedDecimalPlaces,
    number_format: applyDecimalPlacesToDatasetNumberFormat(
      normalizeDatasetNumberFormat(numberFormat),
      normalizedDecimalPlaces,
    ),
  };
}

function sameDatasetSettings(a, b) {
  const left = normalizeDatasetSettings(a || {});
  const right = normalizeDatasetSettings(b || {});
  return (
    left.origin_length === right.origin_length
    && left.development_length === right.development_length
    && left.cumulative === right.cumulative
    && left.transposed === right.transposed
    && left.calendar === right.calendar
    && left.decimal_places === right.decimal_places
    && left.number_format === right.number_format
    && normalizeProjectText(left.dataset_type) === normalizeProjectText(right.dataset_type)
    && normalizeProjectText(left.instance_name) === normalizeProjectText(right.instance_name)
  );
}

function hasManualInputGridChanges() {
  return state.dirty.size > 0 && currentDatasetIsManualTriangleOrVector();
}

function hasUnsavedDatasetChanges() {
  return datasetSettingsDirty || notesDirty || hasManualInputGridChanges();
}

function normalizeDatasetModeText(value) {
  return String(value || "").trim().toLowerCase();
}

function currentDatasetIsManualTriangleOrVector() {
  const sourceKind = normalizeDatasetModeText(currentDatasetSidecarSourceKind || state.model?.source_kind || "");
  const format = normalizeDatasetModeText(
    currentDatasetSidecarDataFormat
      || state.model?.data_format
      || (isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : ""),
  );
  const isManualInput = isProjectInstanceDraft || sourceKind === "input";
  const isTriangleOrVector = !format || format === "triangle" || format === "vector";
  return isManualInput && isTriangleOrVector;
}

function datasetValuesAreAllZero() {
  const values = Array.isArray(state.model?.values) ? state.model.values : [];
  const mask = Array.isArray(state.model?.mask) ? state.model.mask : [];
  for (let r = 0; r < values.length; r += 1) {
    const row = Array.isArray(values[r]) ? values[r] : [];
    for (let c = 0; c < row.length; c += 1) {
      if (Array.isArray(mask[r]) && mask[r][c] === false) continue;
      const raw = row[c];
      if (raw == null || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) > 1e-12) return false;
    }
  }
  return true;
}

function getManualDatasetLengthBaseline() {
  const settings = lastSavedDatasetSettings;
  if (!settings) {
    return {
      origin_length: 12,
      development_length: 12,
    };
  }
  return {
    origin_length: Number(settings.origin_length) || 12,
    development_length: Number(settings.development_length) || 12,
  };
}

function getCurrentLengthControlValues() {
  const origin = Number.parseInt(document.getElementById("originLenSelect")?.value || "", 10);
  const dev = Number.parseInt(document.getElementById("devLenSelect")?.value || "", 10);
  return {
    origin_length: Number.isFinite(origin) ? origin : 12,
    development_length: Number.isFinite(dev) ? dev : 12,
  };
}

function validateManualDatasetLengthChange() {
  if (!currentDatasetIsManualTriangleOrVector()) return true;
  if (datasetValuesAreAllZero()) return true;
  const baseline = getManualDatasetLengthBaseline();
  const current = getCurrentLengthControlValues();
  if (current.origin_length >= baseline.origin_length && current.development_length >= baseline.development_length) {
    return true;
  }
  setLenSelectValue("originLenSelect", String(baseline.origin_length));
  setLenSelectValue("devLenSelect", String(baseline.development_length));
  refreshLenDropdowns();
  setStatus("Manual input datasets with non-zero values cannot use a lower period length. Set all values to 0 before changing to a lower level.");
  return false;
}

function updateManualDatasetModeControls() {
  const locked = currentDatasetIsManualTriangleOrVector();
  const message = "Manual input Triangle/Vector datasets keep their cumulative and development/calendar mode fixed.";
  const cumulativeChk = document.getElementById("cumulativeChk");
  if (cumulativeChk) {
    cumulativeChk.disabled = locked;
    cumulativeChk.title = locked ? message : "";
  }
  document.querySelectorAll('input[name="timeMode"]').forEach((input) => {
    input.disabled = locked;
    input.title = locked ? message : "";
  });
}

function restoreManualDatasetModeControls() {
  const settings = normalizeDatasetSettings(lastSavedDatasetSettings || getCurrentDatasetSettings());
  const cumulativeChk = document.getElementById("cumulativeChk");
  if (cumulativeChk) cumulativeChk.checked = settings.cumulative;
  const mode = settings.calendar ? "calendar" : "development";
  const modeInput = document.querySelector(`input[name="timeMode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  updateManualDatasetModeControls();
}

function notifyDatasetDirtyState() {
  const dirty = hasUnsavedDatasetChanges();
  try {
    window.parent?.postMessage({
      type: "arcrho:dataset-dirty",
      inst: instanceId,
      dirty,
    }, "*");
  } catch {}
}

function updateDatasetSaveUi() {
  const bar = document.getElementById("datasetSaveBar");
  const saveBtn = document.getElementById("datasetSaveBtn");
  const cancelBtn = document.getElementById("datasetCancelBtn");
  const runBtn = document.getElementById("runArcRhoTriBtn");
  const clearBtn = document.getElementById("clearCacheReloadBtn");
  const hasContext = hasDatasetSidecarContext(sidecarContextPayload) || hasNotesContext(notesContextPayload);
  const dirty = hasUnsavedDatasetChanges();
  if (bar) bar.hidden = !hasContext;
  if (saveBtn) {
    saveBtn.disabled = datasetSaveInFlight || datasetInstanceNameConflict || !hasContext || !dirty;
    saveBtn.classList.toggle("is-clean", !dirty);
  }
  if (cancelBtn) cancelBtn.disabled = datasetSaveInFlight || !dirty;
  for (const button of [runBtn, clearBtn]) {
    if (!button) continue;
    if (datasetInstanceNameConflict) {
      if (button.dataset.duplicateNameBlocked !== "1") {
        button.dataset.originalTitle = button.title || "";
      }
      button.dataset.duplicateNameBlocked = "1";
      button.disabled = true;
      button.title = datasetInstanceNameConflictMessage || "Dataset instance name already exists.";
    } else if (button.dataset.duplicateNameBlocked === "1") {
      button.disabled = false;
      button.title = button.dataset.originalTitle || "";
      delete button.dataset.duplicateNameBlocked;
    }
  }
  updateManualDatasetModeControls();
  notifyDatasetDirtyState();
}

function refreshDatasetSettingsDirty() {
  datasetSettingsDirty = !!lastSavedDatasetSettings && !sameDatasetSettings(getCurrentDatasetSettings(), lastSavedDatasetSettings);
  updateDatasetSaveUi();
}

function applyDatasetSettingsToControls(settings = {}) {
  const normalized = normalizeDatasetSettings(settings);
  setLenSelectValue("originLenSelect", String(normalized.origin_length));
  setLenSelectValue("devLenSelect", String(normalized.development_length));
  const linkChk = document.getElementById("linkLenChk");
  if (linkChk && normalized.origin_length !== normalized.development_length) {
    linkChk.checked = false;
  }
  const cumulativeChk = document.getElementById("cumulativeChk");
  if (cumulativeChk) cumulativeChk.checked = normalized.cumulative;
  const transposedChk = document.getElementById("transposedChk");
  if (transposedChk) transposedChk.checked = normalized.transposed;
  const mode = normalized.calendar ? "calendar" : "development";
  const modeInput = document.querySelector(`input[name="timeMode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  setDatasetDecimalPlacesValue(normalized.decimal_places);
  setDatasetNumberFormatValue(normalized.number_format);
  refreshLenDropdowns();
}

async function syncSidecarForCurrentDataset(options = {}) {
  const context = buildDatasetSidecarContextPayload();
  const key = buildDatasetSidecarContextKey(context);
  sidecarContextPayload = hasDatasetSidecarContext(context) ? context : null;
  sidecarContextKey = key;
  if (!key) {
    if (window.ADA_DFM_CONTEXT) setDatasetRenderNumberFormatSettings(null);
    isSidecarReadOnlyDataset = false;
    currentDatasetSidecarSourceKind = "";
    currentDatasetSidecarDataFormat = "";
    currentDatasetPrecedents = [];
    lastSavedDatasetSettings = null;
    datasetSettingsDirty = false;
    renderDatasetAuditLog([]);
    renderDetailFormula("", currentDatasetPrecedents);
    renderDatasetDependents([]);
    updateDatasetSaveUi();
    return false;
  }

  const nonce = ++sidecarSyncNonce;
  const resp = await loadDatasetSidecar(context);
  if (nonce !== sidecarSyncNonce) return false;
  if (!resp.ok) {
    if (window.ADA_DFM_CONTEXT) setDatasetRenderNumberFormatSettings(null);
    setStatus(`Dataset settings load failed: ${resp?.data?.detail || "Unknown error."}`);
    currentDatasetSidecarSourceKind = isProjectInstanceDraft ? "input" : "";
    currentDatasetSidecarDataFormat = isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : "";
    currentDatasetPrecedents = [];
    lastSavedDatasetSettings = normalizeDatasetSettings(getCurrentDatasetSettings());
    datasetSettingsDirty = false;
    renderDatasetAuditLog([]);
    renderDetailFormula(getDatasetTypeFormulaByName(document.getElementById("triInput")?.value || ""), currentDatasetPrecedents);
    renderDatasetDependents([]);
    updateDatasetSaveUi();
    return false;
  }

  const data = resp.data || {};
  currentDatasetSidecarSourceKind = data.exists ? String(data.source_kind || "") : (isProjectInstanceDraft ? "input" : "");
  currentDatasetSidecarDataFormat = data.exists ? String(data.data_format || "") : (isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : "");
  currentDatasetPrecedents = data.exists ? normalizeDatasetDependencyEntries(data.Precedents) : [];
  if (isProjectInstanceDraft && data.exists && !String(data.csv_file || "").trim()) {
    savedProjectInstanceDraftName = String(data.dataset_name || context.dataset_name || "").trim();
  }
  renderDatasetAuditLog(data.exists ? data.audit_log : []);
  renderDetailFormula(
    data.exists
      ? (String(data.formula || "").trim() || getDatasetTypeFormulaByName(data.dataset_type || context.dataset_name || ""))
      : getDatasetTypeFormulaByName(document.getElementById("triInput")?.value || ""),
    currentDatasetPrecedents,
  );
  renderDatasetDependents(data.exists ? data.Dependents : []);
  const sidecarEditable = data.editable;
  const sidecarCalculated = data.calculated;
  const sidecarGenerated = data.generated;
  isSidecarReadOnlyDataset = !!data.exists && (
    sidecarEditable === false
    || String(sidecarEditable).trim().toLowerCase() === "false"
    || sidecarCalculated === true
    || String(sidecarCalculated).trim().toLowerCase() === "true"
    || sidecarGenerated === true
    || String(sidecarGenerated).trim().toLowerCase() === "true"
  );
  const patchSaveBtn = document.getElementById("saveBtn");
  if (patchSaveBtn && !isReadOnlyDatasetViewer) {
    patchSaveBtn.disabled = isSidecarReadOnlyDataset;
    patchSaveBtn.title = isSidecarReadOnlyDataset ? "Calculated datasets are read-only." : "";
  }
  const settings = data.exists
    ? normalizeDatasetSettings(data)
    : normalizeDatasetSettings(getCurrentDatasetSettings());
  if (window.ADA_DFM_CONTEXT) {
    setDatasetRenderNumberFormatSettings(data.exists ? settings : null);
  }
  lastSavedDatasetSettings = settings;
  if (options?.applyLengths !== false && data.exists) {
    applyDatasetSettingsToControls(settings);
    saveTriInputsToStorage();
    datasetSettingsDirty = false;
    updateDatasetSaveUi();
    return true;
  }
  refreshDatasetSettingsDirty();
  return true;
}

async function saveDatasetSidecarForCurrentContext() {
  if (await refreshDatasetInstanceNameConflict()) {
    return { ok: false, error: datasetInstanceNameConflictMessage || "Dataset instance name already exists." };
  }
  const context = buildDatasetSidecarContextPayload();
  if (!hasDatasetSidecarContext(context)) {
    return { ok: false, error: "Project, Reserving Class, and Dataset Type are required." };
  }
  const settings = getCurrentDatasetSettings();
  const resp = await saveDatasetSidecar({
    ...context,
    ...settings,
    ...getManualInputDatasetValuePayload(),
  });
  if (!resp.ok) {
    return { ok: false, error: resp?.data?.detail || "Failed to save dataset settings." };
  }
  sidecarContextPayload = context;
  sidecarContextKey = buildDatasetSidecarContextKey(context);
  lastSavedDatasetSettings = normalizeDatasetSettings(settings);
  currentDatasetSidecarSourceKind = String(resp.data?.source_kind || (isProjectInstanceDraft ? "input" : currentDatasetSidecarSourceKind) || "");
  currentDatasetSidecarDataFormat = String(resp.data?.data_format || settings.data_format || currentDatasetSidecarDataFormat || "");
  currentDatasetPrecedents = normalizeDatasetDependencyEntries(resp.data?.Precedents);
  if (isProjectInstanceDraft) {
    savedProjectInstanceDraftName = context.dataset_name;
  }
  if (hasManualInputGridChanges()) {
    state.dirty.clear();
  }
  if (state.model && currentDatasetIsManualTriangleOrVector()) {
    state.model.source_kind = currentDatasetSidecarSourceKind;
    state.model.data_format = currentDatasetSidecarDataFormat;
  }
  if (resp.data?.ds_id) {
    config.DS_ID = String(resp.data.ds_id);
    saveLastDsId(config.DS_ID);
  }
  if (resp.data?.file_mtime !== undefined && resp.data?.file_mtime !== null) {
    state.fileMtime = resp.data.file_mtime;
  }
  renderDatasetAuditLog(resp.data?.audit_log);
  renderDetailFormula(
    String(resp.data?.formula || "").trim() || getDatasetTypeFormulaByName(settings.dataset_type),
    currentDatasetPrecedents,
  );
  renderDatasetDependents(resp.data?.Dependents);
  invalidateCachedDatasetInstances();
  datasetSettingsDirty = false;
  updateDatasetSaveUi();
  handleCalculationUpdates(resp.data?.calculated_updates, "Dataset settings save");
  return { ok: true, data: resp.data };
}

async function saveDatasetChanges(options = {}) {
  if (datasetSaveInFlight) return { ok: false, error: "Save already in progress." };
  datasetSaveInFlight = true;
  updateDatasetSaveUi();
  try {
    if (datasetSettingsDirty || hasManualInputGridChanges()) {
      const sidecarResult = await saveDatasetSidecarForCurrentContext();
      if (!sidecarResult.ok) return sidecarResult;
    }
    if (notesDirty) {
      const notesResult = await saveNotesForCurrentContext({ silentStatus: true });
      if (!notesResult.ok) return notesResult;
    }
    updateDatasetSaveUi();
    if (!options?.silentStatus) setStatus("Dataset settings saved.");
    return { ok: true };
  } finally {
    datasetSaveInFlight = false;
    updateDatasetSaveUi();
  }
}

async function discardDatasetChanges(options = {}) {
  const reload = options?.reload !== false;
  if (lastSavedDatasetSettings) {
    applyDatasetSettingsToControls(lastSavedDatasetSettings);
    saveTriInputsToStorage();
    if (reload) {
      const project = getResolvedProjectValue();
      if (project) {
        await ensureHeadersForProject(project);
        await ensureDevHeadersForProject(project);
      }
      renderTable();
      notifyDatasetUpdated();
      renderChart();
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
    }
  }
  if (notesDirty) applyNotesInputValue(lastSavedNotesText);
  state.dirty.clear();
  datasetSettingsDirty = false;
  updateDatasetSaveUi();
}

function resolveDatasetCancelConfirm(value) {
  const overlay = document.getElementById("datasetCancelConfirmOverlay");
  if (overlay) overlay.hidden = true;
  const resolve = datasetCancelConfirmResolve;
  datasetCancelConfirmResolve = null;
  if (resolve) resolve(!!value);
}

function showHostDatasetCancelConfirm(reason = "close") {
  const host = window.parent;
  if (!host || host === window) return Promise.resolve(null);

  return new Promise((resolve) => {
    const requestId = `dataset_close_confirm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let acknowledged = false;
    let done = false;
    let fallbackTimer = 0;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(fallbackTimer);
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== host) return;
      const msg = event.data || {};
      if (msg.requestId !== requestId) return;
      if (msg.type === "arcrho:dataset-close-confirm-ack") {
        acknowledged = true;
        return;
      }
      if (msg.type === "arcrho:dataset-close-confirm-result") {
        finish(!!msg.discard);
      }
    };

    window.addEventListener("message", onMessage);
    try {
      host.postMessage({ type: "arcrho:dataset-close-confirm-request", requestId, reason }, "*");
    } catch {
      finish(null);
      return;
    }
    fallbackTimer = window.setTimeout(() => {
      if (!acknowledged) finish(null);
    }, 300);
  });
}

function showDatasetCancelConfirm(reason = "close") {
  if (datasetCancelConfirmResolve) return Promise.resolve(false);
  const overlay = document.getElementById("datasetCancelConfirmOverlay");
  const title = document.getElementById("datasetCancelConfirmTitle");
  const message = document.getElementById("datasetCancelConfirmMessage");
  const yesBtn = document.getElementById("datasetCancelConfirmYes");
  if (!overlay || !yesBtn) return Promise.resolve(false);

  const isClose = reason === "close";
  if (title) title.textContent = isClose ? "Cancel and close?" : "Cancel changes?";
  if (message) {
    message.textContent = isClose
      ? "Unsaved dataset changes will be discarded and the window will close."
      : "Unsaved dataset changes will be discarded.";
  }

  overlay.hidden = false;
  requestAnimationFrame(() => yesBtn.focus());
  return new Promise((resolve) => {
    datasetCancelConfirmResolve = resolve;
  });
}

async function confirmCancelDatasetChanges(reason = "close") {
  if (!hasUnsavedDatasetChanges()) return true;
  const hostDiscard = await showHostDatasetCancelConfirm(reason);
  const discard = hostDiscard == null ? await showDatasetCancelConfirm(reason) : hostDiscard;
  if (!discard) return false;
  await discardDatasetChanges({ reload: reason !== "close" });
  return true;
}

function requestConfirmedDatasetClose() {
  try {
    window.parent?.postMessage({
      type: "arcrho:dataset-close-confirmed",
      inst: instanceId,
    }, "*");
  } catch {}
}

function wireDatasetSaveControls() {
  document.getElementById("datasetSaveBtn")?.addEventListener("click", async () => {
    await handleDatasetSaveCommand();
  });
  document.getElementById("datasetCancelBtn")?.addEventListener("click", async () => {
    const ok = await confirmCancelDatasetChanges("cancel");
    if (ok) updateDatasetSaveUi();
  });
  document.getElementById("datasetCancelConfirmYes")?.addEventListener("click", () => {
    resolveDatasetCancelConfirm(true);
  });
  document.getElementById("datasetCancelConfirmNo")?.addEventListener("click", () => {
    resolveDatasetCancelConfirm(false);
  });
  document.getElementById("datasetCancelConfirmClose")?.addEventListener("click", () => {
    resolveDatasetCancelConfirm(false);
  });
  document.getElementById("datasetCancelConfirmOverlay")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) resolveDatasetCancelConfirm(false);
  });
  document.getElementById("datasetCancelConfirmOverlay")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveDatasetCancelConfirm(false);
    }
  });
  document.getElementById("datasetRecalcOk")?.addEventListener("click", hideCalculationUpdatesDialog);
  document.getElementById("datasetRecalcClose")?.addEventListener("click", hideCalculationUpdatesDialog);
  document.getElementById("datasetRecalcOverlay")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) hideCalculationUpdatesDialog();
  });
  document.getElementById("datasetRecalcOverlay")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideCalculationUpdatesDialog();
    }
  });
  window.__arcrho_request_close = () => {
    if (!hasUnsavedDatasetChanges()) return false;
    void (async () => {
      const ok = await confirmCancelDatasetChanges("close");
      if (ok) requestConfirmedDatasetClose();
    })();
    return true;
  };
  window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedDatasetChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  updateDatasetSaveUi();
}

async function handleDatasetSaveCommand() {
  const result = await saveDatasetChanges();
  if (!result.ok) setStatus(`Dataset save failed: ${result.error || "Unknown error."}`);
  return result;
}

function getDisplayProjectValue() {
  return (document.getElementById("projectSelect")?.value || "").trim();
}

function getDisplayReservingClassValue() {
  return (document.getElementById("pathInput")?.value || "").trim();
}

function getDisplayTriValue() {
  return (document.getElementById("triInput")?.value || "").trim();
}

function getRawProjectValueForNotes() {
  const input = document.getElementById("projectSelect");
  if (isInputDefaultBound(input)) {
    const defaults = loadWorkflowDefaults();
    return typeof defaults?.project === "string" ? defaults.project : "";
  }
  return String(input?.value ?? "");
}

function getRawReservingClassValueForNotes() {
  const input = document.getElementById("pathInput");
  if (isInputDefaultBound(input)) {
    const defaults = loadWorkflowDefaults();
    return typeof defaults?.reservingClass === "string" ? defaults.reservingClass : "";
  }
  return String(input?.value ?? "");
}

function getRawDatasetNameValueForNotes() {
  const input = document.getElementById("dsDetailName") || document.getElementById("triInput");
  return String(input?.value ?? "");
}

function buildNotesContextPayload() {
  return {
    project_name: getRawProjectValueForNotes(),
    reserving_class: getRawReservingClassValueForNotes(),
    dataset_name: getRawDatasetNameValueForNotes(),
  };
}

function hasNotesContext(payload) {
  if (!payload || typeof payload !== "object") return false;
  const projectName = String(payload.project_name ?? "");
  const reservingClass = String(payload.reserving_class ?? "");
  const datasetName = String(payload.dataset_name ?? "");
  return !!projectName.trim() && !!reservingClass.trim() && !!datasetName.trim();
}

function buildNotesContextKey(payload) {
  if (!hasNotesContext(payload)) return "";
  return `${payload.project_name}\u001f${payload.reserving_class}\u001f${payload.dataset_name}`;
}

function getNotesErrorMessage(resp, fallback) {
  const detail = resp?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  const error = resp?.data?.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  return "Unknown error.";
}

function getNotesEditorElements() {
  return {
    input: document.getElementById("dsNotesInput"),
    saveBtn: document.getElementById("dsNotesSaveBtn"),
    saveState: document.getElementById("dsNotesSaveState"),
  };
}

function updateNotesSaveUi() {
  const { saveBtn, saveState } = getNotesEditorElements();
  const hasContext = !!notesContextKey && hasNotesContext(notesContextPayload);

  if (saveBtn) {
    saveBtn.disabled = !hasContext;
    saveBtn.classList.toggle("is-dirty", hasContext && notesDirty);
  }

  if (!saveState) return;
  saveState.classList.remove("is-dirty", "is-clean", "is-hidden");
  if (!hasContext) {
    saveState.textContent = "No dataset context";
    updateDatasetSaveUi();
    return;
  }
  if (notesDirty) {
    saveState.textContent = "Unsaved changes";
    saveState.classList.add("is-dirty");
    updateDatasetSaveUi();
    return;
  }
  saveState.textContent = "";
  saveState.classList.add("is-hidden");
  updateDatasetSaveUi();
}

function applyNotesInputValue(text) {
  const { input } = getNotesEditorElements();
  if (!input) return;
  const nextText = String(text ?? "");
  notesProgrammaticInput = true;
  lastSavedNotesText = nextText;
  notesDirty = false;
  input.value = nextText;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  notesProgrammaticInput = false;
  updateNotesSaveUi();
  updateDatasetSaveUi();
}

async function saveNotesForPayload(payload, options = {}) {
  const silentStatus = !!options?.silentStatus;
  if (!hasNotesContext(payload)) {
    updateNotesSaveUi();
    return { ok: false, error: "Project, Reserving Class, and Dataset Type are required." };
  }

  const { input } = getNotesEditorElements();
  const notesText = String(input?.value ?? "");
  const req = {
    project_name: payload.project_name,
    reserving_class: payload.reserving_class,
    dataset_name: payload.dataset_name,
    notes: notesText,
  };
  const resp = await saveDatasetNotes(req);
  if (!resp.ok) {
    return { ok: false, error: getNotesErrorMessage(resp, "Failed to save notes.") };
  }

  notesContextPayload = {
    project_name: req.project_name,
    reserving_class: req.reserving_class,
    dataset_name: req.dataset_name,
  };
  notesContextKey = buildNotesContextKey(notesContextPayload);
  lastSavedNotesText = notesText;
  notesDirty = false;
  updateNotesSaveUi();
  if (!silentStatus) setStatus("Notes saved.");
  return { ok: true, data: resp.data };
}

async function saveNotesForCurrentContext(options = {}) {
  return saveNotesForPayload(notesContextPayload, options);
}

async function syncNotesForCurrentDataset() {
  const nextPayload = buildNotesContextPayload();
  const nextKey = buildNotesContextKey(nextPayload);
  if (nextKey === notesContextKey) {
    notesContextPayload = hasNotesContext(nextPayload) ? nextPayload : null;
    updateNotesSaveUi();
    return true;
  }

  if (notesContextKey && notesDirty) {
    const shouldSave = window.confirm(
      "You have unsaved Notes. Click OK to save before switching notes, or Cancel to discard unsaved changes.",
    );
    if (shouldSave) {
      const saveResult = await saveNotesForCurrentContext({ silentStatus: true });
      if (!saveResult.ok) {
        setStatus(`Notes save failed: ${saveResult.error || "Unknown error."}`);
        updateNotesSaveUi();
        return false;
      }
    } else {
      notesDirty = false;
    }
  }

  notesContextPayload = hasNotesContext(nextPayload) ? nextPayload : null;
  notesContextKey = nextKey;
  updateNotesSaveUi();
  if (!nextKey) {
    applyNotesInputValue("");
    return true;
  }

  const nonce = ++notesSyncNonce;
  const resp = await loadDatasetNotes(nextPayload);
  if (nonce !== notesSyncNonce) return true;
  if (!resp.ok) {
    const err = getNotesErrorMessage(resp, "Failed to load notes.");
    setStatus(`Notes load failed: ${err}`);
    applyNotesInputValue("");
    return false;
  }

  const text = resp?.data?.exists ? String(resp?.data?.notes ?? "") : "";
  applyNotesInputValue(text);
  return true;
}

publishDatasetHostDfmHelpers({
  getResolvedProjectValue,
  getResolvedReservingClassValue,
  getDisplayProjectValue,
  getDisplayReservingClassValue,
  getDisplayTriValue,
  isInputDefaultBound,
});


function scheduleAutoRun(delayMs = 150) {
  return datasetRunController.scheduleAutoRun(delayMs);
}

function bindAutoRunOnEnter(el) {
  return datasetRunController.bindAutoRunOnEnter(el);
}

function runArcRhoTri(opts = {}) {
  return datasetRunController.runArcRhoTri(opts);
}

async function refreshDfmDatasetForCurrentInputs(options = {}) {
  if (!window.ADA_DFM_CONTEXT) return null;
  saveTriInputsToStorage();
  const project = getResolvedProjectValue();
  const forceRefreshLabels = !!options?.forceRefreshLabels;
  if (project) {
    await ensureHeadersForProject(project, { forceRefresh: forceRefreshLabels });
    await ensureDevHeadersForProject(project, { forceRefresh: forceRefreshLabels });
  }
  setStatus("Loading dataset...");
  return runArcRhoTri({ showValidationMessage: false });
}

if (window.ADA_DFM_CONTEXT) {
  window.ADA_DFM_REFRESH_DATASET = refreshDfmDatasetForCurrentInputs;
}

function isRunInFlight() {
  return datasetRunController.isRunInFlight();
}

function updateCurrentTabTitle() {
  if (window.ADA_DFM_CONTEXT) return null;
  const triangleName = document.getElementById("triInput")?.value?.trim();
  if (!triangleName) return null;

  window.parent.postMessage(
    {
      type: "arcrho:update-active-tab-title",
      title: `${triangleName}`,
    },
    "*"
  );

  return triangleName;
}

function setStatus(text) {
  try {
    window.parent.postMessage({ type: "arcrho:status", text }, "*");
  } catch {
    // ignore
  }
}

function collectCalculationSteps(report) {
  if (!report || typeof report !== "object") return [];
  const steps = [];
  if (Array.isArray(report.steps)) steps.push(...report.steps);
  if (Array.isArray(report.chains)) {
    report.chains.forEach((chain) => {
      if (Array.isArray(chain?.steps)) steps.push(...chain.steps);
    });
  }
  if (!steps.length && Array.isArray(report.updated)) steps.push(...report.updated.map((item) => ({ ...item, status: "updated" })));
  if (!steps.length && Array.isArray(report.skipped)) steps.push(...report.skipped.map((item) => ({ ...item, status: "skipped" })));
  const seen = new Set();
  return steps.filter((step) => {
    const key = [
      String(step?.reserving_class || report.reserving_class || ""),
      String(step?.dataset_type_name || ""),
      String(step?.status || (step?.ok ? "updated" : "skipped")),
      String(step?.reason || ""),
    ].join("\u0001");
    if (seen.has(key)) return false;
    seen.add(key);
    return String(step?.dataset_type_name || "").trim() || String(step?.reason || "").trim();
  });
}

function calculationStepReservingPath(step, report = null) {
  const explicit = String(step?.reserving_class || report?.reserving_class || "").trim();
  if (explicit) return decodeFileNameSegment(explicit);
  const path = String(step?.path || step?.sidecar_path || "").trim();
  const match = path.match(/[\\/]data[\\/](.*?)[\\/](?:datasets|sidecars|methods)[\\/]/i);
  return match ? decodeFileNameSegment(match[1]) : "";
}

function showCalculationUpdatesDialog(report, source = "Dataset save") {
  const steps = collectCalculationSteps(report);
  if (!steps.length) return;
  const overlay = document.getElementById("datasetRecalcOverlay");
  const summary = document.getElementById("datasetRecalcSummary");
  const list = document.getElementById("datasetRecalcList");
  if (!overlay || !summary || !list) return;

  const updatedCount = steps.filter((step) => step?.ok || String(step?.status || "").toLowerCase() === "updated").length;
  const skippedCount = steps.length - updatedCount;
  summary.textContent = `${source} refreshed ${updatedCount} calculated dataset${updatedCount === 1 ? "" : "s"}${skippedCount ? ` and skipped ${skippedCount}` : ""}.`;
  list.replaceChildren();
  steps.forEach((step, index) => {
    const item = document.createElement("div");
    const skipped = !(step?.ok || String(step?.status || "").toLowerCase() === "updated");
    item.className = `datasetRecalcItem${skipped ? " is-skipped" : ""}`;

    const badge = document.createElement("span");
    badge.className = "datasetRecalcBadge";
    badge.title = skipped ? "Skipped" : "Updated";

    const body = document.createElement("div");
    const name = document.createElement("div");
    name.className = "datasetRecalcName";
    name.textContent = `${index + 1}. ${String(step?.dataset_type_name || "Calculated dataset")}`;

    const meta = document.createElement("div");
    meta.className = "datasetRecalcMeta";
    const parts = [];
    const reservingPath = calculationStepReservingPath(step, report);
    if (reservingPath) parts.push(reservingPath);
    if (step?.reason) parts.push(`Reason: ${step.reason}`);
    if (Array.isArray(step?.errors) && step.errors.length) parts.push(`Errors: ${step.errors.join("; ")}`);
    meta.textContent = parts.join(" | ") || (skipped ? "Skipped" : "CSV refreshed");

    body.append(name, meta);
    item.append(badge, body);
    list.appendChild(item);
  });
  overlay.hidden = false;
  document.getElementById("datasetRecalcOk")?.focus();
}

function publishCalculatedDatasetUpdates(report, source = "Dataset save") {
  if (!collectCalculationSteps(report).some(isCalculationStepUpdated)) return;
  try {
    window.parent.postMessage({
      type: CALCULATED_DATASETS_UPDATED_MESSAGE,
      report,
      source,
    }, "*");
  } catch {
    // ignore
  }
}

function handleCalculationUpdates(report, source = "Dataset save") {
  showCalculationUpdatesDialog(report, source);
  publishCalculatedDatasetUpdates(report, source);
}

function hideCalculationUpdatesDialog() {
  const overlay = document.getElementById("datasetRecalcOverlay");
  if (overlay) overlay.hidden = true;
}

datasetHeadersService = createDatasetHeadersService({
  state,
  setStatus,
});

datasetRunController = createDatasetRunController({
  config,
  state,
  $,
  logLine,
  getDataset,
  patchDataset,
  renderTable,
  renderChart,
  notifyDatasetUpdated,
  isForceRebuildEnabled,
  validateTriInputsBeforeRun,
  getTriInputs,
  buildTriRequestPayload,
  precheckArcRhoTriCsv,
  clearHeadersCacheForProject: (project, options = {}) =>
    datasetHeadersService.clearHeadersCacheForProject(project, options),
  ensureHeadersForProject: (project, options = {}) =>
    datasetHeadersService.ensureHeadersForProject(project, options),
  ensureDevHeadersForProject: (project, options = {}) =>
    datasetHeadersService.ensureDevHeadersForProject(project, options),
  saveLastDsId,
  recordDatasetBrowsingHistory,
  syncNotesForCurrentDataset,
  syncSidecarForCurrentDataset,
  updateCurrentTabTitle,
  setStatus,
  onCalculatedUpdates: (report, source) => handleCalculationUpdates(report, source),
  applyGridSelectionFromState,
  stepId,
  suppressLoadingPopup: !!window.ADA_DFM_CONTEXT,
  isDatasetReadOnly,
});

async function openReservingClassTreeForDataset(targetInput) {
  const projectName = getResolvedProjectValue();
  const initialPath = targetInput
    ? (isInputDefaultBound(targetInput) ? getResolvedReservingClassValue() : (targetInput.value || ""))
    : "";
  await openLazyReservingClassPicker({
    projectName,
    initialPath,
    anchorElement: targetInput || null,
    setStatus,
    title: "Reserving Class",
    onProjectMissing: (name) => {
      alert(`Project "${name}" does not exist.`);
      setStatus(`Project "${name}" does not exist.`);
    },
    onError: (err) => {
      console.error("Failed to load reserving class tree:", err);
      setStatus("Error loading reserving class paths.");
    },
    onSelect: async (path) => {
      if (!targetInput) return;
      setInputDefaultBound(targetInput, false);
      const normalized = ensureReservingClassOption(path);
      targetInput.value = normalized || normalizeReservingClassPath(path);
      if (targetInput.value) {
        lastReservingClassSelection = targetInput.value;
        clearInputInvalid(targetInput);
      }
      saveTriInputsToStorage();
      await syncSidecarForCurrentDataset({ applyLengths: true });
      setStatus("Loading dataset...");
      scheduleAutoRun(0);
    },
  });
}

async function openProjectNameTreeForDataset(targetInput) {
  const initialProject = getResolvedProjectValue() || targetInput?.value || "";
  await openProjectNameTreePicker({
    initialProject,
    anchorElement: targetInput || null,
    title: "Select a Project",
    setStatus,
    onError: (err) => {
      console.error("Failed to load project tree:", err);
      setStatus("Error loading project tree.");
    },
    onSelect: async (projectName) => {
      const selected = String(projectName || "").trim();
      if (!selected || !targetInput) return;
      setInputDefaultBound(targetInput, false);
      targetInput.value = selected;
      showProjectDropdown(false);
      setStatus("Loading dataset...");
      await handleProjectSelection(selected, { strict: true, showMessage: true });
    },
  });
}

async function openDatasetNameTreeForDataset(targetInput) {
  const projectName = getResolvedProjectValue();
  await openDatasetNamePicker({
    projectName,
    initialName: targetInput?.value || "",
    anchorElement: targetInput || null,
    title: "Select a Dataset Type",
    setStatus,
    onError: (err) => {
      console.error("Failed to load dataset type tree:", err);
      setStatus("Error loading dataset types.");
    },
    onSelect: (datasetName) => {
      const selected = String(datasetName || "").trim();
      if (!selected || !targetInput) return;
      targetInput.value = selected;
      showDatasetDropdown(false);
      const knownName = ensureDatasetTypeOption(selected) || selected;
      void handleDatasetSelection(knownName, { strict: true });
    },
  });
}

function loadDataset() {
  return datasetRunController.loadDataset();
}

function savePatch() {
  return datasetRunController.savePatch();
}

function toggleBlanks() {
  return datasetRunController.toggleBlanks();
}

function getValidDevelopmentLengthForOrigin(origin, currentDev) {
  if (!Number.isFinite(origin) || origin <= 0) return "";
  const devSelect = document.getElementById("devLenSelect");
  const candidates = Array.from(devSelect?.options || [])
    .map((opt) => Number.parseInt(String(opt.value || opt.textContent || ""), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= origin && origin % value === 0)
    .sort((a, b) => b - a);
  if (!candidates.length) return "";
  if (Number.isFinite(currentDev) && candidates.includes(currentDev)) return String(currentDev);
  return String(candidates[0]);
}

function getValidOriginLengthForDevelopment(dev, currentOrigin) {
  if (!Number.isFinite(dev) || dev <= 0) return "";
  const originSelect = document.getElementById("originLenSelect");
  const candidates = Array.from(originSelect?.options || [])
    .map((opt) => Number.parseInt(String(opt.value || opt.textContent || ""), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value >= dev && value % dev === 0)
    .sort((a, b) => a - b);
  if (!candidates.length) return "";
  if (Number.isFinite(currentOrigin) && candidates.includes(currentOrigin)) return String(currentOrigin);
  return String(candidates[0]);
}

function enforceDevLenRule(options = {}) {
  const source = String(options?.source || "auto");
  const o = document.getElementById("originLenSelect");
  const d = document.getElementById("devLenSelect");
  if (!o || !d) return false;

  let origin = parseInt(o.value, 10);
  let dev = parseInt(d.value, 10);

  const ok =
    Number.isFinite(origin) &&
    Number.isFinite(dev) &&
    dev <= origin &&
    origin % dev === 0;

  let changed = false;
  if (!ok) {
    if (source === "dev" || (source !== "origin" && dev > origin)) {
      const nextOrigin = getValidOriginLengthForDevelopment(dev, origin);
      if (nextOrigin) {
        changed = setLenSelectValue("originLenSelect", nextOrigin) || changed;
        origin = parseInt(o.value, 10);
      }
    } else {
      const nextDev = getValidDevelopmentLengthForOrigin(origin, dev);
      if (nextDev) {
        changed = setLenSelectValue("devLenSelect", nextDev) || changed;
        dev = parseInt(d.value, 10);
      }
    }
    const validAfterFirstPass =
      Number.isFinite(origin) &&
      Number.isFinite(dev) &&
      dev <= origin &&
      origin % dev === 0;
    if (!validAfterFirstPass) {
      const nextDev = getValidDevelopmentLengthForOrigin(origin, dev);
      if (nextDev) {
        changed = setLenSelectValue("devLenSelect", nextDev) || changed;
      }
    }
  }
  refreshLenDropdowns();
  return changed;
}

// -----------------------------
// Headers (year + dev) via GetDataset-like flow
// key = ProjectName + OriginLength
// -----------------------------

function getCurrentOriginLength() {
  return datasetHeadersService.getCurrentOriginLength();
}

function getCurrentDevLength() {
  return datasetHeadersService.getCurrentDevLength();
}

function ensureHeadersForProject(project, options = {}) {
  return datasetHeadersService.ensureHeadersForProject(project, options);
}

function ensureDevHeadersForProject(project, options = {}) {
  return datasetHeadersService.ensureDevHeadersForProject(project, options);
}

async function handleProjectSelection(value, options = {}) {
  const strict = !!options?.strict;
  const showMessage = !!options?.showMessage;
  const projectInput = document.getElementById("projectSelect");
  if (isDefaultTokenValue(value)) {
    if (projectInput) setInputDefaultBound(projectInput, true);
    clearInputInvalid(projectInput);
    const defaults = loadWorkflowDefaults();
    if (defaults?.project) {
      await applyResolvedProjectDefaults(defaults.project);
    }
    saveTriInputsToStorage();
    await syncSidecarForCurrentDataset({ applyLengths: true });
    scheduleAutoRun(0);
    return true;
  }

  if (projectInput) setInputDefaultBound(projectInput, false);

  const project = findExactProjectMatch(value);
  if (!project) {
    if (strict && projectInput) {
      if (lastProjectSelection) projectInput.value = lastProjectSelection;
      else projectInput.value = "";
      clearInputInvalid(projectInput);
      if (showMessage) {
        reportInputInvalid(
          projectInput,
          "Project Name is not in the valid list.",
          "Invalid Project Name. Please select a valid project.",
        );
      }
    }
    return false;
  }
  clearInputInvalid(projectInput);
  if (project === lastProjectSelection) {
    notifyProjectSelectionCommitted(project, "project-selection");
    return true;
  }

  lastProjectSelection = project;
  if (!window.ADA_DFM_CONTEXT) {
    saveLastDatasetViewerProjectToAppData(project);
  }

  if (projectInput) projectInput.value = project;
  notifyProjectSelectionCommitted(project, "project-selection");
  showProjectDropdown(false);

  saveTriInputsToStorage();
  const showProjectSwitchPopup = !isRunInFlight();
  if (showProjectSwitchPopup) {
    showDatasetLoadingPopup("Validating Reserving Class");
  }
  try {
    await ensureHeadersForProject(project);
    await ensureDevHeadersForProject(project);
    await refreshDatasetTypesForProject(project);
    await refreshReservingClassPathsForProject(project);

    if (options?.applyProjectUserPreferences !== false && !window.ADA_DFM_CONTEXT) {
      const prefs = await loadDatasetProjectPrefs(project);
      const pathInputForPrefs = document.getElementById("pathInput");
      const triInputForPrefs = document.getElementById("triInput");
      if (prefs?.path && pathInputForPrefs && !isInputDefaultBound(pathInputForPrefs)) {
        pathInputForPrefs.value = prefs.path;
      }
      if (prefs?.tri && triInputForPrefs) {
        triInputForPrefs.value = prefs.tri;
        setLastDatasetSelection(prefs.tri);
      }
    }

    const pathInput = document.getElementById("pathInput");
    if (pathInput) {
      const pathIsDefault = isInputDefaultBound(pathInput);
      const currentPath = pathIsDefault
        ? getResolvedReservingClassValue()
        : pathInput.value;
      const normalizedPath = normalizeReservingClassPath(currentPath);
      let validatedPath = "";
      if (normalizedPath) {
        const validated = await validateReservingClassPathByTypeNames(project, normalizedPath);
        if (validated?.ok && validated?.path) {
          validatedPath = ensureReservingClassOption(validated.path) || normalizeReservingClassPath(validated.path);
        }
      }

      if (validatedPath) {
        lastReservingClassSelection = validatedPath;
        if (!pathIsDefault) {
          pathInput.value = validatedPath;
        }
      } else {
        if (pathIsDefault) {
          setInputDefaultBound(pathInput, false);
        }
        pathInput.value = "";
        lastReservingClassSelection = "";
      }
      clearInputInvalid(pathInput);
    }

    const triInput = document.getElementById("triInput");
    if (triInput) {
      const matchedTri = findExactDatasetMatch(triInput.value);
      if (matchedTri) {
        triInput.value = matchedTri;
        lastDatasetSelection = matchedTri;
      } else {
        triInput.value = "";
        lastDatasetSelection = "";
      }
      clearInputInvalid(triInput);
    }

    await syncSidecarForCurrentDataset({ applyLengths: true });
    scheduleAutoRun();
    return true;
  } finally {
    if (showProjectSwitchPopup && !isRunInFlight()) {
      hideDatasetLoadingPopup();
    }
  }
}

function wireGridInteractions() {
  if (datasetGridInteractions) return;
  datasetGridInteractions = wireDatasetGridInteractions({
    state,
    renderTable,
    renderActiveCellUI,
    isReadOnly: isDatasetReadOnly,
    setStatus,
    notifyDatasetUpdated,
  });
}

function applyGridSelectionFromState() {
  datasetGridInteractions?.applySelectionFromState?.();
}

function wireNotesEditor() {
  return wireDatasetNotesEditor({
    getNotesProgrammaticInput: () => notesProgrammaticInput,
    getLastSavedNotesText: () => lastSavedNotesText,
    setNotesDirty: (value) => {
      notesDirty = !!value;
    },
    updateNotesSaveUi,
    saveNotesForCurrentContext,
    setStatus,
  });
}

function wireDatasetInstanceNameInput() {
  const input = document.getElementById("dsDetailName");
  if (!input || input.dataset.instanceNameWired === "1") return;
  input.dataset.instanceNameWired = "1";
  input.addEventListener("input", () => {
    saveTriInputsToStorage();
    refreshDatasetSettingsDirty();
    void refreshDatasetInstanceNameConflict();
  });
  input.addEventListener("change", () => {
    void refreshDatasetInstanceNameConflict();
  });
}

function wireEvents() {
  wireDatasetInputController({
    state,
    $,
    loadDataset,
    isRunInFlight,
    setStatus,
    runArcRhoTri,
    savePatch,
    toggleBlanks,
    wireLenDropdowns,
    syncDetailDatasetTypeFromTopInput,
    ensureDatasetTypeOption,
    clearInputInvalid,
    openReservingClassTreeForDataset,
    showProjectDropdown,
    openProjectNameTreeForDataset,
    showDatasetDropdown,
    openDatasetNameTreeForDataset,
    saveTriInputsToStorage,
    scheduleAutoRun,
    renderTable,
    notifyDatasetUpdated,
    renderChart,
    isDefaultTokenValue,
    setInputDefaultBound,
    getResolvedProjectValue,
    validateAndNormalizeReservingClassInput,
    filterDatasetOptions,
    getActiveDatasetIndex,
    setActiveDatasetIndex,
    chooseActiveDataset,
    validateAndNormalizeDatasetInput,
    validateDatasetTypeDependencies,
    handleDatasetSelection,
    setLastDatasetSelection,
    filterProjectOptions,
    getProjectFilterQuery,
    getActiveProjectIndex,
    setActiveProjectIndex,
    chooseActiveProject,
    handleProjectSelection,
    setLastProjectSelection,
    LEN_DROPDOWN_CONFIG,
    closeAllLenDropdowns,
    syncLen,
    enforceDevLenRule,
    ensureHeadersForProject,
    ensureDevHeadersForProject,
    isLenLinked,
    bindAutoRunOnEnter,
    redrawChartSafely,
    wireDatasetHostBridge,
    getTriInputsForStorage,
    syncSidecarForCurrentDataset,
    instanceId,
    wireGridInteractions,
    isProjectInstanceDraft,
    refreshProjectInstanceDraftModel,
    validateManualDatasetLengthChange,
    isManualDatasetModeLocked: currentDatasetIsManualTriangleOrVector,
    restoreManualDatasetModeControls,
  });
  wireDatasetInstanceNameInput();
  wireNotesEditor();
  wireDatasetSaveControls();
}


async function boot() {
  fillLenDropdowns();
  await loadProjectsDropdown();

  applyWorkflowDefaultsIfNew();

  // restore user inputs AFTER dropdown options are populated
  await restoreTriInputsFromStorage();
  applyTriInputsFromQueryParams();
  enforceDevLenRule();
  const projectResult = validateAndNormalizeProjectInput({ strict: true, showMessage: false });
  if (projectResult.ok) {
    lastProjectSelection = projectResult.value;
    if (!window.ADA_DFM_CONTEXT) {
      saveLastDatasetViewerProjectToAppData(projectResult.value);
    }
    await refreshDatasetTypesForProject(projectResult.value);
    await refreshReservingClassPathsForProject(projectResult.value);
  } else {
    await refreshDatasetTypesForProject("");
    await refreshReservingClassPathsForProject("");
  }
  await validateAndNormalizeReservingClassInput(getResolvedProjectValue(), { strict: true, showMessage: false });
  validateAndNormalizeDatasetInput({ strict: true, showMessage: false });
  await syncSidecarForCurrentDataset({ applyLengths: !isProjectInstanceDraft });
  await refreshDatasetInstanceNameConflict();
  enforceDevLenRule({ source: "origin" });

  // Initialize dataset tab system (Details / Data / Chart / Notes / Audit Log)
  const redrawPoppedChart = (tabId) => {
    if (tabId !== "chart") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(redrawChartSafely);
    });
  };
  const dsTabSystem = createTabbedPage(document.body, {
    tabs: DATASET_TABS,
    cssPrefix: "ds",
    initialTab: getDatasetInitialTab(),
    injectTabBar: false,
    onTabChange: (tabId) => {
      if (tabId === "details") {
        requestAnimationFrame(resizeDetailFormulaInput);
      }
      if (tabId === "chart") {
        // Chart canvas needs a redraw after becoming visible
        requestAnimationFrame(() => {
          requestAnimationFrame(redrawChartSafely);
        });
      }
    },
  });
  window.dsTabSystem = dsTabSystem;
  wireTabPopoutWindows({
    cssPrefix: "ds",
    tabs: DATASET_TABS,
    tabSystem: () => window.dsTabSystem,
    onPopoutTab: redrawPoppedChart,
    onDockTab: redrawPoppedChart,
    onFocusTab: redrawPoppedChart,
    onLayout: redrawPoppedChart,
  });

  wireEvents();

  // If the restored controls are complete, trigger an immediate autoRun.
  // Otherwise, fall back to loading the last dataset.
  const { project, path, tri } = getTriInputs();
  if (project && path && tri) {
    await ensureHeadersForProject(project, { forceRefresh: true });
    await ensureDevHeadersForProject(project, { forceRefresh: true });
    if (isProjectInstanceDraft) {
      initializeProjectInstanceDraftModel();
      setStatus("Ready to edit new dataset draft.");
      renderTable();
      notifyDatasetUpdated();
      renderChart();
    } else {
      scheduleAutoRun(0);
    }
  } else {
    await loadDataset();
  }
}

window.ADA_DATASET_READY = boot();
