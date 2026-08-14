import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


test("save preparation aborts when an upstream preview arrives during its async work", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_model.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    ResultSelectionParts: {},
    clearTimeout,
    parent: { postMessage() {} },
  };
  let saveRequests = 0;
  globalThis.fetch = async () => {
    saveRequests += 1;
    throw new Error("save request must not start");
  };

  try {
    Function(source)();
    const state = {
      loadBlocked: false,
      initialLoadPending: false,
      dependencyRestorePending: false,
      dependencyRestoreError: "",
      hasDependencyPreview: false,
      dependencyEventSeq: 0,
      persistedMutationSeq: 0,
      persistedMutationInFlight: 0,
    };
    const api = globalThis.window.ResultSelectionParts.installModel({
      state,
      els: { nameInput: { value: "Selection" }, notesInput: { value: "" } },
      text: (value) => String(value ?? "").trim(),
      getDetails: () => ({ name: "Selection", outputType: "Selected Ultimate" }),
      refreshOriginLabels: async () => {
        state.dependencyEventSeq += 1;
        state.hasDependencyPreview = true;
      },
      resumePersistedValuesRefresh: () => {},
      postStatus: () => {},
    });

    await assert.rejects(
      api.saveResultSelection(),
      /upstream dependency preview|upstream dependency changed/iu,
    );
    assert.equal(saveRequests, 0);
    assert.equal(state.persistedMutationInFlight, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});


test("a dependency update queued during save survives the save response", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_model.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    ResultSelectionParts: {},
    clearTimeout,
    parent: { postMessage() {} },
  };
  let releaseSave;
  let notifySaveStarted;
  const saveStarted = new Promise((resolve) => { notifySaveStarted = resolve; });
  globalThis.fetch = async () => {
    notifySaveStarted();
    await new Promise((resolve) => { releaseSave = resolve; });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        method_revision: "saved-revision",
        method: { details_tab: {}, method_tab: { loaded_datasets: [] } },
        sidecar: { audit_log: [] },
      }),
    };
  };

  try {
    Function(source)();
    let previewReapplyCount = 0;
    let resumeCount = 0;
    let scheduleCount = 0;
    const state = {
      project: "Project",
      reservingClass: "Class",
      sources: [],
      ratioBasisValueSets: [],
      loadBlocked: false,
      initialLoadPending: false,
      dependencyRestorePending: false,
      dependencyRestoreError: "",
      hasDependencyPreview: false,
      dependencyEventSeq: 0,
      persistedMutationSeq: 0,
      persistedMutationInFlight: 0,
      methodRevision: "original-revision",
    };
    const api = globalThis.window.ResultSelectionParts.installModel({
      state,
      els: { nameInput: { value: "Selection" }, notesInput: { value: "" } },
      text: (value) => String(value ?? "").trim(),
      getDetails: () => ({ name: "Selection", outputType: "Selected Ultimate" }),
      getRowCount: () => 0,
      originLabel: () => "",
      calculatedUltimateVector: () => [],
      selectedUltimateVector: () => [],
      serializedUltimateOverrides: () => [],
      buildResultSelectionMethodPayload: () => ({
        details_tab: {},
        method_tab: { loaded_datasets: [] },
      }),
      refreshOriginLabels: async () => {},
      invalidateOutputSidecarLoad: () => {},
      auditLogView: { render() {} },
      recordPersistedMethodDependencies: () => {},
      notesController: { markClean() {} },
      clearResultSelectionDependencyPreview: () => {},
      postDirty: () => {},
      reapplyActiveDependencyPreviews: () => { previewReapplyCount += 1; },
      schedulePersistedValuesRefresh: () => { scheduleCount += 1; },
      resumePersistedValuesRefresh: () => { resumeCount += 1; },
      trackSavePropagation: async () => null,
      // Step one of the two-step save needs a live server; this save's
      // dependents are not what this test is about.
      planAndConfirmSave: async () => ({ proceed: true, fingerprint: "fp-race" }),
      showMethodSaveReviewWarning: async () => {},
      postStatus: () => {},
      inst: "rs_test",
    });

    const savePromise = api.saveResultSelection();
    await saveStarted;
    state.dependencyEventSeq += 1;
    state.dependencyRestorePending = true;
    state.persistedRefreshReason = "newer dependency update";
    releaseSave();
    const result = await savePromise;

    assert.equal(result.ok, true);
    assert.equal(state.dependencyRestorePending, true);
    assert.equal(state.persistedRefreshReason, "newer dependency update");
    assert.equal(previewReapplyCount, 1);
    assert.equal(scheduleCount, 0);
    assert.equal(resumeCount, 1);
    assert.equal(state.persistedMutationInFlight, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});


