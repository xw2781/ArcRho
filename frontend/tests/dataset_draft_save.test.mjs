// A Project Instance "Add > Dataset" draft opens fully prefilled, so no control
// or grid edit happens before the user saves. These tests pin that the draft is
// still save-eligible and that its first save writes the placeholder grid.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function inlineModule(relativePath) {
  return dataUrl(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

const changeWatchUrl = await inlineModule("../ui/shared/tabs/data/data_tab_change_watch_port.js");
const propagationReportUrl = await inlineModule("../ui/shared/tabs/data/data_tab_propagation_report.js");
const temporaryFormatUrl = await inlineModule("../ui/shared/tabs/data/data_tab_temporary_format.js");
const dirtyStateUrl = await inlineModule("../ui/shared/tabs/data/data_tab_dirty_state.js");
const messageBoxUrl = dataUrl("export async function showPageMessageBox(){ return undefined; }");
// The saving animation needs a document; this headless install runs it inert.
const saveProgressUrl = dataUrl(
  "export function createArcRhoSaveProgress(){ return { run: (work) => work({ writing(){}, setMessage(){}, finish(){} }), isVisible: () => false }; }\n"
  + "export async function showSavedDependentsNotice(){}",
);
// The dependent-update poller needs a live server; drafts enqueue no walk.
const propagationJobUrl = dataUrl(
  "export async function trackSavePropagation(){ return null; }",
);

let persistenceSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_persistence_controller.js", import.meta.url),
  "utf8",
);
persistenceSource = persistenceSource
  .replace(/"\/ui\/shared\/tabs\/data\/data_tab_change_watch_port\.js[^"]*"/, JSON.stringify(changeWatchUrl))
  .replace(/"\/ui\/shared\/tabs\/data\/data_tab_propagation_report\.js[^"]*"/, JSON.stringify(propagationReportUrl))
  .replace(/"\/ui\/shared\/tabs\/data\/data_tab_temporary_format\.js[^"]*"/, JSON.stringify(temporaryFormatUrl))
  .replace(/"\/ui\/shared\/tabs\/data\/data_tab_dirty_state\.js[^"]*"/, JSON.stringify(dirtyStateUrl))
  .replace(/"\/ui\/shared\/components\/message_box\/message_box\.js[^"]*"/, JSON.stringify(messageBoxUrl))
  .replace(/"\/ui\/shared\/components\/progress_popup\/save_progress\.js[^"]*"/, JSON.stringify(saveProgressUrl))
  .replace(/"\/ui\/shared\/services\/dependent_propagation_job\.js[^"]*"/, JSON.stringify(propagationJobUrl));
const { registerDataTabPersistenceController } = await import(dataUrl(persistenceSource));

const PROJECT = "NJ_Annual_Prod_202605_Fake";
const RESERVING_CLASS = "PRNJ - PA\\PA\\All States\\Direct Group\\COL";
const DATASET_TYPE = "C 12 - CWP DFM w/ Selected LDFs";

function fakeElement(value = "") {
  return {
    value,
    checked: false,
    disabled: false,
    hidden: false,
    title: "",
    dataset: {},
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    setCustomValidity() {},
    focus() {},
  };
}

function installFakeDom(overrides = {}) {
  const elements = new Map(Object.entries({
    triInput: fakeElement(DATASET_TYPE),
    dsDetailName: fakeElement(DATASET_TYPE),
    projectSelect: fakeElement(PROJECT),
    pathInput: fakeElement(RESERVING_CLASS),
    originLenSelect: fakeElement("12"),
    devLenSelect: fakeElement("12"),
    cumulativeChk: fakeElement(),
    transposedChk: fakeElement(),
    saveBtn: fakeElement(),
    datasetSaveBar: fakeElement(),
    datasetSaveBtn: fakeElement(),
    datasetCancelBtn: fakeElement(),
    runArcRhoTriBtn: fakeElement(),
    clearCacheReloadBtn: fakeElement(),
    dsNotesSaveState: fakeElement(),
    ...overrides,
  }));
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = { parent: { postMessage() {} }, confirm: () => false };
  return elements;
}

