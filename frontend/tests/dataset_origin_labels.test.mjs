import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const helperSource = await readFile(
  new URL("../ui/dataset/dataset_origin_labels.js", import.meta.url),
  "utf8",
);
const originLabelsModuleUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const originLabels = await import(originLabelsModuleUrl);
const headersServiceSource = await readFile(
  new URL("../ui/dataset/dataset_headers_service.js", import.meta.url),
  "utf8",
);
const testableHeadersServiceSource = headersServiceSource.replace(
  /import \{ validateDatasetOriginLabels \} from "\/ui\/dataset\/dataset_origin_labels\.js";/,
  `import { validateDatasetOriginLabels } from "${originLabelsModuleUrl}";`,
);
const headersServiceModule = await import(
  `data:text/javascript;base64,${Buffer.from(testableHeadersServiceSource).toString("base64")}`
);
const apiSource = await readFile(new URL("../ui/shared/api.js", import.meta.url), "utf8");
const testableApiSource = apiSource.replace(
  /import \{ config \} from "\/ui\/shared\/config\.js";/,
  "const config = { API_BASE: '', DS_ID: '' };",
);
const datasetApi = await import(
  `data:text/javascript;base64,${Buffer.from(testableApiSource).toString("base64")}`
);
const runControllerSource = await readFile(
  new URL("../ui/dataset/dataset_run_controller.js", import.meta.url),
  "utf8",
);
const runControllerModule = await import(
  `data:text/javascript;base64,${Buffer.from(runControllerSource).toString("base64")}`
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
    precheckArcRhoTriCsv: async () => ({}),
    precheckArcRhoVecCsv: async () => ({}),
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
    precheckArcRhoTriCsv: async () => ({}),
    precheckArcRhoVecCsv: async () => ({}),
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
  const originalWindow = globalThis.window;
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
  globalThis.window = { ADA_DFM_CONTEXT: false };
  const state = {
    dirty: new Map(),
    model: null,
    fileMtime: null,
    headerLabels: [],
    devHeaderLabels: [],
  };
  let requestCount = 0;
  let releaseNotesSync;
  let markNotesSyncStarted;
  const notesSyncStarted = new Promise((resolve) => { markNotesSyncStarted = resolve; });
  const notesSyncRelease = new Promise((resolve) => { releaseNotesSync = resolve; });
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
    precheckArcRhoTriCsv: async () => ({}),
    precheckArcRhoVecCsv: async () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async ({ isCurrent, forceReload }) => {
      assert.equal(forceReload, true);
      markNotesSyncStarted();
      await notesSyncRelease;
      assert.equal(isCurrent(), false);
    },
    syncSidecarForCurrentDataset: async () => {},
    updateCurrentTabTitle: () => "",
    setStatus: (value) => { statusText = value; },
    applyGridSelectionFromState: () => {},
  });
  try {
    const olderLoad = controller.loadDataset();
    await notesSyncStarted;
    const newerResult = await controller.loadDataset();
    releaseNotesSync();
    const olderResult = await olderLoad;
    assert.equal(newerResult.ok, false);
    assert.equal(olderResult.stale, true);
    assert.equal(state.model, null);
    assert.equal(dsMeta.textContent, "");
    assert.equal(statusText, "Origin Start Date is invalid.");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("a blocked notes sync keeps its actionable status instead of reporting Ready", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const tableWrap = { replaceChildren() {} };
  const dsMeta = { textContent: "old metadata" };
  globalThis.document = {
    createElement: () => ({ style: {}, append() {} }),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  globalThis.window = { ADA_DFM_CONTEXT: false };
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
    precheckArcRhoTriCsv: async () => ({}),
    precheckArcRhoVecCsv: async () => ({}),
    clearHeadersCacheForProject: async () => {},
    ensureHeadersForProject: async () => {},
    ensureDevHeadersForProject: async () => {},
    saveLastDsId: () => {},
    recordDatasetBrowsingHistory: () => {},
    syncNotesForCurrentDataset: async () => {
      statusText = "Notes changed while saving. Save the latest notes before switching datasets.";
      return false;
    },
    syncSidecarForCurrentDataset: async () => { sidecarSyncCount += 1; return true; },
    updateCurrentTabTitle: () => "",
    setStatus: (value) => { statusText = value; },
    applyGridSelectionFromState: () => {},
  });
  try {
    const result = await controller.loadDataset();
    assert.equal(result.ok, false);
    assert.equal(result.contextSyncFailed, true);
    assert.equal(sidecarSyncCount, 0);
    assert.equal(dsMeta.textContent, "");
    assert.match(statusText, /Notes changed while saving/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("dataset sources contain no hard-coded start-year fallback", async () => {
  const sourceUrls = [
    "../ui/shared/config.js",
    "../ui/shared/api.js",
    "../app_server/api/dataset_router.py",
    "../app_server/services/dataset_service.py",
    "../app_server/services/arcrho_runtime_service.py",
    "../ui/dataset/dataset_main.js",
    "../ui/dataset/dataset_headers_service.js",
    "../ui/dataset/dataset_run_controller.js",
    "../ui/dfm/dfm_results_tab.js",
    "../ui/result_selection/result_selection_data.js",
    "../ui/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
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
