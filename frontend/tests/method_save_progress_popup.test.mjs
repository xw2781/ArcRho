import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createArcRhoBusyOverlay } from "../ui/shared/components/progress_popup/progress_popup.js";

const frontendRoot = new URL("../", import.meta.url);

// The runtime module loads its dependency from the app-server URL space, which
// Node cannot resolve, so the real source is imported with that one specifier
// rewritten to the file it serves.
async function importSaveProgress() {
  const popupUrl = new URL("ui/shared/components/progress_popup/progress_popup.js", frontendRoot).href;
  // The stub records every dialog the module opens so a test can assert that a
  // save with nothing to report opens none at all.
  const messageBoxUrl = `data:text/javascript,${encodeURIComponent(
    "export async function showPageMessageBox(options){"
    + " (globalThis.__arcrhoNoticeDialogs = globalThis.__arcrhoNoticeDialogs || []).push(options);"
    + " }",
  )}`;
  // The notice opens a clicked dataset through the real review-warning helper,
  // so that one keeps its own source rather than being stubbed out.
  const reviewWarningUrl = new URL(
    "ui/shared/components/message_box/method_save_review_warning.js",
    frontendRoot,
  ).href;
  const text = (await source("ui/shared/components/progress_popup/save_progress.js"))
    .replace(
      /"\/ui\/shared\/components\/progress_popup\/progress_popup\.js\?v=[0-9a-z]+"/u,
      JSON.stringify(popupUrl),
    )
    .replace(
      /"\/ui\/shared\/components\/message_box\/method_save_review_warning\.js\?v=[0-9a-z]+"/u,
      JSON.stringify(reviewWarningUrl),
    )
    .replace(
      /"\/ui\/shared\/components\/message_box\/message_box\.js\?v=[0-9a-z]+"/u,
      JSON.stringify(messageBoxUrl),
    );
  return import(`data:text/javascript,${encodeURIComponent(text)}`);
}