test("a clear and its propagation report share one persisted Result Selection load", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_ui.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  globalThis.window = {
    ResultSelectionParts: {},
    setTimeout,
    clearTimeout,
    parent: { postMessage() {} },
  };

  try {
    Function(source)();
    let loadCount = 0;
    const state = {
      sources: [],
      ratioBasisValues: [],
      ratioBasisValueSets: [],
      dependencyPreviews: new Map(),
      persistedDependencyNames: new Set(),
      persistedRefreshSeq: 0,
      persistedRefreshTimer: null,
      persistedRefreshReason: "",
      dependencyRefreshPromise: null,
      initialLoadPending: false,
      pendingDependencyClearMessages: [],
      dependencyRestorePending: false,
      dependencyRestoreError: "",
      persistedMutationInFlight: 0,
      needsReview: false,
      project: "Project",
      reservingClass: "Class",
    };
    const api = globalThis.window.ResultSelectionParts.installUi({
      state,
      els: { ratioBasisInputs: [] },
      text: (value) => String(value ?? "").trim(),
      norm: (value) => String(value ?? "").trim().toLowerCase(),
      isDirty: false,
      fetchPersistedResultSelection: async () => {
        loadCount += 1;
        return {
          method_exists: true,
          method_revision: "revision",
          method: {
            details_tab: { ratio_basis_datasets: [] },
            method_tab: { loaded_datasets: [] },
          },
          sidecar: { status: 0 },
        };
      },
      applyOutputSidecar: () => {},
      applyPayload: async () => {},
      syncLoadBlockedControls: () => {},
      markClean: () => {},
      postStatus: () => {},
    });

    api.scheduleDependencyClearRestore({
      inst: "source-window",
      project: "Project",
      reservingClass: "Class",
      names: ["Paid"],
      reason: "save",
    });
    api.schedulePersistedValuesRefresh("Dataset save");

    assert.equal(state.dependencyRestorePending, true);
    assert.equal(await api.flushPersistedValuesRefresh(), true);
    assert.equal(loadCount, 1);
    assert.equal(state.dependencyRestorePending, false);
    assert.equal(state.dependencyRestoreError, "");
  } finally {
    globalThis.window = previousWindow;
  }
});


test("a failed local clear stays blocked and is retried by the next dependency event", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_ui.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  globalThis.window = {
    ResultSelectionParts: {},
    setTimeout,
    clearTimeout,
    parent: { postMessage() {} },
  };

  try {
    Function(source)();
    let sourceLoadCount = 0;
    let methodLoadCount = 0;
    const state = {
      sources: [{ name: "Paid", values: [1] }],
      ratioBasisValues: [],
      ratioBasisValueSets: [],
      dependencyPreviews: new Map(),
      persistedDependencyNames: new Set(["paid"]),
      persistedRefreshSeq: 0,
      persistedRefreshTimer: null,
      persistedRefreshReason: "",
      dependencyRefreshPromise: null,
      dependencyEventSeq: 1,
      initialLoadPending: false,
      pendingDependencyClearMessages: [],
      dependencyRestorePending: false,
      dependencyRestoreError: "",
      persistedMutationInFlight: 0,
      needsReview: false,
      project: "Project",
      reservingClass: "Class",
    };
    const api = globalThis.window.ResultSelectionParts.installUi({
      state,
      els: { ratioBasisInputs: [] },
      cachedRows: [],
      SOURCE_LOAD_CONCURRENCY: 2,
      mapWithConcurrency: async (items, _limit, worker) => Promise.all(items.map(worker)),
      buildSourceFromRecord: async () => {
        sourceLoadCount += 1;
        if (sourceLoadCount === 1) throw new Error("network source read failed");
        return { name: "Paid", values: [2] };
      },
      renderMethodGrid: () => {},
      text: (value) => String(value ?? "").trim(),
      norm: (value) => String(value ?? "").trim().toLowerCase(),
      isDirty: false,
      fetchPersistedResultSelection: async () => {
        methodLoadCount += 1;
        return {
          method_exists: true,
          method_revision: "revision",
          method: {
            details_tab: { ratio_basis_datasets: [] },
            method_tab: { loaded_datasets: [] },
          },
          sidecar: { status: 0 },
        };
      },
      applyOutputSidecar: () => {},
      applyPayload: async () => {},
      markClean: () => {},
    });

    api.scheduleDependencyClearRestore({
      inst: "source-window",
      project: "Project",
      reservingClass: "Class",
      names: ["Paid"],
      reason: "save",
    }, { reloadLocalSource: true });

    await assert.rejects(api.flushPersistedValuesRefresh(), /network source read failed/u);
    assert.equal(state.dependencyRestorePending, true);
    assert.match(state.dependencyRestoreError, /network source read failed/u);
    assert.equal(state.pendingDependencyClearMessages.length, 1);
    assert.equal(methodLoadCount, 0);

    state.dependencyEventSeq += 1;
    api.schedulePersistedValuesRefresh("newer calculated dataset update");
    assert.equal(await api.flushPersistedValuesRefresh(), true);
    assert.equal(sourceLoadCount, 2);
    assert.equal(methodLoadCount, 1);
    assert.equal(state.pendingDependencyClearMessages.length, 0);
    assert.equal(state.dependencyRestorePending, false);
    assert.equal(state.dependencyRestoreError, "");
  } finally {
    globalThis.window = previousWindow;
  }
});
