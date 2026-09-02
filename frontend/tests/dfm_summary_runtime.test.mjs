import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = (source) => (
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const frontendRoot = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, frontendRoot), "utf8");
}

test("rebuilt DFM summary rows remain live through the extracted runtime", async () => {
  const previousWindow = globalThis.window;
  const previousRows = globalThis.__dfmSummaryRuntimeRows;
  globalThis.window = { location: { search: "" } };
  globalThis.__dfmSummaryRuntimeRows = [];

  try {
    const datasetStateUrl = moduleUrl(`
      export const state = {
        model: {
          values: [[100, 150]],
          mask: [[true, true]],
          origin_labels: ["2024"],
          dev_labels: ["0", "12"],
        },
      };
    `);
    const dependencyStubUrl = moduleUrl(`
      export const sanitizeDataFolderPart = (value) => String(value || "");
      export const sanitizeFileNamePart = (value) => String(value || "");
      export const getSummaryConfigKey = () => "runtime-test";
      export const loadCustomSummaryRows = () => (
        globalThis.__dfmSummaryRuntimeRows.map((row) => ({ ...row }))
      );
      export const containsExcelReference = () => false;
      export const excelColumnFromIndex = () => "A";
      export const findExcelReferences = () => [];
      export const formatExcelReference = () => "";
      export const normalizeExcelReferenceAddressCase = (value) => value;
      export const parseStandaloneExcelRange = () => null;
      export const buildExcelRangeSourceCells = () => [];
      export const collectDfmExternalLinkGroups = () => new Map();
      export const getDfmExternalLinkHardCodeTargets = () => new Map();
      export const getDfmExternalLinkRangeTargets = () => [];
      export const DFM_FORMULA_VALIDATION_TIMEOUT_MS = 30000;
      export const beginFormulaValidationLease = () => null;
      export const clearFormulaValidationError = () => {};
      export const computeFormulaValidationTooltipLayout = () => null;
      export const revealAndFocusFormulaInput = () => {};
      export const showFormulaValidationError = () => {};
      export const scrollSpreadsheetCellIntoView = () => {};
      export const wireSelectableTable = () => null;
      export const openDfmSummaryPlotWindow = () => {};
      export const hasDfmCellNote = () => false;
      export const showDfmCellNoteEditor = () => {};
      export const beginRatioHistoryAction = () => {};
      export const commitRatioHistoryAction = () => {};
    `);

    let stateSource = await source("ui/method_pages/dfm/dfm_state.js");
    stateSource = stateSource
      .replace(
        '"/ui/shared/dataset/dataset_state.js"',
        JSON.stringify(datasetStateUrl),
      )
      .replace(
        '"/ui/shared/utils/filename.js"',
        JSON.stringify(dependencyStubUrl),
      )
      .replace(
        '"/ui/method_pages/dfm/dfm_storage.js"',
        JSON.stringify(dependencyStubUrl),
      )
      .replace(
        /const __ratioParams[\s\S]*?export \{[\s\S]*?computeAverageForColumn,?\s*\};/u,
        `
          const calcRatio = (left, right) => Number(right) / Number(left);
          const ratioNumberOrNull = (value) => (
            value === null || value === undefined || value === "" ? null : Number(value)
          );
          const persistedRatioOrNull = (value) => (
            Number(value) === 0 ? null : ratioNumberOrNull(value)
          );
          const roundRatio = (value) => Number(value);
          const formatRatio = (value) => String(value);
          const computeAverageForColumn = () => ({
            value: null,
            totalValid: 0,
            totalIncluded: 0,
            sumA: 0,
          });
          export {
            calcRatio,
            ratioNumberOrNull,
            persistedRatioOrNull,
            roundRatio,
            formatRatio,
            computeAverageForColumn,
          };
        `,
      );
    const stateUrl = moduleUrl(stateSource);

    let runtimeSource = await source(
      "ui/method_pages/dfm/ratios_summary/summary_runtime.js",
    );
    const runtimeReplacements = new Map([
      ["/ui/method_pages/dfm/dfm_state.js", stateUrl],
      ["/ui/method_pages/dfm/dfm_storage.js", dependencyStubUrl],
      ["/ui/shared/integrations/excel_api.js", dependencyStubUrl],
      ["/ui/shared/integrations/excel_reference.js?v=20260715a", dependencyStubUrl],
      ["/ui/method_pages/dfm/dfm_external_links_model.js?v=20260715a", dependencyStubUrl],
      ["/ui/method_pages/dfm/dfm_formula_validation.js?v=20260713b", dependencyStubUrl],
      ["/ui/shared/components/spreadsheet/table_selection.js?v=20260726a", dependencyStubUrl],
      ["/ui/method_pages/dfm/dfm_summary_plot_window.js?v=20260722a", dependencyStubUrl],
      ["/ui/method_pages/dfm/dfm_cell_notes.js", dependencyStubUrl],
      ["/ui/method_pages/dfm/dfm_ratio_history.js", dependencyStubUrl],
    ]);
    runtimeReplacements.forEach((replacement, specifier) => {
      runtimeSource = runtimeSource.replace(
        JSON.stringify(specifier),
        JSON.stringify(replacement),
      );
    });
    const runtimeUrl = moduleUrl(runtimeSource);

    let modelSource = await source(
      "ui/method_pages/dfm/ratios_summary/summary_model.js",
    );
    modelSource = modelSource.replace(
      '"/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260819a"',
      JSON.stringify(runtimeUrl),
    );
    const modelUrl = moduleUrl(modelSource);

    const [stateModule, runtimeModule, modelModule] = await Promise.all([
      import(stateUrl),
      import(runtimeUrl),
      import(modelUrl),
    ]);
    const rowsIdentity = stateModule.summaryRowConfigs;
    const mapIdentity = stateModule.summaryRowMap;
    assert.strictEqual(runtimeModule.summaryRuntime.summaryRowConfigs, rowsIdentity);
    assert.strictEqual(runtimeModule.summaryRuntime.summaryRowMap, mapIdentity);

    globalThis.__dfmSummaryRuntimeRows = [
      { id: "first", label: "First", averageType: "user_entry" },
    ];
    stateModule.buildSummaryRows();
    assert.deepEqual(modelModule.buildAverageSelectionPayload().formulas, ["First"]);
    assert.equal(runtimeModule.summaryRuntime.summaryRowMap.get("first")?.label, "First");

    globalThis.__dfmSummaryRuntimeRows = [
      { id: "second", label: "Second", averageType: "user_entry" },
    ];
    stateModule.buildSummaryRows();
    assert.strictEqual(stateModule.summaryRowConfigs, rowsIdentity);
    assert.strictEqual(stateModule.summaryRowMap, mapIdentity);
    assert.deepEqual(modelModule.buildAverageSelectionPayload().formulas, ["Second"]);
    assert.equal(runtimeModule.summaryRuntime.summaryRowMap.has("first"), false);
    assert.equal(runtimeModule.summaryRuntime.summaryRowMap.get("second")?.label, "Second");
    assert.equal(modelModule.formatUserEntryFormulaEvaluationValue(1.2), "1.2000");
    assert.equal(modelModule.formatUserEntryFormulaEvaluationValue(1.23456), "1.2346");
    assert.equal(modelModule.formatUserEntryFormulaEvaluationValue("not-a-number"), "");
  } finally {
    globalThis.window = previousWindow;
    globalThis.__dfmSummaryRuntimeRows = previousRows;
  }
});

