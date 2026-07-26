import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const helperSource = await readFile(
  new URL("../ui/shared/dataset/dataset_origin_labels.js", import.meta.url),
  "utf8",
);
const originLabelsModuleUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const originLabels = await import(originLabelsModuleUrl);
const headersServiceSource = await readFile(
  new URL("../ui/shared/dataset/dataset_headers_service.js", import.meta.url),
  "utf8",
);
const testableHeadersServiceSource = headersServiceSource.replace(
  /import \{ validateDatasetOriginLabels \} from "\/ui\/shared\/dataset\/dataset_origin_labels\.js";/,
  `import { validateDatasetOriginLabels } from "${originLabelsModuleUrl}";`,
);
const headersServiceModule = await import(
  `data:text/javascript;base64,${Buffer.from(testableHeadersServiceSource).toString("base64")}`
);
const apiSource = await readFile(new URL("../ui/shared/dataset/dataset_api.js", import.meta.url), "utf8");
const testableApiSource = apiSource.replace(
  /import \{ config \} from "\/ui\/shared\/dataset\/dataset_config\.js";/,
  "const config = { API_BASE: '', DS_ID: '' };",
);
const datasetApi = await import(
  `data:text/javascript;base64,${Buffer.from(testableApiSource).toString("base64")}`
);
const runControllerSource = await readFile(
  new URL("../ui/shared/dataset/dataset_run_controller.js", import.meta.url),
  "utf8",
);
const testableRunControllerSource = runControllerSource.replace(
  /import \{ isDfmDataTabHost \} from "\/ui\/shared\/tabs\/data\/data_tab_context\.js";/,
  "const isDfmDataTabHost = () => false;",
);
const runControllerModule = await import(
  `data:text/javascript;base64,${Buffer.from(testableRunControllerSource).toString("base64")}`
);
const dataTabControllerSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_controller.js", import.meta.url),
  "utf8",
);
const dfmTabsOrchestratorSource = await readFile(
  new URL("../ui/method_pages/dfm/dfm_tabs_orchestrator.js", import.meta.url),
  "utf8",
);
const queryInputsSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_query_inputs.js", import.meta.url),
  "utf8",
);
const queryInputsModule = await import(
  `data:text/javascript;base64,${Buffer.from(queryInputsSource).toString("base64")}`
);

test("accepts consecutive origin labels for every supported period length", () => {
  const cases = [
    { originLen: 12, labels: ["2017", "2018"] },
    { originLen: 6, labels: ["2017 H1", "2017H2", "2018 H1"] },
    { originLen: 3, labels: ["2017 Q4", "2018Q1"] },
    { originLen: 1, labels: ["201712", "201801", "Feb 2018"] },
  ];

  for (const item of cases) {
    const result = originLabels.validateDatasetOriginLabels(item.labels, {
      originLen: item.originLen,
      expectedCount: item.labels.length,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.labels, item.labels);
  }
});

test("rejects placeholders, mixed formats, gaps, and row-count mismatches", () => {
  const cases = [
    originLabels.validateDatasetOriginLabels(["1", "2"], { originLen: 12 }),
    originLabels.validateDatasetOriginLabels(["2017", "2018 H1"], {}),
    originLabels.validateDatasetOriginLabels(["2017", "2019"], { originLen: 12 }),
    originLabels.validateDatasetOriginLabels(["2017", "2018"], { originLen: 12, expectedCount: 3 }),
  ];

  for (const result of cases) assert.equal(result.ok, false);
  assert.equal(
    originLabels.validateDatasetOriginLabels(["2017", "2018"], {
      originLen: 6,
      requireMatchingPeriod: true,
    }).ok,
    false,
  );
});

test("surfaces ArcRho header failures with an actionable project-settings message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, status: "timeout" }),
  });
  try {
    await assert.rejects(
      originLabels.fetchDatasetOriginLabels("Example Project", 12),
      /Cannot load origin labels for project 'Example Project'.*timeout/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("late origin-header responses cannot overwrite the newest validated labels", async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.document = {
    getElementById: (id) => ({ value: id === "originLenSelect" ? "12" : "12" }),
    querySelector: () => ({ checked: false }),
  };
  globalThis.localStorage = {
    getItem: (key) => storage.get(String(key)) ?? null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
  };
  let resolveFirst;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, labels: ["2022", "2023"] }),
    };
  };
  const state = { headerLabels: [], devHeaderLabels: [] };
  const service = headersServiceModule.createDatasetHeadersService({ state, setStatus: () => {} });
  try {
    const first = service.ensureHeadersForProject("Example Project", { forceRefresh: true });
    const second = await service.ensureHeadersForProject("Example Project", { forceRefresh: true });
    resolveFirst({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, labels: ["2020", "2021"] }),
    });
    await first;
    assert.deepEqual(second, ["2022", "2023"]);
    assert.deepEqual(state.headerLabels, ["2022", "2023"]);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("dataset API sends the encoded dataset, project, and origin length", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ id: "dataset" }) };
  };
  try {
    const result = await datasetApi.getDataset("paid / reported", {
      projectName: "Example & Project",
      originLength: 3,
    });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const parsed = new URL(requestedUrl, "http://arcrho.test");
  assert.equal(parsed.pathname, "/dataset/paid%20%2F%20reported");
  assert.equal(parsed.searchParams.get("project_name"), "Example & Project");
  assert.equal(parsed.searchParams.get("origin_length"), "3");
  assert.equal(parsed.searchParams.has("start_year"), false);
});

