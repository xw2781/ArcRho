import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pathPanelSource = await readFile(
  new URL("../ui/project_instance/project_instance_path_panel.js", import.meta.url),
  "utf8",
);
const pickerSource = await readFile(
  new URL("../ui/shared/components/pickers/reserving_class_picker.js", import.meta.url),
  "utf8",
);
const { installProjectInstancePathPanel } = await import(
  `data:text/javascript;base64,${Buffer.from(pathPanelSource).toString("base64")}`
);

function installPanel({ shortcutPaths = [], firstTreePath = "" } = {}) {
  const calls = { revealed: [], active: [], saved: [], rendered: 0 };
  const state = {
    selectedPath: "",
    pathSegmentMenu: null,
    pathPickerModel: null,
    datasetTableSelection: { selectedKeys: new Set(), anchorKey: "" },
    pathPickerController: {
      getFirstVisibleLeafPath: () => firstTreePath,
      setActivePath: (path) => calls.active.push(path),
      revealPath: async (path, options) => {
        calls.revealed.push({ path, options });
        return true;
      },
    },
  };
  const els = {
    pathTree: {
      querySelectorAll: () => shortcutPaths.map((path) => ({ getAttribute: () => path })),
    },
  };
  const api = {
    beginPageLoading() {},
    finishPageLoading() {},
    focusProjectInstancePage() {},
    loadCachedDatasetFilterForSelectedPath() {},
    normalizePath: (value) => String(value ?? "").trim(),
    notifyProjectInstanceStateChanged() {},
    renderDatasetTable: () => { calls.rendered += 1; },
    setStatus() {},
    syncDatasetWindowChrome() {},
    toText: (value) => String(value ?? "").trim(),
  };
  installProjectInstancePathPanel({
    api,
    els,
    state,
    projectName: "Demo",
    constants: {},
    loadProjectUserPreferences: async () => ({}),
    openReservingClassPicker: async () => ({ ok: true }),
    scheduleProjectUserPreferencesSave: (project, values) => calls.saved.push(values),
  });
  return { api, state, calls };
}

test("a project with no saved path and no shortcut selects the first tree path", async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  t.after(() => { globalThis.window = previousWindow; });

  const { api, state, calls } = installPanel({ firstTreePath: "ALN_HPCIC\\GL\\Total" });
  await api.selectStartupFallbackPath();

  assert.equal(state.selectedPath, "ALN_HPCIC\\GL\\Total");
  assert.deepEqual(calls.revealed.map((entry) => entry.path), ["ALN_HPCIC\\GL\\Total"]);
  assert.equal(calls.saved.length, 0);
  assert.ok(calls.rendered > 0);
});

test("a shortcut still wins over the first tree path", async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  t.after(() => { globalThis.window = previousWindow; });

  const { api, state, calls } = installPanel({
    shortcutPaths: ["ALN_PIC\\Auto\\Total"],
    firstTreePath: "ALN_HPCIC\\GL\\Total",
  });
  await api.selectStartupFallbackPath();

  assert.equal(state.selectedPath, "ALN_PIC\\Auto\\Total");
  assert.equal(calls.revealed.length, 0);
});

test("the first tree path skips hidden paths and stops on a leaf", () => {
  assert.match(
    pickerSource,
    /const getFirstVisibleLeafPath = \(\) => \{\s*let node = filterHiddenNodes\(model\.getRootNodes\(\)\)\[0\][\s\S]*?filterHiddenNodes\(model\.getChildrenForPrefix\(node\.path\)\)\[0\]/u,
  );
  assert.match(pathPanelSource, /state\.pathPickerController\?\.getFirstVisibleLeafPath\?\.\(\)/u);
});
