import { statusNeedsReview } from "/ui/shared/dataset/review_status.js";
import { openDatasetNamePicker } from "/ui/shared/components/pickers/dataset_name_picker.js";
import {
  createTabbedPage,
  requestTabbedPageWindowClose,
  updateTabbedPageSaveControls,
} from "/ui/shared/tabbed_page/tabbed_page.js?v=20260913a";
import { wireTabPopoutWindows } from "/ui/shared/tabbed_page/tab_popout_window.js?v=20260722a";
import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260911b";
import { syncDetailsLabelWidth } from "/ui/shared/tabs/details/details_form_layout.js?v=20260820b";
import { createDetailsDependenciesController } from "/ui/shared/tabs/details/details_dependencies.js?v=20260820b";
import { applyHostFixedDetailsFields } from "/ui/shared/tabs/details/details_host_fields.js?v=20260820b";
import { createAuditLogView } from "/ui/shared/tabs/audit_log/audit_log_view.js?v=20260714c";
import {
  formatSidecarAuditEventDate,
  normalizeSidecarAuditEntries,
} from "/ui/shared/tabs/audit_log/sidecar_audit_entries.js?v=20260714c";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import { createPageCloseConfirm } from "/ui/shared/components/close_confirm/close_confirm.js";
import { showMethodSaveReviewWarning } from "/ui/shared/components/message_box/method_save_review_warning.js?v=20260827a";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260916a";
import { createArcRhoSaveProgress, showSavedDependentsNotice } from "/ui/shared/components/progress_popup/save_progress.js?v=20260916b";
import {
  isEngineUnavailableSaveError,
  trackSavePropagation,
} from "/ui/shared/services/dependent_propagation_job.js?v=20260813e";
import {
  createMethodObjectChangeWatchController,
  showObjectUpdatedAlert,
  wireSamePropagationScopePause,
} from "/ui/shared/services/object_change_watch.js?v=20260820a";
import { readProjectInstanceDatasetSnapshot } from "/ui/shared/dataset/project_instance_dataset_snapshot.js?v=20260725a";
import { BOOTSTRAP_TAB_DEFS, windowTabIds } from "/ui/shared/tabs/window_tab_catalog.js?v=20260903a";
import { loadBootstrapMethod, saveBootstrapMethod } from "/ui/method_pages/bootstrap/bootstrap_method_api.js?v=20260923a";
import { createResidualChart } from "/ui/method_pages/bootstrap/bootstrap_residual_chart.js?v=20260923a";
import { createDistributionChart } from "/ui/method_pages/bootstrap/bootstrap_distribution_chart.js?v=20260923b";
import { createFanChart } from "/ui/method_pages/bootstrap/bootstrap_fan_chart.js?v=20260923b";
import {
  BST_BASIS_OPTIONS,
  BST_DEFAULT_PERCENTILES,
  BST_MEASURE_OPTIONS,
  availableBases,
  distributionChartData,
  fanChartData,
  formatPercentileList,
  formatRunDuration,
  ladderTableRows,
  parsePercentileList,
  resultsClipboardText,
  resultsView,
  summaryTableColumns,
  BST_DISTRIBUTION_OPTIONS,
  BST_METHOD_TYPE,
  BST_MODEL_OPTIONS,
  BST_NEGATIVE_MEAN_OPTIONS,
  BST_ODP_NEGATIVE_MEAN_OPTIONS,
  BST_RESIDUAL_TYPE_OPTIONS,
  BST_SCALE_ROWS,
  BST_SCALING_OPTIONS,
  applyBootstrapSettings,
  bootstrapRunState,
  flagLargeResiduals,
  hasSimulationRun,
  newRandomSeed,
  odpNegativeMeanApplies,
  optionLabel,
  originLabels,
  readBootstrapSettings,
  residualColumnLabels,
  residualGrid,
  simulationSummary,
  targetRows,
} from "/ui/method_pages/bootstrap/bootstrap_page_model.js?v=20260923b";

const ALLOWED_TABS = windowTabIds("bootstrap");
const params = new URLSearchParams(window.location.search || "");
const inst = text(params.get("inst")) || `bst_${Date.now()}`;

const state = {
  project: text(params.get("project")),
  reservingClass: text(params.get("class") || params.get("path")),
  method: null,
  persisted: false,
  settings: readBootstrapSettings({}),
  cachedRows: [],
  ownedRevision: "",
  derivedRevision: "",
  needsReview: false,
  // A run in flight, and how long the last run in this window took; the
  // stored method does not record a run's duration.
  running: false,
  lastRunMs: null,
  // Results view choices: page state, not method settings, so they never
  // make the method dirty.
  results: {
    basis: "scaled",
    measure: "reserves",
    percentiles: BST_DEFAULT_PERCENTILES.slice(),
    fullLadder: false,
  },
};

let cleanSnapshot = "";
let isDirty = false;
let tabbedPage = null;
let residualChart = null;
let distributionChart = null;
let fanChart = null;
let menuState = null;