function createRuntime({ isProjectInstanceDraft = true, model = null, sidecarSaves = [] } = {}) {
  const state = {
    dirty: new Map(),
    model,
    headerLabels: [],
    devHeaderLabels: [],
    fileMtime: null,
  };
  const saveControlCalls = [];
  const base = {
    state,
    config: {},
    instanceId: "test-inst",
    isProjectInstanceDraft,
    isReadOnlyDatasetViewer: false,
    isTemporaryDatasetView: false,
    savedProjectInstanceDraftName: "",
    currentDatasetSidecarSourceKind: "",
    currentDatasetSidecarDataFormat: "",
    currentDatasetPrecedents: [],
    isSidecarReadOnlyDataset: false,
    datasetSaveInFlight: false,
    datasetInstanceNameConflict: false,
    datasetInstanceNameConflictMessage: "",
    saveControlCalls,
    sidecarSaves,

    // Deferred collaborators the controller reads through `runtime`.
    getResolvedProjectValue: () => PROJECT,
    getResolvedReservingClassValue: () => RESERVING_CLASS,
    getDatasetInstanceNameValue: () => String(document.getElementById("dsDetailName")?.value || ""),
    normalizeDatasetInstanceKey: (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase(),
    normalizeProjectText: (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase(),
    getTriInputs: () => ({
      project: PROJECT,
      path: RESERVING_CLASS,
      tri: DATASET_TYPE,
      instanceName: String(document.getElementById("dsDetailName")?.value || ""),
      originLen: 12,
      devLen: 12,
      cumulative: true,
      transposed: false,
      calendar: false,
    }),
    getProjectInstanceDraftDataFormat: () => "Triangle",
    getDatasetDecimalPlacesValue: () => 0,
    getDatasetSyncedNumberFormatValue: () => "0,000",
    clampDatasetDecimalPlaces: (value) => Number(value) || 0,
    normalizeDatasetNumberFormat: (value) => String(value || "0,000"),
    applyDecimalPlacesToDatasetNumberFormat: (format) => String(format || "0,000"),
    isDfmDataTabHost: () => false,
    isDatasetReadOnly: () => false,
    isInputDefaultBound: () => false,
    loadWorkflowDefaults: () => ({}),
    getDatasetAuditLog: () => null,
    getDataTabLinksController: () => null,
    normalizeDatasetDependencyEntries: (entries) => (Array.isArray(entries) ? entries : []),
    getDatasetTypeFormulaByName: () => "",
    validateDatasetOriginLabels: () => ({ ok: true, labels: ["2020", "2021"] }),
    refreshDatasetInstanceNameConflict: async () => false,
    loadDatasetSidecar: async () => ({ ok: true, data: { exists: false } }),
    saveDatasetSidecar: async (payload) => {
      sidecarSaves.push(payload);
      return { ok: true, data: { source_kind: "input", data_format: "Triangle", ds_id: "arcrhotri_test" } };
    },
    updateTabbedPageSaveControls: (options) => saveControlCalls.push(options),
    createDatasetExternalLinksController: () => ({
      abort() {}, clear() {}, load() {}, markClean() {}, isDirty: () => false,
      serialize: () => [], refreshAll: async () => ({ linkedCellCount: 0, changedCount: 0, failedCount: 0 }),
    }),
  };
  const runtime = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Every remaining collaborator is a UI side effect this test does not assert.
      return () => {};
    },
  });
  registerDataTabPersistenceController(runtime);
  return runtime;
}

function lastSaveControls(runtime) {
  return runtime.saveControlCalls[runtime.saveControlCalls.length - 1] || null;
}

function saveEnabled(runtime) {
  const controls = lastSaveControls(runtime);
  return !!controls && controls.dirty === true && controls.saveBlocked !== true && controls.saving !== true;
}