test("DFM URL aliases initialize the shared dataset input owner", () => {
  const values = queryInputsModule.readDatasetInputQueryValues(
    "?project=Example%20Project&class=LOB%5CState&method_name=Paid%20DFM&input_triangle=Paid%20Loss",
  );
  assert.equal(values.project, "Example Project");
  assert.equal(values.path, "LOB\\State");
  assert.equal(values.methodName, "Paid DFM");
  assert.equal(values.tri, "Paid Loss");
  assert.match(dataTabControllerSource, /readDatasetInputQueryValues\(qs\)/);
  assert.match(dfmTabsOrchestratorSource, /readDatasetInputQueryValues\(_qs\)/);
});

test("Dataset Viewer paints backend labels without waiting for development headers", async () => {
  const originalDocument = globalThis.document;
  const tableWrap = { replaceChildren() {} };
  const dsMeta = { textContent: "" };
  globalThis.document = {
    createElement: () => ({ style: {}, append() {} }),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: () => ({ value: "" }),
  };
  const inputs = {
    project: "Example Project",
    path: "Example Path",
    tri: "Example Dataset",
    instanceName: "Example Dataset",
    cumulative: true,
    calendar: false,
    originLen: 12,
    devLen: 12,
  };
  const state = {
    dirty: new Map(),
    model: null,
    fileMtime: null,
    headerLabels: [],
    devHeaderLabels: [],
  };
  const headerStarts = [];
  let releaseDevelopmentHeaders;
  const developmentHeadersReady = new Promise((resolve) => { releaseDevelopmentHeaders = resolve; });
  let datasetRequestCount = 0;
  const renderedDevelopmentLabels = [];
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "dataset-id" },
    state,
    $: (id) => (id === "tableWrap" ? tableWrap : dsMeta),
    logLine: () => {},
    getDataset: async () => {
      datasetRequestCount += 1;
      return {
        ok: true,
        status: 200,
        data: {
          id: "dataset-id",
          mtime: 2,
          origin_labels: ["2020", "2021"],
          dev_labels: ["12"],
          values: [[1], [2]],
          mask: [[true], [true]],
        },
      };
    },
    patchDataset: async () => ({}),
    renderTable: () => {
      renderedDevelopmentLabels.push([...(state.model?.dev_labels || [])]);
    },
    renderChart: () => {},
    notifyDatasetUpdated: () => {},
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: () => ({}),
    getTriInputs: () => inputs,
    buildTriRequestPayload: () => ({}),
    buildVecRequestPayload: () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: () => {
      throw new Error("origin labels must come from the authoritative dataset response");
    },
    ensureDevHeadersForProject: (_project, options) => {
      assert.equal(options.forceRefresh, undefined);
      assert.equal(options.isCurrent(), true);
      headerStarts.push("development");
      return developmentHeadersReady;
    },
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async () => true,
    syncSidecarForCurrentDataset: async () => true,
    updateCurrentTabTitle: () => "",
    setStatus: () => {},
    applyGridSelectionFromState: () => {},
  });

  let loadTimeout = null;
  try {
    const loadPromise = controller.loadDataset();
    await Promise.resolve();
    assert.deepEqual(headerStarts, ["development"]);
    assert.equal(datasetRequestCount, 1);
    const result = await Promise.race([
      loadPromise,
      new Promise((_, reject) => {
        loadTimeout = setTimeout(
          () => reject(new Error("dataset load waited for development headers")),
          500,
        );
      }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(datasetRequestCount, 1);
    assert.deepEqual(state.model.dev_labels, ["12"]);
    assert.deepEqual(renderedDevelopmentLabels, [["12"]]);

    releaseDevelopmentHeaders(["6", "12"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(state.model.dev_labels, ["6", "12"]);
    assert.deepEqual(renderedDevelopmentLabels, [["12"], ["6", "12"]]);
  } finally {
    if (loadTimeout !== null) clearTimeout(loadTimeout);
    releaseDevelopmentHeaders([]);
    globalThis.document = originalDocument;
  }
});

test("Dataset run replaces the duplicate precheck with a delayed loading indicator", () => {
  assert.doesNotMatch(runControllerSource, /precheckArcRho(?:Tri|Vec)Csv/);
  assert.match(runControllerSource, /const DEFAULT_LOADING_POPUP_DELAY_MS = 300/);
  assert.match(runControllerSource, /scheduleDelayedLoadingPopup\(\)/);
  assert.match(runControllerSource, /finally \{\s*cancelDelayedLoadingPopup\(\);\s*hideLoadingPopup\(\);/);
});

test("a stale deferred validation queues and publishes only the latest dataset run", async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const elements = {
    runArcRhoTriBtn: { disabled: false },
    clearCacheReloadBtn: { disabled: false },
    arcrhoTriStatus: { textContent: "" },
  };
  globalThis.document = {
    getElementById: (id) => elements[id] || { value: "" },
  };
  const oldInputs = {
    project: "Example Project",
    path: "Old Class",
    tri: "Old Dataset",
    instanceName: "Old Dataset",
    cumulative: true,
    calendar: false,
    originLen: 12,
    devLen: 12,
  };
  const newInputs = {
    ...oldInputs,
    path: "New Class",
    tri: "New Dataset",
    instanceName: "New Dataset",
  };
  let currentInputs = oldInputs;
  let releaseFirstValidation;
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  let validationCount = 0;
  const requestPayloads = [];
  const requestUrls = [];
  globalThis.fetch = async (url, options) => {
    requestUrls.push(String(url));
    requestPayloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, message: "Expected test stop." }),
    };
  };
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "" },
    state: { dirty: new Map(), model: null },
    $: () => ({ textContent: "", replaceChildren() {} }),
    logLine: () => {},
    getDataset: async () => assert.fail("test response must stop before dataset loading"),
    patchDataset: async () => ({}),
    renderTable: () => {},
    renderChart: () => {},
    notifyDatasetUpdated: () => {},
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: async () => {
      validationCount += 1;
      if (validationCount === 1) {
        markValidationStarted();
        return new Promise((resolve) => { releaseFirstValidation = resolve; });
      }
      return {
        ok: true,
        project: currentInputs.project,
        path: currentInputs.path,
        tri: currentInputs.tri,
      };
    },
    getTriInputs: () => ({ ...currentInputs }),
    buildTriRequestPayload: (inputs) => ({ ...inputs }),
    buildVecRequestPayload: (inputs) => ({ ...inputs }),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async () => true,
    syncSidecarForCurrentDataset: async () => true,
    updateCurrentTabTitle: () => "",
    setStatus: () => {},
    applyGridSelectionFromState: () => {},
    suppressLoadingPopup: true,
  });

  try {
    const firstRun = controller.runArcRhoTri();
    await validationStarted;
    assert.equal(elements.runArcRhoTriBtn.disabled, true);
    assert.equal(elements.arcrhoTriStatus.textContent, "Validating inputs...");

    currentInputs = newInputs;
    const queuedResult = await controller.runArcRhoTri({ clearCache: true });
    assert.equal(queuedResult.queued, true);
    releaseFirstValidation({
      ok: true,
      project: oldInputs.project,
      path: oldInputs.path,
      tri: oldInputs.tri,
    });
    const firstResult = await firstRun;
    assert.equal(firstResult.stale, true);
    assert.equal(requestPayloads.length, 0);

    const deadline = Date.now() + 500;
    while (requestPayloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(requestPayloads.length, 1);
    assert.equal(requestUrls[0], "/arcrho/tri/refresh");
    assert.equal(requestPayloads[0].path, "New Class");
    assert.equal(requestPayloads[0].tri, "New Dataset");
    assert.equal(validationCount, 2);
    while (controller.isRunInFlight() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test("DFM refresh delegates header and dataset ownership to the run controller", () => {
  const refreshStart = dataTabControllerSource.indexOf("async function refreshDfmDatasetForCurrentInputs");
  const refreshEnd = dataTabControllerSource.indexOf("if (isDfmDataTabHost())", refreshStart);
  assert.notEqual(refreshStart, -1);
  assert.notEqual(refreshEnd, -1);
  const refreshSource = dataTabControllerSource.slice(refreshStart, refreshEnd);
  assert.doesNotMatch(refreshSource, /ensure(?:Dev)?HeadersForProject/);
  assert.match(refreshSource, /return runArcRhoTri/);
});

test("Result Selection materializes an engine source with one authoritative request", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const materializeStart = source.indexOf("async function materializeEngineSourceAtLength");
  const loadStart = source.indexOf("async function loadMaterializedEngineDatasetPayload", materializeStart);
  assert.notEqual(materializeStart, -1);
  assert.notEqual(loadStart, -1);
  const materializeSource = source.slice(materializeStart, loadStart);
  assert.doesNotMatch(materializeSource, /\/precheck/);
  assert.match(materializeSource, /const resp = await fetch\(routeRoot,/);
});

test("Dataset boot schedules auto-run without forced header refreshes", () => {
  const bootStart = dataTabControllerSource.indexOf("export async function bootDatasetDataTab()");
  assert.notEqual(bootStart, -1);
  const bootSource = dataTabControllerSource.slice(bootStart);
  assert.doesNotMatch(
    bootSource,
    /await ensure(?:Dev)?HeadersForProject\(project,\s*\{\s*forceRefresh:\s*true\s*\}\)/,
  );
  assert.match(bootSource, /scheduleAutoRun\(0\)/);
});

test("Dataset Viewer renders backend label errors and invalidates stale data", async () => {
  const originalDocument = globalThis.document;
  const tableWrap = { children: [], replaceChildren(...children) { this.children = children; } };
  const dsMeta = { textContent: "old metadata" };
  globalThis.document = {
    createElement: () => ({
      style: {},
      children: [],
      textContent: "",
      append(...children) { this.children.push(...children); },
    }),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  const state = {
    dirty: new Map([["0,0", 10]]),
    model: { id: "old-dataset" },
    fileMtime: 1,
    headerLabels: ["2019"],
  };
  let statusText = "";
  let chartRenderCount = 0;
  let updateOptions = null;
  const detail = "Origin Start Date is missing or invalid.";
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "dataset-id" },
    state,
    $: (id) => (id === "tableWrap" ? tableWrap : dsMeta),
    logLine: () => {},
    getDataset: async (_id, options) => {
      assert.deepEqual(options, { projectName: "Example Project", originLength: 12 });
      return { ok: false, status: 422, data: { detail } };
    },
    patchDataset: async () => ({}),
    renderTable: () => {},
    renderChart: () => { chartRenderCount += 1; },
    notifyDatasetUpdated: (options) => { updateOptions = options; },
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: () => ({}),
    getTriInputs: () => ({ project: "Example Project", originLen: 12 }),
    buildTriRequestPayload: () => ({}),
    buildVecRequestPayload: () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => assert.fail("failed loads must not persist a dataset id"),
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async () => {},
    syncSidecarForCurrentDataset: async () => {},
    updateCurrentTabTitle: () => "",
    setStatus: (value) => { statusText = value; },
    applyGridSelectionFromState: () => {},
  });
  let result;
  try {
    result = await controller.loadDataset();
  } finally {
    globalThis.document = originalDocument;
  }

  assert.equal(statusText, detail);
  assert.equal(result.ok, false);
  assert.equal(state.model, null);
  assert.equal(state.fileMtime, null);
  assert.deepEqual(state.headerLabels, []);
  assert.equal(state.dirty.size, 1);
  assert.equal(chartRenderCount, 1);
  assert.deepEqual(updateOptions, { publishPreview: false });
  assert.equal(tableWrap.children[0].children[1].textContent, detail);
});

test("an older dataset response cannot restore data after a newer load fails", async () => {
  const originalDocument = globalThis.document;
  const tableWrap = { children: [], replaceChildren(...children) { this.children = children; } };
  const dsMeta = { textContent: "old metadata" };
  globalThis.document = {
    createElement: () => ({
      style: {},
      children: [],
      textContent: "",
      append(...children) { this.children.push(...children); },
    }),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  const state = {
    dirty: new Map(),
    model: { id: "old-dataset" },
    fileMtime: 1,
    headerLabels: ["2019"],
    devHeaderLabels: [],
  };
  let resolveOlderRequest;
  let markOlderRequestStarted;
  const olderRequestStarted = new Promise((resolve) => { markOlderRequestStarted = resolve; });
  let requestCount = 0;
  let updateCount = 0;
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "dataset-id" },
    state,
    $: (id) => (id === "tableWrap" ? tableWrap : dsMeta),
    logLine: () => {},
    getDataset: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        markOlderRequestStarted();
        return new Promise((resolve) => { resolveOlderRequest = resolve; });
      }
      return { ok: false, status: 422, data: { detail: "Origin Start Date is invalid." } };
    },
    patchDataset: async () => ({}),
    renderTable: () => {},
    renderChart: () => {},
    notifyDatasetUpdated: () => { updateCount += 1; },
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: () => ({}),
    getTriInputs: () => ({ project: "Example Project", originLen: 12 }),
    buildTriRequestPayload: () => ({}),
    buildVecRequestPayload: () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => assert.fail("failed or stale loads must not persist a dataset id"),
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async () => {},
    syncSidecarForCurrentDataset: async () => {},
    updateCurrentTabTitle: () => "",
    setStatus: () => {},
    applyGridSelectionFromState: () => {},
  });
  try {
    const olderLoad = controller.loadDataset();
    await olderRequestStarted;
    const newerResult = await controller.loadDataset();
    resolveOlderRequest({
      ok: true,
      status: 200,
      data: {
        id: "stale-dataset",
        mtime: 2,
        origin_labels: ["2020", "2021"],
        dev_labels: ["12"],
        values: [[1], [2]],
        mask: [[true], [true]],
      },
    });
    const olderResult = await olderLoad;
    assert.equal(newerResult.ok, false);
    assert.equal(olderResult.stale, true);
    assert.equal(state.model, null);
    assert.equal(updateCount, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("a stale notes sync cannot hide a newer origin-label failure", async () => {
  const originalDocument = globalThis.document;
  const tableWrap = { children: [], replaceChildren(...children) { this.children = children; } };
  const dsMeta = { textContent: "old metadata" };
  globalThis.document = {
    createElement: () => ({
      style: {},
      children: [],
      textContent: "",
      append(...children) { this.children.push(...children); },
    }),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: () => ({ value: "" }),
  };
  const state = {
    dirty: new Map(),
    model: null,
    fileMtime: null,
    headerLabels: [],
    devHeaderLabels: [],
  };
  let requestCount = 0;
  let releaseSidecarSync;
  let markSidecarSyncStarted;
  const sidecarSyncStarted = new Promise((resolve) => { markSidecarSyncStarted = resolve; });
  const sidecarSyncRelease = new Promise((resolve) => { releaseSidecarSync = resolve; });
  let statusText = "";
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "dataset-id" },
    state,
    $: (id) => (id === "tableWrap" ? tableWrap : dsMeta),
    logLine: () => {},
    getDataset: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: true,
          status: 200,
          data: {
            id: "older-success",
            mtime: 2,
            origin_labels: ["2020", "2021"],
            dev_labels: ["12"],
            values: [[1], [2]],
            mask: [[true], [true]],
          },
        };
      }
      return { ok: false, status: 422, data: { detail: "Origin Start Date is invalid." } };
    },
    patchDataset: async () => ({}),
    renderTable: () => {},
    renderChart: () => {},
    notifyDatasetUpdated: () => {},
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: () => ({}),
    getTriInputs: () => ({
      project: "Example Project",
      path: "Example Path",
      tri: "Example Dataset",
      instanceName: "Example Dataset",
      cumulative: true,
      calendar: false,
      originLen: 12,
      devLen: 12,
    }),
    buildTriRequestPayload: () => ({}),
    buildVecRequestPayload: () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncSidecarForCurrentDataset: async ({ isCurrent, forceReload }) => {
      assert.equal(forceReload, true);
      markSidecarSyncStarted();
      await sidecarSyncRelease;
      assert.equal(isCurrent(), false);
    },
    updateCurrentTabTitle: () => "",
    setStatus: (value) => { statusText = value; },
    applyGridSelectionFromState: () => {},
  });
  try {
    const olderLoad = controller.loadDataset();
    await sidecarSyncStarted;
    const newerResult = await controller.loadDataset();
    releaseSidecarSync();
    const olderResult = await olderLoad;
    assert.equal(newerResult.ok, false);
    assert.equal(olderResult.stale, true);
    assert.equal(state.model, null);
    assert.equal(dsMeta.textContent, "");
    assert.equal(statusText, "Origin Start Date is invalid.");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("a blocked sidecar sync keeps its actionable status instead of reporting Ready", async () => {
  const originalDocument = globalThis.document;
  const tableWrap = { replaceChildren() {} };
  const dsMeta = { textContent: "old metadata" };
  globalThis.document = {
    createElement: () => ({ style: {}, append() {} }),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  const state = {
    dirty: new Map(),
    model: null,
    fileMtime: null,
    headerLabels: [],
    devHeaderLabels: [],
  };
  let statusText = "";
  let sidecarSyncCount = 0;
  const controller = runControllerModule.createDatasetRunController({
    config: { API_BASE: "", DS_ID: "dataset-id" },
    state,
    $: (id) => (id === "tableWrap" ? tableWrap : dsMeta),
    logLine: () => {},
    getDataset: async () => ({
      ok: true,
      status: 200,
      data: {
        id: "dataset-id",
        mtime: 2,
        origin_labels: ["2020", "2021"],
        dev_labels: ["12"],
        values: [[1], [2]],
        mask: [[true], [true]],
      },
    }),
    patchDataset: async () => ({}),
    renderTable: () => {},
    renderChart: () => {},
    notifyDatasetUpdated: () => {},
    isForceRebuildEnabled: () => false,
    validateTriInputsBeforeRun: () => ({}),
    getTriInputs: () => ({ project: "Example Project", originLen: 12 }),
    buildTriRequestPayload: () => ({}),
    buildVecRequestPayload: () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncSidecarForCurrentDataset: async () => {
      sidecarSyncCount += 1;
      statusText = "Notes changed while saving. Save the latest notes before switching datasets.";
      return false;
    },
    updateCurrentTabTitle: () => "",
    setStatus: (value) => { statusText = value; },
    applyGridSelectionFromState: () => {},
  });
  try {
    const result = await controller.loadDataset();
    assert.equal(result.ok, false);
    assert.equal(result.contextSyncFailed, true);
    assert.equal(sidecarSyncCount, 1);
    assert.equal(dsMeta.textContent, "");
    assert.match(statusText, /Notes changed while saving/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("dataset sources contain no hard-coded start-year fallback", async () => {
  const sourceUrls = [
    "../ui/shared/dataset/dataset_config.js",
    "../ui/shared/dataset/dataset_api.js",
    "../app_server/api/dataset_router.py",
    "../app_server/services/dataset_service.py",
    "../app_server/services/arcrho_runtime_service.py",
    "../ui/shared/tabs/data/data_tab_controller.js",
    "../ui/shared/dataset/dataset_headers_service.js",
    "../ui/shared/dataset/dataset_run_controller.js",
    "../ui/method_pages/dfm/dfm_results_tab.js",
    "../ui/method_pages/result_selection/result_selection_data.js",
    "../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
  ];
  const sources = await Promise.all(sourceUrls.map((url) => readFile(new URL(url, import.meta.url), "utf8")));
  const combined = sources.join("\n");

  const hardCodedFallbackPatterns = [
    /\b2016\b/,
    /\bSTART_YEAR\s*:/,
    /\bstart_year\s*:\s*int\s*=/,
    /\b(?:const|let|var)\s+startYear\s*=\s*\d{4}\b/,
    /\b(?:fallbackOriginLabel|generatedOriginLabel)\b/,
  ];
  for (const pattern of hardCodedFallbackPatterns) assert.doesNotMatch(combined, pattern);
  assert.match(sources[1], /project_name/);
  assert.match(sources[1], /origin_length/);
  assert.match(sources[5], /validateDatasetOriginLabels/);
  assert.doesNotMatch(sources[5], /values\.map\(\(_, index\) => String\(index \+ 1\)\)/);
  assert.match(sources[5], /Cannot apply live source preview/);
});