const els = {
  headerName: document.getElementById("bstHeaderName"),
  stateChip: document.getElementById("bstStateChip"),
  stateLabel: document.getElementById("bstStateLabel"),
  runInfo: document.getElementById("bstRunInfo"),
  simulateBtn: document.getElementById("bstSimulateBtn"),
  saveBtn: document.getElementById("bstSaveBtn"),
  cancelBtn: document.getElementById("bstCancelBtn"),
  nameInput: document.getElementById("bstNameInput"),
  outputTypeInput: document.getElementById("bstOutputTypeInput"),
  outputTypeBtn: document.getElementById("bstOutputTypeBtn"),
  projectInput: document.getElementById("bstProjectInput"),
  classInput: document.getElementById("bstClassInput"),
  dfmInput: document.getElementById("bstDfmInput"),
  dfmBtn: document.getElementById("bstDfmBtn"),
  originLengthInput: document.getElementById("bstOriginLengthInput"),
  developmentLengthInput: document.getElementById("bstDevelopmentLengthInput"),
  modelControl: document.getElementById("bstModelControl"),
  residualTypeButton: document.getElementById("bstResidualTypeButton"),
  residualSmoothingInput: document.getElementById("bstResidualSmoothingInput"),
  forecastSmoothingInput: document.getElementById("bstForecastSmoothingInput"),
  showScaleInput: document.getElementById("bstShowScaleInput"),
  residualHead: document.getElementById("bstResidualHead"),
  residualBody: document.getElementById("bstResidualBody"),
  residualCaption: document.getElementById("bstResidualCaption"),
  residualChart: document.getElementById("bstResidualChart"),
  residualsSplit: document.querySelector(".bstResidualsSplit"),
  residualsEmpty: document.getElementById("bstResidualsEmpty"),
  simulationCountInput: document.getElementById("bstSimulationCountInput"),
  seedInput: document.getElementById("bstSeedInput"),
  newSeedBtn: document.getElementById("bstNewSeedBtn"),
  estimationButton: document.getElementById("bstEstimationButton"),
  processButton: document.getElementById("bstProcessButton"),
  preventNegativeInput: document.getElementById("bstPreventNegativeInput"),
  negativeMeanButton: document.getElementById("bstNegativeMeanButton"),
  odpNegativeMeanButton: document.getElementById("bstOdpNegativeMeanButton"),
  targetInput: document.getElementById("bstTargetInput"),
  targetBtn: document.getElementById("bstTargetBtn"),
  targetClearBtn: document.getElementById("bstTargetClearBtn"),
  targetsHead: document.getElementById("bstTargetsHead"),
  targetsBody: document.getElementById("bstTargetsBody"),
  targetsCaption: document.getElementById("bstTargetsCaption"),
  resultsBody: document.getElementById("bstResultsBody"),
  resultsEmpty: document.getElementById("bstResultsEmpty"),
  resultsEmptyText: document.getElementById("bstResultsEmptyText"),
  emptySimulateBtn: document.getElementById("bstEmptySimulateBtn"),
  basisControl: document.getElementById("bstBasisControl"),
  measureControl: document.getElementById("bstMeasureControl"),
  percentileInput: document.getElementById("bstPercentileInput"),
  percentileResetBtn: document.getElementById("bstPercentileResetBtn"),
  fullLadderInput: document.getElementById("bstFullLadderInput"),
  copyResultsBtn: document.getElementById("bstCopyResultsBtn"),
  resultsStale: document.getElementById("bstResultsStale"),
  staleSimulateBtn: document.getElementById("bstStaleSimulateBtn"),
  resultsHead: document.getElementById("bstResultsHead"),
  resultsTableBody: document.getElementById("bstResultsTableBody"),
  resultsCaption: document.getElementById("bstResultsCaption"),
  distributionTitle: document.getElementById("bstDistributionTitle"),
  distributionChart: document.getElementById("bstDistributionChart"),
  distributionEmpty: document.getElementById("bstDistributionEmpty"),
  distributionTooltip: document.getElementById("bstDistributionTooltip"),
  fanTitle: document.getElementById("bstFanTitle"),
  fanChart: document.getElementById("bstFanChart"),
  fanLegend: document.getElementById("bstFanLegend"),
  fanEmpty: document.getElementById("bstFanEmpty"),
  fanTooltip: document.getElementById("bstFanTooltip"),
  menu: document.getElementById("bstMenu"),
};

const closeConfirm = createPageCloseConfirm({ subject: BST_METHOD_TYPE });
const saveProgress = createArcRhoSaveProgress({ subject: BST_METHOD_TYPE });
const notesController = mountNotesTab({
  container: document.getElementById("bstNotesMount"),
  ariaLabel: "Bootstrap notes",
  onChange: () => markDirty(),
  onStatus: postStatus,
});
const auditLogView = createAuditLogView({
  container: document.getElementById("bstAuditLogMount"),
  ariaLabel: "Bootstrap audit log",
  emptyDescription: "Method saves will appear here after the first save.",
  normalizeEntries: normalizeSidecarAuditEntries,
  formatEventDate: formatSidecarAuditEventDate,
});
// Open-window change alert (advisory): fires once when another user or the
// dependent-propagation job rewrites this method while it is open.
const objectChangeWatch = createMethodObjectChangeWatchController({
  methodType: "bootstrap",
  onChange: (attribution) => {
    void showObjectUpdatedAlert({
      showMessageBox: showPageMessageBox,
      attribution,
      isDirty: () => isDirty,
      onBlockedRefresh: () => {
        postStatus("Unsaved changes block the refresh. Save or discard them, then reopen the window.", "warn");
      },
    });
  },
});
wireSamePropagationScopePause({
  watch: objectChangeWatch,
  getProject: () => state.project,
  getReservingClass: () => state.reservingClass,
});
const detailsDependencies = createDetailsDependenciesController({
  precedentsList: "bstPrecedentsList",
  dependentsList: "bstDependentsList",
  getIdentity: () => ({
    projectName: state.project,
    reservingClass: state.reservingClass,
    datasetName: state.settings.name,
  }),
  instanceId: inst,
  isProjectInstanceHost: window.parent !== window,
  setStatus: (message) => postStatus(message),
});

function text(value) {
  return String(value ?? "").trim();
}

