import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tableSource = await readFile(
  new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url),
  "utf8",
);
// The module is imported from a data: URL, which cannot resolve the app's
// absolute "/ui/..." specifiers, so every browser-only import is stubbed here.
const testableSource = tableSource
  .replace(
    /^import \{ openDatasetNamePicker \} from .*;\s*/mu,
    "const openDatasetNamePicker = async () => null;\n",
  )
  .replace(
    /^import \{[\s\S]*?\} from "\/ui\/shared\/dataset\/berquist_sherman_contract\.js";\s*/mu,
    [
      "const BERQUIST_SHERMAN_VARIANTS = [];",
      "const berquistShermanDisplayLabel = () => \"\";",
      "const getBerquistShermanContract = () => null;",
      "const normalizeBerquistShermanVariant = (value) => value;",
      "",
    ].join("\n"),
  );
const { installProjectInstanceDatasetTable } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);

function createHarness(deleteResponse) {
  const requests = [];
  const statuses = [];
  const applied = [];
  const state = {
    selectedPath: "Direct Group/COLL",
    datasetRows: [],
    datasetTableVisibleRecords: [],
    datasetDeleteConfirmResolve: null,
    datasetTablePreferenceWidthKeys: new Set(),
    datasetTableView: { filters: new Map(), collapsedGroups: new Set(), groupBy: [] },
    cachedDatasetFilter: { loading: false, names: new Set(), instanceRows: [] },
    datasetTableSelection: { selectedKeys: new Set(), anchorKey: "" },
    datasetIndexWatch: { pending: true, suppressUntil: 0 },
  };
  // renderDatasetTable returns early without a table surface, so the harness
  // exercises the delete flow rather than the DOM.
  const els = {};
  const loadingEvents = [];
  const api = {
    beginPageLoading: (task, labels) => loadingEvents.push({ began: task, labels }),
    finishPageLoading: (task) => loadingEvents.push({ finished: task }),
    focusProjectInstancePage: () => {},
    getCachedDatasetKey: (value) => String(value || "").trim().toLowerCase(),
    hasCachedDatasetMetadataForSelectedPath: () => true,
    isDatasetRecordCached: () => true,
    isTemporaryDatasetView: () => false,
    normalizeLookupKey: (value) => String(value || "").trim().toLowerCase(),
    normalizePath: (value) => String(value || "").trim(),
    postProjectInstanceStatus: () => {},
    setStatus: (message, isError = false) => statuses.push({ message, isError }),
    shouldUseCachedDatasetFilter: () => true,
    syncCachedDatasetToolbar: () => {},
    toText: (value) => String(value ?? "").trim(),
    applyCachedDatasetSnapshot: (payload, path) => applied.push({ payload, path }),
    loadCachedDatasetFilterForSelectedPath: async () => {
      requests.push({ url: "/datasets/cached", method: "GET" });
    },
  };
  installProjectInstanceDatasetTable({
    api,
    els,
    projectName: "PI delete test",
    state,
    constants: {
      DATASET_TABLE_COLUMNS: [],
      DATASET_COLUMNS: [],
      DATASET_TABLE_DEFAULT_WIDTHS: {},
      DATASET_TABLE_AUTOFIT_MAX_WIDTH: 400,
      DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH: 0,
      DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH: 0,
      DATASET_TABLE_BLANK_LABEL: "(Blank)",
    },
    fetchProjectDatasetTypes: async () => [],
    loadProjectUserPreferences: async () => ({}),
    scheduleProjectUserPreferencesSave: () => {},
  });

  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { ADAHost: {}, location: { origin: "http://127.0.0.1:28765" } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method || "GET" });
    return { ok: true, status: 200, async json() { return deleteResponse; } };
  };

  return {
    api,
    applied,
    loadingEvents,
    requests,
    restoreGlobals() {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
    state,
    statuses,
    async runDelete() {
      const pending = this.api.deleteSelectedDatasetRows([{ datasetName: "Paid Loss" }]);
      await Promise.resolve();
      this.api.resolveDatasetDeleteConfirm(true);
      await pending;
    },
  };
}

test("a delete applies the index it already received instead of re-reading it", async () => {
  const index = {
    ok: true,
    files: [{ name: "Reported Loss", method_type: "None" }],
    folder_signature: "sha256:abc",
    index_persisted: true,
  };
  const harness = createHarness({ ok: true, deleted_count: 2, index });

  try {
    await harness.runDelete();

    assert.deepEqual(
      harness.requests,
      [{ url: "/datasets/cached/delete", method: "POST" }],
      "the delete response carries the rebuilt index, so no second read is due",
    );
    assert.equal(harness.applied.length, 1);
    assert.equal(harness.applied[0].payload, index);
    assert.equal(harness.applied[0].path, "Direct Group/COLL");
    assert.equal(harness.state.datasetIndexWatch.pending, false);
    assert.ok(harness.state.datasetIndexWatch.suppressUntil > 0);
    assert.equal(harness.statuses.at(-1).message, "Deleted 2 cached files.");
  } finally {
    harness.restoreGlobals();
  }
});

test("a delete shows the shared loading spinner for as long as it runs", async () => {
  const harness = createHarness({
    ok: true,
    deleted_count: 1,
    index: { ok: true, files: [] },
  });

  try {
    await harness.runDelete();

    assert.deepEqual(harness.loadingEvents, [
      {
        began: "delete-datasets",
        labels: {
          title: "Deleting cached files",
          message: "Removing cached files for Paid Loss and rebuilding the dataset index...",
        },
      },
      { finished: "delete-datasets" },
    ]);
  } finally {
    harness.restoreGlobals();
  }
});

test("a failed delete still clears the loading spinner", async () => {
  const harness = createHarness({ ok: false, detail: "Cached dataset file is locked." });

  try {
    await harness.runDelete();

    assert.deepEqual(harness.loadingEvents.at(-1), { finished: "delete-datasets" });
    assert.deepEqual(harness.statuses.at(-1), {
      message: "Cached dataset file is locked.",
      isError: true,
    });
  } finally {
    harness.restoreGlobals();
  }
});

test("a cancelled confirmation never opens the spinner", async () => {
  const harness = createHarness({ ok: true, deleted_count: 0, index: { ok: true, files: [] } });

  try {
    const pending = harness.api.deleteSelectedDatasetRows([{ datasetName: "Paid Loss" }]);
    await Promise.resolve();
    harness.api.resolveDatasetDeleteConfirm(false);
    await pending;

    assert.deepEqual(harness.loadingEvents, []);
    assert.deepEqual(harness.requests, []);
  } finally {
    harness.restoreGlobals();
  }
});

test("a delete without a usable index falls back to reloading the table", async () => {
  const harness = createHarness({ ok: true, deleted_count: 1, index: {} });

  try {
    await harness.runDelete();

    assert.deepEqual(harness.requests, [
      { url: "/datasets/cached/delete", method: "POST" },
      { url: "/datasets/cached", method: "GET" },
    ]);
    assert.equal(harness.applied.length, 0);
    assert.equal(harness.statuses.at(-1).message, "Deleted 1 cached file.");
  } finally {
    harness.restoreGlobals();
  }
});