function draftModel() {
  return {
    id: "draft:test",
    origin_labels: ["2020", "2021"],
    dev_labels: ["12", "24"],
    values: [[0, 0], [0, null]],
    mask: [[true, true], [true, false]],
    data_format: "Triangle",
  };
}

test("an untouched Project Instance draft is save-eligible", async () => {
  installFakeDom();
  const runtime = createRuntime({ model: draftModel() });
  await runtime.syncSidecarForCurrentDataset({ applyLengths: false });

  assert.equal(runtime.isUnsavedProjectInstanceDraft(), true);
  assert.equal(runtime.hasUnsavedDatasetChanges(), false, "tab dirty state stays clean for an untouched draft");
  assert.equal(saveEnabled(runtime), true, "Save must be enabled so the new dataset can be created");
});

test("a draft whose placeholder grid failed to build blocks Save", async () => {
  installFakeDom();
  const runtime = createRuntime({ model: null });
  await runtime.syncSidecarForCurrentDataset({ applyLengths: false });

  assert.equal(lastSaveControls(runtime).saveBlocked, true);
});

test("saving an untouched draft writes the placeholder grid and reports success once", async () => {
  installFakeDom();
  const statuses = [];
  const runtime = createRuntime({ model: draftModel() });
  runtime.setStatus = (text) => statuses.push(String(text ?? ""));
  await runtime.syncSidecarForCurrentDataset({ applyLengths: false });

  const result = await runtime.saveDatasetChanges();
  assert.equal(result.ok, true);
  assert.equal(runtime.sidecarSaves.length, 1, "the draft save must reach the sidecar endpoint");

  const payload = runtime.sidecarSaves[0];
  assert.equal(payload.project_name, PROJECT);
  assert.equal(payload.reserving_class, RESERVING_CLASS);
  assert.equal(payload.dataset_name, DATASET_TYPE);
  assert.equal(payload.source_kind, "input");
  assert.equal(payload.data_format, "Triangle");
  assert.deepEqual(payload.values, [[0, 0], [0, null]]);
  assert.deepEqual(payload.origin_labels, ["2020", "2021"]);
  assert.ok(statuses.includes("Dataset settings saved."));

  assert.equal(runtime.isUnsavedProjectInstanceDraft(), false, "the saved draft name clears the pending save");
  assert.equal(saveEnabled(runtime), false, "Save returns to disabled after the draft is created");
});

test("renaming a saved draft makes it save-eligible again", async () => {
  const elements = installFakeDom();
  const runtime = createRuntime({ model: draftModel() });
  await runtime.syncSidecarForCurrentDataset({ applyLengths: false });
  await runtime.saveDatasetChanges();

  elements.get("dsDetailName").value = "C 12 - Renamed";
  assert.equal(runtime.isUnsavedProjectInstanceDraft(), true);
});

test("a non-draft dataset with no changes still skips the sidecar save", async () => {
  installFakeDom();
  const runtime = createRuntime({ isProjectInstanceDraft: false, model: draftModel() });
  await runtime.syncSidecarForCurrentDataset();

  assert.equal(runtime.isUnsavedProjectInstanceDraft(), false);
  assert.equal(saveEnabled(runtime), false);
  const result = await runtime.saveDatasetChanges();
  assert.equal(result.ok, true);
  assert.equal(runtime.sidecarSaves.length, 0);
});

test("a non-draft refresh marker saves the durable grid even when values are unchanged", async () => {
  installFakeDom();
  const runtime = createRuntime({ isProjectInstanceDraft: false, model: draftModel() });
  runtime.currentDatasetSidecarSourceKind = "input";
  runtime.currentDatasetSidecarDataFormat = "Triangle";
  runtime.state.dirty.set("0,0", runtime.state.model.values[0][0]);

  const result = await runtime.saveDatasetChanges();

  assert.equal(result.ok, true);
  assert.equal(runtime.sidecarSaves.length, 1);
  assert.deepEqual(runtime.sidecarSaves[0].values, [[0, 0], [0, null]]);
  assert.equal(runtime.state.dirty.size, 0);
});