function norm(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value, decimals = 0) {
  const n = numberOrNull(value);
  if (n === null) return "";
  // A value that rounds to zero shows as 0, not -0.
  const shown = Math.abs(n) < 0.5 * 10 ** -decimals ? 0 : n;
  return shown.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPercent(value, decimals = 1) {
  const n = numberOrNull(value);
  return n === null ? "" : `${(n * 100).toFixed(decimals)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function postStatus(message, tone = "") {
  try {
    window.parent?.postMessage({ type: "arcrho:status", text: text(message), ...(tone ? { tone } : {}) }, "*");
  } catch {}
}

function snapshotPage() {
  return JSON.stringify({ settings: state.settings, notes: notesController.elements.input?.value || "" });
}

function syncHeader() {
  const name = state.settings.name;
  els.headerName.textContent = name || BST_METHOD_TYPE;
  document.title = name ? `${name} - ${BST_METHOD_TYPE}` : BST_METHOD_TYPE;
  const run = bootstrapRunState({ method: state.method, dirty: isDirty, running: state.running });
  els.stateChip.dataset.state = run.key;
  els.stateLabel.textContent = run.label;
  const summary = simulationSummary(state.method);
  const duration = formatRunDuration(state.lastRunMs);
  els.runInfo.textContent = state.running
    ? `Running ${formatNumber(state.settings.simulationCount)} simulations`
    : hasSimulationRun(state.method)
      ? [
        `${formatNumber(summary.simulation_count)} simulations`,
        `seed ${summary.random_seed}`,
        ...(duration ? [`ran in ${duration}`] : []),
      ].join(" · ")
      : "";
  const canRun = !state.running && !!state.settings.dfmMethod;
  for (const button of [els.simulateBtn, els.emptySimulateBtn, els.staleSimulateBtn]) button.disabled = !canRun;
  els.resultsStale.hidden = !(isDirty && hasSimulationRun(state.method)) || state.running;
}

function syncSaveControls() {
  updateTabbedPageSaveControls({
    saveButton: els.saveBtn,
    cancelButton: els.cancelBtn,
    dirty: isDirty,
    needsReview: state.needsReview,
  });
}

function postDirty(dirty, force = false) {
  const next = !!dirty;
  if (!force && isDirty === next) return;
  isDirty = next;
  syncSaveControls();
  syncHeader();
  try {
    window.parent?.postMessage({ type: "arcrho:dataset-dirty", inst, dirty: next }, "*");
  } catch {}
}

function markDirty() {
  postDirty(snapshotPage() !== cleanSnapshot);
}

function markClean() {
  cleanSnapshot = snapshotPage();
  notesController.markClean();
  postDirty(false, true);
}

function updateSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  markDirty();
}

/* ---------------------------------------------------------------------------
   One dropdown menu serves every select-like control on the page, so each
   opened list looks and behaves the same.
--------------------------------------------------------------------------- */

function closeMenu({ focusAnchor = false } = {}) {
  if (!menuState) return;
  const { anchor } = menuState;
  anchor.setAttribute("aria-expanded", "false");
  anchor.classList.remove("open");
  els.menu.hidden = true;
  els.menu.innerHTML = "";
  menuState = null;
  if (focusAnchor) anchor.focus();
}

function openMenu(anchor, options, current, onSelect) {
  if (menuState?.anchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  els.menu.innerHTML = options.map((option) => `
    <button class="bstMenuOption" type="button" role="option" data-value="${escapeHtml(option.value)}"
      aria-selected="${option.value === current ? "true" : "false"}">${escapeHtml(option.label)}</button>`).join("");
  const rect = anchor.getBoundingClientRect();
  els.menu.style.minWidth = `${Math.round(rect.width)}px`;
  els.menu.hidden = false;
  const menuHeight = els.menu.offsetHeight;
  const below = rect.bottom + 3 + menuHeight <= window.innerHeight - 4;
  els.menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - els.menu.offsetWidth - 4))}px`;
  els.menu.style.top = `${Math.round(below ? rect.bottom + 3 : Math.max(4, rect.top - 3 - menuHeight))}px`;
  anchor.setAttribute("aria-expanded", "true");
  anchor.classList.add("open");
  menuState = { anchor, onSelect };
  (els.menu.querySelector("[aria-selected='true']") || els.menu.querySelector(".bstMenuOption"))?.focus();
}

function wireMenu() {
  els.menu.addEventListener("click", (event) => {
    const option = event.target.closest(".bstMenuOption");
    if (!option || !menuState) return;
    const { onSelect } = menuState;
    closeMenu({ focusAnchor: true });
    onSelect(option.dataset.value);
  });
  els.menu.addEventListener("keydown", (event) => {
    const options = Array.from(els.menu.querySelectorAll(".bstMenuOption"));
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeMenu({ focusAnchor: true });
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menuState) return;
    if (els.menu.contains(event.target) || menuState.anchor.contains(event.target)) return;
    closeMenu();
  }, true);
  window.addEventListener("resize", () => closeMenu());
  document.querySelector(".bstPageHost")?.addEventListener("scroll", () => closeMenu(), true);
}

function setDropdown(button, options, value, disabled = false) {
  button.querySelector(".bstDropdownValue").textContent = optionLabel(options, value);
  button.disabled = disabled;
}

function bindDropdown(button, options, key) {
  button.addEventListener("click", () => {
    openMenu(button, options, state.settings[key], (value) => {
      updateSetting(key, value);
      renderSettingsControls();
    });
  });
}

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */

function dfmSnapshot() {
  const snapshot = state.method?.details_tab?.dfm_snapshot;
  return snapshot && typeof snapshot === "object" ? snapshot : {};
}

function renderModelControl() {
  els.modelControl.innerHTML = BST_MODEL_OPTIONS.map((option) => `
    <button class="bstSegment" type="button" role="radio" data-value="${option.value}"
      aria-checked="${option.value === state.settings.modelType ? "true" : "false"}"
      ${option.disabled ? "disabled" : ""}>${escapeHtml(option.label)}</button>`).join("");
  for (const button of els.modelControl.querySelectorAll(".bstSegment")) {
    const option = BST_MODEL_OPTIONS.find((item) => item.value === button.dataset.value);
    if (option?.hint) {
      // A disabled button takes no pointer events, so the hint sits on a wrapper.
      const wrap = document.createElement("span");
      wrap.className = "bstSegmentHint";
      button.replaceWith(wrap);
      wrap.appendChild(button);
      attachArcrhoTooltip(wrap, option.hint);
    }
  }
}

function renderSettingsControls() {
  const s = state.settings;
  els.nameInput.value = s.name;
  els.nameInput.readOnly = state.persisted;
  els.outputTypeInput.value = s.outputType;
  els.dfmInput.value = s.dfmMethod;
  const snapshot = dfmSnapshot();
  els.originLengthInput.value = snapshot.origin_length ? String(snapshot.origin_length) : "";
  els.developmentLengthInput.value = snapshot.development_length ? String(snapshot.development_length) : "";
  renderModelControl();

  setDropdown(els.residualTypeButton, BST_RESIDUAL_TYPE_OPTIONS, s.residualType);
  if (document.activeElement !== els.residualSmoothingInput) els.residualSmoothingInput.value = String(s.residualScaleSmoothing);
  if (document.activeElement !== els.forecastSmoothingInput) els.forecastSmoothingInput.value = String(s.forecastScaleSmoothing);
  els.showScaleInput.checked = s.showScaleValues;

  if (document.activeElement !== els.simulationCountInput) els.simulationCountInput.value = String(s.simulationCount);
  if (document.activeElement !== els.seedInput) els.seedInput.value = String(s.randomSeed);
  setDropdown(els.estimationButton, BST_DISTRIBUTION_OPTIONS, s.estimationVariance);
  setDropdown(els.processButton, BST_DISTRIBUTION_OPTIONS, s.processVariance);
  els.preventNegativeInput.checked = s.preventNegativeData;
  setDropdown(els.negativeMeanButton, BST_NEGATIVE_MEAN_OPTIONS, s.negativeMeanAction);
  setDropdown(els.odpNegativeMeanButton, BST_ODP_NEGATIVE_MEAN_OPTIONS, s.odpNegativeMeanAction, !odpNegativeMeanApplies(s));

  els.targetInput.value = s.targetUltimate;
  els.targetClearBtn.hidden = !s.targetUltimate;
  renderResiduals();
  renderTargets();
  syncHeader();
}

