import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = (value) => String(value ?? "").trim();
const norm = (value) => text(value).replace(/\s+/g, " ").toLowerCase();
const csvBaseName = (value) => text(value).split(/[\\/]/).pop();

function extractFunction(source, name) {
  const match = source.match(
    new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, "u"),
  );
  assert.ok(match, `Expected to find ${name}().`);
  return match[0];
}

async function loadCachedRowNormalizer(relativePath, extraNames = [], extraValues = []) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const functionSource = extractFunction(source, "normalizeCachedRow");
  return Function(
    "text",
    "csvBaseName",
    ...extraNames,
    `return (${functionSource});`,
  )(text, csvBaseName, ...extraValues);
}

test("canonical index consumers preserve numeric at-sign suffixes in logical names", async () => {
  const resultSelectionSource = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  globalThis.window = { ResultSelectionParts: {} };

  try {
    Function(resultSelectionSource)();
    const resultSelectionApi = globalThis.window.ResultSelectionParts.installData({
      datasetTypeItems: [],
      norm,
      text,
      validSourceOriginLength: (value) => Number(value) || 0,
    });
    const [resultSelectionRow] = resultSelectionApi.normalizeDatasetRows({
      files: [{
        name: "Legacy Name@12@24",
        dataset_type: "Legacy Type",
        data_format: "Vector",
      }],
    });

    const normalizeBornhuetterFergusonRow = await loadCachedRowNormalizer(
      "../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
      ["validOriginLength"],
      [(value) => Number(value) || 0],
    );
    const normalizeBerquistShermanRow = await loadCachedRowNormalizer(
      "../ui/method_pages/berquist_sherman/berquist_sherman_main.js",
    );
    const canonicalRow = {
      name: "Legacy Name@12@24",
      dataset_type: "Legacy Type",
      data_format: "Vector",
    };

    assert.equal(resultSelectionRow.name, "Legacy Name@12@24");
    assert.equal(normalizeBornhuetterFergusonRow(canonicalRow).name, "Legacy Name@12@24");
    assert.equal(normalizeBerquistShermanRow(canonicalRow).name, "Legacy Name@12@24");
  } finally {
    globalThis.window = previousWindow;
  }
});

async function installProjectInstanceDatasetTable() {
  const source = await readFile(
    new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url),
    "utf8",
  );
  const testableSource = source.replace(
    /^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gmu,
    "",
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(`
      const openDatasetNamePicker = async () => {};
      const BERQUIST_SHERMAN_VARIANTS = [];
      const getBerquistShermanContract = () => ({});
      const normalizeBerquistShermanVariant = () => "";
      ${testableSource}
    `).toString("base64")}`
  );
  const api = {
    beginPageLoading() {},
    finishPageLoading() {},
    focusProjectInstancePage() {},
    getCachedDatasetKey: norm,
    hasCachedDatasetMetadataForSelectedPath: () => false,
    isDatasetRecordCached: () => false,
    isTemporaryDatasetView: () => false,
    loadCachedDatasetFilterForSelectedPath: async () => {},
    normalizeLookupKey: norm,
    normalizePath: text,
    openBerquistShermanWindow() {},
    openBornhuetterFergusonWindow() {},
    openDatasetWindow() {},
    openDfmWindow() {},
    openNewDatasetDraftWindow() {},
    openResultSelectionWindow() {},
    postProjectInstanceStatus() {},
    setStatus() {},
    shouldUseCachedDatasetFilter: () => false,
    syncCachedDatasetToolbar() {},
    toText: text,
  };
  const state = {
    cachedDatasetFilter: {
      loadedPath: "",
      metadataByName: new Map(),
      methodTypesByName: new Map(),
    },
    datasetRows: [],
    datasetTablePreferenceWidthKeys: [],
    datasetTableSelection: new Set(),
    datasetTableView: {
      collapsedGroups: new Set(),
      columns: [],
      filters: new Map(),
      groupBy: [],
    },
    selectedPath: "",
  };
  module.installProjectInstanceDatasetTable({
    api,
    constants: {
      DATASET_COLUMNS: 3,
      DATASET_TABLE_AUTOFIT_CELL_EXTRA_WIDTH: 0,
      DATASET_TABLE_AUTOFIT_HEADER_EXTRA_WIDTH: 0,
      DATASET_TABLE_AUTOFIT_MAX_WIDTH: 0,
      DATASET_TABLE_BLANK_LABEL: "(Blank)",
      DATASET_TABLE_COLUMNS: [
        { key: "name", label: "Name" },
        { key: "datasetTypeName", label: "Dataset Type" },
        { key: "dataFormat", label: "Data Format" },
      ],
      DATASET_TABLE_DEFAULT_WIDTHS: {},
    },
    els: {},
    fetchProjectDatasetTypes: async () => ({}),
    loadProjectUserPreferences: async () => ({}),
    projectName: "Example Project",
    scheduleProjectUserPreferencesSave() {},
    state,
  });
  return { api, state };
}

test("PI records prefer canonical index data_format without Dataset Type metadata", async () => {
  const { api, state } = await installProjectInstanceDatasetTable();
  const instance = {
    name: "Legacy Name@12@24",
    dataset_type: "Missing Type",
    data_format: "Vector",
  };

  const withoutDatasetType = api.buildDatasetRecord([], 0, instance);
  assert.equal(withoutDatasetType.values.dataFormat, "Vector");

  state.datasetRows = [["Configured Type", "Triangle"]];
  const withDifferentDatasetType = api.buildDatasetRecord(
    state.datasetRows[0],
    0,
    { ...instance, dataset_type: "Configured Type" },
  );
  assert.equal(withDifferentDatasetType.values.dataFormat, "Vector");
});
