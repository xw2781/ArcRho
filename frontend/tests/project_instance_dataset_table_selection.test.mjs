import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tableSource = await readFile(
  new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url),
  "utf8",
);
const pageCss = await readFile(
  new URL("../ui/project_instance/project_instance.css", import.meta.url),
  "utf8",
);
// The table's own look lives in the shared pi-table sheet, which the Project
// Instance page and the macro review table both load.
const tableCss = await readFile(
  new URL("../ui/shared/styles/pi_table.css", import.meta.url),
  "utf8",
);
const darkCss = await readFile(
  new URL("../ui/shared/styles/themes/dark.css", import.meta.url),
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

function createHarness(records) {
  const state = {
    selectedPath: "Direct Group/COLL",
    datasetRows: [],
    datasetTableVisibleRecords: records,
    datasetDeleteConfirmResolve: null,
    datasetTablePreferenceWidthKeys: new Set(),
    datasetTableView: { filters: new Map(), collapsedGroups: new Set(), groupBy: [] },
    cachedDatasetFilter: { loading: false, names: new Set(), instanceRows: [] },
    datasetTableSelection: { selectedKeys: new Set(), anchorKey: "", activeKey: "" },
    datasetIndexWatch: { pending: false, suppressUntil: 0 },
    lastDatasetSelectionStatusCount: 0,
  };
  // No table surface: the harness exercises selection state, not the DOM.
  const els = {};
  const api = {
    beginPageLoading: () => {},
    finishPageLoading: () => {},
    focusProjectInstancePage: () => {},
    getCachedDatasetKey: (value) => String(value || "").trim().toLowerCase(),
    hasCachedDatasetMetadataForSelectedPath: () => true,
    isDatasetRecordCached: () => true,
    isTemporaryDatasetView: () => false,
    normalizeLookupKey: (value) => String(value || "").trim().toLowerCase(),
    normalizePath: (value) => String(value || "").trim(),
    postProjectInstanceStatus: () => {},
    setStatus: () => {},
    shouldUseCachedDatasetFilter: () => true,
    syncCachedDatasetToolbar: () => {},
    toText: (value) => String(value ?? "").trim(),
    applyCachedDatasetSnapshot: () => {},
    loadCachedDatasetFilterForSelectedPath: async () => {},
  };
  installProjectInstanceDatasetTable({
    api,
    els,
    projectName: "PI selection test",
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
  return { api, state };
}

function makeRecords(names) {
  return names.map((name, rowIndex) => ({ rowIndex, datasetName: name, values: { name } }));
}

test("shift-click keeps the anchor but makes the clicked row the Enter target", () => {
  const records = makeRecords(["Alpha", "Beta", "Gamma", "Delta"]);
  const { api, state } = createHarness(records);

  api.applyDatasetRowSelection(records[0], {});
  assert.equal(state.datasetTableSelection.anchorKey, "row-0");
  assert.equal(state.datasetTableSelection.activeKey, "row-0");

  api.applyDatasetRowSelection(records[2], { shiftKey: true });
  assert.deepEqual(
    Array.from(state.datasetTableSelection.selectedKeys).sort(),
    ["row-0", "row-1", "row-2"],
  );
  assert.equal(state.datasetTableSelection.anchorKey, "row-0", "shift keeps the range anchor");
  assert.equal(state.datasetTableSelection.activeKey, "row-2", "the clicked row becomes active");
  assert.equal(api.getActiveDatasetSelectionIndex(), 2, "Enter opens the last-selected row");
});

test("ctrl-toggling a row off falls back to a still-selected row for Enter", () => {
  const records = makeRecords(["Alpha", "Beta", "Gamma"]);
  const { api, state } = createHarness(records);

  api.applyDatasetRowSelection(records[0], {});
  api.applyDatasetRowSelection(records[2], { ctrlKey: true });
  assert.equal(state.datasetTableSelection.activeKey, "row-2");
  assert.equal(api.getActiveDatasetSelectionIndex(), 2);

  api.applyDatasetRowSelection(records[2], { ctrlKey: true });
  assert.ok(!state.datasetTableSelection.selectedKeys.has("row-2"));
  assert.equal(api.getActiveDatasetSelectionIndex(), 0, "Enter falls back to a selected row");
});

test("capture/restore keeps the active row across a re-render", () => {
  const records = makeRecords(["Alpha", "Beta", "Gamma"]);
  const { api, state } = createHarness(records);

  api.applyDatasetRowSelection(records[0], {});
  api.applyDatasetRowSelection(records[2], { shiftKey: true });
  const snapshot = api.captureDatasetTableSelection();
  assert.equal(snapshot.activeKey, "row-2");
  assert.equal(snapshot.activeName, "gamma");

  state.datasetTableSelection.selectedKeys.clear();
  state.datasetTableSelection.anchorKey = "";
  state.datasetTableSelection.activeKey = "";
  api.restoreDatasetTableSelection(snapshot);
  assert.equal(state.datasetTableSelection.anchorKey, "row-0");
  assert.equal(state.datasetTableSelection.activeKey, "row-2");
});

test("the row context menu makes the pointer row active and gates Add > DFM by dataset shape", () => {
  const contextHandler = tableSource.slice(
    tableSource.indexOf("tr.addEventListener(\"contextmenu\""),
    tableSource.indexOf("showDatasetRowContextMenu(recordKey, event.clientX, event.clientY)"),
  );
  assert.match(
    contextHandler,
    /datasetTableSelection\.activeKey = recordKey;/,
    "right-click emphasizes the row under the pointer",
  );
  assert.match(
    tableSource,
    /canAddDfmForDataset[\s\S]*?dataFormat"\)\) === "triangle"[\s\S]*?\["", "none"\]\.includes\(normalizeLookupKey\(getDatasetRecordValue\(record, "methodType"\)\)\)/,
    "DFM creation requires a plain triangle dataset",
  );
  assert.match(
    tableSource,
    /\[data-row-action='add-dfm'\][\s\S]*?addDfmItem\.disabled = !canAdd;[\s\S]*?DFM can be added only to triangle datasets with Method Type None\./,
    "the Add > DFM item is disabled with an explanatory tooltip",
  );
});

test("the active row keeps the solid left bar while other selected rows go hollow", () => {
  assert.match(
    tableSource,
    /selectedKeys\.size > 1[\s\S]*?key === datasetTableSelection\.activeKey/,
    "the emphasis only applies to multi-row selections",
  );
  assert.ok(
    !/\.selected\.active/su.test(pageCss) && !/\.selected\.active/su.test(tableCss),
    "the active row shares the normal selected background (no rules of its own)",
  );
  assert.ok(
    !/\.selected\.active/su.test(darkCss),
    "dark theme gives the active row no background of its own either",
  );
  assert.match(
    tableSource,
    /classList\.toggle\("multi", selected && datasetTableSelection\.selectedKeys\.size > 1\)/,
    "selected rows are tagged when they are part of a multi-row selection",
  );
  const multiRule = tableCss.match(
    /\.pi-table tbody tr\[data-record-key\]\.selected\.multi:not\(\.active\) td:first-child \{([^}]*)\}/su,
  );
  assert.ok(multiRule, "non-active rows in a multi-selection have their own first-cell rule");
  assert.match(multiRule[1], /box-shadow: inset 0 1px 0 #9cc7ff, inset 0 -1px 0 #9cc7ff;/);
  assert.ok(
    !/inset 3px/su.test(multiRule[1]),
    "non-active rows in a multi-selection carry no solid left bar",
  );
  assert.match(
    multiRule[1],
    /background-image: linear-gradient\([^)]*transparent 1px 3px[^)]*#2474d8 3px 4px/su,
    "non-active rows draw a hollow left bar with a 2px gap",
  );
});