function scaleRowsMarkup(title, block, userValues, userKey, columnCount) {
  const header = `<tr class="bstBandRow"><td class="bstOriginCell">${escapeHtml(title)}</td>${
    `<td class="bstBandCell" colspan="${columnCount}"></td>`}</tr>`;
  const rows = BST_SCALE_ROWS.map(({ key, label }) => {
    const cells = Array.from({ length: columnCount }, (_, c) => {
      if (key === "user_entry") {
        const value = numberOrNull(userValues[c]);
        return `<td class="bstCell bstEntryCell"><input class="bstCellInput" type="text" inputmode="decimal"
          data-user-scale="${userKey}" data-col="${c}" value="${value === null ? "" : escapeHtml(String(value))}"
          aria-label="${escapeHtml(`${title} user entry ${c + 1}`)}"></td>`;
      }
      const value = Array.isArray(block?.[key]) ? block[key][c] : null;
      const cls = key === "selected" ? "bstCell bstResultCell" : "bstCell bstDerivedCell";
      return `<td class="${cls}">${formatNumber(value, 3)}</td>`;
    }).join("");
    return `<tr><td class="bstOriginCell bstScaleLabel">${label}</td>${cells}</tr>`;
  }).join("");
  return header + rows;
}

function renderResiduals() {
  const grid = residualGrid(state.method, state.settings.residualType);
  const hasGrid = grid.length > 0;
  els.residualsSplit.hidden = !hasGrid;
  els.residualsEmpty.hidden = hasGrid;
  if (!hasGrid) {
    residualChart?.render({});
    els.residualCaption.textContent = "";
    return;
  }
  const columnCount = Math.max(...grid.map((row) => row.length));
  const labels = residualColumnLabels(state.method, columnCount);
  const origins = originLabels(state.method);
  const flags = flagLargeResiduals(grid);
  els.residualHead.innerHTML = `<tr><th class="bstOriginHead">Origin</th>${
    labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr>`;
  const rows = grid.map((row, r) => `<tr><td class="bstOriginCell">${escapeHtml(origins[r] || String(r + 1))}</td>${
    Array.from({ length: columnCount }, (_, c) => {
      const value = row[c];
      const cls = flags[r]?.[c] ? "bstCell bstFlaggedCell" : "bstCell";
      return `<td class="${cls}">${formatNumber(value, 3)}</td>`;
    }).join("")}</tr>`).join("");
  const residuals = state.method?.residuals_tab || {};
  const scaleRows = state.settings.showScaleValues
    ? scaleRowsMarkup("Scale (Residuals)", residuals.scale_values_residuals, state.settings.userScaleValuesResiduals, "residuals", columnCount)
      + scaleRowsMarkup("Scale (Forecasting)", residuals.scale_values_forecasting, state.settings.userScaleValuesForecasting, "forecasting", columnCount)
    : "";
  els.residualBody.innerHTML = rows + scaleRows;
  const adjustment = numberOrNull(residuals.residual_adjustment);
  const bias = numberOrNull(residuals.bias_factor);
  const flagged = flags.flat().filter(Boolean).length;
  els.residualCaption.textContent = [
    adjustment !== null ? `Residuals adjusted by ${formatNumber(adjustment, 6)} to make the mean zero.` : "",
    bias !== null ? `Bias factor ${formatNumber(bias, 6)}.` : "",
    `${formatNumber(residuals.data_point_count)} data points, ${formatNumber(residuals.parameter_count)} parameters.`,
    flagged ? `${flagged} large ${flagged === 1 ? "residual" : "residuals"} flagged.` : "",
  ].filter(Boolean).join(" ");
  residualChart?.render({ grid, flags, labels });
}

function targetCell(value, decimals = 0, extra = "") {
  return `<td class="bstCell ${extra}">${formatNumber(value, decimals)}</td>`;
}

function renderTargets() {
  const { rows, total } = targetRows(state.method, state.settings);
  const pending = norm(state.settings.targetUltimate) !== norm(state.method?.results_tab?.target_ultimate);
  els.targetsHead.innerHTML = `<tr>
    <th class="bstOriginHead">Origin</th>
    <th>Target Ultimate</th>
    <th>Target Reserve</th>
    <th class="bstScalingHead">Scaling Method</th>
    <th>CV (%)</th>
    <th>Unscaled Mean Reserve</th>
    <th>Target - Unscaled</th>
    <th>Target / Unscaled</th>
  </tr>`;
  if (!rows.length) {
    els.targetsBody.innerHTML = `<tr><td class="bstEmptyRow" colspan="8">Choose a DFM and save to list the origins.</td></tr>`;
    els.targetsCaption.textContent = "";
    return;
  }
  const body = rows.map((row) => {
    const userDefined = row.scalingMethod === "user_defined";
    return `<tr>
      <td class="bstOriginCell">${escapeHtml(row.origin)}</td>
      ${targetCell(row.targetUltimate)}
      ${targetCell(row.targetReserve)}
      <td class="bstCell bstEntryCell bstScalingCell">
        <button class="bstCellDropdown" type="button" data-scaling-row="${row.index}" aria-haspopup="listbox" aria-expanded="false"
          aria-label="${escapeHtml(`Scaling method for ${row.origin}`)}">
          <span class="bstDropdownValue">${escapeHtml(optionLabel(BST_SCALING_OPTIONS, row.scalingMethod))}</span><span class="bstDropdownCaret" aria-hidden="true"></span>
        </button>
      </td>
      <td class="bstCell ${userDefined ? "bstEntryCell" : "bstInactiveCell"}">${userDefined
        ? `<input class="bstCellInput" type="text" inputmode="decimal" data-cv-row="${row.index}"
            value="${escapeHtml(String(+(row.cv * 100).toFixed(6)))}" aria-label="${escapeHtml(`CV for ${row.origin}`)}">`
        : ""}</td>
      ${targetCell(row.unscaledMean, 0, "bstDerivedCell")}
      ${targetCell(row.difference, 0, "bstDerivedCell")}
      <td class="bstCell bstDerivedCell">${formatPercent(row.ratio)}</td>
    </tr>`;
  }).join("");
  els.targetsBody.innerHTML = `${body}<tr class="bstTotalRow">
      <td class="bstOriginCell">Total</td>
      ${targetCell(total.targetUltimate)}
      ${targetCell(total.targetReserve)}
      <td class="bstCell bstInactiveCell"></td>
      <td class="bstCell bstInactiveCell"></td>
      ${targetCell(total.unscaledMean, 0, "bstDerivedCell")}
      ${targetCell(total.difference, 0, "bstDerivedCell")}
      <td class="bstCell bstDerivedCell">${formatPercent(total.ratio)}</td>
    </tr>`;
  els.targetsCaption.textContent = pending
    ? "The target reserves and the unscaled means update when the method is saved."
    : "";
}

