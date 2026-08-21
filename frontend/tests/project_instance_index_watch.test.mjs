import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The dataset-index staleness watch must never flag this window's own writes.
// index.json is rewritten server-side (hosted saves, propagation, hosted index
// rebuilds), and a client stat over the mapped drive can echo pre-write
// metadata for ~10s afterwards, so the watch baselines on the signature the
// snapshot payload carries (statted by the process that wrote the file) and
// ignores polled signatures whose mtime is older than that baseline.

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
  )
  .replace(
    /"\/ui\/shared\/utils\/timestamp\.js\?v=\d{8}[a-z]"/u,
    JSON.stringify(new URL("../ui/shared/utils/timestamp.js", import.meta.url).href),
  );
const { installProjectInstanceDatasetCache } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);

function createHarness() {
  const signatureReads = [];
  const state = {
    selectedPath: "Direct Group/COLL",
    datasetViewMode: "normal",
    datasetRows: [],
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
      path: "",
      selectedPath: "",
      signature: "",
      pending: false,
      checking: false,
      error: "",
      suppressUntil: 0,
      timer: 0,
      visibilityWired: false,
    },
  };
  const api = {
    captureDatasetTableSelection: () => ({}),
    closeDatasetTableFilterPopover: () => {},
    fetchDatasetTypeRowsForRefresh: async () => null,
    getCachedDatasetKey: (value) => String(value || "").trim().toLowerCase(),
    getDatasetName: (row) => row?.name || "",
    normalizeLookupKey: (value) => String(value || "").trim().toLowerCase(),
    normalizePath: (value) => String(value || "").trim(),
    renderDatasetTable: () => {},
    restoreDatasetTableSelection: () => {},
    setStatus: () => {},
    toText: (value) => String(value ?? "").trim(),
  };
  installProjectInstanceDatasetCache({
    api,
    els: {},
    projectName: "PI index watch test",
    state,
  });

  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { origin: "http://127.0.0.1:28765" },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  const harness = {
    api,
    nextPolledSignature: "",
    signatureReads,
    state,
    async restore() {
      await api.stopDatasetIndexWatch();
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/datasets\/cached\/index-signature\?/u);
    signatureReads.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, signature: harness.nextPolledSignature };
      },
    };
  };
  return harness;
}

test("the snapshot payload's signature baselines the watch without a client stat", async () => {
  const harness = createHarness();
  try {
    await harness.api.startDatasetIndexWatchForSnapshot(
      { index_signature: "2000.5:64" },
      harness.state.selectedPath,
    );

    assert.equal(harness.state.datasetIndexWatch.signature, "2000.5:64");
    assert.equal(harness.signatureReads.length, 0);
  } finally {
    await harness.restore();
  }
});

test("a payload without a signature falls back to the polling endpoint", async () => {
  const harness = createHarness();
  try {
    harness.nextPolledSignature = "1500:32";
    await harness.api.startDatasetIndexWatchForSnapshot({}, harness.state.selectedPath);

    assert.equal(harness.state.datasetIndexWatch.signature, "1500:32");
    assert.equal(harness.signatureReads.length, 1);
  } finally {
    await harness.restore();
  }
});

test("an observation older than the baseline is an SMB cache echo, not new work", async () => {
  const harness = createHarness();
  try {
    await harness.api.startDatasetIndexWatchForSnapshot(
      { index_signature: "2000:64" },
      harness.state.selectedPath,
    );
    harness.nextPolledSignature = "1000:48";
    await harness.api.checkDatasetIndexSignature();

    assert.equal(harness.state.datasetIndexWatch.pending, false);
    // Not adopted either: lowering the baseline would make the next fresh
    // stat of the same old write read as an external update.
    assert.equal(harness.state.datasetIndexWatch.signature, "2000:64");
  } finally {
    await harness.restore();
  }
});

test("an observation newer than the baseline raises the refresh prompt", async () => {
  const harness = createHarness();
  try {
    await harness.api.startDatasetIndexWatchForSnapshot(
      { index_signature: "2000:64" },
      harness.state.selectedPath,
    );
    harness.nextPolledSignature = "3000:80";
    await harness.api.checkDatasetIndexSignature();

    assert.equal(harness.state.datasetIndexWatch.pending, true);
  } finally {
    await harness.restore();
  }
});

test("a newer observation inside the settle window is adopted silently", async () => {
  const harness = createHarness();
  try {
    await harness.api.startDatasetIndexWatchForSnapshot(
      { index_signature: "2000:64" },
      harness.state.selectedPath,
    );
    harness.state.datasetIndexWatch.suppressUntil = Date.now() + 60000;
    harness.nextPolledSignature = "3000:80";
    await harness.api.checkDatasetIndexSignature();

    assert.equal(harness.state.datasetIndexWatch.pending, false);
    assert.equal(harness.state.datasetIndexWatch.signature, "3000:80");
  } finally {
    await harness.restore();
  }
});