// Every window that saves an ArcRho object raises the same animation.
const SAVE_SURFACES = [
  {
    label: "DFM",
    path: "ui/method_pages/dfm/dfm_persistence.js",
    subject: '"DFM Method"',
    entry: /export async function saveRatioSelectionPattern[\s\S]{0,200}?dfmSaveProgress\.run\(/u,
  },
  {
    label: "Result Selection",
    path: "ui/method_pages/result_selection/result_selection_main.js",
    subject: '"Result Selection"',
  },
  {
    label: "Bornhuetter Ferguson",
    path: "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
    subject: "BF_METHOD_TYPE",
    entry: /async function saveBornhuetterFerguson\(\)[\s\S]{0,200}?bfSaveProgress\.run\(/u,
  },
  {
    label: "Cape Cod",
    path: "ui/method_pages/cape_cod/cape_cod_main.js",
    subject: "CC_METHOD_TYPE",
    entry: /async function saveCapeCod\(\)[\s\S]{0,200}?ccSaveProgress\.run\(/u,
  },
  {
    label: "Berquist Sherman",
    path: "ui/method_pages/berquist_sherman/berquist_sherman_main.js",
    subject: "contract.displayLabel",
    entry: /async function saveMethod\(\)[\s\S]{0,200}?bsSaveProgress\.run\(/u,
  },
  {
    label: "Dataset",
    path: "ui/shared/tabs/data/data_tab_persistence_controller.js",
    subject: '"Dataset", noun: "dataset"',
    entry: /async function saveDatasetChanges\([\s\S]{0,600}?datasetSaveProgress\.run\(/u,
  },
];

async function source(relativePath) {
  return readFile(new URL(relativePath, frontendRoot), "utf8");
}

function createStubElement() {
  const parts = new Map();
  return {
    className: "",
    innerHTML: "",
    textContent: "",
    hidden: false,
    isConnected: false,
    parentNode: null,
    children: [],
    lastElementChild: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    appendChild(child) {
      this.children.push(child);
      this.lastElementChild = child;
    },
    querySelector(selector) {
      if (!parts.has(selector)) parts.set(selector, createStubElement());
      return parts.get(selector);
    },
  };
}

function createStubDocument() {
  const created = [];
  const body = {
    appendChild(element) {
      element.isConnected = true;
      element.parentNode = {
        removeChild(node) {
          node.isConnected = false;
          node.parentNode = null;
        },
      };
    },
  };
  return {
    created,
    // A truthy lookup keeps the popup from building a stylesheet link.
    getElementById: () => ({}),
    createElement: () => {
      const element = createStubElement();
      created.push(element);
      return element;
    },
    head: { appendChild() {} },
    body,
    cardText(part) {
      const card = created.at(-1);
      return card ? card.querySelector(`.arcrho-load-popup-${part}`).textContent : "";
    },
  };
}

function withStubAnimationFrame(run) {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    return run();
  } finally {
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
}

test("overlapping busy scopes share one popup until the last scope ends", () => {
  withStubAnimationFrame(() => {
    const doc = createStubDocument();
    const overlay = createArcRhoBusyOverlay({ documentRef: doc, title: "Saving Method" });

    assert.equal(overlay.isVisible(), false);
    const first = overlay.begin("Step one.");
    assert.equal(overlay.isVisible(), true);
    const second = overlay.begin("Step two.");

    // The scope that finishes first must not pull the popup out from under
    // the save still running behind it.
    first.dismiss();
    assert.equal(overlay.isVisible(), true);
    // A dismissed scope can no longer retarget the popup the other scope owns.
    first.setMessage("Stale step.");
    second.dismiss();
    assert.equal(overlay.isVisible(), false);
    // A repeated dismiss must not unbalance the scope counter.
    second.dismiss();
    const third = overlay.begin("Step three.");
    assert.equal(overlay.isVisible(), true);
    third.dismiss();
    assert.equal(overlay.isVisible(), false);
  });
});

test("save progress names the saved object and reports the same two steps", async () => {
  const { createArcRhoSaveProgress } = await importSaveProgress();
  await withStubAnimationFrame(async () => {
    const doc = createStubDocument();
    const saveProgress = createArcRhoSaveProgress({ documentRef: doc, subject: "Cape Cod" });

    const seen = [];
    const result = await saveProgress.run((progress) => {
      seen.push([doc.cardText("title"), doc.cardText("msg")]);
      progress.writing();
      seen.push([doc.cardText("title"), doc.cardText("msg")]);
      // A save drops the spinner itself before opening a dialog.
      progress.finish();
      seen.push(saveProgress.isVisible());
      return "saved";
    });

    assert.equal(result, "saved");
    assert.deepEqual(seen, [
      ["Saving Cape Cod", "Preparing the method before saving."],
      ["Saving Cape Cod", "Saving the method and updating dependent objects."],
      false,
    ]);
    assert.equal(saveProgress.isVisible(), false);
  });
});

test("save progress names the dataset noun and clears after a failed save", async () => {
  const { createArcRhoSaveProgress } = await importSaveProgress();
  await withStubAnimationFrame(async () => {
    const doc = createStubDocument();
    const saveProgress = createArcRhoSaveProgress({ documentRef: doc, subject: "Dataset", noun: "dataset" });

    await assert.rejects(
      saveProgress.run(() => {
        assert.equal(doc.cardText("title"), "Saving Dataset");
        assert.equal(doc.cardText("msg"), "Preparing the dataset before saving.");
        throw new Error("save failed");
      }),
      /save failed/u,
    );
    // A throwing save must not strand the overlay over a blocked page.
    assert.equal(saveProgress.isVisible(), false);
  });
});

test("a Result Selection save shows the spinner and clears it before the review dialog", async () => {
  const modelSource = await source("ui/method_pages/result_selection/result_selection_model.js");
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    ResultSelectionParts: {},
    clearTimeout,
    parent: { postMessage() {} },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      method_revision: "saved-revision",
      method: { details_tab: {}, method_tab: { loaded_datasets: [] } },
      sidecar: { audit_log: [] },
    }),
  });

  const events = [];
  let visible = false;
  const rsSaveProgress = {
    async run(work) {
      visible = true;
      events.push("begin");
      try {
        return await work({
          writing() { events.push("writing"); },
          finish() {
            if (!visible) return;
            visible = false;
            events.push("finish");
          },
        });
      } finally {
        visible = false;
      }
    },
  };

  try {
    Function(modelSource)();
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
      refreshOriginLabels: async () => {
        events.push(`origin-labels:${visible}`);
      },
      invalidateOutputSidecarLoad: () => {},
      auditLogView: { render() {} },
      recordPersistedMethodDependencies: () => {},
      notesController: { markClean() {} },
      clearResultSelectionDependencyPreview: () => {},
      postDirty: () => {},
      reapplyActiveDependencyPreviews: () => {},
      schedulePersistedValuesRefresh: () => {},
      resumePersistedValuesRefresh: () => {},
      trackSavePropagation: async () => null,
      showMethodSaveReviewWarning: async () => {
        events.push(`review-dialog:${visible}`);
      },
      postStatus: () => {},
      inst: "rs_test",
      rsSaveProgress,
    });

    const result = await api.saveResultSelection();

    assert.equal(result.ok, true);
    assert.deepEqual(events, [
      "begin",
      "origin-labels:true",
      "writing",
      "finish",
      "review-dialog:false",
    ]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test("the saved-dependents notice only appears when a dependent was refreshed", async () => {
  const { showSavedDependentsNotice } = await importSaveProgress();
  globalThis.__arcrhoNoticeDialogs = [];

  // A save that refreshed nothing has nothing to tell the user, so it must not
  // interrupt them with a dialog they have to dismiss.
  await showSavedDependentsNotice([]);
  await showSavedDependentsNotice(undefined);
  await showSavedDependentsNotice(["", "   "]);
  assert.deepEqual(globalThis.__arcrhoNoticeDialogs, []);

  // Node has no `document`, so the caller supplies the one the notice uses.
  await showSavedDependentsNotice(["Paid Loss", " Reported Loss "], { documentRef: {} });
  assert.equal(globalThis.__arcrhoNoticeDialogs.length, 1);
  const notice = globalThis.__arcrhoNoticeDialogs[0];
  assert.equal(notice.title, "Saved");
  assert.equal(notice.message, "2 dependent datasets were updated:");
  // The names are links, one per row, instead of one comma-joined sentence.
  assert.deepEqual(notice.links.map((link) => link.label), ["Paid Loss", "Reported Loss"]);
  // A save that touched one dependent still reads as a sentence.
  await showSavedDependentsNotice(["Paid Loss"], { documentRef: {} });
  assert.equal(globalThis.__arcrhoNoticeDialogs.at(-1).message, "1 dependent dataset was updated:");
  delete globalThis.__arcrhoNoticeDialogs;
});

test("a clicked dependent name asks Project Instance to open its page", async () => {
  const { showSavedDependentsNotice } = await importSaveProgress();
  globalThis.__arcrhoNoticeDialogs = [];
  const posted = [];
  const windowRef = { parent: { postMessage: (message) => posted.push(message) } };

  await showSavedDependentsNotice(["Ultimate Loss"], { documentRef: {}, windowRef });
  globalThis.__arcrhoNoticeDialogs[0].onLinkClick({ label: "Ultimate Loss" });

  // `openMethod` is what makes Project Instance land on the owning method page
  // when the refreshed dataset is a method output, and on the dataset page
  // otherwise; the name is the only thing Project Instance needs to resolve it.
  assert.deepEqual(posted, [{
    type: "arcrho:project-instance-open-dependent-dataset",
    inst: "",
    datasetName: "Ultimate Loss",
    openMethod: true,
    project: "",
    reservingClass: "",
  }]);
  delete globalThis.__arcrhoNoticeDialogs;
});

test("every method and dataset window saves behind the shared save progress", async () => {
  const sources = await Promise.all(SAVE_SURFACES.map((surface) => source(surface.path)));

  sources.forEach((text, index) => {
    const surface = SAVE_SURFACES[index];
    assert.match(
      text,
      new RegExp(`createArcRhoSaveProgress\\(\\{ subject: ${surface.subject.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\}\\)`, "u"),
      `${surface.label} must build its saving animation from the shared save progress`,
    );
    assert.match(
      text,
      /save_progress\.js\?v=20260816a/u,
      `${surface.label} must load one version of the shared save progress`,
    );
    // No page owns popup markup, styles, or its own scope counter.
    assert.doesNotMatch(text, /arcrho-load-popup/u, `${surface.label} must not own popup markup`);
    if (surface.entry) {
      assert.match(text, surface.entry, `${surface.label} must run its save entry point behind the animation`);
    }
  });
});

test("each save drops the spinner before its post-save review dialog", async () => {
  const reviewSurfaces = SAVE_SURFACES.filter((surface) => surface.label !== "Result Selection");
  const sources = await Promise.all(reviewSurfaces.map((surface) => source(surface.path)));

  sources.forEach((text, index) => {
    const surface = reviewSurfaces[index];
    // The Dataset window opens the recalculation dialog instead of the
    // method review warning; both must follow the same dismissal rule.
    const dialogIndex = surface.label === "Dataset"
      ? text.indexOf("handleCalculationUpdates(resp.data?.calculated_updates")
      : text.indexOf("await showMethodSaveReviewWarning(");
    assert.ok(dialogIndex > 0, `${surface.label} must open a post-save dialog`);
    const finishIndex = text.lastIndexOf("progress?.finish()", dialogIndex) >= 0
      ? text.lastIndexOf("progress?.finish()", dialogIndex)
      : text.lastIndexOf("progress.finish()", dialogIndex);
    assert.ok(
      finishIndex > 0 && finishIndex < dialogIndex,
      `${surface.label} must dismiss the saving animation before its post-save dialog`,
    );
  });
});