/* ---------------------------------------------------------------------------
   Results: one view (basis and measure) feeds the table and both charts, and
   the chosen percentiles are shared by all three.
--------------------------------------------------------------------------- */

function segmentedMarkup(options, current, available = null) {
  return options.map((option) => {
    const enabled = !available || available.includes(option.value);
    return `<button class="bstSegment" type="button" role="radio" data-value="${option.value}"
      aria-checked="${option.value === current ? "true" : "false"}" ${enabled ? "" : "disabled"}>${escapeHtml(option.label)}</button>`;
  }).join("");
}

function currentResultsView() {
  const bases = availableBases(state.method);
  if (bases.length && !bases.includes(state.results.basis)) state.results.basis = bases[0];
  return resultsView(state.method, { basis: state.results.basis, measure: state.results.measure });
}

function resultCell(value, kind, extra = "") {
  const shown = kind === "percent" ? formatPercent(value) : formatNumber(value);
  return `<td class="bstCell${extra ? ` ${extra}` : ""}">${shown}</td>`;
}

function renderSummaryTable(view) {
  const columns = summaryTableColumns(view.measure, state.results.percentiles);
  els.resultsHead.innerHTML = `<tr><th class="bstOriginHead">Origin</th>${
    columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr>`;
  const rowMarkup = (row, total) => `<tr${total ? " class=\"bstTotalRow\"" : ""}>
    <td class="bstOriginCell">${escapeHtml(row.label)}</td>${
    columns.map((column) => resultCell(column.value(row), column.kind)).join("")}</tr>`;
  els.resultsTableBody.innerHTML = view.rows.map((row) => rowMarkup(row, false)).join("") + rowMarkup(view.total, true);
}

function renderLadderTable(view) {
  const rows = ladderTableRows(view, state.results.percentiles);
  els.resultsHead.innerHTML = `<tr><th class="bstOriginHead">Statistic</th>${
    view.rows.map((row) => `<th>${escapeHtml(row.label)}</th>`).join("")}<th>Total</th></tr>`;
  els.resultsTableBody.innerHTML = rows.map((row) => `<tr${row.chosen ? " class=\"bstChosenRow\"" : ""}>
    <td class="bstOriginCell">${escapeHtml(row.label)}</td>${
    row.values.map((value, index) => resultCell(value, row.kind, index === row.values.length - 1 ? "bstTotalCell" : "")).join("")}</tr>`).join("");
}

function renderResultsCharts(view) {
  const noun = view.measure === "ultimates" ? "Ultimate" : "Reserve";
  els.distributionTitle.textContent = `Distribution Of Total ${noun}`;
  els.fanTitle.textContent = `${noun}s By Origin`;
  distributionChart?.render(distributionChartData(view, state.results.percentiles));
  fanChart?.render(fanChartData(view, state.results.percentiles));
}

function renderResults() {
  const run = hasSimulationRun(state.method);
  els.resultsEmpty.hidden = run;
  els.resultsBody.hidden = !run;
  syncHeader();
  if (!run) {
    els.resultsEmptyText.textContent = state.settings.dfmMethod
      ? "Not run yet. Simulate runs the model and saves the results."
      : "Choose a DFM on the Details tab, then simulate.";
    return;
  }
  const view = currentResultsView();
  els.basisControl.innerHTML = segmentedMarkup(BST_BASIS_OPTIONS, state.results.basis, availableBases(state.method));
  els.measureControl.innerHTML = segmentedMarkup(BST_MEASURE_OPTIONS, state.results.measure);
  if (document.activeElement !== els.percentileInput) {
    els.percentileInput.value = formatPercentileList(state.results.percentiles);
  }
  els.fullLadderInput.checked = state.results.fullLadder;
  if (!view) return;
  els.resultsBody.classList.toggle("isFullLadder", state.results.fullLadder);
  if (state.results.fullLadder) renderLadderTable(view);
  else renderSummaryTable(view);
  const basisLabel = view.basis === "scaled" ? "Scaled" : "Unscaled";
  els.resultsCaption.textContent = `${basisLabel} ${view.measure} over ${formatNumber(view.simulationCount)} simulations, seed ${view.randomSeed ?? ""}.`;
  renderResultsCharts(view);
}

function commitPercentiles() {
  const parsed = parsePercentileList(els.percentileInput.value);
  if (!parsed.ok) {
    postStatus(parsed.error, "warn");
    els.percentileInput.value = formatPercentileList(state.results.percentiles);
    return;
  }
  state.results.percentiles = parsed.values;
  els.percentileInput.value = formatPercentileList(parsed.values);
  renderResults();
}

