import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cacheSource = await readFile(
  new URL("../ui/project_instance/project_instance_dataset_cache.js", import.meta.url),
  "utf8",
);
// The module is imported from a data: URL, which cannot resolve the app's
// absolute "/ui/..." specifiers, so every browser-only import is stubbed here.
const testableSource = cacheSource
  .replace(
    /^import \{ attachArcrhoTooltip \} from .*;\s*/u,
    "const attachArcrhoTooltip = () => {};\n",
  )
  .replace(
    /^import \{ publishProjectInstanceDatasetSnapshot \} from .*;\s*/mu,
    "const publishProjectInstanceDatasetSnapshot = () => true;\n",
  );
const { installProjectInstanceDatasetCache } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);

function createStatusElement() {
  const attributes = new Map();
  return {
    textContent: "",
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
  };
}

function createHarness(payload) {
  const statuses = [];
  const cachedDatasetStatus = createStatusElement();
  const state = {
    selectedPath: "Direct Group/COLL",
    datasetViewMode: "normal",
    cachedDatasetFilter: {
      loading: false,
      loadedPath: "",
      names: new Set(),
      instanceRows: [],
      metadataByName: new Map(),
      methodTypesByName: new Map(),
      visibleCount: 0,
      error: "",
      warning: "",
      requestSeq: 0,
    },
    cachedDatasetSnapshotRequests: new Map(),
    datasetIndexWatch: {
      watchId: "",
      path: "",
      selectedPath: "",
      pending: false,
      error: "",
      suppressUntil: 0,
      unsubscribe: null,
    },
  };
  const els = {
    cachedDatasetStatus,
    datasetTableWrap: {
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 0,
      scrollHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
    },
  };
  const api = {
    captureDatasetTableSelection: () => ({}),
    closeDatasetTableFilterPopover: () => {},
    getCachedDatasetKey: (value) => String(value || "").trim().toLowerCase(),
    getDatasetName: (row) => row?.name || "",
    normalizeLookupKey: (value) => String(value || "").trim().toLowerCase(),
    normalizePath: (value) => String(value || "").trim(),
    restoreDatasetTableSelection: () => {},
    setStatus: (message, isError = false) => statuses.push({ message, isError }),
    toText: (value) => String(value ?? "").trim(),
  };
  api.renderDatasetTable = () => {
    state.cachedDatasetFilter.visibleCount = state.cachedDatasetFilter.instanceRows.length;
    api.syncCachedDatasetToolbar?.();
  };
  installProjectInstanceDatasetCache({
    api,
    els,
    projectName: "PI warning test",
    state,
  });

  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {
    ADAHost: {},
    location: { origin: "http://127.0.0.1:28765" },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  });

  return {
    api,
    cachedDatasetStatus,
    restoreGlobals() {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
    state,
    statuses,
  };
}

test("a read-only index warning keeps the cached dataset table usable and visible", async () => {
  const warning = "Dataset table loaded, but index.json could not be updated: access denied.";
  const harness = createHarness({
    ok: true,
    files: [{ name: "Paid Loss", method_type: "None" }],
    index_persisted: false,
    index_warning: warning,
  });

  try {
    const refreshed = await harness.api.refreshCachedDatasetTableFromDisk();

    assert.equal(refreshed, true);
    assert.equal(harness.state.cachedDatasetFilter.error, "");
    assert.equal(harness.state.cachedDatasetFilter.warning, warning);
    assert.equal(harness.state.cachedDatasetFilter.instanceRows.length, 1);
    assert.equal(harness.state.cachedDatasetFilter.names.has("paid loss"), true);
    assert.equal(
      harness.cachedDatasetStatus.textContent,
      "(1 record | Warning: index not saved)",
    );
    assert.equal(harness.cachedDatasetStatus.getAttribute("aria-label"), warning);
    assert.equal(
      harness.statuses.some(({ message }) => message === "Dataset table refreshed."),
      false,
    );
    assert.deepEqual(harness.statuses.at(-1), { message: warning, isError: true });
  } finally {
    harness.restoreGlobals();
  }
});

test("a later persisted snapshot clears the non-blocking index warning", () => {
  const harness = createHarness({
    ok: true,
    files: [],
  });

  try {
    harness.state.cachedDatasetFilter.warning = "Previous index warning";
    harness.api.applyCachedDatasetSnapshot({
      ok: true,
      files: [{ name: "Reported Loss", method_type: "None" }],
      index_persisted: true,
    });
    harness.state.cachedDatasetFilter.visibleCount = 1;
    harness.api.syncCachedDatasetToolbar();

    assert.equal(harness.state.cachedDatasetFilter.warning, "");
    assert.equal(harness.cachedDatasetStatus.textContent, "(1 record)");
    assert.equal(harness.cachedDatasetStatus.getAttribute("aria-label"), null);
  } finally {
    harness.restoreGlobals();
  }
});

test("canonical logical names with numeric at-sign suffixes remain literal", () => {
  const harness = createHarness({ ok: true, files: [] });

  try {
    harness.api.applyCachedDatasetSnapshot({
      ok: true,
      files: [{
        name: "Legacy Name@12@24",
        dataset_type: "Legacy Type",
        method_type: "None",
      }],
      index_persisted: true,
    });

    assert.equal(
      harness.state.cachedDatasetFilter.names.has("legacy name@12@24"),
      true,
    );
    assert.equal(harness.state.cachedDatasetFilter.names.has("legacy name@12"), false);
    assert.equal(
      harness.state.cachedDatasetFilter.instanceRows[0].name,
      "Legacy Name@12@24",
    );
  } finally {
    harness.restoreGlobals();
  }
});