test("DFM edit-mode arrows use the canonical sticky-aware scroll helper", async () => {
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const selectionSource = await source(
    "ui/shared/components/spreadsheet/table_selection.js",
  );
  const selectionModule = await import(moduleUrl(selectionSource));
  const stickyColumnHeader = {};
  const stickyRowHeader = {
    getBoundingClientRect: () => ({ width: 30 }),
  };
  const thead = {
    querySelectorAll: () => [stickyColumnHeader],
    getBoundingClientRect: () => ({ height: 20 }),
  };
  const table = { querySelector: () => thead };
  const cell = {
    closest: () => table,
    getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 5, right: 25 }),
    parentElement: { querySelector: () => stickyRowHeader },
  };
  const scrollHost = {
    scrollTop: 100,
    scrollLeft: 50,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100 }),
  };
  globalThis.getComputedStyle = (element) => (
    element === stickyColumnHeader
      ? { position: "sticky" }
      : { position: "sticky", left: "0px" }
  );

  try {
    selectionModule.scrollSpreadsheetCellIntoView(cell, scrollHost);
    assert.equal(scrollHost.scrollTop, 90);
    assert.equal(scrollHost.scrollLeft, 25);
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }

  const interactionsSource = await source(
    "ui/method_pages/dfm/ratios_summary/summary_interactions.js",
  );
  assert.match(
    interactionsSource,
    /scrollSpreadsheetCellIntoView\([\s\S]*?nextCell,[\s\S]*?ratioWrapHost/u,
  );
  assert.doesNotMatch(interactionsSource, /nextCell\.scrollIntoView/u);
});

test("extracted DFM summary modules contain no mojibake markers", async () => {
  const mojibakePattern = /[\u00c3\ufffd]|\u00e2(?:\u20ac\u00a6|\u2020\u2019|\u20ac\u201d)/u;
  assert.match("Validating\u00e2\u20ac\u00a6", mojibakePattern);
  assert.match("Excel refs \u00e2\u2020\u2019 dark green", mojibakePattern);
  assert.match("Timeout \u00e2\u20ac\u201d no Enter", mojibakePattern);
  const paths = [
    "summary_runtime.js",
    "summary_model.js",
    "summary_formula_bar.js",
    "summary_excel.js",
    "summary_entries.js",
    "summary_interactions.js",
  ];
  const sources = await Promise.all(paths.map((name) => (
    source(`ui/method_pages/dfm/ratios_summary/${name}`)
  )));
  sources.forEach((text, index) => {
    assert.doesNotMatch(text, mojibakePattern, paths[index]);
  });
});