async function copyResults() {
  const view = currentResultsView();
  const payload = resultsClipboardText(view, {
    percentiles: state.results.percentiles,
    fullLadder: state.results.fullLadder,
  });
  if (!payload) return;
  try {
    await navigator.clipboard.writeText(payload);
    postStatus(`Copied ${payload.split("\r\n").length - 1} rows of results.`);
  } catch (err) {
    postStatus(`Copy failed: ${String(err?.message || err)}`, "error");
  }
}

function wireResults() {
  const segmentedHandler = (key) => (event) => {
    const button = event.target.closest(".bstSegment");
    if (!button || button.disabled || button.dataset.value === state.results[key]) return;
    state.results[key] = button.dataset.value;
    renderResults();
  };
  els.basisControl.addEventListener("click", segmentedHandler("basis"));
  els.measureControl.addEventListener("click", segmentedHandler("measure"));
  els.percentileInput.addEventListener("change", commitPercentiles);
  els.percentileInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") els.percentileInput.blur();
    if (event.key === "Escape") {
      els.percentileInput.value = formatPercentileList(state.results.percentiles);
      els.percentileInput.blur();
    }
  });
  els.percentileResetBtn.addEventListener("click", () => {
    state.results.percentiles = BST_DEFAULT_PERCENTILES.slice();
    renderResults();
  });
  els.fullLadderInput.addEventListener("change", () => {
    state.results.fullLadder = els.fullLadderInput.checked;
    renderResults();
  });
  els.copyResultsBtn.addEventListener("click", () => void copyResults());
  for (const button of [els.simulateBtn, els.emptySimulateBtn, els.staleSimulateBtn]) {
    button.addEventListener("click", () => void simulateFromUser());
  }
}

function renderAll() {
  renderSettingsControls();
  renderResults();
}

/* ---------------------------------------------------------------------------
   Load and save
--------------------------------------------------------------------------- */

function applyOutputSidecar(sidecar) {
  const payload = sidecar && typeof sidecar === "object" ? sidecar : {};
  if (payload.exists === false) {
    state.needsReview = false;
    notesController.setValue("", { markClean: true });
    auditLogView.clear();
    return;
  }
  state.needsReview = statusNeedsReview(payload.status);
  notesController.setValue(String(payload.notes ?? ""), { markClean: true });
  auditLogView.render(payload.audit_log);
}

function applyLoaded(result) {
  const method = result?.method;
  if (!method || text(method.json_format) !== "arcrho-bootstrap-v4") {
    throw new Error("Bootstrap load did not return a current method.");
  }
  state.method = method;
  state.persisted = true;
  state.settings = readBootstrapSettings(method);
  state.ownedRevision = text(result?.owned_revision);
  state.derivedRevision = text(result?.derived_revision);
  applyOutputSidecar(result?.sidecar);
  renderAll();
  objectChangeWatch.ensure({
    projectName: state.project,
    reservingClass: state.reservingClass,
    methodName: state.settings.name,
    outputDataset: text(result?.output_dataset) || state.settings.name,
    selfWriteStamp: result?.sidecar?.updated_at,
  });
}

async function tryLoadExistingMethod() {
  if (!state.settings.name) return false;
  try {
    const result = await loadBootstrapMethod({
      project_name: state.project,
      reserving_class: state.reservingClass,
      method_name: state.settings.name,
    });
    applyLoaded(result);
    return true;
  } catch (err) {
    if (Number(err?.status) === 404) return false;
    throw err;
  }
}

/* Every save re-simulates on the server, so Save and Simulate send the same
   request; Simulate only words the progress card for the run and stays
   available when nothing changed, to run the stored settings again. */
async function runSave(progress, { simulate = false } = {}) {
  const s = state.settings;
  if (!s.name || !s.outputType || !s.dfmMethod) {
    postStatus(`Bootstrap ${simulate ? "simulation" : "save"} requires Name, Output Type, and DFM.`, "error");
    return { ok: false };
  }
  const method = applyBootstrapSettings(state.method || {}, s);
  let result;
  objectChangeWatch.pause();
  try {
    const started = performance.now();
    state.running = true;
    syncHeader();
    try {
      if (simulate) {
        progress.setMessage(`Running ${formatNumber(s.simulationCount)} simulations and saving the results.`);
      } else {
        progress.writing();
      }
      result = await saveBootstrapMethod({
        project_name: state.project,
        reserving_class: state.reservingClass,
        method,
        notes: notesController.elements.input?.value || "",
        expected_owned_revision: state.ownedRevision,
        expected_derived_revision: state.derivedRevision,
      });
    } catch (err) {
      progress.finish();
      if (isEngineUnavailableSaveError(err)) {
        void showPageMessageBox({ title: "Arco Engine Unavailable", message: String(err?.message || err), tone: "warn" });
      }
      throw err;
    } finally {
      state.running = false;
    }
    state.lastRunMs = performance.now() - started;
    applyLoaded(result);
    markClean();
    void detailsDependencies.refresh().catch(() => null);
    try {
      window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
    } catch {}
    postStatus(
      result?.propagation_ok === false
        ? `Bootstrap saved, but some dependent updates did not complete: ${text(result?.propagation?.message) || s.name}`
        : `Bootstrap ${simulate ? "simulated and saved" : "saved"}: ${s.name} (${formatRunDuration(state.lastRunMs)})`,
      result?.propagation_ok === false ? "warn" : "",
    );
    const propagationOutcome = await trackSavePropagation(result?.propagation, {
      onStatus: (message, statusOptions) => {
        progress.setMessage?.(message, statusOptions);
        postStatus(message, statusOptions?.tone === "warn" ? "warn" : "");
      },
      onComplete: () => {
        try {
          window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
        } catch {}
      },
    });
    progress.finish();
    await showMethodSaveReviewWarning(result, {
      instanceId: inst,
      projectName: state.project,
      reservingClass: state.reservingClass,
    });
    return {
      ...result,
      propagationClean: propagationOutcome !== null,
      refreshedDatasets: propagationOutcome?.review_flagged_datasets || [],
      linkWarnings: propagationOutcome?.link_warnings || [],
    };
  } finally {
    objectChangeWatch.resume();
  }
}

