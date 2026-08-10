import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadingSource = await readFile(
  new URL("../ui/project_instance/project_instance_loading.js", import.meta.url),
  "utf8",
);
const { installProjectInstanceLoading } = await import(
  `data:text/javascript;base64,${Buffer.from(loadingSource).toString("base64")}`
);

function createHarness() {
  const state = {
    datasetWindows: new Map(),
    pageLoadingTasks: new Set(),
    pageLoadingLabels: new Map(),
    pageLoadingFrameTimer: 0,
    pageLoadingStartedAt: 0,
    lastZoomDetail: null,
  };
  const classes = new Set();
  const els = {
    pageLoadingOverlay: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
    },
    pageLoadingTitle: { textContent: "" },
    pageLoadingMessage: { textContent: "" },
    pageLoadingElapsed: { textContent: "" },
  };
  const api = { toText: (value) => String(value ?? "").trim() };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCaf = globalThis.cancelAnimationFrame;
  const previousPerformance = globalThis.performance;
  globalThis.window = { ArcRhoZoomBridge: { wirePageZoomBridge: () => {} } };
  globalThis.document = { body: { classList: { toggle: () => {} } } };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  if (!globalThis.performance) globalThis.performance = { now: () => 0 };

  installProjectInstanceLoading({ api, els, projectName: "PI loading test", state });

  return {
    api,
    classes,
    els,
    restoreGlobals() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.requestAnimationFrame = previousRaf;
      globalThis.cancelAnimationFrame = previousCaf;
      globalThis.performance = previousPerformance;
    },
    state,
  };
}

test("a labelled task names itself in the shared loading card", () => {
  const harness = createHarness();

  try {
    harness.api.beginPageLoading("delete-datasets", {
      title: "Deleting cached files",
      message: "Removing cached files for Paid Loss...",
    });

    assert.equal(harness.classes.has("open"), true);
    assert.equal(harness.els.pageLoadingTitle.textContent, "Deleting cached files");
    assert.equal(
      harness.els.pageLoadingMessage.textContent,
      "Removing cached files for Paid Loss...",
    );
    assert.equal(harness.els.pageLoadingElapsed.textContent, "Elapsed: 0.0s");

    harness.api.finishPageLoading("delete-datasets");

    assert.equal(harness.classes.has("open"), false);
    assert.equal(harness.state.pageLoadingLabels.size, 0);
  } finally {
    harness.restoreGlobals();
  }
});

test("an unlabelled task keeps the project-load wording", () => {
  const harness = createHarness();

  try {
    harness.api.beginPageLoading("paths");

    assert.equal(harness.els.pageLoadingTitle.textContent, "Loading Project Instance");
    assert.equal(
      harness.els.pageLoadingMessage.textContent,
      "Loading reserving class paths...",
    );
  } finally {
    harness.restoreGlobals();
  }
});

test("finishing a labelled task restores the wording of what is still loading", () => {
  const harness = createHarness();

  try {
    harness.api.beginPageLoading("paths");
    harness.api.beginPageLoading("delete-datasets", {
      title: "Deleting cached files",
      message: "Removing cached files for Paid Loss...",
    });
    assert.equal(harness.els.pageLoadingTitle.textContent, "Deleting cached files");

    harness.api.finishPageLoading("delete-datasets");

    assert.equal(harness.classes.has("open"), true, "the path load is still running");
    assert.equal(harness.els.pageLoadingTitle.textContent, "Loading Project Instance");
    assert.equal(
      harness.els.pageLoadingMessage.textContent,
      "Loading reserving class paths...",
    );
  } finally {
    harness.restoreGlobals();
  }
});