async function saveFromUser({ simulate = false } = {}) {
  if (state.running) return;
  try {
    const saved = await saveProgress.run((progress) => runSave(progress, { simulate }));
    if (saved?.ok && saved?.propagationClean) {
      await showSavedDependentsNotice(saved.refreshedDatasets, { linkWarnings: saved.linkWarnings });
    }
  } catch (err) {
    console.error(err);
    postStatus(`${simulate ? "Simulation" : "Save"} failed: ${String(err?.message || err)}`, "error");
  } finally {
    syncHeader();
  }
}

function simulateFromUser() {
  return saveFromUser({ simulate: true });
}

/* ---------------------------------------------------------------------------
   Pickers
--------------------------------------------------------------------------- */

function normalizeCachedRow(row) {
  const name = text(row?.datasetName || row?.dataset_name || row?.name || row?.datasetTypeName || row?.dataset_type);
  return {
    ...row,
    name,
    datasetType: text(row?.datasetTypeName || row?.dataset_type || row?.datasetType || name),
    dataFormat: text(row?.dataFormat || row?.data_format || row?.meta?.dataFormat),
    methodType: text(row?.methodType || row?.method_type || row?.meta?.methodType),
    category: text(row?.category || row?.dataset_category || row?.meta?.category),
    methodName: text(row?.instance?.method_name || row?.method_name || row?.methodName),
  };
}

async function loadCachedRows() {
  if (!state.project || !state.reservingClass) return [];
  const shared = params.get("project_instance") === "1"
    ? readProjectInstanceDatasetSnapshot(state.project, state.reservingClass)
    : null;
  if (shared) {
    state.cachedRows = shared.files.map(normalizeCachedRow).filter((row) => row.name);
    return state.cachedRows;
  }
  const qs = new URLSearchParams({ project_name: state.project, reserving_class: state.reservingClass });
  const resp = await fetch(`/datasets/cached?${qs.toString()}`, { cache: "no-store" });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Dataset cache failed (${resp.status}).`);
  const rows = Array.isArray(payload?.files) ? payload.files : Array.isArray(payload?.rows) ? payload.rows : [];
  state.cachedRows = rows.map(normalizeCachedRow).filter((row) => row.name);
  return state.cachedRows;
}

function cachedRecordByName(name) {
  const key = norm(name);
  return state.cachedRows.find((row) => norm(row.name) === key || norm(row.datasetType) === key) || null;
}

const PICKERS = {
  output: { title: "Select Output Vector", field: "outputType" },
  dfm: { title: "Select DFM", field: "dfmMethod" },
  target: { title: "Select Target Ultimate", field: "targetUltimate" },
};

async function openPicker(kind, anchor) {
  await loadCachedRows().catch(() => {});
  const picker = PICKERS[kind];
  await openDatasetNamePicker({
    projectName: state.project,
    initialName: state.settings[picker.field],
    anchorElement: anchor,
    title: picker.title,
    allowedDataFormats: ["Vector"],
    includeCalculated: true,
    emptyMessage: kind === "dfm" ? "No DFM methods found in this reserving class." : "No cached vector datasets found.",
    itemFilter: (item) => {
      if (kind === "output") return true;
      const record = cachedRecordByName(item?.name);
      if (!record || norm(record.dataFormat) !== "vector") return false;
      if (kind === "dfm") return norm(record.methodType) === "dfm";
      return norm(record.name) !== norm(state.settings.name);
    },
    setStatus: (message) => {
      if (text(message)) postStatus(message, "warn");
    },
    onError: (err) => postStatus(`Error loading dataset names: ${String(err?.message || err)}`, "error"),
    onSelect: (name, item) => {
      const selected = text(name);
      if (!selected) return;
      const record = cachedRecordByName(selected);
      const next = { ...state.settings };
      if (kind === "output") {
        next.outputType = selected;
        next.datasetCategory = text(item?.dataset_category || item?.category || record?.category);
        if (!next.name) next.name = selected;
      } else if (kind === "dfm") {
        // The picker lists the dataset a DFM publishes; the method file is
        // named by the DFM's method name, which the index row carries.
        next.dfmMethod = record?.methodName || selected;
      } else {
        next.targetUltimate = selected;
      }
      state.settings = next;
      renderAll();
      markDirty();
    },
  });
}

/* ---------------------------------------------------------------------------
   Wiring
--------------------------------------------------------------------------- */

function commitNumber(input, key, { integer = false, minimum = 0, maximum = Infinity } = {}) {
  const raw = text(input.value).replaceAll(",", "");
  const n = integer ? Number.parseInt(raw, 10) : Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < minimum || n > maximum) {
    postStatus(`Enter a number from ${minimum} to ${Number.isFinite(maximum) ? maximum.toLocaleString() : "any"}.`, "warn");
    input.value = String(state.settings[key]);
    return;
  }
  if (n !== state.settings[key]) updateSetting(key, n);
  input.value = String(n);
}

function wireNumberInput(input, key, bounds) {
  input.addEventListener("change", () => commitNumber(input, key, bounds));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

function wireInputs() {
  els.nameInput.addEventListener("input", () => {
    state.settings = { ...state.settings, name: text(els.nameInput.value) };
    syncHeader();
    markDirty();
  });
  els.outputTypeBtn.addEventListener("click", () => openPicker("output", els.outputTypeBtn));
  els.dfmBtn.addEventListener("click", () => openPicker("dfm", els.dfmBtn));
  els.targetBtn.addEventListener("click", () => openPicker("target", els.targetBtn));
  els.targetClearBtn.addEventListener("click", () => {
    updateSetting("targetUltimate", "");
    renderSettingsControls();
  });
  els.modelControl.addEventListener("click", (event) => {
    const button = event.target.closest(".bstSegment");
    if (!button || button.disabled || button.dataset.value === state.settings.modelType) return;
    updateSetting("modelType", button.dataset.value);
    renderModelControl();
  });
  bindDropdown(els.residualTypeButton, BST_RESIDUAL_TYPE_OPTIONS, "residualType");
  bindDropdown(els.estimationButton, BST_DISTRIBUTION_OPTIONS, "estimationVariance");
  bindDropdown(els.processButton, BST_DISTRIBUTION_OPTIONS, "processVariance");
  bindDropdown(els.negativeMeanButton, BST_NEGATIVE_MEAN_OPTIONS, "negativeMeanAction");
  bindDropdown(els.odpNegativeMeanButton, BST_ODP_NEGATIVE_MEAN_OPTIONS, "odpNegativeMeanAction");
  wireNumberInput(els.residualSmoothingInput, "residualScaleSmoothing", { minimum: 0 });
  wireNumberInput(els.forecastSmoothingInput, "forecastScaleSmoothing", { minimum: 0 });
  wireNumberInput(els.simulationCountInput, "simulationCount", { integer: true, minimum: 1, maximum: 1000000 });
  wireNumberInput(els.seedInput, "randomSeed", { integer: true, minimum: 0, maximum: 4294967295 });
  els.showScaleInput.addEventListener("change", () => {
    updateSetting("showScaleValues", els.showScaleInput.checked);
    renderResiduals();
  });
  els.preventNegativeInput.addEventListener("change", () => {
    updateSetting("preventNegativeData", els.preventNegativeInput.checked);
  });
  els.newSeedBtn.addEventListener("click", () => {
    updateSetting("randomSeed", newRandomSeed());
    els.seedInput.value = String(state.settings.randomSeed);
  });
  els.residualBody.addEventListener("change", (event) => {
    const input = event.target.closest("[data-user-scale]");
    if (!input) return;
    const key = input.dataset.userScale === "residuals" ? "userScaleValuesResiduals" : "userScaleValuesForecasting";
    const raw = text(input.value).replaceAll(",", "");
    const value = raw === "" ? null : Number(raw);
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      postStatus("A user scale value must be a positive number, or blank.", "warn");
      renderResiduals();
      return;
    }
    const values = state.settings[key].slice();
    values[Number(input.dataset.col)] = value;
    updateSetting(key, values);
  });
  els.targetsBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scaling-row]");
    if (!button) return;
    const row = Number(button.dataset.scalingRow);
    openMenu(button, BST_SCALING_OPTIONS, state.settings.targetScalingMethods[row], (value) => {
      const values = state.settings.targetScalingMethods.slice();
      values[row] = value;
      updateSetting("targetScalingMethods", values);
      renderTargets();
    });
  });
  els.targetsBody.addEventListener("change", (event) => {
    const input = event.target.closest("[data-cv-row]");
    if (!input) return;
    const percent = Number(text(input.value).replace("%", ""));
    if (!Number.isFinite(percent) || percent < 0) {
      postStatus("A coefficient of variation must be zero or more.", "warn");
      renderTargets();
      return;
    }
    const values = state.settings.targetCvs.slice();
    values[Number(input.dataset.cvRow)] = percent / 100;
    updateSetting("targetCvs", values);
  });
  els.saveBtn.addEventListener("click", () => void saveFromUser());
  els.cancelBtn.addEventListener("click", () => void closeOrConfirm());
  window.__arcrho_request_close = () => {
    if (!isDirty) return false;
    if (closeConfirm.isOpen) return true;
    void closeOrConfirm();
    return true;
  };
  window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
}

async function closeOrConfirm() {
  if (isDirty) {
    const discard = await closeConfirm.confirm({ reason: "close" });
    if (!discard) return;
  }
  requestTabbedPageWindowClose({ messageType: "arcrho:dataset-close-confirmed", inst });
}

function wireMessages() {
  window.addEventListener("message", async (event) => {
    const msg = event?.data && typeof event.data === "object" ? event.data : {};
    if (msg.type === "arcrho:dataset-save") {
      await saveFromUser();
    } else if (msg.type === "arcrho:close-active-tab" || msg.type === "arcrho:dataset-close-request") {
      await closeOrConfirm();
    }
  });
}

function initTabbedPage() {
  const requested = text(params.get("tab") || params.get("initial_tab"));
  tabbedPage = createTabbedPage(document.getElementById("bstTabbedPage"), {
    tabs: BOOTSTRAP_TAB_DEFS,
    cssPrefix: "bst",
    initialTab: ALLOWED_TABS.has(requested) ? requested : "details",
    onTabChange: (tabId) => {
      closeMenu();
      if (tabId === "residuals") requestAnimationFrame(() => residualChart?.refresh());
      if (tabId === "results") {
        requestAnimationFrame(() => {
          distributionChart?.refresh();
          fanChart?.refresh();
        });
      }
      try {
        window.parent?.postMessage({ type: "arcrho:bst-tab-changed", inst, tab: tabId }, "*");
      } catch {}
    },
  });
  wireTabPopoutWindows({
    cssPrefix: "bst",
    tabs: BOOTSTRAP_TAB_DEFS,
    tabSystem: () => tabbedPage,
    getTitle: () => `${state.settings.name || BST_METHOD_TYPE} - ${BST_METHOD_TYPE}`,
  });
}

async function init() {
  applyHostFixedDetailsFields({ root: "#bstDetailsPage" });
  for (const root of ["#bstDetailsPage", "#bstSimulationPage"]) {
    syncDetailsLabelWidth({ root, labelSelector: ".arDetailsLabel" });
  }
  els.projectInput.value = state.project;
  els.classInput.value = state.reservingClass;
  state.settings = {
    ...state.settings,
    name: text(params.get("name") || params.get("dataset")),
    outputType: text(params.get("output_type") || params.get("dataset_type")),
    datasetCategory: text(params.get("category")),
    randomSeed: newRandomSeed(),
  };
  residualChart = createResidualChart({ canvas: els.residualChart });
  distributionChart = createDistributionChart({
    canvas: els.distributionChart,
    tooltip: els.distributionTooltip,
    emptyState: els.distributionEmpty,
  });
  fanChart = createFanChart({
    canvas: els.fanChart,
    legend: els.fanLegend,
    tooltip: els.fanTooltip,
    emptyState: els.fanEmpty,
  });
  initTabbedPage();
  wireMenu();
  wireInputs();
  wireResults();
  wireMessages();
  let loaded = false;
  try {
    loaded = await tryLoadExistingMethod();
  } catch (err) {
    postStatus(`Could not load existing Bootstrap: ${String(err?.message || err)}`, "error");
  }
  if (!loaded) renderAll();
  void detailsDependencies.refresh().catch(() => null);
  markClean();
  postStatus(loaded ? "Bootstrap ready." : "New Bootstrap: choose a DFM, then save to run it.");
}

// The window is held blank until the opening tab is rendered; see
// ui/shared/tabbed_page/initial_tab_paint.js.
void init().finally(() => window.arcrhoRevealPage?.());
